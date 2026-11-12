import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { memoRead } from "../src/store.js";
import { cachedSudoRead, forgetSecret } from "../src/secretCache.js";
import { createCheckoutSync } from "../src/status/checkoutSync.js";
import { orphanCommitsIn } from "../src/status/orphanCommits.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "e6s80-"));

describe("T6-S80 secrets are read once and kept in memory", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    forgetSecret();
  });

  it("reads a secret once, again only after the store index changes, a forget, or (for a miss) 5 minutes", async () => {
    const dir = tmp();
    const index = path.join(dir, "index.json");
    fs.writeFileSync(index, "{}");
    process.env.CONSOLE_SECRET_INDEX = index;
    delete process.env.CONSOLE_NO_SUDO;
    let reads = 0;
    let t = 1_000;
    const read = async () => (reads++, "v1");
    const o = { read, now: () => t };
    const f = "/etc/console-keys/x/E6S80_A";
    expect(await Promise.all([cachedSudoRead(f, o), cachedSudoRead(f, o)])).toEqual(["v1", "v1"]);
    for (let i = 0; i < 10; i++) await cachedSudoRead(f, o);
    expect(reads).toBe(1);
    forgetSecret(f); // its user said it failed
    await cachedSudoRead(f, o);
    expect(reads).toBe(2);
    fs.writeFileSync(index, '{"x":{"E6S80_A":"2026-11-11"}}'); // `secret put` rewrote the index
    await cachedSudoRead(f, o);
    expect(reads).toBe(3);
    // a miss is kept 5 minutes, then read again
    let missReads = 0;
    const miss = { read: async () => (missReads++, undefined), now: () => t };
    const g = "/etc/console-keys/x/E6S80_MISSING";
    expect(await cachedSudoRead(g, miss)).toBeUndefined();
    t += 60_000;
    await cachedSudoRead(g, miss);
    expect(missReads).toBe(1);
    t += 5 * 60_000;
    await cachedSudoRead(g, miss);
    expect(missReads).toBe(2);
  });

  it("staging (CONSOLE_NO_SUDO=1) never reads the store", async () => {
    process.env.CONSOLE_NO_SUDO = "1";
    let reads = 0;
    expect(await cachedSudoRead("/etc/console-keys/x/E6S80_B", { read: async () => (reads++, "v") })).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("T6-S80 memoRead keeps a list read across another connection's commits for a moment", () => {
  it("an own write drops it at once; another connection's commit only once the memo is CONSOLE_MEMO_FOREIGN_MS old", () => {
    const file = path.join(tmp(), "c.db");
    const db = openDb(file);
    const other = openDb(file);
    db.exec("CREATE TABLE t (v INTEGER)");
    let t = 0;
    let reads = 0;
    const list = () => memoRead(db, "t", () => (reads++, db.prepare("SELECT v FROM t").all() as { v: number }[]), () => t);
    list();
    list();
    expect(reads).toBe(1);
    db.prepare("INSERT INTO t VALUES (1)").run(); // own write
    expect(list()).toEqual([{ v: 1 }]);
    expect(reads).toBe(2);
    other.prepare("INSERT INTO t VALUES (2)").run(); // the indexer's commit
    t += 500;
    expect(list()).toEqual([{ v: 1 }]);
    t += 2_000;
    expect(list()).toEqual([{ v: 1 }, { v: 2 }]);
    expect(reads).toBe(3);
    db.close();
    other.close();
  });

  it("indexes the running runs and the runs list's order", () => {
    const db = openDb(path.join(tmp(), "i.db"));
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan("SELECT id FROM runs WHERE outcome = 'running'")).toContain("runs_running");
    expect(plan("SELECT * FROM runs WHERE (NULL IS NULL OR tenant_id = 'a') ORDER BY started_at DESC, rowid DESC LIMIT 500")).toContain("runs_started");
    db.close();
  });
});

describe("T6-S80 git reads with no fork", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const repo = () => {
    const d = tmp();
    const origin = path.join(d, "origin.git");
    const work = path.join(d, "work");
    git(d, "init", "-q", "--bare", "-b", "main", origin);
    git(d, "clone", "-q", origin, work);
    git(work, "commit", "-q", "--allow-empty", "-m", "first, no ticket");
    git(work, "push", "-q", "origin", "HEAD:main");
    git(work, "fetch", "-q");
    return work;
  };

  it("checkout sync answers an in-sync main from the files, and still asks git when it is ahead", async () => {
    const work = repo();
    const calls: string[][] = [];
    const real = (dir: string, args: string[]) => (calls.push(args), Promise.resolve(git(dir, ...args)));
    const s = createCheckoutSync({ dirs: () => [work], git: real });
    await s.tick();
    expect(calls).toEqual([]);
    git(work, "commit", "-q", "--allow-empty", "-m", "local only");
    const out = await s.tick();
    expect(calls.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ ahead: 1, behind: 0 });
  });

  it("orphan commits are read again only when origin/main moves", async () => {
    const work = repo();
    let n = 0;
    const real = (dir: string, args: string[]) => (n++, new Promise<string>((r) => r(git(dir, ...args))).catch(() => ""));
    const since = "2000-01-01T00:00:00Z";
    const a = await orphanCommitsIn(real, work, since);
    const first = n;
    expect(a.map((c) => c.message)).toEqual(["first, no ticket"]);
    expect(await orphanCommitsIn(real, work, since)).toEqual(a);
    expect(n).toBe(first);
    git(work, "commit", "-q", "--allow-empty", "-m", "second, no ticket");
    git(work, "push", "-q", "origin", "HEAD:main");
    git(work, "fetch", "-q");
    expect((await orphanCommitsIn(real, work, since)).length).toBe(2);
    expect(n).toBeGreaterThan(first);
  });
});
