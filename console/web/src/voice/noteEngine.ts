/**
 * rework (the owner's review, 2026-11-02): the voice-note recorder behind the Chat's one button. Tap to start, tap to
 * finish. It records in self-contained segments: every `segmentS` a new MediaRecorder starts on the same microphone before
 * the old one stops (no gap), and each finished segment is uploaded at once, so a 10- or 30-minute note is never one big
 * upload and most of it is transcribed before he taps finish. The console transcribes each segment once and, on finish, posts
 * the transcript as his message. No realtime session, nothing re-read per turn.
 *
 * Locked phone: if the microphone stops (an iPhone locking, another app taking the mic), what was recorded so far is kept and
 * the note waits, paused, for Resume or Send. A screen wake lock keeps the phone from locking by itself while recording.
 *
 * When the page goes out of view the part being
 * recorded is closed and uploaded at once (a new part goes on where the phone still records, Android), so what was said up to
 * the lock is safe on the console even if the phone throws the page away. When the page is back in view a note the lock
 * paused picks up again by itself. The open note (its id and which parts are in) is kept in this browser's storage, so a page
 * the phone reloaded offers the note again: Resume or Send, nothing lost.
 */
import { stickyWakeLock } from "./keepAwake";
import { held, newCid, recount, type OutboxStore, type OutNote } from "./outbox";


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
export interface SentNote {
  id: string;
  state: string;
  seconds: number;
  costUsd: number;
  segments: number;
  transcript?: string;
  /** the recording's link, when the note was an answer on a card (`fill`). */
  audio?: string;
}

/** The console's note routes (fetch by default; tests fake them). */
export interface NotesApi {
  /** `clientId`: the note's name in this browser; the console opens one note per clientId, so a retry never makes two. */
  start(page?: string, clientId?: string): Promise<NoteStartInfo>;
  /** `startMs`: the start's timings (JSON), sent with the parts until one is in. */
  segment(id: string, n: number, audio: Blob, seconds: number, startMs?: string): Promise<{ segment: { n: number; text: string; costUsd: number }; note: { costUsd: number } }>;
  /** `skip`: part numbers with no audio (an empty part, or one lost when the phone threw the page away). */
  finish(id: string, segments: number, page?: string, skip?: number[]): Promise<{ note: SentNote; audio?: string }>;
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
export const KEPT_FAILED_TEXT = "Saved on this phone. It is sent by itself as soon as the console answers; nothing is lost.";
/** a reloaded note that is neither resumed nor sent goes by itself after this long. */
export const RECOVER_SEND_MS = 3 * 60_000;
/** a kept note that did not go tries again this often. */
export const RETRY_MS = 20_000;
/** A kept note older than this is not offered again (its parts stay on the console). */
export const KEEP_MS = 24 * 3600_000;
/** On hiding, the part being recorded is closed only if it has at least this much in it (a near-empty part has no words). */
export const MIN_PART_S = 2;
/** A part shorter than this is not uploaded (no words in it; the transcriber refuses near-empty audio). */
export const MIN_AUDIO_S = 1;
/** The console takes at most this many parts per note. */
export const MAX_PARTS = 300;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const UPLOAD_TRIES = 3;
/** A part's length until the console's answer (its `segmentS`) is in. */
const DEFAULT_SEGMENT_S = 120;
/** a try to open the note that has not answered in this long is given up and tried again (a dead connection). */
export const START_TRY_MS = 6000;
/** opening the note is tried this long; then Send tries again (what was said stays here). */
export const START_GIVE_UP_MS = 45_000;
const TIMED_OUT = new Error("timed out");
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(TIMED_OUT), ms)))]).finally(() => clearTimeout(t));
}

const realClock: NoteClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

