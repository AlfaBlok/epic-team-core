import { describe, expect, it } from "vitest";
import { milestoneStatus } from "../src/status/compute.js";
import { plainFinding, readyToMarkItem } from "../src/status/mark.js";
import { sendInWhy, shortRequestId } from "../src/desk/routes.js";

/**
 * the owner several times (24 Nov): "This card, I don't know exactly what it is to me and what I'm
 * supposed to reply to", and the card refused his voice answer ("text (string) is required"). The Ready to mark card
 * is one plain question naming the goal, what the team found, what Yes does; a long message id never refuses his words.
 */
const SENTENCE =
  "Buying on unusual market days (three z-score rules, two VIX rules) shows no alpha over lump sum: no rule beats it in more than half of the 10-year windows. Results: http://results.example.com/index.html ; shared on r/Bogleheads.";

describe("the Ready to mark card asks one plain question", () => {
  it("names the goal, says what the team found and what Yes does, and links the results", () => {
    const i = readyToMarkItem("ms_1", "every Done means is ticked and the evidence table is written", { name: "Market entry signals", sentence: SENTENCE, done: 7, total: 7 });
    expect(i.title).toBe("Is Market entry signals finished?");
    expect(i.detail).toBe("The team says it is: Buying on unusual market days shows no alpha over lump sum. All 7 checks are ticked. Yes closes it and its team stops. Not yet: say what is missing.");
    expect(i.url).toBe("http://results.example.com/index.html");
    // no jargon from the old card
    expect(`${i.title} ${i.detail}`).not.toMatch(/Done means|evidence table|Review and mark|[;()]/);
  });

  it("milestoneStatus passes the milestone's name and Outcome sentence to the card", () => {
    const s = milestoneStatus({
      milestone: { id: "m1", paused: false, title: "Market entry signals" },
      waiting: [],
      runs: [],
      assignments: [],
      doneMeans: { done: 7, total: 7 },
      outcome: { verdict: null, sentence: SENTENCE, evidence: [{ doneMeans: "E1-1", links: ["x"] }], risk: null, closedAt: null, closedBy: null },
    });
    expect(s.items).toEqual([expect.objectContaining({ kind: "ready_to_mark", title: "Is Market entry signals finished?", url: "http://results.example.com/index.html" })]);
  });

  it("plainFinding keeps one plain sentence", () => {
    expect(plainFinding("Done: see [page](http://x).")).toBe("Done: see page");
    expect(plainFinding(null)).toBeUndefined();
  });
});

describe("a card's words are never refused for a long message id", () => {
  it("a long id is shortened to a stable one under 120 characters", () => {
    const long = `feedback:card ready_to_mark:ms_b964026f-8161-45d6-bbad-90ca476e075d: Review and mark the outcome: every Done means is ticked and the evidence table is written:${Date.now()}`;
    const a = shortRequestId(long);
    expect(a.length).toBeLessThanOrEqual(120);
    expect(shortRequestId(long)).toBe(a);
    expect(shortRequestId(`${long}1`)).not.toBe(a);
    expect(shortRequestId("short")).toBe("short");
  });
  it("a refused message names the field that failed, never text for another field", () => {
    expect(sendInWhy([{ path: ["page"] }])).toMatch(/page hint is too long/);
    expect(sendInWhy([{ path: ["text"] }])).toMatch(/text \(string\) is required/);
  });
});
