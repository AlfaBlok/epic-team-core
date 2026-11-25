import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Play, SendHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import { outbox, outboxState, startOutbox, subscribeOutbox } from "./outbox";
import { ON_DEVICE_PATH } from "@/lib/routePaths";
import { cardFallback, deskFallback } from "./deskFallback";
import type { ClosedCardRef } from "@/api/review-types";
import { hookLinks } from "./linkGuard";
import { markSent, sentOf } from "@/lib/sentRows";
import { EMPTY_RECORDING_TEXT, KEPT_FAILED_TEXT, WAITING_TEXT, localNoteStore, memoryNoteStore, MIC_BUSY_TEXT, noteMicrophone, type NoteClock, type NoteMedia, type NotePhase, type NotesApi, type NoteStore, type NoteView, type SentNote } from "./noteShared";
import { LazyNote, withFirstMic } from "./lazyNote";
import { noteEngineCode } from "./voiceCode";

/**
 * Like a call (
 * L-42), a voice note is the tab's, never a page's: this owner sits above the router and holds one NoteEngine per origin (a
 * chat's note route, or one card's box), so its microphone and recorder live across page changes. A page's voice control
 * (useNote) is a view onto it; while a note is on and no page shows it, NoteWidget floats the controls on every page, and back
 * on that page the same note (same vn_ id) goes on. The tab's pagehide and visibility are hooked once here.
 *
 * the controls, on the page and in the floating pill: a pulsing red dot (steady with reduced motion), the time, Send
 * (stops and sends in one tap) and Cancel (a note of a minute or more asks once before it is thrown away).
 *
 * a note carries its origin. A chat note posts itself (the console's finish). A card's note is written out
 * (`fill`) and then handed to the card's own press (`deliver`: Answer, Changes wanted, Decline, the path), here in the
 * tab, so it lands on that card even when the card is not on screen. The pill says where it goes ("to: Chat").
 */
export interface HeldNote {
  /** The origin: a chat's note route (`/api/voice`), or `card:<id>` for a card's box. */
  key: string;
  base: string;
  /** the recorder, loaded on his first tap (lazyNote.ts). */
  engine: LazyNote<Awaited<ReturnType<typeof noteEngineCode>>>;
  /** The api a page passed (tests); production passes none. */
  given?: NotesApi;
  /** Where Send lands it, for the pill: "Chat", or the card's title. */
  to: string;
  /** The page (path + query) the note was started on: the pill's link back. */
  route?: string;
  /** Controls showing this note now (0: the pill shows it). */
  docks: number;
  /** A card's note: send the written-out note through the card's own press. Absent: the note posts itself (a chat). */
  deliver?: (note: SentNote) => Promise<unknown>;
  /**
   * the owner 2026-11-15: set while a card's recording strip is scrolled off screen on the page it was started on (the pill
   * then floats it); the pill's link scrolls back to the card instead of opening the page again.
   */
  show?: () => void;
  /** A card's note: the reply the press carries (his typed words, the spoken words, the note's id and link). */
  words?: (note: SentNote) => string;
  /** The page the note names (`card <ref>: <title>`), for the Team desk when the card refuses it. */
  page?: string;
  /** the row the card is on; when its press refuses the note, the note lands there as his note on that card. */
  card?: ClosedCardRef;
  /**
   * A delivered note's way out (cards): sending, landed, nothing heard, `desk` (the card refused it, so his words
   * went to the Team desk whole), or failed (Send again; his words are already in his memory, so never "Not sent").
   */
  out?: { state: "sending" | "done" | "empty" | "card" | "desk" | "failed"; error?: string; note?: SentNote };
  /** E948-S174: the card the note was started or sent on (its `data-inbox-card` slot), found from the pressed button. */
  slot?: string;
  /** E948-S174: the card collapsed to this row on Send; the row spins until the card's press has the note. */
  row?: string;
}

/** a refused card note goes here whole (the world's Team desk); `id` keys it so a retry never posts twice. */
export type ToDesk = (text: string, page: string | undefined, id: string) => Promise<unknown>;
/**
 * a refused card note goes onto the card's own row (its spine, as his note on that card, its owner woken), keyed on
 * the note so a retry never writes it twice.
 */