export class NoteEngine {
  private v: NoteView = { phase: "idle", elapsedS: 0, level: 0, costUsd: 0, estUsd: 0, usdPerMin: 0.003, maxMin: DEFAULT_MAX_MIN, segments: 0, uploaded: 0 };
  private subs = new Set<(v: NoteView) => void>();
  /** the warning before the cap was shown for this note. */
  private warned = false;
  /** why the note stopped by itself (the cap, the most parts): still said once it is sent. */
  private stopWhy?: string;
  private info?: NoteStartInfo;
  /** the note opening on the console (its id), while the recording already runs; undefined once thrown away. */
  private noteP?: Promise<NoteStartInfo>;
  /** when the button was pressed, and each start stage in ms after it (note open, microphone open, recording). */
  private pressAt = 0;
  private startMs: { note?: number; mic?: number; rec?: number; tries?: number } = {};
  private page?: string;
  private stream?: MediaStream;
  private rec?: RecorderLike;
  private recStart = 0;
  /** Seconds in segments already closed. */
  private closedS = 0;
  private segN = 0;
  private queue: Promise<void> = Promise.resolve();
  /** Segments whose upload failed: retried on Send. */
  private failed = new Map<number, { blob: Blob; seconds: number }>();
  private pendingStops: Promise<void>[] = [];
  private stopTick?: () => void;
  private meter?: { read(): number; close(): void };
  private lock?: { release(): Promise<void> };
  /** Parts uploaded, parts that had no audio (kept with the note). */
  private done = new Set<number>();
  private empty = new Set<number>();
  /** The page is out of view since this time (phone locked); the lock paused the note (resume on return). */
  private hiddenAt?: number;
  private lockedAt?: number;
  private shownAt = 0;
  /** the note's client id; its parts and where it goes are kept in the outbox under it until the console confirms. */
  private cid?: string;
  private beatAt = 0;
  private stopBeat?: () => void;
  private recoverTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private api: NotesApi,
    private media: NoteMedia,
    private clock: NoteClock = realClock,
    private store: NoteStore = memoryNoteStore(),
    /** the browser's outbox (IndexedDB) and what a kept note needs to be sent without this engine. Tests: none. */
    private out?: { store: OutboxStore; base: string; fill?: boolean; to?: string },
  ) {}

  /** the client id of the note on now (tests). */
  clientId = () => this.cid;

  /** a note that did not go (the console restarting, no connection) tries again by itself, kept here meanwhile. */
  private retryLater() {
    if (!this.out || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.v.phase === "failed" && this.v.info === KEPT_FAILED_TEXT) void this.finish();
    }, RETRY_MS);
  }
  /** the browser is back online: a kept note that did not go tries now. */
  online() {
    if (this.v.phase === "failed" && this.v.info === KEPT_FAILED_TEXT) void this.finish();
  }

  /** write the note's outbox record (merged with what is there). */
  private outNote(p: Partial<OutNote> = {}): Promise<void> {
    const o = this.out;
    const cid = this.cid;
    if (!o || !cid) return Promise.resolve();
    const now = this.clock.now();
    return o.store
      .getNote(cid)
      .then((had) =>
        o.store.putNote({
          cid,
          base: o.base,
          ...(o.fill ? { fill: true } : {}),
          ...(this.page ? { page: this.page } : {}),
          ...(o.to ? { to: o.to } : {}),
          startedAt: had?.startedAt ?? now,
          ...(had ?? {}),
          ...(this.info ? { id: this.info.note.id } : {}),
          parts: Math.max(this.segN, had?.parts ?? 0),
          done: [...new Set([...(had?.done ?? []), ...this.done])],
          seconds: this.closedS,
          at: now,
          ...p,
        }),
      )
      .catch(() => undefined);
  }
  /** the console confirmed the note (posted, written out, or nothing heard): it leaves the outbox. */
  private outDone() {
    const cid = this.cid;
    this.cid = undefined;
    this.stopBeat?.();
    this.stopBeat = undefined;
    if (cid) held.delete(cid);
    if (this.out && cid) void this.out.store.delNote(cid).then(() => recount(this.out!.store));
  }
  /** this engine lets the note go (failed and closed): the outbox sends it by itself, nothing is thrown away. */
  private outRelease() {
    const cid = this.cid;
    if (!cid) return;
    this.stopBeat?.();
    this.stopBeat = undefined;
    held.delete(cid);
    if (this.out) void this.outNote({ send: true }).then(() => recount(this.out!.store));
  }
  /** while this tab holds the note (recording, paused, sending), its record says so every 30 s (other tabs leave it). */
  private beat() {
    if (!this.out || this.stopBeat) return;
    this.stopBeat = this.clock.every(30_000, () => void this.outNote());
  }

  view = () => this.v;
  subscribe(fn: (v: NoteView) => void) {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }
  private set(p: Partial<NoteView>) {
    this.v = { ...this.v, ...p };
    for (const f of this.subs) f(this.v);
  }

  /**
   * Tap 1: open the microphone and record. The
   * recording no longer waits for the console. The note is opened on the console at the same time (`openNote`: a try that
   * hangs is given up after START_TRY_MS and tried again, as a phone waking from sleep can sit on a dead connection), the
   * parts wait for its id, and the wake lock is taken without holding up the start.
   */
  async start(page?: string) {
    if (this.v.phase !== "idle" && this.v.phase !== "sent" && this.v.phase !== "failed") return;
    this.reset();
    this.page = page;
    this.pressAt = this.clock.now();
    this.startMs = {};
    this.cid = newCid();
    held.add(this.cid);
    void this.outNote();
    this.beat();
    this.set({ phase: "starting" });
    const noteP = this.openNote();
    try {
      await this.openMic(noteP);
    } catch (e) {
      if (noteP !== this.noteP) return; // thrown away, or refused by the console, while the microphone opened
      this.forgetNote();
      return this.set({ phase: "failed", error: micError(e) });
    }
    if (noteP !== this.noteP) return;
    this.startMs.rec = this.clock.now() - this.pressAt;
    this.set({ phase: "recording" });
    this.stopTick = this.clock.every(250, () => this.tick());
    this.takeLock();
  }

  /** The screen wake lock, taken without holding up the recording; one that comes after the note ended is let go. */
  private takeLock() {
    const noteP = this.noteP;
    void this.media
      .wakeLock?.()
      .then((l) => {
        if (noteP === this.noteP && this.v.phase === "recording" && !this.lock) this.lock = l ?? undefined;
        else void l?.release().catch(() => undefined);
      })
      .catch(() => undefined);
  }

  /**
   * open the note on the console, retrying a try that fails on the way or does not answer in START_TRY_MS, for up to
   * START_GIVE_UP_MS. A refusal (voice off, the month's cap, not the owner) stops the recording at once with the console's words.
   * The id is kept (`info`) when it comes; a note opened by a try that was given up on is thrown away on the console.
   */
  private openNote(): Promise<NoteStartInfo> {
    const page = this.page;
    // eslint-disable-next-line prefer-const
    let noteP!: Promise<NoteStartInfo>;
    noteP = (async () => {
      const t0 = this.clock.now();
      for (let i = 0; ; i++) {
        this.startMs.tries = i + 1;
        const tryP = this.out ? this.api.start(page, this.cid) : this.api.start(page);
        let late = false;
        try {
          const info = await withTimeout(tryP, START_TRY_MS);
          if (noteP === this.noteP) {
            this.startMs.note ??= this.clock.now() - this.pressAt;
            this.info = info;
            this.set({ usdPerMin: info.usdPerMin, maxMin: info.maxMin });
            this.keep();
          } else if (!this.out) void this.api.discard(info.note.id).catch(() => undefined);
          return info;
        } catch (e) {
          late = (e as Error) === TIMED_OUT;
          // with a client id the console opens the same note again on the next try, so a late answer is not thrown away.
          if (late && !this.out) void tryP.then((i) => this.api.discard(i.note.id)).catch(() => undefined);
          const status = (e as { status?: number }).status;
          if (noteP !== this.noteP) throw e;
          if (status && status >= 400 && status < 500) {
            this.refused(e as Error);
            throw e;
          }
          if (this.clock.now() - t0 >= START_GIVE_UP_MS) {
            if (this.v.phase === "recording" || this.v.phase === "paused") this.set({ info: NO_ANSWER_TEXT });
            throw late ? new Error("the console did not answer") : e;
          }
        }
        await sleep(Math.min(START_TRY_MS, 500 * 2 ** i));
      }
    })();
    this.noteP = noteP;
    noteP.catch(() => undefined);
    return noteP;
  }

  /** the console said no to the note (voice off, the month's cap): nothing recorded is kept, its words are shown. */
  private refused(e: Error) {
    if (!(["starting", "recording", "paused"] as NotePhase[]).includes(this.v.phase)) return;
    this.noteP = undefined;
    this.info = undefined;
    if (this.rec) void this.closeSegment();
    this.releaseMic();
    this.store.clear();
    this.outDone();
    this.set({ phase: "failed", level: 0, error: e.message });
  }

  /** The note is given up here (the microphone did not open): throw it away on the console once it is open there. */
  private forgetNote() {
    this.outDone();
    const p = this.noteP;
    this.noteP = undefined;
    this.info = undefined;
    void p?.then((i) => this.api.discard(i.note.id)).catch(() => undefined);
  }

  /** write the open note to the browser's storage (id, parts in, length so far). */
  private keep() {
    void this.outNote();
    if (!this.info) return;
    this.store.set({
      id: this.info.note.id,
      ...(this.cid ? { cid: this.cid } : {}),
      next: this.segN,
      done: [...this.done],
      empty: [...this.empty],
      closedS: this.closedS,
      segmentS: this.info.segmentS,
      maxMin: this.info.maxMin,
      usdPerMin: this.info.usdPerMin,
      ...(this.page ? { page: this.page } : {}),
      at: this.clock.now(),
    });
  }

  /**
   * a page the phone reloaded (or closed) mid-note offers that note again, paused: Resume records on into it, Send
   * posts what is in. A note the console already closed is forgotten.
   */
  async recover(): Promise<boolean> {
    const k = this.store.get();
    if (!k || this.v.phase !== "idle") return false;
    if (this.clock.now() - k.at > KEEP_MS) return void this.store.clear(), false;
    const state = await this.api.state?.(k.id).catch(() => "unknown");
    // Still open on the console ("failed": its post did not go, Send tries again); posted or discarded: nothing to offer.
    if (state !== undefined && state !== "recording" && state !== "failed" && state !== "unknown") return void this.store.clear(), false;
    if (this.v.phase !== "idle") return false;
    this.info = { note: { id: k.id }, segmentS: k.segmentS, maxMin: k.maxMin, usdPerMin: k.usdPerMin, monthUsd: 0, monthCapUsd: Infinity };
    this.noteP = Promise.resolve(this.info);
    this.page = k.page;
    this.segN = k.next;
    this.closedS = k.closedS;
    this.done = new Set(k.done);
    this.empty = new Set(k.empty);
    // Send was pressed before the page went: nothing to offer, the outbox sends it now (same client id, once).
    if (k.cid && this.out && (await this.out.store.getNote(k.cid))?.send) {
      this.store.clear();
      this.info = undefined;
      this.noteP = undefined;
      this.reset();
      this.set({ phase: "idle" });
      return false;
    }
    // the parts that did not reach the console before the page went are in the outbox: Send uploads them.
    if (k.cid) {
      this.cid = k.cid;
      held.add(k.cid);
      this.beat();
      if (this.out) {
        const kept = await this.out.store.parts(k.cid);
        for (const p of kept) if (!this.done.has(p.n)) this.failed.set(p.n, { blob: p.blob, seconds: p.seconds }), this.empty.delete(p.n);
        const rec = await this.out.store.getNote(k.cid);
        if (rec && rec.parts > this.segN) this.segN = rec.parts;
      }
      // Neither Resume nor Send: it goes by itself (the owner: never lost, never waiting on a button).
      this.recoverTimer = setTimeout(() => {
        if (this.v.phase === "paused" && this.v.info === RECOVERED_TEXT) void this.finish();
      }, RECOVER_SEND_MS);
    }
    this.set({ phase: "paused", info: RECOVERED_TEXT, elapsedS: Math.floor(k.closedS), segments: k.next, uploaded: k.done.length + k.empty.length, usdPerMin: k.usdPerMin, maxMin: k.maxMin });
    return true;
  }

  private async openMic(noteP = this.noteP) {
    const stream = await this.media.microphone();
    // Thrown away (or refused) while the microphone opened: let it go at once.
    if (noteP !== this.noteP) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    this.startMs.mic ??= this.clock.now() - this.pressAt;
    // iOS mutes the microphone (a `mute` event) when the page is hidden or the phone locks; `ended` when another app takes it.
    for (const t of stream.getAudioTracks()) for (const ev of ["ended", "mute"]) t.addEventListener?.(ev, () => this.interrupted());
    this.meter = this.media.level?.(stream) ?? undefined;
    this.startSegment();
  }

  private startSegment() {
    const rec = this.media.recorder(this.stream!);
    const n = this.segN++;
    const chunks: Blob[] = [];
    const began = this.clock.now();
    const noteP = this.noteP;
    let done!: () => void;
    const stopped = new Promise<void>((ok) => (done = ok));
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
      // The recorder's own one-second events keep the clock going where a background tab slows timers.
      if (rec === this.rec) this.tick();
    };
    rec.onstop = () => {
      const seconds = Math.max(0, ((rec as RecorderLike & { stopAt?: number }).stopAt ?? this.clock.now()) - began) / 1000;
      // a part under a second (cut by a lock right after another cut) has no words and would not transcribe: skipped.
      const blob = seconds < MIN_AUDIO_S ? new Blob([]) : new Blob(chunks, { type: rec.mimeType || chunks[0]?.type || "audio/webm" });
      // the part's audio is in the browser's outbox before it is sent, until the console says it has it.
      if (blob.size && this.out && this.cid && noteP === this.noteP) void this.out.store.putPart({ cid: this.cid, n, blob, seconds });
      this.enqueue(n, blob, seconds, noteP);
      done();
    };
    (rec as RecorderLike & { stopped?: Promise<void>; began?: number }).stopped = stopped;
    this.rec = rec;
    this.recStart = began;
    this.set({ segments: this.segN });
    rec.start(1000);
  }

  /** Close the current segment (it uploads on its own); returns once its audio is handed over. */
  private closeSegment(): Promise<void> {
    const rec = this.rec as (RecorderLike & { stopped?: Promise<void> }) | undefined;
    if (!rec) return Promise.resolve();
    this.closedS += (this.clock.now() - this.recStart) / 1000;
    this.rec = undefined;
    try {
      (rec as RecorderLike & { stopAt?: number }).stopAt = this.clock.now();
      rec.stop();
    } catch {
      /* already stopped */
    }
    const p = rec.stopped ?? Promise.resolve();
    this.pendingStops.push(p);
    return p;
  }

  /** a part waits for its note's id (`noteP`, opened while it recorded); a thrown-away note uploads nothing. */
  private enqueue(n: number, blob: Blob, seconds: number, noteP = this.noteP) {
    if (!noteP || noteP !== this.noteP) return;
    this.queue = this.queue.then(async () => {
      if (noteP !== this.noteP) return;
      let id: string;
      try {
        id = (await noteP).note.id;
      } catch {
        // The note did not open on the console (yet): the part is kept, Send opens the note again and uploads it.
        if (noteP === this.noteP && blob.size) this.failed.set(n, { blob, seconds });
        else if (noteP === this.noteP) this.empty.add(n);
        return;
      }
      if (noteP !== this.noteP) return;
      if (!blob.size) {
        this.empty.add(n);
        this.keep();
        this.set({ uploaded: this.v.uploaded + 1 });
        return;
      }
      for (let i = 0; i < UPLOAD_TRIES; i++) {
        try {
          // the start's timings go with the parts until one is in (the console keeps the first).
          const sm = this.startMs.rec !== undefined && !this.done.size ? JSON.stringify(this.startMs) : undefined;
          const r = await (sm ? this.api.segment(id, n, blob, seconds, sm) : this.api.segment(id, n, blob, seconds));
          this.failed.delete(n);
          this.done.add(n);
          if (this.out && this.cid) void this.out.store.delPart(this.cid, n);
          this.keep();
          this.set({ uploaded: this.v.uploaded + 1, costUsd: r.note.costUsd });
          return;
        } catch (e) {
          // the console kept this part's audio but could not turn it into words: it is saved there, and
          // Send names it in the note with its audio link instead of holding the rest of what he said.
          if (i === UPLOAD_TRIES - 1 && (e as { code?: string }).code === "transcribe_failed") {
            this.failed.delete(n);
            this.done.add(n);
            if (this.out && this.cid) void this.out.store.delPart(this.cid, n);
            this.keep();
            this.set({ uploaded: this.v.uploaded + 1, error: `Part ${n + 1} is saved on the console but was not turned into words yet; the note names it with its audio.` });
            return;
          }
          if (i === UPLOAD_TRIES - 1) {
            this.failed.set(n, { blob, seconds });
            this.set({ error: `Part ${n + 1} did not upload yet (${(e as Error).message}); it is saved on this phone and Send retries it.` });
          }
        }
      }
    });
  }

  /** the microphone's level now, 0..1 (0 when nothing records), read by the meter many times a second. */
  readLevel(): number {
    if (this.v.phase !== "recording" || !this.meter) return 0;
    return Math.max(0, Math.min(1, this.meter.read()));
  }

  private tick() {
    if (this.v.phase !== "recording") return;
    const cur = this.rec ? (this.clock.now() - this.recStart) / 1000 : 0;
    const elapsedS = Math.floor(this.closedS + cur);
    const p: Partial<NoteView> = { elapsedS, estUsd: Math.round(((this.closedS + cur) / 60) * (this.info?.usdPerMin ?? 0.003) * 1e5) / 1e5 };
    if (this.meter) p.level = Math.max(0, Math.min(1, this.meter.read()));
    this.set(p);
    // a heartbeat on the kept note, so no other tab takes a note this one still records.
    if (this.out && this.clock.now() - this.beatAt > 30_000) {
      this.beatAt = this.clock.now();
      void this.outNote();
    }
    if (!this.noteP) return;
    // until the console's answer is in, the caps it usually sends (the view's, and two-minute parts) hold.
    const maxMin = this.info?.maxMin ?? this.v.maxMin;
    if (this.closedS + cur >= maxMin * 60) {
      this.stopWhy = capText(maxMin);
      this.set({ info: this.stopWhy });
      // the tick stops first: one Send, never one per tick while the last part closes.
      this.stopTick?.();
      this.stopTick = undefined;
      void this.finish();
      return;
    }
    // a visible warning before the cap (1 h 50 min of 2 hours), once per note.
    const warnMin = this.info?.warnMin ?? maxMin - 10;
    if (!this.warned && warnMin > 0 && this.closedS + cur >= warnMin * 60) {
      this.warned = true;
      this.set({ warn: warnText(maxMin, maxMin - (this.closedS + cur) / 60) });
    }
    // A new segment before the old one stops: no gap in what he says.
    if (this.rec && cur >= (this.info?.segmentS ?? DEFAULT_SEGMENT_S)) {
      // the console takes MAX_PARTS parts: at the last one the note is sent, never cut without a word.
      if (this.segN >= MAX_PARTS - 1) {
        this.stopWhy = PARTS_CAP_TEXT;
        this.set({ info: PARTS_CAP_TEXT });
        // the tick stops first: one Send, never one per tick while the last part closes.
        this.stopTick?.();
        this.stopTick = undefined;
        void this.finish();
        return;
      }
      this.rotate();
    }
  }

  /** Close the part being recorded (it uploads) and go on in a new one on the same microphone, with no gap. */
  private rotate() {
    const old = this.rec as (RecorderLike & { stopped?: Promise<void>; stopAt?: number }) | undefined;
    if (!old) return;
    this.closedS += (this.clock.now() - this.recStart) / 1000;
    this.startSegment();
    try {
      old.stopAt = this.clock.now();
      old.stop();
    } catch {
      /* already stopped */
    }
    this.pendingStops.push(old.stopped ?? Promise.resolve());
    this.keep();
  }

  /**
   * the page went out of view (phone locked, app switched) or came back. Out of view: what was said so far uploads now.
   * Back: a note the lock paused records on by itself, and the note says what happened.
   */
  async pageVisible(visible: boolean): Promise<void> {
    const now = this.clock.now();
    if (!visible) {
      this.hiddenAt = now;
      if (this.v.phase === "recording" && this.rec && (now - this.recStart) / 1000 >= MIN_PART_S && this.segN < MAX_PARTS - 2) this.rotate();
      return;
    }
    this.hiddenAt = undefined;
    this.shownAt = now;
    this.checkMic();
    await this.pickUp();
  }

  /** A note the lock paused records on (the page is in view again). */
  private async pickUp() {
    const at = this.lockedAt;
    if (at === undefined || this.v.phase !== "paused") return;
    this.lockedAt = undefined;
    await this.resume();
    if ((this.v.phase as NotePhase) === "recording") this.set({ info: resumedText(hhmm(at)) });
  }

  /** The microphone stopped under the note (iPhone locked, the mic taken): keep what is recorded, wait for Resume or Send. */
  interrupted() {
    if (this.v.phase !== "recording") return;
    const now = this.clock.now();
    void this.closeSegment();
    this.releaseMic();
    this.keep();
    this.set({ phase: "paused", info: INTERRUPTED_TEXT, level: 0, elapsedS: Math.floor(this.closedS) });
    // The lock (page hidden, or the mute that comes just after the page is back) paused it: it records on once in view.
    if (this.hiddenAt !== undefined || now - this.shownAt < 3000) {
      this.lockedAt = this.hiddenAt ?? now;
      if (this.hiddenAt === undefined) {
        this.shownAt = 0; // once per return: a microphone that keeps going mute leaves the note paused
        void this.pickUp();
      }
    }
  }

  /** The page is back in view (a phone unlocked): a microphone that ended or went mute under the note pauses it. */
  checkMic() {
    if (this.v.phase !== "recording") return;
    const t = this.stream?.getAudioTracks()[0];
    if (t && (t.readyState === "ended" || t.muted)) this.interrupted();
  }

  async resume() {
    if (this.v.phase !== "paused") return;
    try {
      await this.openMic();
    } catch (e) {
      return this.set({ error: micError(e) });
    }
    if (this.v.phase !== "paused" || !this.stream) return;
    this.set({ phase: "recording", info: undefined, error: undefined });
    if (!this.stopTick) this.stopTick = this.clock.every(250, () => this.tick());
    this.takeLock();
    this.keep();
  }

  /** Tap 2: stop, wait for every part to upload, and post the note. Also "Send again" after a failure. */
  async finish() {
    if (!this.noteP || !(["recording", "paused", "failed"] as NotePhase[]).includes(this.v.phase)) return;
    if (this.v.phase === "recording") await this.closeSegment();
    this.releaseMic();
    clearTimeout(this.recoverTimer);
    this.set({ phase: "sending", level: 0, elapsedS: Math.floor(this.closedS), error: undefined, ...(this.out ? { info: KEPT_TEXT } : {}) });
    void this.outNote({ send: true });
    await Promise.all(this.pendingStops);
    await this.queue;
    // the note never opened on the console while recording (no answer): open it now, the parts kept here go up.
    if (!this.info) {
      try {
        await this.openNote();
      } catch (e) {
        if ((this.v.phase as NotePhase) !== "sending") return;
        return this.set({ phase: "failed", error: `Not sent: ${(e as Error).message}. What you said is kept here. Tap Send again.`, ...(this.out ? { info: KEPT_FAILED_TEXT } : {}) }), void this.retryLater();
      }
    }
    const id = this.info!.note.id;
    for (const [n, f] of [...this.failed]) this.enqueue(n, f.blob, f.seconds);
    await this.queue;
    if (this.failed.size) return this.set({ phase: "failed", error: `Not sent: ${this.failed.size} part(s) did not upload. Tap Send again.`, ...(this.out ? { info: KEPT_FAILED_TEXT } : {}) }), void this.retryLater();
    try {
      const skip = [...Array(this.segN).keys()].filter((n) => !this.done.has(n));
      const r = await (skip.length ? this.api.finish(id, this.segN, this.page, skip) : this.api.finish(id, this.segN, this.page));
      this.store.clear();
      this.outDone();
      this.set({ phase: "sent", note: r.audio ? { ...r.note, audio: r.audio } : r.note, costUsd: r.note.costUsd, info: r.note.state === "empty" ? "Nothing was heard in that note, so nothing was posted." : this.stopWhy });
    } catch (e) {
      this.set({ phase: "failed", error: `Not sent: ${(e as Error).message}`, ...(this.out ? { info: KEPT_FAILED_TEXT } : {}) }), void this.retryLater();
    }
  }

  /** Throw the note away (nothing posted; what was already transcribed stays counted). */
  async discard() {
    const noteP = this.noteP;
    // No note any more before the last part closes, so it is never uploaded (nor transcribed and billed).
    this.noteP = undefined;
    this.info = undefined;
    if (this.rec) await this.closeSegment();
    this.releaseMic();
    this.store.clear();
    this.outDone();
    this.reset();
    this.set({ phase: "idle" });
    // A note still opening on the console is thrown away once it is open there.
    if (noteP) await noteP.then((i) => this.api.discard(i.note.id)).catch(() => undefined);
  }

  /** Back to the button after a sent note. */
  dismiss() {
    if (this.v.phase === "sent" || this.v.phase === "failed") {
      // closing a note that did not go never throws it away: the outbox keeps it and sends it by itself.
      if (this.v.phase === "failed" && this.out && this.cid) {
        this.outRelease();
        this.store.clear();
      } else if (this.v.phase === "failed" && this.noteP) {
        void this.noteP.then((i) => this.api.discard(i.note.id)).catch(() => undefined);
        this.store.clear();
      }
      this.noteP = undefined;
      this.info = undefined;
      this.reset();
      this.set({ phase: "idle" });
    }
  }

  /** The tab is closing: keep what was recorded on the console side by finishing if anything is in. */
  pageHide() {
    if (this.v.phase === "recording" || this.v.phase === "paused") void this.finish();
  }

  private releaseMic() {
    this.stopTick?.();
    this.stopTick = undefined;
    this.meter?.close();
    this.meter = undefined;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    void this.lock?.release().catch(() => undefined);
    this.lock = undefined;
  }

  private reset() {
    clearTimeout(this.recoverTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopBeat?.();
    this.stopBeat = undefined;
    this.cid = undefined;
    this.closedS = 0;
    this.warned = false;
    this.stopWhy = undefined;
    this.segN = 0;
    this.queue = Promise.resolve();
    this.failed.clear();
    this.pendingStops = [];
    this.done.clear();
    this.empty.clear();
    this.lockedAt = undefined;
    this.v = { phase: "idle", elapsedS: 0, level: 0, costUsd: 0, estUsd: 0, usdPerMin: this.v.usdPerMin, maxMin: this.v.maxMin, segments: 0, uploaded: 0 };
  }
}

