import { describe, expect, it, vi } from "vitest";
import { CallEngine, RECONNECT_WINDOW_MS, RESUME_GREETING, greetingInstructions, type Limits, type Media, type VoiceApi } from "./engine";
import { CallTab } from "./CallProvider";
import { stickyWakeLock, type PageDoc } from "./keepAwake";

// a call dropped when the phone locked. The wake lock comes back after every unlock, the quiet
// timer does not count a locked phone as silence, a muted microphone is taken again on return, and a line that dropped while
// the phone was locked reconnects by itself (a new call that the desk's call memory makes continuous), saying what happened.

function fakeDoc() {
  const fns = new Set<() => void>();
  const d = {
    hidden: false,
    addEventListener: (_t: string, f: () => void) => void fns.add(f),
    removeEventListener: (_t: string, f: () => void) => void fns.delete(f),
    set(h: boolean) {
      d.hidden = h;
      for (const f of [...fns]) f();
    },
    count: () => fns.size,
  };
  return d satisfies PageDoc & Record<string, unknown>;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("T42-S34 the screen wake lock comes back", () => {
  it("is taken again each time the page is back in view, and not after release", async () => {
    const doc = fakeDoc();
    const sentinels: { release: ReturnType<typeof vi.fn> }[] = [];
    const request = vi.fn(async () => {
      const s = { release: vi.fn(async () => undefined) };
      sentinels.push(s);
      return s;
    });
    const lock = await stickyWakeLock(request, doc);
    expect(request).toHaveBeenCalledTimes(1);
    doc.set(true); // locked: the browser drops the lock; nothing to ask while hidden
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    doc.set(false); // unlocked: asked again
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    await lock!.release();
    expect(sentinels[1].release).toHaveBeenCalled();
    expect(doc.count()).toBe(0);
    doc.set(true);
    doc.set(false);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("no wake lock in this browser: nothing to hold, no error", async () => {
    expect(await stickyWakeLock(undefined, fakeDoc())).toBeUndefined();
  });
});

function fakes(limits: Limits = { callMaxMin: 20, callWarnMin: 18, quietHangupS: 60, quietWarnS: 10, monthCapUsd: 25 }) {
  const sent: any[] = [];
  const mk = () => {
    const dc: any = { readyState: "open", send: (s: string) => sent.push(JSON.parse(s)), close: vi.fn() };
    const sender: any = { track: undefined, replaceTrack: vi.fn(async (t: any) => (sender.track = t)) };
    const pc: any = {
      dc,
      sender,
      addTrack: vi.fn((t: any) => (sender.track = t)),
      getSenders: () => [sender],
      createDataChannel: () => dc,
      createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      close: vi.fn(),
      connectionState: "connected",
    };
    return pc;
  };
  const pcs: any[] = [];
  const mics: any[] = [];
  const media: Media = {
    microphone: vi.fn(async () => {
      const track: any = { kind: "audio", enabled: true, muted: false, readyState: "live", stop: vi.fn() };
      const mic = { track, getAudioTracks: () => [track], getTracks: () => [track] };
      mics.push(mic);
      return mic as any;
    }),
    peer: () => (pcs.push(mk()), pcs[pcs.length - 1]),
    exchange: vi.fn(async () => "v=0 answer"),
    play: vi.fn(),
    wakeLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
    session: vi.fn(() => vi.fn()),
  };
  let n = 0;
  const api = {
    start: vi.fn(async () => ({ call: { id: `call_${++n}`, costUsd: 0, seconds: 0, usdPerMin: null, startedAt: "" }, clientSecret: "ek", expiresAt: 0, model: "m", limits, greeting: "Hi Sam, the desk here." })),
    beat: vi.fn(async (id: string) => ({ call: { id, costUsd: 0, seconds: 0, usdPerMin: null }, monthUsd: 0 })),
    usage: vi.fn(async (id: string) => ({ call: { id, costUsd: 0, seconds: 0, usdPerMin: null }, monthUsd: 0 })),
    end: vi.fn(async (id: string) => ({ call: { id, costUsd: 0, seconds: 0, usdPerMin: null }, monthUsd: 0 })),
    status: vi.fn(async () => ({ text: "" })),
    ask: vi.fn(async () => ({ askId: "q" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 0 })),
  } satisfies VoiceApi;
  const timers: { fn: () => void; ms: number; next: number; on: boolean }[] = [];
  const clock = {
    t: Date.UTC(2026, 10, 7, 22, 0, 0),
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
      await flush();
    }
    clock.t = end;
  };
  const engine = new CallEngine(api, media, clock);
  const live = async () => {
    const pc = pcs[pcs.length - 1];
    pc.dc.onopen();
    pc.dc.onmessage({ data: JSON.stringify({ type: "response.done", response: { id: "greet" } }) });
    pc.dc.onmessage({ data: JSON.stringify({ type: "output_audio_buffer.stopped" }) });
    await flush();
  };
  return { engine, api, media, sent, pcs, mics, clock, run, live };
}

describe("T42-S34 a call when the phone locks", () => {
  it("holds the wake lock and the lock-screen controls for the call, and lets both go at hang-up", async () => {
    const f = fakes();
    await f.engine.start();
    await f.live();
    expect(f.media.wakeLock).toHaveBeenCalledTimes(1);
    expect(f.media.session).toHaveBeenCalledTimes(1);
    const undo = (f.media.session as any).mock.results[0].value;
    const lock = await (f.media.wakeLock as any).mock.results[0].value;
    // The lock screen's Hang up ends the call.
    (f.media.session as any).mock.calls[0][0].hangup();
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("hangup");
    expect(undo).toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it("a locked phone is not silence: the call stays on past the quiet limit, and on return the mic is taken again", async () => {
    const f = fakes();
    await f.engine.start();
    await f.live();
    await f.engine.pageVisible(false);
    f.mics[0].track.muted = true; // iOS mutes a hidden page's microphone
    await f.run(5 * 60_000); // five minutes locked, far past the 60 s quiet hang-up
    expect(f.engine.view().phase).toBe("live");
    await f.engine.pageVisible(true);
    expect(f.mics).toHaveLength(2);
    expect(f.pcs[0].sender.replaceTrack).toHaveBeenCalledWith(f.mics[1].track);
    expect(f.mics[0].track.stop).toHaveBeenCalled();
    expect(f.engine.view().notice).toBe("The phone was locked for 5:00. The call held; you are back on it.");
    // The quiet timer starts again from the return, not from before the lock.
    await f.run(30_000);
    expect(f.engine.view().phase).toBe("live");
    await f.run(60_000);
    expect(f.engine.view().phase).not.toBe("live");
  });

  it("the line dropped while locked: on return a new call reconnects by itself, opens with the resume line, and says so", async () => {
    const f = fakes();
    await f.engine.start();
    await f.live();
    await f.engine.pageVisible(false);
    f.pcs[0].connectionState = "failed";
    f.pcs[0].onconnectionstatechange();
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.api.end).toHaveBeenCalledWith("call_1", expect.objectContaining({ reason: "line_dropped" }));
    expect(f.api.start).toHaveBeenCalledTimes(1); // nothing while still locked
    f.clock.t += 2 * 60_000;
    await f.engine.pageVisible(true);
    expect(f.api.start).toHaveBeenCalledTimes(2);
    // The old call ended (with its transcript) before the new one started, so the console's call memory holds it.
    expect(f.api.end.mock.invocationCallOrder[0]).toBeLessThan(f.api.start.mock.invocationCallOrder[1]);
    expect(f.engine.view()).toMatchObject({ phase: "connecting", callId: "call_2" });
    expect(f.engine.view().notice).toMatch(/^The phone locked at \d?\d:\d\d( [AP]M)? and the line dropped\. Reconnected at \d?\d:\d\d( [AP]M)?; the desk remembers the call\.$/);
    f.sent.length = 0;
    f.pcs[1].dc.onopen();
    expect(f.sent).toContainEqual({ type: "response.create", response: { instructions: greetingInstructions(RESUME_GREETING), tool_choice: "none" } });
  });

  it("a page that was frozen while locked finds the dead line on return and reconnects", async () => {
    const f = fakes();
    await f.engine.start();
    await f.live();
    await f.engine.pageVisible(false);
    f.pcs[0].connectionState = "closed"; // no event reached the frozen page
    await f.engine.pageVisible(true);
    expect(f.api.end).toHaveBeenCalledWith("call_1", expect.objectContaining({ reason: "line_dropped" }));
    expect(f.engine.view()).toMatchObject({ phase: "connecting", callId: "call_2" });
  });

  it("locked too long: no reconnect, the screen says what happened and waits for Call", async () => {
    const f = fakes();
    await f.engine.start();
    await f.live();
    await f.engine.pageVisible(false);
    f.pcs[0].connectionState = "failed";
    f.pcs[0].onconnectionstatechange();
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    f.clock.t += RECONNECT_WINDOW_MS + 1000;
    await f.engine.pageVisible(true);
    expect(f.api.start).toHaveBeenCalledTimes(1);
    expect(f.engine.view().notice).toMatch(/did not reconnect: press Call to talk again\.$/);
  });

  it("his own hang-up, or a drop with the page in view, never reconnects by itself", async () => {
    const f = fakes();
    await f.engine.start();
    await f.live();
    await f.engine.hangup("hangup");
    await f.engine.pageVisible(false);
    await f.engine.pageVisible(true);
    expect(f.api.start).toHaveBeenCalledTimes(1);
    const g = fakes();
    await g.engine.start();
    await g.live();
    g.pcs[0].connectionState = "failed";
    g.pcs[0].onconnectionstatechange();
    await vi.waitFor(() => expect(g.engine.view().phase).toBe("ended"));
    await g.engine.pageVisible(false);
    await g.engine.pageVisible(true);
    expect(g.api.start).toHaveBeenCalledTimes(1);
  });

  it("the tab hands the page's visibility to every call it holds", async () => {
    const tab = new CallTab(undefined);
    const f = fakes();
    const h = tab.call("/api/voice", { api: f.api, media: () => f.media });
    const seen = vi.spyOn(h.engine, "pageVisible");
    tab.visibility(false);
    tab.visibility(true);
    expect(seen.mock.calls).toEqual([[false], [true]]);
  });
});
