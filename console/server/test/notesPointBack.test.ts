import { describe, expect, it } from "vitest";
import { deskSeed, SEED_VERSION, updateMessage } from "../src/desk/desk.js";
import { POINTS_BACK_HEAD, pointsBackCues, pointsBackLine, voiceNoteMessage, voiceNoteMessages } from "../src/desk/voiceNotes.js";

// a note that points back ("the guy was suggesting flats", "testers") carries a line telling the desk to find the
// source first and ask one short line when unsure (root L-64, L-65). The Condesa note of 12 Nov 21:16Z is the case.
const CONDESA =
  "Another thing I want to say Is that... I am in Condesa, next to Chapultepec. Chapultepec, Bosque Chapultepec. But when the guy was suggesting floods and... Like, can you give me, like, specific addresses? Specific coordinates, because I want to go and check it out.";
const TESTERS = "Next time I get a message about a new tester application, tell me if it was a real one.";
const PLAIN = "Add a dark mode toggle to the console settings page.";

describe("notes that point back", () => {
  it("finds the back-reference phrases in the Condesa note and the tester note", () => {
    expect(pointsBackCues(CONDESA)).toEqual(["the guy", "was suggesting"]);
    expect(pointsBackCues(TESTERS)).toEqual(["tester"]);
    expect(pointsBackCues(PLAIN)).toEqual([]);
    expect(pointsBackCues("As I said yesterday, this penthouse is the one")).toEqual(["this penthouse", "as i said", "yesterday"]);
  });

  it("a plain note gets no line; a note that points back gets the find-the-source line", () => {
    expect(pointsBackLine(PLAIN)).toBe("");
    const line = pointsBackLine(CONDESA);
    expect(line.startsWith(POINTS_BACK_HEAD)).toBe(true);
    expect(line).toContain('"the guy", "was suggesting"');
    expect(line).toContain("scripts/find_source.py --note-file");
    expect(line).toContain("ask him one open question he answers by voice note, file nothing");
  });

  it("the WhatsApp note relayed to the desk carries the line under its header, before the memory reference", () => {
    const e = { content: CONDESA, capturedAt: "2026-11-12T21:16:00Z", githubUrl: "https://example.test/n" };
    const [msg] = voiceNoteMessages("Log/2026-11-12.md#^e-ded023", e);
    const lines = msg.split("\n");
    expect(lines[0]).toMatch(/^🎙 Voice note/);
    expect(lines[1].startsWith(POINTS_BACK_HEAD)).toBe(true);
    expect(lines[2]).toContain("Log/2026-11-12.md#^e-ded023");
    expect(voiceNoteMessage("r", e).split("\n")[1].startsWith(POINTS_BACK_HEAD)).toBe(true);
    expect(voiceNoteMessages("r", { content: PLAIN, capturedAt: "2026-11-12T21:16:00Z" })[0]).not.toContain(POINTS_BACK_HEAD);
  });

  it("the desk seed and its update carry the rule, and the seed version moved so the live desk gets it", () => {
    const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c.test", reposRoot: "/r" });
    expect(seed).toContain("Notes that point back (root L-64");
    expect(seed).toContain("file nothing until he answers");
    expect(seed).toContain("testers =");
    expect(seed).toContain("credits we get");
    expect(updateMessage("https://c.test")).toContain("credits we give");
    expect(updateMessage("https://c.test")).toContain("find_source.py");
    expect(SEED_VERSION).toBeGreaterThanOrEqual(35);
  });
});
