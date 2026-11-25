import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, ELEVEN_AGENT_NAME, ELEVEN_MODEL_LABEL, elevenCalls, withoutTools } from "../src/voice/elevenAgent.js";
import { createVoice, VOICE_TOOLS } from "../src/voice/voice.js";

/**
 * The owner asked for voice calls back on through ElevenLabs: with the ElevenLabs door, a call starts on ElevenLabs
 * Agents (a signed link, the console's instructions and greeting, no OpenAI key minted), on its own switch that the
 * 22 Nov switch-off of OpenAI's paid calls does not hold; the agent is found by name, made once, and kept in step.
 */

function fakeEleven(agents: { agent_id: string; name: string }[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", url, body });
    const u = new URL(url);
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (u.pathname === "/v1/convai/agents") return ok({ agents });
    if (u.pathname === "/v1/convai/agents/create") return ok({ agent_id: "agent_new" });
    if (init.method === "PATCH") return ok({});
    if (u.pathname === "/v1/convai/conversation/get-signed-url") return ok({ signed_url: `wss://el/conv?agent_id=${u.searchParams.get("agent_id")}&sig=1` });
    return new Response("{}", { status: 404 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("calls through ElevenLabs Agents", () => {
  it("the agent: every desk tool as a client tool, end_call for hang_up, prompt and first line overridable per call", () => {
    const b = agentBody("prompt", "Hi", VOICE_TOOLS as any);
    const names = b.conversation_config.agent.prompt.tools.map((t: any) => t.name);
    expect(names).toContain("quick_status");
    expect(names).toContain("ask_the_desk");
    expect(names).toContain("end_call");
    expect(names).not.toContain("hang_up");
    expect(b.platform_settings.overrides.conversation_config_override.agent).toEqual({ prompt: { prompt: true }, first_message: true, language: true });
    expect((withoutTools(b).conversation_config.agent.prompt as any).tools).toBeUndefined();
  });

  it("made once when the account has none; found by name and updated (tools left alone) when it has", async () => {
    const none = fakeEleven();
    const kept: string[] = [];
    const a = elevenCalls({ key: async () => "k", prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: none.f, known: { get: () => kept.at(-1), set: (id) => void kept.push(id) } });
    expect((await a.link()).signedUrl).toContain("agent_id=agent_new");
    expect(none.calls.filter((c) => c.url.endsWith("/agents/create"))).toHaveLength(1);
    await a.link();
    expect(none.calls.filter((c) => c.url.endsWith("/agents/create"))).toHaveLength(1);
    expect(kept).toEqual(["agent_new"]);

    const some = fakeEleven([{ agent_id: "agent_old", name: ELEVEN_AGENT_NAME }]);
    const b = elevenCalls({ key: async () => "k", prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: some.f });
    expect((await b.link()).agentId).toBe("agent_old");
    const patch = some.calls.find((c) => c.method === "PATCH");
    expect(patch?.body.conversation_config.agent.prompt.tools).toBeUndefined();
    expect(some.calls.some((c) => c.url.endsWith("/agents/create"))).toBe(false);
  });

  it("a call starts on ElevenLabs with the console's instructions, no OpenAI key, and the 22 Nov switch-off does not hold it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s53-"));
    const db = openDb(path.join(dir, "console.db"));
    const mint = vi.fn(async () => ({ value: "ek", expires_at: 0 }));
    const el = fakeEleven();
    const eleven = elevenCalls({ key: async () => "k", prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: el.f });
    const v = createVoice({ db, mint, eleven, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), callsDefault: "off" });
    db.prepare("INSERT INTO voice_settings (key, value) VALUES ('calls', 'off')").run();
    expect(v.state().provider).toBe("elevenlabs");
    expect(v.state().available).toBe(true);
    const s = await v.start();
    expect(mint).not.toHaveBeenCalled();
    expect(s.provider).toBe("elevenlabs");
    expect(s.signedUrl).toContain("agent_new");
    expect(s.instructions).toContain("voice line");
    expect(s.greeting).toBeTruthy();
    expect(s.call.model).toBe(ELEVEN_MODEL_LABEL);
    await v.end(s.call.id, { reason: "hangup" });
    // his switch for these calls is their own
    v.setCalls(false);
    expect(v.state().callsOff).toBe(true);
    expect((db.prepare("SELECT value FROM voice_settings WHERE key = 'calls:elevenlabs'").get() as any).value).toBe("off");
    // without the door, calls stay OpenAI's and the old switch holds them off
    const old = createVoice({ db, mint, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), callsDefault: "off" });
    expect(old.state().provider).toBe("openai");
    expect(old.state().callsOff).toBe(true);
  });
});
