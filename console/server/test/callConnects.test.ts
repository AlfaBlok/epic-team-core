import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { elevenCalls, READY_LINK_MS } from "../src/voice/elevenAgent.js";
import { createVoice, VOICE_TOOLS } from "../src/voice/voice.js";

/**
 * A call took 30 s or more to connect: the call page asks for the next call's link as it opens, so his tap
 * takes a link already made instead of waiting on the key and ElevenLabs. The key is still fetched for each link and
 * never kept; only the one-conversation link waits, once, for at most READY_LINK_MS.
 */
function fake() {
  let n = 0;
  const signed: string[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (u.pathname === "/v1/convai/agents") return ok({ agents: [{ agent_id: "agent_1", name: "EpicTeam Team desk call" }] });
    if (init.method === "PATCH" || /\/agents\/agent_1$/.test(u.pathname)) return ok({});
    if (u.pathname === "/v1/convai/conversation/get-signed-url") {
      const s = `wss://el/conv?sig=${++n}`;
      signed.push(s);
      return ok({ signed_url: s });
    }
    return new Response("{}", { status: 404 });
  });
  return { f: f as unknown as typeof fetch, signed };
}

describe("a call connects in a few seconds", () => {
  it("a link made when the page opened is taken by the next press, once; the key is read for it and not again", async () => {
    const e = fake();
    const key = vi.fn(async () => "k");
    const a = elevenCalls({ key, prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: e.f });
    await a.warm();
    expect(key).toHaveBeenCalledTimes(1);
    expect(a.isWarm()).toBe(true);
    const l = await a.link();
    expect(l.warm).toBe(true);
    expect(l.signedUrl).toBe(e.signed[0]);
    expect(key).toHaveBeenCalledTimes(1);
    // taken once: the next press makes its own link (a signed link is one conversation)
    const l2 = await a.link();
    expect(l2.warm).toBeUndefined();
    expect(l2.signedUrl).toBe(e.signed[1]);
    expect(key).toHaveBeenCalledTimes(2);
  });

  it("a press while the page's link is still coming waits for it: one key read, never two side by side", async () => {
    const e = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const key = vi.fn(async () => (await gate, "k"));
    const a = elevenCalls({ key, prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: e.f });
    void a.warm();
    const press = a.link();
    release();
    expect((await press).warm).toBe(true);
    expect(key).toHaveBeenCalledTimes(1);
  });

  it("a fresh link is kept, never a second one; an old one is dropped and the press makes its own", async () => {
    vi.useFakeTimers();
    try {
      const e = fake();
      const key = vi.fn(async () => "k");
      const a = elevenCalls({ key, prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: e.f });
      await a.warm();
      await a.warm();
      expect(e.signed).toHaveLength(1);
      vi.advanceTimersByTime(READY_LINK_MS + 1);
      expect(a.isWarm()).toBe(false);
      const l = await a.link();
      expect(l.warm).toBeUndefined();
      expect(l.signedUrl).toBe(e.signed[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a warm that fails leaves nothing: the press fetches as before", async () => {
    const e = fake();
    let fail = true;
    const key = vi.fn(async () => {
      if (fail) throw new Error("bitwarden slow");
      return "k";
    });
    const a = elevenCalls({ key, prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: e.f });
    await a.warm();
    expect(a.isWarm()).toBe(false);
    fail = false;
    expect((await a.link()).signedUrl).toBe(e.signed[0]);
  });

  it("the voice: warm makes the link when calls can start, and the start takes it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-connects-"));
    const db = openDb(path.join(dir, "console.db"));
    const e = fake();
    const key = vi.fn(async () => "k");
    const eleven = elevenCalls({ key, prompt: () => "p", firstMessage: () => "Hi", tools: () => VOICE_TOOLS as any, f: e.f });
    const v = createVoice({
      db,
      mint: async () => {
        throw new Error("never OpenAI");
      },
      eleven,
      quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
    });
    expect(v.warm()).toEqual({ warming: true });
    await vi.waitFor(() => expect(eleven.isWarm()).toBe(true));
    const s = await v.start();
    expect(s.signedUrl).toBe(e.signed[0]);
    expect(key).toHaveBeenCalledTimes(1);
    // a call is on: no link is made beside it
    expect(v.warm()).toEqual({ warming: false });
  });
});
