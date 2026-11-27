import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { costOf, tokensOfResponse, tokensOfTranscription, zeroTokens } from "../src/voice/prices.js";
import { answerIn, ASK_WORDS_MAX, RELAY_WORDS_MAX, relayedNotes, CALL_QUESTION_HEAD, CALL_TRANSCRIPT_HEAD, callWholeNote, createVoice, OPENING_LINE, QUIET_WARN_LINE, quickStatusText, ROLE_LINE, sessionConfig, voiceInstructions, type DeskPort } from "../src/voice/voice.js";
import { mountVoice } from "../src/voice/routes.js";
import { endpointLines, SEED_VERSION } from "../src/desk/desk.js";
import type { DeskMessage, DeskView } from "../src/desk/session.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

// Call the desk. The console mints a 1-minute client key per call under the caps and the off
// switch, answers the voice's two tools, meters every call's cost from the API's usage, and writes the transcript to Chat.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A real `response.done` usage payload's shape (GA Realtime API). */
const USAGE = {
  total_tokens: 1800,
  input_tokens: 1300,
  output_tokens: 500,
  input_token_details: { text_tokens: 900, audio_tokens: 400, image_tokens: 0, cached_tokens: 640, cached_tokens_details: { text_tokens: 576, audio_tokens: 64, image_tokens: 0 } },
  output_token_details: { text_tokens: 100, audio_tokens: 400 },
};

function setup(o: { now?: string; deskMessages?: DeskMessage[]; working?: boolean; relay?: (callId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s5-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse(o.now ?? "2026-11-01T18:00:00Z") };
  const mint = vi.fn(async (_body: unknown) => ({ value: "ek_test_secret", expires_at: Math.floor(clock.t / 1000) + 60, session: { id: "sess_1" } }));
  const sent: { text: string; page?: string; crid?: string }[] = [];
  const view: { messages: DeskMessage[]; working: boolean } = { messages: o.deskMessages ?? [], working: o.working ?? false };
  const desk: DeskPort = {
    send: vi.fn(async (text: string, page?: string, crid?: string) => {
      sent.push({ text, page, crid });
      return { threadId: "thread_desk", pending: false };
    }),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, ...view }) as DeskView,
  };
  const quickStatus = vi.fn(async () => ({ text: "Waiting on Sam: 2.", waiting: 2, stuck: 0, working: 1 }));
  const voice = createVoice({ db, mint, desk, quickStatus, now: () => clock.t, ...(o.relay ? { relay: o.relay } : {}) });
  return { db, voice, mint, sent, view, desk, quickStatus, clock, advance: (ms: number) => (clock.t += ms) };
}

const msg = (id: string, role: "user" | "assistant", text: string, status = "completed"): DeskMessage => ({ id, role, kind: "message", text, status });

describe("E942-S5 prices and the cost meter", () => {
  it("splits the API's usage into uncached, cached, text and audio tokens", () => {
    expect(tokensOfResponse(USAGE)).toEqual({ ...zeroTokens(), textIn: 324, textCachedIn: 576, audioIn: 336, audioCachedIn: 64, textOut: 100, audioOut: 400 });
    expect(tokensOfTranscription({ type: "tokens", input_tokens: 120, output_tokens: 15, input_token_details: { audio_tokens: 120 } })).toEqual({ ...zeroTokens(), trIn: 120, trOut: 15 });
  });

  it("prices mini at $10/M audio in, $20/M audio out, $0.60/$2.40 text, cached at its own rate", () => {
    const t = tokensOfResponse(USAGE);
    // 324*0.6 + 576*0.06 + 336*10 + 64*0.3 + 100*2.4 + 400*20 = 194.4 + 34.56 + 3360 + 19.2 + 240 + 8000 = 11848.16 per 1M
    expect(costOf("gpt-realtime-2.1-mini", t)).toBeCloseTo(0.011848, 6);
    expect(costOf("gpt-realtime-2.1-mini", { ...zeroTokens(), audioIn: 1_000_000 })).toBe(10);
    expect(costOf("gpt-realtime-2.1-mini", { ...zeroTokens(), audioOut: 1_000_000 })).toBe(20);
    // An unknown model is priced as the bigger one (the meter never reads low).
    expect(costOf("gpt-realtime-9", { ...zeroTokens(), audioOut: 1_000_000 })).toBe(64);
  });
});

