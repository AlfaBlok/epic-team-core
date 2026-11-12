import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { softSpines, type SpinesJson } from "../src/adapters/spines.js";
import { buildTree, type Tree } from "../src/adapters/tree.js";
import { waitingAndDefects } from "../src/inbox/waiting.js";
import { createStore, type Milestone } from "../src/store.js";
import { createStatus } from "../src/status/routes.js";

// right after a console restart spines.py has no output yet (~22 s cold on the main server). The batch
// waited 1.5 s per spine read, the milestone route 4 s, and a read that ran out of time built the tree from the bare doc
// parse: the code repo read 0 in GET /api/status while its own status read 11. A spine read that has not finished is now
// "loading" (no items, needsYou null) on both routes, never a number; once read, both say N.
const ROOT = `# EPIC: home_repo

## Current State

Status: active

## Waiting on

- [ask M5-A1: decide @Sam since 2026-10-24 row M5] Import authed cookies? — options: yes | no — recommend: yes — unblocks: M5 — context: notes.md
- [ask M5-A2: decide @Sam since 2026-10-24 row M5] Which exit node? — options: home | vps — recommend: home — unblocks: M5 — context: notes.md
`;
// What the doc parse alone saw of the code repo after a restart: none of the asks (they sit in spines.py's view).
const BARE = `# EPIC: home_repo

## Current State

Status: active
`;

let reposRoot: string;
let db: DB;
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s16-"));
  fs.mkdirSync(path.join(reposRoot, "home_repo/.git"), { recursive: true });
  fs.writeFileSync(path.join(reposRoot, "home_repo/.git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/home_repo.git\n`);
  fs.mkdirSync(path.join(reposRoot, "home_repo/docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(reposRoot, "home_repo/docs/spines/root.md"), ROOT);
  fs.writeFileSync(path.join(reposRoot, "home_repo/docs/spines/bare.md"), BARE);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

function setup(runMs: number) {
  db = openDb(":memory:");
  const store = createStore(db);
  const m = store.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const dir = path.join(reposRoot, "home_repo");
  let finished = false;
  // A cold spines.py: answers after runMs (each call its own run, as the cached runner's first read is).
  const soft = softSpines(() => new Promise<SpinesJson>((r) => setTimeout(() => ((finished = true), r({} as SpinesJson)), runMs)));
  const treeFor = async (x: Milestone, ms = 15): Promise<Tree> => {
    const spines = await soft(dir, ms);
    return buildTree(reposRoot, spines ? x : { ...x, path: "docs/spines/bare.md" }, undefined);
  };
  const status = createStatus({
    db,
    store,
    treeFor: (x) => treeFor(x),
    milestoneInfo: async (_x, softMs) => (await soft(dir, softMs), { status: "active" }),
    waiting: (f) => waitingAndDefects({ store, reposRoot, treeFor: (x) => treeFor(x), blame: async () => undefined }, f),
    cold: { mark: soft.mark, missed: (_x, mark) => soft.missedSince(dir, mark) },
  });
  return { m, status, finished: () => finished };
}

describe("T13-S16 a slow spine read never makes the batch report 0 while the milestone reports N", () => {
  it("cold: both routes say loading (no number, no items), the batch carries no Team count", async () => {
    const { m, status } = setup(10_000);
    const batch = await status.all();
    const row = batch.milestones.find((s) => s.milestoneId === m.id)!;
    expect(row).toMatchObject({ loading: true, needsYou: null, items: [] });
    expect(batch).toMatchObject({ loading: true, needsYou: null });
    expect(await status.one(m)).toMatchObject({ loading: true, needsYou: null });
  });

  it("once the spines are read, the batch and the milestone say the same N, not loading", async () => {
    const { m, status, finished } = setup(40);
    expect((await status.all()).loading).toBe(true); // the first read ran out of time
    await new Promise((r) => setTimeout(r, 80));
    expect(finished()).toBe(true);
    const batch = await status.all();
    const one = await status.one(m);
    expect(one.loading).toBeUndefined();
    expect(one.needsYou).toBe(2);
    expect(batch.loading).toBeUndefined();
    expect(batch.milestones.find((s) => s.milestoneId === m.id)!.needsYou).toBe(2);
    expect(batch.needsYou).toBe(2);
  });

  it("a read that fails (not slow) keeps the old answer: the doc parse, not loading forever", async () => {
    const soft = softSpines(() => Promise.reject(new Error("spines.py: boom")));
    const dir = path.join(reposRoot, "home_repo");
    expect(await soft(dir, 15)).toBeUndefined();
    expect(soft.missedSince(dir, 0)).toBe(false);
  });
});
