import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { buildTree, type SpinesWait, type Tree, type TreeNode } from "../src/adapters/tree.js";
import { expandRanges, jordiLine } from "../src/inbox/freeText.js";
import { waitingAndDefects } from "../src/inbox/waiting.js";
import { milestoneStatus, paintTree, type PaintedNode, type PendingItem } from "../src/status/compute.js";
import { createStore, type Milestone } from "../src/store.js";
import { createStatus } from "../src/status/routes.js";

// one unit, "a thing the owner can act on now", the same N everywhere. Fixture: memory
// as it stood at ea46e35 (Status draft, `Waiting on: the owner stamps this epic ready; the cap figure
// (asked at T3, not before)`, no `## Waiting on` ask behind either code). Before: two "Respond: Waits on memory/|A2"
// cards, N=2, no red dot. After: one "Mark ready" item, not counted, the codes a defect for the owner.
const EPIC7 = (status: string, waiting: string) => `# PLAN-7: Real-user production test — 5 testers on free passes

## Current State

Owner: Delivery manager (memo)
Status: ${status}
Waiting on: ${waiting}
Next action: once \`ready\`, dispatch T0 and T1 in parallel
`;
const OLD_LINE = "T7-A1 Sam stamps this epic `ready`; T7-A2 the cap figure (asked at T3, not before)";

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s13-"));
  write("memo/.git/config", `[remote "origin"]\n\turl = https://github.com/acme-ai/memo.git\n`);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

const unresolved = (code: string): SpinesWait => ({ ref: code, repo: null, code, row: null, state: "unresolved" });

async function memo(status: string, waiting: string, waits: SpinesWait[] = []) {
  write("memo/docs/PLAN-7-REAL-USER-TEST.md", EPIC7(status, waiting));
  db = openDb(path.join(reposRoot, "c.db"));
  const store = createStore(db);
  const m = store.createMilestone({ title: "Memo", repo: "acme-ai/memo", path: "docs/PLAN-7-REAL-USER-TEST.md", owner: "Sam", paused: false });
  const treeFor = async (x: Milestone): Promise<Tree> => {
    const t = buildTree(reposRoot, x, undefined);
    if (waits.length) t.waits = { "docs/PLAN-7-REAL-USER-TEST.md": waits };
    return t;
  };
  const tree = await treeFor(m);
  const r = await waitingAndDefects({ store, reposRoot, treeFor, blame: async () => undefined }, { milestoneId: m.id });
  const st = milestoneStatus({ milestone: m, status, tree, waiting: r.items, defects: r.defects, runs: [], assignments: [] });
  return { m, tree, ...r, st, painted: paintTree(tree, st.items, st.defects) };
}

const redDots = (n: TreeNode): number => ((n as PaintedNode).color === "red" ? ((n as PaintedNode).waiting ?? 0) : 0) + n.children.reduce((a, c) => a + redDots(c), 0);