describe("E942-S5 call key, caps and the off switch", () => {
  it("mints a 60-second key for the configured model with the two tools and transcription; the real key never leaves", async () => {
    const s = setup();
    const r = await s.voice.start();
    expect(r.clientSecret).toBe("ek_test_secret");
    expect(r.model).toBe("gpt-realtime-2.1-mini");
    const body = s.mint.mock.calls[0][0] as ReturnType<typeof sessionConfig>;
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 });
    expect(body.session.model).toBe("gpt-realtime-2.1-mini");
    expect(body.session.tools.map((t) => t.name)).toEqual(["quick_status", "ask_the_desk", "listen_for_feedback", "hang_up"]);
    expect(body.session.audio.input.transcription.model).toBe("gpt-4o-mini-transcribe");
    expect(body.session.instructions).toMatch(/Never say something is done/);
    expect(JSON.stringify(r)).not.toMatch(/sk-/);
    expect(r.limits).toEqual({ callMaxMin: 20, callWarnMin: 18, quietHangupS: 60, quietWarnS: 10, checkInS: 7, listenQuietS: 180, listenWarnS: 60, monthCapUsd: 25, historyTokens: 0 });
  });

  it("one call at a time; a call the page stopped beating for is closed as lost after 3 minutes", async () => {
    const s = setup();
    const a = await s.voice.start();
    await expect(s.voice.start()).rejects.toMatchObject({ code: "one_call" });
    s.advance(3 * 60_000 + 1);
    const b = await s.voice.start();
    expect(s.voice.get(a.call.id)).toMatchObject({ endReason: "lost" });
    expect(b.call.id).not.toBe(a.call.id);
  });

  it("the switch off refuses new calls and stops the live one at its next heartbeat; the model is one setting", async () => {
    const s = setup();
    const a = await s.voice.start();
    s.voice.setEnabled(false);
    expect(s.voice.beat(a.call.id).stop).toBe("voice_off");
    await s.voice.end(a.call.id, { reason: "voice_off" });
    await expect(s.voice.start()).rejects.toMatchObject({ code: "voice_off" });
    expect(s.voice.state()).toMatchObject({ available: false, enabled: false });
    s.voice.setEnabled(true);
    s.voice.setModel("gpt-realtime-2.1");
    expect((await s.voice.start()).model).toBe("gpt-realtime-2.1");
  });

  it("20 minutes per call: the heartbeat says stop at the limit", async () => {
    const s = setup();
    const a = await s.voice.start();
    for (let i = 0; i < 59; i++) {
      s.advance(20_000);
      expect(s.voice.beat(a.call.id).stop).toBeUndefined();
    }
    s.advance(20_000);
    expect(s.voice.beat(a.call.id).stop).toBe("call_limit");
  });

  it("the $25 month cap: stops the live call and refuses new ones until the 1st", async () => {
    const s = setup();
    const a = await s.voice.start();
    // 1.3M audio-out tokens on mini = $26.
    const r = s.voice.usage(a.call.id, { eventId: "resp_big", kind: "response", usage: { output_token_details: { audio_tokens: 1_300_000 }, input_token_details: {} } });
    expect(r.call.costUsd).toBe(26);
    expect(r.stop).toBe("month_cap");
    await s.voice.end(a.call.id, { reason: "month_cap" });
    await expect(s.voice.start()).rejects.toMatchObject({ code: "month_cap" });
    expect(s.voice.state().reason).toMatch(/paused until the 1st/);
    // Next month the meter starts again.
    s.clock.t = Date.parse("2026-12-01T00:00:01Z");
    expect((await s.voice.start()).call.costUsd).toBe(0);
  });

  it("each usage event counts once; the call row holds tokens by kind, $ and $/min", async () => {
    const s = setup();
    const a = await s.voice.start();
    s.voice.usage(a.call.id, { eventId: "resp_1", kind: "response", usage: USAGE });
    s.voice.usage(a.call.id, { eventId: "resp_1", kind: "response", usage: USAGE }); // retried: ignored
    s.voice.usage(a.call.id, { eventId: "tr-item_1-0", kind: "transcription", usage: { input_tokens: 1000, output_tokens: 100 } });
    s.advance(60_000);
    s.voice.beat(a.call.id);
    const c = s.voice.get(a.call.id)!;
    expect(c.responses).toBe(1);
    expect(c.tokens).toMatchObject({ audioIn: 336, audioOut: 400, trIn: 1000, trOut: 100 });
    expect(c.costUsd).toBeCloseTo(0.011848 + 0.00125 + 0.0005, 6);
    expect(c.seconds).toBe(60);
    expect(c.usdPerMin).toBeCloseTo(0.0136, 4);
    expect(s.voice.state()).toMatchObject({ monthCalls: 1, monthMinutes: 1 });
  });
});

