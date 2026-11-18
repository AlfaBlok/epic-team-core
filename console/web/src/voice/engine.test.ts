import { describe, expect, it, vi } from "vitest";
import { BYE_MAX_MS, CallEngine, deskQuestionNote, deskReplyNote, needsHisAnswer, HANDOFF_NOTE, GREETING_MAX_MS, greetingInstructions, startsGreeting, FIXED_SLACK_WORDS, LISTEN_ACK_GAP_MS, LISTEN_ACK_WAIT_MS, LISTEN_ACKS, LISTEN_DONE, LISTEN_SEND_LINE, LISTEN_START_LINE, LISTEN_STILL_LINE, NORMAL_TURN, OPENING_NUDGE, QUIET_NUDGE, type Limits, type Media, type VoiceApi } from "./engine";

// the browser side of Call the desk: tools answered through the console, every usage forwarded to the
// cost meter, captions and transcript kept, and the hang-ups (button, quiet, 20 min, console stop).

function fakes(limits: Limits = { callMaxMin: 20, callWarnMin: 18, quietHangupS: 120, monthCapUsd: 25 }, greeting?: string) {
  const sent: any[] = [];
  const dc: any = { readyState: "open", send: (s: string) => sent.push(JSON.parse(s)), close: vi.fn() };
  const pc: any = {
    addTrack: vi.fn(),
    createDataChannel: () => dc,
    createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    close: vi.fn(),
    connectionState: "connected",
  };
  const track: any = { enabled: true, stop: vi.fn() };
  const mic: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const media: Media = { microphone: vi.fn(async () => mic), peer: () => pc, exchange: vi.fn(async () => "v=0 answer"), play: vi.fn() };
  let cost = 0;
  const api = {
    start: vi.fn(async () => ({ call: { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null, startedAt: "" }, clientSecret: "ek_1", expiresAt: 0, model: "gpt-realtime-2.1-mini", limits, ...(greeting ? { greeting, turnDetection: NORMAL_TURN } : {}) })),
    beat: vi.fn(async () => ({ call: { id: "call_1", costUsd: cost, seconds: 0, usdPerMin: null }, monthUsd: cost })),
    usage: vi.fn(async () => ((cost += 0.01), { call: { id: "call_1", costUsd: cost, seconds: 0, usdPerMin: null }, monthUsd: cost })),
    end: vi.fn(async () => ({ call: { id: "call_1", costUsd: cost, seconds: 0, usdPerMin: null }, monthUsd: cost })),
    status: vi.fn(async () => ({ text: "Waiting on Sam: 2." })),
    ask: vi.fn(async () => ({ askId: "call_1-q1" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 60_000 })),
    tool: vi.fn(async (_id: string, _name: string, _args: Record<string, unknown>) => ({ place: "card 2 of 5", pos: 2, total: 5, card: "A card waiting for Sam's review: The inbox loads fast." })),
  } satisfies VoiceApi;
  // A manual clock: `run(ms)` moves time and fires due intervals in order.
  const timers: { fn: () => void; ms: number; next: number; on: boolean }[] = [];
  const clock = {
    t: 0,
    now: () => clock.t,
    every: (fn: () => void, ms: number) => (timers.push({ fn, ms, next: clock.t + ms, on: true }), timers.length - 1) as any,
    stop: (i: any) => void (timers[i] && (timers[i].on = false)),
  };
  const run = async (ms: number) => {
    const end = clock.t + ms;
    for (;;) {
      const due = timers.filter((x) => x.on && x.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      clock.t = due.next;
      due.next += due.ms;
      due.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    clock.t = end;
  };
  const engine = new CallEngine(api, media, clock);
  const emit = async (ev: unknown) => {
    dc.onmessage({ data: JSON.stringify(ev) });
    await new Promise((r) => setTimeout(r, 0));
  };
  const open = async () => {
    await engine.start();
    dc.onopen();
    // The voice's first line runs as one response; the tests start after it.
    await emit({ type: "response.done", response: { id: "resp_open" } });
    sent.length = 0;
  };
  return { engine, api, media, sent, dc, pc, track, emit, open, run, clock };
}

describe("T42-S5 call engine", () => {
  it("opens the call with the console's 1-minute key: microphone first, SDP to OpenAI, live on the data channel", async () => {
    const f = fakes();
    await f.open();
    expect((f.media.microphone as any).mock.invocationCallOrder[0]).toBeLessThan(f.api.start.mock.invocationCallOrder[0]);
    expect(f.media.exchange).toHaveBeenCalledWith("v=0 offer", "ek_1", "gpt-realtime-2.1-mini");
    expect(f.pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
    expect(f.engine.view()).toMatchObject({ phase: "live", callId: "call_1" });
  });

  it("a refused microphone costs nothing: no key minted", async () => {
    const f = fakes();
    (f.media.microphone as any).mockRejectedValueOnce(new Error("Permission denied"));
    await f.engine.start();
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.engine.view()).toMatchObject({ phase: "failed", error: "Permission denied" });
  });

  it("OpenAI out of credit: a plain message, the call row ends as no_credit", async () => {
    const f = fakes();
    (f.media.exchange as any).mockRejectedValueOnce(new Error("OpenAI refused the call (429): credit_balance_exhausted: You have no credits remaining."));
    await f.engine.start();
    expect(f.engine.view()).toMatchObject({ phase: "failed" });
    expect(f.engine.view().error).toMatch(/no credit left.*nothing was charged/);
    expect(f.api.end).toHaveBeenCalledWith("call_1", { reason: "no_credit", transcript: [] });
    expect(f.pc.close).toHaveBeenCalled();
  });

  it("captions, transcript lines and every usage (responses and transcription) go to the meter", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "conversation.item.input_audio_transcription.delta", delta: "What's wait" });
    expect(f.engine.view().hearing).toBe("What's wait");
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", content_index: 0, transcript: "What's waiting on me?", usage: { input_tokens: 50, output_tokens: 6 } });
    await f.emit({ type: "response.output_audio_transcript.delta", delta: "Two" });
    expect(f.engine.view().speaking).toBe("Two");
    await f.emit({ type: "response.output_audio_transcript.done", transcript: "Two asks." });
    await f.emit({ type: "response.done", response: { id: "resp_1", usage: { input_tokens: 10 } } });
    expect(f.api.usage).toHaveBeenCalledWith("call_1", { eventId: "tr-item_1-0", kind: "transcription", usage: { input_tokens: 50, output_tokens: 6 } });
    expect(f.api.usage).toHaveBeenCalledWith("call_1", { eventId: "resp_1", kind: "response", usage: { input_tokens: 10 } });
    expect(f.engine.view().costUsd).toBeCloseTo(0.02);
    expect(f.engine.view().lines.map((l) => [l.who, l.text])).toEqual([
      ["owner", "What's waiting on me?"],
      ["voice", "Two asks."],
    ]);
  });

  it("quick status: answered through the console, then one response", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.created" });
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_1", name: "quick_status", arguments: "{}" });
    await f.emit({ type: "response.done", response: { id: "resp_1" } });
    expect(f.api.status).toHaveBeenCalledWith("call_1");
    expect(f.sent).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "fc_1", output: "Waiting on Sam: 2." } },
      { type: "response.create" },
    ]);
  });

  it("the inbox walk: next_card and read_card answered by the console with his place, then one response", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.created" });
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_9", name: "read_card", arguments: JSON.stringify({ number: 2 }) });
    await f.emit({ type: "response.done", response: { id: "resp_9" } });
    expect(f.api.tool).toHaveBeenCalledWith("call_1", "read_card", { number: 2 });
    expect(f.sent[0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "fc_9" } });
    expect(JSON.parse(f.sent[0].item.output)).toMatchObject({ place: "card 2 of 5" });
    expect(f.sent[1]).toEqual({ type: "response.create" });
    expect(f.engine.view().lines.some((l: { who: string; text: string }) => l.who === "tool" && l.text === "read card: card 2 of 5")).toBe(true);
  });

  it("a section call starts with its cards; press_card on his yes is pressed by the page, the result said back", async () => {
    const f = fakes();
    const press = vi.fn(async () => "done: marked complete");
    await f.engine.startFocused({ section: "Decisions waiting on you", cards: [{ kind: "review", id: "ri_1", title: "A card", buttons: ["Mark complete"] }], press });
    f.dc.onopen();
    await f.emit({ type: "response.done", response: { id: "resp_open" } });
    f.sent.length = 0;
    expect(f.api.start).toHaveBeenCalledWith({ section: "Decisions waiting on you", cards: [{ kind: "review", id: "ri_1", title: "A card", buttons: ["Mark complete"] }] });
    f.api.tool.mockImplementationOnce(async () => ({ place: "card 1 of 1", pos: 1, total: 1, press: { id: "ri_1", kind: "review", button: "Mark complete", title: "A card" } }) as any);
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_p", name: "press_card", arguments: JSON.stringify({ button: "Mark complete", confirmed: true }) });
    await f.emit({ type: "response.done", response: { id: "resp_p" } });
    expect(press).toHaveBeenCalledWith({ id: "ri_1", kind: "review", button: "Mark complete", title: "A card" });
    expect(JSON.parse(f.sent[0].item.output)).toMatchObject({ result: "done: marked complete" });
    expect(f.engine.view().lines.some((l: { who: string; text: string }) => l.who === "tool" && l.text === "pressed Mark complete on card 1 of 1: done: marked complete")).toBe(true);
  });

  it("ask the desk: sent at once, no spoken updates while it works (T42-S31), the answer said at once (T42-S33)", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_2", name: "ask_the_desk", arguments: JSON.stringify({ request: "start the WhatsApp row", confirmed: true }) });
    await f.emit({ type: "response.done", response: { id: "resp_2" } });
    expect(f.api.ask).toHaveBeenCalledWith("call_1", "start the WhatsApp row", true, "");
    expect(JSON.parse(f.sent[0].item.output)).toMatchObject({ askId: "call_1-q1", note: HANDOFF_NOTE });
    expect(f.engine.view().deskWaiting).toBe(1);
    f.sent.length = 0;
    await f.emit({ type: "response.done", response: { id: "resp_3" } }); // the voice's "Noted." turn ends
    await f.run(10_000);
    f.api.askState.mockImplementation(async () => ({ state: "working", waitedMs: 61_000, spokenWaitMs: 60_000 }));
    await f.run(30_000);
    // call_3a2e181c: "Still in progress." five times in a minute. Now nothing is said while the desk works.
    expect(f.sent).toEqual([]);
    f.api.askState.mockImplementation(async () => ({ state: "answered", answer: "Started run_9.", waitedMs: 70_000, spokenWaitMs: 60_000 }) as any);
    await f.run(2_500);
    // the answer is a turn of its own, said at once, not a silent note.
    expect(f.sent).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: deskReplyNote("start the WhatsApp row", "Started run_9.") }] } },
      { type: "response.create" },
    ]);
    expect(f.sent[0].item.content[0].text).toMatch(/Tell him now, warmly and simply.*the answer first/);
    expect(f.engine.view().deskWaiting).toBe(0);
    expect(f.engine.view().lines.map((l) => l.text)).toEqual(["asked the desk (call_1-q1): start the WhatsApp row", "desk answered (call_1-q1): Started run_9."]);
  });

  it("a nudge waits while Sam is talking", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "input_audio_buffer.speech_started" });
    await f.run(18 * 60_000); // the 18-minute warning comes due mid-sentence
    expect(f.sent.some((e) => e.item?.role === "system")).toBe(false);
    expect(f.engine.view().warn).toMatch(/2 minutes left/);
    await f.emit({ type: "input_audio_buffer.speech_stopped" });
    expect(f.sent.find((e) => e.item?.role === "system")?.item.content[0].text).toMatch(/two minutes left/);
  });

  it("hangs up after the quiet time (warning first) and hands the transcript to the console", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i", transcript: "Hello" });
    await f.run(109_000);
    expect(f.engine.view().phase).toBe("live");
    await f.run(2_000);
    await f.emit({ type: "response.done", response: { id: "resp_warn" } }); // the warning said
    await f.run(10_000);
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("quiet");
    expect(f.api.end).toHaveBeenCalledWith("call_1", { reason: "quiet", transcript: [expect.objectContaining({ who: "owner", text: "Hello" }), expect.objectContaining({ who: "tool", text: "quiet warning" })] });
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.pc.close).toHaveBeenCalled();
  });

  it("hangs up at 20 minutes, and when the console's heartbeat says stop (month cap, switch off)", async () => {
    const f = fakes();
    await f.open();
    // Keep talking so the quiet timer never fires.
    for (let i = 0; i < 20; i++) {
      await f.emit({ type: "input_audio_buffer.speech_stopped" });
      await f.run(60_000);
    }
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("call_limit");

    const g = fakes();
    await g.open();
    g.api.beat.mockImplementation(async () => ({ call: { id: "call_1", costUsd: 25, seconds: 0, usdPerMin: null }, monthUsd: 25, stop: "month_cap" }) as any);
    await g.run(20_000);
    await vi.waitFor(() => expect(g.engine.view().phase).toBe("ended"));
    expect(g.engine.view().endReason).toBe("month_cap");
  });

  it("mute switches the microphone track off and on", async () => {
    const f = fakes();
    await f.open();
    f.engine.setMuted(true);
    expect(f.track.enabled).toBe(false);
    f.engine.setMuted(false);
    expect(f.track.enabled).toBe(true);
  });

  it("T42-S7: the voice speaks first, with its first line, before Sam says anything", async () => {
    const f = fakes();
    await f.engine.start();
    f.dc.onopen();
    expect(f.sent).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: OPENING_NUDGE }] } },
      { type: "response.create", response: { tool_choice: "none" } },
    ]);
    // Nothing else is pushed on top of it: a nudge waits until the first line is over.
    f.sent.length = 0;
    await f.run(18 * 60_000);
    expect(f.sent.filter((e) => e.type === "response.create")).toHaveLength(0);
  });

  it("T42-S8: a slow check never reads the desk's answer twice (call_283d1c45 read one answer three times)", async () => {
    const f = fakes();
    await f.open();
    // The desk view can take seconds: checks still in flight when the next 2.5 s tick comes.
    const pending: ((v: any) => void)[] = [];
    f.api.askState.mockImplementation(() => new Promise((r) => pending.push(r)) as any);
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_1", name: "ask_the_desk", arguments: JSON.stringify({ request: "file the layout fix", confirmed: true }) });
    await f.emit({ type: "response.done", response: { id: "resp_1" } });
    await f.emit({ type: "response.done", response: { id: "resp_2" } });
    await f.run(7_500); // three ticks, one check
    expect(f.api.askState).toHaveBeenCalledTimes(1);
    for (const r of pending.splice(0)) r({ state: "answered", answer: "Filed T42-S6.", waitedMs: 8_000, spokenWaitMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    await f.run(10_000);
    // Even if a late check answered "answered" again, it is taken once.
    for (const r of pending.splice(0)) r({ state: "answered", answer: "Filed T42-S6.", waitedMs: 9_000, spokenWaitMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    const replies = f.sent.filter((e) => e.item?.role === "system" && /The desk replied/.test(e.item.content[0].text));
    expect(replies).toHaveLength(1);
    expect(f.engine.view().lines.filter((l) => l.text.startsWith("desk answered"))).toHaveLength(1);
    expect(f.engine.view().deskWaiting).toBe(0);
  });

  it("T42-S8: overlapping checks that all come back answered still read it once", async () => {
    const f = fakes();
    await f.open();
    const pending: ((v: any) => void)[] = [];
    let calls = 0;
    f.api.askState.mockImplementation(() => (calls++, new Promise((r) => pending.push(r))) as any);
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_1", name: "ask_the_desk", arguments: JSON.stringify({ request: "x" }) });
    await f.emit({ type: "response.done", response: { id: "resp_1" } });
    await f.emit({ type: "response.done", response: { id: "resp_2" } });
    await f.run(2_500);
    pending.shift()!({ state: "working", waitedMs: 2_500, spokenWaitMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    await f.run(7_500);
    for (const r of pending.splice(0)) r({ state: "answered", answer: "Yes.", waitedMs: 10_000, spokenWaitMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    await f.run(5_000);
    expect(f.sent.filter((e) => e.item?.role === "system" && /The desk replied/.test(e.item.content[0].text))).toHaveLength(1);
    expect(f.engine.view().lines.filter((l) => l.text.startsWith("desk answered"))).toHaveLength(1);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("T42-S5 review: Sam's own words since the last question go to the desk with it, and the transcript tags each question", async () => {
    const f = fakes();
    await f.open();
    const said = async (t: string, id: string) => f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: t });
    await said("The call button should be at the bottom.", "i1");
    await said("And the history in its own scroll panel.", "i2");
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_1", name: "ask_the_desk", arguments: JSON.stringify({ request: "file his layout feedback", confirmed: true }) });
    await f.emit({ type: "response.done", response: { id: "resp_1" } });
    expect(f.api.ask).toHaveBeenLastCalledWith("call_1", "file his layout feedback", true, "The call button should be at the bottom. And the history in its own scroll panel.");
    f.api.ask.mockImplementation(async () => ({ askId: "call_1-q2" }));
    await said("Also milestones in quick status.", "i3");
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_2", name: "ask_the_desk", arguments: JSON.stringify({ request: "add milestones to quick status" }) });
    await f.emit({ type: "response.done", response: { id: "resp_2" } });
    expect(f.api.ask).toHaveBeenLastCalledWith("call_1", "add milestones to quick status", false, "Also milestones in quick status.");
    expect(f.engine.view().lines.filter((l) => l.who === "tool").map((l) => l.text)).toEqual([
      "asked the desk (call_1-q1): file his layout feedback",
      "asked the desk (call_1-q2): add milestones to quick status",
    ]);
  });
});

// a forgotten call stops spending. Idle hang-up after a spoken warning; the voice hangs up
// when the owner says he is done, after one goodbye.
describe("PLAN-56 call cost guard", () => {
  const LIMITS: Limits = { callMaxMin: 20, callWarnMin: 18, quietHangupS: 60, quietWarnS: 10, monthCapUsd: 25 };
  const say = async (f: ReturnType<typeof fakes>, id: string, words: string, extra: unknown[] = []) => {
    await f.emit({ type: "response.created", response: { id } });
    await f.emit({ type: "output_audio_buffer.started" });
    await f.emit({ type: "response.output_audio_transcript.delta", delta: words });
    await f.emit({ type: "response.output_audio_transcript.done", transcript: words });
    for (const e of extra) await f.emit(e);
    await f.emit({ type: "response.done", response: { id, usage: { total_tokens: 1 } } });
  };

  it("E56-1: 60 s with nobody speaking: the voice warns at 50 s (its own words do not count), then the call ends 'quiet' with transcript and cost", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.run(49_000);
    expect(f.sent).toEqual([]);
    await f.run(1_000);
    expect(f.sent).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: QUIET_NUDGE }] } },
      { type: "response.create", response: { tool_choice: "none" } },
    ]);
    await say(f, "resp_warn", "Still there? I'll hang up in a few seconds.");
    await f.run(3_000);
    await f.emit({ type: "output_audio_buffer.stopped" });
    await f.run(5_000);
    expect(f.engine.view().phase).toBe("live"); // 58 s
    await f.run(2_000);
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("quiet");
    expect(f.api.end).toHaveBeenCalledWith("call_1", { reason: "quiet", transcript: expect.arrayContaining([expect.objectContaining({ who: "tool", text: "quiet warning" }), expect.objectContaining({ who: "voice", text: "Still there? I'll hang up in a few seconds." })]) });
    expect(f.api.usage).toHaveBeenCalledWith("call_1", expect.objectContaining({ eventId: "resp_warn", kind: "response" }));
  });

  it("E56-1: Sam speaking after the warning, or a desk answer arriving, keeps the call on", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.run(50_000);
    await say(f, "resp_warn", "Still there?");
    await f.emit({ type: "output_audio_buffer.stopped" });
    await f.run(3_000);
    await f.emit({ type: "input_audio_buffer.speech_started" });
    await f.emit({ type: "input_audio_buffer.speech_stopped" });
    await f.run(30_000);
    expect(f.engine.view().phase).toBe("live");

    const g = fakes(LIMITS);
    g.api.askState.mockImplementation(async () => ({ state: "working", waitedMs: 120_000, spokenWaitMs: 60_000 }) as any);
    await g.open();
    await g.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "ask_the_desk", arguments: JSON.stringify({ request: "what moved?" }) });
    await g.emit({ type: "response.done", response: { id: "r1" } });
    await g.emit({ type: "response.done", response: { id: "r2" } });
    await g.run(50_000); // nothing said while the desk works: the line goes quiet and is warned
    expect(g.sent.some((e) => e.item?.content?.[0]?.text === QUIET_NUDGE)).toBe(true);
    await g.emit({ type: "response.done", response: { id: "resp_warn" } });
    g.api.askState.mockImplementation(async () => ({ state: "answered", answer: "Two things.", waitedMs: 125_000, spokenWaitMs: 60_000 }) as any);
    await g.run(15_000);
    expect(g.engine.view().phase).toBe("live");
    expect(g.sent.some((e) => /The desk replied/.test(e.item?.content?.[0]?.text ?? ""))).toBe(true);
    // the reply is said at once, a turn of its own (it counts as activity, so the idle warning is called off).
    expect(g.sent.at(-1)).toEqual({ type: "response.create" });
  });

  it("E56-2: he says bye: one goodbye, then hang_up; the line closes when the goodbye has played, reason 'bye', no further turn", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i", transcript: "That's all, bye." });
    await say(f, "resp_bye", "Bye, Sam.", [{ type: "response.function_call_arguments.done", call_id: "c_bye", name: "hang_up", arguments: JSON.stringify({ said: "That's all, bye." }) }]);
    await f.run(2_000);
    expect(f.engine.view().phase).toBe("live"); // the goodbye is still playing
    await f.emit({ type: "output_audio_buffer.stopped" });
    await f.run(1_000);
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("bye");
    expect(f.sent).toEqual([]); // no tool output, no new response: nothing after the goodbye
    expect(f.api.ask).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledWith("call_1", {
      reason: "bye",
      transcript: [
        expect.objectContaining({ who: "owner", text: "That's all, bye." }),
        expect.objectContaining({ who: "voice", text: "Bye, Sam." }),
        expect.objectContaining({ who: "tool", text: "hang up (he said: That's all, bye.)" }),
      ],
    });
  });

  it("E56-2: hang_up with no goodbye said gets one goodbye turn first; a goodbye that never stops playing still ends the call", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.emit({ type: "response.created", response: { id: "r" } });
    await f.emit({ type: "response.function_call_arguments.done", call_id: "c_bye", name: "hang_up", arguments: "{}" });
    await f.emit({ type: "response.done", response: { id: "r" } });
    expect(f.sent[0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c_bye" } });
    expect(f.sent[1]).toEqual({ type: "response.create", response: { tool_choice: "none" } });
    await say(f, "resp_bye", "Bye.");
    await f.run(BYE_MAX_MS - 1_000);
    expect(f.engine.view().phase).toBe("live");
    await f.run(2_000);
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("bye");
  });
});

