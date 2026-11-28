import { describe, expect, it } from "vitest";
import { needsHim, writeFollowups } from "../src/review/followups.js";
import { waitingLine } from "../src/review/review.js";

/**
 * A follow-up his Start press makes that needs his Mac or his yes waits under its Mac ticket or ask, never reads
 * ready (two such rows once sat ready for hours with nobody able to start them).
 */
const SPINE = [
  "# EPIC-907",
  "",
  "## Issue Ledger",
  "",
  "| ID | Role | Owner | Title | Status | Depends | PR | Base | Latest Evidence | Verified | Next Action |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  "| E907-S7 | Ticket worker | run_x | Credits sign-ups | review | none | none | main | page | 2026-11-28 | followups: none |",
  "",
].join("\n");

describe("needsHim", () => {
  it("reads the two rows that sat ready", () => {
    expect(needsHim("Superscout sign-up and listing, Claude on his Mac")).toBe("mac");
    expect(needsHim("Real clinic payments at the first clinic", "needs his yes to use the live Stripe key (money)")).toBe("yes");
  });
  it("reads other ways of saying it", () => {
    expect(needsHim("Run the export", "a Mac-agent ticket")).toBe("mac");
    expect(needsHim("Sign in on your laptop")).toBe("mac");
    expect(needsHim("Send the mails", "waits on the owner's approval")).toBe("yes");
    expect(needsHim("Go live after your OK")).toBe("yes");
  });
  it("leaves work the team can do alone ready", () => {
    expect(needsHim("Fix the Mac build of the app")).toBeUndefined();
    expect(needsHim("Add a yes button to the card")).toBeUndefined();
    expect(needsHim("Write the Stripe test checkout", "his words asked for it")).toBeUndefined();
  });
});

describe("writeFollowups", () => {
  const picks = [
    { title: "Superscout sign-up and listing, Claude on his Mac", start: true },
    { title: "Real clinic payments", why: "needs his yes to use the live Stripe key (money)", start: true },
    { title: "Shortlist ten more programs", start: true },
    { title: "Pay for the listing", why: "needs his yes", start: false },
  ];
  const f = writeFollowups(SPINE, "E907-S7", picks, "2026-11-28", "Sam");
  if ("skip" in f) throw new Error(f.skip);
  const row = (ref: string) => f.text.split("\n").find((l) => l.startsWith(`| ${ref} |`))!.split(" | ");

  it("writes a Mac or yes follow-up waiting, with what the Delivery Manager writes for it", () => {
    expect(f.rows.map((r) => [r.ref, r.status, r.needs])).toEqual([
      ["E907-S8", "waiting", "mac"],
      ["E907-S9", "waiting", "yes"],
      ["E907-S10", "ready", undefined],
      ["E907-S11", "draft", undefined],
    ]);
    expect(row("E907-S8")[4]).toBe("waiting (on Sam's Mac: its Mac-agent ticket on his Mac list, never a ready row)");
    expect(row("E907-S8")[10]).toMatch(/^Delivery Manager: write its Mac-agent ticket/);
    expect(row("E907-S9")[4]).toBe("waiting (on Sam's yes: its one ask in his inbox, never a ready row)");
    expect(row("E907-S9")[10]).toMatch(/^Delivery Manager: post its one coded ask under Waiting on/);
  });
  it("keeps the rest as before: ready to dispatch, parked as draft, all named on the closed row", () => {
    expect(row("E907-S10")[4]).toBe("ready");
    expect(row("E907-S10")[10]).toBe("worker |");
    expect(row("E907-S11")[4]).toBe("draft");
    expect(row("E907-S7")[10]).toBe("followups: started E907-S8, E907-S9, E907-S10, E907-S11 |");
  });
  it("tells the Delivery Manager never to dispatch them", () => {
    const line = waitingLine(f.rows.filter((r) => r.status === "waiting"));
    expect(line).toContain("Waiting on his Mac, never dispatch: E907-S8");
    expect(line).toContain("Waiting on his yes, never dispatch: E907-S9");
    expect(line).not.toContain("E907-S10");
  });
});
