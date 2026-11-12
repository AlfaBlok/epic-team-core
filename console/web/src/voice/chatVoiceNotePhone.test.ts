import { describe, expect, it, vi } from "vitest";
import { INTERRUPTED_TEXT, memoryNoteStore, NoteEngine, RECOVERED_TEXT, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";

// locking the phone must not stop or lose a Chat voice note. Hidden: the part being recorded
// uploads at once. Back in view: a note the lock paused records on by itself. A page the phone threw away offers its note
// again (Resume or Send) from the browser's storage, and Send posts what is in, skipping the part that was lost.

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakes() {
  const clock = { t: Date.UTC(2026, 10, 7, 22, 0, 0), ticks: [] as (() => void)[] };
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
      const track: any = { stop: vi.fn(), readyState: "live", muted: false, listeners: {} as Record<string, () => void>, addEventListener: (e: string, f: () => void) => (track.listeners[e] = f) };
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
    start: vi.fn(async () => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number, _a?: Blob, _s?: number) => ({ segment: { n, text: `t${n}`, costUsd: 0.001 }, note: { costUsd: 0.001 * (n + 1) } })),
    finish: vi.fn(async (_id: string, segments: number, _page?: string, _skip?: number[]) => ({ note: { id: "vn_1", state: "posted", seconds: 60, costUsd: 0.003, segments } })),
    discard: vi.fn(async () => ({})),
    state: vi.fn(async (_id: string): Promise<string | undefined> => "recording"),
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

describe("T42-S35 a Chat voice note when the phone locks", () => {
  it("hidden: what was said so far uploads at once, and where the phone still records (Android) the note goes on", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    await f.advance(25);
    await e.pageVisible(false);
    await flush();
    expect(f.recorders).toHaveLength(2);
    expect(f.recorders[0].stopped && f.recorders[1].started).toBe(true);
    expect(f.api.segment.mock.calls.map((x) => x[1])).toEqual([0]);
    expect(f.api.segment.mock.calls[0][3]).toBeCloseTo(25, 0);
    expect(e.view().phase).toBe("recording");
    await f.advance(20); // still recording while locked
    await e.pageVisible(true);
    await e.finish();
    expect(f.api.finish).toHaveBeenCalledWith("vn_1", 2, undefined);
    expect(e.view().phase).toBe("sent");
  });

  it("an iPhone mutes the mic on lock: the note pauses with its words kept, and records on by itself on unlock", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    await f.advance(40);
    await e.pageVisible(false);
    f.tracks[0].listeners.mute();
    expect(e.view()).toMatchObject({ phase: "paused", info: INTERRUPTED_TEXT, elapsedS: 40 });
    f.clock.t += 3 * 60_000;
    await e.pageVisible(true);
    expect(f.media.microphone).toHaveBeenCalledTimes(2);
    expect(e.view().phase).toBe("recording");
    expect(e.view().info).toMatch(/^The phone locked at .+\. What you said before is kept, and recording picked up again\.$/);
    expect(f.media.wakeLock).toHaveBeenCalledTimes(2);
    await f.advance(10);
    expect(e.view().elapsedS).toBe(50); // the locked minutes are not counted
    await e.finish();
    // Part 1 (cut by the hide, then at once by the mute) had no audio: not uploaded, skipped on Send.
    expect(f.api.segment.mock.calls.map((x) => x[1]).sort()).toEqual([0, 2]);
    expect(f.api.finish).toHaveBeenCalledWith("vn_1", 3, undefined, [1]);
  });

  it("the mute arriving just after the page is back (a frozen page catching up) also records on by itself, once", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    await f.advance(10);
    await e.pageVisible(false);
    await e.pageVisible(true);
    f.tracks[1 - 1].listeners.mute();
    await flush();
    await flush();
    expect(e.view().phase).toBe("recording");
    // A microphone that keeps going mute leaves the note paused (no loop).
    f.clock.t += 5000;
    f.tracks[1].listeners.mute();
    await flush();
    expect(e.view().phase).toBe("paused");
    expect(f.media.microphone).toHaveBeenCalledTimes(2);
  });

  it("another app taking the mic with the page in view still waits for Resume", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    f.clock.t += 60_000;
    f.tracks[0].listeners.ended();
    await flush();
    expect(e.view().phase).toBe("paused");
    expect(f.media.microphone).toHaveBeenCalledTimes(1);
  });

  it("the phone threw the page away mid-note: the reloaded page offers it again, Resume records on, Send skips the lost part", async () => {
    const f = fakes();
    const store = memoryNoteStore();
    const e = new NoteEngine(f.api, f.media, f.c, store);
    await e.start("T42-S35");
    await f.advance(30);
    await e.pageVisible(false); // part 0 uploads; part 1 begins, then the page dies with it
    await flush();
    await f.advance(5);
    expect(store.get()).toMatchObject({ id: "vn_1", next: 2, done: [0], page: "T42-S35" });

    const g = fakes();
    const again = new NoteEngine(g.api, g.media, g.c, store);
    expect(await again.recover()).toBe(true);
    expect(g.api.state).toHaveBeenCalledWith("vn_1");
    expect(again.view()).toMatchObject({ phase: "paused", info: RECOVERED_TEXT, elapsedS: 30 });
    await again.resume();
    await g.advance(10);
    await again.finish();
    expect(g.api.segment.mock.calls.map((x) => [x[0], x[1]])).toEqual([["vn_1", 2]]);
    expect(g.api.finish).toHaveBeenCalledWith("vn_1", 3, "T42-S35", [1]);
    expect(store.get()).toBeUndefined();
  });

  it("a kept note the console already closed, or one a day old, is not offered", async () => {
    const f = fakes();
    const store = memoryNoteStore();
    store.set({ id: "vn_9", next: 1, done: [0], empty: [], closedS: 20, segmentS: 120, maxMin: 30, usdPerMin: 0.003, at: f.clock.t });
    f.api.state.mockResolvedValueOnce("posted");
    expect(await new NoteEngine(f.api, f.media, f.c, store).recover()).toBe(false);
    expect(store.get()).toBeUndefined();
    store.set({ id: "vn_8", next: 1, done: [0], empty: [], closedS: 20, segmentS: 120, maxMin: 30, usdPerMin: 0.003, at: f.clock.t - 25 * 3600_000 });
    expect(await new NoteEngine(f.api, f.media, f.c, store).recover()).toBe(false);
  });

  it("Discard forgets the kept note", async () => {
    const f = fakes();
    const store = memoryNoteStore();
    const e = new NoteEngine(f.api, f.media, f.c, store);
    await e.start();
    await vi.waitFor(() => expect(store.get()?.id).toBe("vn_1"));
    await e.discard();
    expect(store.get()).toBeUndefined();
  });
});
