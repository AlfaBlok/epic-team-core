import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { cachedRunner, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import { bookStore, followBook } from "../src/book/service.js";
import type { Book } from "../src/book/build.js";
import { createIndexer } from "../src/indexer/core.js";
import { indexerEnv, unitArgs, INDEXER_LIMITS } from "../src/indexer/launch.js";
import { BEAT_KEY, T3_KEY, ensureIndexerTables, indexerBeat, kvGet, kvSet, sendToIndexer, takeIndexerMsgs } from "../src/indexer/queue.js";
import { persistedSpinesRunner, persistingRunner, seedFrom } from "../src/indexer/spinesCache.js";
import { createReadModelHost } from "../src/readModel/host.js";

/**
 * the console's scans (spines.py, the read model's refresher, the Epic Book's git log) run in a
 * separate niced, CPU-capped indexer process; the console reads their results from console.db and asks for work through
 * a queue table. A restart re-reads only checkouts that moved.
 */

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s64-"));
  db = openDb(path.join(tmp, "console.db"));
  ensureIndexerTables(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const out = (title: string): SpinesJson => ({
  root: "docs/spines/root.md",
  nodes: [{ id: "E0", path: "docs/spines/root.md", title, parent: null, status: "active", rollup_status: "active", dod: [], children: [] }],
  orphans: [],
  mismatches: [],
});
function repo(name = "r") {
  const dir = path.join(tmp, "repos", name);
  fs.mkdirSync(path.join(dir, "docs", "spines"), { recursive: true });
  git(tmp, "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "docs", "spines", "root.md"), "# root\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const counting = (title = "T") => {
  const calls: string[] = [];
  const run: SpinesRunner = async (dir) => (calls.push(dir), out(title));
  return { run, calls };
};

describe("T6-S64 spines_cache: stored by the indexer, seeded after a restart", () => {
  it("a restart takes the stored output and re-runs spines.py only for a checkout that moved", async () => {
    const dir = repo();
    const a = counting("first");
    const first = cachedRunner(persistingRunner(a.run, db), 60_000, Date.now, () => {}, { seed: seedFrom(db) });
    expect((await first(dir)).nodes[0].title).toBe("first");
    expect(a.calls).toHaveLength(1);

    // the restart: a new cache over the same database, nothing moved
    const b = counting("second");
    const again = cachedRunner(persistingRunner(b.run, db), 0, Date.now, () => {}, { seed: seedFrom(db) });
    expect((await again(dir)).nodes[0].title).toBe("first");
    await sleep(10);
    expect(b.calls).toHaveLength(0);

    // a commit moves the checkout key: the next stale hit re-reads it
    fs.writeFileSync(path.join(dir, "docs", "spines", "root.md"), "# root\n\nmoved\n");
    git(dir, "commit", "-qam", "two");
    await again(dir);
    await sleep(20);
    expect(b.calls).toHaveLength(1);
    expect((await again(dir)).nodes[0].title).toBe("second");
  });

  it("a failed run keeps the stored output and stamps it, so readers waiting for a run after their write are answered", async () => {
    const dir = repo();
    let fail = false;
    const run = persistingRunner(async () => {
      if (fail) throw new Error("boom");
      return out("good");
    }, db);
    await run(dir);
    const before = (db.prepare("SELECT started_at FROM spines_cache WHERE dir = ?").get(dir) as { started_at: number }).started_at;
    await sleep(5);
    fail = true;
    await expect(run(dir)).rejects.toThrow("boom");
    const row = db.prepare("SELECT json, started_at FROM spines_cache WHERE dir = ?").get(dir) as { json: string; started_at: number };
    expect(row.started_at).toBeGreaterThan(before);
    expect(JSON.parse(row.json).nodes[0].title).toBe("good");
  });
});

describe("T6-S64 persistedSpinesRunner (the console's side)", () => {
  const store = (dir: string, title: string, startedAt: number) =>
    db.prepare("INSERT INTO spines_cache (dir, json, ver, started_at, ran_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(dir) DO UPDATE SET json = excluded.json, started_at = excluded.started_at, ran_at = excluded.ran_at").run(dir, JSON.stringify(out(title)), startedAt, startedAt);

  it("answers from the stored output, the same object while the output did not change", async () => {
    store("/r", "a", 1);
    const run = persistedSpinesRunner(db, { alive: () => true, pollMs: 5 });
    const x = await run("/r");
    expect(x.nodes[0].title).toBe("a");
    store("/r", "a", 2); // a new run, same output
    expect(await run("/r")).toBe(x);
    expect(takeIndexerMsgs(db)).toEqual([]); // a read asks nothing of the indexer
  });

  it("a checkout never read is asked for and waited on", async () => {
    const run = persistedSpinesRunner(db, { alive: () => true, pollMs: 5 });
    const p = run("/new");
    expect(takeIndexerMsgs(db)).toEqual([{ type: "spines", dir: "/new" }]);
    await sleep(20);
    store("/new", "fresh", Date.now());
    expect((await p).nodes[0].title).toBe("fresh");
  });

  it("the console's own write waits for a run that started after it; a pull keeps the last output at once", async () => {
    store("/r", "old", Date.now() - 1_000);
    const run = persistedSpinesRunner(db, { alive: () => true, pollMs: 5 });
    await run("/r");
    run.invalidate("/r", { stale: true });
    expect((await run("/r")).nodes[0].title).toBe("old");
    expect(takeIndexerMsgs(db)).toEqual([{ type: "spines", dir: "/r", stale: true }]);

    run.invalidate("/r");
    expect(takeIndexerMsgs(db)).toEqual([{ type: "spines", dir: "/r" }]);
    let got: string | undefined;
    const p = run("/r").then((v) => (got = v.nodes[0].title));
    await sleep(30);
    expect(got).toBeUndefined();
    expect(run.settled?.("/r")).toBeDefined();
    store("/r", "new", Date.now());
    await p;
    expect(got).toBe("new");
  });

  it("with the indexer down and nothing stored, the fallback runs here", async () => {
    const f = counting("local");
    const run = persistedSpinesRunner(db, { alive: () => false, fallback: f.run });
    expect((await run("/x")).nodes[0].title).toBe("local");
    expect(f.calls).toEqual(["/x"]);
  });

  it("gives up after waitMs with the last output", async () => {
    store("/r", "old", Date.now() - 1_000);
    const run = persistedSpinesRunner(db, { alive: () => true, pollMs: 5, waitMs: 40 });
    run.invalidate("/r");
    expect((await run("/r")).nodes[0].title).toBe("old");
  });
});

describe("T6-S64 the indexer process (core)", () => {
  it("answers the queue, stores spines.py output, beats, and a restart re-reads nothing that did not move", async () => {
    const dir = repo();
    const a = counting();
    const ix = createIndexer(db, { dbPath: "", reposRoot: path.join(tmp, "repos"), bookTickMs: 0, tickMs: 0, pollMs: 0, beatMs: 0, keepFreshMs: 0 }, { spines: a.run, log: () => {} });
    ix.beat();
    expect(indexerBeat(db)?.pid).toBe(process.pid);
    sendToIndexer(db, { type: "spines", dir });
    ix.poll();
    expect(takeIndexerMsgs(db)).toEqual([]); // taken
    await sleep(50);
    expect(a.calls).toEqual([dir]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spines_cache").get()).toEqual({ n: 1 });
    ix.stop();

    const b = counting();
    const ix2 = createIndexer(db, { dbPath: "", reposRoot: path.join(tmp, "repos"), bookTickMs: 0, tickMs: 0, pollMs: 0, beatMs: 0, keepFreshMs: 0 }, { spines: b.run, log: () => {} });
    await ix2.spines!(dir);
    await sleep(20);
    expect(b.calls).toEqual([]);
    expect(ix2.stats()).toEqual({ runs: 0, seeded: 1 });
    ix2.beat();
    expect(kvGet<{ seeded: number }>(db, BEAT_KEY)?.v.seeded).toBe(1);
    ix2.stop();
  });
});

describe("T6-S64 the console's read model host in external mode", () => {
  it("hands changes to the indexer through the queue and T3 states through the kv table; reads stored views", async () => {
    const host = createReadModelHost({ db, mode: "external", worlds: () => [""], tickMs: 0, runningRuns: () => [] });
    host.dirty("/r", { stale: true });
    host.dirtyAll();
    expect(takeIndexerMsgs(db)).toEqual([{ type: "dirty", dir: "/r", stale: true }, { type: "dirtyAll" }]);
    let inline = 0;
    const v = await host.view({ kind: "status", world: "", includeSettled: false }, async () => (inline++, { x: 1 }));
    expect(v).toMatchObject({ source: "inline", payload: { x: 1 } });
    expect(takeIndexerMsgs(db)).toEqual([{ type: "register", key: { kind: "status", world: "", includeSettled: false } }]);
    host.close();
    kvSet(db, T3_KEY, { run_1: { status: "Working", checkedAt: "x" } });
    expect(kvGet(db, T3_KEY)?.v).toEqual({ run_1: { status: "Working", checkedAt: "x" } });
  });
});

describe("T6-S64 followBook (the console's book when the indexer builds it)", () => {
  const book = (at: string) => ({ builtAt: at, repos: [] }) as unknown as Book;
  it("serves the stored book, parsed again only when a new one was stored, and asks the indexer to rebuild", async () => {
    const st = bookStore(db);
    st.save(book("2026-11-08T00:00:00.000Z"));
    const asks: boolean[] = [];
    const b = followBook({ store: st, ask: (r) => asks.push(r), pollMs: 5 });
    const v1 = await b.get();
    expect(v1.book?.builtAt).toBe("2026-11-08T00:00:00.000Z");
    expect((await b.get()).book).toBe(v1.book);
    b.invalidate();
    expect(asks).toEqual([false]);
    const p = b.rebuild();
    await sleep(20);
    st.save(book("2026-11-08T00:05:00.000Z"));
    expect((await p).builtAt).toBe("2026-11-08T00:05:00.000Z");
    expect(asks).toEqual([false, true]);
  });
});

describe("T6-S64 launch", () => {
  it("runs the indexer niced and CPU-capped, with no secret from the console's env", () => {
    const env = indexerEnv({ dbPath: "/d", reposRoot: "/r" }, 42, { PATH: "/bin", HOME: "/h", CONSOLE_AUTH_SECRET: "s", GITHUB_TOKEN: "t", OPENAI_API_KEY: "k" });
    expect(Object.keys(env).sort()).toEqual(["CONSOLE_INDEXER_CONFIG", "CONSOLE_INDEXER_PARENT", "HOME", "PATH"]);
    const args = unitArgs("agent-team-console-indexer-8750", "/app/dist/indexer.mjs", env, "/app");
    expect(args).toContain(`--property=Nice=${INDEXER_LIMITS.nice}`);
    expect(args).toContain(`--property=CPUQuota=${INDEXER_LIMITS.cpuQuota}`);
    expect(args).toContain("--property=IOSchedulingClass=idle");
    expect(args).toContain("--unit=agent-team-console-indexer-8750");
    expect(args.slice(-1)).toEqual(["/app/dist/indexer.mjs"]);
  });
});