/**
 * a microphone another app
 * holds (a phone call, mostly) is said plainly, and the button stays ready for when the call ends.
 */
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

/**
 * The console's note routes under `base` (`/api/voice`, or `/api/milestones/<id>/voice`). `fill`: the note is an answer
 * on a card, its words come back for the card's text box and nothing is posted to the chat.
 */
export function fetchNotesApi(base = "/api/voice", f: typeof fetch = (...a) => fetch(...a), o: { fill?: boolean } = {}): NotesApi {
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await f(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `console answered ${r.status}`), { status: r.status });
    return j as T;
  };
  return {
    start: (page, clientId) => call("POST", "/notes", { ...(page ? { page } : {}), ...(clientId ? { clientId } : {}) }),
    segment: async (id, n, audio, seconds, startMs) => {
      const headers: Record<string, string> = { "content-type": audio.type || "audio/webm", "x-seconds": seconds.toFixed(2), ...(startMs ? { "x-start-ms": startMs } : {}) };
      const r = await f(`${base}/notes/${id}/segments/${n}`, { method: "POST", headers, body: audio });
      const j = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `console answered ${r.status}`), { status: r.status, code: j?.error?.code });
      return j;
    },
    finish: (id, segments, page, skip) => call("POST", `/notes/${id}/finish`, { segments, ...(page ? { page } : {}), ...(skip?.length ? { skip } : {}), ...(o.fill ? { fill: true } : {}) }),
    discard: (id) => call("POST", `/notes/${id}/discard`, {}),
    state: async (id) => (await call<{ notes: { id: string; state: string }[] }>("GET", "/notes?limit=50")).notes.find((n) => n.id === id)?.state,
  };
}

