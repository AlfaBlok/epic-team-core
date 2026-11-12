import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { isOpen } from "../src/auth/routeScope.js";
import type { ScaffoldInput, SpineWriter } from "../src/inbox/spineWrite.js";
import { notesMonthUsd } from "../src/voice/notes.js";
import {
  createFeedback,
  FEEDBACK_DIR,
  FEEDBACK_NOTES_PER_DAY,
  feedbackDeskNote,
  feedbackPage,
  mountFeedback,
  readFiledFeedback,
  type Structurer,
} from "../src/voiceFeedback.js";

// a link per recipient, a page that records a voice note, transcribed only (no
// audio kept), structured, filed in the world's repo as feedback/voice/<day>-<id>.md, one desk note, the console's list.

let db: DB;
let repo: string;
let told: { world: string; text: string; id: string }[];
let structured = 0;
const transcribe = async (audio: Uint8Array) => ({ text: `part of ${audio.byteLength} bytes said`, usage: { type: "tokens", input_tokens: 100, output_tokens: 20, input_token_details: { audio_tokens: 100, text_tokens: 0 } } });
const structure: Structurer = async (t, ctx) => {
  structured++;
  return { structure: { summary: `${ctx.who} likes it.`, sentiment: "mixed", asks: ["A dark mode"], bugs: ["Send does nothing on Safari"], praise: ["Fast drafts"], quotes: [t.slice(0, 20)] }, costUsd: 0.0002 };
};
const writer = (): SpineWriter => ({
  scaffold: async (o: ScaffoldInput) => {
    const r = await o.scaffold(o.repoDir);
    return r.ok ? { status: "written", sha: "abc1234", path: r.files[0] } : { status: "skipped", reason: r.error };
  },
} as unknown as SpineWriter);

let t = Date.parse("2026-11-08T17:00:00Z");
const make = (o: Partial<Parameters<typeof createFeedback>[0]> = {}) =>
  createFeedback({
    db,
    transcribe,
    structure,
    budget: () => ({ monthUsd: 1, monthCapUsd: 20, enabled: true }),
    repoOf: () => repo,
    writer: writer(),
    tell: async (world, text, id) => {
      told.push({ world, text, id });
      return true;
    },
    pageBase: "https://team.example.com",
    now: () => t,
    ...o,
  });

