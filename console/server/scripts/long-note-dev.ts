/**
 * A long synthetic voice note through a DEV copy of the console's note routes, never production (the 2026-11-12
 * 19:50Z incident put test notes into the owner's memory). A throwaway console on 127.0.0.1 with its own temp database: no desk
 * (the "posted" note is written to a TEST file), no memory forward (nothing reaches memory), a fake transcriber (TEST words,
 * no OpenAI spend). It makes a real 2-hour recording with ffmpeg, cuts it the way the page does (two-minute opus parts at
 * 32 kbit/s), uploads every part over HTTP, makes one part fail to transcribe, sends, then tries a part past the cap.
 *
 *   npx tsx scripts/long-note-dev.ts <out dir> [minutes=120]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, mountVoiceNotesRec, NOTE_SEGMENT_S, type Transcriber } from "../src/voice/notes.js";

const out = path.resolve(process.argv[2] ?? "long-note-dev");
const minutes = Number(process.argv[3] ?? 120);
const FAIL_PART = 17;
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e42s65-dev-"));
const log = (s: string) => {
  console.log(s);
  fs.appendFileSync(path.join(out, "run.log"), s + "\n");
};
fs.writeFileSync(path.join(out, "run.log"), "");

// 1. the synthetic recording: a tone that changes pitch every 30 s plus quiet noise, mono 16 kHz, the whole length.
const wav = path.join(tmp, "long.wav");
const t0 = Date.now();
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=16000:duration=${minutes * 60}`, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.02:sample_rate=16000:duration=${minutes * 60}`, "-filter_complex", "[0][1]amix=inputs=2:duration=shortest,tremolo=f=0.5:d=0.6", "-ac", "1", wav]);
// 2. cut like the page: one self-contained opus/webm file per NOTE_SEGMENT_S, 32 kbit/s.
const parts = Math.ceil((minutes * 60) / NOTE_SEGMENT_S);
const files: string[] = [];
for (let n = 0; n < parts; n++) {
  const f = path.join(tmp, `part${n}.webm`);
  execFileSync("ffmpeg", ["-v", "error", "-ss", String(n * NOTE_SEGMENT_S), "-t", String(NOTE_SEGMENT_S), "-i", wav, "-c:a", "libopus", "-b:a", "32k", "-ac", "1", f]);
  files.push(f);
}
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
log(`TEST recording: ${minutes} min synthetic audio, ${parts} parts of ${NOTE_SEGMENT_S} s, made in ${Math.round((Date.now() - t0) / 1000)} s`);

// 3. the dev console: temp DB, TEST desk file, fake transcriber, nothing forwarded to memory.
const db = openDb(path.join(tmp, "console.db"));
const posted: string[] = [];
const desk: DeskPort = {
  send: async (text: string) => {
    posted.push(text);
    fs.writeFileSync(path.join(out, "posted-TEST.txt"), `TEST — dev copy only, never the owner's chat or memory\n\n${text}`);
    return { threadId: "dev_thread_TEST", pending: false };
  },
  view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
};
const voice = createVoice({ db, mint: async () => ({ value: "dev", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }) });
const transcribe: Transcriber = async (audio, o) => {
  const n = Number(o.filename.split("-").pop()!.split(".")[0]);
  if (n === FAIL_PART) throw new Error("TEST: OpenAI answered 500");
  return { text: `TEST words of part ${n + 1} (${audio.byteLength} bytes)` };
};
const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(tmp, "notes") });
const app = new Hono();
mountVoiceNotesRec(app, "/api/voice", () => notes);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/voice`;
const page = { "sec-fetch-site": "same-origin" };

const call = async (method: string, p: string, body?: BodyInit, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method, headers: { ...page, ...headers }, body });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
};

// 4. the note: start, every part up as recorded, Send.
const st = await call("POST", "/notes", JSON.stringify({ page: "long-note TEST dev copy" }), { "content-type": "application/json" });
log(`start ${st.status}: note ${st.j.note.id}, maxMin ${st.j.maxMin}, warnMin ${st.j.warnMin}, segmentS ${st.j.segmentS}`);
let bytes = 0, maxBytes = 0, slowest = 0, secs = 0;
const failed: number[] = [];
for (let n = 0; n < parts; n++) {
  const body = fs.readFileSync(files[n]);
  const s = dur(files[n]);
  const a = Date.now();
  const r = await call("POST", `/notes/${st.j.note.id}/segments/${n}`, body, { "content-type": "audio/webm", "x-seconds": s.toFixed(2) });
  slowest = Math.max(slowest, Date.now() - a);
  bytes += body.byteLength;
  maxBytes = Math.max(maxBytes, body.byteLength);
  secs += s;
  if (r.status !== 200) failed.push(n), log(`part ${n + 1}: ${r.status} ${r.j.error?.code}: ${r.j.error?.message}`);
}
log(`uploaded ${parts} parts, ${(bytes / 1024 / 1024).toFixed(1)} MB in all, largest ${(maxBytes / 1024).toFixed(0)} KB, slowest ${slowest} ms, ${(secs / 60).toFixed(1)} min of audio`);
const fin = await call("POST", `/notes/${st.j.note.id}/finish`, JSON.stringify({ segments: parts }), { "content-type": "application/json" });
log(`finish ${fin.status}: state ${fin.j.note?.state}, ${fin.j.note?.seconds} s, ${fin.j.note?.segments} parts`);
const msg = posted[0] ?? "";
const named = msg.match(/\[Part \d+, from [^\]]+\]/)?.[0];
log(`posted once: ${posted.length === 1}; untranscribed part named: ${named ?? "no"}`);
log(`words of part 1 first: ${msg.includes("TEST words of part 1 ")}; words of part ${parts} last: ${msg.trim().endsWith(`TEST words of part ${parts} (` + msg.trim().split("(").pop())}`);
// 5. past the cap: a new note at the cap refuses one part too many, with a clear answer.
const st2 = await call("POST", "/notes", JSON.stringify({ page: "long-note TEST cap" }), { "content-type": "application/json" });
let capAt = -1;
for (let n = 0; n < parts + 3; n++) {
  const r = await call("POST", `/notes/${st2.j.note.id}/segments/${n}`, fs.readFileSync(files[0]), { "content-type": "audio/webm", "x-seconds": "120" });
  if (r.status === 409) {
    capAt = n;
    log(`cap: part ${n + 1} (${((n * 120) / 60).toFixed(0)} min in) answered ${r.status} ${r.j.error?.code}: ${r.j.error?.message}`);
    break;
  }
}
await call("POST", `/notes/${st2.j.note.id}/discard`, "{}", { "content-type": "application/json" });
const result = { minutes, parts, mb: +(bytes / 1024 / 1024).toFixed(1), largestKb: Math.round(maxBytes / 1024), slowestMs: slowest, audioMin: +(secs / 60).toFixed(1), uploadRefused: failed, finish: fin.status, state: fin.j.note?.state, postedOnce: posted.length === 1, untranscribedNamed: named ?? null, capRefusesPart: capAt + 1, maxMin: st.j.maxMin, warnMin: st.j.warnMin };
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
log(JSON.stringify(result));
server.close();
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
