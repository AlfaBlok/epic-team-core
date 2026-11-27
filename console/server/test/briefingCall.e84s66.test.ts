import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, elevenCalls } from "../src/voice/elevenAgent.js";
import { BRIEFING_AGENT_NAME, BRIEFING_TOOLS, briefingInstructions, briefingKnows, briefingNoteText, briefingSince, briefingWalkRule, changesOf, reviewCards, snapshotOf } from "../src/voice/briefing.js";
import type { ObjectiveCard } from "../src/voice/inbox.js";
import { createVoice } from "../src/voice/voice.js";

/**
 * The briefing call, now his objectives review (his note: "I'm just a manager reviewing a team trying
 * to make their goals"): his objectives in his order, those that moved or turned red since the last briefing first, each
 * one's red key results with numbers, what moved and what waits on him; his decisions filed on the objective.
 */

const NOW = Date.parse("2026-11-27T14:00:00Z");
const card = (id: string, name: string, krs: ObjectiveCard["keyResults"], light = "red"): ObjectiveCard => ({
  id,
  name,
  light,
  krs: `${krs.filter((k) => k.state === "green").length} of ${krs.length} key results green`,
  keyResults: krs,
  stands: "not moved today",
});
const HOUSE = card("house", "House: Buy a house", [
  { label: "Visits booked", state: "green", value: "3", target: "3" },
  { label: "Offers made", state: "red", value: "0", target: "1" },
]);
const TEAM = card("team", "EpicTeam: Get the team to understand me", [
  { label: "Cards he closes in one look", state: "red", value: "61%", target: "90%" },
  { label: "Notes acted on", state: "green", value: "100%", target: "100%" },
]);
const NOTES = card("notes", "Notes: Launch Notes", [{ label: "Testers", state: "red", value: "2", target: "5" }]);