export type ToCard = (card: ClosedCardRef, words: string, id: string) => Promise<unknown>;
/** How long a note that went to the desk instead says so (longer than a plain Sent: he should read where it went). */
export const DESK_SHOW_MS = 12_000;

/** The pill shows a note in these phases (sent: a few seconds, then it goes). */
const SHOWN: NotePhase[] = ["starting", "recording", "paused", "sending", "failed", "sent"];
export const noteOn = (p: NotePhase) => p === "starting" || p === "recording" || p === "paused";
/** A note this long (seconds) asks once before Cancel throws it away. */
export const CONFIRM_CANCEL_S = 60;
/** A sent note says so this long, then its line and the pill go. */
export const SENT_SHOW_MS = 4000;
const ROUTE_KEY = (key: string) => `voice-note-route:${key}`;
const OPEN_KEY = "voice-note-open:";
/** what a card's note needs to come back after a reload: its routes, its card, where it was started. */
const CARD_META_KEY = (key: string) => `voice-note-card:${key}`;
interface CardMeta {
  base: string;
  to: string;
  route?: string;
  page?: string;
  card?: ClosedCardRef;
}
function keptCard(key: string): CardMeta | undefined {
  try {
    const raw = localStorage.getItem(CARD_META_KEY(key));
    const m = raw ? (JSON.parse(raw) as CardMeta) : undefined;
    return m && typeof m.base === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}
function keepCard(key: string, m: CardMeta | undefined) {
  try {
    if (m) localStorage.setItem(CARD_META_KEY(key), JSON.stringify(m));
    else localStorage.removeItem(CARD_META_KEY(key));
  } catch {
    /* storage off */
  }
}
/** a restored card note's words for its row when the card is gone (the card's own control uses withVoiceNote). */
const cardWords = (n: SentNote) => `${n.transcript?.trim() ?? ""} (voice note ${n.id}${n.audio ? `, audio ${n.audio}` : ""})`;

export interface NoteOpts {
  base?: string;
  /** The note's words come back (a card's) instead of being posted to a chat. */
  fill?: boolean;
  to?: string;
  api?: NotesApi;
  media?: NoteMedia;
  clock?: NoteClock;
  store?: NoteStore;
}

export class NoteTab {
  private held = new Map<string, HeldNote>();
  private listeners = new Set<() => void>();
  private unhook?: () => void;
  private version = 0;

  constructor(
    private win: Window | undefined = typeof window === "undefined" ? undefined : window,
    /** where a card note goes when its card refuses it; none = it stays failed with Send again (tests). */
    public toDesk?: ToDesk,
    /** where a refused card note goes first: the card's own row; none = straight to the desk. */
    public toCard?: ToCard,
  ) {}

  /** The tab's pagehide (finish what is recorded) and visibility (lock and unlock), for every note at once. */
  hook(): () => void {
    if (!this.unhook && this.win) {
      const doc = this.win.document;
      const hide = () => this.held.forEach((h) => h.engine.pageHide());
      const seen = () => this.held.forEach((h) => void h.engine.pageVisible(doc.visibilityState === "visible"));
      const online = () => this.held.forEach((h) => h.engine.online());
      this.win.addEventListener("pagehide", hide);
      this.win.addEventListener("online", online);
      doc.addEventListener("visibilitychange", seen);
      // a link out of the app opens a new window, and no link reloads the page under a note that is on
      const offLinks = hookLinks(this.win, { busy: () => this.busy() });
      this.unhook = () => {
        offLinks();
        this.win?.removeEventListener("pagehide", hide);
        this.win?.removeEventListener("online", online);
        doc.removeEventListener("visibilitychange", seen);
        this.unhook = undefined;
      };
    }
    return () => this.unhook?.();
  }

  /**
   * After a reload: every note kept in this browser is offered again, paused, whatever page opens first: a chat's, and
   * (the owner 25 Nov: "I click voice, and then I follow the link ... and then I click back, and
   * then I land where the voice note started") a card's. His installed phone app goes to the back while the link's page
   * is in front, and the phone may reload it there; a card's note, held only in memory, was lost with the page. Now it is
   * kept like a chat's, comes back paused on its card (Resume or Send), and the pill links back to where it started.
   * Left alone it sends by itself to that card, or to the card's row when the card is no longer shown.
   */
  restore() {
    let keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(OPEN_KEY)) keys.push(k.slice(OPEN_KEY.length));
      }
    } catch {
      keys = [];
    }
    for (const key of keys) {
      // a chat's note is kept under its route (`/api/voice`); every other kept note is a card's (`review:<id>:changes`)
      const m = keptCard(key);
      if (!m) {
        if (key.startsWith("/")) this.note(key);
        else localNoteStore(key).clear();
        continue;
      }
      const h = this.note(key, { fill: true, base: m.base, to: m.to });
      h.route = m.route;
      h.page = m.page;
      h.card = m.card;
      h.words = (n) => cardWords(n);
      // the card is not on screen yet: its press refuses, so the note goes to the card's row (or the Team desk).
      // When the card shows, its own control replaces this with the card's press (useNote).
      h.deliver = () => Promise.reject(new Error("the card was not on screen when the note was sent"));
      void h.engine.recover();
    }
  }

  /** The note held for `key`, if any (a card's control looks before it makes one). */
  get(key: string, api?: NotesApi): HeldNote | undefined {
    const h = this.held.get(key);
    return h && h.given === api ? h : undefined;
  }

  /** The tab's note for `key` (made on first use; a chat's kept note is offered again). */
  note(key: string, o: NoteOpts = {}): HeldNote {
    const had = this.get(key, o.api);
    if (had) return had;
    const base = o.base ?? (key.startsWith("/") ? key : "/api/voice");
    // A chat's open note is kept in browser storage, and a card's too (under its own origin, so a reload of
    // the installed app while a link's page is in front never loses it). Tests: memory.
    const store = o.store ?? (o.api ? memoryNoteStore() : o.fill ? localNoteStore(key) : localNoteStore(base));
    let route: string | undefined;
    if (!o.api)
      try {
        route = localStorage.getItem(ROUTE_KEY(key)) ?? undefined;
      } catch {
        /* storage off */
      }
    // the recorder's code is fetched on his first tap (or for a note kept from before a reload), never with the page
    const build = (m: Awaited<ReturnType<typeof noteEngineCode>>, first?: Promise<MediaStream>) => {
      const api = o.api ?? m.fetchNotesApi(base, undefined, o.fill ? { fill: true } : {});
      const media = withFirstMic(o.media ?? m.browserNoteMedia(), first);
      const engine = new m.NoteEngine(api, media, o.clock, store, o.api ? undefined : { store: outbox(), base, ...(o.fill ? { fill: true } : {}), ...(o.to ? { to: o.to } : {}) });
      return { engine, unused: media.unused };
    };
    const mic = o.media ? () => o.media!.microphone() : noteMicrophone;
    const h: HeldNote = { key, base, given: o.api, to: o.to ?? "Chat", docks: 0, route, engine: new LazyNote(noteEngineCode, build, store, mic) };
    h.engine.subscribe((v) => this.seen(h, v));
    this.held.set(key, h); // no change event: this may run while a page renders
    if (!o.fill) void h.engine.recover();
    return h;
  }

  private phases = new WeakMap<HeldNote, NotePhase>();
  /** A note changed: a card's note that was just written out goes to its card. Each control follows its own note's ticks. */
  private seen(h: HeldNote, v: NoteView) {
    const was = this.phases.get(h);
    this.phases.set(h, v.phase);
    if (v.phase === "sent" && v.note && h.deliver && !h.out) {
      const n = v.note;
      h.engine.dismiss();
      if (n.state === "empty" || !n.transcript?.trim()) {
        h.out = { state: "empty", ...(v.info === EMPTY_RECORDING_TEXT ? { error: EMPTY_RECORDING_TEXT } : {}) };
        this.rowEmpty(h, v.info === EMPTY_RECORDING_TEXT ? EMPTY_RECORDING_TEXT : "Nothing was heard, so nothing was sent");
      } else void this.send(h, n);
      this.later(h);
    }
    // E948-S174: written out failed on a collapsed card: the row says why with Send again (a note kept on the phone
    // sends by itself, so its row keeps spinning)
    if (was !== v.phase && v.phase === "failed" && h.row && v.info !== KEPT_FAILED_TEXT) this.rowFailed(h, v.error ?? "it could not be written out");
    if (was !== v.phase) this.changed();
  }

  /**
   * E948-S174 (the owner 22 Nov 18:56Z, vn_3b3cf02e: "the moment I press Send, it compacts into this row. It's just that
   * instead of saying Sent, it stays spinning until it fully has been sent"):
   *
   *   [ the card, Voice recording ]  ──Send──▶  [ ◌ Sending · Voice note · its title ]  ──card has it──▶  [ ✓ Sent · … ]
   *                                                    └── failed ──▶  [ Not sent · why · Send again ]
   *
   * Send on a card's note collapses the card to its one row at once (no button spinner on a big card, no floating pill);
   * the row spins while the note is written out and handed to the card's press, then turns green Sent.
   */
  finish(h: HeldNote) {
    if (h.deliver && h.slot) this.collapse(h, h.slot);
    void h.engine.finish();
  }
  /** Send again from the row: the row spins again, the note goes the way it failed (its card's press, or written out again). */
  retry(key: string) {
    const h = this.held.get(key);
    if (!h) return;
    if (h.out?.state === "failed" && h.out.note) {
      if (h.row) this.collapse(h, h.row);
      void this.send(h, h.out.note);
    } else {
      if (h.row) h.slot = h.row;
      this.finish(h);
    }
  }
  private collapse(h: HeldNote, slot: string) {
    h.row = slot;
    markSent(slot, { said: "Voice note", title: h.to, voice: h.key });
    this.changed();
  }
  /** ours = the row still shows this note on its way (the card's own press did not mark it with its own words yet) */
  private ours(h: HeldNote) {
    return !!h.row && sentOf(h.row)?.voice === h.key;
  }
  private rowDone(h: HeldNote, said: string) {
    if (this.ours(h)) markSent(h.row!, { said, title: h.to });
  }
  private rowFailed(h: HeldNote, why: string) {
    if (h.row) markSent(h.row, { said: "Voice note", title: h.to, voice: h.key, failed: why });
  }
  /** nothing to send (an empty recording, nothing heard): the row says so plainly, Bring it back shows the card again */
  private rowEmpty(h: HeldNote, said: string) {
    if (this.ours(h)) markSent(h.row!, { said, title: h.to, dropped: true, back: async () => ({ back: true, line: "" }) });
  }

  /** Hand a written-out note to its card's press; a failure stays on the control with Send again. */
  async send(h: HeldNote, n: SentNote) {
    h.out = { state: "sending", note: n };
    this.changed();
    try {
      await h.deliver!(n);
      h.out = { state: "done", note: n };
      this.rowDone(h, "Voice note sent");
      this.later(h);
    } catch (e) {
      const why = (e as Error).message || "the card did not answer";
      // a card never refuses his note. When its press does not take it (the row moved on, a gate, a bad field),
      // the note lands on the card's own row as his note on that card, and the row's owner is woken with it.
      if (this.toCard && h.card && h.words) {
        this.changed();
        try {
          await this.toCard(h.card, h.words(n), `card-note:${n.id}`);
          h.out = { state: "card", error: why, note: n };
          this.rowDone(h, OUT_CARD_SAID);
          this.later(h);
          this.changed();
          return;
        } catch {
          /* the row could not be written: the Team desk next, whole */
        }
      }
      // his words never end at a refusal. The note is already in his memory (the
      // console forwards every card note once transcribed); the card's part goes to the Team desk whole, keyed on the note.
      if (this.toDesk && h.words) {
        this.changed();
        try {
          await this.toDesk(`Feedback on ${h.page ?? h.to} (the card did not take it: ${why}): ${h.words(n)}`, h.page, `card-note:${n.id}`);
          h.out = { state: "desk", error: why, note: n };
          this.rowDone(h, "Your words went to the Team desk");
          this.later(h);
          this.changed();
          return;
        } catch {
          /* the desk is down too: it stays failed with Send again, his words kept on the note */
        }
      }
      h.out = { state: "failed", error: why, note: n };
      this.rowFailed(h, why);
    }
    this.changed();
  }

  /** A landed or empty card note says so for a few seconds, then its line goes. */
  private later(h: HeldNote) {
    if (h.out?.state !== "done" && h.out?.state !== "empty" && h.out?.state !== "desk" && h.out?.state !== "card") return;
    const was = h.out;
    setTimeout(() => {
      if (h.out === was) this.forget(h);
    }, h.out.state === "desk" || h.out.state === "card" ? DESK_SHOW_MS : SENT_SHOW_MS);
  }

  /** Done with a note: its line goes (and a card's holder with it, if no control shows it). */
  forget(h: HeldNote) {
    h.out = undefined;
    if (h.deliver && !h.given && !noteOn(h.engine.view().phase)) keepCard(h.key, undefined);
    if (h.engine.view().phase === "sent" || h.engine.view().phase === "failed") h.engine.dismiss();
    if (h.deliver && h.docks === 0 && h.engine.view().phase === "idle" && this.held.get(h.key) === h) this.held.delete(h.key);
    this.changed();
  }

  /** A control shows `h` while mounted. */
  dock(h: HeldNote): () => void {
    h.docks++;
    this.changed();
    return () => {
      h.docks--;
      if (h.deliver && h.docks === 0 && h.engine.view().phase === "idle" && !h.out && this.held.get(h.key) === h) this.held.delete(h.key);
      this.changed();
    };
  }
  /** The note was started on `route`: the pill links back there. */
  started(h: HeldNote, route: string | undefined) {
    h.route = route;
    h.out = undefined;
    h.row = undefined;
    if (route && !h.given && !h.deliver)
      try {
        localStorage.setItem(ROUTE_KEY(h.key), route);
      } catch {
        /* storage off */
      }
    if (!h.given && h.deliver && !h.key.startsWith("/")) keepCard(h.key, { base: h.base, to: h.to, route, page: h.page, card: h.card });
    this.changed();
  }

  /** Notes on that no page shows: the floating pill's. */
  floating(): HeldNote[] {
    // E948-S174: a note whose card collapsed to its row shows there, never a second time floating
    return [...this.held.values()].filter((h) => h.docks === 0 && !(h.row && sentOf(h.row)) && (!!h.out || SHOWN.includes(h.engine.view().phase)));
  }

  /** a note is recording, paused, sending or failed (its words not yet landed) somewhere in the tab: a new build waits. */
  busy(): boolean {
    return [...this.held.values()].some((h) => {
      const p = h.engine.view().phase;
      return noteOn(p) || p === "sending" || p === "failed" || h.out?.state === "sending" || h.out?.state === "failed";
    });
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
}

