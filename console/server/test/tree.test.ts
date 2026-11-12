import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { SpinesJson, SpinesRunner } from "../src/adapters/spines.js";
import { buildTree, colorFor, MAX_DEPTH, statusWordOf, todoLeaves, treeTodoSection, type TreeNode } from "../src/adapters/tree.js";
import type { ReadConfig } from "../src/routes/read.js";

const ROOT = `# EPIC: Tree root

Spine ID: tree-root

## Current State

Status: active

## Definition Of Done

- [ ] T-1 First ticket shipped
- [x] T-3 Third ticket shipped
- [ ] DOD-9 Something with no ledger row

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T-1 | Ship the first thing | done |
| T-2 | Needs a decision | blocked — waiting on Sam approval |
| T-3 | Waits for T-2 | blocked on T-2 |
| [T-4](../../tickets/T-4.md) | Chain head | |
| T-5 | Odd status | wibble |
| T-6 | Dropped idea | superseded by T-4 |
| [CH](child.md) | Child spine via ledger | active |
`;

const CHILD = `# EPIC: Child

Spine ID: tree-child
Parent spine: root.md

## Current State

Status: done

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| C-1 | Still running | active |
`;

const ticket = (id: string, status: string, next?: string, extra = "") =>
  `# ${id}: ticket ${id}\n\nTicket ID: ${id}\nStatus: ${status}\n${extra}\n## Tickets\n\n| Ticket | Title |\n|---|---|\n` +
  (next ? `| [${next}](${next}.md) | next |\n` : "");

function spinesFor(): SpinesJson {
  return {
    root: "docs/spines/root.md",
    nodes: [
      {
        id: "tree-root",
        path: "docs/spines/root.md",
        title: "EPIC: Tree root",
        parent: null,
        status: "active",
        rollup_status: "active",
        dod: [
          { id: "T-1", text: "First ticket shipped", done: false },
          { id: "T-3", text: "Third ticket shipped", done: true },
          { id: "DOD-9", text: "Something with no ledger row", done: false },
        ],
        children: ["docs/spines/child.md"],
      },
      { id: "tree-child", path: "docs/spines/child.md", title: "EPIC: Child", parent: "docs/spines/root.md", status: "done", rollup_status: "done", dod: [], children: [] },
    ],
    orphans: [],
    mismatches: [{ path: "docs/spines/child.md", parent: "docs/spines/root.md", problem: "not in the parent's Spine Map" }],
    stale: [{ path: "docs/spines/root.md", title: "EPIC: Tree root", days: 20 }],
  } as SpinesJson;
}

let reposRoot: string;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const M = { id: "ms_t", repo: "Acme/tree", path: "docs/spines/root.md", paused: false, title: "Tree" };

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-tree-"));
  write("tree/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/tree.git\n`);
  write("tree/docs/spines/root.md", ROOT);
  write("tree/docs/spines/child.md", CHILD);
  // sub-ticket chain T-4 → T-4a → T-4b → back to T-4 (cycle); T-4b is done but has an unchecked acceptance box.
  write("tree/tickets/T-4.md", ticket("T-4", "active", "T-4a"));
  write("tree/tickets/T-4a.md", ticket("T-4a", "blocked — waiting on worker seat2", "T-4b"));
  write("tree/tickets/T-4b.md", ticket("T-4b", "done", "T-4", "\n## Acceptance\n\n- [x] AC-1 one\n- [ ] AC-2 two\n"));
});
afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

const find = (n: TreeNode, id: string): TreeNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)];

describe("colorFor (EpicSpine vocabulary + M2-3 Sam heuristic)", () => {
  it.each([
    ["draft", "grey"],
    ["ready — not started", "grey"],
    ["deferred", "grey"],
    ["superseded by M2-10", "grey"],
    ["active", "blue"],
    ["review", "blue"],
    ["testing on staging", "blue"],
    ["done 54e12ca, deployed", "green"],
    ["blocked on T-2", "yellow"],
    ["blocked — waiting on Sam approval", "red"],
    ["waiting (Sam root, ops S2/S3)", "red"],
  ])("%s → %s", (raw, color) => expect(colorFor(raw).color).toBe(color));
  it("unparseable → grey, unknown; Waiting on naming Sam makes a bare blocked red", () => {
    expect(colorFor("wibble")).toEqual({ color: "grey", known: false });
    expect(colorFor(undefined)).toEqual({ color: "grey", known: false });
    expect(colorFor("blocked", "Sam's go on P2").color).toBe("red");
    expect(colorFor("blocked", "vendor quote; then Sam").color).toBe("yellow");
  });
});