// listen mode. He says he wants to give feedback; the voice then only says "Noted, keep going",
// reads no desk answer, and on "done" all his words go to the desk as ONE message, whose reply it confirms in one line.
describe("PLAN-57 call listen mode", () => {
  const LIMITS: Limits = { callMaxMin: 20, callWarnMin: 18, quietHangupS: 60, quietWarnS: 10, monthCapUsd: 25 };
  /** an acknowledgement is out of band: no conversation in front of it, so nothing of his to answer. */
  const ack = (line: string) => ({ type: "response.create", response: { instructions: `Say exactly "${line}" and nothing else.`, tool_choice: "none", conversation: "none", input: [] } });
  /** One of his turns: VAD start/stop, then its transcription. */
  const talk = async (f: ReturnType<typeof fakes>, id: string, words: string) => {
    await f.emit({ type: "input_audio_buffer.speech_started", item_id: id });
    await f.emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
  };
  /** The voice's response (an ack, the start line) runs and ends. */
  const done = async (f: ReturnType<typeof fakes>, id: string) => {
    await f.emit({ type: "response.created", response: { id } });
    await f.emit({ type: "response.done", response: { id } });
  };
  const enter = async (f: ReturnType<typeof fakes>) => {
    // "I want to give feedback": the voice calls the tool; its transcription arrives only after listen mode is on.
    await f.emit({ type: "input_audio_buffer.speech_started", item_id: "i0" });
    await f.emit({ type: "input_audio_buffer.speech_stopped", item_id: "i0" });
    await f.emit({ type: "response.created", response: { id: "r_tool" } });
    await f.emit({ type: "response.function_call_arguments.done", call_id: "c_listen", name: "listen_for_feedback", arguments: "{}" });
    await f.emit({ type: "response.done", response: { id: "r_tool" } });
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i0", transcript: "I want to give feedback." });
  };

  it("E57-1: listen mode on: no automatic replies, a longer pause per turn, then only the start line", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await enter(f);
    expect(f.sent[0]).toEqual({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { ...NORMAL_TURN, silence_duration_ms: 1200, create_response: false, interrupt_response: true } } } } });
    expect(f.sent[1]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c_listen" } });
    expect(f.sent[2]).toEqual({ type: "response.create", response: { instructions: `Say exactly "${LISTEN_START_LINE}" and nothing else.`, tool_choice: "none" } });
    expect(f.sent).toHaveLength(3);
    expect(f.engine.view().listening).toBe(true);
  });

  it("E57-1/E57-2 + T42-S19: three sentences get a short acknowledgement or silence, no desk answer is read mid-flow, 'done' sends all three as ONE message, then a one-line 'Filed:'", async () => {
    const f = fakes(LIMITS);
    let answered = false;
    f.api.ask.mockImplementationOnce(async () => ({ askId: "call_1-q1" })).mockImplementationOnce(async () => ({ askId: "call_1-q2" }));
    (f.api.askState as any).mockImplementation(async (_c: string, askId: string) =>
      (askId === "call_1-q1" || answered ? { state: "answered", answer: askId === "call_1-q1" ? "Two things moved." : "Filed three points as row T57-S2 in PLAN-57.", waitedMs: 5_000, spokenWaitMs: 60_000 } : { state: "working", waitedMs: 1_000, spokenWaitMs: 60_000 }) as any,
    );
    await f.open();
    // A question from before listen mode, still open at the desk.
    await f.emit({ type: "response.function_call_arguments.done", call_id: "c_q", name: "ask_the_desk", arguments: JSON.stringify({ request: "what moved?" }) });
    await f.emit({ type: "response.done", response: { id: "r_q" } });
    await done(f, "r_q2");
    await enter(f);
    await done(f, "r_start");
    f.sent.length = 0;

    await talk(f, "i1", "The call button is too small on the phone.");
    expect(f.sent).toEqual([]); // not straight away: he may only be drawing breath
    await f.run(3_000);
    expect(f.sent).toEqual([ack(LISTEN_ACKS[0])]);
    await done(f, "r_ack1");
    await f.run(3_000); // the old question's answer comes in: held, not read
    await talk(f, "i2", "The transcript should show the cost per minute.");
    await f.run(3_000);
    expect(f.sent).toHaveLength(1); // under 15 s since the last one: the voice just waits
    await f.run(10_000);
    await talk(f, "i3", "And quick status should list stuck items first.");
    await f.run(3_000);
    await done(f, "r_ack2");
    expect(f.sent).toEqual([ack(LISTEN_ACKS[0]), ack(LISTEN_ACKS[1])]);
    expect(f.sent.some((e) => e.item?.role === "system")).toBe(false);
    expect(f.api.ask).toHaveBeenCalledTimes(1); // only the question from before

    await talk(f, "i4", "Done.");
    await vi.waitFor(() => expect(f.api.ask).toHaveBeenCalledTimes(2));
    expect(f.api.ask).toHaveBeenLastCalledWith(
      "call_1",
      "Sam's feedback from this call, all of it in one message: file it once.",
      true,
      "The call button is too small on the phone.\nThe transcript should show the cost per minute.\nAnd quick status should list stuck items first.",
      "feedback",
    );
    expect(f.engine.view().listening).toBe(false);
    expect(f.sent[2]).toEqual({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: NORMAL_TURN } } } });
    // The send line straight after (no system note before it: on call_ed357715 one made the voice ad-lib instead).
    expect(f.sent[3]).toEqual({ type: "response.create", response: { instructions: `Say exactly "${LISTEN_SEND_LINE}" and nothing else.`, tool_choice: "none" } });
    expect(f.sent).toHaveLength(4);
    const lines = f.engine.view().lines;
    expect(lines.filter((l) => l.feedback === "call_1-q2").map((l) => l.text)).toHaveLength(3);
    expect(lines.find((l) => l.text === "I want to give feedback.")?.feedback).toBeUndefined();
    expect(lines.find((l) => l.text === "Done.")?.feedback).toBeUndefined();
    await done(f, "r_send");
    // Now the old answer is read, then the desk files the feedback and the voice confirms it in one line.
    expect(f.sent.some((e) => /The desk replied to "what moved\?"/.test(e.item?.content?.[0]?.text ?? ""))).toBe(true);
    await done(f, "r_old");
    // While the desk files it: no "still processing" chatter (call_ed357715 had four).
    const before = f.sent.length;
    await f.run(30_000);
    expect(f.sent.length).toBe(before);
    answered = true;
    await f.run(3_000);
    const filed = f.sent.filter((e) => /The desk filed his feedback/.test(e.item?.content?.[0]?.text ?? ""));
    expect(filed).toHaveLength(1);
    expect(filed[0].item.content[0].text).toMatch(/Filed three points as row T57-S2[\s\S]*ONE short sentence what was filed, beginning "Filed:"/);
    await f.run(10_000);
    expect(f.api.ask).toHaveBeenCalledTimes(2); // filed once
  });

  it("E57-1: 'done' as the last sentence of a turn keeps the words before it; he already talking again gets no ack on top", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await enter(f);
    await done(f, "r_start");
    f.sent.length = 0;
    await f.emit({ type: "input_audio_buffer.speech_started", item_id: "i1" });
    await f.emit({ type: "input_audio_buffer.speech_stopped", item_id: "i1" });
    await f.emit({ type: "input_audio_buffer.speech_started", item_id: "i2" }); // he goes on before i1's words come
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "First point." });
    expect(f.sent).toEqual([]);
    await f.emit({ type: "input_audio_buffer.speech_stopped", item_id: "i2" });
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "Second point, that's the last one. Okay, I'm done." });
    await vi.waitFor(() => expect(f.api.ask).toHaveBeenCalledTimes(1));
    expect(f.api.ask).toHaveBeenCalledWith("call_1", expect.any(String), true, "First point.\nSecond point, that's the last one.", "feedback");
  });

  it("E57-1: the idle hang-up waits 3 minutes in listen mode, with one gentle check; the feedback still reaches the desk", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await enter(f);
    await done(f, "r_start");
    await talk(f, "i1", "One thing about the book page.");
    await f.run(3_000);
    await done(f, "r_ack");
    f.sent.length = 0;
    await f.run(107_000); // past the normal 60 s idle hang-up: still on, nothing said
    expect(f.engine.view().phase).toBe("live");
    expect(f.sent).toEqual([]);
    await f.run(10_000); // 120 s quiet: the gentle check, once
    expect(f.sent).toEqual([{ type: "response.create", response: { instructions: `Say exactly "${LISTEN_STILL_LINE}" and nothing else.`, tool_choice: "none" } }]);
    await done(f, "r_still");
    await f.run(50_000);
    expect(f.sent).toHaveLength(1);
    expect(f.engine.view().phase).toBe("live");
    await f.run(10_000); // 180 s
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("quiet");
    expect(f.api.ask).toHaveBeenCalledTimes(1);
    expect(f.api.ask).toHaveBeenCalledWith("call_1", expect.any(String), true, "One thing about the book page.", "feedback");
    const end = f.api.end.mock.calls[0] as any[];
    expect(end[1].transcript.find((l: any) => l.text === "One thing about the book page.").feedback).toBe("call_1-q1");
  });

  it("E57-1: Hang up in listen mode sends what he said once; he asking to expand gets more than the ack", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await enter(f);
    await done(f, "r_start");
    await talk(f, "i1", "The milestones list is too long.");
    await done(f, "r_ack");
    f.sent.length = 0;
    await talk(f, "i2", "Can you read that back?");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].response.instructions).toMatch(/listen mode.*read back his points/s);
    expect(f.sent[0].response.tool_choice).toBe("none");
    await done(f, "r_expand");
    await f.engine.hangup("hangup");
    expect(f.api.ask).toHaveBeenCalledTimes(1);
    expect(f.api.ask).toHaveBeenCalledWith("call_1", expect.any(String), true, "The milestones list is too long.", "feedback");
  });

  it("'done' is the whole turn or its last sentence, never a word inside his feedback", () => {
    for (const t of ["Done.", "done", "Okay, I'm done.", "That's it, I'm done, thanks.", "Finished.", "So, all done!", "Vale, he terminado.", "Second point. Done."]) expect(t).toMatch(LISTEN_DONE);
    for (const t of ["The deploy is done too slowly.", "I'm done with the layout but not the colors.", "It is finished", "Make sure it's done.", "Get it done"]) expect(t).not.toMatch(LISTEN_DONE);
  });
});

