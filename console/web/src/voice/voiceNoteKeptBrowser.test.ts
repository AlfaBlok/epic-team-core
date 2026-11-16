import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEPT_FAILED_TEXT, KEPT_TEXT, NoteEngine, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";
import { ABANDON_MS, backoffMs, drain, held, KEEP_SENT, memoryOutbox, outboxState, recount, RETRY_MAX_MS, setOutbox, settle, type DrainApi, type OutboxStore } from "./outbox";

// every part is
// kept in the browser's outbox until the console confirms it; a failure, a reload or a restart resends it with the same
// client id, and the console stores and posts it once.

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A console that can go down (a restart) and that, like the real one, opens one note per client id and posts it once. */
function fakeConsole() {
  const s = {
    down: false,
    /** The next finish is stored but its answer is lost (the restart cut the response). */
    loseNextFinishAnswer: false,
    notes: new Map<string, { id: string; cid?: string; parts: Map<number, string>; state: string }>(),
    posts: [] as { id: string; words: string }[],
    transcribed: 0,
    seq: 0,
  };
  const gone = () => Object.assign(new Error("fetch failed (the console is restarting)"), {});
  const open = (cid?: string) => {
    if (s.down) throw gone();
    const had = cid ? [...s.notes.values()].find((n) => n.cid === cid) : undefined;
    if (had) return had;
    const n = { id: `vn_${++s.seq}`, cid, parts: new Map<number, string>(), state: "recording" };
    s.notes.set(n.id, n);
    return n;
  };
  const segment = async (id: string, n: number, blob: Blob) => {
    if (s.down) throw gone();
    const note = s.notes.get(id)!;
    if (!note.parts.has(n)) {
      if (note.state !== "recording") throw Object.assign(new Error(`voice note ${id} is ${note.state}`), { status: 409 });
      note.parts.set(n, await blob.text());
      s.transcribed++;
    }
    return { segment: { n, text: note.parts.get(n)!, costUsd: 0.001 }, note: { costUsd: 0.001 } };
  };
  const finish = async (id: string, segments: number, skip: number[] = []) => {
    if (s.down) throw gone();
    const note = s.notes.get(id)!;
    if (note.state === "recording") {
      const missing = [...Array(segments).keys()].filter((i) => !skip.includes(i) && !note.parts.has(i));
      if (missing.length) throw Object.assign(new Error(`segments not in yet: ${missing.join(", ")}`), { status: 409 });
      note.state = "posted";
      s.posts.push({ id, words: [...note.parts.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(" ") });
    }
    if (s.loseNextFinishAnswer) {
      s.loseNextFinishAnswer = false;
      throw gone();
    }
    return { note: { id, state: note.state, seconds: 60, costUsd: 0.003, segments } };
  };
  const api: NotesApi = {
    start: vi.fn(async (_page?: string, cid?: string) => ({ note: { id: open(cid).id }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0, monthCapUsd: 25 })),
    segment: vi.fn(async (id: string, n: number, a: Blob) => segment(id, n, a)),
    finish: vi.fn(async (id: string, segments: number, _p?: string, skip?: number[]) => finish(id, segments, skip)),
    discard: vi.fn(async () => ({})),
    state: vi.fn(async (id: string) => s.notes.get(id)?.state),
  };
  const drainApi: DrainApi = {
    start: async (_b, cid) => ({ id: open(cid).id }),
    segment: (_b, id, n, blob) => segment(id, n, blob),
    finish: async (_b, id, segments, _p, skip) => (await finish(id, segments, skip)).note,
  };
  return { s, api, drainApi };
}

function fakes() {
  const clock = { t: Date.UTC(2026, 10, 11, 5, 0, 0), ticks: [] as (() => void)[] };
  const c: NoteClock = {
    now: () => clock.t,
    every: (_ms, fn) => {
      clock.ticks.push(fn);
      return () => (clock.ticks = clock.ticks.filter((f) => f !== fn));
    },
  };
  let k = 0;
  const media: NoteMedia = {
    microphone: async () => {
      const track: any = { stop: vi.fn(), readyState: "live", muted: false, addEventListener: () => undefined };
      return { getAudioTracks: () => [track], getTracks: () => [track] } as any;
    },
    recorder: () => {
      const n = k++;
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        ondataavailable: null,
        onstop: null,
        start: () => undefined,
        stop: () =>
          queueMicrotask(() => {
            r.ondataavailable?.({ data: new Blob([`words${n}`], { type: "audio/webm" }) });
            r.onstop?.();
          }),
      };
      return r as RecorderLike;
    },
  };
  const advance = async (s: number) => {
    for (let i = 0; i < s * 4; i++) {
      clock.t += 250;
      for (const f of [...clock.ticks]) f();
    }
    await flush();
  };
  return { clock, c, media, advance };
}