describe("E942-S5 the two tools and the transcript", () => {
  it("quick status answers from the console, read-only", async () => {
    const s = setup();
    const a = await s.voice.start();
    expect((await s.voice.status(a.call.id)).text).toBe("Waiting on Sam: 2.");
    expect(
      quickStatusText({ waiting: [{ code: "E942-A1", title: "WhatsApp key", milestone: "home_repo" }], stuck: [], working: [{ milestone: "EPIC-942", what: "voice call" }] }).split("\n"),
    ).toEqual(["Waiting on Sam: 1.", "- E942-A1: WhatsApp key (home_repo)", "Stuck: 0.", "Working now: 1.", "- EPIC-942: voice call"]);
    expect(quickStatusText({ waiting: [{ title: "x".repeat(300) }], stuck: [], working: [] }).split("\n")[1]).toHaveLength(2 + 108);
  });

  it("ask the desk: a chat message marked as a call, then queued → working → answered", async () => {
    const s = setup();
    const a = await s.voice.start();
    const q = await s.voice.ask(a.call.id, "start the WhatsApp row", true);
    expect(q.askId).toBe(`${a.call.id}-q1`);
    expect(s.sent[0].page).toBe("voice call");
    expect(s.sent[0].crid).toBe(`voice-ask-${a.call.id}-q1`);
    expect(s.sent[0].text.startsWith(`${CALL_QUESTION_HEAD} (${a.call.id}-q1)`)).toBe(true);
    expect(s.sent[0].text).toMatch(/said yes to the read-back/);
    expect((await s.voice.askState(a.call.id, q.askId)).state).toBe("queued");
    s.view.messages = [msg("u1", "user", s.sent[0].text), msg("a1", "assistant", "On it…", "in_progress")];
    s.view.working = true;
    expect(await s.voice.askState(a.call.id, q.askId)).toMatchObject({ state: "working", partial: "On it…" });
    s.view.messages = [msg("u1", "user", s.sent[0].text), msg("a1", "assistant", "Started run_1 for the WhatsApp row.")];
    s.view.working = false;
    expect(await s.voice.askState(a.call.id, q.askId)).toMatchObject({ state: "answered", answer: "Started run_1 for the WhatsApp row." });
    // Remembered: a later read answers even when the thread moved on.
    s.view.messages = [];
    expect((await s.voice.askState(a.call.id, q.askId)).state).toBe("answered");
  });

  it("answerIn: the answer is the desk's last message after the question, once its turn is over", () => {
    const head = `${CALL_QUESTION_HEAD} (call_x-q2)`;
    const m = [msg("1", "user", "other"), msg("2", "assistant", "old"), msg("3", "user", `${head}\nSam…`), msg("4", "assistant", "checking"), msg("5", "assistant", "Done: answered E945-A1 yes.")];
    expect(answerIn({ messages: m, working: true }, head)).toMatchObject({ state: "working" });
    expect(answerIn({ messages: m, working: false }, head)).toEqual({ state: "answered", answer: "Done: answered E945-A1 yes." });
    // a later question steered into a running turn no longer makes a line between tool calls the answer
    expect(answerIn({ messages: [...m, msg("6", "user", "next")], working: true }, head).state).toBe("working");
  });

  it("the transcript lands in the desk chat once, marked as a call, with time, length and cost", async () => {
    const s = setup();
    const a = await s.voice.start();
    s.voice.usage(a.call.id, { eventId: "r1", kind: "response", usage: USAGE });
    s.advance(95_000);
    await s.voice.end(a.call.id, { reason: "hangup", transcript: [{ who: "owner", text: "What's waiting on me?" }, { who: "voice", text: "Two asks." }] });
    await s.voice.end(a.call.id, { reason: "tab_closed" }); // the beacon after the button: no second post
    expect(s.sent).toHaveLength(1);
    const t = s.sent[0].text.split("\n");
    expect(t[0]).toBe(`${CALL_TRANSCRIPT_HEAD} · 2026-11-01 18:00Z · 1 min 35 s · $0.012 (gpt-realtime-2.1-mini) · ${a.call.id}`);
    expect(t).toContain("Sam: What's waiting on me?");
    expect(t).toContain("Desk voice: Two asks.");
    expect(t[1]).toBe(`${callWholeNote()} Nothing reached a desk live during this call: no call question, no note passed on.`);
    expect(t[2]).toMatch(new RegExp(`/api/voice/calls/${a.call.id}/transcript$`));
    expect(t[3]).toBe("");
    expect(s.sent[0].crid).toBe(`voice-transcript-whole-${a.call.id}`);
    expect(s.voice.get(a.call.id)).toMatchObject({ endReason: "hangup", seconds: 95 });
    expect(s.voice.get(a.call.id)!.transcriptPostedAt).toBeTruthy();
  });

  it("a call that never connected (no credit) leaves no transcript in Chat", async () => {
    const s = setup();
    const a = await s.voice.start();
    await s.voice.end(a.call.id, { reason: "no_credit", transcript: [] });
    expect(s.sent).toHaveLength(0);
    expect(s.voice.get(a.call.id)).toMatchObject({ endReason: "no_credit", costUsd: 0 });
    expect(s.voice.state().lastCall).toMatchObject({ endReason: "no_credit" });
  });

  it("E942-S5 review: a call question carries Sam's own words; the transcript is marked a record and lists what the desk already had", async () => {
    const s = setup();
    const a = await s.voice.start();
    await s.voice.ask(a.call.id, "file a fix: the call screen scrolls as one page", true, "The call button should be at the bottom,  next to the chat box.");
    await s.voice.ask(a.call.id, "what are the priorities");
    const q1 = s.sent[0].text.split("\n");
    expect(q1[2]).toBe(`His words (call captions): "The call button should be at the bottom, next to the chat box."`);
    expect(s.sent[1].text.split("\n")).toHaveLength(2); // no words: no line
    s.view.messages = [msg("u1", "user", s.sent[0].text), msg("a1", "assistant", "Filed E942-S6.")];
    s.view.working = false;
    await s.voice.askState(a.call.id, `${a.call.id}-q1`);
    await s.voice.end(a.call.id, { reason: "hangup", transcript: [{ who: "owner", text: "File it." }, { who: "tool", text: `asked the desk (${a.call.id}-q1): file a fix` }] });
    const t = s.sent[2].text.split("\n");
    expect(t[0].startsWith(CALL_TRANSCRIPT_HEAD)).toBe(true);
    expect(t[1]).toBe(`${callWholeNote()} Relayed live as call questions: ${a.call.id}-q1 (answered), ${a.call.id}-q2 (still open).`);
    expect(t).toContain(`· asked the desk (${a.call.id}-q1): file a fix`);
    // Long speech: only its last part goes, so the question stays readable.
    const b = setup();
    const c = await b.voice.start();
    await b.voice.ask(c.call.id, "x", false, "y".repeat(5000));
    expect(b.sent[0].text.split("\n")[2]).toBe(`His words (call captions): "…${"y".repeat(ASK_WORDS_MAX)}"`);
  });

  it("the notes a call passed on live with its relay tool are listed in the whole-call post, so the desk files none twice", async () => {
    let n = 0;
    const s = setup({ relay: async (callId) => (++n === 1 ? { desk: "team", state: "sent", requestId: `strategy-${callId}-${n}`, result: "Passed." } : { desk: "social", state: "queued", requestId: `strategy-${callId}-${n}`, result: "Passed." }) });
    const a = await s.voice.start();
    await s.voice.relay(a.call.id, { words: 'Make the   desk see "every" call.', note: "his ask" });
    await s.voice.relay(a.call.id, { words: "Post the launch video at noon. " + "x".repeat(400) });
    await s.voice.end(a.call.id, { reason: "hangup", transcript: [{ who: "owner", text: "Make the desk see every call." }] });
    const t = s.sent.at(-1)!.text.split("\n");
    expect(t[1]).toBe(
      `${callWholeNote()} Passed on live by the call: note 1 to the Team desk (request strategy-${a.call.id}-1): "Make the desk see 'every' call." ; note 2 to the social desk (request strategy-${a.call.id}-2): "${("Post the launch video at noon. " + "x".repeat(400)).slice(0, RELAY_WORDS_MAX - 1)}…".`,
    );
    expect(relayedNotes(s.db, a.call.id)).toMatchObject([{ n: 1, desk: "team", state: "sent" }, { n: 2, desk: "social", state: "queued" }]);
    // a relay that fails records nothing
    const b = setup({ relay: async () => { throw new Error("words are required"); } });
    const c = await b.voice.start();
    await expect(b.voice.relay(c.call.id, {})).rejects.toThrow(/words are required/);
    expect(relayedNotes(b.db, c.call.id)).toEqual([]);
  });

  it("E942-S11: the voice greets in one short line; what it does it says when asked", () => {
    const ins = voiceInstructions();
    expect(ins).toContain(OPENING_LINE);
    expect(OPENING_LINE).toBe("Hi Sam, I'm the desk line. How can I help?");
    expect(OPENING_LINE.split(/[.?!]\s/).length).toBeLessThanOrEqual(2);
    expect(OPENING_LINE).not.toMatch(/stuck|waiting|pass/);
    expect(ins).toMatch(/Do not list what you can do unless he asks/);
    // call_3a1918ff: noise at the start cut the first line and the voice greeted twice.
    expect(ins).toMatch(/never greet him again or say that line again yourself, even if he talks over it or you hear only noise/);
    //'s honesty stays when asked; dropped the relay line said on every first hand-off.
    expect(ROLE_LINE).toMatch(/I pass to the desk, and I tell you its answer as soon as it lands/);
    expect(ins).toContain(ROLE_LINE);
    expect(ins).toMatch(/Do not ask permission you do not need/);
    // call_48453457: the voice said its rule aloud ("I'll say it once: 'The desk says …'").
    expect(ins).not.toMatch(/The desk says/);
    expect(ins).not.toMatch(/must (hand|pass) everything/i);
  });

  it("the desk's seed (v59) tells it how to answer call questions and to place every point of a whole call, never the ones relayed live", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(59);
    const line = endpointLines("https://team.example.com").find((l) => l.includes("Voice call"))!;
    expect(line).toMatch(/📞 Call question/);
    expect(line).toMatch(/His words \(call captions\)`.*his words win/);
    expect(line).toMatch(/Every word of this call`.*one request of his, its id the call id/);
    expect(line).toMatch(/never file those again/);
    expect(line).toMatch(/notes it lists as passed on live \(`Passed on live by the call: note <n>/);
    expect(line).toMatch(/Record only: already handled live`.*act on nothing in it and reply `Call noted\.`/);
  });
});