describe("T13-S13 rule 1+2: only what Sam can act on now counts", () => {
  it("Memo PLAN-7 (draft): one Mark ready item, the future ask not counted, the codes a defect for the owner, never 'Waits on'", async () => {
    const z = await memo("draft", OLD_LINE, [unresolved("T7-A1"), unresolved("T7-A2")]);
    expect(z.items.map((i) => [i.signal, i.title, i.gate ?? null])).toEqual([["stamp_ready", "Mark PLAN-7 ready", null]]);
    expect(z.items.some((i) => /waits on/i.test(`${i.title} ${i.question}`))).toBe(false);
    expect(z.st.items.map((i) => [i.kind, i.state, i.title])).toEqual([["mark_ready", "open", "Mark PLAN-7 ready"]]);
    expect(z.st.needsYou).toBe(1);
    expect(z.st.flow).toMatchObject({ word: "needs_you", reason: "1 to mark ready" });
    expect(z.defects.map((d) => `${d.repo}/${d.code}`).sort()).toEqual(["memo/T7-A1", "memo/T7-A2"]);
    expect(z.st.reasons.filter((r) => r.startsWith("defect for the Delivery Manager:"))).toHaveLength(2);
    // Rule 3+4: the Tree red count is the same N, one red dot on.
    expect(z.painted.counts.red).toBe(1);
    expect(redDots(z.painted.root)).toBe(1);
    expect((z.painted.root as PaintedNode).color).toBe("red");
  });

  it("the same line on a ready epic (Sam stamped it, memo 5a95ff9): nothing to do, N = 0", async () => {
    const z = await memo("ready", "nobody (Sam stamped `ready` in chat 2026-10-31; the cap figure is asked at T3, not before)");
    expect(z.st.needsYou).toBe(0);
    expect(z.st.items.filter((i) => i.state === "open")).toEqual([]);
    expect(z.painted.counts.red).toBe(0);
    const stale = await memo("ready", OLD_LINE, [unresolved("T7-A1"), unresolved("T7-A2")]);
    expect(stale.st.needsYou).toBe(0);
  });

  it("a stamp for later ('only after PLAN-34 is live') is Coming up, not counted", async () => {
    const z = await memo("draft", "Sam stamps ready (only after PLAN-34 is live: the social skin proves the path)");
    expect(z.items.map((i) => i.gate)).toEqual(["future"]);
    expect(z.st.needsYou).toBe(0);
  });

  it("an ask waiting on another agent ('the abnb-agent manager runs it with Sam-approved texts') is not Sam's", async () => {
    const z = await memo("active", "E38-3: the abnb-agent manager runs the A2 resend and the thread-reply half with Sam-approved texts");
    expect(z.items).toEqual([]);
    expect(z.st.needsYou).toBe(0);
  });

  it("T13-S14: a free-text line for Sam (no coded ask) is not counted: a defect for the owner, amber in the Tree, not red", async () => {
    const z = await memo("active", "Sam reviews the pitch deck: offer, launch channels (slide 14)");
    expect(z.st.items.filter((i) => i.state === "open")).toEqual([]);
    expect(z.st.needsYou).toBe(0);
    expect(z.painted.counts.red).toBe(0);
    expect(z.painted.root.color).toBe("yellow");
    expect(z.st.defects).toEqual([expect.objectContaining({ kind: "free_text", path: "docs/PLAN-7-REAL-USER-TEST.md", line: 6, text: "Sam named at docs/PLAN-7-REAL-USER-TEST.md:7 with no ask: write a coded ask or drop the line" })]);
  });
});

describe("T13-S13 jordiLine", () => {
  it("splits at ';', keeps only parts where Sam acts, separates later steps, spots the ready stamp", () => {
    expect(jordiLine(OLD_LINE)).toEqual({ now: ["T7-A1 Sam stamps this epic ready"], later: [], stamp: true });
    expect(jordiLine("Sam: T7-A2 the cap figure (asked at T3, not before)")).toMatchObject({ now: [], later: [expect.any(String)] });
    expect(jordiLine("Sam scans the QR when pinged")).toMatchObject({ now: [], stamp: false });
    expect(jordiLine("the manager sends the Sam-approved texts").now).toEqual([]);
    expect(jordiLine("Sam phone check (no ask; reported in thread)")).toMatchObject({ now: ["Sam phone check (no ask"], stamp: false });
  });
});