// call_7415c108 said "Hi the owner, I'm the desk line. How can I help?" twice at the start, both in the one opening
// response (two message items, 109 audio tokens). The greeting is now said once per call whatever the model or the line does.
describe("T42-S18 the greeting is said once per call", () => {
  const HI = "Hi Sam, I'm the desk line. How can I help?";
  const turnsSent = (sent: any[]) => sent.filter((e) => e.type === "session.update").map((e) => e.session.audio.input.turn_detection);
  const greetingFlow = async (f: ReturnType<typeof fakes>) => {
    await f.emit({ type: "response.created", response: { id: "resp_hi" } });
    await f.emit({ type: "output_audio_buffer.started", response_id: "resp_hi" });
    await f.emit({ type: "response.output_item.added", response_id: "resp_hi", item: { id: "item_hi", type: "message" } });
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_hi", item_id: "item_hi", delta: "Hi Sam, I'm the desk line." });
    await f.emit({ type: "response.output_audio_transcript.done", response_id: "resp_hi", item_id: "item_hi", transcript: HI });
  };

  it("the page says the console's greeting in one response of its own, with turn detection off until it has played", async () => {
    const f = fakes(undefined, HI);
    await f.engine.start();
    f.dc.onopen();
    expect(f.sent).toEqual([
      { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } },
      { type: "response.create", response: { instructions: greetingInstructions(HI), tool_choice: "none" } },
    ]);
    await greetingFlow(f);
    await f.emit({ type: "response.done", response: { id: "resp_hi", status: "completed" } });
    // Still playing: turn-taking stays off until the greeting has been heard.
    expect(turnsSent(f.sent)).toHaveLength(1);
    await f.emit({ type: "output_audio_buffer.stopped", response_id: "resp_hi" });
    // What the microphone picked up under the greeting is dropped, then turn-taking is back.
    expect(f.sent.slice(-2)).toEqual([{ type: "input_audio_buffer.clear" }, { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: NORMAL_TURN } } } }]);
    f.sent.length = 0;
    await f.run(30_000); // under the idle warning
    expect(f.sent.filter((e) => e.type === "response.create")).toHaveLength(0);
    expect(f.engine.view().lines.filter((l) => l.who === "voice").map((l) => l.text)).toEqual([HI]);
  });

  it("call_7415c108: a second greeting in the same response is cancelled at once and never shown", async () => {
    const f = fakes(undefined, HI);
    await f.engine.start();
    f.dc.onopen();
    await greetingFlow(f);
    f.sent.length = 0;
    await f.emit({ type: "response.output_item.added", response_id: "resp_hi", item: { id: "item_hi2", type: "message" } });
    // Cancelled, not cleared: the first greeting may still be playing.
    expect(f.sent).toEqual([{ type: "response.cancel" }]);
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_hi", item_id: "item_hi2", delta: "Hi Sam, I'm" });
    expect(f.engine.view().speaking).toBe("");
    await f.emit({ type: "response.output_audio_transcript.done", response_id: "resp_hi", item_id: "item_hi2", transcript: HI });
    await f.emit({ type: "response.done", response: { id: "resp_hi", status: "cancelled" } });
    await f.emit({ type: "error", error: { code: "response_cancel_not_active", message: "no active response" } });
    expect(f.engine.view().warn).toBeUndefined();
    await f.emit({ type: "output_audio_buffer.stopped", response_id: "resp_hi" });
    expect(f.engine.view().lines.filter((l) => l.who === "voice").map((l) => l.text)).toEqual([HI]);
    expect(f.sent.filter((e) => e.type === "response.create")).toHaveLength(0);
  });

  it("noise at the start cannot cut the greeting (call_e7c957e4: a speech start cleared it at 0.8 s) nor get a reply over it", async () => {
    const f = fakes(undefined, HI);
    await f.engine.start();
    f.dc.onopen();
    // No turn detection while it plays: the server sends no speech events, so nothing clears or answers over it.
    expect(turnsSent(f.sent)[0]).toBeNull();
    await greetingFlow(f);
    await f.emit({ type: "response.done", response: { id: "resp_hi", status: "completed" } });
    // A clear (from anywhere) is not the greeting's end: turn-taking stays off until its audio has played out.
    await f.emit({ type: "output_audio_buffer.cleared", response_id: "resp_hi" });
    expect(turnsSent(f.sent)).toEqual([null]);
    await f.emit({ type: "output_audio_buffer.stopped", response_id: "resp_hi" });
    expect(turnsSent(f.sent)).toEqual([null, NORMAL_TURN]);
    expect(f.sent.filter((e) => e.type === "response.create")).toHaveLength(1);
    expect(f.sent.filter((e) => e.type === "response.cancel")).toHaveLength(0);
  });

  it("a later reply that starts with the greeting (re-greeting after noise or being talked over) is cancelled and cleared", async () => {
    const f = fakes(undefined, HI);
    await f.engine.start();
    f.dc.onopen();
    await greetingFlow(f);
    await f.emit({ type: "response.done", response: { id: "resp_hi", status: "completed" } });
    await f.emit({ type: "output_audio_buffer.stopped", response_id: "resp_hi" });
    f.sent.length = 0;
    await f.emit({ type: "response.created", response: { id: "resp_2" } });
    await f.emit({ type: "response.output_item.added", response_id: "resp_2", item: { id: "item_2", type: "message" } });
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_2", item_id: "item_2", delta: "Hi Sam, " });
    expect(f.sent).toEqual([]);
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_2", item_id: "item_2", delta: "I'm the" });
    expect(f.sent).toEqual([{ type: "response.cancel" }, { type: "output_audio_buffer.clear" }]);
    await f.emit({ type: "response.output_audio_transcript.done", response_id: "resp_2", item_id: "item_2", transcript: "Hi Sam, I'm the" });
    await f.emit({ type: "response.done", response: { id: "resp_2", status: "cancelled" } });
    // A normal answer that happens to greet him is untouched.
    await f.emit({ type: "response.created", response: { id: "resp_3" } });
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "resp_3", item_id: "item_3", delta: "Hi Sam, the desk says it is filed." });
    await f.emit({ type: "response.output_audio_transcript.done", response_id: "resp_3", item_id: "item_3", transcript: "Hi Sam, the desk says it is filed." });
    expect(f.engine.view().lines.filter((l) => l.who === "voice").map((l) => l.text)).toEqual([HI, "Hi Sam, the desk says it is filed."]);
    expect(f.engine.view().lines.some((l) => l.who === "tool" && /second greeting stopped/.test(l.text))).toBe(true);
  });

  it("turn-taking comes back even if the greeting's end never arrives; listen mode still works after it", async () => {
    const f = fakes(undefined, HI);
    await f.engine.start();
    f.dc.onopen();
    await f.emit({ type: "response.created", response: { id: "resp_hi" } });
    await f.run(GREETING_MAX_MS + 1000);
    expect(turnsSent(f.sent).at(-1)).toEqual(NORMAL_TURN);
    await f.emit({ type: "response.done", response: { id: "resp_hi" } });
    f.sent.length = 0;
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_l", name: "listen_for_feedback", arguments: "{}" });
    await f.emit({ type: "response.done", response: { id: "resp_l" } });
    expect(f.engine.view().listening).toBe(true);
  });

  it("startsGreeting matches the greeting's first words only", () => {
    expect(startsGreeting("Hi Sam, I'm", HI)).toBe(true);
    expect(startsGreeting("hi sam im the desk line how can i help", HI)).toBe(true);
    expect(startsGreeting("Hi Sam", HI)).toBe(false);
    expect(startsGreeting("Hi Sam, the desk says", HI)).toBe(false);
    expect(startsGreeting("Hi, I'm the desk line.", "Hi, I'm the desk line. How can I help?")).toBe(true);
  });
});

