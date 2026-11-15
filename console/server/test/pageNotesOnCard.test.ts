import { describe, expect, it } from "vitest";
import { pageNotesFor, pageNotesOf } from "../src/review/pageNotes.js";
import { applyStep } from "../src/steps/steps.js";

// a note he leaves in a page's own feedback box shows on that item's inbox card.

const SPINE = (rows: string) => `# EPIC-907: x\n\n## Decisions\n| Date | Outcome | Decision | Summary | Evidence | Revisit |\n|---|---|---|---|---|---|\n${rows}`;
const OLD =
  '| 2026-11-12 | accepted | Step note: Your feedback on this page on How the engine works: feedback on the deck [step-note sp_ddeae0c7/feedback]; his words: "It kind of reloaded the entire page when I press the microphone." | the owner wrote a note on the steps page (E87): the desk was told and the owner woken | http://host1.example.com:9319/ | the step changes |';

describe("a page note on its row's card", () => {
  it("the steps kit files the time and the row with the note", () => {
    const t = { page: { id: "sp_ddeae0c7", title: "Deck", url: "http://host1.example.com:9319/" }, step: "feedback", title: "Your feedback", row: "E907-S3" };
    const r = applyStep(SPINE(""), t, "todo", "good for now", "2026-11-12", "2026-11-12T23:49:08.520Z");
    if ("skip" in r) throw new Error(r.skip);
    expect(r.text).toContain('[step-note sp_ddeae0c7/feedback] at 23:49Z, for E907-S3; his words: "good for now"');
    const [n] = pageNotesOf(r.text);
    expect(n).toMatchObject({ date: "2026-11-12", time: "23:49", words: "good for now", url: "http://host1.example.com:9319/", step: "Your feedback", refs: ["E907-S3"] });
  });

  it("a note naming its row goes on that row only; an older note with no row goes on the row whose evidence opens its page", () => {
    const named = OLD.replace("[step-note sp_ddeae0c7/feedback]", "[step-note sp_ddeae0c7/feedback] at 23:49Z, for E907-S4");
    const notes = pageNotesOf(SPINE(`${OLD}\n${named}`));
    expect(notes).toHaveLength(2);
    // the old one (no row named): matched by page, any trailing slash or #part
    expect(pageNotesFor(notes, "E907-S3", ["http://host1.example.com:9319"]).map((n) => n.time)).toEqual([undefined]);
    expect(pageNotesFor(notes, "E907-S4", []).map((n) => n.time)).toEqual(["23:49"]);
    expect(pageNotesFor(notes, "E907-S5", ["http://host1.example.com:9400/"])).toEqual([]);
  });

  it("a Stuck with words counts; a step row without words, or another page's mark, never does", () => {
    const rows = [
      '| 2026-11-12 | accepted | Step stuck: Key [step-stuck sp_11111111/k] at 10:00Z, for E907-S6; his words: "no key there" | x | http://h:1/ | y |',
      "| 2026-11-12 | accepted | Step done: Key [step-done sp_11111111/k] | x | http://h:1/ | y |",
      '| 2026-11-12 | accepted | Something else; his words: "hi" | x | http://h:1/ | y |',
    ].join("\n");
    const notes = pageNotesOf(SPINE(rows));
    expect(notes).toEqual([expect.objectContaining({ stuck: true, words: "no key there", refs: ["E907-S6"] })]);
  });

  it("at most the newest three", () => {
    const rows = [1, 2, 3, 4].map((i) => OLD.replace("It kind of", `n${i}`)).join("\n");
    expect(pageNotesFor(pageNotesOf(SPINE(rows)), "E907-S3", ["http://host1.example.com:9319/"]).map((n) => n.words.slice(0, 2))).toEqual(["n2", "n3", "n4"]);
  });
});
