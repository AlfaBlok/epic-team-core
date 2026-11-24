import type { NoteEngine } from "./noteEngine";
import { isPromise } from "./voiceCode";
import { IDLE_NOTE, type NoteMedia, type NoteStore, type NoteView } from "./noteShared";

/**
 * the owner, 24 Nov: "load the voice call and note engines only when one starts": the voice
 * note's recorder (noteEngine.ts, its upload, outbox writes and level meter) is no longer in the phone's first script.
 * A control holds this stand-in; the recorder's code is fetched the moment he taps the microphone.
 *
 *   tap ──┬── microphone opens (at once, inside the tap) ──┐
 *         └── recorder code loads (one small script) ──────┴──▶ recording (red dot, time)
 *
 * No lost first words: the control says "starting" until the recorder runs, exactly as before, and only then shows the
 * red dot; the microphone is asked for at the tap, in parallel with the code, so the wait is the longer of the two,
 * not their sum. A note kept in this browser from before a reload loads the recorder at once (recover), as it must.
 */
export type NoteEngineLike = Pick<NoteEngine, "view" | "subscribe" | "start" | "recover" | "readLevel" | "discard" | "dismiss" | "resume" | "finish" | "online" | "pageHide" | "pageVisible">;

/** the recorder's code could not be fetched (no connection): nothing was recorded, a tap tries again. */
export const NOTE_LOAD_FAILED_TEXT = "The voice note could not start: this page could not load its recorder. Check the connection and tap again.";

const stop = (s: MediaStream) => s.getTracks?.().forEach((t) => t.stop());

/** `media` whose first microphone() is the stream the tap opened; every later one opens a new stream. */
export function withFirstMic(media: NoteMedia, first?: Promise<MediaStream>): NoteMedia & { unused(): Promise<MediaStream> | undefined } {
  let pre = first;
  return {
    microphone: () => {
      const p = pre;
      pre = undefined;
      return p ?? media.microphone();
    },
    recorder: (s) => media.recorder(s),
    ...(media.level ? { level: (s: MediaStream) => media.level!(s) } : {}),
    ...(media.wakeLock ? { wakeLock: () => media.wakeLock!() } : {}),
    unused: () => {
      const p = pre;
      pre = undefined;
      return p;
    },
  };
}

type Built = { engine: NoteEngine; unused: () => Promise<MediaStream> | undefined };

export class LazyNote<Code = unknown> implements NoteEngineLike {
  private real?: NoteEngine;
  private loading?: Promise<unknown>;
  private v: NoteView = IDLE_NOTE;
  private subs = new Set<(v: NoteView) => void>();
  private cancelled = false;

  constructor(
    /** the recorder's code: here at once once fetched, else a promise of it (voiceCode.ts). */
    private code: () => Code | Promise<Code>,
    /** make the engine from the code; `first` is the microphone the tap opened (none on recover or a second note). */
    private build: (code: Code, first?: Promise<MediaStream>) => Built,
    private store: NoteStore,
    /** the microphone, asked for at the tap (same constraints the recorder uses). */
    private microphone: () => Promise<MediaStream>,
  ) {}

  /** the recorder is loaded (tests, the busy check). */
  loaded = () => !!this.real;

  view = (): NoteView => (this.real ? this.real.view() : this.v);
  subscribe(fn: (v: NoteView) => void) {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }
  private set(v: NoteView) {
    this.v = v;
    for (const f of this.subs) f(v);
  }
  private attach(b: Built): Built {
    b.engine.subscribe((v) => {
      for (const f of this.subs) f(v);
    });
    return b;
  }
  /** the code, at once (here already) or after its fetch; a failed fetch can be tried again. */
  private fetch(): Code | Promise<Code> {
    let c: Code | Promise<Code>;
    try {
      c = this.code();
    } catch (e) {
      c = Promise.reject(e);
    }
    if (isPromise(c)) {
      const p = c;
      this.loading = p;
      void p.then(
        () => (this.loading = undefined),
        () => (this.loading = undefined),
      );
    }
    return c;
  }

  async start(page?: string) {
    if (this.real) return this.real.start(page);
    if (this.loading || this.v.phase === "starting") return;
    const c = this.fetch();
    if (!isPromise(c)) {
      // the recorder's code is here already (a second note): exactly as before, no wait
      this.real = this.attach(this.build(c)).engine;
      return this.real.start(page);
    }
    this.cancelled = false;
    this.set({ ...IDLE_NOTE, phase: "starting" });
    // inside the tap: the microphone opens while the recorder's code loads
    let first: Promise<MediaStream>;
    try {
      first = this.microphone();
    } catch (e) {
      first = Promise.reject(e);
    }
    first.catch(() => undefined);
    let b: Built;
    try {
      b = this.attach(this.build(await c, first));
    } catch {
      void first.then(stop, () => undefined);
      return this.set({ ...IDLE_NOTE, phase: "failed", error: NOTE_LOAD_FAILED_TEXT });
    }
    if (this.cancelled) {
      this.real = b.engine;
      void b.unused()?.then(stop, () => undefined);
      return;
    }
    const going = b.engine.start(page);
    this.real = b.engine;
    try {
      await going;
    } finally {
      // the engine did not take the tap's microphone: let it go
      void b.unused()?.then(stop, () => undefined);
    }
  }

  async recover(): Promise<boolean> {
    if (this.real) return this.real.recover();
    // nothing kept in this browser: nothing to load
    if (!this.store.get() || this.loading) return false;
    let code: Code;
    try {
      code = await this.fetch();
    } catch {
      return false;
    }
    if (this.real) return (this.real as NoteEngine).recover();
    const b = this.attach(this.build(code));
    const p = b.engine.recover();
    this.real = b.engine;
    return p;
  }

  readLevel = () => this.real?.readLevel() ?? 0;
  async discard() {
    if (this.real) return this.real.discard();
    this.cancelled = true;
    this.set(IDLE_NOTE);
  }
  dismiss() {
    if (this.real) return this.real.dismiss();
    if (this.v.phase === "failed") this.set(IDLE_NOTE);
  }
  async resume() {
    if (this.real) return this.real.resume();
  }
  async finish() {
    if (this.real) return this.real.finish();
    // Send tapped while the recorder still loads: nothing was recorded yet
    this.cancelled = true;
    this.set(IDLE_NOTE);
  }
  online() {
    this.real?.online();
  }
  pageHide() {
    this.real?.pageHide();
  }
  async pageVisible(visible: boolean) {
    if (this.real) return this.real.pageVisible(visible);
  }
}
