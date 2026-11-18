/**
 * the browser side of "Call the desk". Audio goes straight from this page to OpenAI's realtime model over
 * WebRTC, opened with a 1-minute client key the console minted for this call (the real key stays on the server). The
 * data channel carries the model's events: this engine answers its two tools through the console (quick status, ask the
 * desk), forwards every `usage` it reports to the console's cost meter, keeps the captions and the transcript, and hangs
 * up on Hang up, the quiet timer, the 20-minute limit or a stop from the console (month cap, off switch).
 * after ~60 s with nobody speaking the voice warns once, then the call ends ("quiet"); when the owner says he is done
 * the voice says goodbye and calls hang_up, and the line closes once the goodbye has played ("bye").
 * listen mode: when the owner says he wants to give feedback the voice calls listen_for_feedback; from then on this engine
 * holds the turns (no automatic replies): now and then a pause gets one short acknowledgement ("Mm-hm."), else
 * silence; no desk answer is read, and on "done"
 * everything he said goes to the desk as one message, whose reply the voice confirms in one line ("Filed: …").
 */

import { callMediaSession, stickyWakeLock } from "./keepAwake";
import { ownerName } from "@/lib/identity";

export interface Limits {
  callMaxMin: number;
  callWarnMin: number;
  quietHangupS: number;
  /** Seconds before the idle hang-up that the voice warns (older consoles send none: 10). */
  quietWarnS?: number;
  /** in listen mode the call hangs up only after this long without his voice (default 180), the gentle check this long before (60). */
  listenQuietS?: number;
  listenWarnS?: number;
  monthCapUsd: number;
}
export interface CallInfo {
  id: string;
  costUsd: number;
  seconds: number;
  usdPerMin: number | null;
}
export interface StartAnswer {
  call: CallInfo & { startedAt: string };
  clientSecret: string;
  expiresAt: number;
  model: string;
  limits: Limits;
  /** The session's own turn detection, put back when listen mode ends (older consoles send none: NORMAL_TURN). */
  turnDetection?: Record<string, unknown>;
  /** the greeting this page has the voice say once (older consoles send none: the OPENING_NUDGE way). */
  greeting?: string;
}
export interface Line {
  who: "owner" | "voice" | "tool";
  text: string;
  at: string;
  /** his words held in listen mode, then the id of the one desk message that carried them (the transcript folds them). */
  feedback?: string;
}
export type Phase = "idle" | "starting" | "connecting" | "live" | "ending" | "ended" | "failed";

export interface EngineView {
  phase: Phase;
  muted: boolean;
  callId?: string;
  /** What the owner is saying now (partial) and the voice's words so far. */
  hearing: string;
  speaking: string;
  lines: Line[];
  costUsd: number;
  monthUsd?: number;
  elapsedS: number;
  warn?: string;
  error?: string;
  endReason?: string;
  /** Questions with the desk still open. */
  deskWaiting: number;
  /** listen mode is on (the voice only holds what he says until he says "done"). */
  listening?: boolean;
  /** what happened while the phone was locked (line held, reconnected, or ended), said on the call screen. */
  notice?: string;
}

/** The console calls this engine makes (fetch by default; tests fake them). */
/**
 * a call started from one inbox section (its phone button): the section, its cards as the page shows them, and
 * how the page presses his own button on one of them (the same calls its buttons make) once he said yes.
 */
export interface CallFocus {
  section: string;
  cards: Record<string, unknown>[];
  press?: (p: { id: string; kind: string; button: string; words?: string }) => Promise<string>;
}

