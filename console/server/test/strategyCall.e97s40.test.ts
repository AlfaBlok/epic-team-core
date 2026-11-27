import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, elevenCalls } from "../src/voice/elevenAgent.js";
import { marketingAgentName, marketingRelayIn } from "../src/voice/marketing.js";
import { strategyAgentName, STRATEGY_TOOLS, strategyInstructions, strategyKnows, strategyNoteText, teamProduct } from "../src/voice/teamStrategy.js";
import { createVoice } from "../src/voice/voice.js";

/** The team product's strategy call: its launch strategy, his decisions to the Team desk or the social desk. */

const card = (name: string) => ({ name, light: "red", krs: "0 of 4 green", keyResults: [{ label: "A stranger signs up and pays", state: "red" }] }) as any;
const BRIEF = "# What the strategy call knows\n## The number one blocker\nA stranger cannot sign up and pay yet.\n## Questions\nWho buys first: a solo builder or a team of three?";

describe("the team product's strategy call", () => {
  it("its own agent, apart from the marketing call: relay and hang up only", () => {
    expect(strategyAgentName()).not.toBe(marketingAgentName());
    const b = agentBody(strategyInstructions(), "Hi", STRATEGY_TOOLS as any, strategyAgentName(), ["strategy-call"]);
    const names = b.conversation_config.agent.prompt.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["relay_to_desk", "end_call"]));
    expect(names).not.toContain("press_card");
    expect(strategyInstructions()).toMatch(/Settled is settled: a question he has already answered .* is never asked again/);
    expect(strategyInstructions()).toMatch(/never say you did/);
  });

  it("knows the brief and only the team product's objectives", () => {
    const k = strategyKnows({ brief: BRIEF, objectives: [card(`${teamProduct()}: Get multi-tenant working`), card("House: Buy a house")] });
    expect(k).toContain("A stranger cannot sign up and pay yet.");
    expect(k).toContain(`${teamProduct()}: Get multi-tenant working`);
    expect(k).not.toContain("Buy a house");
    expect(strategyKnows({ objectives: [] })).toMatch(/could not be read/);
  });

  it("a note is his words first, under the strategy call's head", () => {
    const t = strategyNoteText("call_2", { ...marketingRelayIn({ desk: "team", words: "Solo builders first" }), note: "who buys first" });
    expect(t).toMatch(/^📞 From the strategy call \(call_2\)/);
    expect(t).toContain('"Solo builders first"');
    expect(t).toContain("Strategy note: who buys first");
  });

  it("a strategy call starts on its own agent with the brief, and a note reaches the desk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e97s40-"));
    const db = openDb(path.join(dir, "console.db"));
    const made: any[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.body) made.push(JSON.parse(String(init.body)));
      if (u.pathname === "/v1/convai/agents") return new Response(JSON.stringify({ agents: [] }));
      if (u.pathname === "/v1/convai/agents/create") return new Response(JSON.stringify({ agent_id: "agent_str" }));
      return new Response(JSON.stringify({ signed_url: "wss://el/str" }));
    }) as unknown as typeof fetch;
    const eleven = elevenCalls({ name: strategyAgentName(), key: async () => "k", prompt: strategyInstructions, firstMessage: () => "Hi", tools: () => STRATEGY_TOOLS as any, f });
    const sent: string[] = [];
    const v = createVoice({
      db,
      mint: async () => {
        throw new Error("never OpenAI");
      },
      eleven,
      instructions: strategyInstructions,
      tools: () => STRATEGY_TOOLS as any,
      quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
      context: () => strategyKnows({ brief: BRIEF, objectives: [] }),
      walkRule: () => "",
      relay: async (id, a) => (sent.push(strategyNoteText(id, marketingRelayIn(a))), { desk: "team", state: "sent" }),
    });
    const s = await v.start();
    expect(made[0].name).toBe(strategyAgentName());
    expect(s.instructions).toContain("senior strategist");
    expect(s.instructions).toContain("a solo builder or a team of three");
    expect(await v.relay(s.call.id, { desk: "team", words: "Open the waitlist now" })).toMatchObject({ state: "sent" });
    expect(sent[0]).toContain('"Open the waitlist now"');
  });
});
