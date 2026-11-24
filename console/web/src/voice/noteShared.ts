/**
 * what every page needs of a voice note without its recorder: the types, the texts a control shows, the note's
 * store in this browser and the microphone it opens. The recorder itself (noteEngine.ts) loads only when he taps the
 * microphone (NoteProvider LazyNote), so the phone's first load carries none of it.
 */
export interface NoteStartInfo {
  note: { id: string };
  segmentS: number;
  maxMin: number;
  /** the minute the page warns at (1 h 50 min of a 2-hour note); older consoles leave it out: ten minutes before the cap. */
  warnMin?: number;
  usdPerMin: number;
  monthUsd: number;
  monthCapUsd: number;
}
/**
 * E948-S174 (the owner 22 Nov 19:2xZ: a 0-second note to a card sat "Waiting to send" on his phone, retried for days): a
 * recording with no audio (0 s, or no bytes) is dropped at once with this line, never queued or retried.
 */
export const EMPTY_RECORDING_TEXT = "Empty recording, not sent";

export interface SentNote {
  id: string;
  state: string;
  seconds: number;
  costUsd: number;
  segments: number;
  transcript?: string;
  /** the recording's link, when the note was an answer on a card (`fill`). */
  audio?: string;
  /** its audio was safe on the console at this time (Sent); the words are written and posted after. */
  acceptedAt?: string;
}

/** The console's note routes (fetch by default; tests fake them). */
/** where tap stop to Sent went (ms; bytes of the last upload), reported with the timing so a slow one names its step. */
export interface SendParts {
  /** tap stop to the recorder handing over the last part. */
  stopMs?: number;
  /** waiting for a part of it still going up while he talked. */
  earlyWaitMs?: number;
  /** the last upload, to the console's answer. */
  uploadMs?: number;
  tailBytes?: number;
  earlyBytes?: number;
}

export interface NotesApi {
  /** `clientId`: the note's name in this browser; the console opens one note per clientId, so a retry never makes two. */
  start(page?: string, clientId?: string): Promise<NoteStartInfo>;
  /**
   * `startMs`: the start's timings (JSON), sent with the parts until one is in. `more.earlyBytes`: the console already has
   * the part's first bytes (`early`), `audio` is its tail; `more.accept`: the last part of a chat note asks for Sent in
   * the same request (the answer then carries `accepted` and the note).
   */
  segment(
    id: string,
    n: number,
    audio: Blob,
    seconds: number,
    startMs?: string,
    more?: { earlyBytes?: number; accept?: { segments: number; skip?: number[]; page?: string } },
  ): Promise<{ segment: { n: number; text?: string; costUsd: number }; note: { costUsd: number } & Partial<SentNote>; accepted?: boolean }>;
  /** the part being recorded goes up while he talks, from `offset`; answers how many bytes the console has. */
  early?(id: string, n: number, offset: number, bytes: Blob): Promise<{ have: number }>;
  /** `skip`: part numbers with no audio (an empty part, or one lost when the phone threw the page away). */
  finish(id: string, segments: number, page?: string, skip?: number[]): Promise<{ note: SentNote; audio?: string; accepted?: boolean }>;
  /** how long tap stop to Sent took (ms), for the console's 3-second check. */
  timing?(id: string, sentMs: number, parts?: SendParts): Promise<unknown>;
  discard(id: string): Promise<unknown>;
  /** The note's state on the console (a reloaded page checks its kept note is still open). */
  state?(id: string): Promise<string | undefined>;
}

/** the open note, kept in the browser between page loads. */
export interface KeptNote {
  id: string;
  /** the note's client id (its parts wait in the browser's outbox under it). */
  cid?: string;
  /** Next part number; parts below it are either in `done` or lost. */
  next: number;
  done: number[];
  empty: number[];
  closedS: number;
  segmentS: number;
  maxMin: number;
  usdPerMin: number;
  page?: string;
  at: number;
}
export interface NoteStore {
  get(): KeptNote | undefined;
  set(k: KeptNote): void;
  clear(): void;
}
/** The browser's localStorage under one key per note route (`base`); a no-op where storage is off. */
export function localNoteStore(base = "/api/voice"): NoteStore {
  const key = `voice-note-open:${base}`;
  return {
    get: () => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as KeptNote) : undefined;
      } catch {
        return undefined;
      }
    },
    set: (k) => {
      try {
        localStorage.setItem(key, JSON.stringify(k));
      } catch {
        /* private mode */
      }
    },
    clear: () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* private mode */
      }
    },
  };
}
export const memoryNoteStore = (): NoteStore => {
  let k: KeptNote | undefined;
  return { get: () => k, set: (x) => void (k = x), clear: () => void (k = undefined) };
};

