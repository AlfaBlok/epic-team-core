import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, elevenCalls } from "../src/voice/elevenAgent.js";
import { BRIEFING_AGENT_NAME, BRIEFING_TOOLS, briefingInstructions, briefingKnows, briefingNoteText, briefingSince } from "../src/voice/briefing.js";
import { createVoice } from "../src/voice/voice.js";

/** The briefing call: the desk's news since his last briefing, then his notes, each one request on the Team desk. */

const NOW = Date.parse("2026-11-25T14:00:00Z");

describe("the briefing call", () => {
  it("its own agent: relay and hang up only, it never presses or changes anything", () => {
    const b = agentBody(briefingInstructions(), "Hi", BRIEFING_TOOLS as any, BRIEFING_AGENT_NAME, ["briefing-call"]);
    const names = b.conversation_config.agent.prompt.tools.map((t: any) => t.name);
    expect(b.name).toBe(BRIEFING_AGENT_NAME);
    expect(names).toEqual(expect.arrayContaining(["relay_to_desk", "end_call"]));
    expect(names).not.toContain("press_card");
    expect(briefingInstructions()).toMatch(/do not help him decide/);
  });

  it("starts where the last briefing began, a day back the first time, never more than a week", () => {
    expect(briefingSince(undefined, NOW)).toBe("2026-11-24T14:00:00.000Z");
    expect(briefingSince("2026-11-25T08:00:00Z", NOW)).toBe("2026-11-25T08:00:00.000Z");
    expect(briefingSince("2026-10-01T08:00:00Z", NOW)).toBe("2026-11-18T14:00:00.000Z");
  });

  it("knows what shipped in the window, newest first, and what waits on him", () => {
    const k = briefingKnows({
      since: "2026-11-25T08:00:00.000Z",
      now: NOW,
      shipped: [
        { at: "2026-11-25T09:00:00Z", kind: "delivered", text: "Coach call is live", product: "EpicTeam" },
        { at: "2026-11-25T12:00:00Z", kind: "released", text: "Console 516ff52 is live", product: "EpicTeam" },
        { at: "2026-11-25T07:00:00Z", kind: "delivered", text: "Too old" },
        { at: "2026-11-25T10:00:00Z", kind: "learning", text: "Not shipped" },
      ],
      waiting: [
        { kind: "review", id: "r1", title: "Four voice products" },
        { kind: "ask", id: "a1", title: "Switch Epic Help on" },
      ],
    });
    expect(k).toMatch(/last 6 hours/);
    expect(k).toMatch(/What shipped \(2\)/);
    expect(k.indexOf("Console 516ff52")).toBeLessThan(k.indexOf("Coach call"));
    expect(k).not.toContain("Too old");
    expect(k).not.toContain("Not shipped");
    expect(k).toMatch(/1 cards to review, 1 questions/);
    expect(k).toContain("Card: Four voice products");
    expect(k).toContain("Question: Switch Epic Help on");
  });

  it("a note lands on the Team desk as one request with his words", () => {
    const t = briefingNoteText("call_1", { words: "Ship the coach to Spanish too", note: "about the coach" });
    expect(t).toMatch(/^📞 From the briefing call \(call_1\)/);
    expect(t).toContain('"Ship the coach to Spanish too"');
    expect(t).toMatch(/one request/);
  });

  it("a briefing call starts on its own agent with the news, and a note reaches the desk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s53b-"));
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
    const v = createVoice({
      db,
      mint: async () => {
        throw new Error("never OpenAI");
      },
      eleven,
      instructions: briefingInstructions,
      tools: () => BRIEFING_TOOLS as any,
      quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
      context: () => briefingKnows({ since: "2026-11-25T08:00:00.000Z", now: NOW, shipped: [{ at: "2026-11-25T12:00:00Z", kind: "released", text: "Console 516ff52 is live" }], waiting: [] }),
      walkRule: () => "",
      relay: async (id, a) => (sent.push(briefingNoteText(id, { words: String(a.words), note: "" })), { desk: "team", state: "sent" }),
    });
    const s = await v.start();
    expect(made[0].name).toBe(BRIEFING_AGENT_NAME);
    expect(s.instructions).toContain("briefing guy");
    expect(s.instructions).toContain("Console 516ff52 is live");
    expect(await v.relay(s.call.id, { desk: "team", words: "Plan the Spanish coach today" })).toMatchObject({ desk: "team", state: "sent" });
    expect(sent[0]).toContain('"Plan the Spanish coach today"');
  });
});
