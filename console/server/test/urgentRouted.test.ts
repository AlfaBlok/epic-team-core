import { describe, expect, it } from "vitest";
import { parseCard } from "../src/review/card.js";
import { cutUrgentLead, readyOf } from "../src/review/ready.js";

/**
 * E948-S168 (the owner, 22 Nov 05:09Z, on the Adeje card: "If something is being marked urgent, why is it not actually labeled
 * urgent properly?"): its source said urgent but its deadline won, so it sat under Done as "It has a deadline", titled "Urgent.".
 */
const ev = { url: "http://example.com/adeje", label: "The Adeje map" };

describe("a card he called urgent goes in Urgent", () => {
  it("urgent in his words wins over a deadline", () => {
    const r = readyOf({ deadline: { at: "2026-11-22T00:00:00.000Z" }, words: [], source: 'Your Team desk note, 22 Nov: "flying to Tenerife in a few hours, so the items on that are urgent"', evidence: ev });
    expect(r?.why).toBe("urgent");
    expect(r?.whyText).toBe("You marked it urgent");
  });
  it("a card or row labelled urgent counts, a deadline alone stays a deadline", () => {
    expect(readyOf({ words: [], source: "The owner asked", labelled: true, evidence: ev })?.why).toBe("urgent");
    expect(readyOf({ deadline: { at: "2026-11-22T00:00:00.000Z" }, words: [], source: "Airbnb asked for a reply", evidence: ev })?.why).toBe("deadline");
  });
  it("the leading Urgent word is a label, cut from the title", () => {
    expect(cutUrgentLead("Urgent. A map of where to stay in Adeje was made.")).toEqual({ title: "A map of where to stay in Adeje was made.", urgent: true });
    expect(cutUrgentLead("URGENT: where to stay in Adeje")).toEqual({ title: "Where to stay in Adeje", urgent: true });
    expect(cutUrgentLead("**Urgent** — the hotel answered").urgent).toBe(true);
    expect(cutUrgentLead("Urgent.")).toEqual({ title: "Urgent.", urgent: true });
    expect(cutUrgentLead("Cards marked urgent land in Urgent")).toEqual({ title: "Cards marked urgent land in Urgent", urgent: false });
    expect(cutUrgentLead("Urgently needed keys were found.").urgent).toBe(false);
  });
  it("reads `label: urgent` and `urgent: yes` on a card", () => {
    const card = (line: string) => ["---", "row: E900-S1", "title: A map was made.", line, "---", ""].join("\n");
    expect(parseCard(card("label: urgent"))!.urgent).toBe(true);
    expect(parseCard(card("urgent: yes"))!.urgent).toBe(true);
    expect(parseCard(card("label: later"))!.urgent).toBeUndefined();
  });
});
