// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { capText, lengthText, MAX_PARTS, NoteEngine, PARTS_CAP_TEXT, warnText, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";

// The owner (2026-11-12): "the recorder says max 30 minutes; allow up to 2 hours, and never stop without
// telling him (a warning before any limit, the part so far always saved)". A synthetic 2-hour recording on fake time.

function fakes(o: { failPart?: number } = {}) {
  const clock = { t: 1_000_000, ticks: [] as (() => void)[] };
  const c: NoteClock = {
    now: () => clock.t,
    every: (_ms, fn) => {
      clock.ticks.push(fn);
      return () => (clock.ticks = clock.ticks.filter((f) => f !== fn));
    },
  };
  const recorders: RecorderLike[] = [];
  const track: any = { stop: vi.fn(), readyState: "live", muted: false, addEventListener: () => undefined };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const media: NoteMedia = {
    microphone: vi.fn(async () => stream),
    recorder: () => {
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        ondataavailable: null,
        onstop: null,
        start: () => undefined,
        stop: () =>
          queueMicrotask(() => {
            r.ondataavailable?.({ data: new Blob([`part${recorders.indexOf(r)}`], { type: "audio/webm" }) });
            r.onstop?.();
          }),
      };
      recorders.push(r);
      return r;
    },
    level: () => ({ read: () => 0.5, close: () => undefined }),
  };
  const api = {
    start: vi.fn(async () => ({ note: { id: "vn_2h" }, segmentS: 120, maxMin: 120, warnMin: 110, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number, _audio?: Blob, _seconds?: number) => {
      if (n === o.failPart) throw Object.assign(new Error("the segment was kept but not transcribed: OpenAI 500"), { status: 502, code: "transcribe_failed" });
      return { segment: { n, text: `t${n}`, costUsd: 0.006 }, note: { costUsd: 0.006 * (n + 1) } };
    }),
    finish: vi.fn(async (_id: string, segments: number, _page?: string, _skip?: number[]) => ({ note: { id: "vn_2h", state: "posted", seconds: 7200, costUsd: 0.36, segments } })),
    discard: vi.fn(async () => ({})),
  } satisfies NotesApi;
  const advance = async (s: number) => {
    for (let i = 0; i < s * 4; i++) {
      clock.t += 250;
      for (const f of [...clock.ticks]) f();
    }
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { clock: c, media, api, recorders, advance };
}

describe("long-note a 2-hour voice note", () => {
  it("says the length in words", () => {
    expect(lengthText(120)).toBe("2 hours");
    expect(lengthText(110)).toBe("1 h 50 min");
    expect(lengthText(30)).toBe("30 minutes");
    expect(MAX_PARTS).toBeGreaterThanOrEqual(180);
  });

  it("records 2 hours in two-minute parts, warns at 1 h 50 min, then stops, says so and sends everything", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start("long-note test");
    // 1 h 49 min: no warning, parts going up as he talks
    for (let m = 0; m < 109; m++) await f.advance(60);
    expect(e.view().phase).toBe("recording");
    expect(e.view().warn).toBeUndefined();
    expect(f.api.segment.mock.calls.length).toBeGreaterThanOrEqual(54);
    // 1 h 50 min: the warning shows, recording goes on
    await f.advance(61);
    expect(e.view().phase).toBe("recording");
    expect(e.view().warn).toBe(warnText(120, 10 - 1 / 60));
    expect(e.view().warn).toMatch(/^10 minutes left: at 2 hours this note stops and is sent by itself, everything you said kept\./);
    // 2 hours: it stops by itself, says why, and every part is in
    for (let m = 0; m < 10; m++) await f.advance(60);
    await f.advance(2);
    expect(e.view().phase).toBe("sent");
    expect(e.view().info).toBe(capText(120));
    expect(capText(120)).toBe("Stopped at the 2 hours limit and sent. Everything you said up to here is kept.");
    const parts = f.api.segment.mock.calls.map((c) => c[1]);
    expect(parts).toEqual([...Array(60).keys()]);
    const secs = f.api.segment.mock.calls.reduce((a, c) => a + (c[3] as number), 0);
    expect(secs).toBeCloseTo(7200, -1);
    expect(f.api.finish).toHaveBeenCalledTimes(1);
    expect(f.api.finish.mock.calls[0][1]).toBe(60);
  });

  it("a part the console keeps but cannot turn into words never holds the note back", async () => {
    const f = fakes({ failPart: 1 });
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start("long-note test");
    await f.advance(300);
    await e.finish();
    expect(e.view().phase).toBe("sent");
    // part 1 was sent as recorded (not skipped): the console names it in the note with its audio link
    expect(f.api.finish.mock.calls[0][1]).toBe(3);
    expect(f.api.finish.mock.calls[0][3]).toBeUndefined();
  });

  it("at the most parts a note takes, it is sent with a word, never cut silently", async () => {
    const f = fakes();
    f.api.start.mockResolvedValue({ note: { id: "vn_2h" }, segmentS: 1, maxMin: 120, warnMin: 110, usdPerMin: 0.003, monthUsd: 0, monthCapUsd: 25 });
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start("long-note test");
    for (let i = 0; i < MAX_PARTS + 5; i += 20) await f.advance(20);
    expect(e.view().phase).toBe("sent");
    expect(e.view().info).toBe(PARTS_CAP_TEXT);
    expect(f.api.finish.mock.calls[0][1]).toBeLessThanOrEqual(MAX_PARTS);
  });
});
