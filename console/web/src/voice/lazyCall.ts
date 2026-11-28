import type { CallEngine, CallFocus, CallHands, EngineView } from "./engine";
import { isPromise } from "./voiceCode";

/**
 * the owner, 24 Nov: "load the voice call and note engines only when one starts": the call
 * engine (engine.ts: WebRTC, the realtime events, listen mode, the desk's hands) is no longer in the phone's first
 * script. Every call bar holds this stand-in; the engine's code is fetched when he taps Call.
 *
 *   tap Call ──▶ "Connecting…" at once ──▶ engine code loads ──▶ microphone, key, line (as before) ──▶ live
 *
 * The call cannot hear him before the line is up in any case, so nothing he says is lost to the load: the bar shows
 * Connecting from the tap, as it always did while the key was minted.
 */
export type CallEngineLike = Pick<CallEngine, "view" | "subscribe" | "start" | "startFocused" | "setMuted" | "hangup" | "pageVisible" | "clearError" | "pageHide" | "readLevel"> & { hands?: CallHands };

export const IDLE_CALL: EngineView = { phase: "idle", muted: false, hearing: "", speaking: "", lines: [], costUsd: 0, elapsedS: 0, deskWaiting: 0 };
/** the engine's code could not be fetched (no connection): no call was made, nothing charged. */
export const CALL_LOAD_FAILED_TEXT = "The call could not start: this page could not load its call code. Check the connection and tap Call again.";

export class LazyCall implements CallEngineLike {
  private real?: CallEngine;
  private loading?: Promise<CallEngine>;
  private v: EngineView = IDLE_CALL;
  private subs = new Set<(v: EngineView) => void>();
  private cancelled = false;
  private myHands?: CallHands;

  /** `make`: the engine, at once when its code is already here, else a promise of it. */
  constructor(private make: () => CallEngine | Promise<CallEngine>) {}

  /** the engine is loaded (tests). */
  loaded = () => !!this.real;

  get hands(): CallHands | undefined {
    return this.real ? this.real.hands : this.myHands;
  }
  set hands(h: CallHands | undefined) {
    this.myHands = h;
    if (this.real) this.real.hands = h;
  }

  view(): EngineView {
    return this.real ? this.real.view() : this.v;
  }
  subscribe(fn: (v: EngineView) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }
  private set(v: EngineView) {
    this.v = v;
    for (const f of this.subs) f(v);
  }

  private attach(e: CallEngine): CallEngine {
    if (this.myHands) e.hands = this.myHands;
    e.subscribe((v) => {
      for (const f of this.subs) f(v);
    });
    return e;
  }

  private async go(run: (e: CallEngine) => Promise<void>): Promise<void> {
    if (this.real) return run(this.real);
    if (this.loading || this.v.phase === "starting") return;
    let made: CallEngine | Promise<CallEngine>;
    try {
      made = this.make();
    } catch (err) {
      made = Promise.reject(err);
    }
    if (!isPromise(made)) {
      // the code is here already (a second call): exactly as before, no wait
      const e = this.attach(made);
      this.real = e;
      return run(e);
    }
    this.cancelled = false;
    this.set({ ...IDLE_CALL, phase: "starting" });
    let e: CallEngine;
    try {
      this.loading = made.then((x) => this.attach(x));
      e = await this.loading;
    } catch {
      return this.set({ ...IDLE_CALL, phase: "failed", error: CALL_LOAD_FAILED_TEXT });
    } finally {
      this.loading = undefined;
    }
    if (this.cancelled) {
      this.real = e;
      return;
    }
    // the engine says "starting" itself before we hand the view over, so the bar never flickers back to idle
    const going = run(e);
    this.real = e;
    return going;
  }

  start(o?: Parameters<CallEngine["start"]>[0]): Promise<void> {
    return this.go((e) => e.start(o));
  }
  startFocused(focus: CallFocus): Promise<void> {
    return this.go((e) => e.startFocused(focus));
  }
  setMuted(m: boolean) {
    this.real?.setMuted(m);
  }
  async hangup(reason = "hangup"): Promise<void> {
    if (this.real) return this.real.hangup(reason);
    // hung up while the code still loads: no call was made
    this.cancelled = true;
    this.set(IDLE_CALL);
  }
  async pageVisible(visible: boolean): Promise<void> {
    if (this.real) return this.real.pageVisible(visible);
  }
  clearError() {
    if (this.real) return this.real.clearError();
    if (this.v.error) this.set({ ...this.v, error: undefined, phase: this.v.phase === "failed" ? "idle" : this.v.phase });
  }
  pageHide() {
    this.real?.pageHide();
  }
  readLevel(): number {
    return this.real?.readLevel() ?? 0;
  }
}
