import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
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
  // the briefing's link opens with no sign-in: signed, this one note only, LISTEN_DAYS days
  const listenOf = (hash: string) => signedListen(o.dir, hash, now());

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
    if (fs.existsSync(fileOf(hash))) {
      // the newest sender's title wins: a real briefing with a test's words never keeps the test's "TEST ·" title
      keepTitle(path.join(o.dir, `${hash}.json`), title, words, now());
      return c.json({ url: urlOf(hash), listen: listenOf(hash), chars: words.length, words, kept: true });
    }
    const u = used();
    if (u.chars + words.length > DAY_CHARS) return err("day_cap", `today's voice replies reached ${DAY_CHARS} characters; the answer is in the text, and Play still reads it`, 429);
    let key: string | undefined;
    try {
      key = await o.key();
    } catch (e) {
      // Bitwarden slow to give the key (key_wait): the sender tries again, never told the key is missing
      const x = e as { code?: string; message?: string; status?: number };
      return err(x.code ?? "key_failed", x.message ?? String(e), x.status ?? 503);
    }
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
    // The owner, 26 Nov ("link broken"): an iPhone plays audio only from a server that answers byte ranges (206);
    // a whole-file 200 left the Listen page's player dead on his phone.
    return audioAnswer(fs.readFileSync(fileOf(m[1])), c.req.header("range"));
  });

  api.get("/voice/reply-notes", (c) => c.json({ ...used(), dayCap: DAY_CHARS, voice: ELEVEN_VOICE_ID, model: NOTE_MODEL }));
}

