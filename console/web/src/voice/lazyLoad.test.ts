// the owner, 24 Nov: "load the voice call and note engines only when one starts": the call engine
// and the note recorder are not in the phone's first script; each loads when he taps Call or the microphone.
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CALL_LOAD_FAILED_TEXT, LazyCall } from "./lazyCall";
import { LazyNote, NOTE_LOAD_FAILED_TEXT, withFirstMic } from "./lazyNote";
import { memoryNoteStore, type NoteMedia } from "./noteShared";
import type { CallEngine } from "./engine";
import type { NoteEngine } from "./noteEngine";

const later = <T,>() => {
  let ok!: (v: T) => void, no!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((ok = a), (no = b)));
  return { p, ok, no };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeCall() {
  let phase = "idle";
  const subs = new Set<(v: unknown) => void>();
  const e = {
    hands: undefined as unknown,
    view: () => ({ phase }),
    subscribe: (f: (v: unknown) => void) => (subs.add(f), () => subs.delete(f)),
    start: vi.fn(async () => {
      phase = "starting";
      subs.forEach((f) => f({ phase }));
    }),
    startFocused: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
  };
  return e as unknown as CallEngine & typeof e;
}

describe("a call's engine loads when he taps Call", () => {
  it("shows Connecting at once, then the loaded engine starts the call, and the desk's hands reach it", async () => {
    const code = later<CallEngine>();
    const make = vi.fn(() => code.p);
    const c = new LazyCall(make);
    const hands = { press: vi.fn() };
    c.hands = hands;
    const seen: string[] = [];
    c.subscribe((v) => seen.push(v.phase));
    expect(make).not.toHaveBeenCalled(); // nothing fetched for a page that only shows the Call button
    expect(c.view().phase).toBe("idle");
    const going = c.start();
    expect(c.view().phase).toBe("starting");
    const e = fakeCall();
    code.ok(e);
    await going;
    expect(e.start).toHaveBeenCalledTimes(1);
    expect(e.hands).toBe(hands);
    expect(c.loaded()).toBe(true);
    expect(seen[0]).toBe("starting");
    expect(seen).not.toContain("idle");
  });

  it("a second tap while it loads starts one call; Hang up while it loads makes none", async () => {
    const code = later<CallEngine>();
    const c = new LazyCall(() => code.p);
    void c.start();
    void c.start();
    await c.hangup();
    expect(c.view().phase).toBe("idle");
    const e = fakeCall();
    code.ok(e);
    await tick();
    expect(e.start).not.toHaveBeenCalled();
  });

  it("no connection: the bar says the call could not start, and the next tap tries again", async () => {
    let n = 0;
    const e = fakeCall();
    const c = new LazyCall(() => (n++ === 0 ? Promise.reject(new Error("fetch failed")) : Promise.resolve(e)));
    await c.start();
    expect(c.view()).toMatchObject({ phase: "failed", error: CALL_LOAD_FAILED_TEXT });
    c.clearError();
    expect(c.view().phase).toBe("idle");
    await c.start();
    expect(e.start).toHaveBeenCalledTimes(1);
  });

  it("once the code is here, a call starts in the same tick, as before", () => {
    const e = fakeCall();
    const c = new LazyCall(() => e);
    void c.start();
    expect(e.start).toHaveBeenCalledTimes(1);
    expect(c.view().phase).toBe("starting");
  });
});

function fakeNote() {
  let phase = "idle";
  const subs = new Set<(v: unknown) => void>();
  let media!: NoteMedia;
  const e = {
    view: () => ({ phase }),
    subscribe: (f: (v: unknown) => void) => (subs.add(f), () => subs.delete(f)),
    start: vi.fn(async () => {
      phase = "starting";
      subs.forEach((f) => f({ phase }));
      await media.microphone();
      phase = "recording";
      subs.forEach((f) => f({ phase }));
    }),
    recover: vi.fn(async () => true),
    setMedia: (m: NoteMedia) => void (media = m),
  };
  return e;
}