describe("T13-S13 rule 4 + T6-S42: tree red is exactly the counted items", () => {
  const node = (key: string, children: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({ key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "blocked", color: "grey", flags: [], children, ...extra });
  const tree = (): Tree => {
    const root = node("ms/root", [node("ms/root/PLAN-10", [node("ms/root/PLAN-10/T10-S0"), node("ms/root/PLAN-10/T10-S1")], { kind: "spine" }), node("ms/root/ref", [], { flags: ["repeat"], color: "red" })], { kind: "spine" });
    return { root, counts: { red: 0, yellow: 0, blue: 0, grey: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, warnings: [], source: "spines" } as unknown as Tree;
  };
  const item = (o: Partial<PendingItem>): PendingItem => ({ id: "i1", kind: "ask", state: "open", milestoneId: "other", title: "PLAN-29-A1", code: "PLAN-29-A1", ...o });

  it("an ask of another milestone sits on its first referencing row here; the other referencing rows get the ring, not a dot", () => {
    const p = paintTree(tree(), [item({ nodeKey: "elsewhere/T29-S0", refNodes: ["ms/root/PLAN-10/T10-S0", "ms/root/PLAN-10/T10-S1"] })]);
    const [epic, ref] = p.root.children as PaintedNode[];
    const [s0, s1] = epic.children as PaintedNode[];
    expect([s0.color, s0.waiting]).toEqual(["red", 1]);
    expect(s1.color).not.toBe("red");
    expect(s1.waitsOn).toEqual(["PLAN-29-A1"]);
    expect(epic.rollup).toBe("red");
    // A reference node (shown elsewhere) is never a red dot.
    expect(ref.color).not.toBe("red");
    expect(p.counts.red).toBe(1);
    expect(redDots(p.root)).toBe(1);
  });

  it("two items on one node: one red dot carrying 2, the counts row says 2", () => {
    const p = paintTree(tree(), [item({ id: "a", nodeKey: "ms/root/PLAN-10/T10-S0" }), item({ id: "b", nodeKey: "ms/root/PLAN-10/T10-S0" })]);
    expect(p.counts.red).toBe(2);
    expect(redDots(p.root)).toBe(2);
  });
});

describe("T13-S13 found on production (2026-11-01 count proof)", () => {
  const ROWS = (status: string) => `# PLAN-34: Social team MVP

## Current State

Owner: Delivery manager
Status: active
Waiting on: nobody

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| T34-S7 | Ticket worker | worker | Campaign desk | ${status} | none | - | main | none | 2026-10-31 | build |
| T34-S8 | Ticket worker | worker | Ideas | ${status} | none | - | main | none | 2026-10-31 | build |
| T34-S14 | Sam | Sam | Sam uses it a week and gives the verdict | draft | T34-S7..S8 | - | main | none | 2026-10-31 | use it |
`;
  const ASK = "- [ask PLAN-34-A2: do @Sam since 2026-10-28 row T34-S14] Start your week on the social console — steps: open the URL — unblocks: T34-S14";
  const setup = async (status: string, tail = "") => {
    write("memo/docs/e34.md", ROWS(status) + tail);
    db = openDb(path.join(reposRoot, "s.db"));
    const store = createStore(db);
    // Two milestones over the same spine (the code repo root and its milestone share epic-34.md).
    const a = store.createMilestone({ title: "root", repo: "acme-ai/memo", path: "docs/e34.md", owner: "Sam", paused: false });
    const b = store.createMilestone({ title: "PLAN-34", repo: "acme-ai/memo", path: "docs/e34.md", owner: "Sam", paused: false });
    const treeFor = async (x: Milestone) => buildTree(reposRoot, x, undefined);
    const deps = { store, reposRoot, treeFor, blame: async () => undefined };
    const st = createStatus({ db, store, milestoneInfo: async () => ({}), treeFor, waiting: (f) => waitingAndDefects(deps, f) });
    return { a, b, st };
  };

  it("expandRanges spells out T0–T6 and T34-S7..S12; leaves plain codes alone", () => {
    expect(expandRanges("T0–T6")).toBe("T0 T1 T2 T3 T4 T5 T6");
    expect(expandRanges("T34-S7..S12, T34-S15")).toBe("T34-S7 T34-S8 T34-S9 T34-S10 T34-S11 T34-S12, T34-S15");
    expect(expandRanges("T10-S1, PLAN-29-A1")).toBe("T10-S1, PLAN-29-A1");
  });

  it("a Sam row after a range of open sibling rows (T34-S7..S8) is a later step, not counted", async () => {
    const { a, b, st } = await setup("active");
    expect((await st.one(a)).needsYou).toBe(0);
    expect((await st.one(b)).needsYou).toBe(0);
  });

  it("T13-S14: a Sam row with no coded ask counts nowhere (a defect on both milestones), once its siblings are done", async () => {
    const { a, b, st } = await setup("done");
    const all = await st.all();
    expect(all.needsYou).toBe(0);
    for (const m of [a, b]) {
      const one = await st.one(m);
      expect(one.needsYou).toBe(0);
      expect(one.defects?.map((d) => [d.kind, d.path, d.line])).toEqual([["free_text", "docs/e34.md", 14]]);
    }
  });

  it("T13-S14 (PLAN-34-A2): a coded ask written outside `## Waiting on` is no card; the defect says to move it", async () => {
    const { a, st } = await setup("done", ASK);
    const one = await st.one(a);
    expect(one.needsYou).toBe(0);
    expect(one.defects?.[0]).toMatchObject({ kind: "free_text", text: "docs/e34.md:15 has ask PLAN-34-A2 outside `## Waiting on`, so no card shows: move the line under `## Waiting on`" });
  });

  it("T13-S14: the row's coded ask under `## Waiting on` is the card on both milestones' pages, no free-text item; the Team badge counts it once", async () => {
    const { a, b, st } = await setup("done", `\n## Waiting on\n${ASK}`);
    const all = await st.all();
    for (const m of [a, b]) {
      const one = await st.one(m);
      expect(one.items.filter((i) => i.state === "open").map((i) => [i.kind, i.code])).toEqual([["ask", "PLAN-34-A2"]]);
      expect(one.defects ?? []).toEqual([]);
      expect(all.milestones.find((x) => x.milestoneId === m.id)!.needsYou).toBe(1);
    }
    expect(all.needsYou).toBe(1);
  });
});
