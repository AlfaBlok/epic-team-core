import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { dedupeMoving, movingLimit, sortMoving, type MovingEpic } from "../src/cycle/movement.js";
import { createMovement } from "../src/cycle/movementRoutes.js";

// Moving now lists each spine once, workers first then most recent commit, and `?limit=` returns that many.

const epic = (over: Partial<MovingEpic> = {}): MovingEpic => ({
  milestoneId: "ms_root",
  repo: "Acme/home_repo",
  path: "docs/spines/epic-46.md",
  title: "PLAN-46",
  status: "active",
  workers: [],
  doneToday: [],
  ready: [],
  rows: [],
  ...over,
});

describe("dedupeMoving", () => {
  it("one line per spine: the milestone whose own spine it is wins; workers and done rows merge", () => {
    const fromRoot = epic({ milestoneId: "ms_root", workers: [{ ticket: "T46-S8", runId: "r1", persona: "W" }], ready: ["T46-S8", "T46-S9"], lastCommitAt: "2026-11-02T10:00:00Z" });
    const own = epic({ milestoneId: "ms_46", path: "./docs/spines/epic-46.md", doneToday: ["T46-S7"], ready: ["T46-S8", "T46-S9"], lastCommitAt: "2026-11-02T09:00:00Z" });
    const other = epic({ path: "docs/spines/epic-14.md", title: "PLAN-14" });
    const out = dedupeMoving([fromRoot, other, own], [
      { id: "ms_root", path: "docs/spines/root.md" },
      { id: "ms_46", path: "docs/spines/epic-46.md" },
    ]);
    expect(out).toHaveLength(2);
    const e46 = out.find((e) => e.title === "PLAN-46")!;
    expect(e46.milestoneId).toBe("ms_46");
    expect(e46.workers.map((w) => w.runId)).toEqual(["r1"]);
    expect(e46.doneToday).toEqual(["T46-S7"]);
    expect(e46.ready).toEqual(["T46-S9"]);
    expect(e46.lastCommitAt).toBe("2026-11-02T10:00:00Z");
  });
  it("no own milestone: the first stays; the same worker is not counted twice", () => {
    const w = { ticket: "E1", runId: "r1", persona: "W" };
    const out = dedupeMoving([epic({ milestoneId: "a", workers: [w] }), epic({ milestoneId: "b", workers: [w] })]);
    expect(out).toEqual([expect.objectContaining({ milestoneId: "a", workers: [w] })]);
  });
  it("other repos with the same path stay apart", () => {
    expect(dedupeMoving([epic(), epic({ repo: "Acme/ops" })])).toHaveLength(2);
  });
});

it("sortMoving: workers first, then most recent commit, undated last", () => {
  const w = [{ ticket: "E1", runId: "r", persona: "W" }];
  const out = sortMoving([
    epic({ title: "old", lastCommitAt: "2026-10-01T00:00:00Z" }),
    epic({ title: "none" }),
    epic({ title: "new", lastCommitAt: "2026-11-02T00:00:00Z" }),
    epic({ title: "worker", workers: w, lastCommitAt: "2026-09-01T00:00:00Z" }),
  ]);
  expect(out.map((e) => e.title)).toEqual(["worker", "new", "old", "none"]);
});

it("movingLimit: a positive whole number, else all", () => {
  expect(movingLimit("20")).toBe(20);
  expect(movingLimit("50")).toBe(50);
  for (const q of [undefined, "all", "0", "-3", "2.5", "x"]) expect(movingLimit(q)).toBeUndefined();
});

describe("GET /api/moving-now", () => {
  let dir: string;
  let db: DB;
  afterEach(() => {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const node = (over: Partial<TreeNode>): TreeNode => ({ key: over.id ?? "k", id: "x", kind: "ticket", title: "", status: "ready", color: "grey", children: [], flags: [], ...over });
  const spine = (n: number) =>
    node({ id: `EPIC-${n}`, key: `EPIC-${n}`, kind: "spine", path: `docs/spines/epic-${n}.md`, title: `EPIC-${n}`, status: "active", children: [node({ id: `E${n}-S1`, key: `E${n}-S1` })] });

  it("each spine once, `limit` lines and the total", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s14-"));
    db = openDb(path.join(dir, "console.db"));
    const store = createStore(db);
    const root = store.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "sam", paused: false });
    const own = store.createMilestone({ title: "SocialApp launch", repo: "Acme/home_repo", path: "docs/spines/epic-46.md", owner: "sam", paused: false });
    const children = Array.from({ length: 30 }, (_, i) => spine(i + 100));
    const trees: Record<string, Tree> = {
      [root.id]: { milestoneId: root.id, root: node({ id: "root", key: "root", kind: "spine", path: "docs/spines/root.md", title: "root", status: "active", children }) } as Tree,
      [own.id]: { milestoneId: own.id, root: spine(46) } as Tree,
    };
    children.push(spine(46)); // under the root milestone too
    const mv = createMovement({ store, treeFor: async (m) => trees[m.id], repoDir: () => undefined, seats: () => [], enabled: false });
    const app = new Hono();
    mv.mount(app);
    const get = async (q = "") => (await app.request(`/moving-now${q}`)).json() as Promise<{ epics: MovingEpic[]; total: number }>;

    const all = await get();
    expect(all.total).toBe(31);
    expect(all.epics).toHaveLength(31);
    expect(all.epics.filter((e) => e.path === "docs/spines/epic-46.md")).toEqual([expect.objectContaining({ milestoneId: own.id })]);
    const twenty = await get("?limit=20");
    expect(twenty.total).toBe(31);
    expect(twenty.epics).toHaveLength(20);
    expect((await get("?limit=all")).epics).toHaveLength(31);
  });
});