// sixteen "Noted, keep going." in a row, and three times the voice answered his feedback as if he
// were done ("That's a great observation…") while he was still talking. Now: a few short acknowledgements in turn, only
// after a real pause and at most one per 15 s, said out of band (they see none of his words), and cut if they run on.
describe("T42-S19 listen mode: varied, sparing acknowledgements", () => {
  const LIMITS: Limits = { callMaxMin: 20, callWarnMin: 18, quietHangupS: 60, quietWarnS: 10, monthCapUsd: 25 };
  const talk = async (f: ReturnType<typeof fakes>, id: string, words: string) => {
    await f.emit({ type: "input_audio_buffer.speech_started", item_id: id });
    await f.emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
  };
  const listening = async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "c_l", name: "listen_for_feedback", arguments: "{}" });
    await f.emit({ type: "response.done", response: { id: "r_tool" } });
    await f.emit({ type: "response.created", response: { id: "r_start" } });
    await f.emit({ type: "response.done", response: { id: "r_start" } });
    f.sent.length = 0;
    return f;
  };
  const acks = (f: ReturnType<typeof fakes>) => f.sent.filter((e) => e.type === "response.create").map((e) => /Say exactly "(.*)"/.exec(e.response.instructions)?.[1]);

  it("rotates short acknowledgements, never the same twice running, at most one per 15 s, silence otherwise", async () => {
    const f = await listening();
    for (let i = 0; i < 8; i++) {
      await talk(f, `i${i}`, `Point number ${i + 1}.`);
      await f.run(LISTEN_ACK_WAIT_MS + 1000);
      const r = f.sent.at(-1);
      if (r?.type === "response.create" && !r.done) {
        r.done = true;
        await f.emit({ type: "response.created", response: { id: `r${i}` } });
        await f.emit({ type: "response.done", response: { id: `r${i}` } });
      }
      await f.run(5_000); // he pauses ~8 s between points
    }
    const said = acks(f);
    expect(said.length).toBeGreaterThanOrEqual(3);
    expect(said.length).toBeLessThan(8); // some pauses get silence
    for (const a of said) expect(LISTEN_ACKS).toContain(a);
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1]);
    expect(said).not.toContain("Noted, keep going.");
    for (const e of f.sent.filter((x) => x.type === "response.create")) expect(e.response).toMatchObject({ conversation: "none", input: [], tool_choice: "none" });
    // Nothing went to the desk while he talked.
    expect(f.api.ask).not.toHaveBeenCalled();
    expect(LISTEN_ACK_GAP_MS).toBe(15_000);
  });

  it("he goes on within the pause: no acknowledgement over him", async () => {
    const f = await listening();
    await talk(f, "i1", "First, the button.");
    await f.run(1_000);
    await f.emit({ type: "input_audio_buffer.speech_started", item_id: "i2" });
    await f.run(5_000);
    expect(acks(f)).toEqual([]);
    await f.emit({ type: "input_audio_buffer.speech_stopped", item_id: "i2" });
    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "And then the colours." });
    await f.run(3_000);
    expect(acks(f)).toEqual([LISTEN_ACKS[0]]);
  });

  it("an acknowledgement that runs on into an answer (call_3457e739) is cancelled, cleared and kept out of the transcript; only 'done' sends", async () => {
    const f = await listening();
    await talk(f, "i1", "Now the cost per second is a lot better.");
    await f.run(3_000);
    f.sent.length = 0;
    await f.emit({ type: "response.created", response: { id: "r_ack" } });
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "r_ack", item_id: "it_ack", delta: "That's great " });
    expect(f.sent).toEqual([]); // within the slack (the line's words + 3)
    await f.emit({ type: "response.output_audio_transcript.delta", response_id: "r_ack", item_id: "it_ack", delta: "to hear, cost per second improving is definitely a win!" });
    expect(f.sent).toEqual([{ type: "response.cancel" }, { type: "output_audio_buffer.clear" }]);
    await f.emit({ type: "response.output_audio_transcript.done", response_id: "r_ack", item_id: "it_ack", transcript: "That's great to hear, cost per second improving is definitely a win!" });
    await f.emit({ type: "response.done", response: { id: "r_ack", status: "cancelled" } });
    expect(f.engine.view().lines.some((l) => l.who === "voice" && /great to hear/.test(l.text))).toBe(false);
    expect(f.engine.view().listening).toBe(true);
    // A long pause is not "done": nothing goes to the desk until he says it.
    await f.run(100_000);
    expect(f.api.ask).not.toHaveBeenCalled();
    await talk(f, "i2", "Okay, I'm done.");
    await vi.waitFor(() => expect(f.api.ask).toHaveBeenCalledTimes(1));
    expect(f.api.ask).toHaveBeenCalledWith("call_1", expect.any(String), true, "Now the cost per second is a lot better.", "feedback");
    expect(FIXED_SLACK_WORDS).toBe(3);
  });
});

