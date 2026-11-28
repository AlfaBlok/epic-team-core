import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { agentBody, ELEVEN_AGENT_NAME, ELEVEN_VOICE_ID, ELEVEN_VOICE_ID_ES, elevenCalls, spanishAgentName } from "../src/voice/elevenAgent.js";
import { spanishGreeting, spanishInstructions } from "../src/voice/spanish.js";
import { createVoice, OPENING_LINE, VOICE_TOOLS } from "../src/voice/voice.js";
import { MARKETING_GREETING } from "../src/voice/marketing.js";
import { objectiveGreeting } from "../src/voice/levelCall.js";

/**
 * He picks Español on a call screen and the call answers in a native Spain-Spanish voice, never the English
 * voice reading Spanish (his words on call_f5516a60, 26 Nov). Spanish runs on its own agent (language es, the Spanish
 * voice, a v2.5 model), greets him in Spanish and its prompt opens in Spanish; English calls stay as they were.
 */

function fakeEleven() {
  const calls: { method: string; url: string; body?: any }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", url, body });
    const u = new URL(url);
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (u.pathname === "/v1/convai/agents") return ok({ agents: [] });
    if (u.pathname === "/v1/convai/agents/create") return ok({ agent_id: body.conversation_config.agent.language === "es" ? "agent_es" : "agent_en" });
    if (u.pathname === "/v1/convai/conversation/get-signed-url") return ok({ signed_url: `wss://el/conv?agent_id=${u.searchParams.get("agent_id")}` });
    return new Response("{}", { status: 404 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("calls in Spanish with a Spanish voice", () => {
  it("the Spanish agent speaks Spanish with the Spain-Spanish voice; the English one is unchanged", () => {
    const es = agentBody("p", "Hola", VOICE_TOOLS as any, spanishAgentName(ELEVEN_AGENT_NAME), undefined, "es");
    expect(es.conversation_config.agent.language).toBe("es");
    expect(es.conversation_config.tts.voice_id).toBe(ELEVEN_VOICE_ID_ES);
    expect(es.conversation_config.tts.model_id).toBe("eleven_flash_v2_5");
    // the owner heard "a TV actress in a film": the Spanish voice speaks steadier than the 0.5 default
    expect((es.conversation_config.tts as { stability?: number }).stability).toBe(0.8);
    expect(ELEVEN_VOICE_ID_ES).not.toBe(ELEVEN_VOICE_ID);
    const en = agentBody("p", "Hi", VOICE_TOOLS as any);
    expect(en.conversation_config.agent.language).toBe("en");
    expect(en.conversation_config.tts).toEqual({ voice_id: ELEVEN_VOICE_ID, model_id: "eleven_flash_v2" });
  });

  it("each call's greeting has its Spanish one", () => {
    expect(spanishGreeting(MARKETING_GREETING())).toMatch(/^Hola .+, aquí tu briefer de .+\. ¿Quieres primero los números/);
    expect(spanishGreeting(OPENING_LINE)).toMatch(/^Hola .+, soy la línea del equipo\. ¿En qué te ayudo\?$/);
    expect(spanishGreeting(objectiveGreeting("SocialApp: Launch SocialApp"))).toMatch(/^Hola .+, aquí el responsable de Launch SocialApp\. ¿Qué hay de nuevo desde la última vez\?$/);
    expect(spanishGreeting("anything else")).toMatch(/^Hola .+, ¿por dónde empezamos\?$/);
    const i = spanishInstructions(`Say "${OPENING_LINE}" once.`, OPENING_LINE, "Hola");
    expect(i.startsWith("# Idioma de esta llamada: español de España")).toBe(true);
    expect(i).toContain('Say "Hola" once.');
  });

  it("a call started in Spanish takes the Spanish agent's link, a Spanish greeting and the Spanish lead; English stays English", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e84s64-"));
    const db = openDb(path.join(dir, "console.db"));
    const el = fakeEleven();
    const eleven = elevenCalls({ key: async () => "k", prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: el.f });
    const v = createVoice({ db, mint: vi.fn() as any, eleven, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }) });
    const s = await v.start(undefined, "es");
    expect(s.signedUrl).toContain("agent_es");
    expect(s.greeting).toMatch(/^Hola /);
    expect(s.instructions?.startsWith("# Idioma de esta llamada")).toBe(true);
    const made = el.calls.find((c) => c.url.endsWith("/agents/create"))!;
    expect(made.body.name).toBe(spanishAgentName(ELEVEN_AGENT_NAME));
    await v.end(s.call.id, { reason: "hangup" });
    const e = await v.start();
    expect(e.signedUrl).toContain("agent_en");
    expect(e.greeting).toBe(OPENING_LINE);
    expect(e.instructions?.startsWith("# Idioma")).toBe(false);
  });

  it("the page-open link is kept per language: a Spanish press takes the Spanish one", async () => {
    const el = fakeEleven();
    const a = elevenCalls({ key: async () => "k", prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: el.f });
    await a.warm("es");
    expect(a.isWarm("es")).toBe(true);
    expect(a.isWarm("en")).toBe(false);
    const l = await a.link("es");
    expect(l.warm).toBe(true);
    expect(l.agentId).toBe("agent_es");
  });
});
