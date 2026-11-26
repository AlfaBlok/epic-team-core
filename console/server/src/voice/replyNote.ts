import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { ELEVEN_VOICE_ID } from "./elevenAgent.js";

/**
 * A voice note back (the owner's note 25 Nov 11:55Z: "I drop this long voice
 * note and then could I be getting a voice note back? ... as I'm walking ... I can also listen ... this should be not super
 * extensive"). The desk's answer to his voice note comes back as text and as a short voice note: the answer's first part
 * (its punchline, about a minute at most), spoken by ElevenLabs in the narration voice on the grant.
 *
 *   his voice note ──▶ desk answers in text ──▶ Chat asks POST /api/voice/reply-note {text}
 *                                                 │ short part, ElevenLabs (Jessica, flash v2.5), kept on disk by its hash
 *                                                 ▼
 *                                 GET /api/voice/reply-notes/<hash>.mp3 ──▶ a voice note under the answer
 *
 * Each text is spoken once (the file is kept); a day's spoken characters stop at DAY_CHARS so the grant is never run down.
 */

/** about a minute of speech: the answer's lead, cut at a sentence end. */
export const NOTE_CHARS = 900;
/** ElevenLabs characters a day across every voice reply (flash v2.5 costs half a credit a character). */
export const DAY_CHARS = 60_000;
export const NOTE_MODEL = "eleven_flash_v2_5";
const REST = "The rest is in the chat.";

/** the words of a reply worth saying: no code, links, tables or markdown marks. */
export function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    // a table is read on the screen, never aloud
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>|~]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** the short voice note's words: whole sentences of the answer's lead up to NOTE_CHARS, then "The rest is in the chat." */
export function shortNote(text: string, max = NOTE_CHARS, rest = REST): string {
  const all = spoken(text).replace(/\s*\n+\s*/g, " ").trim();
  if (all.length <= max) return all;
  const sentences = all.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [all];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > max) break;
    out += s;
  }
  if (!out) out = `${all.slice(0, all.lastIndexOf(" ", max)).trim()}.`;
  return rest ? `${out.trim()} ${rest}` : out.trim();
}

