import { describe, expect, it, vi } from "vitest";
import { drain, emptyNote, memoryOutbox, type DrainApi } from "./outbox";

// E948-S174 (the owner 22 Nov 19:2xZ): his phone showed a 0-second voice note to a card "Waiting to send", retried for days.
// An empty recording (0 s, or no audio bytes) is dropped at once, never queued or retried; the one stuck in an outbox goes
// the next time the outbox runs.

const api = (): DrainApi => ({
  start: vi.fn(async () => ({ id: "vn_x" })),
  segment: vi.fn(async () => ({})),
  // the console refuses a note with no audio: before, this kept it waiting and retrying for days
  finish: vi.fn(async () => {
    throw Object.assign(new Error("no audio in this note"), { status: 400 });
  }),
  discard: vi.fn(async () => ({})),
});

describe("E948-S174 an empty recording is dropped, never retried", () => {
  it("names an empty note: 0 s or no bytes, with nothing on the console", () => {
    const n = { done: [] as number[], seconds: 0 };
    expect(emptyNote(n, [])).toBe(true);
    expect(emptyNote(n, [{ blob: new Blob([]), seconds: 3 }])).toBe(true);
    expect(emptyNote(n, [{ blob: new Blob(["x"]), seconds: 0 }])).toBe(true);
    expect(emptyNote({ done: [], seconds: 4 }, [{ blob: new Blob(["said"]), seconds: 4 }])).toBe(false);
    expect(emptyNote({ done: [0], seconds: 0 }, [])).toBe(false);
  });

  it("the 0-second note stuck waiting (opened on the console, sent, retried) leaves the outbox on the next run, thrown away there too", async () => {
    const store = memoryOutbox();
    await store.putNote({ cid: "c1", base: "/api/voice", id: "vn_stuck", fill: true, to: "Exa", parts: 1, done: [], send: true, at: 0, startedAt: 0, seconds: 0, tries: 40, error: "no audio in this note" });
    await store.putPart({ cid: "c1", n: 0, blob: new Blob([]), seconds: 0 });
    const a = api();
    await drain(a, store, () => 10 ** 13, { force: true });
    expect(await store.notes()).toEqual([]);
    expect(await store.parts("c1")).toEqual([]);
    expect(a.finish).not.toHaveBeenCalled();
    expect(a.segment).not.toHaveBeenCalled();
    expect(a.discard).toHaveBeenCalledWith("/api/voice", "vn_stuck");
  });

  it("a real note still goes", async () => {
    const store = memoryOutbox();
    await store.putNote({ cid: "c2", base: "/api/voice", parts: 1, done: [], send: true, at: 0, startedAt: 0, seconds: 5 });
    await store.putPart({ cid: "c2", n: 0, blob: new Blob(["said"]), seconds: 5 });
    const a = { ...api(), finish: vi.fn(async () => ({ state: "posted" })) };
    expect(await drain(a, store, () => 10 ** 13, { force: true })).toBe(1);
    expect(a.segment).toHaveBeenCalled();
  });
});
