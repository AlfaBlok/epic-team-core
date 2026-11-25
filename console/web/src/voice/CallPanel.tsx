import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CALL_TAP, PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import { useInRouterContext, useLocation } from "react-router-dom";
import type { EngineView, Media, VoiceApi } from "./engine";
import { busy, useCallTab } from "./CallProvider";

/** GET /api/voice/state: what the button needs before a call. */
export interface VoiceState {
  available: boolean;
  enabled: boolean;
  reason?: string;
  model?: string;
  monthUsd?: number;
  monthMinutes?: number;
  limits?: { monthCapUsd: number; callMaxMin: number };
  lastCall?: { costUsd: number; seconds: number; usdPerMin: number | null; endReason?: string; startedAt?: string };
  /** The world's call still on (any of its desks), from this tab or another. */
  activeCall?: { id: string; startedAt: string };
  /** voice calls are off (voice notes still work): no Call button. */
  callsOff?: boolean;
}

export const money = (v: number | undefined) => (v === undefined ? "–" : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`);
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const END_WORDS: Record<string, string> = {
  hangup: "Call ended.",
  quiet: "Hung up: the line was quiet.",
  bye: "You said bye, so the voice hung up.",
  call_limit: "Hung up at the 20-minute limit. You can call again.",
  month_cap: "Voice paused until the 1st: the month's cap is reached. Chat still works.",
  voice_off: "Voice was switched off in the console.",
  calls_off: "Calls are off. Send a voice note instead.",
  line_dropped: "The line dropped. Press Call to reconnect.",
  tab_closed: "Call ended.",
  ended_elsewhere: "Hung up from another page.",
};

const loadState = async (base = "/api/voice"): Promise<VoiceState | undefined> => {
  try {
    const r = await fetch(`${base}/state`);
    return r.ok ? ((await r.json()) as VoiceState) : undefined;
  } catch {
    return undefined; // no console answer (or a test page without fetch): no button
  }
};

/** What the Chat page places: the call bar (at the top, above the history panel) and the call's live lines (inside the history panel). */
export interface CallDock {
  /** The call bar, or undefined when this world has no voice. */
  bar?: ReactNode;
  /**
   * the compact Call (a phone icon and "Call", 44 px) for the page's header row, shown on a phone only. There the idle
   * bar folds away, so the history gets the screen; the bar comes back on a call ('s big Mute and Hang up) or to say why.
   */
  button?: ReactNode;
  /** This call's live lines, shown as the newest lines of the chat history while on a call. */
  live?: ReactNode;
  /** Changes whenever a live line appears or grows, so the history panel follows it. */
  liveKey: string;
  onCall: boolean;
}

/**
 * "Call the desk", laid out per and the owner's review of it: every call control sits in one bar at the top
 * of the Chat page, above the history panel (Call and the month's spend; on a call Mute, Hang up, the timer and what the call has
 * cost so far), the chat box alone at the bottom, and what is said on the call appears as the newest lines in the chat history panel, so there is no separate call window. The transcript
 * lands in the chat as a call when it ends.
 * on a phone (narrow, or turned sideways) the controls are 64 px tall with labels (upright: their own row below the status),
 * solid high-contrast colours, and Hang up sits apart from Mute (a wide gap, on the right) so a cold thumb does not end the call.
 */
export function useCallDock(
  props: {
    api?: VoiceApi;
    media?: (audio: HTMLAudioElement) => Media;
    state?: () => Promise<VoiceState | undefined>;
    onEnded?: () => void;
    /** the call routes' root: `/api/voice` (the Team desk) or `/api/milestones/<id>/voice` (a campaign chat). */
    base?: string;
    /** whom the button calls ("the desk", "the campaign desk"). */
    callee?: string;
    /** start the call by itself once the voice is available (a Team home card's Call); `onAutoStart` runs once it did. */
    autoStart?: boolean;
    onAutoStart?: () => void;
    /** the idle bar's line under Call (default: what to try on the desk's call). */
    hint?: string;
    /** what the floating call widget names besides the callee (a milestone's title). */
    where?: string;
  } = {},
): CallDock {
  const callee = props.callee ?? "the desk";
  const [st, setSt] = useState<VoiceState | undefined>();
  // the tab's engine for these routes, owned above the router (a call started here and still on when the page comes
  // back is this one); while this bar is mounted the floating widget leaves the call to it.
  const tab = useCallTab();
  const here = useHere();
  const [h] = useState(() => tab.call(props.base ?? "/api/voice", { api: props.api, media: props.media, callee, where: props.where }));
  const engine = h.engine;
  useEffect(() => tab.dock(h), [tab, h]);
  const start = () => {
    tab.started(h, here());
    return engine.start();
  };
  const [v, setV] = useState<EngineView>(engine.view());
  useEffect(() => {
    setV(engine.view());
    return engine.subscribe(setV);
  }, [engine]);
  const [stray, setStray] = useState<{ busy?: boolean; error?: string }>({});
  const refresh = () => void (props.state ?? (() => loadState(props.base)))().then(setSt);
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!props.autoStart || autoStarted.current || !st?.available || busy(v.phase)) return;
    autoStarted.current = true;
    void start();
    props.onAutoStart?.();
  }, [props.autoStart, st?.available, v.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownPhase = useRef(v.phase);
  useEffect(() => {
    if (shownPhase.current === v.phase) return; // a call that ended before this page came back is not news
    shownPhase.current = v.phase;
    if (v.phase === "ended" || v.phase === "failed") {
      refresh();
      props.onEnded?.();
    }
  }, [v.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCall = v.phase === "live" || v.phase === "connecting" || v.phase === "starting";
  const said = v.lines.filter((l) => l.who !== "tool");
  const liveKey = onCall ? `${said.length}|${said.at(-1)?.text.length ?? 0}|${v.hearing.length}|${v.speaking.length}|${v.phase}` : "";
  // the world's call is on, but not on this page's engine: a Hang up for it, never the dead-end "one call at a time".
  const other = st?.activeCall && !busy(v.phase) && v.callId !== st.activeCall.id ? st.activeCall : undefined;
  const hangUpOther = async (id: string) => {
    setStray({ busy: true });
    try {
      // Held by this tab on another page's routes (a campaign's chat, the desk): hang it up there, transcript and all.
      const mine = tab.all().find((x) => x.engine.view().callId === id && busy(x.engine.view().phase));
      if (mine) await mine.engine.hangup("hangup");
      else if (h.api.endActive) await h.api.endActive(id);
      setStray({});
      if (engine.view().error) engine.clearError();
    } catch (e) {
      setStray({ error: `Could not hang it up: ${(e as Error).message}` });
    }
    refresh();
  };
  // Not the owner's world, or no voice at all: no bar (a switched-off or capped voice says why).
  if (!st || (!st.available && !st.enabled && !st.reason)) return { liveKey, onCall };
  // calls off, no Call button and no bar.
  if (st.callsOff && !onCall) return { liveKey, onCall };

  const cap = st.limits?.monthCapUsd;
  const month = v.monthUsd ?? st.monthUsd;
  const note = (testid: string, text: ReactNode, tone: "warn" | "error" | "muted") => (
    <p data-testid={testid} className={cn("text-xs leading-snug", tone === "error" ? "text-destructive" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
      {text}
    </p>
  );

  const hasNotes = !!(st.reason || v.error || v.warn || v.endReason || v.notice || other || stray.error || st.lastCall?.endReason === "no_credit");
  // idle with nothing that needs the owner (a plain "Call ended" is not news): on a phone the bar folds away and the
  // header's compact Call stands for it.
  const quiet = !onCall && !other && !(st.reason || v.error || v.notice || stray.error || st.lastCall?.endReason === "no_credit");
  const bar = (
    <section
      data-testid="call-panel"
      data-on-call={onCall ? "true" : undefined}
      aria-label={`Call ${callee}`}
      className={cn("mb-2 rounded-md border px-2.5 py-2 transition-colors", onCall ? "border-emerald-500/50 bg-emerald-500/[0.07]" : "bg-card", quiet && "phone:hidden")}
    >
      <div className="flex items-center gap-2 phone:gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-3">
        <div className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground" data-testid="call-meter">
          {onCall ? (
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm phone:text-base">
              <span className="relative flex size-2 shrink-0" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-600" />
              </span>
              <span className="font-medium tabular-nums text-foreground phone:font-semibold">{v.phase === "live" ? `On call ${clock(v.elapsedS)}` : "Connecting…"}</span>
              <span className="tabular-nums" data-testid="call-cost">{money(v.costUsd)}</span>
              {v.listening ? (
                <span data-testid="call-listening" className="text-emerald-800 dark:text-emerald-300">
                  · listening: say “done” when finished
                </span>
              ) : (
                v.deskWaiting > 0 && <span className="text-amber-700 dark:text-amber-400">· asking the desk…</span>
              )}
            </p>
          ) : (
            <p className="phone:hidden">{props.hint ?? <>Talk to {callee}, in English or Spanish. Try “What’s waiting on me?”</>}</p>
          )}
          <p data-testid="call-month" className={cn("tabular-nums phone:text-sm", onCall && "phone:hidden")}>
            This month {money(month)}
            {cap ? ` of ${money(cap)}` : ""}
            {st.monthMinutes !== undefined && !onCall ? ` · ${st.monthMinutes} min` : ""}
            {!onCall && st.lastCall?.usdPerMin ? <span className="phone:hidden">{` · last call ${money(st.lastCall.costUsd)} (${money(st.lastCall.usdPerMin)}/min)`}</span> : null}
          </p>
        </div>
        {other ? (
          <Button
            data-testid="call-other-hangup"
            variant="destructive"
            className={cn(PHONE_TAP, CALL_TAP, "shrink-0 gap-1.5 max-sm:w-full phone:bg-red-700 phone:text-white")}
            disabled={stray.busy}
            onClick={() => void hangUpOther(other.id)}
          >
            <PhoneOff className={cn(stray.busy && "animate-pulse")} /> {stray.busy ? "Hanging up…" : "Hang up"}
          </Button>
        ) : !onCall ? (
          <Button
            data-testid="call-start"
            variant="outline"
            className={cn(
              PHONE_TAP,
              CALL_TAP,
              "shrink-0 gap-2 border-emerald-600/40 text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-300",
              // on a phone the header's compact Call starts it (this one would take a 64 px row)
              "phone:hidden",
            )}
            disabled={!st.available || v.phase === "ending"}
            onClick={() => void start()}
          >
            <Phone /> Call {callee}
          </Button>
        ) : (
          <div className="flex shrink-0 gap-2 phone:grid phone:grid-cols-2 phone:gap-10 phone:sm:[&>*]:min-w-36" data-testid="call-controls">
            <Button
              data-testid="call-mute"
              variant="outline"
              className={cn(
                PHONE_TAP,
                CALL_TAP,
                "gap-1.5 phone:border-2 phone:border-foreground/70 phone:text-foreground",
                v.muted && "phone:border-amber-600 phone:bg-amber-500/15",
              )}
              aria-pressed={v.muted}
              onClick={() => engine.setMuted(!v.muted)}
            >
              {v.muted ? <MicOff /> : <Mic />} <span>{v.muted ? "Unmute" : "Mute"}</span>
            </Button>
            <Button
              data-testid="call-hangup"
              variant="destructive"
              className={cn(PHONE_TAP, CALL_TAP, "gap-1.5 phone:bg-red-700 phone:text-white phone:hover:bg-red-800")}
              onClick={() => void engine.hangup("hangup")}
            >
              <PhoneOff /> Hang up
            </Button>
          </div>
        )}
      </div>
      {hasNotes && (
        <div className="mt-1.5 space-y-0.5">
          {other &&
            note(
              "call-other",
              `A call is still on (since ${other.startedAt.slice(11, 16)}Z), from another page or tab, so a new call can't start. Hang it up here.`,
              "warn",
            )}
          {stray.error && note("call-other-error", stray.error, "error")}
          {!st.available && st.reason && !onCall && note("call-reason", st.reason, "warn")}
          {!v.error && !onCall && st.lastCall?.endReason === "no_credit" &&
            note("call-no-credit", "The last try could not start: OpenAI's account has no credit left. Voice works again as soon as credit is added.", "warn")}
          {v.error && !other && note("call-error", v.error, "error")}
          {/* what happened while the phone was locked (held, reconnected, or ended). */}
          {v.notice && note("call-notice", v.notice, "warn")}
          {v.warn && onCall && note("call-warn", v.warn, "warn")}
          {!onCall && v.endReason && !v.notice && note("call-ended", `${END_WORDS[v.endReason] ?? "Call ended."} The transcript is in the chat below.`, "muted")}
        </div>
      )}
    </section>
  );

  const line = (who: "owner" | "voice", text: string, key: string, partial = false) => (
    <li key={key} className={cn("flex", who === "owner" ? "justify-end" : "justify-start")} data-testid={who === "owner" ? "call-line-you" : "call-line-desk"}>
      <p
        className={cn(
          "min-w-0 max-w-[92%] whitespace-pre-wrap rounded-lg border border-dashed px-3 py-2 text-sm [overflow-wrap:anywhere] sm:max-w-[85%]",
          who === "owner" ? "border-primary/40 bg-primary/[0.06]" : "border-emerald-600/40 bg-emerald-500/[0.06]",
          partial && "opacity-70",
        )}
      >
        {text}
      </p>
    </li>
  );
  const live = onCall ? (
    <>
      <li className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400" data-testid="call-divider">
        <span className="h-px flex-1 bg-emerald-500/30" />
        <span>On the call · said aloud</span>
        <span className="h-px flex-1 bg-emerald-500/30" />
      </li>
      <li className="contents" data-testid="call-captions" aria-live="polite">
        <ol className="contents">
          {said.map((l, i) => line(l.who === "owner" ? "owner" : "voice", l.text, `l${i}`))}
          {v.hearing && line("owner", v.hearing, "hearing", true)}
          {v.speaking && line("voice", v.speaking, "speaking", true)}
          {!said.length && !v.hearing && !v.speaking && (
            <li className="text-center text-sm text-muted-foreground">{v.phase === "live" ? "Listening… keep this screen on during the call." : "Connecting…"}</li>
          )}
        </ol>
      </li>
    </>
  ) : undefined;
  const button =
    !onCall && !other ? (
      <Button
        data-testid="call-start-compact"
        variant="outline"
        className="hidden h-11 shrink-0 gap-1.5 rounded-full border-emerald-600/50 px-4 text-emerald-800 hover:bg-emerald-500/10 phone:inline-flex dark:text-emerald-300 [&_svg]:size-[18px]"
        disabled={!st.available || v.phase === "ending"}
        aria-label={`Call ${callee}`}
        title={`Talk to ${callee}, in English or Spanish. This month ${money(month)}${cap ? ` of ${money(cap)}` : ""}.`}
        onClick={() => void start()}
      >
        <Phone /> Call
      </Button>
    ) : undefined;
  return { bar, button, live, liveKey, onCall };
}

/** Where this page is (path + query), for the widget's link back; a page outside a router (a test) reads the window's. */
function useHere(): () => string | undefined {
  // The router context never comes or goes for a mounted component, so the hook order is stable.
  const loc = useInRouterContext() ? useLocation() : undefined; // eslint-disable-line react-hooks/rules-of-hooks
  return () => (loc ? `${loc.pathname}${loc.search}` : typeof window === "undefined" ? undefined : `${window.location.pathname}${window.location.search}`);
}
