import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountReplyVoice } from "../src/voice/speak.js";

// Play on a desk reply asks POST /api/voice/speak for one piece; the console relays it to the team's local voice
// on the worker server (Kokoro Heart, free) and returns the wav. Down, slow or off: 503, so the page speaks with the device's best voice.

function setup(o: Parameters<typeof mountReplyVoice>[1]) {
  const api = new Hono();
  mountReplyVoice(api, o);
  const app = new Hono();
  app.route("/api", api);
  const speak = (body: unknown) => app.request("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { speak };
}

describe("T42-S40 the reply voice relay", () => {
  it("relays one piece to the voice and returns its wav, at a gentle speed", async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } }));
    const { speak } = setup({ url: "http://voice:1/", fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await speak({ text: "All good, the deploy is live." });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(fetch.mock.calls[0][0]).toBe("http://voice:1/speak");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ text: "All good, the deploy is live.", speed: 0.95 });
  });
  it("refuses empty or long pieces", async () => {
    const { speak } = setup({ url: "http://voice:1", fetch: vi.fn() as unknown as typeof globalThis.fetch });
    expect((await speak({ text: "" })).status).toBe(400);
    expect((await speak({ text: "x".repeat(601) })).status).toBe(400);
    expect((await speak({})).status).toBe(400);
  });
  it("down, slow, wrong answer or off: 503 reply_voice_down, so the page falls back to the device's voice", async () => {
    const down = setup({ url: "http://voice:1", fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch });
    const r = await down.speak({ text: "Hello." });
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("reply_voice_down");
    const html = setup({ url: "http://voice:1", fetch: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof globalThis.fetch });
    expect((await html.speak({ text: "Hello." })).status).toBe(503);
    const slow = setup({ url: "http://voice:1", timeoutMs: 20, fetch: ((_u: unknown, i?: RequestInit) => new Promise((_, rej) => i?.signal?.addEventListener("abort", () => rej(i.signal!.reason)))) as typeof globalThis.fetch });
    const s = await slow.speak({ text: "Hello." });
    expect(s.status).toBe(503);
    expect((await s.json()).error.message).toMatch(/too slow/);
    const off = setup({ url: "off", fetch: vi.fn() as unknown as typeof globalThis.fetch });
    expect((await off.speak({ text: "Hello." })).status).toBe(503);
  });
});
