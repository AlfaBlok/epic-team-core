import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedRunner, rescanGapMs, SPINES_RESCAN_GAP_MS, type SpinesJson } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createRefresher } from "../src/readModel/refresher.js";
import { keyOf } from "../src/readModel/views.js";
import { readPayload } from "../src/readModel/table.js";
import { gitBlame, gitFirstAdded, type WaitingItem } from "../src/inbox/waiting.js";

/**
 * the code repo takes a commit every 1-5 min on the main server and each cost a
 * spines.py rescan (11-24 s) plus a re-blame of every spine with an ask: the console still averaged 0.43 core after.
 * A changed repo is now scanned at most every 5 min (the console's own write still at once), the read model's second scan
 * after a write or pull is gone, and blame / first-added answers are kept per file version, not per HEAD.
 */

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s59-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (n: number): SpinesJson => ({ root: "docs/spines/root.md", nodes: [], orphans: [], mismatches: [], n } as unknown as SpinesJson);

/** A runner that counts its runs and answers a new output each time; `ver` is the checkout key the cache sees. */
function counted(minGapMs: number) {
  let runs = 0;
  const state = { ver: "v1" };
  const run = cachedRunner(async () => out(++runs), 0, Date.now, () => {}, { version: () => state.ver, minGapMs });
  return { run, state, runs: () => runs };
}

describe("T6-S59 cachedRunner: a changed repo is scanned at most every minGapMs", () => {
  it("defaults to 5 min, CONSOLE_RESCAN_GAP_MS overrides, 0 = off", () => {
    expect(SPINES_RESCAN_GAP_MS).toBe(300_000);
    expect(rescanGapMs({})).toBe(300_000);
    expect(rescanGapMs({ CONSOLE_RESCAN_GAP_MS: "0" })).toBe(0);
    expect(rescanGapMs({ CONSOLE_RESCAN_GAP_MS: "60000" })).toBe(60_000);
    expect(rescanGapMs({ CONSOLE_RESCAN_GAP_MS: "x" })).toBe(300_000);
  });

  it("commits inside the gap share one deferred run; the last good output is served meanwhile", async () => {
    const c = counted(300);
    expect(await c.run("/r")).toMatchObject({ n: 1 });
    for (let i = 2; i <= 5; i++) {
      c.state.ver = `v${i}`; // a commit
      expect(await c.run("/r")).toMatchObject({ n: 1 });
    }
    expect(c.runs()).toBe(1);
    await sleep(400);
    expect(c.runs()).toBe(2);
    expect(await c.run("/r")).toMatchObject({ n: 2 });
    await sleep(400);
    expect(c.runs()).toBe(2); // nothing moved since: no scan
  });

  it("off (0): a moved key scans at once, as in T6-S58", async () => {
    const c = counted(0);
    await c.run("/r");
    c.state.ver = "v2";
    await c.run("/r");
    await sleep(20);
    expect(c.runs()).toBe(2);
  });

  it("the console's own write scans at once inside the gap and starts a deferred run instead of adding one", async () => {
    const c = counted(10_000);
    await c.run("/r");
    c.state.ver = "v2";
    await c.run("/r"); // a commit: deferred 10 s
    expect(c.runs()).toBe(1);
    c.run.invalidate("/r"); // the console's own write
    expect(await c.run("/r")).toMatchObject({ n: 2 }); // waits for the run after the write, not 10 s
    await sleep(50);
    expect(c.runs()).toBe(2);
    // a write with nothing deferred also runs at once
    c.state.ver = "v3";
    c.run.invalidate("/r");
    expect(await c.run("/r")).toMatchObject({ n: 3 });
  });

  it("a pull (stale) inside the gap waits for the gap; reads keep the last output", async () => {
    const c = counted(300);
    await c.run("/r");
    c.state.ver = "v2";
    c.run.invalidate("/r", { stale: true });
    expect(await c.run("/r")).toMatchObject({ n: 1 });
    expect(c.runs()).toBe(1);
    await c.run.settled!("/r");
    expect(c.runs()).toBe(2);
    expect(await c.run("/r")).toMatchObject({ n: 2 });
  });

  it("since(): the read model asking right after a write shares the write's run (no second scan)", async () => {
    const c = counted(0);
    await c.run("/r");
    c.state.ver = "v2"; // the write's commit
    c.run.invalidate("/r");
    await sleep(5);
    const v = await c.run.since!("/r", Date.now()); // the worker noticed a moment later
    expect(v).toMatchObject({ n: 2 });
    await sleep(20);
    expect(c.runs()).toBe(2);
    // the key moved again: since needs a new run
    c.state.ver = "v3";
    expect(await c.run.since!("/r", Date.now())).toMatchObject({ n: 3 });
  });
});

// ---------- the read model ----------

