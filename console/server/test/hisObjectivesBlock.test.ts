import { describe, expect, it } from "vitest";
import { names, objectivesContext, CONTEXT_MAX_CHARS, splitObjectivesContext, touches } from "../src/desk/hisObjectives.js";
import { splitSince } from "../src/desk/since.js";

// the desk reads his objectives, not the details: every live objective, no hand-kept count.
const NOW = Date.parse("2026-11-14T05:00:00Z");
const node = (id: string, rank: number, extra: object = {}) => ({ id, kind: "pursuit", name: id, rank, headline: `Objective ${id}`, greens: 0, total: 1, keyResults: [{ label: `KR of ${id}`, state: "red", value: "0" }], ...extra });

describe("his objectives block", () => {
  it("names a pursuit when every term of one group is in the text (his transcripts: Zenot, Epic Social)", () => {
    const e = { id: "z", match: [["zeno[dt]"], ["epic\\s?social", "tester"]] };
    expect(touches(e, "how is Zenot doing")).toBe(true);
    expect(touches(e, "Epic Social testers this week")).toBe(true);
    expect(touches(e, "Epic Social posts")).toBe(false);
    expect(touches({ id: "x", match: [["(bad"]] }, "(bad")).toBe(false); // a broken term never throws
  });
  it("a message that only names a pursuit's subject still raises it, after the fully named ones (replay 03:16Z: Epic Social posts)", () => {
    const social = { id: "s", match: [["epic\\s?social", "tester"]] };
    expect(names(social, "Epic Social posts")).toBe(true);
    expect(names(social, "the house")).toBe(false);
    const input = { nodes: [node("z", 1), node("s", 2), node("c", 3)] };
    const f = { refreshedAt: "2026-11-14T04:00Z", objectives: [{ id: "z", match: [["zeno[dt]"]] }, social, { id: "c", match: [["epic\\s?social|social team", "tik\\s?tok"]] }] };
    const b = objectivesContext(f, input, NOW, "how much did we post on Zenot and on Epic Social");
    expect(b).toContain("names the first 3");
    expect(b.indexOf("1. 🔴 Objective z")).toBeLessThan(b.indexOf("2. 🔴 Objective s"));
    expect(objectivesContext(f, input, NOW, "Epic Social on TikTok").indexOf("3. 🔴 Objective c")).toBeLessThan(objectivesContext(f, input, NOW, "Epic Social on TikTok").indexOf("2. 🔴 Objective s"));
  });
  it("follows the objectives: parked out, a new one in, his order kept; quiet words say so", () => {
    const input = { nodes: [node("a", 1), node("b", 2), node("p", 0, { rank: null, parked: true }), node("c", 3)] };
    const f = { refreshedAt: "2026-11-14T04:00Z", objectives: [{ id: "a", match: [["alpha"]], after: { words: "old words on alpha", said: "2026-11-01T10:00Z" } }] };
    const b = objectivesContext(f, input, NOW, "alpha please");
    expect(b).toContain("His 3 objectives");
    expect(b).not.toContain("Objective p");
    expect(b).toMatch(/\n1\. 🔴 Objective a .* quiet: his last words 11-01: "old words on alpha"/);
    expect(b.indexOf("2. 🔴 Objective b")).toBeLessThan(b.indexOf("3. 🔴 Objective c"));
    expect(b).toContain("next: KR of b (0)");
    expect(objectivesContext(f, input, NOW, "nothing named")).not.toContain("old words");
  });
  it("stays short even with long lines, and strips off his words cleanly (with a since block too)", () => {
    const long = "x ".repeat(600);
    const input = { nodes: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => node(`p${i}`, i, { headline: long })) };
    const f = { refreshedAt: "2026-11-14T04:00Z", objectives: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `p${i}`, match: [["x"]], after: { words: long } })) };
    const b = objectivesContext(f, input, NOW, "x");
    expect(b.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS + 50);
    const msg = `${b}\n[since your last message]\nSince x\n[/since]\nhello`;
    expect(splitObjectivesContext(msg).text.startsWith("[since your last message]")).toBe(true);
    expect(splitSince(msg).text).toBe("hello");
    expect(objectivesContext(undefined, undefined)).toBe("");
  });
});

describe("no invented name", () => {
  it("the block never says plot, and a message sent before still loses its old block", async () => {
    const { objectivesContext, splitObjectivesContext } = await import("../src/desk/hisObjectives.js");
    const b = objectivesContext({ refreshedAt: "2026-11-14T04:00Z", objectives: [{ id: "a", match: [["alpha"]] }] }, { nodes: [{ id: "a", kind: "pursuit", name: "a", rank: 1, headline: "Objective a", greens: 0, total: 1, keyResults: [] }] } as never, Date.parse("2026-11-14T05:00:00Z"), "alpha");
    expect(b).not.toMatch(/plot/i);
    expect(splitObjectivesContext("[plot]\nold\n[/plot]\nhis words").text).toBe("his words");
  });
  it("the chat drops the old opening label from the desk's earlier replies", async () => {
    const { dropLabelLine } = await import("../src/desk/session.js");
    expect(dropLabelLine("Plot: Acme testers, nothing changes.\n\nDone: the row is filed.")).toBe("Done: the row is filed.");
    expect(dropLabelLine("Done: the plot of land by the lake.")).toBe("Done: the plot of land by the lake.");
  });
});

