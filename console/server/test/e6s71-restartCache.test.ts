import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { cachedRunner, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import { createIndexer } from "../src/indexer/core.js";
import { ensureIndexerTables, kvGet, kvSet } from "../src/indexer/queue.js";
import { persistingRunner, scannerVersion, seedFrom } from "../src/indexer/spinesCache.js";

/**
 * a console restart (each deploy) no longer starts a cold rescan on the main server. The seeded
 * spines.py output keeps the rescan gap of its run before the restart, a stored output read by another scanner is read
 * again, and git's blame and first-added answers outlive the process (indexer_kv).
 */

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s71-"));
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
  fs.writeFileSync(path.join(dir, "docs", "spines", "root.md"), "# root\n\n## Waiting on\n- [ask T0-A1] one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}
const move = (dir: string, text: string) => {
  fs.appendFileSync(path.join(dir, "docs", "spines", "root.md"), `${text}\n`);
  git(dir, "commit", "-qam", text);
};
/** The stored run started just now (the commit above takes longer than the short gaps these tests use). */
const justRan = (dir: string) => db.prepare("UPDATE spines_cache SET started_at = ? WHERE dir = ?").run(Date.now(), dir);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const counting = (title: string) => {
  const calls: string[] = [];
  const run: SpinesRunner = async (dir) => (calls.push(dir), out(title));
  return { run, calls };
};

describe("T6-S71 the rescan gap holds across a restart", () => {
  it("a seeded repo that moved within the gap answers at once with its seed and re-reads at the gap's end", async () => {
    const dir = repo();
    await cachedRunner(persistingRunner(counting("before").run, db), 60_000)(dir);
    move(dir, "two");
    justRan(dir);

    const b = counting("after");
    const refreshed: string[] = [];
    const again = cachedRunner(persistingRunner(b.run, db), 60_000, Date.now, () => {}, { seed: seedFrom(db), minGapMs: 300, onSeedRefreshed: (d) => refreshed.push(d) });
    const t0 = Date.now();
    expect((await again.since!(dir, t0)).nodes[0].title).toBe("before"); // no wait for a run
    expect((await again.since!(dir, t0)).nodes[0].title).toBe("before"); // asked twice: one deferred run
    expect(Date.now() - t0).toBeLessThan(200);
    expect(b.calls).toEqual([]);
    await sleep(450);
    expect(b.calls).toEqual([dir]);
    expect(refreshed).toEqual([dir]);
    expect((await again.since!(dir, t0)).nodes[0].title).toBe("after");
  });

  it("a seeded repo that did not move is never read again; one whose last run is older than the gap is read at once", async () => {
    const still = repo("still");
    const moved = repo("moved");
    const first = cachedRunner(persistingRunner(counting("before").run, db), 60_000);
    await first(still);
    await first(moved);
    db.prepare("UPDATE spines_cache SET started_at = started_at - 600000 WHERE dir = ?").run(moved);
    move(moved, "two");

    const b = counting("after");
    const refreshed: string[] = [];
    const again = cachedRunner(persistingRunner(b.run, db), 60_000, Date.now, () => {}, { seed: seedFrom(db), minGapMs: 300_000, onSeedRefreshed: (d) => refreshed.push(d) });
    expect((await again.since!(still, Date.now())).nodes[0].title).toBe("before");
    expect((await again.since!(moved, Date.now())).nodes[0].title).toBe("after");
    expect(b.calls).toEqual([moved]);
    expect(refreshed).toEqual([]);
  });

  it("the console's own write still re-reads at once", async () => {
    const dir = repo();
    await cachedRunner(persistingRunner(counting("before").run, db), 60_000)(dir);
    move(dir, "two");
    const b = counting("after");
    const again = cachedRunner(persistingRunner(b.run, db), 60_000, Date.now, () => {}, { seed: seedFrom(db), minGapMs: 300_000 });
    again.invalidate(dir);
    expect((await again(dir)).nodes[0].title).toBe("after");
    expect(b.calls).toEqual([dir]);
  });
});

describe("T6-S71 scanner version", () => {
  it("an output read by another scanner is served without its key (read again); a row from before names none and is kept", async () => {
    const skill = path.join(tmp, "skill");
    fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skill, "scripts", "spines.py"), "print(1)\n");
    const scanner = scannerVersion(skill);
    const v1 = scanner();
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(scanner()).toBe(v1);

    const dir = repo();
    await persistingRunner(counting("x").run, db, { scanner })(dir);
    expect(db.prepare("SELECT scanner FROM spines_cache").get()).toEqual({ scanner: v1 });
    expect(seedFrom(db, scanner)(dir)?.ver).toBeDefined();

    fs.writeFileSync(path.join(skill, "scripts", "doctrine.py"), "X = 2\n"); // a module spines.py loads
    expect(scanner()).not.toBe(v1);
    expect(seedFrom(db, scanner)(dir)?.ver).toBeUndefined();
    expect(seedFrom(db, scanner)(dir)?.value.nodes[0].title).toBe("x");

    db.prepare("UPDATE spines_cache SET scanner = NULL").run();
    expect(seedFrom(db, scanner)(dir)?.ver).toBeDefined();
  });

  it("the column is added to a spines_cache made before it", () => {
    const old = openDb(path.join(tmp, "old.db"));
    old.exec("CREATE TABLE spines_cache (dir TEXT PRIMARY KEY, json TEXT NOT NULL, ver TEXT, started_at INTEGER NOT NULL, ran_at INTEGER NOT NULL)");
    ensureIndexerTables(old);
    ensureIndexerTables(old);
    expect((old.prepare("PRAGMA table_info(spines_cache)").all() as { name: string }[]).map((c) => c.name)).toContain("scanner");
    old.close();
  });
});