/** Pages rendered without the app (tests, one page alone) share this one. */
let fallback: NoteTab | undefined;
const fallbackTab = () => {
  if (!fallback) {
    fallback = new NoteTab();
    fallback.hook();
  }
  return fallback;
};

const Ctx = createContext<NoteTab | undefined>(undefined);

/** The app's voice-note owner: wraps the router (App.tsx), so no page change ever stops a note. */
export function NoteProvider(props: { children: ReactNode; tab?: NoteTab }) {
  const [tab] = useState(() => props.tab ?? new NoteTab(undefined, deskFallback, cardFallback));
  useEffect(() => {
    const off = tab.hook();
    if (!props.tab) tab.restore();
    // notes kept on this phone (a reload, a closed tab, a console restart) are sent now, once each.
    const offOut = props.tab ? undefined : startOutbox();
    return () => {
      off();
      offOut?.();
    };
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={tab}>{props.children}</Ctx.Provider>;
}

export function useNoteTab(): NoteTab {
  return useContext(Ctx) ?? fallbackTab();
}

export const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The live dot: pulsing red while recording (steady with reduced motion), grey when paused. */
export function LiveDot({ phase }: { phase: NotePhase }) {
  const rec = phase === "recording";
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden data-testid="note-dot">
      {rec && <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500/70 motion-reduce:hidden" />}
      <span className={cn("relative inline-flex size-2.5 rounded-full", rec ? "bg-red-600" : "bg-muted-foreground")} />
    </span>
  );
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * the live level of the note's microphone, a small bar that fills 0 to 100 with the number beside it.
 * It reads the engine's AnalyserNode (the recording's own stream) about 12 times a second: up at once, down slowly, so a word
 * shows. With reduced motion the bar goes and the number alone changes, twice a second. The strip and the floating pill use it.
 */
export function LevelMeter({ engine, phase, value = 0, tid = "note" }: { engine?: Pick<LazyNote, "readLevel">; phase: NotePhase; value?: number; tid?: string }) {
  const [reduce] = useState(reducedMotion);
  // what the meter last sampled; until its first sample (and in tests, whose clock is fake) the engine's own tick
  const [sampled, setSampled] = useState<number>();
  const rec = phase === "recording";
  useEffect(() => {
    setSampled(undefined);
    if (!rec || !engine) return;
    let shown = 0;
    const t = setInterval(
      () => {
        const now = Math.round(engine.readLevel() * 100);
        shown = now >= shown ? now : Math.max(now, Math.floor(shown * 0.82));
        setSampled(shown);
      },
      reduce ? 500 : 80,
    );
    return () => clearInterval(t);
  }, [engine, rec, reduce]);
  const lv = rec ? (sampled ?? Math.round(value * 100)) : 0;
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={lv}
      aria-label={`input level ${lv}%`}
      title="How loud the microphone hears you, 0 to 100"
      className="flex shrink-0 items-center gap-1.5"
      data-testid={`${tid}-level`}
      data-level={lv}
    >
      {!reduce && (
        <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-muted-foreground/25" aria-hidden data-testid={`${tid}-level-bar`}>
          <span className={cn("absolute inset-y-0 left-0 rounded-full", lv >= 85 ? "bg-amber-500" : "bg-red-600")} style={{ width: `${lv}%` }} />
        </span>
      )}
      <span className="w-6 text-right text-[11px] tabular-nums text-muted-foreground" data-testid={`${tid}-level-num`}>
        {lv}
      </span>
    </span>
  );
}

/**
 * Cancel: throws the note away. A note of a minute or more asks once ("Throw away 1:12?" Discard / Keep), so a stray tap never
 * loses a long note; the question goes after 5 s.
 */
export function CancelNote({ engine, elapsedS }: { engine: Pick<LazyNote, "discard">; elapsedS: number }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(t);
  }, [asking]);
  if (asking)
    return (
      <span className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Throw away this voice note?">
        <span className="text-xs">Throw away {clockOf(elapsedS)}?</span>
        <Button type="button" size="sm" variant="destructive" className={cn(PHONE_TAP, "h-7")} data-testid="note-discard-confirm" onClick={() => void engine.discard()}>
          Discard
        </Button>
        <Button type="button" size="sm" variant="outline" className={cn(PHONE_TAP, "h-7")} data-testid="note-discard-keep" onClick={() => setAsking(false)}>
          Keep
        </Button>
      </span>
    );
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(PHONE_TAP, "h-7 shrink-0 gap-1 text-muted-foreground")}
      aria-label="Cancel: throw this voice note away"
      data-testid="note-discard"
      onClick={() => (elapsedS >= CONFIRM_CANCEL_S ? setAsking(true) : void engine.discard())}
    >
      <X /> Cancel
    </Button>
  );
}

