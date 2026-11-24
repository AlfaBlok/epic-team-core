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

// The owner's press on a row was refused: a worker's hand edit had put an empty
// `| |` cell between the branch and the evidence. One stray empty cell is mended when only one reading exists.
describe("a row with one stray empty cell is mended, his press lands", () => {
  const STRAY = "| E907-S4 | Ticket worker | run_12c9c41e (started 2026-11-24) | The profile | review (/profile/ live) | E907-S3 | none | main |  | http://x/profile/#table | 2026-11-24 | followups: start Rents; confirm: yes |";
  it("approves the row and writes it back with eleven cells", async () => {
    const { setRowMendLog } = await import("../src/review/rows.js");
    const logged: string[] = [];
    setRowMendLog((m) => logged.push(m));
    const e = editRowStatus(spine(STRAY), "E907-S4", approveCell("E907-S4", "2026-11-24"));
    if ("skip" in e) throw new Error(e.skip);
    expect(e.after).toBe("| E907-S4 | Ticket worker | run_12c9c41e (started 2026-11-24) | The profile | done (approved by OWNER 2026-11-24) | E907-S3 | none | main | http://x/profile/#table | 2026-11-24 | followups: start Rents; confirm: yes |".replace("OWNER", e.after.match(/approved by (.+?) 2026/)![1]));
    expect(e.after.split(/(?<!\\)\|/).length - 2).toBe(11);
    expect(e.mended).toMatch(/extra empty cell \(cell 9 of 12\)/);
    expect(logged.join("\n")).toMatch(/row E907-S4: an extra empty cell/);
  });
  it("mends a trailing empty cell", () => {
    const trailing = WHOLE.replace(/ \|$/, " |  |");
    const e = editRowStatus(spine(trailing), "E907-S3", approveCell("E907-S3", "2026-11-23"));
    expect(e).toMatchObject({ status: "review", mended: expect.stringMatching(/cell 12 of 12/) });
  });
  it("mends two adjacent empty cells as one reading", async () => {
    const { mendCells } = await import("../src/review/rows.js");
    const heads = ["Issue", "Status", "PR", "Next"];
    expect(mendCells(["E1", "review", "", "", "go"], heads)?.cells).toEqual(["E1", "review", "", "go"]);
  });
  it("refuses when two different empty cells could be the stray one", async () => {
    const { mendCells } = await import("../src/review/rows.js");
    expect(mendCells(["E1", "", "review", "", "go"], ["Issue", "Owner", "Status", "Next"])).toBeUndefined();
  });
  it("refuses when dropping the empty cell leaves no status in the Status column", async () => {
    const { mendCells } = await import("../src/review/rows.js");
    expect(mendCells(["E1", "", "x", "review", "go"], ["Issue", "Status", "Owner", "Next"])).toBeUndefined();
  });
  it("still refuses an unescaped pipe inside a cell (no empty cell to drop)", () => {
    const pipe = WHOLE.replace("The Context tab", "The Context | Pages tab");
    const e = editRowStatus(spine(pipe), "E907-S3", approveCell("E907-S3", "2026-11-23"));
    expect(e).toMatchObject({ skip: expect.stringMatching(/12 cells but its header has 11/) });
  });
});