describe("the objectives review call (the briefing call)", () => {
  it("its own agent walks objectives, files his decisions, relays and hangs up; it never presses a card", () => {
    const b = agentBody(briefingInstructions(), "Hi", BRIEFING_TOOLS as any, BRIEFING_AGENT_NAME, ["briefing-call"]);
    const names = b.conversation_config.agent.prompt.tools.map((t: any) => t.name);
    expect(b.name).toBe(BRIEFING_AGENT_NAME);
    expect(names).toEqual(expect.arrayContaining(["next_objective", "read_objective", "file_objective_words", "relay_to_desk", "end_call"]));
    expect(names).not.toContain("press_card");
    expect(briefingInstructions()).toMatch(/manager reviewing a team/);
    expect(briefingWalkRule(3)).toMatch(/exact number/);
  });

  it("starts where the last briefing began, a day back the first time, never more than a week", () => {
    expect(briefingSince(undefined, NOW)).toBe("2026-11-26T14:00:00.000Z");
    expect(briefingSince("2026-11-27T08:00:00Z", NOW)).toBe("2026-11-27T08:00:00.000Z");
    expect(briefingSince("2026-10-01T08:00:00Z", NOW)).toBe("2026-11-20T14:00:00.000Z");
  });

  it("the first review walks every objective in his order, red key results first, with what waits on him", () => {
    const r = reviewCards([HOUSE, TEAM, NOTES], { waits: (c) => (c.id === "notes" ? ["Question: Send the tester mail?"] : []) });
    expect(r.first).toBe(true);
    expect(r.changed).toBe(3);
    expect(r.cards.map((c) => c.id)).toEqual(["house", "team", "notes"]);
    expect(r.cards[0].keyResults[0].label).toBe("Offers made");
    expect(r.cards[2].stands).toContain("Waits on Sam here: Question: Send the tester mail?");
    expect(r.cards[0].stands).toContain("Nothing waits on Sam here");
  });

  it("a later briefing walks what moved or turned red since the last one first, and says what changed", () => {
    const last = snapshotOf([HOUSE, TEAM, NOTES], "2026-11-27T06:00:00.000Z");
    const notesNow = { ...NOTES, keyResults: [{ label: "Testers", state: "red", value: "3", target: "5" }] };
    const houseNow = { ...HOUSE, keyResults: [{ label: "Visits booked", state: "red", value: "2", target: "3" }, HOUSE.keyResults[1]] };
    expect(changesOf(notesNow, last.objectives.notes)).toEqual(["moved: Testers, 2 → 3"]);
    expect(changesOf(houseNow, last.objectives.house)).toEqual(["turned red: Visits booked (now 2)"]);
    const r = reviewCards([houseNow, TEAM, notesNow], { last, waits: () => [] });
    expect(r.first).toBe(false);
    expect(r.changed).toBe(2);
    expect(r.cards.map((c) => c.id)).toEqual(["house", "notes", "team"]);
    expect(r.cards[2].stands).toContain("Nothing changed since the last briefing");
    const k = briefingKnows({ since: last.at, now: NOW, cards: r.cards, changed: r.changed, first: false, shipped: [{ at: "2026-11-27T09:00:00Z", kind: "released", text: "Console abc is live" }], waiting: [] });
    expect(k).toMatch(/2 of 3 objectives moved or turned red since the last briefing/);
    expect(k).toContain("1. House: Buy a house: red");
    expect(k).toContain("Testers (now 3, target 5)");
    expect(k).toContain("Console abc is live");
  });

  it("a note lands on the Team desk as one request with his words, under the objective he was on", () => {
    const t = briefingNoteText("call_1", { words: "Push the second tester this week", note: "", objective: "Notes: Launch Notes" });
    expect(t).toMatch(/^📞 From the objectives review call \(call_1\) · objective: Notes: Launch Notes/);
    expect(t).toContain('"Push the second tester this week"');
    expect(t).toMatch(/one request/);
  });

  it("a review call starts on its own agent with the agenda and walks the objectives one by one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s66-"));
    const db = openDb(path.join(dir, "console.db"));
    const made: any[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.body) made.push(JSON.parse(String(init.body)));
      if (u.pathname === "/v1/convai/agents") return new Response(JSON.stringify({ agents: [] }));
      if (u.pathname === "/v1/convai/agents/create") return new Response(JSON.stringify({ agent_id: "agent_brief" }));
      return new Response(JSON.stringify({ signed_url: "wss://el/brief" }));
    }) as unknown as typeof fetch;
    const eleven = elevenCalls({ name: BRIEFING_AGENT_NAME, key: async () => "k", prompt: briefingInstructions, firstMessage: () => "Hi", tools: () => BRIEFING_TOOLS as any, f });
    const sent: string[] = [];
    const r = reviewCards([HOUSE, TEAM, NOTES], { waits: () => [] });
    const v = createVoice({
      db,
      mint: async () => {
        throw new Error("never OpenAI");
      },
      eleven,
      instructions: briefingInstructions,
      tools: () => BRIEFING_TOOLS as any,
      quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
      objectiveCards: () => r.cards,
      walkRule: briefingWalkRule,
      context: () => briefingKnows({ since: "2026-11-27T06:00:00.000Z", now: NOW, cards: r.cards, changed: r.changed, first: true, shipped: [], waiting: [] }),
      relay: async (id, a) => (sent.push(briefingNoteText(id, { words: String(a.words), note: "" })), { desk: "team", state: "sent" }),
    });
    const s = await v.start();
    expect(made[0].name).toBe(BRIEFING_AGENT_NAME);
    expect(s.instructions).toContain("walk all 3 objectives in his order");
    expect(s.instructions).toContain("The walk: 3 objectives");
    const one = v.tool(s.call.id, "next_objective");
    expect(one.objective).toContain("Objective 1 of 3 in Sam's order: House: Buy a house");
    expect(one.objective).toContain("Offers made (red): now 0, target 1");
    const two = v.tool(s.call.id, "next_objective");
    expect(two.objective).toContain("Cards he closes in one look (red): now 61%, target 90%");
    const filed = v.tool(s.call.id, "file_objective_words", { words: "Ask the team for the card score daily", confirmed: true });
    expect(filed.file).toMatchObject({ id: "team", words: "Ask the team for the card score daily" });
    expect(await v.relay(s.call.id, { desk: "team", words: "Plan the card score today" })).toMatchObject({ desk: "team", state: "sent" });
    expect(sent[0]).toContain('"Plan the card score today"');
  });
});
