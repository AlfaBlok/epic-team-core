import { describe, expect, it } from "vitest";
import { OBJECTIVES_HEAD, objectivesBlock, objectivesOneLine, objectivesRule } from "../src/objectives.js";
import { workerBriefRules, wakeProtocol } from "../src/cycle/prompts.js";

/** his objectives are the one list every wake and every worker rereads, "which objective" first. */
const body = {
  nodes: [
    { id: "b", kind: "pursuit", name: "B", rank: 2, headline: "Five teams use Widget", greens: 0, total: 3, keyResults: [{ state: "red" }, { state: "green" }], idle: { idle: false, reason: "waits on Sam's review: E907-S3" } },
    { id: "a", kind: "pursuit", name: "A", rank: 1, headline: "Five teams use Acme every week", greens: 3, total: 6, keyResults: [{ state: "green" }, { state: "amber" }, { state: "green" }] },
    { id: "p", kind: "pursuit", name: "Parked one", rank: null, parked: true, greens: 0, total: 1 },
    { id: "a~x", kind: "epic", name: "An epic", greens: 1, total: 2 },
  ],
  progress: { sets: { a: { today: 1, week: 2 }, b: { today: 0, week: 0 } } },
};
const words = {
  objectives: [
    { id: "a", after: { words: "the number one priority right now is getting teams for Acme", said: "2026-11-14T01:58Z" } },
    { id: "house", name: "The second", world: { repo: "home_two" }, after: { words: "the second thing in my life" } },
  ],
} as never;

describe("his objectives first", () => {
  it("lists his objectives in his order with lights, today's movement and his words; parked and epics left out", () => {
    const b = objectivesBlock(body, words, [
      { name: "Acme's first team", objective: "a" },
      { name: "Second line", target: "2026-11-30" },
    ]);
    expect(b.startsWith(OBJECTIVES_HEAD)).toBe(true);
    const lines = b.split("\n");
    const one = lines.findIndex((l) => l.startsWith("1. "));
    expect(lines[one]).toContain("Five teams use Acme every week");
    expect(lines[one]).toContain("2 of 3 key results green");
    expect(lines[one]).toContain("moved today: 1 turned green");
    expect(lines[one]).toContain('his words 11-14: "the number one priority');
    expect(lines[one + 1]).toMatch(/^2\. 🔴 Five teams use Widget .* not moved today \(waits on Sam's review: E907-S3\)/);
    expect(b).not.toContain("Parked one");
    expect(b).not.toContain("An epic");
    expect(b).toContain("Also his: The second (its own world home_two: notes only)");
    expect(b).toContain("Red lines (docs/pursuits.json): Acme's first team (inside objective 1) · Second line by 2026-11-30 (no objective of its own yet)");
    expect(b).toContain("`Objective: <its name>: how this step moves it`");
  });

  it("no objectives read: no block", () => {
    expect(objectivesBlock(undefined)).toBe("");
    expect(objectivesBlock({ nodes: [] })).toBe("");
  });

  it("the first worker rule carries the live list in one line", () => {
    const line = objectivesOneLine(body, words);
    expect(line).toBe("1. Five teams use Acme every week (2 of 3 key results green; moved today: 1 turned green) ; 2. Five teams use Widget (1 of 2 key results green; not moved today)");
    const rules = workerBriefRules(line);
    expect(rules).toHaveLength(11);
    expect(rules[0]).toBe(objectivesRule(line));
    expect(rules[0]).toContain('"which objective does this move?"');
    expect(rules[0]).toContain(`His objectives now: ${line}.`);
    expect(workerBriefRules()[0]).toContain("GET /api/objectives");
  });

  it("the wake's dispatch step prints the rules with the live list in every brief", () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "Delivery Manager" },
      objectivesLine: "1. Acme (2 of 3)",
    } as never);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain("these eleven rules");
    expect(brief).toContain("His objectives now: 1. Acme (2 of 3).");
  });
});
