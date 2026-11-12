import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpinesJson } from "../src/adapters/spines.js";
import { buildTree, subtree, todoLeaves, type TreeNode } from "../src/adapters/tree.js";
import { openDescendantGoals, paintTree } from "../src/status/compute.js";

/**
 * finished epics (spines.py run_state) are closed work: not counted as open, their leftovers do not flag
 * parents, a live epic first met inside one is shown at its live place; superseded rows are closed, never ready.
 */
const spine = (id: string, status: string, rows: string) =>
  `# EPIC: ${id}\n\nSpine ID: ${id}\n\n## Current State\n\nStatus: ${status}\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n${rows}`;

const node = (id: string, file: string, status: string, run_state: string, parent: string | null, children: string[] = []) => ({
  id, path: `docs/spines/${file}`, title: `EPIC: ${id}`, parent, status, rollup_status: status, dod: [], children, run_state,
});

function spines(rootStatus = "active", kids = ["docs/spines/old.md", "docs/spines/live.md"]): SpinesJson {
  return {
    root: "docs/spines/root.md",
    nodes: [
      node("root", "root.md", rootStatus, rootStatus === "done" ? "finished" : "running", null, kids),
      node("OLD", "old.md", "done", "finished", "docs/spines/root.md"),
      node("LIVE", "live.md", "active", "running", "docs/spines/root.md"),
    ],
    orphans: [],
    mismatches: [],
  } as SpinesJson;
}

let reposRoot: string;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const M = { id: "ms_f", repo: "Acme/fold", path: "docs/spines/root.md", paused: false, title: "Fold" };
const find = (n: TreeNode, id: string): TreeNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e16s4-"));
  write("fold/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
  // OLD is finished but still carries an open row and a row naming its successor LIVE (met first, inside OLD).
  write("fold/docs/spines/old.md", spine("OLD", "done", "| O-1 | Leftover | ready |\n| [LIVE](live.md) | Successor | superseded |\n"));
  write("fold/docs/spines/live.md", spine("LIVE", "active", "| L-1 | Next step | ready |\n| L-2 | Dropped | superseded |\n"));
  write("fold/docs/spines/root.md", spine("root", "active", "| [OLD](old.md) | Old epic | done |\n| [LIVE](live.md) | Live epic | active |\n| R-1 | Dropped idea | superseded |\n"));
});
afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

describe("T16-S4 finished epics fold, superseded is closed", () => {
  it("spine nodes carry spines.py run_state verbatim", () => {
    const t = buildTree(reposRoot, M, spines());
    expect(t.root.runState).toBe("running");
    expect(t.root.children.map((c) => [c.id, c.runState])).toEqual([["OLD", "finished"], ["LIVE", "running"], ["R-1", undefined]]);
  });

  it("a live epic first met inside a finished one is expanded at its live place; the copy inside is the reference", () => {
    const t = buildTree(reposRoot, M, spines());
    const live = t.root.children[1];
    expect(live).toMatchObject({ id: "LIVE", flags: [] });
    expect(live.children.map((c) => c.id)).toEqual(["L-1", "L-2"]);
    expect(live.children[0].key.startsWith(live.key + "/")).toBe(true);
    const inside = t.root.children[0].children.find((c) => c.id === "LIVE")!;
    expect(inside.flags).toEqual(["repeat"]);
    expect(inside.children).toEqual([]);
    const keys: string[] = [];
    const walk = (n: TreeNode) => (keys.push(n.key), n.children.forEach(walk));
    walk(t.root);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("counts open work only: a finished epic and its rows are left out and counted in `finished`", () => {
    const t = buildTree(reposRoot, M, spines());
    // root (blue), LIVE (blue, its roll-up line), R-1 (superseded: grey, closed). OLD and O-1 not counted;:
    // LIVE's own rows (L-1, L-2) are counted in LIVE's tree only.
    expect(t.finished).toBe(1);
    expect(t.counts).toEqual({ grey: 1, blue: 2, yellow: 0, red: 0, green: 0 });
    expect(t.closed).toBe(1);
    expect(t.nonGreen).toBe(2);
    expect(todoLeaves(t).map((l) => l.id)).toEqual(["L-1"]);
    expect(openDescendantGoals(t)).toBe(1); // LIVE; OLD (finished) is not an open goal
    // paintTree keeps the same rule
    expect(paintTree(t, []).nonGreen).toBe(2);
  });

  it("the node view of a finished epic counts its own content", () => {
    const t = buildTree(reposRoot, M, spines());
    const old = subtree(t, t.root.children[0].key)!;
    expect(old.finished).toBe(0);
    expect(old.nonGreen).toBe(1); // O-1
  });

  it("a finished child's leftovers flag that child, not a done parent (no 'done over open work' upward)", () => {
    write("fold/docs/spines/root.md", spine("root", "done", "| [OLD](old.md) | Old epic | done |\n| R-1 | Dropped idea | superseded |\n"));
    const t = buildTree(reposRoot, M, spines("done", ["docs/spines/old.md"]));
    expect(t.root.color).toBe("green");
    expect(t.root.flags).not.toContain("done-open-descendants");
    expect(find(t.root, "OLD")!.flags).toContain("done-open-descendants");
  });

  it("superseded rows are closed: grey, `closed`, never ready, not to-do", () => {
    const t = buildTree(reposRoot, M, spines());
    for (const id of ["R-1", "L-2"]) {
      const n = find(t.root, id)!;
      expect(n).toMatchObject({ color: "grey", closed: true });
      expect(n.ready).toBeUndefined();
    }
    expect(find(t.root, "L-1")).toMatchObject({ ready: true });
    expect(find(t.root, "L-1")!.closed).toBeUndefined();
  });
});
