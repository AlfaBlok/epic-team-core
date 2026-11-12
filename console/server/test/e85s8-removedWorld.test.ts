import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createRefresher } from "../src/readModel/refresher.js";
import { keyOf } from "../src/readModel/views.js";
import { ensureReadModel, listSnapshotKeys, writeSnapshot } from "../src/readModel/table.js";
import { createIndexer } from "../src/indexer/core.js";
import { kvGet, kvSet } from "../src/indexer/queue.js";

/**
 * a removed tester world left three read-model views behind (status, review, waiting); the production indexer
 * tried them every 5 s and logged "tenant … not found" until the 3-day unread drop. A view whose tenant is gone is now
 * dropped on the first pass, and a checkout that is gone leaves the indexer's scan cache.
 */
const W = "es-e85-s3-test-tester-r-0000";
let tmp: string;
const dbs: DB[] = [];
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e85s8-"))));
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("T85-S8: a removed world leaves nothing for the indexer to retry", () => {
  it("drops the views of a world whose tenant is gone on the first pass, and logs once", async () => {
    const db = openDb(path.join(tmp, "c.db"));
    dbs.push(db);
    ensureReadModel(db);
    const t = Date.now();
    const at = new Date(t - 3600_000).toISOString(); // written an hour ago, never read: inside the 3-day unread window
    const gone = [keyOf({ kind: "status", world: W, includeSettled: false }), keyOf({ kind: "review", world: W }), keyOf({ kind: "waiting", world: W, includeSettled: false })];
    for (const k of gone) writeSnapshot(db, k, { items: [] }, at);
    const logs: string[] = [];
    const r = createRefresher({ db, reposRoot: path.join(tmp, "repos"), worlds: ["home"], now: () => t, log: (m) => logs.push(m), spines: async () => Promise.reject(new Error("none")) });
    const pass = async () => {
      await r.tick();
      await r.idle();
    };
    await pass();
    expect(listSnapshotKeys(db).map((x) => x.key).filter((k) => k.includes(W))).toEqual([]);
    expect(logs.filter((l) => l.includes(W))).toHaveLength(3);
    expect(logs.filter((l) => l.includes(W)).every((l) => l.endsWith("view dropped"))).toBe(true);
    logs.length = 0;
    await pass();
    await pass();
    expect(logs.filter((l) => l.includes("not found"))).toEqual([]);
    r.stop();
  });

  it("the indexer drops the cached scan and book commits of a checkout that is gone", async () => {
    const db = openDb(path.join(tmp, "c.db"));
    dbs.push(db);
    const repos = path.join(tmp, "repos");
    const kept = path.join(repos, "kept");
    fs.mkdirSync(kept, { recursive: true });
    const removed = path.join(repos, W);
    const logs: string[] = [];
    const ix = createIndexer(db, { dbPath: "", reposRoot: repos, bookTickMs: 0, tickMs: 0, pollMs: 0, beatMs: 0, keepFreshMs: 20, startReportMs: 0 }, { spines: async () => ({}) as never, log: (m) => logs.push(m) });
    const ins = db.prepare("INSERT INTO spines_cache (dir, json, ver, started_at, ran_at) VALUES (?, '{}', 1, ?, ?)");
    for (const d of [kept, removed]) ins.run(d, Date.now(), Date.now());
    kvSet(db, `book-commits:${removed}`, { head: "x", commits: [] });
    kvSet(db, `book-commits:${kept}`, { head: "y", commits: [] });
    ix.start();
    await new Promise((r) => setTimeout(r, 80));
    ix.stop();
    const dirs = (db.prepare("SELECT dir FROM spines_cache").all() as { dir: string }[]).map((x) => x.dir);
    expect(dirs).toEqual([kept]);
    expect(kvGet(db, `book-commits:${removed}`)).toBeUndefined();
    expect(kvGet(db, `book-commits:${kept}`)).toBeDefined();
    expect(logs.filter((l) => l.includes(`${removed} is gone`))).toHaveLength(1);
  });
});
