import { describe, expect, it } from "vitest";
import { approveCell, editRowStatus, expireLeaseText } from "../src/review/rows.js";

// "A claim can never break a ticket's row". A real line of 22 Nov had twelve cells under an
// eleven-column header; the console must never write a status or lease into such a row by column.
const HEAD = "| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |";
const SEP = "|---|---|---|---|---|---|---|---|---|---|---|";
const CLAIM = "run_12c9c41e — claimed 2026-11-22T21:02Z, lease until 2026-11-22T23:02Z";
const spine = (...rows: string[]) => ["# EPIC-907", "", "## Issue Ledger", "", HEAD, SEP, ...rows, ""].join("\n");
const WHOLE = `| E907-S3 | Ticket worker | ${CLAIM} | The Context tab | review | none | none | main | live | 2026-11-22 | confirm: yes |`;
const BROKEN = `| E907-S3 | Ticket worker | ${CLAIM} | run_12c9c41e (host1) — review | active | review | none | main | none | live | 2026-11-22 | confirm: yes |`;

describe("a row out of its columns is never written", () => {
  it("approves a whole row", () => {
    const e = editRowStatus(spine(WHOLE), "E907-S3", approveCell("E907-S3", "2026-11-23"));
    expect(e).toMatchObject({ status: "review" });
  });
  it("refuses the twelve-cell break, naming both counts", () => {
    const e = editRowStatus(spine(BROKEN), "E907-S3", approveCell("E907-S3", "2026-11-23"));
    expect(e).toMatchObject({ skip: expect.stringMatching(/12 cells but its header has 11/) });
  });
  it("never expires a lease into a broken row", () => {
    const active = BROKEN.replace("| active | review |", "| active | active |");
    const out = expireLeaseText(spine(active), "E907-S3", "run_12c9c41e", "2026-11-22T23:02Z", "2026-11-22T23:05Z");
    expect(out).toMatchObject({ skip: expect.stringMatching(/12 cells/) });
  });
});
