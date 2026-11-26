import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { LISTEN_DAYS, mountReplyNote, signedListen } from "../src/voice/replyNote.js";

/**
 * The owner 26 Nov 01:50Z: "link broken". WhatsApp opens the briefing's Listen link in its own browser,
 * signed in nowhere, and the page sent it to the login. The link now carries its own signature: that one voice note's
 * page and sound open with no cookie for LISTEN_DAYS days; nothing else of the console opens with it.
 */
const ANDROID_WA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36 WhatsApp/2.24";
let restore: (() => void) | undefined;
afterEach(() => restore?.());

function world(at: () => number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listen-open-"));
  const notes = path.join(dir, "reply-notes");
  fs.mkdirSync(notes);
  const id = "0123456789abcdef01234567";
  fs.writeFileSync(path.join(notes, `${id}.mp3`), Buffer.from("ID3" + "x".repeat(997)));
  fs.writeFileSync(path.join(notes, `${id}.json`), JSON.stringify({ title: "Your evening briefing", words: "Two objectives moved today.", at: "2026-11-26T01:00:00Z" }));
  const prev = process.env.CONSOLE_REPLY_NOTES_DIR;
  process.env.CONSOLE_REPLY_NOTES_DIR = notes;
  restore = () => (prev === undefined ? delete process.env.CONSOLE_REPLY_NOTES_DIR : (process.env.CONSOLE_REPLY_NOTES_DIR = prev));
  const app = createApp(openDb(path.join(dir, "console.db")), {
    auth: "on",
    browser: { browserUrl: "http://127.0.0.1:9" },
    read: { reposRoot: path.join(dir, "repos"), seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    voice: { now: at },
  });
  const get = (p: string, h: Record<string, string> = {}) => app.request(p, { headers: { "user-agent": ANDROID_WA, accept: "text/html", "sec-fetch-mode": "navigate", ...h } });
  return { app, get, notes, id };
}

describe("the briefing's Listen link opens from WhatsApp with no sign-in", () => {
  it("signed: the page and its sound open with no cookie; the sound answers byte ranges", async () => {
    const now = Date.parse("2026-11-26T02:00:00Z");
    const { get, notes, id } = world(() => now);
    const link = signedListen(notes, id, now);
    const page = await get(link);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Your evening briefing</title>");
    expect(html).toContain(`src="${link}/audio.mp3"`);
    expect(html).toContain("Two objectives moved today.");
    expect(html).not.toContain("TEST");
    const all = await get(`${link}/audio.mp3`);
    expect(all.status).toBe(200);
    expect(all.headers.get("content-type")).toBe("audio/mpeg");
    const part = await get(`${link}/audio.mp3`, { range: "bytes=0-99" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-99/1000");
  });

  it("only that note, only while it lasts: a changed signature, another note or an old link does not open", async () => {
    let now = Date.parse("2026-11-26T02:00:00Z");
    const { get, notes, id } = world(() => now);
    const link = signedListen(notes, id, now);
    const other = "fedcba9876543210fedcba98";
    fs.writeFileSync(path.join(notes, `${other}.mp3`), "ID3");
    const forged = link.replace(/[A-Za-z0-9_-]$/, (ch) => (ch === "A" ? "B" : "A"));
    expect((await get(forged)).status).toBe(404);
    expect((await get(link.replace(id, other))).status).toBe(404);
    expect((await get(`${link.replace(id, other)}/audio.mp3`)).status).toBe(404);
    // the login still guards everything else, the plain /listen/<id> page among it
    expect((await get(`/listen/${id}`)).status).toBe(302);
    expect((await get(`${link}/../../api/status`)).status).not.toBe(200);
    now += (LISTEN_DAYS + 1) * 86_400_000;
    const late = await get(link);
    expect(late.status).toBe(410);
    expect(await late.text()).toMatch(/expired/);
    expect((await get(`${link}/audio.mp3`)).status).toBe(410);
  });

  it("a real briefing that says a test's words takes its own title, never the test's TEST mark", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listen-title-"));
    const api = new Hono();
    const f = vi.fn(async () => new Response(Buffer.from("ID3fake"), { status: 200 })) as unknown as typeof fetch;
    mountReplyNote(api, { key: async () => "k", dir, fetch: f });
    const post = (title: string) => api.request("/voice/reply-note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Do the wheels turn? Yes.", title, rest: "" }) });
    const t = (await (await post("TEST · Do the wheels turn")).json()) as { listen: string };
    const r = (await (await post("Do the wheels turn")).json()) as { listen: string; kept: boolean };
    expect(r.kept).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const id = r.listen.split("/")[2];
    expect(t.listen.split("/")[2]).toBe(id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")).title).toBe("Do the wheels turn");
  });
});
