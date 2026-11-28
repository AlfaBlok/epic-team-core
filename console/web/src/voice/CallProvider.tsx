import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CALL_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import type { Media, Phase, VoiceApi } from "./engine";
import { fetchVoiceApi } from "./callApi";
import { LazyCall } from "./lazyCall";
import { callEngineCode, isPromise } from "./voiceCode";
import { connectingText, useConnectingSeconds } from "./connecting";
import { hookLinks } from "./linkGuard";

/**
 * (the owner, 28 Nov 01:25Z: "if the phone gets locked or whatever, the calls drop"): his 00:41Z call (call_784648a0)
 * stopped beating at 00:53:15 when the phone locked, and the page came back as a new page that no longer held the call:
 * it showed "A call is still on … Hang it up here", he hung it up at 00:54:20 and the reconnect never ran. Each call this tab
 * holds is now kept in the tab's own sessionStorage (it survives a reload of the same tab, never another tab's), with the
 * last moment the page was alive; a fresh page that finds it hangs the dead call up and reconnects by itself.
 *
 *   live call ──▶ { id, aliveAt } every few seconds ──▶ phone locks, page reloads ──▶ same tab finds it (≤ 15 min)
 *        └─ he hangs up / bye / limit: the record goes                         └─▶ end the dead call, reconnect, "we lost you for N s"
 */
export const HELD_KEY = (base: string) => `console-call-held:${base}`;
/** a call this tab held reconnects after a reload within this long (the engine's own RECONNECT_WINDOW_MS). */
export const RESUME_WINDOW_MS = 15 * 60_000;
/** End reasons after which the tab's record goes: he or the voice ended it (a drop, the quiet, a closed page keep it). */
const KEEP_REASONS = new Set(["line_dropped", "quiet", "tab_closed"]);
export interface HeldRecord {
  id: string;
  aliveAt: number;
  /** the call ended by a drop or a closed page at this time (still on at the console otherwise). */
  droppedAt?: number;
  /** the page went out of view (the phone locked) at this time and has not come back: what he says from here may be lost. */
  hiddenAt?: number;
}
/** when the call stopped reaching him: the lock, else the page's last sign of life. */
export const lostSince = (r: HeldRecord) => Math.min(r.aliveAt, r.hiddenAt ?? r.aliveAt);

/**
 * A call is the tab's, never a page's: leaving
 * Chat mid-call unmounted the bar and orphaned its engine (mic on, heartbeat on, transcript in a detached engine, no Hang up),
 * and took the pagehide listener with it, so a reload ended nothing. So this owner sits above the router: one engine per call
 * routes' root (the Team desk's `/api/voice`, a world desk's or a milestone's), the one audio element the calls play through,
 * and the tab's pagehide, which ends every call on with its transcript. A page's call bar (useCallDock) is a view onto it;
 * while a call is on and no page shows its bar, CallWidget floats it on every page.
 */
export interface HeldCall {
  base: string;
  /** the call engine, loaded when he taps Call (lazyCall.ts). */
  engine: LazyCall;
  api: VoiceApi;
  /** The api a page passed (tests); production passes none. */
  given?: VoiceApi;
  /** Whom the call is with ("the desk"), and the page (path + query) whose bar started it: the widget's link back. */
  callee: string;
  where?: string;
  page?: string;
  /** Call bars showing this call now (0: the widget shows it). */
  docks: number;
}

export const busy = (p: Phase) => p === "starting" || p === "connecting" || p === "live" || p === "ending";

export class CallTab {
  private held = new Map<string, HeldCall>();
  private audio?: HTMLAudioElement;
  private listeners = new Set<() => void>();
  private unhook?: () => void;
  private version = 0;

  constructor(private win: Window | undefined = typeof window === "undefined" ? undefined : window) {}