describe("status sources: ledger row, epic Current State, ticket header; never page prose", () => {
  const PAGE = `# Human asks contract\n\n## Rules\n\n**Status:** the blocked row gets Status blocked\nWaiting on: Sam approval (example)\n`;
  const EPIC = `# EPIC: Linked\n\nSpine ID: linked-epic\n\n## Current State\n\nStatus: blocked — waiting on Sam\n\n## Notes\n\nStatus: active\n`;
  const ROOT12 = `# EPIC: Doctrine\n\nSpine ID: doc-root\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n` +
    `| S-12 | Human asks; [contract](../doctrine/human-asks.md) | done |\n` +
    `| S-13 | Page link, no cell; [notes](../doctrine/human-asks.md) | |\n` +
    `| S-14 | Linked epic; [epic](linked.md) | done |\n` +
    `| S-15 | Linked epic, no cell; [epic](linked.md) | |\n` +
    `| [S-16](../../tickets/S-16.md) | Ticket file | active |\n`;
  const M12 = { ...M, path: "docs/spines/doc-root.md" };
  beforeEach(() => {
    write("tree/docs/doctrine/human-asks.md", PAGE);
    write("tree/docs/spines/linked.md", EPIC);
    write("tree/docs/spines/doc-root.md", ROOT12);
    // Ticket: header Status wins over the row cell (unchanged); body prose `Status:` after a heading is ignored.
    write("tree/tickets/S-16.md", `# S-16: ticket\n\nStatus: done\n\n## Notes\n\nStatus: blocked on everything\n`);
  });
  const spines12 = (): SpinesJson => ({
    root: "docs/spines/doc-root.md",
    nodes: [
      { id: "doc-root", path: "docs/spines/doc-root.md", title: "EPIC: Doctrine", parent: null, status: "active", rollup_status: "active", dod: [], children: ["docs/spines/linked.md"] },
      { id: "linked-epic", path: "docs/spines/linked.md", title: "EPIC: Linked", parent: "docs/spines/doc-root.md", status: "blocked", rollup_status: "blocked", dod: [], children: [] },
    ],
    orphans: [],
    mismatches: [],
  }) as SpinesJson;

  it.each([["fallback (no spines.py)", undefined], ["spines.py", spines12]])("%s: page prose never colours a row; the row cell wins", (_l, sp) => {
    const t = buildTree(reposRoot, M12, sp?.());
    const rows = t.root.children;
    expect(rows[0]).toMatchObject({ id: "S-12", color: "green", status: "done" });
    // Second row on the same page: its own counted step (not a repeat ref), no status from the page.
    expect(rows[1]).toMatchObject({ id: "S-13", color: "grey", status: "unknown", flags: ["unknown-status"], children: [] });
    expect(rows[2]).toMatchObject({ color: "green", status: "done" });
    // No status cell: the linked epic's Current State Status (blocked on the owner), never its body `Status: active`.
    const s15 = rows[3];
    expect(s15).toMatchObject({ color: "red" });
    expect(statusWordOf(s15.status)).toBe("blocked");
    expect(rows[4]).toMatchObject({ id: "S-16", color: "green", status: "done", path: "tickets/S-16.md" });
  });

  it("an epic's own node takes its Current State Status, and a page has no status", async () => {
    const { parseDoc } = await import("../src/adapters/doc.js");
    expect(parseDoc(PAGE).statusLine).toBeUndefined();
    expect(parseDoc(EPIC).statusLine).toBe("blocked — waiting on Sam");
    expect(parseDoc("# T\n\nTicket ID: T\nStatus: ready\n\n## Body\n\nStatus: done\n").statusLine).toBe("ready");
    const t = buildTree(reposRoot, { ...M, path: "docs/spines/linked.md" }, spines12());
    // spines.py `status` (Current State), not the body `Status: active`.
    expect(t.root).toMatchObject({ id: "linked-epic", color: "yellow", status: "blocked" });
  });
});