let box: OutboxStore;
beforeEach(() => {
  box = memoryOutbox();
  setOutbox(box);
  held.clear();
});

const engineOn = (api: NotesApi, f: ReturnType<typeof fakes>) => new NoteEngine(api, f.media, f.c, undefined, { store: box, base: "/api/voice", to: "Chat" });

describe("T42-S51 a voice note is kept in the browser until the console confirms it", () => {
  it("each part is in the outbox before it is sent, and leaves it once the console has it; a sent note leaves no trace", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start("on /");
    const cid = e.clientId()!;
    expect(k.api.start).toHaveBeenCalledWith("on /", cid);
    expect(held.has(cid)).toBe(true);
    await f.advance(121); // part 0 closes and uploads
    expect((await box.getNote(cid))?.done).toEqual([0]);
    // its audio stays on the device until the whole note is confirmed.
    expect((await box.parts(cid)).map((p) => p.n)).toEqual([0]);
    const seen: (string | undefined)[] = [];
    e.subscribe((v) => v.phase === "sending" && seen.push(v.info));
    await e.finish();
    expect(seen[0]).toBe(KEPT_TEXT);
    await flush();
    expect(e.view().phase).toBe("sent");
    expect(k.s.posts).toHaveLength(1);
    expect(await box.notes()).toEqual([]);
    expect(held.has(cid)).toBe(false);
    // once confirmed it is one of the last few kept on the device, its audio whole.
    const kept = await box.sent();
    expect(kept.map((r) => r.cid)).toEqual([cid]);
    expect(await Promise.all(kept[0].parts.map((p) => p.blob.text()))).toEqual(["words0", "words1"]);
    expect(kept[0].to).toBe("Chat");
  });

  it("the console restarts mid-upload: the note says it is saved here, Close never throws it away, and it arrives once when the console is back", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start();
    const cid = e.clientId()!;
    await f.advance(30);
    k.s.down = true; // the restart, while the last part goes up
    await e.finish();
    await flush();
    expect(e.view().phase).toBe("failed");
    expect(e.view().info).toBe(KEPT_FAILED_TEXT);
    const parts = await box.parts(cid);
    expect(parts.map((p) => p.n)).toEqual([0]);
    expect(await parts[0].blob.text()).toBe("words0");
    e.dismiss(); // he closes the failed line: kept, not thrown away
    await flush();
    expect(k.api.discard).not.toHaveBeenCalled();
    expect((await box.getNote(cid))?.send).toBe(true);
    expect(await recount()).toBe(1);
    expect(outboxState().waiting).toBe(1);
    // Still down: drain keeps it.
    expect(await drain(k.drainApi)).toBe(0);
    expect(await box.parts(cid)).toHaveLength(1);
    // Back: it arrives, once (back online tries at once, whatever the wait).
    k.s.down = false;
    expect(await drain(k.drainApi, box, Date.now, { force: true })).toBe(1);
    expect(k.s.posts).toEqual([{ id: "vn_1", words: "words0" }]);
    expect(await box.notes()).toEqual([]);
    expect(outboxState().waiting).toBe(0);
    expect(await drain(k.drainApi)).toBe(0);
    expect(k.s.posts).toHaveLength(1);
    expect(k.s.transcribed).toBe(1);
  });

  it("a reload mid-note: the parts kept in the browser are sent on the next load, with the same client id, into the same note", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start("card T1-S1: a card");
    const cid = e.clientId()!;
    await f.advance(125); // part 0 in
    k.s.down = true;
    await e.pageVisible(false); // phone hides the page: part 1 closes, its upload fails (restart)
    await flush();
    expect((await box.parts(cid)).map((p) => p.n)).toEqual([0, 1]);
    // The page is thrown away: a new load has no engine holding the note.
    held.clear();
    k.s.down = false;
    // Too fresh: another tab may still be recording it.
    expect(await drain(k.drainApi, box, () => f.clock.t + 1000)).toBe(0);
    expect(await drain(k.drainApi, box, () => f.clock.t + ABANDON_MS + 1)).toBe(1);
    expect(k.s.notes.size).toBe(1); // the same note, never a second one
    expect(k.s.posts).toEqual([{ id: "vn_1", words: "words0 words1" }]);
    expect(await box.notes()).toEqual([]);
  });

  it("the console posted it but its answer was lost in a restart: the resend gets the posted note back, never a second post", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start();
    await f.advance(20);
    k.s.loseNextFinishAnswer = true;
    await e.finish();
    await flush();
    expect(e.view().phase).toBe("failed");
    e.dismiss();
    await flush();
    expect(await drain(k.drainApi)).toBe(1);
    expect(k.s.posts).toHaveLength(1);
    expect(k.s.transcribed).toBe(1);
    expect(await box.notes()).toEqual([]);
  });

  it("Cancel throws it away here too: nothing is kept or sent", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start();
    await f.advance(10);
    await e.discard();
    await flush();
    expect(await box.notes()).toEqual([]);
    expect(await drain(k.drainApi, box, () => f.clock.t + ABANDON_MS * 10)).toBe(0);
    expect(k.s.posts).toEqual([]);
  });

  it("a note that no tab holds is left alone while its recording tab still beats", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start();
    const cid = e.clientId()!;
    held.delete(cid); // seen from another tab
    await f.advance(200);
    expect(await drain(k.drainApi, box, () => f.clock.t + 1000)).toBe(0);
    expect(k.s.posts).toEqual([]);
    await e.finish();
    expect(k.s.posts).toHaveLength(1);
  });
});