  /** The tab's pagehide (tab closed, reload): every call on ends with its transcript, whatever page is showing. */
  hook(): () => void {
    if (!this.unhook && this.win) {
      // a link tap or a new build's script reload never reloads the page under a call (lazyPage reads the same check)
      const offLinks = hookLinks(this.win, { busy: () => this.busy() });
      const hide = () => this.pageHide();
      // the phone locked or came back (the engine keeps the call, or reconnects it on return).
      const doc = this.win.document;
      const seen = () => this.visibility(!doc.hidden);
      this.win.addEventListener("pagehide", hide);
      doc.addEventListener("visibilitychange", seen);
      this.unhook = () => {
        offLinks();
        this.win?.removeEventListener("pagehide", hide);
        doc.removeEventListener("visibilitychange", seen);
        this.unhook = undefined;
      };
    }
    return () => this.unhook?.();
  }
  pageHide() {
    for (const h of this.held.values()) h.engine.pageHide();
  }
  visibility(visible: boolean) {
    for (const h of this.held.values()) {
      const r = this.heldRecord(h.base);
      if (r && busy(h.engine.view().phase)) {
        try {
          const next: HeldRecord = { ...r, hiddenAt: visible ? undefined : (r.hiddenAt ?? Date.now()) };
          this.store()?.setItem(HELD_KEY(h.base), JSON.stringify(next));
        } catch {
          /* off */
        }
      }
      void h.engine.pageVisible(visible);
    }
  }

  /** The tab's engine for `base` (made on first use). */
  call(base: string, o: { api?: VoiceApi; media?: (audio: HTMLAudioElement) => Media; callee?: string; where?: string } = {}): HeldCall {
    const had = this.held.get(base);
    if (had && had.given === o.api) return had;
    const api = o.api ?? fetchVoiceApi(undefined, base);
    const made = (e: Awaited<ReturnType<typeof callEngineCode>>) => {
      const m = () => (o.media ?? e.browserMedia)(this.audioEl());
      return new e.CallEngine(api, {
        // Late-bound: the audio element is made when a call first needs it.
        microphone: () => m().microphone(),
        peer: () => m().peer(),
        exchange: (sdp, key, model) => m().exchange(sdp, key, model),
        play: (st) => m().play(st),
        wakeLock: () => m().wakeLock?.() ?? Promise.resolve(undefined),
        session: (hs) => m().session?.(hs),
      });
    };
    const h: HeldCall = {
      base,
      api,
      given: o.api,
      callee: o.callee ?? "the desk",
      where: o.where,
      docks: 0,
      // the engine's code is fetched when he taps Call, never with the page (kept after: a second call starts at once)
      engine: new LazyCall(() => {
        const code = callEngineCode();
        return isPromise(code) ? code.then(made) : made(code);
      }),
    };
    // the Team desk's call walks his whole inbox and his objectives: it presses and files from any page.
    // SectionCall imports this file: its hands are read when first used, so the two never load each other in a loop.
    if (base === "/api/voice" && !o.api) {
      const hands = () => import("./SectionCall").then((m) => m.inboxHands());
      h.engine.hands = {
        press: async (p) => (await hands()).press!(p),
        show: (id) => void hands().then((x) => x.show?.(id)),
        file: async (p) => (await hands()).file!(p),
      };
    }
    // the objectives review call files his decisions on each objective, like the Team desk's walk; it presses nothing.
    if (base === "/api/voice/briefing" && !o.api) {
      const hands = () => import("./SectionCall").then((m) => m.inboxHands());
      h.engine.hands = { file: async (p) => (await hands()).file!(p) };
    }
    h.engine.subscribe((v) => {
      this.keep(base, v);
      this.changed();
    });
    this.held.set(base, h); // no change event: this runs while a page renders, and nothing floats until a call starts
    return h;
  }