describe("buildTree", () => {
  it("spine → ledger tickets → linked ticket chain, child spine merged with its ledger row, unmatched DoD as leaves", () => {
    const t = buildTree(reposRoot, M, spinesFor());
    expect(t.source).toBe("spines");
    expect(t.root).toMatchObject({ kind: "spine", id: "tree-root", color: "blue" });
    expect(t.root.children.map((c) => `${c.kind}:${c.id}`)).toEqual([
      "ticket:T-1", "ticket:T-2", "ticket:T-3", "ticket:T-4", "ticket:T-5", "ticket:T-6", "spine:tree-child", "dod:DOD-9",
    ]);
    expect(find(t.root, "DOD-9")!.title).toBe("Something with no ledger row");
    expect(find(t.root, "AC-2")!.title).toBe("two");
    const chain = find(t.root, "T-4")!;
    expect(chain).toMatchObject({ color: "blue", path: "tickets/T-4.md" });
    expect(chain.children[0]).toMatchObject({ id: "T-4a", color: "yellow", path: "tickets/T-4a.md" });
    expect(chain.children[0].children[0]).toMatchObject({ id: "T-4b", color: "green" });
    // keys are unique
    const keys = all(t.root).map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("guards the cycle T-4 → T-4a → T-4b → T-4", () => {
    const t4b = find(buildTree(reposRoot, M, spinesFor()).root, "T-4b")!;
    const back = t4b.children.find((c) => c.id === "T-4")!;
    expect(back.flags).toEqual(["cycle"]);
    expect(back.children).toEqual([]);
  });

  it("flags dishonest green both ways, done-with-unchecked-acceptance, and done parents over open children", () => {
    const t = buildTree(reposRoot, M, spinesFor());
    expect(find(t.root, "T-1")!.flags).toContain("dishonest-green"); // ledger done, DoD T-1 unchecked
    expect(find(t.root, "T-3")!.flags).toContain("dishonest-green"); // DoD T-3 checked, ledger blocked
    const t4b = find(t.root, "T-4b")!;
    expect(t4b.flags).toContain("dishonest-green");
    expect(t4b.flags).toContain("done-open-descendants"); // AC-2 open
    // The CH row says active; the child epic's own Status (done) is noted, not used for the row node.
    const child = find(t.root, "tree-child")!;
    expect(child).toMatchObject({ color: "blue", status: "active" });
    expect(child.flags).toContain("mismatch");
    expect(child.notes).toContain("ledger row says active; the epic's own Status is done");
    expect(find(t.root, "T-2")!.color).toBe("red");
    expect(find(t.root, "T-5")!).toMatchObject({ color: "grey", flags: ["unknown-status"] });
    expect(t.root.flags).toContain("stale");
  });

  it("counts by color; refs not counted; superseded is grey but not to-do", () => {
    const t = buildTree(reposRoot, M, spinesFor());
    // root-only rows: a child spine is one roll-up line; its rows are counted in its own tree.
    const own = (n: TreeNode): TreeNode[] => [n, ...(n !== t.root && n.kind === "spine" ? [] : n.children.flatMap(own))];
    const counted = own(t.root).filter((n) => !n.flags.includes("cycle") && !n.flags.includes("repeat"));
    expect(Object.values(t.counts).reduce((a, b) => a + b, 0)).toBe(counted.length);
    expect(t.closed).toBe(1);
    expect(t.nonGreen).toBe(counted.filter((n) => n.color !== "green").length - 1);
    expect(t.flagged).toBeGreaterThanOrEqual(6);
  });

  it("caps depth", () => {
    for (let i = 0; i < 10; i++) write(`tree/tickets/D-${i}.md`, ticket(`D-${i}`, "active", i < 9 ? `D-${i + 1}` : undefined));
    write("tree/docs/spines/root.md", ROOT + "| [D-0](../../tickets/D-0.md) | deep | |\n");
    const t = buildTree(reposRoot, M, spinesFor());
    let n = find(t.root, "D-0")!;
    let depth = 1;
    while (n.children.length) (n = n.children[0]), depth++;
    expect(depth).toBe(MAX_DEPTH);
    expect(n.flags).toContain("depth-cap");
  });

  it("without spines.py: doc parser only (no child spine node, no mismatch/stale), still a tree", () => {
    const t = buildTree(reposRoot, M, undefined);
    expect(t.source).toBe("fallback");
    expect(t.warnings[0]).toMatch(/spines\.py/);
    expect(find(t.root, "T-4b")).toBeDefined();
    expect(find(t.root, "CH")).toMatchObject({ kind: "ticket", path: "docs/spines/child.md", color: "blue" }); // CH row says active
  });

  it("missing repo / file → a single grey node with a note", () => {
    const t = buildTree(reposRoot, { ...M, repo: "nope" }, undefined);
    expect(t.root.children).toEqual([]);
    expect(t.nonGreen).toBe(1);
    expect(t.warnings[0]).toMatch(/repo nope/);
  });
});

describe("persona to-do", () => {
  it("lists non-green leaves + flagged nodes, red first, skips closed and refs, caps with +N more", () => {
    const t = buildTree(reposRoot, M, spinesFor());
    const leaves = todoLeaves(t);
    expect(leaves[0]).toMatchObject({ id: "T-2", color: "red" });
    expect(leaves.map((l) => l.id)).not.toContain("T-6");
    expect(leaves.map((l) => l.id)).toEqual(expect.arrayContaining(["T-1", "T-3", "T-5", "DOD-9", "C-1", "AC-2"]));
    expect(leaves.find((l) => l.id === "AC-2")!.path).toBe("tickets/T-4b.md");
    const s = treeTodoSection(t);
    expect(s).toContain("turn every node under this milestone green; at the end, report which nodes changed color");
    expect(s).toContain("- [red] T-2 — Needs a decision — blocked — waiting on Sam approval");
    const capped = treeTodoSection(t, 3);
    expect(capped.split("\n").filter((l) => l.startsWith("- [")).length).toBe(3);
    expect(capped).toContain(`- +${leaves.length - 3} more (GET /api/milestones/ms_t/tree)`);
  });

  it("is injected into the wake prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-tree-db-"));
    const db = openDb(path.join(dir, "c.db"));
    try {
      const store = createStore(db);
      const m = store.createMilestone({ title: "Tree", repo: M.repo, path: M.path, owner: "Sam", paused: false });
      const p = store.createPersona({ name: "PM", remit: "push it", skills: [], model: "x", mayWrite: false });
      const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
      const cycle = createCycle(db, store, { enabled: true, publicUrl: "http://x", treeTodo: async (mm) => treeTodoSection(buildTree(reposRoot, mm, spinesFor())) });
      const w = await cycle.wake(a.id);
      expect(w.prompt).toContain("## Epic tree (your to-do)");
      expect(w.prompt.indexOf("## Epic tree")).toBeLessThan(w.prompt.indexOf("## Console protocol"));
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("API", () => {
  let dbDir: string;
  let db: DB;
  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-tree-api-"));
    db = openDb(path.join(dbDir, "c.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  const appWith = (spines?: SpinesRunner) => {
    const cfg: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [], spines };
    return createApp(db, { read: cfg });
  };
  const post = async (app: ReturnType<typeof createApp>, body: unknown) =>
    (await app.request("/api/milestones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

  it("GET /api/milestones/:id/tree and nonGreen on the list", async () => {
    const app = appWith(async () => spinesFor());
    const m = await post(app, { title: "Tree", repo: "Acme/tree", path: "docs/spines/root.md", owner: "Sam" });
    const res = await app.request(`/api/milestones/${m.id}/tree`);
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t).toMatchObject({ milestoneId: m.id, source: "spines", root: { id: "tree-root" } });
    const list = await (await app.request("/api/milestones")).json();
    expect(list[0].nonGreen).toBe(t.nonGreen);
    expect((await app.request("/api/milestones/nope/tree")).status).toBe(404);
  });

  it("spines.py failing → fallback tree, still 200; broken milestone has no nonGreen", async () => {
    const app = appWith(async () => {
      throw new Error("boom");
    });
    const m = await post(app, { title: "Tree", repo: "Acme/tree", path: "docs/spines/root.md", owner: "Sam" });
    await post(app, { title: "Broken", repo: "nope", path: "x.md", owner: "Sam" });
    expect((await (await app.request(`/api/milestones/${m.id}/tree`)).json()).source).toBe("fallback");
    const list = await (await app.request("/api/milestones")).json();
    expect(list.find((x: any) => x.title === "Tree").nonGreen).toBeGreaterThan(0);
    expect(list.find((x: any) => x.title === "Broken").nonGreen).toBeUndefined();
  });
});

describe("T6-S14 ready · nobody on it", () => {
  it("marks ready rows with no gate as ready; todo (T6-S41: first word `ready` only), draft, blocked, Sam-gated, active and done rows are not", () => {
    write(
      "tree/docs/spines/r.md",
      "# EPIC: R\n\nSpine ID: r\n\n## Current State\n\nStatus: ready\n\n## Issue Ledger\n\n| Issue | Title | Status | Needs |\n|---|---|---|---|\n" +
        "| S1 | a | ready | |\n| S2 | b | todo | |\n| S3 | c | draft | |\n| S4 | d | blocked on S1 | |\n| S5 | e | ready | Sam go |\n| S6 | f | active | |\n| S7 | g | done | |\n",
    );
    const t = buildTree(reposRoot, { ...M, path: "docs/spines/r.md" });
    const ready = all(t.root).filter((n) => n.ready).map((n) => n.id);
    expect(ready).toEqual(["S1"]);
    expect(t.root.ready).toBeUndefined();
    expect(find(t.root, "S1")!.color).toBe("grey");
    expect(find(t.root, "S5")!.color).toBe("red");
  });
});
