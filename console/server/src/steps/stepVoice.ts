/**
 * the voice button of every steps page's note box. The steps pages live on plain-http
 * tailnet hosts, where a browser gives no microphone, so the kit's button opens this small page on the console's own (https)
 * origin. It records like the Chat and the card answers (parts every NOTE_SEGMENT_S on one microphone, each uploaded at once,
 * routes `/api/public/steps/<token>/voice/notes…`, voice/notes.ts in its open form: every finish is `fill`, so the note lands
 * in the memory service once and its other topics reach the desk), then files the words as the step's note through the page's own ticks
 * route, exactly as a typed note, and tells the steps page to show it.
 */
import { KEEP_JS } from "../voice/keepJs.js";
import { NOTE_MAX_MIN } from "../voice/notes.js";
import { memoryName } from "../identity.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The step's recorder page; `step` must be the step's id (checked by the caller), `stepTitle` its name as the kit gave it. */
export function stepVoicePage(o: { page?: { title: string }; step: string; stepTitle: string }): string {
  const title = o.page ? `A voice note on ${esc(o.stepTitle || o.step)}` : "Link not valid";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
:root{--paper:#f6f1e7;--ink:#1d1b16;--muted:#6b6457;--line:#d9d0bf;--green:#1f5a43;--red:#a33a2b}
*{box-sizing:border-box}html,body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:30rem;margin:0 auto;padding:1.6rem 1.1rem 2rem}
h1{font:600 1.45rem/1.25 Georgia,"Times New Roman",serif;margin:0 0 .4rem}
p{margin:.4rem 0}.muted{color:var(--muted)}.small{font-size:.9rem}
.card{border:1px solid var(--line);border-radius:14px;padding:1.1rem;margin:1rem 0;background:#fffdf8}
#rec{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;min-height:4rem;border:0;border-radius:999px;background:var(--green);color:#fff;font:600 1.1rem/1 system-ui,sans-serif;cursor:pointer}
#rec.on{background:var(--red)}#rec:disabled{opacity:.55;cursor:default}
.dot{width:.8rem;height:.8rem;border-radius:50%;background:#fff}#rec.on .dot{animation:b 1s infinite}@keyframes b{50%{opacity:.25}}
#time{font:600 1.5rem/1 ui-monospace,Menlo,monospace;text-align:center;margin:.8rem 0 .2rem}
#status{text-align:center;min-height:1.5rem}
#cancel{display:none;margin:.5rem auto 0;background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer}
#done{display:none}#done pre{white-space:pre-wrap;font:inherit;background:#f1ebdf;border-radius:10px;padding:.8rem;max-height:16rem;overflow:auto}
.err{color:var(--red)}
</style></head><body><main>
${
  o.page
    ? `<h1>${title}</h1>
<p class="muted small">${esc(o.page.title)}</p>
<div class="card" id="box">
<button id="rec" type="button"><span class="dot"></span><span id="label">Tap to start talking</span></button>
<div id="time">0:00</div><div id="status" class="muted small">Up to ${NOTE_MAX_MIN} minutes. Tap again to send it as your note on this step.</div>
<button id="cancel" type="button">Cancel, do not send</button>
</div>
<div id="done" class="card"><p><b>Sent as your note on this step.</b> The team has it; you can close this window.</p><pre id="words"></pre></div>
<p class="muted small">Your words are turned into text and filed like a typed note: in the epic, on the Team desk, and in your ${memoryName()}.</p>`
    : `<h1>${title}</h1><p>This steps page link is not valid any more.</p>`
}
</main>
${o.page ? `<script>window.STEP=${JSON.stringify({ id: o.step, title: o.stepTitle || o.step }).replace(/</g, "\\u003c")};${KEEP_JS}${PAGE_JS}</script>` : ""}
</body></html>`;
}

/** Plain browser JS: the voice-feedback recorder's loop (voiceFeedback.ts), then one tick with the words as the note. */
const PAGE_JS = String.raw`
(() => {
  const base = location.pathname.replace(/\/+$/, "");
  const ticks = base.replace(/\/voice$/, "/ticks");
  const $ = (id) => document.getElementById(id);
  const rec = $("rec"), label = $("label"), time = $("time"), status = $("status"), cancel = $("cancel");
  let SEG = 120000, MAX = 30 * 60000;
  let stream, mr, note, t0, tick, segTimer, part = 0, parts = 0, queue = Promise.resolve(), failed = false, stopping = false, cid, rec0;
  const skip = [], done = [];
  // the note is kept in this browser until the console confirms it; a resend lands in the same note, once.
  const KEPT = "Saved on this phone. It is sent by itself as soon as the connection is back; you can leave this window open or come back to this page.";
  const keepRec = (p) => (rec0 = Object.assign({}, rec0, p), KEEP.put(rec0));
  const say = (t, err) => { status.textContent = t; status.className = (err ? "err" : "muted") + " small"; };
  const mime = () => ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
  const api = async (path, init) => {
    const r = await fetch(path, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ("Error " + r.status)); e.status = r.status; throw e; }
    return j;
  };
  const upload = async (n, blob, seconds) => {
    for (let i = 0; i < 6; i++) {
      try {
        await api(base + "/notes/" + note.id + "/segments/" + n, { method: "POST", headers: { "content-type": blob.type || "audio/webm", "x-seconds": String(seconds) }, body: blob });
        done.push(n); KEEP.dropPart(cid, n); keepRec({ done: done.slice() });
        return;
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) { failed = e.message; return; }
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    failed = "The connection dropped. Please try again.";
  };
  const startPart = () => {
    const m = mime();
    const r = new MediaRecorder(stream, m ? { mimeType: m, audioBitsPerSecond: 32000 } : undefined);
    const n = part++; const chunks = [];
    r.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const secs = (Date.now() - r._start) / 1000;
      const blob = new Blob(chunks, { type: (r.mimeType || m || "audio/webm").split(";")[0] });
      parts = Math.max(parts, n + 1);
      if (!blob.size) { skip.push(n); return; }
      KEEP.part(cid, n, blob, secs); keepRec({ parts });
      queue = queue.then(() => upload(n, blob, secs));
    };
    r._start = Date.now();
    r.start();
    mr = r;
  };
  const roll = () => { if (!stopping && mr && mr.state === "recording") { const old = mr; startPart(); old.stop(); } };
  const clock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const reset = () => { clearInterval(tick); clearInterval(segTimer); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = mr = undefined; rec.classList.remove("on"); label.textContent = "Tap to start talking"; cancel.style.display = "none"; rec.disabled = false; };
  async function start() {
    if (!window.MediaRecorder || !navigator.mediaDevices) { say("This browser cannot record here. Open this window in Chrome or Safari.", true); return; }
    rec.disabled = true; say("Asking for your microphone…");
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { rec.disabled = false; say("The microphone is needed to record. Allow it and tap again.", true); return; }
    cid = KEEP.cid(); KEEP.held.add(cid);
    const pageHint = (document.title + " · step " + STEP.id).slice(0, 200);
    try {
      const s = await api(base + "/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: pageHint, clientId: cid }) });
      note = s.note; SEG = (s.segmentS || 120) * 1000; MAX = (s.maxMin || 30) * 60000;
    } catch (e) { KEEP.held.delete(cid); reset(); say(e.message, true); return; }
    rec0 = { cid, base, page: pageHint, id: note.id, step: STEP.id, title: STEP.title, parts: 0, done: [] }; KEEP.put(rec0);
    part = 0; parts = 0; skip.length = 0; done.length = 0; failed = false; stopping = false; queue = Promise.resolve();
    startPart();
    t0 = Date.now(); rec.disabled = false; rec.classList.add("on"); label.textContent = "Tap to send"; cancel.style.display = "block";
    say("Recording. Take your time.");
    tick = setInterval(() => { const el = Date.now() - t0; time.textContent = clock(el); if (el >= MAX) stop(); }, 250);
    segTimer = setInterval(roll, SEG);
  }
  async function stop() {
    if (stopping) return; stopping = true;
    clearInterval(tick); clearInterval(segTimer);
    rec.disabled = true; cancel.style.display = "none"; label.textContent = "Sending…"; say("Turning your voice into text…");
    await new Promise((r) => { mr.addEventListener("stop", () => setTimeout(r, 0), { once: true }); mr.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    await queue;
    await keepRec({ parts, send: true });
    if (failed) { kept(); return; }
    try {
      say("Saved on this phone, sending…");
      const r = await api(base + "/notes/" + note.id + "/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: parts, skip }) });
      const words = (r.note && r.note.transcript || "").trim();
      if (!words) { reset(); say("Nothing could be heard. Please try again a bit closer to the microphone.", true); return; }
      say("Filing it as your note…");
      await api(ticks, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ step: STEP.id, title: STEP.title, comment: words }) });
      await KEEP.drop(cid); KEEP.held.delete(cid);
      reset();
      shown(words);
    } catch (e) { kept(e.message); }
  }
  const shown = (words) => {
    $("words").textContent = words; $("done").style.display = "block"; $("box").style.display = "none";
    try { window.opener && window.opener.postMessage({ stepsVoice: { step: STEP.id } }, "*"); } catch (e) {}
  };
  // Not confirmed yet (the console restarting, the connection gone): the note stays here and goes by itself.
  const kept = (why) => { KEEP.held.delete(cid); reset(); say(KEPT + (why ? " (" + why + ")" : "")); later(); };
  let timer;
  const later = () => { if (!timer) timer = setInterval(sendKept, 20000); };
  async function sendKept() {
    const n = await KEEP.drain({
      base,
      start: async (r) => (await api(base + "/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: r.page, clientId: r.cid }) })).note.id,
      segment: (id, p) => api(base + "/notes/" + id + "/segments/" + p.n, { method: "POST", headers: { "content-type": p.blob.type || "audio/webm", "x-seconds": String(p.seconds) }, body: p.blob }),
      finish: (id, n, sk) => api(base + "/notes/" + id + "/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: n, skip: sk }) }),
      after: async (r, rec) => {
        const words = (r.note && r.note.transcript || "").trim();
        if (!words) return;
        await api(ticks, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ step: rec.step || STEP.id, title: rec.title || STEP.title, comment: words }) });
        if ((rec.step || STEP.id) === STEP.id) shown(words);
      },
    });
    const left = (await KEEP.waiting(base)).length;
    if (n && !left) say("✓ Sent: your kept voice note is filed as your note.");
    else if (left) { say(left + " voice note" + (left > 1 ? "s" : "") + " saved on this phone, sending…"); later(); }
    if (!left && timer) { clearInterval(timer); timer = undefined; }
  }
  async function abort() {
    stopping = true; clearInterval(tick); clearInterval(segTimer);
    try { mr && mr.state === "recording" && (mr.onstop = null, mr.stop()); } catch (e) {}
    reset(); time.textContent = "0:00";
    if (cid) { KEEP.held.delete(cid); await KEEP.drop(cid); }
    if (note) await api(base + "/notes/" + note.id + "/discard", { method: "POST" }).catch(() => {});
    say("Cancelled. Nothing was sent.");
  }
  rec.addEventListener("click", () => (rec.classList.contains("on") ? stop() : start()));
  cancel.addEventListener("click", abort);
  document.addEventListener("visibilitychange", () => { if (document.hidden) roll(); });
  window.addEventListener("online", () => void sendKept());
  void sendKept();
})();
`;
