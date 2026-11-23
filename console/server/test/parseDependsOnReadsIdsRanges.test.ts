import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpinesJson } from "../src/adapters/spines.js";
import { buildTree, notReadyBecause, parseDependsOn, type ReadyRules, type TreeNode } from "../src/adapters/tree.js";
import { ownerPatterns } from "../src/tenancy/owner.js";

/**
 * ready means a worker can start it. The first live stall-watch note (2026-10-28) flagged/27/30/31
 * rows waiting on the owner step through a sibling row, (the owner's own phone check) and (a free-text
 * condition). One rule (notReadyBecause, applied by the tree's markReady) feeds the stall watch, the wake prompt's
 * ready list and the wake fingerprint alike.
 */
describe("E914-S9 parseDependsOn", () => {
  it("reads ids, ranges, none and annotations; anything else is a condition", () => {
    expect(parseDependsOn("E926-S2, E929-S3")).toEqual({ ids: ["E926-S2", "E929-S3"], freeText: false });
    expect(parseDependsOn("E918-S1..S6").ids).toEqual(["E918-S1", "E918-S2", "E918-S3", "E918-S4", "E918-S5", "E918-S6"]);
    expect(parseDependsOn("S1-S4, E900-A6").ids).toEqual(["S1", "S2", "S3", "S4", "E900-A6"]);
    expect(parseDependsOn("M2-40").ids).toEqual(["M2-40"]);
    expect(parseDependsOn("E900-A11 (QR scan)")).toEqual({ ids: ["E900-A11"], freeText: false });
    expect(parseDependsOn("none")).toEqual({ ids: [], freeText: false });
    expect(parseDependsOn("—")).toEqual({ ids: [], freeText: false });
    expect(parseDependsOn("E926-S4 and E926-S5 merged").freeText).toBe(false);
    expect(parseDependsOn("a spine with a reference line")).toEqual({ ids: [], freeText: true });
    expect(parseDependsOn("[EPIC-900 e900-a11](EPIC-900-ROOT.md)").ids).toEqual(["EPIC-900", "E900-A11"]);
  });
});

describe("E914-S9 notReadyBecause", () => {
  const rules: ReadyRules = {
    openCodes: ["EPIC-929-A1"],
    askCodes: new Set(["EPIC-929-A1", "E914-A2"]),
    status: new Map([
      ["E926-S2", "open"],
      ["E926-S1", "done"],
      ["E929-S3", "merged (abc123)"],
      ["E918-S1", "done (live)"],
      ["E909-S1", "superseded by E909-S2"],
    ]),
    ownerCell: ownerPatterns("Sam").ownerCell,
  };
  const row = (dependsOn?: string, over: Partial<TreeNode> = {}) => ({ status: "open", dependsOn, ...over });

  it("an unfinished sibling blocks; a finished one (this epic or another) does not", () => {
    expect(notReadyBecause(row("E926-S2, E929-S3"), rules)).toBe("depends on E926-S2 (open)");
    expect(notReadyBecause(row("E926-S1, E929-S3"), rules)).toBeUndefined();
    expect(notReadyBecause(row("E909-S1"), rules)).toBeUndefined();
    expect(notReadyBecause(row("E918-S1..S2"), rules)).toBe("depends on E918-S2 (not found)");
  });

  it("a row Sam owns is never ready", () => {
    expect(notReadyBecause(row("none", { owner: "Sam" }), rules)).toBe("owner Sam");
    expect(notReadyBecause(row(undefined, { owner: "@Sam (phone)" }), rules)).toBe("owner @Sam (phone)");
    expect(notReadyBecause(row("none", { owner: "Delivery manager" }), rules)).toBeUndefined();
  });

  it("E996-S5: a Mac agent row is never ready for a server worker", () => {
    expect(notReadyBecause(row("none", { role: "Mac agent" }), rules)).toBe("needs Mac agent");
    expect(notReadyBecause(row("none", { role: "needs Mac agent" }), rules)).toBe("needs Mac agent");
    expect(notReadyBecause(row("none", { role: "Ticket worker" }), rules)).toBeUndefined();
  });

  it("a free-text condition is unmet unless the status says met", () => {
    expect(notReadyBecause(row("a spine with a reference line", { status: "ready" }), rules)).toBe("condition: a spine with a reference line");
    expect(notReadyBecause(row("a spine with a reference line", { status: "ready (condition met)" }), rules)).toBeUndefined();
  });

  it("ask codes as before (E908-S23): open blocks, answered does not", () => {
    expect(notReadyBecause(row("EPIC-929-A1"), rules)).toBe("open ask EPIC-929-A1");
    expect(notReadyBecause(row("E914-A2"), rules)).toBeUndefined();
    expect(notReadyBecause(row("E900-A3 (answered)"), rules)).toBeUndefined();
  });
});