beforeEach(() => {
  db = openDb(":memory:");
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "e46s20-"));
  told = [];
  structured = 0;
  t = Date.parse("2026-11-08T17:00:00Z");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("T46-S20 voice feedback engine", () => {
  it("records parts, keeps text only, files a structured item in the repo and tells the desk once", async () => {
    const f = make();
    const link = f.createLink({ world: "acme", who: "Ana (tester)", product: "SocialApp", campaign: "testers", by: "Sam" });
    expect(link.token.length).toBeGreaterThanOrEqual(16);
    const { note } = f.start(link.token);
    await f.segment(link.token, note.id, 0, new Uint8Array(1000), "audio/webm;codecs=opus", 60);
    await f.segment(link.token, note.id, 1, new Uint8Array(500), "audio/webm", 20);
    // a retried part answers from its text, no second transcription
    expect((await f.segment(link.token, note.id, 1, new Uint8Array(9), "audio/webm", 20)).text).toBe("part of 500 bytes said");
    const done = f.finish(link.token, note.id, { parts: 2 });
    expect(done.note.state).toBe("transcribed");
    expect(done.note.transcript).toBe("part of 1000 bytes said\n\npart of 500 bytes said");
    await settle();
    const [n] = f.notes("acme");
    expect(n.state).toBe("filed");
    expect(n.file).toBe(`${FEEDBACK_DIR}/2026-11-08-${note.id}.md`);
    expect(n.sha).toBe("abc1234");
    expect(n.seconds).toBe(80);
    const text = fs.readFileSync(path.join(repo, n.file!), "utf8");
    expect(text).toContain('from: "Ana (tester)"');
    expect(text).toContain("sentiment: mixed");
    expect(text).toContain("audio: not kept (transcribed only)");
    expect(text).toContain("status: new");
    expect(text).toContain("## Asks\n\n- A dark mode");
    expect(text).toContain("## Bugs\n\n- Send does nothing on Safari");
    expect(text).toContain("## What they said\n\npart of 1000 bytes said");
    // no audio anywhere: the segments table has no file column and the repo only the Markdown
    expect(fs.readdirSync(path.join(repo, FEEDBACK_DIR))).toEqual([path.basename(n.file!)]);
    expect((db.prepare("PRAGMA table_info(feedback_segments)").all() as { name: string }[]).map((c) => c.name)).not.toContain("file");
    expect(told).toHaveLength(1);
    expect(told[0].id).toBe(`voice-feedback-${note.id}`);
    expect(told[0].text).toContain("[voice feedback] Ana (tester) · SocialApp");
    expect(told[0].text).toContain("Asks: A dark mode");
    expect(told[0].text).toContain("https://team.example.com/feedback");
    // filing again does nothing new
    await f.file(note.id);
    await f.tick();
    expect(told).toHaveLength(1);
    expect(structured).toBe(1);
    // the console list reads the repo file back
    const [item] = readFiledFeedback(repo);
    expect(item.fields.from).toBe("Ana (tester)");
    expect(item.asks).toEqual(["A dark mode"]);
    expect(item.bugs).toEqual(["Send does nothing on Safari"]);
  });

  it("never loses a note: a failed structure files the transcript as pending, a failed write is retried by the tick", async () => {
    let fail = true;
    const flaky = {
      scaffold: async (o: any) => {
        if (fail) return { status: "failed", reason: "git push failed" };
        await o.scaffold(o.repoDir);
        return { status: "written", sha: "def5678" };
      },
    } as unknown as SpineWriter;
    const f = make({ writer: flaky, structure: async () => Promise.reject(new Error("OpenAI 500")) });
    const link = f.createLink({ world: "acme", who: "Bo", product: "SocialApp", campaign: "testers", by: "Sam" });
    const { note } = f.start(link.token);
    await f.segment(link.token, note.id, 0, new Uint8Array(10), "audio/mp4", 12);
    f.finish(link.token, note.id, { parts: 1 });
    await settle();
    let [n] = f.notes("acme");
    expect(n.state).toBe("transcribed");
    expect(n.fileError).toContain("git push failed");
    expect(told).toHaveLength(0);
    fail = false;
    await f.tick();
    [n] = f.notes("acme");
    expect(n.state).toBe("filed");
    const text = fs.readFileSync(path.join(repo, n.file!), "utf8");
    expect(text).toContain("structure: pending");
    expect(text).toContain("Not structured yet (OpenAI 500)");
    expect(text).toContain("part of 10 bytes said");
    expect(told).toHaveLength(1);
  });

  it("refuses revoked or unknown tokens, missing parts, the daily cap, the month budget and non-audio", async () => {
    const f = make();
    const link = f.createLink({ world: "acme", who: "Cy", product: "SocialApp", campaign: "testers", by: "Sam" });
    expect(() => f.start("nope-nope-nope")).toThrow(/not valid/);
    const { note } = f.start(link.token);
    await expect(f.segment(link.token, note.id, 0, new Uint8Array(5), "text/html", 3)).rejects.toThrow(/not audio/);
    expect(() => f.finish(link.token, note.id, { parts: 1 })).toThrow(/parts not in yet: 0/);
    for (let i = 1; i < FEEDBACK_NOTES_PER_DAY; i++) f.start(link.token);
    expect(() => f.start(link.token)).toThrow(/notes today/);
    f.revokeLink("acme", link.id);
    expect(() => f.start(link.token)).toThrow(/not valid/);
    const broke = make({ budget: () => ({ monthUsd: 20, monthCapUsd: 20, enabled: true }) });
    const l2 = broke.createLink({ world: "acme", who: "Di", product: "SocialApp", campaign: "testers", by: "Sam" });
    expect(() => broke.start(l2.token)).toThrow(/paused until next month/);
  });

  it("cancel keeps nothing they said; the cost counts in the world's voice budget", async () => {
    const f = make();
    const link = f.createLink({ world: "acme", who: "Ed", product: "SocialApp", campaign: "testers", by: "Sam" });
    const { note } = f.start(link.token);
    await f.segment(link.token, note.id, 0, new Uint8Array(10), "audio/webm", 60);
    f.discard(link.token, note.id);
    expect((db.prepare("SELECT COUNT(*) n FROM feedback_segments").get() as { n: number }).n).toBe(0);
    expect(f.notes("acme")).toHaveLength(0);
    const m = notesMonthUsd(db, "acme", "2026-11-01T00:00:00Z");
    expect(m.usd).toBeGreaterThan(0);
    expect(notesMonthUsd(db, "other", "2026-11-01T00:00:00Z").usd).toBe(0);
  });

  it("a note left recording for a day is sent with what it has", async () => {
    const f = make();
    const link = f.createLink({ world: "acme", who: "Fi", product: "SocialApp", campaign: "testers", by: "Sam" });
    const { note } = f.start(link.token);
    await f.segment(link.token, note.id, 1, new Uint8Array(10), "audio/webm", 60);
    t += 25 * 3600_000;
    await f.tick();
    await f.tick();
    const [n] = f.notes("acme");
    expect(n.state).toBe("filed");
  });
});

