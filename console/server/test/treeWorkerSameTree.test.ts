import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTree } from "../src/adapters/tree.js";
import { depsChanged, depsChangedAsync, trackDeps } from "../src/adapters/fileDeps.js";
import { createTreeOff, treeWorkerFile } from "../src/adapters/treeOff.js";
import { createTreeMemo } from "../src/adapters/treeMemo.js";
import type { SpinesJson } from "../src/adapters/spines.js";

// milestone trees are built in a worker thread so the console's event loop stays free; the worker must
// give exactly the tree and file deps the inline build gives, and the memo must fall back to the inline build.

const ROOT = `# EPIC: Tree root

Spine ID: tree-root

## Current State

Status: active
Waiting on: none

## Definition Of Done

- [ ] T-1 First ticket shipped
- [ ] DOD-9 Something with no ledger row

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T-1 | Ship the first thing | done |
| T-2 | Needs a decision | blocked — waiting on Sam approval |
| [T-4](../../tickets/T-4.md) | Chain head | |
| [CH](child.md) | Child spine via ledger | active |
`;
const CHILD = `# EPIC: Child\n\nSpine ID: tree-child\nParent spine: root.md\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| C-1 | Still running | active |\n`;
const T4 = `# T-4: ticket\n\nTicket ID: T-4\nStatus: active\n`;
const spines = (): SpinesJson =>
  ({
    root: "docs/spines/root.md",
    nodes: [
      { id: "tree-root", path: "docs/spines/root.md", title: "EPIC: Tree root", parent: null, status: "active", rollup_status: "active", dod: [{ id: "T-1", text: "First ticket shipped", done: false }], children: ["docs/spines/child.md"] },
      { id: "tree-child", path: "docs/spines/child.md", title: "EPIC: Child", parent: "docs/spines/root.md", status: "active", rollup_status: "active", dod: [], children: [] },
    ],
    orphans: [],
    mismatches: [],
    stale: [],
  }) as SpinesJson;

let reposRoot: string;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const M = { id: "ms_t", repo: "Acme/tree", path: "docs/spines/root.md", paused: false, title: "Tree" };
const OWNER = { name: "Sam" } as never;

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-tree-worker-"));
  write("tree/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/tree.git\n`);
  write("tree/docs/spines/root.md", ROOT);
  write("tree/docs/spines/child.md", CHILD);
  write("tree/tickets/T-4.md", T4);
});
afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

const dev = new URL("../src/adapters/treeWorker-dev.mjs", import.meta.url);
const off = createTreeOff(dev, () => {});
afterAll(() => off.close());

describe("tree worker", () => {
  it("builds the same tree and the same file deps as the inline build", async () => {
    const s = spines();
    const inline = trackDeps(() => buildTree(reposRoot, M, s, OWNER));
    const viaWorker = await off.buildOff(reposRoot, M, s, OWNER);
    expect(JSON.parse(JSON.stringify(viaWorker.value))).toEqual(JSON.parse(JSON.stringify(inline.value)));
    expect([...viaWorker.deps.keys()].sort()).toEqual([...inline.deps.keys()].sort());
    expect(viaWorker.deps.size).toBeGreaterThan(0);
    // the same spines.py output again is not cloned across a second time, and still builds
    const again = await off.buildOff(reposRoot, M, s, OWNER);
    expect(JSON.parse(JSON.stringify(again.value))).toEqual(JSON.parse(JSON.stringify(inline.value)));
    expect(off.stats().builds).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("is off for the tests and tsx unless asked for, and off when CONSOLE_TREE_WORKER=0", () => {
    expect(treeWorkerFile({})).toBeUndefined();
    expect(treeWorkerFile({ CONSOLE_TREE_WORKER: "0" })).toBeUndefined();
    expect(treeWorkerFile({ CONSOLE_TREE_WORKER: "1" })?.href).toMatch(/treeWorker-dev\.mjs$/);
  });

  it("the memo builds through makeOff, and falls back to the inline build when it fails", async () => {
    const memo = createTreeMemo<string, number>(1_000);
    let inline = 0;
    const viaOff = await memo.get("a", () => ({ spines: 1 }), () => (inline++, "inline"), true, undefined, async () => ({ value: "off", deps: new Map() }));
    expect(viaOff).toBe("off");
    expect(inline).toBe(0);
    const fallback = await memo.get("b", () => ({ spines: 1 }), () => (inline++, "inline"), true, undefined, async () => Promise.reject(new Error("tree worker: exited (1)")));
    expect(fallback).toBe("inline");
    expect(inline).toBe(1);
  });

  it("depsChangedAsync answers as depsChanged does", async () => {
    const { deps } = trackDeps(() => buildTree(reposRoot, M, spines(), OWNER));
    expect(await depsChangedAsync(deps)).toBe(false);
    expect(depsChanged(deps)).toBe(false);
    fs.appendFileSync(path.join(reposRoot, "tree/tickets/T-4.md"), "\nmore\n");
    expect(await depsChangedAsync(deps)).toBe(true);
    expect(depsChanged(deps)).toBe(true);
  });
});
