import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, elevenCalls } from "../src/voice/elevenAgent.js";
import { marketingAgentName, MARKETING_TOOLS, marketingInstructions, marketingKnows, marketingNoteText, marketingRelayIn } from "../src/voice/marketing.js";
import { createVoice } from "../src/voice/voice.js";

/** The senior marketing call: the social product's strategy, his decisions to the social desk or the Team desk. */

const card = (name: string, extra: Record<string, unknown> = {}) => ({ name, light: "red", krs: "0 of 3 green", keyResults: [{ label: "Every channel posts its target", state: "red" }], ...extra }) as any;
const BRIEF = "# What the call knows\n## The number one blocker, our read\nNobody uses the app yet.\n## Channels\nvalue-first Reddit posts brought every tester.";

describe("the senior marketing call", () => {
  it("its own agent: relay and hang up only, it never presses or changes anything", () => {
    const b = agentBody(marketingInstructions(), "Hi", MARKETING_TOOLS as any, marketingAgentName(), ["marketing-call"]);
    const names = b.conversation_config.agent.prompt.tools.map((t: any) => t.name);
    expect(b.name).toBe(marketingAgentName());
    expect(names).toEqual(expect.arrayContaining(["relay_to_desk", "end_call"]));
    expect(names).not.toContain("press_card");
    expect(marketingInstructions()).toMatch(/number one blocker/);
    expect(marketingInstructions()).toMatch(/never say you did/);
  });

  it("knows the brief, only the social product's objectives, and the campaigns' plans", () => {
    const k = marketingKnows({ brief: BRIEF, objectives: [card("SocialApp: Get every channel working"), card("House: Buy a house")], campaigns: "# x\n1. Acme testers: get 5 testers" });
    expect(k).toContain("The number one blocker, our read");
    expect(k).toContain("SocialApp: Get every channel working");
    expect(k).not.toContain("Buy a house");
    expect(k).toContain("Acme testers: get 5 testers");
  });

  it("a note goes to the social desk or the Team desk, his words first", () => {
    expect(() => marketingRelayIn({ desk: "sales", words: "x" })).toThrow();
    expect(() => marketingRelayIn({ desk: "social", words: " " })).toThrow();
    const r = marketingRelayIn({ desk: "Social", words: "Open a waitlist for EpicTeam", campaign: "EpicTeam" });
    expect(r.desk).toBe("social");
    const t = marketingNoteText("call_1", { ...r, note: "" }, true);
    expect(t).toMatch(/^📞 From the senior marketing call \(call_1\) · EpicTeam/);
    expect(t).toContain('"Open a waitlist for EpicTeam"');
    expect(t).toMatch(/pass only his words there/);
  });

  it("a marketing call starts on its own agent with the brief, and a note reaches a desk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s53m-"));
    const db = openDb(path.join(dir, "console.db"));
    const made: any[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.body) made.push(JSON.parse(String(init.body)));
      if (u.pathname === "/v1/convai/agents") return new Response(JSON.stringify({ agents: [] }));
      if (u.pathname === "/v1/convai/agents/create") return new Response(JSON.stringify({ agent_id: "agent_mkt" }));
      return new Response(JSON.stringify({ signed_url: "wss://el/mkt" }));
    }) as unknown as typeof fetch;
    const eleven = elevenCalls({ name: marketingAgentName(), key: async () => "k", prompt: marketingInstructions, firstMessage: () => "Hi", tools: () => MARKETING_TOOLS as any, f });
    const sent: string[] = [];
    const v = createVoice({
      db,
      mint: async () => {
        throw new Error("never OpenAI");
      },
      eleven,
      instructions: marketingInstructions,
      tools: () => MARKETING_TOOLS as any,
      quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
      context: () => marketingKnows({ brief: BRIEF, objectives: [] }),
      walkRule: () => "",
      relay: async (id, a) => (sent.push(marketingNoteText(id, marketingRelayIn(a))), { desk: "team", state: "sent" }),
    });
    const s = await v.start();
    expect(made[0].name).toBe(marketingAgentName());
    expect(s.instructions).toContain("senior marketing person");
    expect(s.instructions).toContain("value-first Reddit posts");
    expect(await v.relay(s.call.id, { desk: "social", words: "Start the EpicTeam waitlist this week" })).toMatchObject({ state: "sent" });
    expect(sent[0]).toContain('"Start the EpicTeam waitlist this week"');
  });
});