describe("T6-S71 git answers outlive the indexer", () => {
  it("blame and first-added answers are stored in indexer_kv and read back by a new process without asking git", async () => {
    const dir = repo();
    const memo = { get: (k: string) => kvGet(db, k)?.v, set: (k: string, v: unknown) => kvSet(db, k, v) };

    vi.resetModules();
    const one = await import("../src/inbox/waiting.js");
    one.useGitMemo(memo);
    const times = await one.gitBlame(dir, "docs/spines/root.md");
    expect(times?.length).toBe(4);
    const added = await one.gitFirstAdded(dir, "docs/spines/root.md", "T0-A1");
    expect(added).toMatch(/^\d{4}-/);
    const keys = (db.prepare("SELECT k FROM indexer_kv").all() as { k: string }[]).map((r) => r.k);
    expect(keys.some((k) => k.startsWith("blame:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("first:"))).toBe(true);
    one.useGitMemo(undefined);

    // Mark the stored answers, so the new process can only return them by reading the memo.
    const bk = keys.find((k) => k.startsWith("blame:"))!;
    const stored = kvGet<{ key: string; times: string[] }>(db, bk)!.v;
    kvSet(db, bk, { key: stored.key, times: stored.times.map(() => "2001-01-01T00:00:00.000Z") });
    const fk = keys.find((k) => k.startsWith("first:"))!;
    kvSet(db, fk, "2002-02-02T00:00:00.000Z");

    vi.resetModules();
    const two = await import("../src/inbox/waiting.js");
    two.useGitMemo(memo);
    expect(await two.gitBlame(dir, "docs/spines/root.md")).toEqual(Array(4).fill("2001-01-01T00:00:00.000Z"));
    expect(await two.gitFirstAdded(dir, "docs/spines/root.md", "T0-A1")).toBe("2002-02-02T00:00:00.000Z");

    // A file that moved is blamed again.
    move(dir, "three");
    expect((await two.gitBlame(dir, "docs/spines/root.md"))?.[0]).not.toBe("2001-01-01T00:00:00.000Z");
    two.useGitMemo(undefined);
  });
});

describe("T6-S71 the indexer after a restart", () => {
  it("a repo that moved just before the restart keeps its stored output and is read once, after the gap", async () => {
    const dir = repo();
    const cfg = { dbPath: "", reposRoot: path.join(tmp, "repos"), bookTickMs: 0, tickMs: 0, pollMs: 0, beatMs: 0, keepFreshMs: 0 };
    const a = counting("before");
    const ix = createIndexer(db, cfg, { spines: a.run, log: () => {} });
    await ix.spines!(dir);
    ix.stop();
    move(dir, "two");
    justRan(dir);

    const b = counting("after");
    const ix2 = createIndexer(db, { ...cfg, rescanGapMs: 300 }, { spines: b.run, log: () => {} });
    expect((await ix2.spines!.since!(dir, Date.now())).nodes[0].title).toBe("before");
    expect(ix2.stats()).toEqual({ runs: 0, seeded: 1 });
    await sleep(450);
    expect(ix2.stats().runs).toBe(1);
    expect(JSON.parse((db.prepare("SELECT json FROM spines_cache WHERE dir = ?").get(dir) as { json: string }).json).nodes[0].title).toBe("after");
    ix2.stop();
  });
});