/** An mp3 answer that honours one byte range (`bytes=a-b`, `a-`, `-n`): 206 with Content-Range, 416 outside the file. */
export function audioAnswer(mp3: Buffer, range: string | undefined): Response {
  const base = { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400", "accept-ranges": "bytes" };
  const size = mp3.length;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (!m[1] && !m[2])) return new Response(new Uint8Array(mp3), { headers: { ...base, "content-length": String(size) } });
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  return new Response(new Uint8Array(mp3.subarray(start, end + 1)), {
    status: 206,
    headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

/** how long a briefing's open Listen link plays: a few days, then it answers "expired". */
export const LISTEN_DAYS = 5;
const ID = /^[0-9a-f]{24}$/;

/** the console's own signing key for Listen links: made once, kept beside the notes (never leaves the server). */
function listenKey(dir: string): Buffer {
  const f = path.join(dir, ".listen-key");
  try {
    const k = fs.readFileSync(f);
    if (k.length >= 32) return k;
  } catch {
    /* none yet */
  }
  fs.mkdirSync(dir, { recursive: true });
  const k = crypto.randomBytes(32);
  try {
    fs.writeFileSync(f, k, { mode: 0o600, flag: "wx" });
    return k;
  } catch {
    return fs.readFileSync(f); // another request made it first
  }
}

const signOf = (dir: string, id: string, exp: string) => crypto.createHmac("sha256", listenKey(dir)).update(`listen|${id}|${exp}`).digest("base64url").slice(0, 32);

/** `/listen/<id>/<expiry>/<signature>`: opens that one note's page and sound with no sign-in until it expires. */
export function signedListen(dir: string, id: string, at: number, days = LISTEN_DAYS): string {
  const exp = Math.floor(at / 1000 + days * 86_400).toString(36);
  return `/listen/${id}/${exp}/${signOf(dir, id, exp)}`;
}

/** why a signed Listen link does not open (undefined: it opens). */
export function listenRefusal(dir: string, id: string, exp: string, sig: string, at: number): "bad" | "expired" | undefined {
  if (!ID.test(id) || !/^[0-9a-z]{1,10}$/.test(exp) || !/^[A-Za-z0-9_-]{32}$/.test(sig)) return "bad";
  const want = Buffer.from(signOf(dir, id, exp));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return "bad";
  return parseInt(exp, 36) * 1000 < at ? "expired" : undefined;
}

function keepTitle(file: string, title: string, words: string, at: number) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    if (m.title === title) return;
    fs.writeFileSync(file, JSON.stringify({ ...m, title }));
  } catch {
    fs.writeFileSync(file, JSON.stringify({ title, words, at: new Date(at).toISOString() }));
  }
}

/**
 * The owner, 25 Nov 11:55Z: "he sends a text and says if you want to listen click this link". The link a WhatsApp
 * caption ends with: GET /listen/<id>, one quiet page with the player and the words, behind the console's login (a
 * path outside /api, so a phone with no session goes to the login page and comes back here).
 */
export function mountListenPage(app: Hono, dir: string, now: () => number = Date.now) {
  const has = (id: string) => ID.test(id) && fs.existsSync(path.join(dir, `${id}.mp3`));
  // behind the login: the owner's own link
  app.get("/listen/:id", (c) => {
    const id = c.req.param("id") ?? "";
    if (!has(id)) return c.text("No such voice note.", 404);
    return c.html(listenPage(dir, id, `/api/voice/reply-notes/${id}.mp3`));
  });
  // the link in a WhatsApp caption: WhatsApp opens it in its own browser, signed in nowhere (his "link broken", 26 Nov),
  // so the signature in the path is the credential: this one note's page and sound, nothing else, for LISTEN_DAYS days.
  const open = (c: Context, audio: boolean) => {
    const { id = "", exp = "", sig = "" } = c.req.param() as Record<string, string>;
    const no = listenRefusal(dir, id, exp, sig, now());
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex");
    if (no === "expired") return c.html(gone("This voice note's link has expired. The words are still in your briefing."), 410);
    if (no || !has(id)) return c.html(gone("No such voice note."), 404);
    if (audio) return audioAnswer(fs.readFileSync(path.join(dir, `${id}.mp3`)), c.req.header("range"));
    c.header("cache-control", "private, no-store");
    return c.html(listenPage(dir, id, `/listen/${id}/${exp}/${sig}/audio.mp3`));
  };
  app.get("/listen/:id/:exp/:sig", (c) => open(c, false));
  app.get("/listen/:id/:exp/:sig/audio.mp3", (c) => open(c, true));
}

const STYLE = `:root{--paper:#f6f3ec;--ink:#1d1b17;--soft:#6b665c;--line:#ddd6c8;--green:#1f5c43}
@media (prefers-color-scheme:dark){:root{--paper:#171613;--ink:#ece8df;--soft:#a39d90;--line:#34312b;--green:#6fb894}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:620px;margin:0 auto;padding:40px 16px 64px}
h1{font:600 26px/1.25 Georgia,"Times New Roman",serif;margin:0 0 4px}.when{color:var(--soft);font-size:14px;margin:0 0 24px}
.player{margin:0;border:1px solid var(--line);border-radius:10px;padding:16px}.player figcaption{margin:0 0 10px;color:var(--green);font-weight:600}
audio{width:100%}.file{display:inline-block;margin-top:10px;color:var(--soft);font-size:14px}.words{margin-top:28px;color:var(--ink);white-space:pre-wrap}.words h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);margin:0 0 8px}`;

const head = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<style>
${STYLE}
</style></head><body><main>`;

const gone = (msg: string) => `${head("Voice note")}<h1>${esc(msg)}</h1></main></body></html>`;

/** one quiet page: the title, when, the player and the words. */
function listenPage(dir: string, id: string, src: string): string {
  let meta: { title?: string; words?: string; at?: string } = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  } catch {
    /* an older note: the player alone */
  }
  const title = meta.title || "A voice note from the team";
  const when = meta.at ? new Date(meta.at).toUTCString().replace(/:\d\d GMT$/, " UTC") : "";
  return `${head(title)}
<h1>${esc(title)}</h1><p class="when">${esc(when)}</p>
<figure class="player" id="listen"><figcaption>Press play to listen</figcaption><audio controls preload="metadata" src="${src}"></audio><a class="file" href="${src}">Open the sound file</a></figure>
${meta.words ? `<section class="words"><h2>What it says</h2>${esc(meta.words)}</section>` : ""}
</main></body></html>`;
}
