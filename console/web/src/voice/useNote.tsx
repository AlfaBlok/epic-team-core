import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { UNSAFE_LocationContext } from "react-router-dom";
import { Mic, Play, SendHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import type { NoteClock, NoteMedia, NotesApi, NoteStore, NoteView, SentNote } from "./noteEngine";
import { DEFAULT_MAX_MIN, KEPT_FAILED_TEXT, KEPT_TEXT, lengthText, MIC_BUSY_TEXT } from "./noteEngine";
import { useDeskVoiceBase } from "./deskBase";
import { CancelNote, clockOf, LevelMeter, LiveDot, noteOn, outText, useNoteTab, type HeldNote } from "./NoteProvider";

/**
 * The one voice control: Chat's composer and every card box that takes his words (Answer, Changes wanted,
 * Decline) use it. Tap the microphone, talk; the strip shows the pulsing red dot, the time, the level and the cost; tap Send
 * and the note goes where it was started (a chat posts it; a card sends it through its own button, no second press); Cancel
 * throws it away. The note is the tab's (NoteProvider): leave the page and it records on, the floating pill follows.
 */

const money = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
const money0 = (v: number) => money(Math.max(0, v));

/** The state the control needs: the voice switch and the month budget (GET <base>/state). */
export interface NoteState {
  enabled: boolean;
  monthUsd?: number;
  limits?: { monthCapUsd: number };
  /** The console could not be reached (no network, a phone page waking up, a 5xx): not an answer, so the box asks again. */
  unknown?: true;
}

/** Read once a minute for every control on the page (not once per card); a sent note reads it again. */
const STATE_TTL_MS = 60_000;
const stateCache = new Map<string, { at: number; p: Promise<NoteState | undefined> }>();
export function noteState(base: string, fresh = false): Promise<NoteState | undefined> {
  const c = stateCache.get(base);
  if (c && !fresh && Date.now() - c.at < STATE_TTL_MS) return c.p;
  // (the owner 2026-11-12: "Why microphone gone from this box??"): a failed read used to be kept for a minute as
  // "voice off", and a box read it only once, so one request lost while his phone woke the page hid every microphone on it
  // until a reload. Now only an answer is kept: a 4xx is the console saying no (another world, no voice here), while no
  // network or a 5xx is unknown, never kept, and the box asks again (useVoiceState).
  const p: Promise<NoteState | undefined> = fetch(`${base}/state`)
    .then((r) => (r.ok ? (r.json() as Promise<NoteState>) : r.status >= 500 ? Promise.reject(new Error(`voice state ${r.status}`)) : undefined))
    .catch((): NoteState => {
      if (stateCache.get(base)?.p === p) stateCache.delete(base);
      return { enabled: false, unknown: true };
    });
  stateCache.set(base, { at: Date.now(), p });
  return p;
}
export const clearNoteState = () => stateCache.clear();

/** After an unknown read the box asks again after these waits, then on focus, on coming back to the screen and on going online. */
export const STATE_RETRY_MS = [1_500, 5_000, 15_000, 45_000];

/**
 * The voice switch and month budget for one box (its microphone shows only when enabled): read when the box appears and
 * again after a sent note (`refresh` changes), and asked again while the console could not be reached, so a page that woke
 * up offline gets its microphone back by itself.
 */
export function useVoiceState(base: string, state: (() => Promise<NoteState | undefined>) | undefined, refresh?: unknown): NoteState | undefined {
  const [st, setSt] = useState<NoteState | undefined>();
  const read = (fresh = false) => (state ?? (() => noteState(base, fresh)))();
  const tries = useRef(0);
  useEffect(() => {
    let live = true;
    tries.current = 0;
    void read().then((s) => live && setSt(s));
    return () => {
      live = false;
    };
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (refresh) void read(true).then(setSt);
  }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!st?.unknown) {
      tries.current = 0;
      return;
    }
    let live = true;
    const again = () => void read().then((s) => live && setSt(s));
    const wait = STATE_RETRY_MS[tries.current++];
    const timer = wait === undefined ? undefined : setTimeout(again, wait);
    const seen = () => document.visibilityState === "visible" && again();
    window.addEventListener("focus", again);
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", seen);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("focus", again);
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** A card's reply: what he typed, then the spoken words, then which voice note they came from and its recording. */
export function withVoiceNote(typed: string, note: Pick<SentNote, "id" | "transcript" | "audio">): string {
  const words = [typed.trim(), note.transcript?.trim() ?? ""].filter(Boolean).join(" ");
  return `${words} (voice note ${note.id}${note.audio ? `, audio ${note.audio}` : ""})`;
}

const IDLE: NoteView = { phase: "idle", elapsedS: 0, level: 0, costUsd: 0, estUsd: 0, usdPerMin: 0.003, maxMin: DEFAULT_MAX_MIN, segments: 0, uploaded: 0 };
const nothing = () => () => undefined;
const idle = () => IDLE;

export interface NoteControl {
  /** The microphone (idle) or Send (recording); undefined when voice is off or this month's cap is reached. */
  button?: ReactNode;
  /** The line by the box while a note is on, on its way, sent, or failed. */
  strip?: ReactNode;
  /** A note is on or on its way: the box's own send waits. */
  busy: boolean;
  view: NoteView;
}

export function useNote(props: {
  /** The origin: a chat's note route, or `card:<id>` for a card's box. */
  origin: string;
  /** The note routes (`/api/voice`, a milestone's). */
  base?: string;
  /** Where Send lands it, for the floating pill ("Chat", the card's title). */
  to: string;
  /** The page hint the console keeps with the note. */
  page?: string;
  /** A card: the note is written out, then sent with this (the card's own press) as his reply. A chat: absent, it posts itself. */
  deliver?: (reply: string) => Promise<unknown>;
  /** A card: what is typed in its box now (it goes out before the spoken words). */
  typed?: string;
  /** The microphone's label ("Voice note", "Speak"). */
  idleLabel?: string;
  /** Test ids' prefix ("note" in Chat, "answer-voice" on cards). */
  tid?: string;
  /** E948-S60: the card feedback block's microphone, big and labelled on every screen (never an icon alone). */
  big?: boolean;
  disabled?: boolean;
  /** Chat: called as he taps Send (read the reply aloud needs the tap). */
  beforeSend?: () => void;
  /** Chat: more on the strip (Read the reply aloud). */
  extra?: ReactNode;
  api?: NotesApi;
  media?: NoteMedia;
  clock?: NoteClock;
  store?: NoteStore;
  state?: () => Promise<NoteState | undefined>;
}): NoteControl {
  const tab = useNoteTab();
  // no base named = this world's desk (the home world: /api/voice), so a card shows the same microphone in every skin.
  const deskBase = useDeskVoiceBase();
  const base = props.base ?? deskBase;
  const tid = props.tid ?? "note";
  const card = !!props.deliver;
  const opts = { base, fill: card, to: props.to, api: props.api, media: props.media, clock: props.clock, store: props.store };
  // A chat's note is held from the start (a kept note is offered again); a card's only once he speaks.
  const made = useMemo(() => (card ? undefined : tab.note(props.origin, opts)), [tab, props.origin]); // eslint-disable-line react-hooks/exhaustive-deps
  useSyncExternalStore(tab.subscribe, tab.snapshot, tab.snapshot);
  const held: HeldNote | undefined = made ?? tab.get(props.origin, props.api);
  const sub = useMemo(() => (held ? (fn: () => void) => held.engine.subscribe(fn) : nothing), [held]);
  const get = held ? held.engine.view : idle;
  const v = useSyncExternalStore(sub, get, get);
  useEffect(() => (held ? tab.dock(held) : undefined), [tab, held]);
  const loc = useContext(UNSAFE_LocationContext)?.location;

  // A card's reply goes out with what is typed at the moment the note is written out, through the card's latest press.
  const typed = useRef(props.typed ?? "");
  typed.current = props.typed ?? "";
  const deliver = useRef(props.deliver);
  deliver.current = props.deliver;
  const hook = (h: HeldNote) => {
    if (card) h.deliver = (n) => deliver.current!(withVoiceNote(typed.current, n));
    h.to = props.to;
  };
  if (held) hook(held);

  // read again after a sent note (its cost counts toward the month's cap)
  const st = useVoiceState(base, props.state, v.phase === "sent" || held?.out?.state === "done" ? `${v.phase}:${held?.out?.state}` : undefined);

  const out = held?.out;
  const on = noteOn(v.phase);
  const sending = v.phase === "sending" || out?.state === "sending";
  const busy = on || sending;
  if (!st?.enabled) return { busy, view: v };
  const cap = st.limits?.monthCapUsd;
  const capped = cap !== undefined && (st.monthUsd ?? 0) >= cap;
  if (capped && !busy && !out && v.phase === "idle") return { busy, view: v };

  const start = () => {
    const h = held ?? tab.note(props.origin, opts);
    hook(h);
    tab.started(h, loc ? loc.pathname + loc.search : undefined);
    void h.engine.start(props.page?.slice(0, 200));
  };
  const send = () => {
    props.beforeSend?.();
    void held?.engine.finish();
  };

  const button = (
    <Button
      type="button"
      data-testid={`${tid}-button`}
      variant={on ? "destructive" : props.big ? "outline" : "ghost"}
      className={cn(PHONE_TAP, "shrink-0 gap-1.5", props.big ? "h-11 px-4 text-sm font-medium [&_svg]:size-5" : on ? "max-sm:h-11 max-sm:px-3" : "max-sm:size-11 max-sm:px-0", card && !props.big && "h-8")}
      disabled={props.disabled || capped || sending || v.phase === "starting"}
      pending={sending}
      pendingLabel={<span className="max-sm:sr-only">Sending…</span>}
      aria-label={on ? `Send the voice note to ${props.to}` : "Record a voice note"}
      title={capped ? "Voice is paused until the 1st: the month's cap is reached." : on ? "Tap to send the note" : "Tap to start a voice note, tap Send when you are done"}
      onClick={() => (on ? send() : start())}
    >
      {/* while recording it is a labelled red Send on a phone too, never mistaken for the box's own send. */}
      {on ? <SendHorizontal /> : <Mic />}
      <span className={cn(!on && !props.big && "max-sm:sr-only")}>{on ? "Send note" : (props.idleLabel ?? "Voice note")}</span>
    </Button>
  );

  const failed = v.phase === "failed" || out?.state === "failed";
  const show = on || sending || v.phase === "sent" || failed || !!out;
  const strip = show ? (
    <div
      data-testid={`${tid}-strip`}
      data-phase={out ? `out-${out.state}` : v.phase}
      role="status"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs", !card && "mb-2", on ? "border-red-500/40 bg-red-500/[0.06]" : "bg-card")}
    >
      {on && (
        <>
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <LiveDot phase={v.phase} />
            {v.phase === "starting" ? "Opening the microphone…" : v.phase === "paused" ? "Paused" : "Recording"}
            <span className="tabular-nums" data-testid={`${tid}-timer`}>
              {clockOf(v.elapsedS)}
            </span>
          </span>
          <LevelMeter engine={held?.engine} phase={v.phase} value={v.level} tid={tid} />
          <span className="tabular-nums text-muted-foreground" data-testid={`${tid}-cost`}>
            ≈ {money0(v.estUsd)} · max {lengthText(v.maxMin)}
          </span>
          {v.phase === "paused" && (
            <Button type="button" size="sm" variant="outline" className={cn(PHONE_TAP, "h-7 gap-1")} data-testid={`${tid}-resume`} onClick={() => void held?.engine.resume()}>
              <Play /> Resume
            </Button>
          )}
          {v.phase === "recording" && (
            <span className="max-sm:hidden text-muted-foreground" data-testid={`${tid}-hint`}>
              other pages keep recording; what you say is saved on this phone; tap Send note when done
            </span>
          )}
          <span className="ml-auto">{held && <CancelNote engine={held.engine} elapsedS={v.elapsedS} />}</span>
        </>
      )}
      {v.phase === "sending" && <span data-testid={`${tid}-sending`}>{card ? "Saved on this phone. Writing out what you said…" : `Saved on this phone, sending… transcribing the last part ${clockOf(v.elapsedS)}`}</span>}
      {v.phase === "sent" && v.note && !card && (
        <span data-testid={`${tid}-sent`}>
          {v.note.state === "empty" ? "Nothing was heard, so nothing was posted." : `✓ Voice note sent · ${clockOf(v.note.seconds)} · ${money(v.note.costUsd)}. The desk answers it like typed text.`}
        </span>
      )}
      {out && (
        <span data-testid={`${tid}-out`} className={cn(out.state === "failed" && "text-destructive")}>
          {outText(out, "this card")}
        </span>
      )}
      {v.phase === "failed" && (
        // a microphone a call holds is no fault: said calmly, the button stays ready for when the call ends.
        <span className={v.error === MIC_BUSY_TEXT || v.info === KEPT_FAILED_TEXT ? "text-amber-700 dark:text-amber-400" : "text-destructive"} data-testid={`${tid}-error`}>
          {/* not confirmed yet is not lost: kept on this device and sent by itself. */}
          {v.info === KEPT_FAILED_TEXT ? KEPT_TEXT : v.error}
        </span>
      )}
      {((v.phase === "failed" && v.error?.startsWith("Not sent")) || (out?.state === "failed" && out.note)) && (
        <Button type="button" size="sm" variant="outline" className={cn(PHONE_TAP, "h-7")} data-testid={`${tid}-again`} onClick={() => (out?.note ? void tab.send(held!, out.note) : void held?.engine.finish())}>
          {v.info === KEPT_FAILED_TEXT ? "Send now" : "Send again"}
        </Button>
      )}
      {v.warn && on && (
        // the warning before the cap, in plain sight while he talks.
        <span role="alert" className="basis-full font-medium text-amber-700 dark:text-amber-400" data-testid={`${tid}-warn`}>
          {v.warn}
        </span>
      )}
      {v.info && (v.phase === "paused" || v.phase === "sent" || v.phase === "recording" || (v.phase === "failed" && v.info === KEPT_FAILED_TEXT)) && (
        <span className="basis-full text-muted-foreground" data-testid={`${tid}-info`}>
          {v.info}
        </span>
      )}
      {v.error && v.phase !== "failed" && <span className="basis-full text-amber-700 dark:text-amber-400">{v.error}</span>}
      {props.extra}
      {(v.phase === "sent" || failed) && (
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close" data-testid={`${tid}-close`} onClick={() => (held ? tab.forget(held) : undefined)}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  ) : undefined;
  return { button, strip, busy, view: v };
}