export interface VoiceApi {
  start(focus?: { section: string; cards: Record<string, unknown>[] }): Promise<StartAnswer>;
  beat(id: string): Promise<{ call: CallInfo; monthUsd: number; stop?: string }>;
  usage(id: string, ev: { eventId: string; kind: "response" | "transcription"; usage: unknown }): Promise<{ call: CallInfo; monthUsd: number; stop?: string }>;
  end(id: string, body: { reason: string; transcript: Line[] }, beacon?: boolean): Promise<unknown>;
  status(id: string): Promise<{ text: string }>;
  ask(id: string, request: string, confirmed?: boolean, words?: string, kind?: "feedback"): Promise<{ askId: string }>;
  askState(id: string, askId: string): Promise<{ state: "queued" | "working" | "answered" | "failed"; answer?: string; partial?: string; waitedMs: number; spokenWaitMs: number }>;
  /** hang up the world's call this page does not hold (`id`: the state's activeCall). */
  endActive?(id: string): Promise<{ ended: boolean }>;
  /** a tool the console answers itself (the inbox walk: next_card, read_card). */
  tool?(id: string, name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** The media and WebRTC pieces (the browser's by default; tests fake them). */
export interface Media {
  microphone(): Promise<MediaStream>;
  peer(): RTCPeerConnection;
  /** POST the SDP offer to OpenAI with the client key; the SDP answer back. */
  exchange(sdp: string, clientSecret: string, model: string): Promise<string>;
  play(stream: MediaStream): void;
  wakeLock?(): Promise<{ release(): Promise<void> } | undefined>;
  /** the lock screen's call controls (media session); returns the undo. */
  session?(h: { hangup(): void; toggleMute(): void }): (() => void) | undefined;
}

/**
 * An iPhone mutes a hidden page's microphone, and a locked
 * phone may let the line drop. While the page is hidden the call is "away": the quiet timer does not count (his silence is the
 * lock, not him), and a line that drops is remembered. When the page is back in view the microphone is taken again if it went
 * mute, and a line that dropped while away reconnects by itself as a new call: the console's call memory gives the
 * voice the earlier talk, and the voice opens with RESUME_GREETING instead of its first-call greeting.
 */
export const RESUME_GREETING = "Sorry, we got cut off when your phone locked. I'm back. Where were we?";
/** A line that dropped while away reconnects on return only within this long; after it the screen says so and waits for Call. */
export const RECONNECT_WINDOW_MS = 15 * 60_000;
/** End reasons that a locked phone causes (anything else, his hang-up, the limits, a stop from the console, never reconnects). */
const AWAY_REASONS = new Set(["line_dropped", "quiet"]);
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** OpenAI's answer when the account behind the console's key has no credit left (429 insufficient_quota). */
export const NO_CREDIT = /credit_balance_exhausted|insufficient_quota|no credits remaining/i;
export const NO_CREDIT_TEXT = "OpenAI's account has no credit left, so the call could not start (nothing was charged). Voice works again as soon as credit is added.";
export const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const BEAT_MS = 20_000;
export const ASK_POLL_MS = 2_500;
/** After this the console stops checking a question; its reply is in Chat either way. */
export const ASK_GIVE_UP_MS = 10 * 60_000;
/**
 * kept the desk's reply as a silent note, said only when he asked. That
 * withheld three answers while he waited ("Noted.", "I don't know"). Each reply is now said at once, at his next pause, short
 * and warm; a reply that asks him something gives its answer first, then the question.
 */
/** What ask_the_desk returns to the model: the desk has it; one warm line if nothing was said yet, then listen. */
export const HANDOFF_NOTE =
  "The desk has it; do not send it again. If you have not said so yet, tell him in one short warm line ('Sure, I'll get the desk on that.'), then keep listening. When its answer comes, you tell him at once. Until then, if he asks, it's on its way: never 'I don't know'.";
export function deskReplyNote(short: string, answer: string): string {
  return `The desk replied to "${short}":\n${answer}\nTell him now, warmly and simply, in one to three short sentences: the answer first, in the desk's facts, no ids, no lists. Then let him talk.`;
}
export function deskQuestionNote(short: string, answer: string): string {
  return `The desk replied to "${short}" and needs his answer:\n${answer}\nTell him now, warmly and simply: the desk's answer in one or two short sentences, then its question, short (for "Shall I file both now?": "Shall I file both now?"). Nothing else.`;
}
/** A desk reply that needs his answer: it asks him something (ends on a question, or asks "shall I / want me to / yes or no"). */
export function needsHisAnswer(answer: string): boolean {
  const a = answer.trim();
  return /\?["')\]]*$/.test(a) || /\b(shall I|should I|want me to|do you want|yes or no)\b[^.!]*\?/i.test(a);
}
/** the voice speaks first, with the first line from its session instructions (the console holds the words). */
export const OPENING_NUDGE = "The call just connected. Say your first line now, once, word for word, then listen.";
/**
 * the greeting is said by one response of its own, once per call. While it plays, his voice or the
 * line's noise neither cuts it nor starts another reply; a second greeting (a second item in that response, or a later
 * response that starts with it) is cancelled before it is heard and kept out of the transcript.
 */
export const greetingInstructions = (line: string) => `Say exactly "${line}" once, and nothing else.`;
/** The greeting's turn-taking is put back after this long even if its end never arrives. */
export const GREETING_MAX_MS = 12_000;
const words = (t: string) => t.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
/** The words so far start the greeting (at least three of them, or all of a shorter greeting). */
export function startsGreeting(text: string, greeting: string): boolean {
  const t = words(text);
  const g = words(greeting);
  const n = Math.min(3, g.length);
  return g.length > 0 && t.length >= n && t.slice(0, g.length).every((w, i) => w === g[i]);
}
/**: the note that makes the voice say its idle warning (the words live in the session instructions). */
export const QUIET_NUDGE = "The line has been quiet. Say your quiet warning now, word for word, nothing else.";
/** After the idle warning, a voice still talking gets this long before the line closes anyway. */
export const QUIET_GRACE_MS = 15_000;
/** after hang_up the goodbye gets this long to play before the line closes anyway. */
export const BYE_MAX_MS = 8_000;

/** listen mode (call_bfdb5e0f): the tool the voice calls when he wants to give feedback, and every word it says in it. */
export const LISTEN_TOOL = "listen_for_feedback";
/** the tools the console answers itself (POST …/calls/:cid/tool): the inbox walk. */
export const CONSOLE_TOOLS = new Set(["next_card", "read_card", "press_card"]);
export const LISTEN_START_LINE = "I'm listening. Take your time, and say done when you're finished.";
/**
 * a few very
 * short acknowledgements in turn, only after a real pause and at most one per LISTEN_ACK_GAP_MS; otherwise the voice waits.
 */
export const LISTEN_ACKS = ["Mm-hm.", "Got it.", "Go on.", "Okay."];
/** After one of his turns, this much more silence before an acknowledgement (he is often only drawing breath). */
export const LISTEN_ACK_WAIT_MS = 2_000;
/** At most one acknowledgement in this long: between them the voice stays quiet. */
export const LISTEN_ACK_GAP_MS = 15_000;
/** A fixed line that runs this many words past its own is an ad-lib: cancelled and its audio cleared. */
export const FIXED_SLACK_WORDS = 3;
export const LISTEN_STILL_LINE = "Still with you, say done when finished.";
export const LISTEN_SEND_LINE = "Got it. Sending all of it to the desk now.";
export const LISTEN_EMPTY_LINE = "Nothing to send yet. Back to normal; ask me anything.";
export const LISTEN_QUIET_S = 180;
export const LISTEN_WARN_S = 60;
/** A longer pause ends one of his turns in listen mode, so a breath mid-sentence is not a turn. */
export const LISTEN_SILENCE_MS = 1200;
/** The session's turn detection when the console sends none (voice.ts sessionConfig). */
export const NORMAL_TURN = { type: "server_vad", silence_duration_ms: 600, create_response: true, interrupt_response: true };
/** He is done: his turn ends with "done" / "finished" (alone, or as the last sentence), optionally "thanks". */
export const LISTEN_DONE = /(?:^|[.!?,;]\s*)(?:(?:ok(?:ay)?|right|so|and|that's it|that is it|that's all|that is all|vale|bueno)[,.]?\s*)*(?:(?:i'm|im|i am)\s+|(?:he|ya he)\s+)?(?:all\s+)?(?:done|finished|terminado|acabado|listo|ya está)[.!]*(?:\s*,?\s*(?:thanks|thank you|gracias)[.!]*)?\s*$/i;
/** He asks the voice to say more (read back, expand): the one time it says more than the acknowledgement. */
export const LISTEN_EXPAND = /\b(?:expand|say more|tell me more|read (?:it|that|them|this|everything|my \w+) back|repeat (?:it|that|them|back)|what (?:have|did) you (?:got|get|noted|heard)|what do you have so far)\b/i;
/** He ends the call from listen mode: his words go first, then the goodbye. */
const ownerWord = ownerName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const LISTEN_BYE = new RegExp(`(?:^|[.!?,;]\\s*)(?:(?:ok(?:ay)?|right|so|thanks|thank you)[,.]?\\s*)*(?:bye|goodbye|bye-bye|hang up|adiós|cuelga)[.!]*(?:\\s*,?\\s*(?:${ownerWord}|thanks|thank you)[.!]*)?\\s*$`, "i");
const sayExactly = (line: string) => `Say exactly "${line}" and nothing else.`;

const iso = () => new Date().toISOString();
/** A line the voice says word for word. `oob`: out of band, with no conversation in front of it (nothing to answer). */
interface Speak {
  instructions: string;
  line?: string;
  oob?: boolean;
}

const busyPhase = (p: Phase) => p === "starting" || p === "connecting" || p === "live" || p === "ending";

export class CallEngine {
  private v: EngineView = { phase: "idle", muted: false, hearing: "", speaking: "", lines: [], costUsd: 0, elapsedS: 0, deskWaiting: 0 };
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  private lock?: { release(): Promise<void> };
  private timers: ReturnType<typeof setInterval>[] = [];
  private startedAt = 0;
  private lastActivity = 0;
  private limits?: Limits;
  private warned = false;
  private responding = false;
  private userSpeaking = false;
  /** The voice's audio is playing on the owner's side (output_audio_buffer.started … stopped). */
  private playing = false;
  /** The current response has spoken words (a goodbye before hang_up). */
  private spoke = false;
  /** When the idle warning was given; his voice (or a desk answer) after it cancels the hang-up. */
  private quietWarnAt?: number;
  private lastOwnerAt = 0;
  /** hang_up was called: the line closes when the goodbye has played. */
  private byeAt?: number;
  private nudges: { text: string; instructions?: string; toolChoice?: "none" }[] = [];
  private pendingCalls: { call_id: string; name: string; arguments: string }[] = [];
  private asks = new Set<string>();
  /** Index in lines of the first of the owner's words not yet sent to the desk with a question. */
  private wordsFrom = 0;
  /** listen mode. `held` = his words since it began; `pre` = turns he started before it (not feedback). */
  private listen?: { since: number; held: { text: string; line: number }[]; warned: boolean; pre: Set<string>; ackDue?: number; lastAck?: number; acks: number };
  /** Turns he started whose transcription has not come yet (item ids). */
  private pendingItems = new Set<string>();
  private turnDetection: Record<string, unknown> = NORMAL_TURN;
  /** A listen-mode line asked for while a response runs: said when it ends (a second response.create would be refused). */
  private queuedSpeak?: Speak;
  /** the word count of the fixed line the next response / the running response must say (ad-lib guard). */
  private fixedNext?: number;
  private fixedNow?: number;
  /** the greeting line, its response and items; `done` once it has played (turn-taking back to normal). */
  private greeting?: string;
  private greet?: { at: number; respId?: string; respDone: boolean; item?: string; done: boolean };
  /** Items whose words are a second greeting: cancelled, not shown, not in the transcript. */
  private dropped = new Set<string>();
  /** The words so far of each item the voice is saying (to catch a second greeting early). */
  private saying = new Map<string, string>();
  /** The held feedback on its way to the desk: the hang-up waits for it, so the transcript knows it was sent. */
  private sending?: Promise<string | undefined>;
  /** the page is hidden (phone locked, app switched) since this time. */
  private away?: number;
  /** the line closed while away (reason, when): reconnect on return. */
  private droppedAway?: { reason: string; at: number; since: number };
  private unsession?: () => void;
  private listeners = new Set<(v: EngineView) => void>();

  constructor(
    private api: VoiceApi,
    private media: Media,
    private clock: { now: () => number; every: (fn: () => void, ms: number) => ReturnType<typeof setInterval>; stop: (t: ReturnType<typeof setInterval>) => void } = {
      now: () => Date.now(),
      every: (fn, ms) => setInterval(fn, ms),
      stop: (t) => clearInterval(t),
    },
  ) {}

  view(): EngineView {
    return this.v;
  }
  subscribe(fn: (v: EngineView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(p: Partial<EngineView>) {
    this.v = { ...this.v, ...p };
    for (const l of this.listeners) l(this.v);
  }
  private line(who: Line["who"], text: string) {
    const t = text.trim();
    if (t) this.set({ lines: [...this.v.lines, { who, text: t, at: iso() }] });
  }

  /** the section the next call starts with (kept for a reconnect of that call; cleared by a plain start). */
  private focus?: CallFocus;
  /** start a call holding one inbox section's cards (its phone button). */
  startFocused(focus: CallFocus): Promise<void> {
    if (this.v.phase === "starting" || this.v.phase === "connecting" || this.v.phase === "live") return Promise.resolve();
    this.focus = focus;
    return this.start({ focused: true });
  }

  async start(o: { notice?: string; resumed?: boolean; focused?: boolean } = {}): Promise<void> {
    if (this.v.phase === "starting" || this.v.phase === "connecting" || this.v.phase === "live") return;
    if (!o.focused && !o.resumed) this.focus = undefined;
    this.droppedAway = this.away = undefined;
    this.set({ phase: "starting", error: undefined, warn: undefined, endReason: undefined, lines: [], hearing: "", speaking: "", costUsd: 0, elapsedS: 0, callId: undefined, deskWaiting: 0, notice: o.notice });
    try {
      // Microphone first: a refused permission costs nothing (no key minted, no call row).
      this.mic = await this.media.microphone();
      const s = this.focus ? await this.api.start({ section: this.focus.section, cards: this.focus.cards }) : await this.api.start();
      this.limits = s.limits;
      this.turnDetection = s.turnDetection ?? NORMAL_TURN;
      this.greeting = o.resumed ? RESUME_GREETING : s.greeting?.trim() || undefined;
      this.set({ callId: s.call.id, phase: "connecting" });
      const pc = (this.pc = this.media.peer());
      pc.ontrack = (e) => this.media.play(e.streams[0]);
      for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      const dc = (this.dc = pc.createDataChannel("oai-events"));
      dc.onmessage = (e) => this.onEvent(e.data);
      dc.onopen = () => this.onOpen();
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") void this.hangup("line_dropped");
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await this.media.exchange(offer.sdp ?? "", s.clientSecret, s.model);
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      this.lock = (await this.media.wakeLock?.().catch(() => undefined)) ?? undefined;
      this.unsession = this.media.session?.({ hangup: () => void this.hangup("hangup"), toggleMute: () => this.setMuted(!this.v.muted) }) ?? undefined;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      const noCredit = NO_CREDIT.test(msg);
      this.cleanupMedia();
      if (this.v.callId) await this.api.end(this.v.callId, { reason: noCredit ? "no_credit" : "failed", transcript: this.v.lines }).catch(() => undefined);
      this.set({ phase: "failed", error: noCredit ? NO_CREDIT_TEXT : msg });
    }
  }

  private onOpen() {
    this.startedAt = this.lastActivity = this.clock.now();
    this.set({ phase: "live" });
    if (this.greeting) {
      // the greeting is this page's one response, its words fixed. Until it has played nothing cuts it or answers
      // over it: no turn detection at all (call_e7c957e4: with replies and interruptions off, noise still cleared it at
      // 0.8 s, because a speech start clears audio still playing), and what the microphone heard meanwhile is dropped.
      // over it (noise at the start of call_3a1918ff / call_7415c108); his words meanwhile are answered after it.
      this.setTurns(null);
      this.greet = { at: this.clock.now(), respDone: false, done: false };
      this.fixedNext = words(this.greeting).length;
      this.send({ type: "response.create", response: { instructions: greetingInstructions(this.greeting), tool_choice: "none" } });
    } else {
      // Older consoles: the voice speaks first with the line from its session instructions.
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: OPENING_NUDGE }] } });
      // No tool on this turn: on call_d73ab8f9 the voice ran quick status before it said what it is.
      this.send({ type: "response.create", response: { tool_choice: "none" } });
    }
    this.responding = true;
    this.timers.push(this.clock.every(() => this.tick(), 1000));
    this.timers.push(this.clock.every(() => void this.beat(), BEAT_MS));
  }

  private tick() {
    if (this.v.phase !== "live" || !this.limits) return;
    const now = this.clock.now();
    const elapsedS = Math.floor((now - this.startedAt) / 1000);
    this.set({ elapsedS });
    if (this.greet && !this.greet.done && now - this.greet.at >= GREETING_MAX_MS) this.greeted();
    if (elapsedS >= this.limits.callMaxMin * 60) return void this.hangup("call_limit");
    if (!this.warned && elapsedS >= this.limits.callWarnMin * 60) {
      this.warned = true;
      this.set({ warn: `${this.limits.callMaxMin - this.limits.callWarnMin} minutes left on this call. You can call again after.` });
      this.nudge(`Time is nearly up: two minutes left on this call. Tell ${ownerName()} in one short sentence; he can call again.`);
    }
    if (this.byeAt !== undefined) {
      if ((!this.responding && !this.playing) || now - this.byeAt >= BYE_MAX_MS) void this.hangup("bye");
      return;
    }
    // the phone is locked; his silence is the lock. The quiet timers wait for the page to be back.
    if (this.away !== undefined) return;
    if (this.listen) {
      // Listen mode: he may pause to think. Only his own voice counts; one gentle check, then the line closes, his words sent.
      const quiet = this.userSpeaking ? 0 : now - Math.max(this.lastOwnerAt, this.listen.since);
      const limitMs = (this.limits.listenQuietS ?? LISTEN_QUIET_S) * 1000;
      if (quiet >= limitMs) return void this.hangup("quiet");
      const l = this.listen;
      if (l.ackDue !== undefined && now >= l.ackDue && !this.userSpeaking && !this.responding) {
        l.ackDue = undefined;
        l.lastAck = now;
        this.speak(LISTEN_ACKS[l.acks++ % LISTEN_ACKS.length], undefined, true);
      }
      if (!this.listen.warned && quiet >= limitMs - (this.limits.listenWarnS ?? LISTEN_WARN_S) * 1000) {
        this.listen.warned = true;
        this.line("tool", "listen mode: still with you");
        if (!this.responding) this.speak(LISTEN_STILL_LINE);
      }
      return;
    }
    const quietMs = this.limits.quietHangupS * 1000;
    const warnMs = (this.limits.quietWarnS ?? 10) * 1000;
    if (this.quietWarnAt !== undefined) {
      // The warning's own words are not activity: only the owner (or something new to say) keeps the call on.
      if (this.userSpeaking || this.lastOwnerAt > this.quietWarnAt) {
        this.quietWarnAt = undefined;
        this.lastActivity = now;
        return;
      }
      const since = now - this.quietWarnAt;
      if ((since >= warnMs && !this.responding && !this.playing) || since >= warnMs + QUIET_GRACE_MS) void this.hangup("quiet");
      return;
    }
    // Someone talking (the owner mid-sentence, the voice mid-answer) is never quiet, however long it lasts.
    if (this.userSpeaking || this.responding || this.playing) this.lastActivity = now;
    if (now - this.lastActivity >= quietMs) return void this.hangup("quiet");
    if (warnMs > 0 && now - this.lastActivity >= quietMs - warnMs) {
      this.quietWarnAt = now;
      this.line("tool", "quiet warning");
      this.nudge(QUIET_NUDGE, undefined, "none");
    }
  }

  private async beat() {
    const id = this.v.callId;
    if (!id || this.v.phase !== "live") return;
    const r = await this.api.beat(id).catch(() => undefined);
    if (!r) return;
    this.set({ costUsd: r.call.costUsd, monthUsd: r.monthUsd });
    if (r.stop) void this.hangup(r.stop);
  }

  setMuted(m: boolean) {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !m;
    this.set({ muted: m });
  }

  private send(ev: unknown) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(ev));
  }

  /** A system note for the model, then a response: queued while it talks or the owner talks, so nobody is cut off. */
  private nudge(text: string, instructions?: string, toolChoice?: "none") {
    // Anything new to say (a desk answer, the time limit) is activity: it cancels a pending idle hang-up.
    if (text !== QUIET_NUDGE && this.quietWarnAt !== undefined) {
      this.quietWarnAt = undefined;
      this.lastActivity = this.clock.now();
    }
    this.nudges.push({ text, instructions, toolChoice });
    this.flush();
  }
  private flush() {
    // Listen mode reads nothing out: desk answers and notes wait until he says "done".
    if (this.responding || this.userSpeaking || this.listen || this.v.phase !== "live") return;
    const n = this.nudges.shift();
    if (!n) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: n.text }] } });
    const response = { ...(n.instructions ? { instructions: n.instructions } : {}), ...(n.toolChoice ? { tool_choice: n.toolChoice } : {}) };
    this.send({ type: "response.create", ...(Object.keys(response).length ? { response } : {}) });
    this.responding = true; // until response.created / response.done arrive
  }

  private onEvent(raw: string) {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const now = this.clock.now();
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        this.lastActivity = this.lastOwnerAt = now;
        if (ev.item_id) this.pendingItems.add(ev.item_id);
        if (this.listen) {
          this.listen.warned = false;
          this.listen.ackDue = undefined; // he goes on: no acknowledgement over him
        }
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.lastActivity = this.lastOwnerAt = now;
        this.flush();
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.set({ hearing: this.v.hearing + (ev.delta ?? "") });
        break;
      case "conversation.item.input_audio_transcription.completed": {
        this.set({ hearing: "" });
        const pre = !!this.listen?.pre.has(ev.item_id);
        this.pendingItems.delete(ev.item_id);
        this.line("owner", ev.transcript ?? "");
        if (ev.usage && this.v.callId) void this.meter({ eventId: `tr-${ev.item_id}-${ev.content_index ?? 0}`, kind: "transcription", usage: ev.usage });
        if (this.listen && !pre) this.heard(String(ev.transcript ?? "").trim());
        break;
      }
      case "response.created":
        this.responding = true;
        this.spoke = false;
        if (this.greet && !this.greet.respId) this.greet.respId = ev.response?.id ?? "greeting";
        this.fixedNow = this.fixedNext;
        this.fixedNext = undefined;
        break;
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (item.type !== "message" || !item.id || !this.greet) break;
        if (this.isGreetingResponse(ev.response_id) && !this.greet.respDone) {
          // call_7415c108: one greeting response said the line twice, as two items. The first is the greeting; a second
          // is stopped at once (not cleared: that would cut the end of the first, still playing).
          if (!this.greet.item) this.greet.item = item.id;
          else this.drop(item.id, false);
        }
        break;
      }
      case "response.output_audio_transcript.delta": {
        if (ev.item_id && this.dropped.has(ev.item_id)) break;
        this.lastActivity = now;
        if (ev.item_id && this.greet && !this.greet.item && !this.greet.respDone) this.greet.item = ev.item_id;
        const later = !!(this.greeting && this.greet?.item && ev.item_id !== this.greet.item);
        if (ev.item_id && (later || this.fixedNow !== undefined)) {
          const so = (this.saying.get(ev.item_id) ?? "") + (ev.delta ?? "");
          this.saying.set(ev.item_id, so);
          // Any later item that starts with the greeting is a second greeting: cancelled, and its audio cleared unless
          // the greeting itself may still be playing.
          if (later && startsGreeting(so, this.greeting!)) {
            this.drop(ev.item_id, !!this.greet?.respDone);
            break;
          }
          // a fixed line (an acknowledgement, the greeting) that goes on past its words is an ad-lib.
          if (this.fixedNow !== undefined && words(so).length > this.fixedNow + FIXED_SLACK_WORDS) {
            this.drop(ev.item_id, true, "a fixed line ran on: stopped");
            break;
          }
        }
        this.spoke = true;
        this.set({ speaking: this.v.speaking + (ev.delta ?? "") });
        break;
      }
      case "response.output_audio_transcript.done":
        if (ev.item_id) this.saying.delete(ev.item_id);
        if (ev.item_id && this.dropped.has(ev.item_id)) break;
        this.lastActivity = now;
        this.set({ speaking: "" });
        this.line("voice", ev.transcript ?? "");
        break;
      case "output_audio_buffer.started":
        this.playing = true;
        this.lastActivity = now;
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.playing = false;
        this.lastActivity = now;
        // The greeting is over when its audio has played out (a clear is never the greeting's end).
        if (ev.type === "output_audio_buffer.stopped" && this.greet?.respDone && !this.greet.done) {
          this.greeted();
          if (!this.responding) this.flush();
        }
        break;
      case "response.function_call_arguments.done":
        this.pendingCalls.push({ call_id: ev.call_id, name: ev.name, arguments: ev.arguments ?? "{}" });
        break;
      case "response.done": {
        this.responding = false;
        this.lastActivity = now;
        this.fixedNow = undefined;
        const r = ev.response ?? {};
        if (this.greet && !this.greet.respDone && this.isGreetingResponse(r.id)) {
          this.greet.respDone = true;
          // Normal turn-taking comes back when the greeting has been heard (its audio stops), or now if none is playing.
          if (!this.playing) this.greeted();
        }
        if (r.usage && this.v.callId) void this.meter({ eventId: r.id ?? `resp-${now}`, kind: "response", usage: r.usage });
        const calls = this.pendingCalls.splice(0);
        const bye = calls.find((c) => c.name === "hang_up");
        if (this.queuedSpeak !== undefined && !bye && !calls.length) {
          const q = this.queuedSpeak;
          this.queuedSpeak = undefined;
          this.say(q);
        } else if (bye) this.byeRequested(bye, r.status === "cancelled" ? false : this.spoke);
        else if (calls.length) void this.runTools(calls, r.status !== "cancelled" && this.spoke);
        else this.flush();
        break;
      }
      case "error":
        // Cancelling a second greeting just as its response ended: nothing to cancel, nothing wrong.
        if (ev.error?.code === "response_cancel_not_active") break;
        // A refused client event (e.g. response.create while one runs) is not fatal; show it and go on.
        this.set({ warn: String(ev.error?.message ?? "voice error").slice(0, 200) });
        this.responding = false;
        if (this.queuedSpeak !== undefined) {
          const q = this.queuedSpeak;
          this.queuedSpeak = undefined;
          this.say(q);
        }
        this.flush();
        break;
    }
  }

  private async meter(ev: { eventId: string; kind: "response" | "transcription"; usage: unknown }) {
    const id = this.v.callId;
    if (!id) return;
    const r = await this.api.usage(id, ev).catch(() => undefined);
    if (!r) return;
    this.set({ costUsd: r.call.costUsd, monthUsd: r.monthUsd });
    if (r.stop && this.v.phase === "live") void this.hangup(r.stop);
  }

  private async runTools(calls: { call_id: string; name: string; arguments: string }[], spoke = false) {
    const id = this.v.callId!;
    let listening = false;
    for (const c of calls) {
      let output: unknown;
      try {
        if (c.name === "quick_status") {
          this.line("tool", "quick status");
          output = (await this.api.status(id)).text;
        } else if (c.name === "ask_the_desk") {
          const a = JSON.parse(c.arguments || "{}") as { request?: string; confirmed?: boolean };
          const req = String(a.request ?? "").trim();
          // His own words since the last question go with it, so the desk reads what he said, not only the voice's summary.
          const from = this.wordsFrom;
          const words = this.v.lines.slice(from).filter((l) => l.who === "owner").map((l) => l.text).join(" ");
          this.wordsFrom = this.v.lines.length;
          let r: { askId: string };
          try {
            r = await this.api.ask(id, req, !!a.confirmed, words);
          } catch (e) {
            this.wordsFrom = from;
            this.line("tool", `asked the desk (not delivered): ${req}`);
            throw e;
          }
          this.line("tool", `asked the desk (${r.askId}): ${req}`);
          this.follow(r.askId, req);
          output = { status: "working", askId: r.askId, note: HANDOFF_NOTE };
        } else if (c.name === LISTEN_TOOL) {
          listening = this.startListening();
          output = { status: "listening", note: "Listen mode is on: the console holds his words and sends them in one go when he says done. Say nothing else now." };
        } else if (CONSOLE_TOOLS.has(c.name) && this.api.tool) {
          // the inbox walk; the console keeps which card he is on.
          const args = JSON.parse(c.arguments || "{}") as Record<string, unknown>;
          const r = (await this.api.tool(id, c.name, args)) as { place?: string; press?: { id: string; kind: string; button: string; words?: string; title?: string } };
          if (r?.press) {
            // the console checked his yes and the button; the page presses it as his own button would.
            const press = this.focus?.press;
            let done: string;
            try {
              done = press ? await press(r.press) : "not pressed: this page cannot press it";
            } catch (e) {
              done = `not pressed: ${(e as Error).message}`;
            }
            this.line("tool", `pressed ${r.press.button} on ${r.place ?? "the card"}: ${done}`);
            output = { ...r, result: done, note: done.startsWith("not pressed") ? "It did not go through: tell him in one line and offer to pass it to the desk." : "Pressed. Say it is done in a few words, then offer the next card." };
          } else {
            this.line("tool", `${c.name.replace("_", " ")}${r?.place ? `: ${r.place}` : ""}`);
            output = r;
          }
        } else output = { error: `unknown tool ${c.name}` };
      } catch (e) {
        output = { error: `the console did not answer: ${(e as Error).message}` };
      }
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: typeof output === "string" ? output : JSON.stringify(output) } });
    }
    if (listening) return this.speak(LISTEN_START_LINE);
    // the desk got it; if the voice already said its line, or he is talking, no turn of its own.
    if (calls.every((c) => c.name === "ask_the_desk") && (spoke || this.userSpeaking)) {
      return this.flush();
    }
    this.send({ type: "response.create" });
    this.responding = true;
  }

  /** the greeting response is the first one of the call (no automatic replies until it has played). */
  private isGreetingResponse(id: string | undefined): boolean {
    return !!this.greet && (!this.greet.respId || !id || id === this.greet.respId);
  }
  /** A second greeting: stopped before it is heard, never shown or written down. `clear`: its audio is all that plays. */
  private drop(itemId: string, clear: boolean, why = "second greeting stopped (the greeting is said once per call)") {
    if (this.dropped.has(itemId)) return;
    this.dropped.add(itemId);
    this.saying.delete(itemId);
    this.line("tool", why);
    this.send({ type: "response.cancel" });
    if (clear) this.send({ type: "output_audio_buffer.clear" });
    this.set({ speaking: "" });
  }
  /** The greeting has played: what the microphone heard under it dropped, normal turn-taking back. */
  private greeted() {
    if (!this.greet || this.greet.done) return;
    this.greet.done = true;
    if (this.listen) return;
    this.send({ type: "input_audio_buffer.clear" });
    this.setTurns(this.turnDetection);
  }

  /** One response that says exactly this line, no tools: the words listen mode uses. `oob`: with no conversation in front. */
  private speak(line: string, instructions = sayExactly(line), oob = false) {
    const q: Speak = { instructions, ...(line ? { line } : {}), ...(oob ? { oob } : {}) };
    if (this.responding) return void (this.queuedSpeak = q);
    this.say(q);
  }
  private say(q: Speak) {
    // an acknowledgement sees none of his words (call_3457e739 answered them: "That's a great observation…").
    const oob = q.oob ? { conversation: "none", input: [] } : {};
    this.fixedNext = q.line ? words(q.line).length : undefined;
    this.send({ type: "response.create", response: { instructions: q.instructions, tool_choice: "none", ...oob } });
    this.responding = true;
  }

  private setTurns(td: Record<string, unknown> | null) {
    this.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: td } } } });
  }

  /** listen mode on. No automatic replies from here (this engine answers each turn), a longer pause per turn. */
  private startListening(): boolean {
    if (this.listen) return true;
    this.listen = { since: this.clock.now(), held: [], warned: false, pre: new Set(this.pendingItems), acks: 0 };
    this.quietWarnAt = undefined;
    this.setTurns({ ...this.turnDetection, silence_duration_ms: LISTEN_SILENCE_MS, create_response: false, interrupt_response: true });
    this.line("tool", "listen mode on");
    this.set({ listening: true });
    return true;
  }

  /** One of his turns in listen mode: "done" sends it all, "bye" sends it all then hangs up, "expand" is answered, else held. */
  private heard(text: string) {
    const l = this.listen!;
    if (!text) return;
    const line = this.v.lines.length - 1;
    const done = text.match(LISTEN_DONE) ?? text.match(LISTEN_BYE);
    if (done) {
      // The words before "done" are feedback too; a full stop before it stays with them.
      const rest = text.slice(0, (done.index ?? 0) + (/^[.!?]/.test(done[0]) ? 1 : 0)).trim();
      if (rest) l.held.push({ text: rest, line });
      return void this.finishListening(LISTEN_BYE.test(text) && !LISTEN_DONE.test(text));
    }
    if (LISTEN_EXPAND.test(text)) {
      return this.speak(
        "",
        `You are in listen mode on a call: ${ownerName()} is giving feedback, and everything he says is held and sent to the desk in one message when he says done. He just asked you to say more: do what he asked in two or three short sentences (read back his points so far if he asked for that, from his own words since he said he wanted to give feedback), then say "Keep going, or say done when finished." Send nothing to the desk, and do not read out anything from the desk.`,
      );
    }
    l.held.push({ text, line });
    // an acknowledgement only after a real pause (tick), and at most one per LISTEN_ACK_GAP_MS; else silence.
    const now = this.clock.now();
    if (l.lastAck === undefined || now - l.lastAck >= LISTEN_ACK_GAP_MS) l.ackDue = now + LISTEN_ACK_WAIT_MS;
  }

  /** "done": listen mode off, his words to the desk as one message, the reply confirmed in one line when it comes. */
  private async finishListening(bye = false) {
    const l = this.listen;
    if (!l) return;
    this.listen = undefined;
    this.lastActivity = this.clock.now();
    this.set({ listening: false });
    this.setTurns(this.turnDetection);
    if (!l.held.length) {
      this.line("tool", "listen mode off (nothing held)");
      if (bye) return this.byeNow();
      return this.speak(LISTEN_EMPTY_LINE);
    }
    // No system note before this line: on call_ed357715 one made the voice ad-lib ("Noted, thanks for sharing…") instead of
    // saying it. That nobody relays any of it again is in the session's instructions and the listen tool's output.
    if (bye) this.byeNow(`${LISTEN_SEND_LINE.replace(" now.", ",")} and goodbye.`);
    else this.speak(LISTEN_SEND_LINE);
    const askId = await (this.sending = this.sendFeedback(l.held));
    this.sending = undefined;
    if (!askId) {
      if (!bye) this.nudge("The desk did not take his feedback. Tell him in one sentence; his words are in the call transcript in Chat.");
      return;
    }
    if (!bye) this.follow(askId, "his feedback", true);
    this.flush();
  }

  /** His held words to the desk, once. Their lines are tagged with the message id so the transcript does not carry them again. */
  private async sendFeedback(held: { text: string; line: number }[]): Promise<string | undefined> {
    const id = this.v.callId;
    if (!id) return undefined;
    const words = held.map((h) => h.text).join("\n");
    this.wordsFrom = this.v.lines.length;
    try {
      const r = await this.api.ask(id, `${ownerName()}'s feedback from this call, all of it in one message: file it once.`, true, words, "feedback");
      const at = new Set(held.map((h) => h.line));
      this.set({ lines: this.v.lines.map((x, i) => (at.has(i) ? { ...x, feedback: r.askId } : x)) });
      this.line("tool", `feedback sent to the desk as one message (${r.askId}): ${held.length} part${held.length === 1 ? "" : "s"}`);
      return r.askId;
    } catch (e) {
      this.line("tool", `feedback not delivered: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** He said bye in listen mode: one goodbye line, then the line closes (as). */
  private byeNow(line = `Bye, ${ownerName()}.`) {
    this.line("tool", "hang up (he said bye in listen mode)");
    this.byeAt = this.clock.now();
    this.nudges = [];
    this.speak(line);
  }

  /** the owner said he is done. The goodbye said in this turn plays out, then the line closes (tick); none said: one now. */
  private byeRequested(c: { call_id: string; arguments: string }, spoke: boolean) {
    let said = "";
    try {
      said = String((JSON.parse(c.arguments || "{}") as { said?: string }).said ?? "").trim();
    } catch {
      /* no words */
    }
    this.line("tool", `hang up${said ? ` (he said: ${said})` : ""}`);
    this.byeAt = this.clock.now();
    this.quietWarnAt = undefined;
    this.nudges = [];
    if (!spoke) {
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ status: "hanging up", note: "Say one short goodbye now, nothing else." }) } });
      this.send({ type: "response.create", response: { tool_choice: "none" } });
      this.responding = true;
    }
  }

  /**
   * Watch one question to the desk. Nothing is said while it works. Its reply is said at once, at his next
   * pause (a question back to him after its answer; a failure in a few words).
   */
  private follow(askId: string, req: string, feedback = false) {
    this.asks.add(askId);
    this.set({ deskWaiting: this.asks.size });
    const short = req.length > 60 ? `${req.slice(0, 57)}…` : req;
    let toldChat = false;
    // One check at a time, and the answer is taken once: a slow check (the desk view can take seconds) used to overlap the
    // next ones, and each read the answer out again (call_283d1c45: one answer, three times).
    let busy = false;
    let done = false;
    const t = this.clock.every(async () => {
      if (done) return;
      if (this.v.phase !== "live") return this.unfollow(askId, t);
      if (busy) return;
      busy = true;
      const s = await this.api.askState(this.v.callId!, askId).catch(() => undefined);
      busy = false;
      if (!s || done) return;
      if (s.state === "answered" || s.state === "failed") {
        done = true;
        this.unfollow(askId, t);
        if (this.v.phase !== "live") return;
        if (s.state === "answered") {
          this.line("tool", `desk answered (${askId}): ${s.answer ?? ""}`);
          if (feedback) this.nudge(`The desk filed his feedback and replied:\n${s.answer ?? ""}\nTell him in ONE short sentence what was filed, beginning "Filed:", in the desk's words. Nothing else; do not read the feedback back.`, undefined, "none");
          else if (needsHisAnswer(s.answer ?? "")) this.nudge(deskQuestionNote(short, s.answer ?? ""));
          else this.nudge(deskReplyNote(short, s.answer ?? ""));
        } else this.nudge(`The desk did not get "${short}" (${s.answer ?? "error"}). Tell him in a few words ('The desk missed that. Type it in Chat?').`);
        return;
      }
      if (s.waitedMs >= ASK_GIVE_UP_MS) return this.unfollow(askId, t);
      // Listen mode: no spoken progress (it would break his flow); the answer itself waits in the queue until "done".
      // His feedback being filed: no progress chatter either (call_ed357715: four "still processing"), only "Filed:".
      if (this.listen) return;
      if (feedback) {
        if (!toldChat && s.waitedMs >= s.spokenWaitMs) {
          toldChat = true;
          this.nudge("The desk is still filing his feedback. Tell him in one sentence that what it filed will be in Chat.", undefined, "none");
        }
      }
      // no spoken progress on his questions either (call_3a2e181c: five "still in progress" in a minute).
    }, ASK_POLL_MS);
    this.timers.push(t);
  }
  private unfollow(askId: string, t: ReturnType<typeof setInterval>) {
    this.clock.stop(t);
    this.asks.delete(askId);
    this.set({ deskWaiting: this.asks.size });
  }

  private cleanupMedia() {
    for (const t of this.timers) this.clock.stop(t);
    this.timers = [];
    try {
      this.dc?.close();
    } catch {
      /* closed */
    }
    try {
      this.pc?.close();
    } catch {
      /* closed */
    }
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    void this.lock?.release().catch(() => undefined);
    this.unsession?.();
    this.pc = this.dc = this.mic = this.lock = this.unsession = undefined;
    this.responding = this.userSpeaking = this.playing = this.spoke = false;
    this.quietWarnAt = this.byeAt = undefined;
    this.lastOwnerAt = 0;
    this.nudges = [];
    this.pendingCalls = [];
    this.asks.clear();
    this.wordsFrom = 0;
    this.listen = this.queuedSpeak = undefined;
    this.fixedNext = this.fixedNow = undefined;
    this.pendingItems.clear();
    this.greet = undefined;
    this.dropped.clear();
    this.saying.clear();
    if (this.v.listening) this.set({ listening: false });
  }

  /** Hang up (button, quiet timer, limit, console stop): close the line, then hand the transcript to the console. */
  async hangup(reason = "hangup"): Promise<void> {
    if (this.v.phase !== "live" && this.v.phase !== "connecting") return;
    const id = this.v.callId;
    // Hung up in listen mode (button, quiet, limit): what he said still reaches the desk, once.
    const held = this.listen?.held ?? [];
    this.listen = undefined;
    if (this.away !== undefined && AWAY_REASONS.has(reason)) this.droppedAway = { reason, at: this.clock.now(), since: this.away };
    this.set({ phase: "ending", endReason: reason, hearing: "", speaking: "" });
    this.cleanupMedia();
    await this.sending?.catch(() => undefined);
    if (held.length) await this.sendFeedback(held);
    // The last response.done may still be on its way to the meter: give it a moment.
    await new Promise((r) => setTimeout(r, 400));
    if (id) {
      const r = (await this.api.end(id, { reason, transcript: this.v.lines }).catch(() => undefined)) as { call?: CallInfo; monthUsd?: number } | undefined;
      if (r?.call) this.set({ costUsd: r.call.costUsd, monthUsd: r.monthUsd });
    }
    this.set({ phase: "ended", deskWaiting: 0 });
  }

  /**
   * the page went out of view (`visible` false: phone locked, app switched) or came back. Back: a line that dropped
   * meanwhile reconnects (within RECONNECT_WINDOW_MS), a live line gets its microphone back if it went mute, and the screen
   * says what happened.
   */
  async pageVisible(visible: boolean): Promise<void> {
    const now = this.clock.now();
    if (!visible) {
      if (this.away === undefined && (this.v.phase === "live" || this.v.phase === "connecting")) {
        this.away = now;
        this.line("tool", "phone locked or page hidden");
      }
      return;
    }
    const since = this.away;
    this.away = undefined;
    if (since === undefined && !this.droppedAway) return;
    if (this.v.phase === "live" && since !== undefined) {
      const st = this.pc?.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed" || this.dc?.readyState === "closed") {
        this.away = since; // the drop counts as while away
        await this.hangup("line_dropped");
        this.away = undefined;
      } else {
        await this.freshMic();
        // His silence while locked was not him: the quiet timers start again from now.
        this.lastActivity = now;
        this.quietWarnAt = undefined;
        if (this.listen) this.listen.since = now;
        this.line("tool", "page back in view");
        this.set({ notice: `The phone was locked for ${mmss(now - since)}. The call held; you are back on it.` });
        return;
      }
    }
    if (this.v.phase === "ending") await new Promise<void>((ok) => {
      const off = this.subscribe((v) => v.phase !== "ending" && (off(), ok()));
    });
    const d = this.droppedAway;
    if (!d || this.v.phase !== "ended") return;
    this.droppedAway = undefined;
    const what = `The phone locked at ${hhmm(d.since)} and the line dropped`;
    if (now - d.at > RECONNECT_WINDOW_MS) {
      this.set({ notice: `${what} at ${hhmm(d.at)}. That was a while ago, so it did not reconnect: press Call to talk again.` });
      return;
    }
    await this.start({ resumed: true, notice: `${what}. Reconnected at ${hhmm(now)}; the desk remembers the call.` });
  }

  /** The microphone went mute or ended under a live call (an iPhone while locked): take it again and send the new track. */
  private async freshMic() {
    const old = this.mic?.getAudioTracks()[0];
    if (!old || (old.readyState !== "ended" && !old.muted)) return;
    const mic = await this.media.microphone().catch(() => undefined);
    const t = mic?.getAudioTracks()[0];
    if (!mic || !t) return;
    t.enabled = !this.v.muted;
    const sender = this.pc?.getSenders?.().find((s) => s.track?.kind === "audio" || s.track === old);
    await sender?.replaceTrack(t).catch(() => undefined);
    old.stop();
    this.mic = mic;
  }

  /** forget a failed start's error (the call it collided with was hung up from this page). */
  clearError() {
    if (this.v.error && !busyPhase(this.v.phase)) this.set({ error: undefined });
  }

  /** The tab is closing: send the end with the transcript as a beacon (no await possible). */
  pageHide() {
    const id = this.v.callId;
    if (!id || (this.v.phase !== "live" && this.v.phase !== "connecting")) return;
    const held = this.listen?.held ?? [];
    if (held.length) void this.api.ask(id, `${ownerName()}'s feedback from this call, all of it in one message: file it once.`, true, held.map((h) => h.text).join("\n"), "feedback").catch(() => undefined);
    this.cleanupMedia();
    void this.api.end(id, { reason: "tab_closed", transcript: this.v.lines }, true);
    this.set({ phase: "ended", endReason: "tab_closed" });
  }
}

