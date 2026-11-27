import { describe, expect, it, vi } from "vitest";
import { CallEngine, MIC_LOST_LINE, MIC_LOST_NOTE, STILL_WITH_ME_LINE, type Limits, type Media, type VoiceApi } from "./engine";
import { catchMic } from "./elevenSession";

// His call of 27 Nov: with the phone screen off the microphone stopped and he ended up
// talking to himself. The voice now checks in within seconds when he goes quiet, says so at once when the phone stops the
// microphone, and the call bar shows the microphone's state.

class Track extends EventTarget {
  enabled = true;
  muted = false;
  readyState: "live" | "ended" = "live";
  kind = "audio";
  stop = vi.fn();
  fire(type: "mute" | "unmute" | "ended") {
    if (type === "mute") this.muted = true;
    if (type === "unmute") this.muted = false;
    if (type === "ended") this.readyState = "ended";
    this.dispatchEvent(new Event(type));
  }
}

function fakes(limits: Limits) {
  const sent: any[] = [];
  const dc: any = { readyState: "open", send: (s: string) => sent.push(JSON.parse(s)), close: vi.fn() };
  const sender = { track: undefined as any, replaceTrack: vi.fn(async (t: any) => void (sender.track = t)) };
  const pc: any = {
    addTrack: vi.fn((t: any) => void (sender.track = t)),
    getSenders: () => [sender],
    createDataChannel: () => dc,
    createOffer: async () => ({ type: "offer", sdp: "v=0" }),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    close: vi.fn(),
    connectionState: "connected",
  };
  const tracks: Track[] = [];
  const media: Media = {
    microphone: vi.fn(async () => {
      const t = new Track();
      tracks.push(t);
      return { getAudioTracks: () => [t], getTracks: () => [t] } as any;
    }),
    peer: () => pc,
    exchange: vi.fn(async () => "v=0 answer"),
    play: vi.fn(),
  };
  const call = { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null };
  const api = {
    start: vi.fn(async () => ({ call: { ...call, startedAt: "" }, clientSecret: "ek", expiresAt: 0, model: "m", limits })),
    beat: vi.fn(async () => ({ call, monthUsd: 0 })),
    usage: vi.fn(async () => ({ call, monthUsd: 0 })),
    end: vi.fn(async () => ({ call, monthUsd: 0 })),
    status: vi.fn(async () => ({ text: "" })),
    ask: vi.fn(async () => ({ askId: "q1" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 0 })),
  } satisfies VoiceApi;
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
    await emit({ type: "response.done", response: { id: "resp_open" } });
    sent.length = 0;
  };
  const said = () => sent.filter((e) => e.type === "response.create").map((e) => e.response?.instructions ?? "");
  return { engine, api, media, sent, tracks, sender, emit, open, run, said };
}

const LIMITS: Limits = { callMaxMin: 20, callWarnMin: 18, quietHangupS: 60, quietWarnS: 10, checkInS: 7, monthCapUsd: 25 };

describe("a call never leaves him talking to himself", () => {
  it("he goes quiet: the voice checks in once within 7 seconds, and again only after he has spoken", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.run(6_000);
    expect(f.said()).toEqual([]);
    await f.run(2_000);
    expect(f.said()).toEqual([`Say exactly "${STILL_WITH_ME_LINE}" and nothing else.`]);
    await f.emit({ type: "response.created" });
    await f.emit({ type: "response.done", response: { id: "r1" } });
    await f.run(15_000);
    expect(f.said()).toHaveLength(1); // once per silence
    await f.emit({ type: "input_audio_buffer.speech_started" });
    await f.emit({ type: "input_audio_buffer.speech_stopped" });
    f.sent.length = 0;
    await f.run(8_000);
    expect(f.said()).toEqual([`Say exactly "${STILL_WITH_ME_LINE}" and nothing else.`]);
  });

  it("the check-in also comes while the page is hidden (screen off), and the call still never hangs up on a locked phone", async () => {
    const f = fakes(LIMITS);
    await f.open();
    await f.engine.pageVisible(false);
    await f.run(8_000);
    expect(f.said()).toEqual([`Say exactly "${STILL_WITH_ME_LINE}" and nothing else.`]);
    await f.run(120_000);
    expect(f.engine.view().phase).toBe("live");
  });

  it("the phone stops the microphone: the bar shows it at once, the voice says it cannot hear him, and back in view the mic is taken again", async () => {
    const f = fakes(LIMITS);
    await f.open();
    expect(f.engine.view().mic).toBe("on");
    await f.engine.pageVisible(false);
    f.tracks[0].fire("mute");
    expect(f.engine.view().mic).toBe("lost");
    const notes = f.sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item.content[0].text);
    expect(notes).toEqual([MIC_LOST_NOTE]);
    expect(f.said()).toEqual([`Say exactly "${MIC_LOST_LINE}" and nothing else.`]);
    // hidden: the page cannot take it again yet
    expect(f.media.microphone).toHaveBeenCalledTimes(1);
    await f.engine.pageVisible(true);
    expect(f.media.microphone).toHaveBeenCalledTimes(2);
    expect(f.sender.replaceTrack).toHaveBeenCalledWith(f.tracks[1]);
    expect(f.engine.view().mic).toBe("on");
    expect(f.engine.view().lines.map((l) => l.text)).toEqual(expect.arrayContaining(["microphone stopped by the phone", "microphone back"]));
  });

  it("an older console sends no check-in time: no check-in (the 50 s warning stays as it was)", async () => {
    const f = fakes({ ...LIMITS, checkInS: undefined });
    await f.open();
    await f.run(30_000);
    expect(f.said()).toEqual([]);
  });

  it("the ElevenLabs client's own microphone streams reach the page, and getUserMedia is put back after", async () => {
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
    const orig = vi.fn(async () => stream);
    const nav = { mediaDevices: { getUserMedia: orig } };
    vi.stubGlobal("navigator", nav);
    const seen: MediaStream[] = [];
    const out = await catchMic(
      (s) => seen.push(s),
      async () => {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        return "ok";
      },
    );
    expect(out).toBe("ok");
    expect(seen).toEqual([stream]);
    expect(nav.mediaDevices.getUserMedia).toBe(orig);
    vi.unstubAllGlobals();
  });
});