/** a note the card's press did not take, written on the card's own row instead (its owner told). */
export const OUT_CARD_TEXT = "✓ Your words are on the card, and its owner was told.";
/** the card's Sent row for it. */
export const OUT_CARD_SAID = "Your words are on the card";
/** a refused card note, sent to the Team desk instead. */
export const OUT_DESK_TEXT = "✓ The Team desk has all your words, and they are in your memory. The card itself did not take them.";
/** card and desk both refused: his words are still in his memory (forwarded when written out), never "Not sent". */
export const outFailedText = (why: string | undefined) => `Your words are in your memory. The card did not take them yet${why ? `: ${why}` : ""}. Send again.`;

/** What a delivered (card) note's line says on its way out. */
export const outText = (out: NonNullable<HeldNote["out"]>, to: string) =>
  out.state === "sending"
    ? `Sending your answer to ${to}…`
    : out.state === "done"
      ? `Sent to ${to}${/[.?!…]$/.test(to) ? "" : "."}`
      : out.state === "empty"
        ? out.error === EMPTY_RECORDING_TEXT
          ? `${EMPTY_RECORDING_TEXT}.`
          : "Nothing was heard, so nothing was sent."
        : out.state === "card"
          ? OUT_CARD_TEXT
          : out.state === "desk"
          ? OUT_DESK_TEXT
          : outFailedText(out.error);

