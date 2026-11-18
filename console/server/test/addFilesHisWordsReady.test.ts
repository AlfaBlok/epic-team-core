import { describe, expect, it } from "vitest";
import { hisWordsIn, saidIn } from "../src/desk/said.js";

/**
 * A row the desk files from his own words is his ask, filed READY. The 17 Nov case: his voice note (18:36Z) asked for
 * the wheel settled by three model runs; he wrote again before the desk filed it at 18:39Z, so the Add's old check (his
 * NEWEST message only) filed the row as a draft: "chat is not in Sam's newest desk message".
 */
const voiceNote = {
  at: "2026-11-17T18:36:05Z",
  text:
    "🎙 Voice note (Chat), 2026-11-17 18:36Z · vn_925a659f\n\nHey, can we dedicate one model to look into this and also maybe three runs of another? " +
    "You are still not getting what a wheel is.",
};
const later = { at: "2026-11-17T18:38:40Z", text: "and the atlas of files for each vertical, I've asked you this at least five times" };
const quote = "can we dedicate one model to look into this and also maybe three runs of another";
const at1839 = Date.parse("2026-11-17T18:39:19Z");

describe("the desk's Add takes his words from any of his recent messages", () => {
  it("the 17 Nov case: the old newest-message rule missed it", () => {
    expect(saidIn(later.text, quote)).toBe(false); // what the Add used to check, so the row went in as a draft
  });

  it("the 17 Nov case is now his ask: the voice note holding the quote is found", () => {
    const r = hisWordsIn([voiceNote, later], quote, at1839);
    expect(r).toEqual({ text: voiceNote.text, at: voiceNote.at });
  });

  it("a long note filed over more than 15 minutes still counts", () => {
    expect(typeof hisWordsIn([voiceNote], quote, at1839 + 3 * 3_600_000)).toBe("object");
  });

  it("words he never said, words older than a day and a quote too short stay a draft", () => {
    expect(hisWordsIn([voiceNote, later], "file this as ready for me please", at1839)).toMatch(/not in any of his desk messages/);
    expect(hisWordsIn([voiceNote], quote, at1839 + 25 * 3_600_000)).toMatch(/written nothing/);
    expect(hisWordsIn([voiceNote], "can", at1839)).toMatch(/at least/);
  });
});