const ASK = (code: string) => `- [ask ${code}: decide @Sam since 2026-10-30] Ship it? — options: yes | no — recommend: yes — why Sam: product call`;
const SPINE = (code: string) => `# PLAN-7: Fold\nSpine ID: PLAN-7\n\n## Current State\n\nOwner: Delivery manager\nStatus: active\n\n## Waiting on\n\n${ASK(code)}\n`;

describe("T6-S59 refresher: a moved stamp is re-read at most every rescanGapMs", () => {
  const dbs: DB[] = [];
  afterEach(() => dbs.splice(0).forEach((d) => d.close()));

  it("keeps the last views inside the gap, re-reads at its end; a console write re-reads at once", async () => {
    const root = path.join(tmp, "repos");
    const spine = path.join(root, "fold", "docs", "spines", "root.md");
    fs.mkdirSync(path.dirname(spine), { recursive: true });
    fs.mkdirSync(path.join(root, "fold", ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "fold", ".git", "config"), `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
    let bump = 0;
    const edit = (code: string) => {
      fs.writeFileSync(spine, SPINE(code));
      const t = new Date(Date.now() + 10_000 * ++bump);
      fs.utimesSync(spine, t, t);
    };
    edit("PLAN-7-A1");
    const db = openDb(path.join(tmp, "c.db"));
    dbs.push(db);
    createStore(db).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    let t = Date.now();
    const calls: string[] = [];
    const r = createRefresher({ db, reposRoot: root, worlds: ["home"], now: () => t, rescanGapMs: 300_000, log: () => {}, spines: async (d) => (calls.push(d), Promise.reject(new Error("fallback"))) });
    const pass = async () => {
      await r.tick();
      await r.idle();
    };
    const codes = () => {
      const row = readPayload(db, keyOf({ kind: "waiting", world: "home", includeSettled: false }));
      return row ? (JSON.parse(row.payload) as { items: WaitingItem[] }).items.map((x) => x.code) : [];
    };
    await pass();
    // (the runner fails, so the trees are the markdown parse and the read layer asks it again per tree: count moves, not runs)
    const n1 = calls.length;
    expect(n1).toBeGreaterThan(0);
    expect(codes()).toEqual(["PLAN-7-A1"]);

    edit("PLAN-7-A2"); // a commit 10 s after the scan
    t += 10_000;
    await pass();
    expect(calls).toHaveLength(n1);
    expect(codes()).toEqual(["PLAN-7-A1"]);
    r.dirty(path.join(root, "fold"), { stale: true }); // a pull: still inside the gap
    await pass();
    expect(calls).toHaveLength(n1);
    expect(codes()).toEqual(["PLAN-7-A1"]);

    t += 300_000; // the gap is over
    await pass();
    const n2 = calls.length;
    expect(n2).toBeGreaterThan(n1);
    expect(codes()).toEqual(["PLAN-7-A2"]);

    edit("PLAN-7-A3"); // the console's own write
    t += 1_000;
    r.dirty(path.join(root, "fold"));
    await pass();
    expect(calls.length).toBeGreaterThan(n2);
    expect(codes()).toEqual(["PLAN-7-A3"]);
    r.stop();
  });
});

// ---------- blame / first added ----------

describe("T6-S59 blame and first-added are kept per file version, not per HEAD", () => {
  const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  const repo = () => {
    const dir = path.join(tmp, "g");
    git(tmp, "init", "-q", "-b", "main", dir);
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "a.md"), "one\ntwo\n");
    fs.writeFileSync(path.join(dir, "b.md"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  };
  afterEach(() => vi.useRealTimers());

  it("a commit to another file keeps a file's blame; a commit to the file blames it again", async () => {
    const dir = repo();
    const first = await gitBlame(dir, "a.md");
    expect(first).toHaveLength(2);
    fs.writeFileSync(path.join(dir, "b.md"), "y\n");
    git(dir, "commit", "-qam", "two");
    expect(await gitBlame(dir, "a.md")).toBe(first); // the cached answer, no new blame
    fs.appendFileSync(path.join(dir, "a.md"), "three\n");
    const dirty = await gitBlame(dir, "a.md");
    expect(dirty).not.toBe(first);
    expect(dirty?.[2]).toBeUndefined(); // uncommitted line
    git(dir, "commit", "-qam", "three");
    const after = await gitBlame(dir, "a.md");
    expect(after?.[2]).toMatch(/^\d{4}-/);
  });

  it("a first-added miss is retried after a minute only once the file moved", async () => {
    const dir = repo();
    expect(await gitFirstAdded(dir, "a.md", "[ask X-1:")).toBeUndefined();
    await sleep(50); // the miss records the file's version
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);
    expect(await gitFirstAdded(dir, "a.md", "[ask X-1:")).toBeUndefined(); // unchanged file: not walked again
    fs.appendFileSync(path.join(dir, "a.md"), "- [ask X-1: decide] q\n");
    git(dir, "commit", "-qam", "ask");
    expect(await gitFirstAdded(dir, "a.md", "[ask X-1:")).toMatch(/^\d{4}-/);
  });
});