describe("T42-S31 listener, T42-S33 warm hand-off and answers said at once", () => {
  it("the voice already said its word: the hand-off gets no turn of its own, the talk goes on", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.created" });
    await f.emit({ type: "response.output_audio_transcript.delta", item_id: "v1", delta: "Noted." });
    await f.emit({ type: "response.output_audio_transcript.done", item_id: "v1", transcript: "Noted." });
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_q", name: "ask_the_desk", arguments: JSON.stringify({ request: "add a KPI section to Epic Social" }) });
    await f.emit({ type: "response.done", response: { id: "resp_q" } });
    expect(f.api.ask).toHaveBeenCalledWith("call_1", "add a KPI section to Epic Social", false, "");
    expect(f.sent.map((e) => e.type)).toEqual(["conversation.item.create"]); // the tool output only, no response.create
    expect(f.engine.view().lines.filter((l) => l.who === "voice").map((l) => l.text)).toEqual(["Noted."]);
  });

  it("he is still talking when the desk takes it: no turn now, he goes on", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_t", name: "ask_the_desk", arguments: JSON.stringify({ request: "posts per day timeline" }) });
    await f.emit({ type: "input_audio_buffer.speech_started" });
    await f.emit({ type: "response.done", response: { id: "resp_t" } });
    expect(f.sent.some((e) => e.type === "response.create")).toBe(false);
  });

  it("the voice said nothing and he is quiet: one short warm turn", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_n", name: "ask_the_desk", arguments: JSON.stringify({ request: "best post on X" }) });
    await f.emit({ type: "response.done", response: { id: "resp_n" } });
    expect(f.sent.map((e) => e.type)).toEqual(["conversation.item.create", "response.create"]);
    expect(HANDOFF_NOTE).toMatch(/one short warm line \('Sure, I'll get the desk on that\.'\)/);
    expect(HANDOFF_NOTE).toMatch(/if he asks, it's on its way: never 'I don't know'/);
  });

  it("a desk reply that needs his answer: its answer first, then its question", async () => {
    expect(needsHisAnswer("Noted: the best post on X and Reddit. Shall I file it all now?")).toBe(true);
    expect(needsHisAnswer("Want me to start it?")).toBe(true);
    expect(needsHisAnswer("Filed T46-S18. It shows on Epic Social.")).toBe(false);
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_y", name: "ask_the_desk", arguments: JSON.stringify({ request: "KPI view" }) });
    await f.emit({ type: "response.done", response: { id: "r1" } });
    await f.emit({ type: "response.done", response: { id: "r2" } });
    f.sent.length = 0;
    f.api.askState.mockImplementation(async () => ({ state: "answered", answer: "Got it. Shall I file it now?", waitedMs: 5_000, spokenWaitMs: 60_000 }) as any);
    await f.run(2_500);
    expect(f.sent[0].item.content[0].text).toBe(deskQuestionNote("KPI view", "Got it. Shall I file it now?"));
    expect(f.sent[0].item.content[0].text).toMatch(/the desk's answer in one or two short sentences, then its question/);
    expect(f.sent[1]).toEqual({ type: "response.create" });
  });
});

