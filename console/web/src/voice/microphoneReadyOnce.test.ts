import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_ANSWER_TEXT, NoteEngine, START_GIVE_UP_MS, START_TRY_MS, type NoteClock, type NoteMedia, type NoteStartInfo, type NotesApi, type RecorderLike } from "./noteEngine";

/**
 * the recording starts as soon as
 * the microphone is open. Opening the note on the console, and the screen wake lock, run alongside and never hold it up.
 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const INFO: NoteStartInfo = { note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0, monthCapUsd: 25 };

function fakes() {
  const clock = { t: Date.UTC(2026, 10, 10, 0, 0, 0), ticks: [] as (() => void)[] };
  const c: NoteClock = {
    now: () => clock.t,
    every: (_ms, fn) => {
      clock.ticks.push(fn);
      return () => (clock.ticks = clock.ticks.filter((f) => f !== fn));
    },
  };
  const recorders: (RecorderLike & { started: boolean; stopped: boolean })[] = [];
  const tracks: any[] = [];
  const media: NoteMedia = {
    microphone: vi.fn(async () => {
      const track: any = { stop: vi.fn(), readyState: "live", muted: false, addEventListener: () => undefined };
      tracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track] } as any;
    }),
    recorder: () => {
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        started: false,
        stopped: false,
        ondataavailable: null,
        onstop: null,
        start: () => (r.started = true),
        stop: () => {
          r.stopped = true;
          queueMicrotask(() => {
            r.ondataavailable?.({ data: new Blob([`part${recorders.indexOf(r)}`], { type: "audio/webm" }) });
            r.onstop?.();
          });
        },
      };
      recorders.push(r);
      return r;
    },
    wakeLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  };
  const api = {
    start: vi.fn(async (_page?: string): Promise<NoteStartInfo> => INFO),
    segment: vi.fn(async (_id: string, n: number, _a?: Blob, _s?: number, _sm?: string) => ({ segment: { n, text: `t${n}`, costUsd: 0.001 }, note: { costUsd: 0.001 * (n + 1) } })),
    finish: vi.fn(async (_id: string, segments: number, _page?: string, _skip?: number[]) => ({ note: { id: "vn_1", state: "posted", seconds: 60, costUsd: 0.003, segments } })),
    discard: vi.fn(async (_id: string) => ({})),
  } satisfies NotesApi;
  const advance = async (s: number) => {
    for (let i = 0; i < s * 4; i++) {
      clock.t += 250;
      for (const f of [...clock.ticks]) f();
    }
    await flush();
  };
  return { clock, c, media, api, recorders, tracks, advance };
}
/** A promise and its resolve/reject, to hold the console's answer. */
function held<T>() {
  let ok!: (v: T) => void, no!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((ok = a), (no = b)));
  return { p, ok, no };
}

afterEach(() => void vi.useRealTimers());