/** One floating note: live dot, where it goes, the time, Send, Cancel, and the link back to the page it was started on. */
function Floating({ h, tab }: { h: HeldNote; tab: NoteTab }) {
  const sub = useMemo(() => (fn: () => void) => h.engine.subscribe(fn), [h]);
  const v: NoteView = useSyncExternalStore(sub, h.engine.view, h.engine.view);
  const on = noteOn(v.phase);
  const out = h.out;
  // A chat note sent from the pill says so for a few seconds, then the pill goes.
  useEffect(() => {
    if (v.phase !== "sent" || h.deliver) return;
    const t = setTimeout(() => h.engine.dismiss(), SENT_SHOW_MS);
    return () => clearTimeout(t);
  }, [v.phase, h]);
  const label = out
    ? outText(out, h.to)
    : v.phase === "starting"
      ? "Opening the microphone…"
      : v.phase === "paused"
        ? "Paused"
        : v.phase === "sending"
          ? h.deliver
            ? "Saved on this phone. Writing out what you said…"
            : "Saved on this phone, sending…"
          : v.phase === "sent"
            ? v.note?.state === "empty"
              ? "Nothing was heard, nothing posted"
              : `✓ Voice note sent to ${h.to}`
            : v.phase === "failed"
              ? v.error === MIC_BUSY_TEXT
                ? v.error
                : v.info === KEPT_FAILED_TEXT
                  ? WAITING_TEXT
                  : v.error?.startsWith("Not sent")
                    ? v.error
                    : `Not sent: ${v.error ?? ""}`
              : "Recording";
  const back = h.route ?? "/chat";
  // a note the console has not confirmed yet is kept on this device and goes by itself: never shown as lost.
  const kept = !out && v.phase === "failed" && v.info === KEPT_FAILED_TEXT;
  const failed = (out?.state === "failed" || v.phase === "failed") && !kept;
  // a card note that failed is already in his memory: said calmly, never in red.
  const calm = out?.state === "failed" || out?.state === "desk";
  return (
    <div
      role="region"
      aria-label="Voice note"
      data-testid="note-widget"
      data-phase={out ? `out-${out.state}` : kept ? "kept" : v.phase}
      data-key={h.key}
      className={cn(
        "flex items-center gap-2 rounded-full border bg-card/95 py-1.5 pl-3 pr-1.5 text-sm shadow-lg backdrop-blur max-sm:flex-wrap max-sm:rounded-2xl max-sm:p-2.5",
        on ? "border-red-500/50" : "border-border",
      )}
    >
      <LiveDot phase={v.phase} />
      <Link to={back} onClick={(e) => h.show && (e.preventDefault(), h.show())} data-testid="note-widget-back" className="min-w-0 flex-1 underline-offset-2 hover:underline max-sm:font-medium" title="Back to where you started this voice note">
        <span className={cn("block", kept ? "whitespace-normal font-medium text-amber-700 dark:text-amber-400" : "truncate", failed && !calm && "text-destructive", calm && "whitespace-normal text-amber-700 dark:text-amber-400", out?.state === "desk" && "text-foreground")} title={kept ? KEPT_FAILED_TEXT : undefined}>
          {label}
        </span>
        {!out && v.phase !== "sent" && (
          <span className="block truncate text-xs font-normal text-muted-foreground" data-testid="note-widget-to">
            to: {h.to}
          </span>
        )}
      </Link>
      {on && v.phase !== "starting" && <LevelMeter engine={h.engine} phase={v.phase} value={v.level} tid="note-widget" />}
      {!out && (
        <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="note-widget-time">
          {clockOf(v.phase === "sent" && v.note ? v.note.seconds : v.elapsedS)}
        </span>
      )}
      {(on || v.phase === "sending" || failed || kept || out?.state === "sending") && (
        <div className="flex shrink-0 items-center gap-1.5 max-sm:ml-auto">
          {v.phase === "paused" && (
            <Button size="sm" variant="outline" className={cn(PHONE_TAP, "h-8 gap-1 rounded-full")} data-testid="note-widget-resume" onClick={() => void h.engine.resume()}>
              <Play /> Resume
            </Button>
          )}
          {(on || v.phase === "failed") && v.phase !== "starting" && <CancelNote engine={h.engine} elapsedS={v.elapsedS} />}
          {(out?.state === "failed" || out?.state === "desk" || out?.state === "card") && (
            <Button size="sm" variant="ghost" className={cn(PHONE_TAP, "h-8")} data-testid="note-widget-close" onClick={() => tab.forget(h)}>
              <X /> Close
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            className={cn(PHONE_TAP, "h-8 gap-1 rounded-full max-sm:min-w-24")}
            data-testid="note-widget-send"
            disabled={v.phase === "starting"}
            pending={v.phase === "sending" || out?.state === "sending"}
            pendingLabel="Sending…"
            onClick={() => (out?.state === "failed" && out.note ? void tab.send(h, out.note) : tab.finish(h))}
          >
            <SendHorizontal /> {kept ? "Send now" : failed ? "Send again" : "Send"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Every page (inside the router): the notes on that no page shows, floating at the bottom in the thumb's reach, clear of the
 * top bar's pills and the Chat icon; on a computer bottom centre, clear of a call's widget (bottom right).
 */
export function NoteWidget() {
  const tab = useNoteTab();
  useSyncExternalStore(tab.subscribe, tab.snapshot, tab.snapshot);
  const notes = tab.floating();
  const kept = useKeptLine();
  if (!notes.length && !kept) return null;
  return (
    <div className="pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 flex max-w-[calc(100vw-1.5rem)] flex-col gap-2 max-sm:inset-x-3 max-sm:items-stretch sm:left-1/2 sm:-translate-x-1/2 sm:items-center">
      {kept && <div className="pointer-events-auto max-w-full">{kept}</div>}
      {notes.map((h) => (
        <div key={h.key} className="pointer-events-auto max-w-full">
          <Floating h={h} tab={tab} />
        </div>
      ))}
    </div>
  );
}

/**
 * notes kept on this phone that no control shows (recorded before a reload, a closed tab or a console restart) say
 * so in one small line until the console confirms them: "1 voice note saved on this phone, sending…", then "✓ Sent" a few
 * seconds.
 */
export function useKeptLine(): ReactNode {
  const st = useSyncExternalStore(subscribeOutbox, outboxState, outboxState);
  const [, tick] = useState(0);
  const fresh = !!st.sentAt && Date.now() - st.sentAt < SENT_SHOW_MS;
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => tick((x) => x + 1), SENT_SHOW_MS);
    return () => clearTimeout(t);
  }, [fresh, st.sentAt]);
  if (!st.waiting && !fresh) return null;
  const many = (n: number) => (n === 1 ? "1 voice note" : `${n} voice notes`);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const next = st.nextAt ? Math.max(1, Math.round((st.nextAt - Date.now()) / 60_000)) : 0;
  const why = offline ? "no connection" : next ? `next try in ${next} min` : "sending now";
  return (
    <div
      role="status"
      data-testid="note-kept"
      data-state={st.waiting ? "waiting" : "sent"}
      className="flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-sm shadow-lg backdrop-blur max-sm:rounded-2xl"
    >
      <span className={cn("relative inline-flex size-2.5 shrink-0 rounded-full", st.waiting ? "bg-amber-500" : "bg-emerald-600")} aria-hidden />
      <span className="min-w-0 truncate">{st.waiting ? `Waiting to send: ${many(st.waiting)} · ${why}` : `✓ Sent: ${many(st.sent)} confirmed by the console`}</span>
      {st.waiting > 0 && (
        <Link to={`/${ON_DEVICE_PATH}`} data-testid="note-kept-see" className="shrink-0 text-sm font-medium underline underline-offset-2">
          See
        </Link>
      )}
    </div>
  );
}