describe("a voice note's recorder loads when he taps the microphone", () => {
  it("the microphone opens at the tap, before the recorder's code is here, and the recorder takes that same stream", async () => {
    const code = later<string>();
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const microphone = vi.fn(async () => stream);
    const e = fakeNote();
    let gotFirst: Promise<MediaStream> | undefined;
    const media: NoteMedia = { microphone, recorder: vi.fn() as never };
    const n = new LazyNote(
      () => code.p,
      (_c, first) => {
        gotFirst = first;
        const m = withFirstMic(media, first);
        e.setMedia(m);
        return { engine: e as unknown as NoteEngine, unused: m.unused };
      },
      memoryNoteStore(),
      microphone,
    );
    const going = n.start("/inbox");
    expect(microphone).toHaveBeenCalledTimes(1); // inside the tap, while the code still loads
    expect(n.view().phase).toBe("starting"); // no red dot until the recorder runs
    code.ok("code");
    await going;
    expect(gotFirst).toBeDefined();
    expect(e.start).toHaveBeenCalledWith("/inbox");
    expect(microphone).toHaveBeenCalledTimes(1); // the recorder used the tap's stream, no second ask
    expect(n.view().phase).toBe("recording");
  });

  it("Send or Cancel while it loads records nothing and lets the microphone go", async () => {
    const code = later<string>();
    const stopT = vi.fn();
    const stream = { getTracks: () => [{ stop: stopT }] } as unknown as MediaStream;
    const e = fakeNote();
    const n = new LazyNote(
      () => code.p,
      (_c, first) => {
        const m = withFirstMic({ microphone: async () => stream, recorder: vi.fn() as never }, first);
        e.setMedia(m);
        return { engine: e as unknown as NoteEngine, unused: m.unused };
      },
      memoryNoteStore(),
      async () => stream,
    );
    const going = n.start();
    await n.discard();
    expect(n.view().phase).toBe("idle");
    code.ok("code");
    await going;
    await tick();
    expect(e.start).not.toHaveBeenCalled();
    expect(stopT).toHaveBeenCalled();
  });

  it("no connection: the note says it could not start; nothing kept means no fetch on a page open", async () => {
    const code = vi.fn(() => Promise.reject(new Error("fetch failed")));
    const n = new LazyNote(code, () => ({ engine: fakeNote() as unknown as NoteEngine, unused: () => undefined }), memoryNoteStore(), async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    expect(await n.recover()).toBe(false);
    expect(code).not.toHaveBeenCalled();
    await n.start();
    expect(n.view()).toMatchObject({ phase: "failed", error: NOTE_LOAD_FAILED_TEXT });
  });

  it("a note kept from before a reload loads the recorder at once and is offered again", async () => {
    const store = memoryNoteStore();
    store.set({ id: "vn_1", next: 1, done: [0], empty: [], closedS: 10, segmentS: 120, maxMin: 120, usdPerMin: 0.003, at: Date.now() });
    const e = fakeNote();
    const n = new LazyNote(() => Promise.resolve("code"), () => ({ engine: e as unknown as NoteEngine, unused: () => undefined }), store, vi.fn());
    expect(await n.recover()).toBe(true);
    expect(e.recover).toHaveBeenCalledTimes(1);
  });
});

describe("the app's first script", () => {
  it("no page or control imports the call engine or the recorder directly: only voiceCode.ts fetches them", () => {
    const root = path.resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f.name) && !/\.test\./.test(f.name)) files.push(p);
      }
    };
    walk(root);
    const bad = files.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      // a value import (not `import type`) from the engines pulls them into whatever script holds this file
      return /^import (?!type )[^;]*from "(\.\/|@\/voice\/)(engine|noteEngine)";/m.test(src) || /^export \* from "(\.\/|@\/voice\/)(engine|noteEngine)"/m.test(src);
    });
    expect(bad.map((f) => path.relative(root, f))).toEqual([]);
  });
});
