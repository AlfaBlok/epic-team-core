import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createStore, type Milestone } from "../src/store.js";
import { progressOf, type Tree, type TreeNode } from "../src/adapters/tree.js";
import { milestoneStatus, type StatusInput } from "../src/status/compute.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import { coverOfIn, createStatus } from "../src/status/routes.js";

// milestones are the owner's big roots: a position per milestone, % done and the root's color in the status batch,
// and a big root tracked inside another milestone's spine is worked by that milestone's personas (not Stalled).

const NOW = Date.parse("2026-11-01T16:00:00Z");
const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children, flags: [], ...over,
});
const tree = (root: TreeNode): Tree => ({
  milestoneId: "m1", root, counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [],
});

describe("T40-S3 progressOf", () => {
  it("each level-1 branch weighs the same; a branch counts its share done; superseded rows and references are left out", () => {
    const root = node("r", { kind: "spine", status: "active", color: "blue" }, [
      node("r/A", { status: "done", color: "green" }),
      node("r/B", { kind: "spine", status: "active", color: "blue" }, [
        node("r/B/1", { status: "done", color: "green" }),
        node("r/B/2", { status: "active", color: "blue" }),
        node("r/B/3", { status: "superseded" }),
      ]),
      node("r/C", { status: "draft" }),
      node("r/D", { status: "ready", flags: ["repeat"] }),
    ]);
    // A = 1, B = 1/2 (its superseded row left out), C = 0 → 1.5 / 3 = 50%; 1 of 3 branches done.
    expect(progressOf(root)).toEqual({ pct: 50, done: 1, total: 3 });
  });

  it("a finished epic counts as done; a done root is 100; no children is 0", () => {
    const root = node("r", { kind: "spine", status: "active", color: "blue" }, [
      node("r/E", { kind: "spine", status: "review", color: "blue", runState: "finished" }, [node("r/E/1", { status: "active", color: "blue" })]),
      node("r/F", { status: "blocked", color: "yellow" }),
    ]);
    expect(progressOf(root)).toEqual({ pct: 50, done: 1, total: 2 });
    expect(progressOf(node("r", { kind: "spine", status: "done", color: "green" }, [node("r/x", { status: "draft" })])).pct).toBe(100);
    expect(progressOf(node("r", { kind: "spine", status: "draft" }))).toEqual({ pct: 0, done: 0, total: 0 });
  });
});

describe("T40-S3 status carries progress and the root's painted color", () => {
  const t = tree(node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/A", { status: "done", color: "green" }), node("m1/B", { status: "active", color: "blue" })]));
  const input = (over: Partial<StatusInput> = {}): StatusInput => ({ milestone: { id: "m1", paused: false }, status: "active", tree: t, waiting: [], runs: [], assignments: [], now: NOW, ...over });

  it("50% and blue with nothing waiting", () => {
    expect(milestoneStatus(input()).progress).toEqual({ pct: 50, done: 1, total: 2, color: "blue" });
  });

  it("red only for an open item of this milestone on the root; another milestone's item (its own node key) leaves the color", () => {
    const ask = (over: Partial<WaitingItem>): WaitingItem => ({ id: "w1", milestoneId: "m1", kind: "ask", ask: "decide", title: "T46-A1", state: "open", ...over }) as WaitingItem;
    expect(milestoneStatus(input({ waiting: [ask({ nodeKey: "m1" })] })).progress?.color).toBe("red");
    expect(milestoneStatus(input({ waiting: [ask({ nodeKey: "m1/B" })] })).progress?.color).toBe("blue");
    // Shared with the code repo's root milestone: listed here through referencedBy, keyed in that milestone's tree.
    expect(milestoneStatus(input({ waiting: [ask({ milestoneId: "m0", nodeKey: "root/PLAN-36/PLAN-46/T46-S1", referencedBy: [{ milestoneId: "m1" }] } as Partial<WaitingItem>)] })).progress?.color).toBe("blue");
  });

  it("no tree → no progress (the sidebar shows no bar rather than a wrong 0%)", () => {
    expect(milestoneStatus(input({ tree: undefined })).progress).toBeUndefined();
  });
});

describe("T40-S3 big root position on milestones", () => {
  it("stored on create, changed and cleared on update; absent on ordinary milestones", () => {
    const store = createStore(openDb(":memory:"));
    const a = store.createMilestone({ title: "SocialApp launch", repo: "Acme/home_repo", path: "docs/spines/epic-46-epic-social-launch.md", owner: "Sam", paused: false, bigRoot: 1 });
    const b = store.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
    expect(store.getMilestone(a.id)!.bigRoot).toBe(1);
    expect("bigRoot" in store.getMilestone(b.id)!).toBe(false);
    expect(store.updateMilestone(b.id, { bigRoot: 2 })!.bigRoot).toBe(2);
    expect("bigRoot" in store.updateMilestone(b.id, { bigRoot: null })!).toBe(false);
    expect(store.updateMilestone(a.id, { title: "x" })!.bigRoot).toBe(1); // a patch without it keeps it
  });
});

describe("T40-S3 a big root inside another milestone's spine is worked by that milestone's personas", () => {
  it("borrows the host's assignments: queued with the host's persona, not stalled", async () => {
    const db = openDb(":memory:");
    const store = createStore(db);
    const host = store.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
    const root46 = store.createMilestone({ title: "SocialApp launch", repo: "Acme/home_repo", path: "docs/spines/epic-46.md", owner: "Sam", paused: false, bigRoot: 1 });
    const dm = store.createPersona({ name: "Delivery Manager", remit: "steer", skills: [], model: "", mayWrite: false });
    const a = store.createAssignment({ milestoneId: host.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true, nextRunAt: new Date(NOW + 600_000).toISOString() });
    const trees: Record<string, Tree> = {
      [host.id]: tree(node("root", { kind: "spine", status: "active", color: "blue", path: "docs/spines/root.md" }, [
        node("root/PLAN-36", { kind: "spine", status: "active", color: "blue", path: "docs/spines/epic-36.md" }, [
          node("root/PLAN-36/PLAN-46", { kind: "spine", status: "active", color: "blue", path: "docs/spines/epic-46.md" }),
        ]),
      ])),
      [root46.id]: tree(node("e46", { kind: "spine", status: "active", color: "blue", path: "docs/spines/epic-46.md" }, [node("e46/S1", { ready: true })])),
    };
    const treeFor = async (m: Milestone) => trees[m.id];
    const deps = {
      db, store, treeFor, now: () => NOW,
      milestoneInfo: async () => ({ status: "active" }),
      waiting: async () => [],
    };
    const covered = createStatus({ ...deps, coverOf: coverOfIn(store, treeFor) });
    const st = await covered.one(store.getMilestone(root46.id)!);
    expect(st.flow.word).toBe("queued");
    expect(st.flow.personas).toEqual(["Delivery Manager"]);
    expect(st.items.filter((i) => i.kind === "stalled")).toEqual([]);
    expect(a.milestoneId).toBe(host.id); // the host's own assignment is untouched
    // Without the wiring the same milestone reads Stalled (the defect this guards).
    expect((await createStatus(deps).one(store.getMilestone(root46.id)!)).flow.word).toBe("stalled");
  });
});