// his newest word wins at wake, at the desk and in every worker brief; older words marked, never mixed in.
import { chatSection, inForceWords, newestWordsSection, replacesMarker, NEWEST_HEAD } from "../src/desk/hisObjectives.js";
import { objectivesBlock } from "../src/objectives.js";
import { workerMessage } from "../src/cycle/workerLaunch.js";

describe("his newest word wins", () => {
  const house = {
    id: "buy-house",
    name: "House: Buy a house",
    match: [["house"]],
    aim: { words: "a house in Tenerife south", said: "2026-11-10T00:00Z" },
    after: { words: "buying a house is the number one objective", said: "2026-11-22T20:20Z", via: "voice note" },
    earlier: [
      { words: "the house search is on the Canary Islands", said: "2026-11-18T10:00Z", state: "replaced" as const, by: "2026-11-22T20:20Z" },
      { words: "he kicked me out of the house", said: "2026-11-22T16:39Z", state: "stands" as const },
    ],
  };
  it("an older aim never beats his newer words, and the words in force say what they replace", () => {
    expect(inForceWords(house)?.words).toBe("buying a house is the number one objective");
    expect(replacesMarker(house)).toContain('replaces 11-10 "a house in Tenerife south"');
    expect(inForceWords({ ...house, aim: { words: "new aim", said: "2026-11-23T00:00Z" } })?.words).toBe("new aim");
  });
  it("the wake's objectives block shows the newest word in force with what it replaces", () => {
    const b = objectivesBlock({ nodes: [{ id: "buy-house", kind: "pursuit", name: "House: Buy a house", rank: 1, greens: 0, total: 2 }] } as never, { objectives: [house] });
    expect(b).toContain("His newest word wins");
    expect(b).toContain('in force (replaces his word of 11-10): "buying a house is the number one objective"');
    expect(b).not.toMatch(/his words[^\n]*Tenerife south"[^\n]*in force/);
  });
  it("a block too long for its budget still shows his words in force and what they replace on every line", () => {
    const long = "x".repeat(400);
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: i ? `o${i}` : "buy-house", kind: "pursuit", name: i ? `Acme: Goal ${i} ${long}` : "House: Buy a house", rank: i + 1, greens: 0, total: 2 }));
    const b = objectivesBlock({ nodes } as never, { objectives: [house] });
    const line = b.split("\n").find((l) => l.startsWith("1. "))!;
    expect(line).toContain("in force (replaces his word of 11-10)");
  });
  it("a worker brief naming the objective opens with his newest words, older ones marked", () => {
    const s = newestWordsSection({ objectives: [house] }, "Row E907-S3: the house objective's key results");
    expect(s.startsWith(`## ${NEWEST_HEAD}`)).toBe(true);
    expect(s.indexOf("in force 2026-11-22T20:20")).toBeLessThan(s.indexOf("replaced by his words of 2026-11-22"));
    expect(s).toContain('stands: 2026-11-22T16:39 "he kicked me out of the house"');
    const m = workerMessage({ base: "http://x", runId: "r", parentRunId: "p", ticket: "E907-S3", brief: "Do the house key results.", newest: s });
    expect(m.indexOf(NEWEST_HEAD)).toBeLessThan(m.indexOf("Do the house key results."));
    expect(newestWordsSection({ objectives: [house] }, "nothing about it")).toBe("");
  });
  it("a campaign wake under no objective gets his words as the Chat tab, read before it plans", () => {
    const s = chatSection({ objectives: [house] }, "House: Buy a house", "home-repo");
    expect(s.startsWith(`## His words, the Chat tab (read before you plan): ${NEWEST_HEAD}`)).toBe(true);
    expect(s).toContain("buying a house is the number one objective");
    expect(s).toContain("scripts/card_notes.py words <row>");
    expect(chatSection({ objectives: [house] }, "nothing about it", "home-repo")).toBe("");
  });
});

import { wakeStub } from "../src/cycle/prompts.js";
describe("the wake message itself carries where we are and his newest word", () => {
  it("puts the first lines before the fetch, so a persona that never reads the fetched prompt still has them", () => {
    const s = wakeStub("http://x", "as_1", { clientRequestId: "run_1", first: "Read first (House: Buy a house):\n- Where we are now: two viewings booked" });
    expect(s.indexOf("Where we are now: two viewings booked")).toBeLessThan(s.indexOf("/api/assignments/as_1/wake"));
    expect(wakeStub("http://x", "as_1", { first: "  " })).not.toContain("Read first");
  });
});
