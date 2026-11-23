import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeStatus } from "../src/adapters/doc.js";
import { buildTree, colorFor, statusWordOf, subtree, type TreeNode } from "../src/adapters/tree.js";

/**
 * house_decision #20/#21 read Status `queued` and were flagged "unknown status" (the owner 2026-11-02). `queued`
 * is ready (grey), `backlog` not started; a leaf row carries its Depends on and Next action for the node page.
 * The rows are ~/github/house_decision/EPIC.md's Issue Ledger as of 2026-11-02.
 */
const EPIC = `# EPIC: House decision

Spine ID: house-decision

## Current State

Status: active

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| https://github.com/Acme/house_decision/issues/16 | Ticket worker | T3 seat pool claudeAgent_seat2 (opus 5.5) | M1-C Basecamp synthesis: graded HTML report + ranked recommendation | done | #14, #15 | research/M1C-synthesis (merged c461476, removed) | main | shortlists/m1-basecamp.json/.html; research/m1/synthesis.md; 38/38 tests OK | 2026-10-15 | Sam reviews and picks |
| https://github.com/Acme/house_decision/issues/17 | Ticket worker | T3 seat pool claudeAgent_seat1 (opus 5.5) | M1-D Airbnb amenity-tower benchmark across the Americas (pool + gym + sauna, 1 week) | paused (data kept: ~11.9k listings in /tmp/m1d/cache, code on pushed branch research/M1D-airbnb-benchmark @ 318dc14; worktree removed 2026-10-16) | #16 | research/M1D-airbnb-benchmark | main | dispatched 2026-10-15 | 2026-10-15 | Verify, integrate, link from M1 report |
| https://github.com/Acme/house_decision/issues/20 | Ticket worker | unassigned | M1-G Worldwide Airbnb benchmark page + value-for-luxury lens + 'most luxury for least money now' leaderboard (no gate) | queued | #17, #18, #19 | none | main | issue created 2026-10-15 | 2026-10-15 | Dispatch when #17-#19 are integrated |
| https://github.com/Acme/house_decision/issues/21 | Ticket worker | unassigned | M1-H Purchase price check (EUR/m2, fees, yield) for best value + weather cities | queued | #20 | none | main | issue created 2026-10-15 | 2026-10-15 | Dispatch after #20 |
`;

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function house() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e35s2-"));
  cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const repo = path.join(dir, "house_decision");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/house_decision.git\n`);
  fs.writeFileSync(path.join(repo, "EPIC.md"), EPIC);
  return buildTree(dir, { id: "ms_house", repo: "Acme/house_decision", path: "EPIC.md", paused: false, title: "House decision" });
}
const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)];
const issue = (root: TreeNode, n: number) => all(root).find((x) => x.id.endsWith(`/issues/${n}`))!;

describe("T35-S2 queued is a known status", () => {
  it("queued → ready (grey, known); backlog → draft", () => {
    expect(statusWordOf("queued")).toBe("ready");
    expect(colorFor("queued")).toEqual({ color: "grey", known: true });
    expect(statusWordOf("backlog")).toBe("draft");
    expect(colorFor("backlog")).toEqual({ color: "grey", known: true });
    expect(statusWordOf("moved to backlog")).toBe("superseded");
    expect(normalizeStatus("queued").status).toBe("ready");
    expect(normalizeStatus("backlog").status).toBe("pending");
  });

  it("house_decision #20/#21 (queued, Depends On #17-#19 / #20) are not flagged and carry Depends on + Next action", () => {
    const t = house();
    const n20 = issue(t.root, 20);
    const n21 = issue(t.root, 21);
    for (const n of [n20, n21]) {
      expect(n.status).toBe("queued");
      expect(n.color).toBe("grey");
      expect(n.flags).not.toContain("unknown-status");
    }
    expect(n20.dependsOn).toBe("#17, #18, #19");
    expect(n20.nextAction).toBe("Dispatch when #17-#19 are integrated");
    expect(n21.dependsOn).toBe("#20");
    expect(n21.nextAction).toBe("Dispatch after #20");
    expect(all(t.root).filter((x) => x.flags.includes("unknown-status"))).toEqual([]);
    // The node view of #20 (a leaf) keeps the row's fields.
    const sub = subtree(t, n20.key)!;
    expect(sub.root.children).toEqual([]);
    expect(sub.root.nextAction).toBe("Dispatch when #17-#19 are integrated");
    expect(sub.flagged).toBe(0);
  });
});

describe("a row carries its Last Verified date", () => {
  it("the tree node has `since` from the Last Verified cell (the Hosts waiting queue's since when)", () => {
    const t = house();
    expect(issue(t.root, 20).since).toBe("2026-10-15");
    expect(issue(t.root, 20).nextAction).toBe("Dispatch when #17-#19 are integrated");
  });
});
