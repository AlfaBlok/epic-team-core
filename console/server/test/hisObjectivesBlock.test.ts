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
