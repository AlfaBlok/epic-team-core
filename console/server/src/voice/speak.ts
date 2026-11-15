import type { Hono } from "hono";
import { z } from "zod";
import { sites } from "../identity.js";

/**
 * Play on a desk reply speaks it in the team's warm local
 * voice (Kokoro Heart, hosted/console/scripts/reply-voice.py on the worker server, free). The page sends one short piece at a time; this relays
 * it to the worker server over the tailnet and returns the wav. Down or slow: 503, and the page speaks with the browser's best voice.
 * Nothing is stored and the text is never logged. Any page of the console may ask (the desk's, a world's or a milestone's).
 *
 * `warm: true` speaks the piece on the worker server without sending the wav back (204): the page warms a new
 * reply's first pieces when it arrives, so Play finds them already spoken (the worker server keeps the last 128). The
 * answer carries `Server-Timing: voice;dur=<ms>;desc=hit|miss` so the wait is measurable from the page and the slow log.
 */
export const REPLY_VOICE_URL = (): string => sites().replyVoiceUrl;
const speakIn = z.object({ text: z.string().trim().min(1).max(600), speed: z.number().min(0.8).max(1.2).optional(), warm: z.boolean().optional() });

export function mountReplyVoice(api: Hono, o: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const url = (o.url ?? process.env.CONSOLE_REPLY_VOICE_URL ?? REPLY_VOICE_URL()).replace(/\/+$/, "");
  const get = o.fetch ?? fetch;
  const down = (why: string) => new Response(JSON.stringify({ error: { code: "reply_voice_down", message: `the reply voice is not reachable (${why}); the page uses the device's voice` } }), { status: 503, headers: { "content-type": "application/json" } });
  api.post("/voice/speak", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    const p = speakIn.safeParse(raw);
    if (!p.success) return c.json({ error: { code: "validation_error", message: "text (1 to 600 characters) is required" } }, 400);
    if (url === "off") return down("off on this console");
    const t0 = Date.now();
    try {
      const r = await get(`${url}/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: p.data.text, speed: p.data.speed ?? 0.95 }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
      if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("audio/")) return down(`answered ${r.status}`);
      const wav = await r.arrayBuffer();
      const cache = r.headers.get("x-voice-cache") === "hit" ? "hit" : "miss";
      const timing = `voice;dur=${Date.now() - t0};desc=${cache}`;
      if (p.data.warm) return new Response(null, { status: 204, headers: { "server-timing": timing } });
      return new Response(wav, { status: 200, headers: { "content-type": "audio/wav", "cache-control": "private, max-age=3600", "server-timing": timing } });
    } catch (e) {
      return down((e as Error).name === "TimeoutError" ? "too slow" : "no answer");
    }
  });
}