// A root with two epics: rows wait on a sibling, on rows (cross-epic), on the owner, on a condition.
const LEDGER = "| Issue | Role | Owner / Assignment | Title | Status | Depends On | Next Action |\n|---|---|---|---|---|---|---|\n";
const spine = (id: string, title: string, rows: string) =>
  `# ${id}: ${title}\n\nSpine ID: ${id.toLowerCase()}\n\n## Current State\n\nOwner: Delivery manager\nStatus: active\n\n## Issue Ledger\n\n${LEDGER}${rows}\n## Decisions\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n`;
const node = (id: string, file: string, title: string, parent: string | null, children: string[] = []) => ({
  id: id.toLowerCase(), path: `docs/spines/${file}`, title: `${id}: ${title}`, parent, status: "active", rollup_status: "active", dod: [], children, run_state: "running", runnable: true,
});
const SPINES = {
  root: "docs/spines/root.md",
  nodes: [
    node("EPIC-900", "root.md", "demo", null, ["docs/spines/e1.md", "docs/spines/e2.md"]),
    node("EPIC-901", "e1.md", "one", "docs/spines/root.md"),
    node("EPIC-902", "e2.md", "two", "docs/spines/root.md"),
  ],
  orphans: [],
  mismatches: [],
} as unknown as SpinesJson;

let reposRoot: string;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const find = (n: TreeNode, id: string): TreeNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
const M = { id: "ms_e1", repo: "Acme/demo", path: "docs/spines/e1.md", paused: false, title: "one" };

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e14s9-"));
  write("demo/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/demo.git\n`);
  write("demo/docs/spines/root.md", spine("EPIC-900", "demo", "| [EPIC-901](e1.md) | DM | DM | one | active | none | go |\n| [EPIC-902](e2.md) | DM | DM | two | active | none | go |\n"));
  write(
    "demo/docs/spines/e2.md",
    spine("EPIC-902", "two", "| E902-S1 | Ticket worker | seat pool | Done thing | done (abc) | none | none |\n| E902-S2 | Ticket worker | seat pool | Open thing | open | none | go |\n"),
  );
});
afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

const e1 = (s2: string) =>
  write(
    "demo/docs/spines/e1.md",
    spine(
      "EPIC-901",
      "one",
      [
        `| E901-S2 | Sam | Sam | Create the account | ${s2} | none | EPIC-929-A1 |`,
        "| E901-S3 | Ticket worker | unassigned | Read tools | ready | E901-S2, E902-S1 | on ready |",
        "| E901-S4 | Ticket worker | unassigned | Post tools | ready | E902-S2 | after W1 |",
        "| E901-S5 | Ticket worker | Sam | Phone check | ready (waits Sam on the phone) | E901-S3 | wait |",
        "| E901-S6 | Delivery manager | manager | Live check | ready | a spine with a reference line | check when one appears |",
        "| E901-S7 | Ticket worker | seat pool | Free step | ready | none | go |",
        "| E901-S8 | Mac agent | Claude on Sam's Mac | Make the page in his Chrome | ready | none | his paste |",
      ].join("\n") + "\n",
    ),
  );

describe("E914-S9 the tree's ready", () => {
  it("sibling unfinished → not ready; finished → ready; Sam-owned never; condition never; cross-epic ids", () => {
    e1("open");
    let root = buildTree(reposRoot, M, SPINES).root;
    const ready = (id: string) => !!find(root, id)?.ready;
    expect(ready("E901-S2")).toBe(false); // the owner's step: an ask, not worker work
    expect(ready("E901-S3")).toBe(false); // waits on the owner's
    expect(ready("E901-S4")).toBe(false); //'s is open
    expect(ready("E901-S5")).toBe(false);
    expect(ready("E901-S6")).toBe(false);
    expect(ready("E901-S7")).toBe(true);
    expect(ready("E901-S8")).toBe(false); // a Mac agent row is never a server worker's
    expect(find(root, "E901-S8")?.role).toBe("Mac agent");

    e1("done (account live)");
    root = buildTree(reposRoot, M, SPINES).root;
    expect(ready("E901-S3")).toBe(true); // done, done
    expect(ready("E901-S5")).toBe(false); // still the owner's
  });
});

describe("a row waiting on a finished row moved to its epic's archive", () => {
  it("stays ready: the archive's done row counts like the ledger's", () => {
    e1("done (account live)");
    // E902-S1 (done) leaves e2's ledger for e2.archive.md, ids kept
    write("demo/docs/spines/e2.md", spine("EPIC-902", "two", "| E902-S2 | Ticket worker | seat pool | Open thing | open | none | go |\n"));
    expect(!!find(buildTree(reposRoot, M, SPINES).root, "E901-S3")?.ready).toBe(false); // not found anywhere yet
    write("demo/docs/spines/e2.archive.md", `# Archive of EPIC-902: finished rows\n\nArchive of: [EPIC-902: two](e2.md)\n\n## Issue Ledger\n\n${LEDGER}| E902-S1 | Ticket worker | seat pool | Done thing | done (abc) | none | none |\n`);
    expect(!!find(buildTree(reposRoot, M, SPINES).root, "E901-S3")?.ready).toBe(true);
  });
});