describe("T42-S113 a voice note is never lost: kept until confirmed, retried for days, the last 5 kept after", () => {
  it("a waiting note backs off after each failed try (20 s doubling to 30 min) and never gives up", async () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([20_000, 40_000, 80_000, 160_000]);
    expect(backoffMs(30)).toBe(RETRY_MAX_MS);
    const k = fakeConsole();
    k.s.down = true;
    let t = Date.UTC(2026, 10, 16, 8, 0, 0);
    const now = () => t;
    await box.putNote({ cid: "c1", base: "/api/voice", parts: 1, done: [], send: true, at: t, startedAt: t, seconds: 5 });
    await box.putPart({ cid: "c1", n: 0, blob: new Blob(["hello"]), seconds: 5 });
    // three days of a dead connection: it tries less and less often, and is still there.
    let tries = 0;
    for (const end = t + 3 * 24 * 3600_000; t < end; t += 60_000) {
      const before = (await box.getNote("c1"))?.tries ?? 0;
      await drain(k.drainApi, box, now);
      if (((await box.getNote("c1"))?.tries ?? 0) > before) tries++;
    }
    expect(tries).toBeGreaterThan(140); // about every 30 min at the most
    expect(tries).toBeLessThan(160);
    expect((await box.getNote("c1"))?.nextAt).toBeGreaterThan(t);
    expect(outboxState().nextAt).toBeGreaterThan(Date.now() - 1);
    // the connection is back: Send now (or the browser's online event) sends it at once.
    k.s.down = false;
    expect(await drain(k.drainApi, box, now)).toBe(0); // still waiting its turn…
    expect(await drain(k.drainApi, box, now, { force: true })).toBe(1); // …but forced it goes
    expect(k.s.posts).toEqual([{ id: "vn_1", words: "hello" }]);
    expect(await box.notes()).toEqual([]);
  });

  it("the last 5 sent recordings stay on the device, older ones leave", async () => {
    for (let i = 0; i < 7; i++) {
      await box.putNote({ cid: `n${i}`, base: "/api/voice", parts: 1, done: [0], at: i, startedAt: i, seconds: 3, to: "Chat" });
      await box.putPart({ cid: `n${i}`, n: 0, blob: new Blob([`note ${i}`]), seconds: 3 });
      await settle(box, `n${i}`, true, 1000 + i);
    }
    const kept = await box.sent();
    expect(kept).toHaveLength(KEEP_SENT);
    expect(kept.map((r) => r.cid)).toEqual(["n6", "n5", "n4", "n3", "n2"]);
    expect(await box.notes()).toEqual([]);
    expect(await box.parts("n6")).toEqual([]);
  });

  it("the part being recorded is saved on the device every few seconds, so a closed tab loses almost nothing", async () => {
    const f = fakes();
    // a recorder that hands its audio over every second, like the browser's (start(1000)).
    const recs: any[] = [];
    f.media.recorder = () => {
      const r: any = { mimeType: "audio/webm", ondataavailable: null, onstop: null, start: () => undefined, stop: () => queueMicrotask(() => r.onstop?.()) };
      recs.push(r);
      return r;
    };
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start();
    const cid = e.clientId()!;
    for (let s = 0; s < 10; s++) {
      await f.advance(1);
      recs[0].ondataavailable({ data: new Blob([`s${s} `]) });
    }
    await flush();
    const parts = await box.parts(cid);
    expect(parts.map((p) => p.n)).toEqual([0]);
    expect(await parts[0].blob.text()).toMatch(/^s0 s1 s2 .*s8 /); // up to the last 3 s or less
    // the tab is closed now (no stop, no upload): the next load sends what was kept.
    held.clear();
    expect(await drain(k.drainApi, box, () => f.clock.t + ABANDON_MS + 1)).toBe(1);
    expect(k.s.posts[0].words).toMatch(/^s0 s1 s2/);
  });

  it("Cancel keeps nothing on the device, not even in the last 5", async () => {
    const f = fakes();
    const k = fakeConsole();
    const e = engineOn(k.api, f);
    await e.start();
    await f.advance(10);
    await e.discard();
    await flush();
    expect(await box.sent()).toEqual([]);
  });
});