describe("T46-S20 routes", () => {
  const app = (f = make()) => {
    const api = new Hono();
    mountFeedback(api, f, { world: () => "acme", by: () => "Sam", repoOf: () => repo });
    const a = new Hono();
    a.route("/api", api);
    return a;
  };

  it("Sam makes a link; the recipient's page, start, part and finish work through it", async () => {
    const a = app();
    const r = await a.request("http://team.example.com/api/feedback/links", { method: "POST", headers: { "content-type": "application/json", host: "team.example.com", "x-forwarded-proto": "https" }, body: JSON.stringify({ who: "Ana" }) });
    expect(r.status).toBe(201);
    const link = (await r.json()) as { url: string; token: string; product: string; campaign: string };
    expect(link.product).toBe("SocialApp");
    expect(link.url).toBe(`https://team.example.com/api/public/feedback/${link.token}`);
    const page = await a.request(`/api/public/feedback/${link.token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Tell us about SocialApp");
    expect(html).toContain("Nobody listens to your voice");
    // the clean app look, not paper: Inter from our own site, no serif, no warm paper ground; every function kept
    expect(html).toContain('url(/fonts/inter-400.woff2)');
    expect(html).not.toMatch(/Georgia|Newsreader|["'\s,]serif\b|--paper|#f6f1e7|#fffdf8/);
    for (const id of ['id="rec"', 'id="label"', 'id="time"', 'id="status"', 'id="cancel"', 'id="done"', 'id="words"', 'id="again"']) expect(html).toContain(id);
    const bad = await a.request("/api/public/feedback/not-a-real-token");
    expect(bad.status).toBe(404);
    const s = (await (await a.request(`/api/public/feedback/${link.token}/notes`, { method: "POST" })).json()) as { note: { id: string }; segmentS: number };
    expect(s.segmentS).toBe(60);
    const p = await a.request(`/api/public/feedback/${link.token}/notes/${s.note.id}/parts/0`, { method: "POST", headers: { "content-type": "audio/webm", "x-seconds": "30" }, body: new Uint8Array(42) });
    expect(((await p.json()) as { text: string }).text).toBe("part of 42 bytes said");
    const fin = await a.request(`/api/public/feedback/${link.token}/notes/${s.note.id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: 1 }) });
    expect(((await fin.json()) as { transcript: string }).transcript).toBe("part of 42 bytes said");
    await settle();
    const list = (await (await a.request("/api/feedback")).json()) as { links: { notes: number }[]; filed: { fields: Record<string, string> }[] };
    expect(list.links[0].notes).toBe(1);
    expect(list.filed[0].fields.from).toBe("Ana");
  });

  it("the public paths are open by token shape only; the list and link making need a sign-in", () => {
    expect(isOpen("GET", "/api/public/feedback/AbCdEfGhIjKlMnOp")).toBe(true);
    expect(isOpen("GET", "/fonts/inter-400.woff2")).toBe(true);
    expect(isOpen("GET", "/fonts/../console.db")).toBe(false);
    expect(isOpen("POST", "/api/public/feedback/AbCdEfGhIjKlMnOp/notes")).toBe(true);
    expect(isOpen("POST", "/api/public/feedback/AbCdEfGhIjKlMnOp/notes/fbn_0123abcd/parts/3")).toBe(true);
    expect(isOpen("POST", "/api/public/feedback/AbCdEfGhIjKlMnOp/notes/fbn_0123abcd/finish")).toBe(true);
    expect(isOpen("GET", "/api/feedback")).toBe(false);
    expect(isOpen("POST", "/api/feedback/links")).toBe(false);
    expect(isOpen("POST", "/api/public/feedback/AbCdEfGhIjKlMnOp/notes/fbn_0123abcd/file")).toBe(false);
  });

  it("the page escapes the recipient's name; the desk note quotes the summary", () => {
    expect(feedbackPage({ who: "<b>x</b>", product: "SocialApp" })).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(feedbackPage(undefined)).toContain("not valid any more");
    const n = feedbackDeskNote({ id: "fbn_1", linkId: "fbl_1", world: "acme", who: "Ana", product: "SocialApp", campaign: "testers", startedAt: "2026-11-08T17:00:00Z", state: "filed", seconds: 75, costUsd: 0.01, file: "feedback/voice/x.md", repo: "home_repo", structure: { summary: "Good.", sentiment: "positive", asks: [], bugs: ["b"], praise: [], quotes: [] } }, "https://team.example.com/");
    expect(n).toContain("1 min 15 s, positive");
    expect(n).toContain("Bugs: b");
    expect(n).not.toContain("Asks:");
  });
});
