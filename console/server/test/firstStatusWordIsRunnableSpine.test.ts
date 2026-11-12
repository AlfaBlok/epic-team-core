import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpinesJson } from "../src/adapters/spines.js";
import { buildTree, firstStatusWord, isRunnableSpine, type TreeNode } from "../src/adapters/tree.js";
import { epicsOf, isGoing } from "../src/cycle/movement.js";
import { readySteps } from "../src/cycle/wakeEnding.js";

/**
 * two stall-watch false flags left after (found by):
 * - a draft epic read as ready: run_a27119bb (2026-10-28 02:18Z) 'launched no worker … while 1 row reads ready:
 *   recruit-testers' (draft); and the wake check's readyIds listed epics with Status ready that
 *   hold no ready rows (the spine node itself was marked ready);
 * - a status that only contains the word: 'handed over (… ready for that repo's DM)' read as a ready row.
 * One test (isReadyRow, the tree's `ready`) feeds readyIds, the stall watch and readySteps: a row whose status cell's
 * first word is `ready`, in spines that are all runnable.
 */
describe("T6-S41 firstStatusWord / isRunnableSpine", () => {
  it("reads the first word only", () => {
    expect(firstStatusWord("ready")).toBe("ready");
    expect(firstStatusWord("**Ready** (after T6-S40)")).toBe("ready");
    expect(firstStatusWord("handed over (PLAN-28 in social, ready for that repo's DM)")).toBe("handed");
    expect(firstStatusWord("open")).toBe("open");
    expect(firstStatusWord("")).toBeUndefined();
  });
  it("runnable: run_state ready/running; else the first word ready/active/blocked", () => {
    expect(isRunnableSpine({ status: "ready", runState: "planning" })).toBe(false); // a row cell says ready, the epic is draft
    expect(isRunnableSpine({ status: "draft", runState: "ready" })).toBe(true);
    for (const rs of ["planning", "parked", "finished"]) expect(isRunnableSpine({ status: "active", runState: rs })).toBe(false);
    expect(isRunnableSpine({ status: "blocked on T6-A1" })).toBe(true);
    for (const st of ["draft", "deferred", "review", "done", "superseded by PLAN-9"]) expect(isRunnableSpine({ status: st })).toBe(false);
  });
  it("the stall watch's isGoing reads the first word too", () => {
    expect(isGoing("active")).toBe(true);
    expect(isGoing("handed over (… ready for that repo's DM)")).toBe(false);
  });
});

const LEDGER = "| Issue | Role | Owner / Assignment | Title | Status | Depends On | Next Action |\n|---|---|---|---|---|---|---|\n";
const spine = (id: string, title: string, status: string, rows: string) =>
  `# ${id}: ${title}\n\nSpine ID: ${id.toLowerCase()}\n\n## Current State\n\nOwner: Delivery manager\nStatus: ${status}\n\n## Issue Ledger\n\n${LEDGER}${rows}\n## Decisions\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n`;
const RUN: Record<string, string> = { draft: "planning", ready: "ready", active: "running", blocked: "running", deferred: "parked", review: "finished", done: "finished" };
const node = (id: string, file: string, title: string, status: string, parent: string | null, children: string[] = []) => ({
  id: id.toLowerCase(), path: `docs/spines/${file}`, title: `${id}: ${title}`, parent, status, rollup_status: status, dod: [], children,
  run_state: RUN[status], runnable: ["ready", "running"].includes(RUN[status]),
});
const EPICS: [string, string, string, string][] = [
  // [id, file, own Status, its rows]
  ["PLAN-1", "recruit-testers.md", "draft", "| T1-S1 | Ticket worker | seat pool | Find testers | ready | none | go |\n"],
  ["PLAN-2", "ready-epic.md", "ready", "| T2-S1 | Ticket worker | seat pool | Plan it | draft | none | plan |\n"],
  ["PLAN-3", "work.md", "active", [
    "| T3-S1 | Ticket worker | seat pool | Free step | ready | none | go |",
    "| T3-S2 | Ticket worker | seat pool | Moved | handed over (PLAN-28 in social, ready for that repo's DM) | none | none |",
    "| T3-S3 | Ticket worker | seat pool | Not started | open | none | go |",
    "| T3-S4 | Ticket worker | seat pool | Waiting | blocked until it is ready | none | wait |",
  ].join("\n") + "\n"],
  ["PLAN-4", "in-review.md", "review", "| T4-S1 | Ticket worker | seat pool | Leftover | ready | none | go |\n"],
  ["PLAN-5", "parked.md", "deferred", "| T5-S1 | Ticket worker | seat pool | Later | ready | none | go |\n"],
];
const SPINES = {
  root: "docs/spines/root.md",
  nodes: [node("PLAN-0", "root.md", "demo", "active", null, EPICS.map((e) => `docs/spines/${e[1]}`)), ...EPICS.map(([id, file, st]) => node(id, file, id, st, "docs/spines/root.md"))],
  orphans: [],
  mismatches: [],
} as unknown as SpinesJson;

let reposRoot: string;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const M = { id: "ms_e6s41", repo: "Acme/demo", path: "docs/spines/root.md", paused: false, title: "demo" };
const readyIds = (n: TreeNode): string[] => [...(n.ready ? [n.id] : []), ...n.children.flatMap(readyIds)];

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e6s41-"));
  write("demo/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/demo.git\n`);
  // The root's row cells all say `ready` (as a social world repo's root did for its draft): the epic's own Status decides.
  write("demo/docs/spines/root.md", spine("PLAN-0", "demo", "active", EPICS.map(([id, file]) => `| [${id}](${file}) | DM | DM | ${id} | ready | none | go |`).join("\n") + "\n"));
  for (const [id, file, st, rows] of EPICS) write(`demo/docs/spines/${file}`, spine(id, id, st, rows));
});
afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

describe("T6-S41 the tree's ready", () => {
  it("only T3-S1: no spine, no row of a draft / review / deferred epic, no status that merely contains `ready`", () => {
    const t = buildTree(reposRoot, M, SPINES);
    expect(readyIds(t.root)).toEqual(["T3-S1"]);
    expect(readySteps(t)).toEqual(["T3-S1"]);
  });
  it("the stall watch reads the same rows", () => {
    const t = buildTree(reposRoot, M, SPINES);
    const ready = Object.fromEntries(epicsOf(t).map((e) => [path.basename(e.path), e.ready]));
    expect(ready["recruit-testers.md"]).toEqual([]);
    expect(ready["ready-epic.md"]).toEqual([]);
    expect(ready["work.md"]).toEqual(["T3-S1"]);
    expect(ready["in-review.md"]).toEqual([]);
    expect(ready["parked.md"]).toEqual([]);
  });
});
