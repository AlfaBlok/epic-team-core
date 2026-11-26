import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, elevenCalls } from "../src/voice/elevenAgent.js";
import { COACH_AGENT_NAME, COACH_TOOLS, coachInstructions, coachKnows, relayIn, teamRelayText } from "../src/voice/coach.js";
import { DAY_CHARS, mountListenPage, mountReplyNote, shortNote } from "../src/voice/replyNote.js";
import { createVoice } from "../src/voice/voice.js";

/**
 * A voice note back for his voice notes, and an
 * objectives coach call that reads his objectives only and relays his words to the Team desk or the social desk.
 */

const card = (name: string) => ({ id: name.toLowerCase(), name, light: "red", krs: "0 of 2 key results green", keyResults: [{ label: "Five testers", state: "red" }, { label: "Listed", state: "green" }], stands: "not moved today" });

describe("the objectives coach", () => {
  it("its own agent: read and relay tools, never a write to an objective", () => {
    const b = agentBody(coachInstructions(), "Hi", COACH_TOOLS as any, COACH_AGENT_NAME, ["objectives-coach"]);
    const names = b.conversation_config.agent.prompt.tools.map((t: any) => t.name);
    expect(b.name).toBe(COACH_AGENT_NAME);
    expect(names).toEqual(expect.arrayContaining(["read_objective", "next_objective", "relay_to_desk", "end_call"]));
    expect(names).not.toContain("file_objective_words");
    expect(names).not.toContain("press_card");
    expect(coachInstructions()).toMatch(/cannot change an objective/);
  });

  it("knows every objective in his order, the red key results named", () => {
    const k = coachKnows([card("Notes: Get 5 testers"), card("Home: Find a flat")]);
    expect(k).toMatch(/1\. Notes: Get 5 testers: red/);
    expect(k).toMatch(/Not green: Five testers/);
    expect(k).not.toMatch(/Not green:[^.]*Listed/);
  });

  it("relay: team or social only, his words required, the Team desk told no objective changes without his yes", () => {
    expect(() => relayIn({ desk: "x", words: "a" })).toThrow();
    expect(() => relayIn({ desk: "team", words: " " })).toThrow();
    const r = relayIn({ desk: "team", words: "Notes launch is the objective,  testers a key result", note: "make testers a KR", objective: "Notes" });
    const t = teamRelayText("call_1", r);
    expect(t).toMatch(/^📞 From the objectives coach call \(call_1\)/);
    expect(t).toContain('"Notes launch is the objective, testers a key result"');
    expect(t).toMatch(/without his yes/);
  });

  it("a coach call starts on its own agent, and relay_to_desk reaches the relay with his words", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s53c-"));
    const db = openDb(path.join(dir, "console.db"));
    const made: any[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.body) made.push(JSON.parse(String(init.body)));
      if (u.pathname === "/v1/convai/agents") return new Response(JSON.stringify({ agents: [] }));
      if (u.pathname === "/v1/convai/agents/create") return new Response(JSON.stringify({ agent_id: "agent_coach" }));
      return new Response(JSON.stringify({ signed_url: "wss://el/coach" }));
    }) as unknown as typeof fetch;
    const eleven = elevenCalls({ name: COACH_AGENT_NAME, key: async () => "k", prompt: coachInstructions, firstMessage: () => "Hi", tools: () => COACH_TOOLS as any, f });
    const relays: any[] = [];
    const v = createVoice({
      db,
      mint: async () => {
        throw new Error("never OpenAI");
      },
      eleven,
      instructions: coachInstructions,
      tools: () => COACH_TOOLS as any,
      quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
      objectiveCards: () => [card("Notes: Get 5 testers")],
      context: () => coachKnows([card("Notes: Get 5 testers")]),
      walkRule: () => "",
      relay: async (id, a) => (relays.push({ id, ...relayIn(a) }), { desk: relayIn(a).desk, state: "sent" }),
    });
    const s = await v.start();
    expect(made[0].name).toBe(COACH_AGENT_NAME);
    expect(s.instructions).toContain("objectives coach");
    expect(s.instructions).toContain("Notes: Get 5 testers");
    expect(s.instructions).not.toContain("file_objective_words");
    expect(v.tool(s.call.id, "read_objective", { number: 1 })).toMatchObject({ place: "objective 1 of 1" });
    expect(await v.relay(s.call.id, { desk: "social", words: "post less, reply more" })).toMatchObject({ desk: "social" });
    expect(relays[0]).toMatchObject({ id: s.call.id, desk: "social", words: "post less, reply more" });
  });
});

describe("a voice note back", () => {
  it("the answer's lead, whole sentences, about a minute at most", () => {
    expect(shortNote("Yes, calls are **back on**. See [the page](https://x.y).")).toBe("Yes, calls are back on. See the page.");
    expect(shortNote("Calls are on.\n\n| a | b |\n|---|---|\n| x | y |")).toBe("Calls are on.");
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const s = shortNote(long);
    expect(s.length).toBeLessThan(960);
    expect(s).toMatch(/is here\. The rest is in the chat\.$/);
  });

  it("spoken once by ElevenLabs, kept, served as mp3; the day cap holds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s53r-"));
    const f = vi.fn(async () => new Response(Buffer.from("ID3fake"), { status: 200, headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const api = new Hono();
    mountReplyNote(api, { key: async () => "k", dir, fetch: f });
    const post = (text: string) => api.request("/voice/reply-note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const a = await post("Calls are back on.");
    expect(a.status).toBe(201);
    const j = (await a.json()) as { url: string };
    expect((await post("Calls are back on.")).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    const got = await api.request(j.url.replace("/api", ""));
    expect(got.headers.get("content-type")).toBe("audio/mpeg");
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), chars: DAY_CHARS, notes: 1 }));
    expect((await post("Something new to say.")).status).toBe(429);
  });
  it("a briefing's spoken version, its own title, no closing words, a listen page with player and words", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e105s311-"));
    const f = vi.fn(async () => new Response(Buffer.from("ID3fake"), { status: 200 })) as unknown as typeof fetch;
    const api = new Hono();
    const app = new Hono();
    mountReplyNote(api, { key: async () => "k", dir, fetch: f });
    mountListenPage(app, dir);
    const long = "Do the wheels turn? Yes. ".repeat(60);
    const r = await api.request("/voice/reply-note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: long, title: "Your morning briefing", rest: "" }) });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { listen: string; words: string };
    expect(j.words).not.toContain("The rest is in the chat.");
    expect(j.words.length).toBeLessThanOrEqual(900);
    expect(j.listen).toMatch(/^\/listen\/[0-9a-f]{24}\/[0-9a-z]+\/[A-Za-z0-9_-]{32}$/);
    const page = await app.request(j.listen);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Your morning briefing");
    expect(html).toContain(`${j.listen}/audio.mp3`);
    expect(html).toContain("Do the wheels turn?");
    expect((await app.request("/listen/0123456789abcdef01234567")).status).toBe(404);
    expect((await app.request("/listen/..%2F..%2Fetc")).status).toBe(404);
  });
});