/** 8-bit time-domain samples (128 = silence) to a 0..1 level: RMS in dB, -60 dB → 0, -12 dB → 1. */
export function levelOfSamples(buf: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += ((buf[i] - 128) / 128) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, buf.length));
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 48));
}

/** The recording formats, best first: opus in webm (Chrome, Firefox, Android), AAC in mp4 (Safari, iPhone). */
const MIMES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

export function browserNoteMedia(): NoteMedia {
  return {
    microphone: () => {
      if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("This browser does not let this page use the microphone (it needs https)."));
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    },
    recorder: (stream) => {
      const mimeType = MIMES.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m));
      // 32 kbit/s mono speech: about 0.5 MB per two-minute part.
      return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 }) as unknown as RecorderLike;
    },
    // the same stream the recorder
    // takes (no second getUserMedia) into an AnalyserNode; its loudness in dB, -60 dB (silence) to -12 dB (loud speech) as 0..1.
    level: (stream) => {
      const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!AC) return undefined;
      const ctx: AudioContext = new AC();
      // Safari starts a context made after an await suspended: it would read silence.
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      return {
        read: () => {
          if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
          an.getByteTimeDomainData(buf);
          return levelOfSamples(buf);
        },
        close: () => void ctx.close().catch(() => undefined),
      };
    },
    // taken again each time the page is back in view (the browser drops it on every lock).
    wakeLock: () => stickyWakeLock(),
  };
}