describe("T42-S43 the microphone is ready at once", () => {
  it("records while the console has not answered yet; the part waits for the note and goes up with its id", async () => {
    const f = fakes();
    const h = held<NoteStartInfo>();
    f.api.start.mockReturnValueOnce(h.p);
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    expect(e.view().phase).toBe("recording");
    expect(f.recorders[0].started).toBe(true);
    await f.advance(5);
    expect(e.view().elapsedS).toBe(5);
    // Send before the console answers: the part is held, then uploaded and the note posted once the id comes.
    const sent = e.finish();
    await flush();
    expect(f.api.segment).not.toHaveBeenCalled();
    h.ok(INFO);
    await sent;
    expect(f.api.segment).toHaveBeenCalledWith("vn_1", 0, expect.any(Blob), 5, expect.any(String));
    expect(e.view().phase).toBe("sent");
  });

  it("a wake lock that never answers does not hold up the recording", async () => {
    const f = fakes();
    (f.media.wakeLock as any).mockReturnValueOnce(new Promise(() => undefined));
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    expect(e.view().phase).toBe("recording");
  });

  it("a try that does not answer is given up and tried again; the late note is thrown away", async () => {
    vi.useFakeTimers();
    const f = fakes();
    const stuck = held<NoteStartInfo>();
    f.api.start.mockReturnValueOnce(stuck.p).mockResolvedValueOnce({ ...INFO, note: { id: "vn_2" } });
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    expect(e.view().phase).toBe("recording");
    await vi.advanceTimersByTimeAsync(START_TRY_MS + 1000);
    expect(f.api.start).toHaveBeenCalledTimes(2);
    await f.advance(3);
    await e.finish();
    expect(f.api.finish).toHaveBeenCalledWith("vn_2", 1, undefined);
    // The first try lands after all: that note is closed on the console, never left open.
    stuck.ok(INFO);
    await flush();
    expect(f.api.discard).toHaveBeenCalledWith("vn_1");
  });

  it("a console that never answers: recording goes on, what is said is kept, Send opens the note again", async () => {
    vi.useFakeTimers();
    const f = fakes();
    f.api.start.mockImplementation(() => Promise.reject(Object.assign(new Error("console answered 502"), { status: 502 })));
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    expect(e.view().phase).toBe("recording");
    // The fake clock moves with the timers: give up after START_GIVE_UP_MS of tries.
    for (let i = 0; i < 40 && e.view().info !== NO_ANSWER_TEXT; i++) {
      f.clock.t += 2000;
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(e.view().info).toBe(NO_ANSWER_TEXT);
    expect(e.view().phase).toBe("recording");
    expect(f.clock.t - Date.UTC(2026, 10, 10)).toBeGreaterThanOrEqual(START_GIVE_UP_MS);
    // Send: the console fails again, so the note is kept here and says so.
    const p = e.finish();
    for (let i = 0; i < 40 && e.view().phase !== "failed"; i++) {
      f.clock.t += 2000;
      await vi.advanceTimersByTimeAsync(2000);
    }
    await p;
    expect(e.view().phase).toBe("failed");
    expect(e.view().error).toMatch(/kept here/);
    // The console is back: Send again uploads the kept part and posts it.
    f.api.start.mockReset().mockResolvedValue(INFO);
    await e.finish();
    expect(f.api.segment).toHaveBeenCalledWith("vn_1", 0, expect.any(Blob), expect.any(Number), expect.any(String));
    expect(e.view().phase).toBe("sent");
  });

  it("a refusal (voice off, the month's cap) stops the recording at once with the console's words, nothing kept", async () => {
    const f = fakes();
    const h = held<NoteStartInfo>();
    f.api.start.mockReturnValueOnce(h.p);
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    expect(e.view().phase).toBe("recording");
    h.no(Object.assign(new Error("Voice is paused until the 1st: this month reached its $25 cap. Type instead."), { status: 409 }));
    await flush();
    expect(e.view().phase).toBe("failed");
    expect(e.view().error).toMatch(/month reached its \$25 cap/);
    expect(f.tracks[0].stop).toHaveBeenCalled();
    expect(f.api.segment).not.toHaveBeenCalled();
    expect(f.api.start).toHaveBeenCalledTimes(1);
  });

  it("Cancel before the console answered throws the note away once it is open there", async () => {
    const f = fakes();
    const h = held<NoteStartInfo>();
    f.api.start.mockReturnValueOnce(h.p);
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    await f.advance(2);
    const gone = e.discard();
    h.ok(INFO);
    await gone;
    await flush();
    expect(e.view().phase).toBe("idle");
    expect(f.api.segment).not.toHaveBeenCalled();
    expect(f.api.discard).toHaveBeenCalledWith("vn_1");
  });

  it("the start's timings (press to note, microphone, recording) go with the first part", async () => {
    const f = fakes();
    const mic = held<any>();
    (f.media.microphone as any).mockImplementationOnce(() => mic.p);
    const e = new NoteEngine(f.api, f.media, f.c);
    const started = e.start();
    await flush();
    f.clock.t += 1200; // the microphone takes 1.2 s
    const track: any = { stop: vi.fn(), readyState: "live", muted: false, addEventListener: () => undefined };
    mic.ok({ getAudioTracks: () => [track], getTracks: () => [track] });
    await started;
    await f.advance(3);
    await e.finish();
    const sm = JSON.parse(f.api.segment.mock.calls[0][4] as string);
    expect(sm).toEqual({ tries: 1, note: 0, mic: 1200, rec: 1200 });
  });
});
