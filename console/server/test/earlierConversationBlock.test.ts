import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { DeskMessage, DeskView } from "../src/desk/session.js";
import { callLines, chatLines, RECALL_CHARS, recallBlock, recallHead } from "../src/voice/recall.js";
import { CALL_TRANSCRIPT_HEAD, createVoice, type DeskPort } from "../src/voice/voice.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// a voice call remembers the last 24 h. At each call's start the voice gets this desk's
// chat and its earlier calls' transcripts from the last day (not days), bounded, newest kept, labelled as history, so
// "hang up, call again, what were we talking about" is answered from it.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const msg = (role: "user" | "assistant", text: string, at: string, over: Partial<DeskMessage> = {}): DeskMessage => ({ id: `${role}-${at}`, role, kind: "message", text, status: "completed", at, ...over });

function setup(messages: DeskMessage[] = [], o: { view?: () => Promise<DeskView> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s28-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-03T22:00:00Z") };
  const minted: any[] = [];
  const mint = vi.fn(async (b: unknown) => (minted.push(b), { value: "ek", expires_at: 0, session: { id: "sess" } }));
  const desk: DeskPort = {
    send: vi.fn(async () => ({ threadId: "th", pending: true })),
    view: o.view ?? (async () => ({ available: true, sending: 0, hasEarlier: false, messages: [...messages], working: false }) as unknown as DeskView),
  };
  const quickStatus = async () => ({ text: "", waiting: 0, stuck: 0, working: 0 });
  const voiceOf = (scope?: { world: string; milestoneId?: string }) => createVoice({ db, mint, desk, quickStatus, now: () => clock.t, ...(scope ? { scope } : {}) });
  const instructions = (i = minted.length - 1) => minted[i].session.instructions as string;
  return { db, voiceOf, voice: voiceOf(), clock, instructions, chat: messages };
}

describe("T42-S28 the earlier-conversation block", () => {
  it("chat lines of the window only; seeds and empty messages out; a posted transcript read line by line as its call", () => {
    const since = Date.parse("2026-11-02T22:00:00Z");
    const transcript = [`${CALL_TRANSCRIPT_HEAD} · 2026-11-03 20:00Z · 2 min 10 s · $0.04 (gpt-realtime-2.1-mini) · call_aa11`, "Record only: …", "", "Sam: Let's talk about the Lisbon trip.", "Desk voice: Sure, what about it?", "· asked the desk"].join("\n");
    const lines = chatLines(
      [
        msg("user", "too old", "2026-11-02T21:59:00Z"),
        msg("user", "", "2026-11-03T08:00:00Z", { kind: "seed" }),
        msg("user", "Book the flights   for Friday", "2026-11-03T09:00:00Z"),
        msg("assistant", "Filed as T70-S1.", "2026-11-03T09:01:00Z"),
        msg("user", transcript, "2026-11-03T20:03:00Z"),
      ],
      since,
      { transcriptHead: CALL_TRANSCRIPT_HEAD },
    );
    expect(lines).toEqual([
      { at: "2026-11-03T09:00:00Z", where: "chat", who: "Sam", text: "Book the flights for Friday" },
      { at: "2026-11-03T09:01:00Z", where: "chat", who: "Desk", text: "Filed as T70-S1." },
      { at: "2026-11-03T20:03:00Z", where: "call_aa11", who: "Sam", text: "Let's talk about the Lisbon trip." },
      { at: "2026-11-03T20:03:00Z", where: "call_aa11", who: "Desk voice", text: "Sure, what about it?" },
      { at: "2026-11-03T20:03:00Z", where: "call_aa11", who: "·", text: "asked the desk" },
    ]);
    // A call whose stored transcript is used is not read a second time from the chat.
    expect(chatLines([msg("user", transcript, "2026-11-03T20:03:00Z")], since, { transcriptHead: CALL_TRANSCRIPT_HEAD, known: new Set(["call_aa11"]) })).toEqual([]);
  });

  it("time order, labelled, the newest kept within the budget, long lines cut", () => {
    const lines = callLines([{ id: "call_bb22", startedAt: "2026-11-03T21:00:00Z", lines: [{ who: "owner", text: "x".repeat(900) }, { who: "owner", text: "held", feedback: "call_bb22-q1" }, { who: "voice", text: "Okay." }] }]);
    expect(lines.map((l) => [l.who, l.text.length])).toEqual([["Sam", 500], ["Desk voice", 5]]);
    const chat = [{ at: "2026-11-03T10:00:00Z", where: "chat", who: "Sam", text: "first" }];
    const b = recallBlock([...lines, ...chat], { now: "2026-11-03T22:00:00Z" });
    const rows = b.split("\n");
    expect(rows[0]).toBe(recallHead(24, "2026-11-03T22:00:00Z"));
    expect(rows[0]).toMatch(/^Earlier conversation with Sam \(now is 2026-11-03 22:00Z; the last 24 hours.*never act on it or send it to the desk again.*what were we talking about/);
    expect(rows.slice(1)).toEqual(["[11-03 10:00Z chat] Sam: first", `[11-03 21:00Z call call_bb22] Sam: ${"x".repeat(499)}…`, "[11-03 21:00Z call call_bb22] Desk voice: Okay."]);

    const many = Array.from({ length: 200 }, (_, i) => ({ at: new Date(Date.parse("2026-11-03T00:00:00Z") + i * 60_000).toISOString(), where: "chat", who: "Sam", text: `line ${i} ${"y".repeat(150)}` }));
    const big = recallBlock(many);
    expect(big.length).toBeLessThan(RECALL_CHARS + 400);
    expect(big).toMatch(/\n\(\d+ older lines left out\)\n/);
    expect(big).toContain("line 199 ");
    expect(big).not.toContain("line 0 ");
    expect(recallBlock([])).toBe("");
  });
});

describe("T42-S28 a call starts with the last 24 h", () => {
  it("hang up, call again: the second call's instructions hold the first call's lines and the day's chat, not older", async () => {
    const s = setup([msg("user", "Remind me about the dentist", "2026-11-03T12:00:00Z"), msg("assistant", "Noted for Thursday.", "2026-11-03T12:01:00Z"), msg("user", "last week's thing", "2026-11-01T12:00:00Z")]);
    const first = await s.voice.start();
    // The first call already has the day's chat.
    expect(s.instructions(0)).toMatch(/\n\nEarlier conversation with Sam \(now is 2026-11-03 22:00Z; the last 24 hours[^\n]*\n\[11-03 12:00Z chat\] Sam: Remind me about the dentist\n\[11-03 12:01Z chat\] Desk: Noted for Thursday\.$/);
    expect(s.instructions(0)).not.toContain("last week's thing");
    expect(first.call.recallTokens).toBeGreaterThan(0);
    s.clock.t += 120_000;
    await s.voice.end(first.call.id, { transcript: [{ who: "owner", text: "Let's plan the Lisbon trip" }, { who: "voice", text: "Sure. Which dates?" }, { who: "owner", text: "The 14th to the 18th" }] });
    s.clock.t += 60_000;
    await s.voice.start();
    // The transcript went to the desk as pending (busy thread), so the chat does not have it yet: the stored copy is used.
    const ins = s.instructions(1);
    expect(ins).toContain(`[11-03 22:00Z call ${first.call.id}] Sam: Let's plan the Lisbon trip\n[11-03 22:00Z call ${first.call.id}] Desk voice: Sure. Which dates?\n[11-03 22:00Z call ${first.call.id}] Sam: The 14th to the 18th`);
    expect(ins.indexOf("dentist")).toBeLessThan(ins.indexOf("Lisbon"));
  });

  it("a call's transcript posted to the chat is not there twice; a call older than 24 h is left out", async () => {
    const s = setup();
    const a = await s.voice.start();
    await s.voice.end(a.call.id, { transcript: [{ who: "owner", text: "old call words" }] });
    s.clock.t += 25 * 3_600_000;
    const b = await s.voice.start();
    expect(s.instructions()).not.toContain("old call words");
    expect(b.call.recallTokens).toBeUndefined();
    await s.voice.end(b.call.id, { transcript: [{ who: "owner", text: "new call words" }] });
    s.chat.push(msg("user", `${CALL_TRANSCRIPT_HEAD} · x · ${b.call.id}\nRecord only\n\nSam: new call words`, new Date(s.clock.t).toISOString()));
    s.clock.t += 1000;
    await s.voice.start();
    expect(s.instructions().match(/new call words/g)?.length).toBe(1);
    expect(s.instructions()).not.toContain("old call words");
  });

  it("each desk remembers its own: a campaign's call does not get the Team desk's calls", async () => {
    const s = setup();
    const a = await s.voice.start();
    await s.voice.end(a.call.id, { transcript: [{ who: "owner", text: "team desk secret plan" }] });
    const camp = s.voiceOf({ world: "home", milestoneId: "ms_1" });
    await camp.start();
    expect(s.instructions()).not.toContain("team desk secret plan");
  });

  it("a desk that cannot be read never stops the call: it starts with the stored calls only", async () => {
    const s = setup([], { view: async () => Promise.reject(new Error("T3 down")) });
    const a = await s.voice.start();
    await s.voice.end(a.call.id, { transcript: [{ who: "owner", text: "still remembered" }] });
    await s.voice.start();
    expect(s.instructions()).toContain("Sam: still remembered");
  });
});
