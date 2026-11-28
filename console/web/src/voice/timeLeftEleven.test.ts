import { describe, expect, it, vi } from "vitest";

// on the ElevenLabs line (production's calls): the time left is said by the agent before the limit, never
// only on the screen, and never while the agent talks or right after his words. Its clock note never shows as his line.
const said: string[] = [];
let hooks: any;
vi.mock("./elevenSession", () => ({
  ELEVEN_ASK_WAIT_MS: 100_000,
  startEleven: async (h: any) => {
    hooks = h;
    return { end: async () => undefined, mute: () => undefined, id: () => "conv_1", say: (n: string) => said.push(n), restartMic: async () => undefined, context: () => undefined };
  },
}));
import { CallEngine, LIMIT_GREETING, type Media, type VoiceApi } from "./engine";

function setup() {
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
  const track: any = { enabled: true, stop: vi.fn() };
  const media: Media = { microphone: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as any), peer: () => ({}) as any, exchange: vi.fn(), play: vi.fn() };
  const api = {
    start: vi.fn(async () => ({ call: { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null, startedAt: "" }, clientSecret: "", expiresAt: 0, model: "eleven", provider: "elevenlabs" as const, signedUrl: "wss://x", limits: { callMaxMin: 2, callWarnMin: 1, quietHangupS: 60, monthCapUsd: 25 } })),
    beat: vi.fn(async () => ({ call: { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null }, monthUsd: 0 })),
    usage: vi.fn(),
    end: vi.fn(async () => ({ call: { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null }, monthUsd: 0 })),
    status: vi.fn(),
    ask: vi.fn(),
    askState: vi.fn(),
    tool: vi.fn(),
  } as unknown as VoiceApi;
  const engine = new CallEngine(api, media, clock as any);
  return { engine, run, api: api as any };
}

describe("ElevenLabs call says its time left", () => {
  it("waits for the agent to stop talking, then has it say the time left once; the limit then ends the call", async () => {
    said.length = 0;
    const f = setup();
    await f.engine.start();
    hooks.onLive("conv_1");
    hooks.onMode(true);
    await f.run(61_000);
    expect(f.engine.view().warn).toBe("Heads up: about one minute left on this call. You can call again after.");
    expect(said).toEqual([]); // the agent is talking
    hooks.onMode(false);
    hooks.onLine("owner", "and one more thing");
    await f.run(1_000);
    expect(said).toEqual([]); // he just spoke
    await f.run(2_000);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\[call clock\].*say exactly "Heads up: about one minute left on this call\. You can call again after\."/);
    await f.run(10_000);
    expect(said).toHaveLength(1);
    expect(f.engine.view().lines.map((l) => l.text)).toContain("time left: one minute");
    // he is still talking at the limit, so the call goes on as a new call (see the cases below)
    await f.run(60_000);
    await vi.waitFor(() => expect(f.api.start).toHaveBeenCalledTimes(2));
    expect(f.api.end).toHaveBeenCalledWith("call_1", expect.objectContaining({ reason: "call_limit" }));
  });
});

// The owner: "the call got ... dropped again": a call was cut at exactly 20 minutes, mid-answer, by the line's own cap. A call he is talking on goes on as a new call just before the cap; a quiet one ends.
describe("the 20-minute cap: a call he is talking on goes on", () => {
  it("rolls over 15 s before the cap: the old call ends as call_limit, the new one opens with the limit line and says so", async () => {
    const f = setup();
    await f.engine.start();
    hooks.onLive("conv_1");
    await f.run(90_000);
    hooks.onLine("owner", "and the strategy is the arc");
    await f.run(14_000); // 104 s: not yet
    expect(f.api.start).toHaveBeenCalledTimes(1);
    await f.run(2_000); // 106 s: past 120 - 15
    await vi.waitFor(() => expect(f.api.start).toHaveBeenCalledTimes(2));
    expect(f.api.end).toHaveBeenCalledWith("call_1", expect.objectContaining({ reason: "call_limit" }));
    expect(f.api.end.mock.invocationCallOrder[0]).toBeLessThan(f.api.start.mock.invocationCallOrder[1]);
    expect(hooks.greeting).toBe(LIMIT_GREETING);
    expect(f.engine.view().notice).toMatch(/^The call reached 2 minutes at .+, so it went on as a new call\. Nothing was lost: the voice remembers the talk\.$/);
  });

  it("the agent's own cap closing the line as 'bye' near the limit is the limit, and goes on when he was talking", async () => {
    const f = setup();
    await f.engine.start();
    hooks.onLive("conv_1");
    await f.run(65_000);
    hooks.onLine("owner", "one more point");
    await f.run(1_000);
    hooks.onEnded("bye");
    await vi.waitFor(() => expect(f.api.start).toHaveBeenCalledTimes(2));
    expect(f.api.end).toHaveBeenCalledWith("call_1", expect.objectContaining({ reason: "call_limit" }));
  });

  it("a quiet call (no words from him for 3 minutes) still ends at the cap, after the time-left line", async () => {
    said.length = 0;
    const f = setup();
    await f.engine.start();
    hooks.onLive("conv_1");
    await f.run(125_000);
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("call_limit");
    expect(f.api.start).toHaveBeenCalledTimes(1);
    expect(said).toHaveLength(1);
  });

  it("a bye early in the call stays his bye", async () => {
    const f = setup();
    await f.engine.start();
    hooks.onLive("conv_1");
    hooks.onLine("owner", "bye");
    await f.run(5_000);
    hooks.onEnded("bye");
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("bye");
  });
});
