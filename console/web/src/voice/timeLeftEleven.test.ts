import { describe, expect, it, vi } from "vitest";

// on the ElevenLabs line (production's calls): the time left is said by the agent before the limit, never
// only on the screen, and never while the agent talks or right after his words. Its clock note never shows as his line.
const said: string[] = [];
let hooks: any;
vi.mock("./elevenSession", () => ({
  ELEVEN_ASK_WAIT_MS: 100_000,
  startEleven: async (h: any) => {
    hooks = h;
    return { end: async () => undefined, mute: () => undefined, id: () => "conv_1", say: (n: string) => said.push(n) };
  },
}));
import { CallEngine, type Media, type VoiceApi } from "./engine";

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
  return { engine, run, api };
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
    await f.run(60_000);
    await vi.waitFor(() => expect(f.engine.view().phase).toBe("ended"));
    expect(f.engine.view().endReason).toBe("call_limit");
  });
});