describe("T42-S33 (call_37f96758): a desk answer is spoken promptly, never withheld", () => {
  it("the answer lands while the line is quiet: a spoken turn goes out on the next check, not a silent note", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_p", name: "ask_the_desk", arguments: JSON.stringify({ request: "can you schedule a post on social" }) });
    await f.emit({ type: "response.done", response: { id: "r1" } });
    await f.emit({ type: "response.done", response: { id: "r2" } }); // "Sure, I'll get the desk on that." ends
    f.sent.length = 0;
    f.api.askState.mockImplementation(async () => ({ state: "answered", answer: "No, that world is closed to me. You can add it at social.example.com.", waitedMs: 5_000, spokenWaitMs: 60_000 }) as any);
    await f.run(2_500);
    expect(f.sent.map((e) => e.type)).toEqual(["conversation.item.create", "response.create"]);
    expect(f.sent[0].item.content[0].text).toContain("social.example.com");
    expect(f.sent[0].item.content[0].text).toMatch(/Tell him now/);
  });

  it("the answer lands while he talks: said at his next pause, not dropped", async () => {
    const f = fakes();
    await f.open();
    await f.emit({ type: "response.function_call_arguments.done", call_id: "fc_w", name: "ask_the_desk", arguments: JSON.stringify({ request: "link to the queue" }) });
    await f.emit({ type: "response.done", response: { id: "r1" } });
    await f.emit({ type: "response.done", response: { id: "r2" } });
    await f.emit({ type: "input_audio_buffer.speech_started" });
    f.sent.length = 0;
    f.api.askState.mockImplementation(async () => ({ state: "answered", answer: "Link: https://social.example.com", waitedMs: 5_000, spokenWaitMs: 60_000 }) as any);
    await f.run(2_500);
    expect(f.sent).toEqual([]); // he is mid-sentence: nobody is cut off
    await f.emit({ type: "input_audio_buffer.speech_stopped" });
    expect(f.sent.map((e) => e.type)).toEqual(["conversation.item.create", "response.create"]);
    expect(f.sent[0].item.content[0].text).toBe(deskReplyNote("link to the queue", "Link: https://social.example.com"));
  });

  it("while a question is with the desk the model is told it's on its way, never 'I don't know'", () => {
    expect(HANDOFF_NOTE).toMatch(/When its answer comes, you tell him at once/);
    expect(HANDOFF_NOTE).not.toMatch(/do not mention the desk/);
    expect(deskReplyNote("x", "y")).not.toMatch(/Do not read this out/);
  });
});