/** The part of MediaRecorder this engine uses. */
export interface RecorderLike {
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export interface NoteMedia {
  microphone(): Promise<MediaStream>;
  recorder(stream: MediaStream): RecorderLike;
  /** Input level 0..1 for the meter (absent in tests: the meter stays flat). */
  level?(stream: MediaStream): { read(): number; close(): void } | undefined;
  wakeLock?(): Promise<{ release(): Promise<void> } | undefined>;
}

export interface NoteClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

export type NotePhase = "idle" | "starting" | "recording" | "paused" | "sending" | "sent" | "failed";

export interface NoteView {
  phase: NotePhase;
  /** Seconds recorded (paused time not counted). */
  elapsedS: number;
  level: number;
  /** What the transcription has cost so far (the console's figures). */
  costUsd: number;
  /** The estimate for what is recorded ($0.003 a minute). */
  estUsd: number;
  usdPerMin: number;
  maxMin: number;
  /** Segments recorded / transcribed. */
  segments: number;
  uploaded: number;
  error?: string;
  info?: string;
  /** the warning before the cap, shown while recording. */
  warn?: string;
  note?: SentNote;
}

/** the cap of a note until the console's answer is in (it sends its own). */
export const DEFAULT_MAX_MIN = 120;
/** a note before its first tap (the recorder starts here, and the control shows it while the recorder loads). */
export const IDLE_NOTE: NoteView = { phase: "idle", elapsedS: 0, level: 0, costUsd: 0, estUsd: 0, usdPerMin: 0.003, maxMin: DEFAULT_MAX_MIN, segments: 0, uploaded: 0 };
/** the length as he says it: "2 hours", "1 h 50 min", "30 minutes". */
export function lengthText(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (!h) return `${m} minutes`;
  if (!m) return h === 1 ? "1 hour" : `${h} hours`;
  return `${h} h ${m} min`;
}
/** shown from 1 h 50 min (ten minutes before the cap): the note never stops without telling him first. */
export const warnText = (maxMin: number, leftMin: number) =>
  `${lengthText(Math.max(1, Math.round(leftMin)))} left: at ${lengthText(maxMin)} this note stops and is sent by itself, everything you said kept. Tap Send note and start a new one to keep talking.`;
export const capText = (maxMin: number) => `Stopped at the ${lengthText(maxMin)} limit and sent. Everything you said up to here is kept.`;
export const PARTS_CAP_TEXT = "Stopped and sent: this note reached its most parts (the phone locked very often). Everything you said up to here is kept.";
export const INTERRUPTED_TEXT = "Recording stopped: a call came in, the screen locked or another app took the microphone. What you said so far is kept. Tap Resume to go on, or Send.";
export const resumedText = (at: string) => `The phone locked at ${at}. What you said before is kept, and recording picked up again.`;
export const NO_ANSWER_TEXT = "The console has not answered yet. Recording goes on and what you say is kept here. Send tries again.";
export const RECOVERED_TEXT = "A voice note you were recording was kept when the page closed. Tap Resume to go on, or Send. If you do neither, it is sent by itself in a few minutes.";
/** what a note says while its parts are kept on this phone and not yet confirmed by the console. */
export const KEPT_TEXT = "Saved on this phone, sending…";
export const KEPT_FAILED_TEXT = "It goes by itself as soon as the connection is back, trying for days. Nothing is lost.";
/** the note's line while the console has not confirmed it (said plainly). */
export const WAITING_TEXT = "Waiting to send · saved on this phone";
/** a reloaded note that is neither resumed nor sent goes by itself after this long. */
export const RECOVER_SEND_MS = 3 * 60_000;
/** a kept note that did not go tries again after this long, doubling each try (at most 30 minutes), for days if need be. */
export const RETRY_MS = 20_000;
/** the part being recorded is saved on the device this often (a closed tab or a crash loses at most this much). */
export const CHECKPOINT_MS = 3000;
/** A kept note older than this is not offered again (its parts stay on the console). */
export const KEEP_MS = 24 * 3600_000;
/** On hiding, the part being recorded is closed only if it has at least this much in it (a near-empty part has no words). */
export const MIN_PART_S = 2;
/** A part shorter than this is not uploaded (no words in it; the transcriber refuses near-empty audio). */
export const MIN_AUDIO_S = 1;
/** The console takes at most this many parts per note. */
export const MAX_PARTS = 300;
/** the part being recorded goes up while he talks once this much is new (about 3 s of speech), so stop sends only its tail. */
export const EARLY_MIN_BYTES = 12 * 1024;
/** A part's length until the console's answer (its `segmentS`) is in. */
/** a try to open the note that has not answered in this long is given up and tried again (a dead connection). */
export const START_TRY_MS = 6000;
/** opening the note is tried this long; then Send tries again (what was said stays here). */
export const START_GIVE_UP_MS = 45_000;

export const MIC_BUSY_TEXT = "You're on a call, or another app is using the microphone. It is free again when the call ends: tap the microphone then.";
/** The browser could not start a microphone that is there: on a phone, a call (or another app) holds it. */
export const micBusy = (e: unknown) => {
  const { name, message } = (e ?? {}) as { name?: string; message?: string };
  return name === "NotReadableError" || name === "TrackStartError" || name === "AbortError" || /in use|could not start|phone call|during a call/i.test(message ?? "");
};

export function micError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (micBusy(e)) return MIC_BUSY_TEXT;
  if (name === "NotAllowedError") return "The microphone is blocked for this page. Allow it in the browser's site settings, then tap again.";
  if (name === "NotFoundError") return "No microphone found.";
  return (e as Error)?.message || "The microphone did not open.";
}

/** The browser's microphone for a note, opened the moment he taps (before the recorder's code has arrived). */
export function noteMicrophone(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("This browser does not let this page use the microphone (it needs https)."));
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}