  private store(): Storage | undefined {
    try {
      return this.win?.sessionStorage;
    } catch {
      return undefined;
    }
  }
  private keptAt = new Map<string, number>();
  /** the tab's record of the call on `base` (written every few seconds while live; gone when he or the voice ends it). */
  private keep(base: string, v: { phase: Phase; callId?: string; endReason?: string }) {
    const st = this.store();
    if (!st) return;
    const now = Date.now();
    try {
      if ((v.phase === "live" || v.phase === "connecting") && v.callId) {
        if (now - (this.keptAt.get(base) ?? 0) < 3_000) return;
        this.keptAt.set(base, now);
        const had = this.heldRecord(base);
        st.setItem(HELD_KEY(base), JSON.stringify({ id: v.callId, aliveAt: now, ...(had?.id === v.callId && had.hiddenAt ? { hiddenAt: had.hiddenAt } : {}) } satisfies HeldRecord));
      } else if (v.phase === "ended" || v.phase === "failed") {
        this.keptAt.delete(base);
        const had = this.heldRecord(base);
        if (had && v.endReason && KEEP_REASONS.has(v.endReason) && had.id === v.callId) st.setItem(HELD_KEY(base), JSON.stringify({ ...had, droppedAt: had.droppedAt ?? now }));
        else if (had && (!v.callId || had.id === v.callId)) st.removeItem(HELD_KEY(base));
      }
    } catch {
      /* storage full or off: no reconnect after a reload, the call itself goes on */
    }
  }
  heldRecord(base: string): HeldRecord | undefined {
    try {
      const raw = this.store()?.getItem(HELD_KEY(base));
      const r = raw ? (JSON.parse(raw) as HeldRecord) : undefined;
      return r && typeof r.id === "string" && typeof r.aliveAt === "number" ? r : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * A fresh page (after a lock and a reload) whose tab held a call on `h`: the call to reconnect, or undefined. `activeId`
   * is the console's call still on for this world: a different one is another device's, never touched.
   */
  resumable(h: HeldCall, activeId: string | undefined, now = Date.now()): (HeldRecord & { stale?: string }) | undefined {
    if (busy(h.engine.view().phase) || h.engine.view().phase === "ended") return undefined;
    const r = this.heldRecord(h.base);
    if (!r) return undefined;
    if (now - r.aliveAt > RESUME_WINDOW_MS || (activeId && activeId !== r.id)) {
      this.store()?.removeItem(HELD_KEY(h.base));
      return undefined;
    }
    return { ...r, ...(activeId === r.id ? { stale: r.id } : {}) };
  }
  forget(base: string) {
    try {
      this.store()?.removeItem(HELD_KEY(base));
    } catch {
      /* off */
    }
  }

  /** A call bar shows `h` while mounted; `page` is where it is (kept as the call's page when the call starts there). */
  dock(h: HeldCall): () => void {
    h.docks++;
    this.changed();
    return () => {
      h.docks--;
      this.changed();
    };
  }
  started(h: HeldCall, page: string | undefined) {
    h.page = page?.replace(/([?&])call=1(&|$)/, "$1").replace(/[?&]$/, "");
    this.changed();
  }

  all(): HeldCall[] {
    return [...this.held.values()];
  }
  /** a call is on somewhere in the tab (a new build waits for it, never reloads under it). */
  busy(): boolean {
    return this.all().some((h) => busy(h.engine.view().phase));
  }
  /** Calls on that no page shows: the floating widget's. */
  floating(): HeldCall[] {
    return this.all().filter((h) => h.docks === 0 && busy(h.engine.view().phase));
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private audioEl(): HTMLAudioElement {
    // In the document for the tab's life (a media element removed from the document pauses; the old one sat in the bar).
    if (!this.audio) {
      const el = document.createElement("audio");
      el.autoplay = true;
      el.hidden = true;
      el.dataset.testid = "call-audio";
      document.body.appendChild(el);
      this.audio = el;
    }
    return this.audio;
  }
}

/** Pages rendered without the app (tests, one page alone) share this one. */
let fallback: CallTab | undefined;
const fallbackTab = () => {
  if (!fallback) {
    fallback = new CallTab();
    fallback.hook();
  }
  return fallback;
};

const Ctx = createContext<CallTab | undefined>(undefined);

/** The app's call owner: wraps the router (App.tsx), so no page change ever unmounts a call. */
export function CallProvider(props: { children: ReactNode; tab?: CallTab }) {
  const [tab] = useState(() => props.tab ?? new CallTab());
  useEffect(() => tab.hook(), [tab]);
  return <Ctx.Provider value={tab}>{props.children}</Ctx.Provider>;
}

export function useCallTab(): CallTab {
  return useContext(Ctx) ?? fallbackTab();
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** One floating call: live dot, whom it is with, the time, Mute, Hang up, and the link back to its page. */
function Floating({ h }: { h: HeldCall }) {
  const v = h.engine.view();
  const connectingS = useConnectingSeconds(v.phase);
  const [hanging, setHanging] = useState(false);
  return (
    <div
      role="region"
      aria-label={`Call with ${h.callee}`}
      data-testid="call-widget"
      data-base={h.base}
      className={cn("flex items-center gap-2 rounded-full border border-emerald-500/50 bg-card/95 py-1.5 pl-3 pr-1.5 text-sm shadow-lg backdrop-blur flex-wrap phone:gap-x-3 phone:gap-y-3 phone:rounded-2xl phone:border-2 phone:p-3 phone:text-base", v.onCard && v.phase === "live" && "rounded-2xl")}
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-600" />
      </span>
      {h.page ? (
        <Link
          to={h.page}
          data-testid="call-widget-back"
          className="min-w-0 underline-offset-2 [overflow-wrap:anywhere] hover:underline phone:flex-1 phone:font-semibold phone:underline"
          title="Back to the call"
        >
          {h.where ? `${h.where} · ` : ""}On call with {v.speaker ? `${v.speakerPerson ? `${v.speakerPerson}, ` : ""}the ${v.speaker}` : h.callee}
        </Link>
      ) : (
        <span className="min-w-0 [overflow-wrap:anywhere] phone:flex-1 phone:font-semibold">On call with {v.speaker ? `${v.speakerPerson ? `${v.speakerPerson}, ` : ""}the ${v.speaker}` : h.callee}</span>
      )}
      {/* a section call: the card the voice is on and its evidence, on his screen while they talk about it */}
      {v.onCard && v.phase === "live" && (
        <span className="order-last flex min-w-0 basis-full items-center gap-2 text-xs text-muted-foreground phone:text-sm" data-testid="call-widget-card">
          <span className="min-w-0 truncate">
            {v.onCard.place}
            {v.onCard.title ? ` · ${v.onCard.title}` : ""}
          </span>
          {v.onCard.link && (
            <a href={v.onCard.link.url} target="_blank" rel="noreferrer" className="shrink-0 font-medium text-foreground underline underline-offset-2" data-testid="call-widget-evidence">
              Evidence ↗
            </a>
          )}
        </span>
      )}
      <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="call-widget-time">
        {v.phase === "live" ? clock(v.elapsedS) : v.phase === "ending" ? "Hanging up…" : connectingText(connectingS)}
      </span>
      {/* on a phone the two controls are 64 px tall with labels, Hang up apart on the right (upright: their own row). */}
      <div className="flex shrink-0 gap-2 phone:grid phone:grid-cols-2 phone:gap-10 phone:sm:[&>*]:min-w-36 max-sm:basis-full">
        <Button
          data-testid="call-widget-mute"
          variant="ghost"
          size="icon"
          className={cn(
            "size-8 shrink-0 rounded-full",
            CALL_TAP,
            "phone:w-auto phone:gap-1.5 phone:border-2 phone:border-foreground/70",
            v.muted && "phone:border-amber-600 phone:bg-amber-500/15",
          )}
          aria-pressed={v.muted}
          aria-label={v.muted ? "Unmute" : "Mute"}
          disabled={v.phase !== "live"}
          onClick={() => h.engine.setMuted(!v.muted)}
        >
          {v.muted ? <MicOff /> : <Mic />}
          <span className="hidden phone:inline">{v.muted ? "Unmute" : "Mute"}</span>
        </Button>
        <Button
          data-testid="call-widget-hangup"
          variant="destructive"
          size="sm"
          className={cn("h-8 shrink-0 gap-1 rounded-full", CALL_TAP, "phone:bg-red-700 phone:text-white")}
          disabled={hanging || v.phase === "ending"}
          onClick={() => {
            setHanging(true);
            void h.engine.hangup("hangup").finally(() => setHanging(false));
          }}
        >
          <PhoneOff className={cn(hanging && "animate-pulse")} /> {hanging ? "Hanging up…" : "Hang up"}
        </Button>
      </div>
    </div>
  );
}

/** Every page (inside the router): the calls on that no page shows, floating bottom right. */
export function CallWidget() {
  const tab = useCallTab();
  useSyncExternalStore(tab.subscribe, tab.snapshot, tab.snapshot);
  const calls = tab.floating();
  if (!calls.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-3 z-50 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2 max-sm:left-3 max-sm:items-stretch">
      {calls.map((h) => (
        <div key={h.base} className="pointer-events-auto max-w-full">
          <Floating h={h} />
        </div>
      ))}
    </div>
  );
}