/** The console's /api/voice routes. */
/** `base`: the call routes' root, `/api/voice` (the Team desk) or `/api/milestones/<id>/voice` (a campaign chat). */
export function fetchVoiceApi(f: typeof fetch = (...a) => fetch(...a), base = "/api/voice"): VoiceApi {
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await f(`${base}${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: method === "POST" && (path.endsWith("/end") || path.endsWith("/ask")) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(j?.error?.message ?? `console answered ${r.status}`);
    return j as T;
  };
  return {
    start: (focus) => call("POST", "/calls", focus ? { focus } : undefined),
    beat: (id) => call("POST", `/calls/${id}/beat`),
    usage: (id, ev) => call("POST", `/calls/${id}/usage`, ev),
    end: (id, body, beacon) => {
      if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) return Promise.resolve(navigator.sendBeacon(`${base}/calls/${id}/end`, JSON.stringify(body)));
      return call("POST", `/calls/${id}/end`, body);
    },
    status: (id) => call("GET", `/calls/${id}/status`),
    ask: (id, request, confirmed, words, kind) => call("POST", `/calls/${id}/ask`, { request, confirmed, ...(words ? { words } : {}), ...(kind ? { kind } : {}) }),
    askState: (id, askId) => call("GET", `/calls/${id}/ask/${askId}`),
    endActive: (id) => call("POST", "/active/end", { id }),
    tool: (id, name, args) => call("POST", `/calls/${id}/tool`, { name, args }),
  };
}

/** The browser's microphone, peer connection and OpenAI's WebRTC call endpoint. */
export function browserMedia(audio: HTMLAudioElement): Media {
  return {
    microphone: () => {
      if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("This browser does not let this page use the microphone (it needs https)."));
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    },
    peer: () => new RTCPeerConnection(),
    async exchange(sdp, clientSecret) {
      const r = await fetch(OPENAI_CALLS_URL, { method: "POST", body: sdp, headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/sdp" } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        let why = body;
        try {
          const j = JSON.parse(body);
          why = [j?.error?.code, j?.error?.message].filter(Boolean).join(": ") || body;
        } catch {
          /* not JSON */
        }
        throw new Error(`OpenAI refused the call (${r.status}): ${why.slice(0, 240)}`);
      }
      return r.text();
    },
    play(stream) {
      audio.srcObject = stream;
      void audio.play().catch(() => undefined);
    },
    // taken again each time the page is back in view (the browser drops it on every lock).
    wakeLock: () => stickyWakeLock(),
    session: (h) => callMediaSession(h),
  };
}