describe("E942-S5 /api/voice routes", () => {
  const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
  function app(world = "home") {
    const s = setup();
    const api = new Hono();
    mountVoice(api, s.voice, { world: () => world });
    return { ...s, api };
  }

  it("only Sam's page starts a call; a persona run or a token cannot", async () => {
    const s = app();
    expect((await s.api.request("/voice/calls", { method: "POST", headers: { ...page, "x-console-run": "team-desk" } })).status).toBe(403);
    expect((await s.api.request("/voice/calls", { method: "POST", headers: { ...page, authorization: "Bearer at_x" } })).status).toBe(403);
    expect((await s.api.request("/voice/calls", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const r = await s.api.request("/voice/calls", { method: "POST", headers: page });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { call: { id: string }; clientSecret: string };
    expect(j.clientSecret).toBe("ek_test_secret");
    const second = await s.api.request("/voice/calls", { method: "POST", headers: page });
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.code).toBe("one_call");
  });

  it("another world gets no button and no call", async () => {
    const s = app("social");
    expect(await (await s.api.request("/voice/state")).json()).toMatchObject({ available: false });
    expect((await s.api.request("/voice/calls", { method: "POST", headers: page })).status).toBe(403);
  });

  it("EPIC-956: the idle hang-up time is a voice setting (default 60 s, Sam's, 20..600 s) the page gets with the call key", async () => {
    const s = app();
    expect(((await (await s.api.request("/voice/state")).json()) as any).limits).toMatchObject({ quietHangupS: 60, quietWarnS: 10 });
    const agent = { "content-type": "application/json", "x-console-run": "agent" };
    expect((await s.api.request("/voice/settings", { method: "PUT", headers: agent, body: JSON.stringify({ quietHangupS: 300 }) })).status).toBe(403);
    expect((await s.api.request("/voice/settings", { method: "PUT", headers: page, body: JSON.stringify({ quietHangupS: 5 }) })).status).toBe(400);
    const r = await s.api.request("/voice/settings", { method: "PUT", headers: page, body: JSON.stringify({ quietHangupS: 90 }) });
    expect(((await r.json()) as any).limits.quietHangupS).toBe(90);
    const call = (await (await s.api.request("/voice/calls", { method: "POST", headers: page })).json()) as any;
    expect(call.limits).toMatchObject({ quietHangupS: 90, quietWarnS: 10 });
  });

  it("any caller may switch voice off; only Sam switches it back on", async () => {
    const s = app();
    const off = await s.api.request("/voice/settings", { method: "PUT", headers: { "content-type": "application/json", "x-console-run": "agent" }, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(s.voice.enabled()).toBe(false);
    const on = await s.api.request("/voice/settings", { method: "PUT", headers: { "content-type": "application/json", "x-console-run": "agent" }, body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(403);
    expect((await s.api.request("/voice/settings", { method: "PUT", headers: page, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
    expect(s.voice.enabled()).toBe(true);
  });

  it("usage, the beacon end (text/plain) and the calls list", async () => {
    const s = app();
    const { call } = (await (await s.api.request("/voice/calls", { method: "POST", headers: page })).json()) as { call: { id: string } };
    const u = await s.api.request(`/voice/calls/${call.id}/usage`, { method: "POST", headers: page, body: JSON.stringify({ eventId: "resp_1", kind: "response", usage: USAGE }) });
    expect(((await u.json()) as any).call.costUsd).toBeCloseTo(0.011848, 6);
    const end = await s.api.request(`/voice/calls/${call.id}/end`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ reason: "tab_closed", transcript: [] }) });
    expect(end.status).toBe(200);
    const list = (await (await s.api.request("/voice/calls")).json()) as any;
    expect(list.calls[0]).toMatchObject({ id: call.id, endReason: "tab_closed", tokens: { audioOut: 400 } });
  });

  it("E942-S5 review: the ask route passes Sam's own words on to the desk", async () => {
    const s = app();
    const { call } = (await (await s.api.request("/voice/calls", { method: "POST", headers: page })).json()) as { call: { id: string } };
    const r = await s.api.request(`/voice/calls/${call.id}/ask`, { method: "POST", headers: page, body: JSON.stringify({ request: "file it", confirmed: true, words: "Put the button at the bottom." }) });
    expect(r.status).toBe(202);
    expect(s.sent[0].text).toContain(`His words (call captions): "Put the button at the bottom."`);
  });
});

describe("EPIC-956 call cost guard: idle hang-up and hang up on request", () => {
  it("E56-2: a hang_up tool the voice calls after one goodbye, only when he closes the call, never on a phrase inside a request", () => {
    const tool = sessionConfig("gpt-realtime-2.1-mini").session.tools.find((t) => t.name === "hang_up");
    expect(tool?.description).toMatch(/Only when Sam clearly says he is done/);
    expect(tool?.description).toMatch(/goodbye/);
    const ins = voiceInstructions();
    expect(ins).toMatch(/'hang up', 'bye', 'goodbye', 'that's all'/);
    expect(ins).toMatch(/say one short goodbye \('Bye, Sam\.'\) and call hang_up in the same turn/);
    expect(ins).toMatch(/never on a phrase inside a request/);
    expect(ins).toMatch(/If unsure, ask 'Hang up\?'/);
  });

  it("E56-1: the idle warning's words live in the instructions", () => {
    expect(QUIET_WARN_LINE).toBe("Still there? I'll hang up in a few seconds.");
    expect(voiceInstructions()).toContain(`say exactly: "${QUIET_WARN_LINE}"`);
  });

  it("E56-1/2: a 'quiet' or 'bye' end keeps the reason, logs it, and saves the cost and the transcript as a normal hang-up", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const reason of ["quiet", "bye"]) {
      const s = setup();
      const { call } = await s.voice.start();
      s.voice.usage(call.id, { eventId: "resp_1", kind: "response", usage: USAGE });
      s.advance(61_000);
      const r = await s.voice.end(call.id, { reason, transcript: [{ who: "voice", text: "Bye, Sam." }] });
      expect(r.call).toMatchObject({ endReason: reason, seconds: 61 });
      expect(r.call.costUsd).toBeCloseTo(0.011848, 6);
      expect(r.call.transcriptPostedAt).toBeTruthy();
      expect(s.sent.at(-1)?.text).toMatch(/Desk voice: Bye, Sam\./);
      expect(log).toHaveBeenCalledWith(`[voice] ${call.id} ended: ${reason} after 61 s, $0.012`);
      cleanup?.();
    }
    cleanup = undefined;
    log.mockRestore();
  });
});

// a long call re-read its whole history every turn ($2.29 for 17 min); the voice now keeps a capped history.
describe("E942-S12 history cap", () => {
  const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
  function app() {
    const s = setup();
    const api = new Hono();
    mountVoice(api, s.voice, { world: () => "home" });
    return { ...s, api };
  }
  it("off by default (OpenAI did not apply it on 2026-11-02); when set, the key caps the history and drops the oldest 20%", async () => {
    const s = setup();
    await s.voice.start();
    expect((s.mint.mock.calls[0][0] as any).session.truncation).toBeUndefined();
    expect(s.voice.state().limits.historyTokens).toBe(0);
    s.voice.setHistoryTokens(8000);
    await s.voice.end((s.voice.state().activeCall as any).id, {});
    await s.voice.start();
    expect((s.mint.mock.calls[1][0] as any).session.truncation).toEqual({ type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 8000 } });
  });

  it("the cap is a setting: clamped to 2000..28000, and 0 sends no truncation (OpenAI's default)", async () => {
    const s = setup();
    s.voice.setHistoryTokens(500);
    expect(s.voice.state().limits.historyTokens).toBe(2000);
    s.voice.setHistoryTokens(99_000);
    expect(s.voice.state().limits.historyTokens).toBe(28000);
    s.voice.setHistoryTokens(0);
    await s.voice.start();
    expect((s.mint.mock.calls[0][0] as any).session.truncation).toBeUndefined();
    expect(sessionConfig("gpt-realtime-2.1-mini", "x", undefined, 4000).session.truncation?.token_limits.post_instructions).toBe(4000);
  });

  it("only Sam changes it (PUT /api/voice/settings {historyTokens})", async () => {
    const s = app();
    const agent = { "content-type": "application/json", "x-console-run": "agent" };
    expect((await s.api.request("/voice/settings", { method: "PUT", headers: agent, body: JSON.stringify({ historyTokens: 0 }) })).status).toBe(403);
    expect((await s.api.request("/voice/settings", { method: "PUT", headers: page, body: JSON.stringify({ historyTokens: -1 }) })).status).toBe(400);
    const r = await s.api.request("/voice/settings", { method: "PUT", headers: page, body: JSON.stringify({ historyTokens: 6000 }) });
    expect(((await r.json()) as any).limits.historyTokens).toBe(6000);
  });
});
