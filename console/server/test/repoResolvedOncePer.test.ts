import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { listRepos, resetRepoScans } from "../src/adapters/repos.js";
import { createTreeMemo } from "../src/adapters/treeMemo.js";
import { buildTree } from "../src/adapters/tree.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";

/** a tree build resolves the repo once; listRepos and built trees are memoized for a few seconds; builds coalesce. */
const spine = (id: string, rows: string) =>
  `# EPIC: ${id}\n\nSpine ID: ${id}\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n${rows}`;

let root: string;
let db: DB | undefined;
const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const M = { id: "ms_e33", repo: "Acme/fold", path: "docs/spines/root.md", paused: false, title: "Fold" };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e33s1-"));
  write("fold/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
  write("other/.git/config", "");
  write("fold/docs/spines/a.md", spine("A", "| A-1 | One | ready |\n| A-2 | Two | done |\n"));
  write("fold/docs/spines/b.md", spine("B", "| B-1 | One | ready |\n"));
  write("fold/docs/spines/root.md", spine("root", "| [A](a.md) | Epic A | active |\n| [B](b.md) | Epic B | active |\n| R-1 | Row | ready |\n"));
  resetRepoScans(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetRepoScans();
  db?.close();
  db = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const rootScans = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === root).length;

describe("T33-S1 repo resolved once per tree build", () => {
  it("a tree with many ledger-bearing nodes scans the repos root once, not once per node", () => {
    const spy = vi.spyOn(fs, "readdirSync");
    const t = buildTree(root, M);
    const nodes = JSON.stringify(t).split('"key"').length - 1;
    expect(nodes).toBeGreaterThan(5);
    expect(rootScans(spy)).toBe(1); // memo off (TTL 0): the single resolve in buildTree
  });
});

describe("T33-S1 listRepos memo", () => {
  it("reuses a scan within the TTL, rescans after it, and resetRepoScans bypasses it", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      resetRepoScans(5_000);
      const spy = vi.spyOn(fs, "readdirSync");
      expect(listRepos(root).map((r) => r.name)).toEqual(["fold", "other"]);
      write("third/.git/config", "");
      expect(listRepos(root).map((r) => r.name)).toEqual(["fold", "other"]); // memoized
      expect(rootScans(spy)).toBe(1);
      vi.setSystemTime(1_000_000 + 5_001);
      expect(listRepos(root).map((r) => r.name)).toEqual(["fold", "other", "third"]);
      expect(rootScans(spy)).toBe(2);
      write("fourth/.git/config", "");
      resetRepoScans(5_000);
      expect(listRepos(root)).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("callers cannot corrupt the memo by mutating the returned list", () => {
    resetRepoScans(5_000);
    listRepos(root).length = 0;
    expect(listRepos(root)).toHaveLength(2);
  });
});

describe("T33-S1 tree memo", () => {
  const spinesA = { n: 1 };
  const load = (spines: { n: number } | undefined, dir = "/r") => async () => ({ spines, dir });

  it("serves a built tree within the TTL and rebuilds after it", async () => {
    let t = 0;
    let builds = 0;
    const memo = createTreeMemo<number, { n: number }>(3_000, () => t);
    const make = () => ++builds;
    expect(await memo.get("k", load(spinesA), make)).toBe(1);
    t = 2_999;
    expect(await memo.get("k", load(spinesA), make)).toBe(1);
    t = 3_000;
    expect(await memo.get("k", load(spinesA), make)).toBe(2);
  });

  it("a different key or a new spines.py output is a miss", async () => {
    let builds = 0;
    const memo = createTreeMemo<number, { n: number }>(3_000, () => 0);
    const make = () => ++builds;
    await memo.get("k1", load(spinesA), make);
    await memo.get("k2", load(spinesA), make);
    await memo.get("k1", load({ n: 2 }), make);
    expect(builds).toBe(3);
  });

  it("concurrent requests for one tree share a single load and build", async () => {
    let builds = 0;
    let loads = 0;
    const memo = createTreeMemo<number, { n: number }>(3_000, () => 0);
    const slow = async () => (loads++, await new Promise((r) => setTimeout(r, 20)), { spines: spinesA, dir: "/r" });
    const all = await Promise.all([1, 2, 3, 4].map(() => memo.get("k", slow, () => ++builds)));
    expect(all).toEqual([1, 1, 1, 1]);
    expect(builds).toBe(1);
    expect(loads).toBe(1);
  });

  it("a caller-chosen spines (shared=false) neither joins nor feeds an in-flight build", async () => {
    let builds = 0;
    const memo = createTreeMemo<number, { n: number }>(3_000, () => 0);
    const a = memo.get("k", async () => (await new Promise((r) => setTimeout(r, 10)), { spines: spinesA }), () => ++builds);
    const b = memo.get("k", load({ n: 9 }), () => ++builds, false);
    expect(await Promise.all([a, b])).toEqual([2, 1]);
  });

  it("invalidate drops that checkout's trees and discards builds that started before it", async () => {
    let builds = 0;
    const memo = createTreeMemo<number, { n: number }>(3_000, () => 0);
    const make = () => ++builds;
    await memo.get("k", load(spinesA, "/r"), make);
    await memo.get("o", load(spinesA, "/other"), make);
    memo.invalidate("/r");
    expect(await memo.get("k", load(spinesA, "/r"), make)).toBe(3); // rebuilt
    expect(await memo.get("o", load(spinesA, "/other"), make)).toBe(2); // untouched
    // a build in flight while the checkout is written must not be stored as fresh
    const slow = memo.get("s", async () => (await new Promise((r) => setTimeout(r, 10)), { spines: spinesA, dir: "/r" }), make);
    memo.invalidate("/r");
    await slow;
    expect(await memo.get("s", load(spinesA, "/r"), make)).toBe(5);
  });

  it("a failed build is not cached and the next call retries", async () => {
    const memo = createTreeMemo<number, { n: number }>(3_000, () => 0);
    await expect(memo.get("k", load(spinesA), () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await memo.get("k", load(spinesA), () => 7)).toBe(7);
  });

  it("TTL 0 turns the memo and the coalescing off", async () => {
    let builds = 0;
    const memo = createTreeMemo<number, { n: number }>(0, () => 0);
    await Promise.all([memo.get("k", load(spinesA), () => ++builds), memo.get("k", load(spinesA), () => ++builds)]);
    expect(builds).toBe(2);
  });
});

describe("T33-S1 treeFor in the app", () => {
  const setup = (treeTtlMs: number) => {
    db = openDb(path.join(root, "c.db"));
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read, treeTtlMs, browser: { browserUrl: "http://127.0.0.1:9" } });
    const m = createStore(db).createMilestone({ title: "fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    const tree = async () => (await app.request(`/api/milestones/${m.id}/tree`)).json() as Promise<{ root: { children: { id: string }[] } }>;
    return { tree };
  };
  const ids = (t: { root: { children: { id: string }[] } }) => t.root.children.map((c) => c.id);

  it("serves the memoized tree within the TTL and shows a spine edit once it is off or dropped", async () => {
    const memoed = setup(60_000);
    const before = ids(await memoed.tree());
    write("fold/docs/spines/root.md", spine("root", "| R-1 | Row | ready |\n| R-2 | New row | ready |\n"));
    expect(ids(await memoed.tree())).toEqual(before); // within the TTL: unchanged inputs are served from the memo
    db!.close();
    const fresh = setup(0);
    expect(ids(await fresh.tree())).toContain("R-2");
  });

  it("concurrent identical tree requests all answer with the same tree", async () => {
    const { tree } = setup(60_000);
    const out = await Promise.all([tree(), tree(), tree()]);
    expect(new Set(out.map((t) => JSON.stringify(t))).size).toBe(1);
  });
});