export function mountReplyNote(api: Hono, o: { key: () => Promise<string | undefined>; dir: string; fetch?: typeof fetch; now?: () => number }) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const usageFile = path.join(o.dir, "usage.json");
  const used = (): { day: string; chars: number; notes: number } => {
    try {
      const u = JSON.parse(fs.readFileSync(usageFile, "utf8"));
      if (u.day === day()) return u;
    } catch {
      /* none yet */
    }
    return { day: day(), chars: 0, notes: 0 };
  };
  const err = (code: string, message: string, status: number) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
  const fileOf = (hash: string) => path.join(o.dir, `${hash}.mp3`);
  const urlOf = (hash: string) => `/api/voice/reply-notes/${hash}.mp3`;
  const listenOf = (hash: string) => `/listen/${hash}`;

  api.post("/voice/reply-note", async (c) => {
    // a daily briefing asks too, with its own title and its own closing words ("" for none).
    const p = z
      .object({ text: z.string().trim().min(1).max(40_000), title: z.string().trim().max(120).optional(), rest: z.string().max(120).optional() })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: { code: "validation_error", message: "text (the desk's answer) is required" } }, 400);
    const words = shortNote(p.data.text, NOTE_CHARS, p.data.rest ?? REST);
    const title = p.data.title || "A voice note from the team";
    if (!/\w/.test(words)) return c.json({ error: { code: "nothing_to_say", message: "the answer has no words to speak" } }, 422);
    const hash = crypto.createHash("sha256").update(`${ELEVEN_VOICE_ID}|${NOTE_MODEL}|${words}`).digest("hex").slice(0, 24);
    if (fs.existsSync(fileOf(hash))) return c.json({ url: urlOf(hash), listen: listenOf(hash), chars: words.length, words, kept: true });
    const u = used();
    if (u.chars + words.length > DAY_CHARS) return err("day_cap", `today's voice replies reached ${DAY_CHARS} characters; the answer is in the text, and Play still reads it`, 429);
    const key = await o.key();
    if (!key) return err("no_key", "the console has no ELEVENLABS_API_KEY", 503);
    let r: Response;
    try {
      r = await f(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: words, model_id: NOTE_MODEL }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return err("elevenlabs_down", `ElevenLabs did not answer (${(e as Error).message.slice(0, 100)})`, 502);
    }
    if (!r.ok) return err("elevenlabs_refused", `ElevenLabs refused the voice reply (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`, 502);
    const mp3 = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(o.dir, { recursive: true });
    fs.writeFileSync(fileOf(hash), mp3);
    fs.writeFileSync(path.join(o.dir, `${hash}.json`), JSON.stringify({ title, words, at: new Date(now()).toISOString() }));
    fs.writeFileSync(usageFile, JSON.stringify({ day: u.day, chars: u.chars + words.length, notes: u.notes + 1 }));
    return c.json({ url: urlOf(hash), listen: listenOf(hash), chars: words.length, words, kept: false }, 201);
  });

  api.get("/voice/reply-notes/:file", (c) => {
    const m = /^([0-9a-f]{24})\.mp3$/.exec(c.req.param("file") ?? "");
    if (!m || !fs.existsSync(fileOf(m[1]))) return err("not_found", "no such voice reply", 404);
    return new Response(fs.readFileSync(fileOf(m[1])), { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" } });
  });

  api.get("/voice/reply-notes", (c) => c.json({ ...used(), dayCap: DAY_CHARS, voice: ELEVEN_VOICE_ID, model: NOTE_MODEL }));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

/**
 * The owner, 25 Nov 11:55Z: "he sends a text and says if you want to listen click this link". The link a WhatsApp
 * caption ends with: GET /listen/<id>, one quiet page with the player and the words, behind the console's login (a
 * path outside /api, so a phone with no session goes to the login page and comes back here).
 */
export function mountListenPage(app: Hono, dir: string) {
  app.get("/listen/:id", (c) => {
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f]{24}$/.test(id) || !fs.existsSync(path.join(dir, `${id}.mp3`))) return c.text("No such voice note.", 404);
    let meta: { title?: string; words?: string; at?: string } = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    } catch {
      /* an older note: the player alone */
    }
    const title = meta.title || "A voice note from the team";
    const when = meta.at ? new Date(meta.at).toUTCString().replace(/:\d\d GMT$/, " UTC") : "";
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>
:root{--paper:#f6f3ec;--ink:#1d1b17;--soft:#6b665c;--line:#ddd6c8;--green:#1f5c43}
@media (prefers-color-scheme:dark){:root{--paper:#171613;--ink:#ece8df;--soft:#a39d90;--line:#34312b;--green:#6fb894}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:620px;margin:0 auto;padding:40px 16px 64px}
h1{font:600 26px/1.25 Georgia,"Times New Roman",serif;margin:0 0 4px}.when{color:var(--soft);font-size:14px;margin:0 0 24px}
.player{margin:0;border:1px solid var(--line);border-radius:10px;padding:16px}.player figcaption{margin:0 0 10px;color:var(--green);font-weight:600}
audio{width:100%}.words{margin-top:28px;color:var(--ink);white-space:pre-wrap}.words h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);margin:0 0 8px}
</style></head><body><main>
<h1>${esc(title)}</h1><p class="when">${esc(when)}</p>
<figure class="player" id="listen"><figcaption>Press play to listen</figcaption><audio controls preload="metadata" src="/api/voice/reply-notes/${id}.mp3"></audio></figure>
${meta.words ? `<section class="words"><h2>What it says</h2>${esc(meta.words)}</section>` : ""}
</main></body></html>`);
  });
}
