import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addLedgerRow } from "../src/status/add.js";
import { highestRowNumber, repoRowIds } from "../src/status/rowIds.js";
import { addAcceptedAskRow, writeFollowups } from "../src/review/followups.js";

/**
 * the console once wrote a new row with an id another epic's spine already held (rows moved out of an epic keep their
 * ids). Row ids are numbered across every spine of the repo: the next free number for the epic code.
 */
const SIX = `# EPIC-907: Team unattended

## Issue Ledger

| ID | Role | Owner | Title | Status | Next Action |
|---|---|---|---|---|---|
| E907-S225 | Ticket worker | unassigned | lost work | review | none |
| E907-S226 | Ticket worker | unassigned | fable credit | review | none |
`;
const ONE_OH_FIVE = `# EPIC-908: Alignment

## Issue Ledger

| ID | Role | Owner | Title | Status | Next Action |
|---|---|---|---|---|---|
| E907-S227 | Ticket worker | unassigned | overall card, moved here from EPIC-907 | draft | none |
| E907-S229 | Ticket worker | unassigned | another moved row | draft | none |
`;

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
function repo(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rowids-"));
  fs.mkdirSync(path.join(dir, "docs", "spines", "nested"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "spines", "m6-team-unattended.md"), SIX);
  fs.writeFileSync(path.join(dir, "docs", "spines", "nested", "epic-105-alignment.md"), ONE_OH_FIVE);
  return dir;
}

describe("E907-S230 row ids are numbered across the repo", () => {
  it("the collision: a new EPIC-907 row skips E907-S227 and E907-S229, which EPIC-908 holds, and takes E907-S230", () => {
    const d = repo();
    const taken = repoRowIds(d, undefined, Date.now() + 60_000);
    expect(taken).toEqual(expect.arrayContaining(["E907-S225", "E907-S226", "E907-S227", "E907-S229"]));
    expect(highestRowNumber("E907-S", taken)).toBe(229);
    const before = addLedgerRow(SIX, { title: "waiting tickets start by themselves" }, "2026-11-23", { ready: true });
    expect("id" in before && before.id).toBe("E907-S227"); // the old per-spine numbering: the collision
    const out = addLedgerRow(SIX, { title: "waiting tickets start by themselves" }, "2026-11-23", { ready: true, taken });
    expect("id" in out && out.id).toBe("E907-S230");
  });

  it("follow-ups and accepted asks take the repo-wide next number too", () => {
    const d = repo();
    const taken = repoRowIds(d, ["E907-S"], Date.now() + 120_000);
    const f = writeFollowups(SIX, "E907-S226", [{ title: "next step", start: true }], "2026-11-23", "Sam", taken);
    expect("rows" in f && f.rows.map((r) => r.ref)).toEqual(["E907-S230"]);
    const a = addAcceptedAskRow(SIX, { code: "E907-A99", question: "Do we keep it?" }, "2026-11-23", "Sam", taken);
    expect("ref" in a && a.ref).toBe("E907-S230");
  });

  it("an unreadable repo takes nothing away (per-spine numbering as before)", () => {
    expect(repoRowIds(undefined)).toEqual([]);
    expect(repoRowIds("/nonexistent/repo")).toEqual([]);
  });
});
