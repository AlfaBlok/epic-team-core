import { describe, expect, it } from "vitest";
import { parseCard, parseDeadline } from "../src/review/card.js";

/** (vn_c95c40ad): a card's `deadline:` is read from the card file, never guessed. */
const card = (line: string) => ["---", "row: E900-S1", "title: A reply was drafted.", line, "---", ""].join("\n");

describe("card deadline", () => {
  it("reads an ISO time with its why", () => {
    expect(parseCard(card('deadline: 2026-11-17T01:47Z — Your words 16 Nov: "We have a 22-hour deadline."'))!.deadline).toEqual({
      at: "2026-11-17T01:47:00.000Z",
      why: 'Your words 16 Nov: "We have a 22-hour deadline."',
    });
  });
  it("reads a zone, seconds, a date alone and the other key names", () => {
    expect(parseDeadline("2026-11-15T00:36:22-06:00")).toEqual({ at: "2026-11-15T06:36:22.000Z" });
    expect(parseDeadline("2026-11-18 06:36 UTC -- Airbnb asked for a reply in 72 hours")).toEqual({ at: "2026-11-18T06:36:00.000Z", why: "Airbnb asked for a reply in 72 hours" });
    expect(parseDeadline("2026-11-20")).toEqual({ at: "2026-11-20T00:00:00.000Z" });
    expect(parseCard(card("due by: 2026-11-20T10:00Z"))!.deadline?.at).toBe("2026-11-20T10:00:00.000Z");
  });
  it("drops what is not a clear time: no deadline is guessed", () => {
    expect(parseCard(card("deadline: soon"))!.deadline).toBeUndefined();
    expect(parseCard(card("deadline: in 72 hours"))!.deadline).toBeUndefined();
    expect(parseCard(card("deadline: 2026-13-40T99:99Z"))!.deadline).toBeUndefined();
    expect(parseCard(card(""))!.deadline).toBeUndefined();
  });
});
