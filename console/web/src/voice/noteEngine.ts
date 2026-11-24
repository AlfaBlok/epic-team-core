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
import { backoffMs, held, newCid, recount, settle, type OutboxStore, type OutNote } from "./outbox";
export * from "./noteShared";
import { IDLE_NOTE, capText, CHECKPOINT_MS, EARLY_MIN_BYTES, EMPTY_RECORDING_TEXT, INTERRUPTED_TEXT, KEEP_MS, KEPT_FAILED_TEXT, KEPT_TEXT, MAX_PARTS, memoryNoteStore, micError, MIN_AUDIO_S, MIN_PART_S, NO_ANSWER_TEXT, NoteClock, NoteMedia, NotePhase, NotesApi, NoteStartInfo, NoteStore, NoteView, PARTS_CAP_TEXT, RecorderLike, RECOVERED_TEXT, RECOVER_SEND_MS, noteMicrophone, resumedText, RETRY_MS, SendParts, SentNote, START_GIVE_UP_MS, START_TRY_MS, warnText } from "./noteShared";


const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const UPLOAD_TRIES = 3;
const DEFAULT_SEGMENT_S = 120;
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
  private v: NoteView = IDLE_NOTE;
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
  /** bytes of each part the console has while it records (`early`); parts whose early upload failed send whole. */
  private earlySent = new Map<number, number>();
  private earlyBusy = new Map<number, Promise<void>>();
  private earlyOff = new Set<number>();
  /** Send was tapped: the last part asks for Sent with its upload; its answer, when it did. */
  private acceptWith?: { segments: number; page?: string };
  private accepted?: { note: SentNote; audio?: string; accepted: true };
  private sendParts: SendParts = {};
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
  /** failed sends of this note in a row (the retry waits longer each time). */
  private retries = 0;

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
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.v.phase === "failed" && this.v.info === KEPT_FAILED_TEXT) void this.finish();
    }, Math.max(RETRY_MS, backoffMs(this.retries)));
  }
  /** the browser is back online: a kept note that did not go tries now. */
  online() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
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
  /**
   * the console confirmed the note (posted, written out, or nothing heard): it leaves the outbox, its audio kept on this
   * device as one of the last few (`keep`); a note thrown away or refused (`keep: false`) just leaves.
   */
  private outDone(keep = false) {
    const cid = this.cid;
    this.cid = undefined;
    this.stopBeat?.();
    this.stopBeat = undefined;
    if (cid) held.delete(cid);
    if (this.out && cid) void settle(this.out.store, cid, keep, this.clock.now()).then(() => recount(this.out!.store));
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
    let savedAt = began;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
      // the part being recorded is saved on this device every few seconds, so a closed tab or a crash loses almost nothing.
      if (rec === this.rec && chunks.length && this.out && this.cid && noteP === this.noteP && this.clock.now() - savedAt >= CHECKPOINT_MS) {
        savedAt = this.clock.now();
        const seconds = (savedAt - began) / 1000;
        if (seconds >= MIN_AUDIO_S) void this.out.store.putPart({ cid: this.cid, n, blob: new Blob(chunks, { type: rec.mimeType || chunks[0]?.type || "audio/webm" }), seconds });
      }
      if (rec === this.rec && noteP === this.noteP) this.pushEarly(n, chunks, rec.mimeType || chunks[0]?.type || "audio/webm");
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

  /** the part being recorded goes up while he talks, one request at a time, each once ~3 s of speech is new. */
  private pushEarly(n: number, chunks: Blob[], type: string) {
    const id = this.info?.note.id;
    if (!this.api.early || !id || this.earlyBusy.has(n) || this.earlyOff.has(n)) return;
    const sent = this.earlySent.get(n) ?? 0;
    const all = new Blob(chunks, { type });
    if (all.size - sent < EARLY_MIN_BYTES) return;
    const p = this.api
      .early(id, n, sent, all.slice(sent, all.size, type))
      .then((r) => void (r.have === all.size ? this.earlySent.set(n, r.have) : this.earlyOff.add(n)))
      .catch(() => void this.earlyOff.add(n))
      .finally(() => this.earlyBusy.delete(n));
    this.earlyBusy.set(n, p);
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
          // what went up while he talked is not sent again: only the tail.
          const waitFrom = this.clock.now();
          await this.earlyBusy.get(n);
          const earlyWaitMs = this.clock.now() - waitFrom;
          const eb = this.earlyOff.has(n) ? 0 : (this.earlySent.get(n) ?? 0);
          const earlyBytes = eb > 0 && eb <= blob.size ? eb : 0;
          // Send was tapped and this is the last part: it asks for Sent in the same request.
          const last = this.acceptWith && n === this.acceptWith.segments - 1 && !this.failed.size ? this.acceptWith : undefined;
          const accept = last ? { segments: last.segments, skip: [...Array(n).keys()].filter((x) => !this.done.has(x)), ...(last.page ? { page: last.page } : {}) } : undefined;
          const more = earlyBytes || accept ? { ...(earlyBytes ? { earlyBytes } : {}), ...(accept ? { accept } : {}) } : undefined;
          const body = earlyBytes ? blob.slice(earlyBytes, blob.size, blob.type) : blob;
          const upFrom = this.clock.now();
          const r = await (more ? this.api.segment(id, n, body, seconds, sm, more) : sm ? this.api.segment(id, n, body, seconds, sm) : this.api.segment(id, n, body, seconds));
          if (this.acceptWith && n === this.acceptWith.segments - 1) this.sendParts = { ...this.sendParts, earlyWaitMs, uploadMs: this.clock.now() - upFrom, tailBytes: body.size, earlyBytes };
          if (r.accepted && r.note.id) this.accepted = { note: r.note as SentNote, accepted: true };
          this.failed.delete(n);
          this.done.add(n);
          // its audio stays on this device until the note is confirmed (then it is kept as one of the last few).
          this.keep();
          this.set({ uploaded: this.v.uploaded + 1, costUsd: r.note.costUsd });
          return;
        } catch (e) {
          // the console lost the part's start (a restart): the next try sends it whole.
          if ((e as { code?: string }).code === "early_missing") this.earlyOff.add(n);
          // the console kept this part's audio but could not turn it into words: it is saved there, and
          // Send names it in the note with its audio link instead of holding the rest of what he said.
          if (i === UPLOAD_TRIES - 1 && (e as { code?: string }).code === "transcribe_failed") {
            this.failed.delete(n);
            this.done.add(n);
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
    // tap stop to Sent is timed (only a first Send: a "Send again" after a failure is not his wait at stop).
    const stopAt = this.v.phase === "failed" ? undefined : this.clock.now();
    // the last part asks for Sent with its own upload (no second round trip); a "Send again" uses the finish.
    this.acceptWith = stopAt !== undefined && this.v.phase === "recording" ? { segments: this.segN, ...(this.page ? { page: this.page } : {}) } : undefined;
    if (this.v.phase === "recording") await this.closeSegment();
    if (stopAt !== undefined) this.sendParts = { ...this.sendParts, stopMs: this.clock.now() - stopAt };
    this.releaseMic();
    clearTimeout(this.recoverTimer);
    this.set({ phase: "sending", level: 0, elapsedS: Math.floor(this.closedS), error: undefined, ...(this.out ? { info: KEPT_TEXT } : {}) });
    const keptHere = this.outNote({ send: true });
    await Promise.all(this.pendingStops);
    await this.queue;
    // E948-S174: nothing recorded went up and nothing waits to (0 s, or no audio bytes): dropped now, never kept
    if (!this.done.size && !this.failed.size) {
      const id = this.info?.note.id;
      if (id) void this.api.discard(id).catch(() => undefined);
      await Promise.resolve(keptHere).catch(() => undefined); // its outbox write lands first, then it leaves (no "Waiting to send")
      this.store.clear();
      this.retries = 0;
      this.outDone(false);
      return this.set({ phase: "sent", note: { id: id ?? "", state: "empty", seconds: 0, costUsd: 0, segments: 0 }, costUsd: 0, info: EMPTY_RECORDING_TEXT });
    }
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
      const r = this.accepted && this.accepted.note.id === id ? this.accepted : await (skip.length ? this.api.finish(id, this.segN, this.page, skip) : this.api.finish(id, this.segN, this.page));
      this.store.clear();
      this.retries = 0;
      this.outDone(true);
      this.set({ phase: "sent", note: r.audio ? { ...r.note, audio: r.audio } : r.note, costUsd: r.note.costUsd, info: r.note.state === "empty" ? "Nothing was heard in that note, so nothing was posted." : this.stopWhy });
      if (r.accepted && stopAt !== undefined) void this.api.timing?.(id, Math.max(0, this.clock.now() - stopAt), this.sendParts)?.catch(() => undefined);
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
    this.retries = 0;
    this.stopBeat?.();
    this.stopBeat = undefined;
    this.cid = undefined;
    this.closedS = 0;
    this.warned = false;
    this.stopWhy = undefined;
    this.segN = 0;
    this.queue = Promise.resolve();
    this.failed.clear();
    this.earlySent.clear();
    this.earlyBusy.clear();
    this.earlyOff.clear();
    this.acceptWith = undefined;
    this.accepted = undefined;
    this.sendParts = {};
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
    segment: async (id, n, audio, seconds, startMs, more) => {
      // x-quick: the console answers once the part's audio is stored; its words follow in the background.
      const headers: Record<string, string> = {
        "content-type": audio.type || "audio/webm",
        "x-seconds": seconds.toFixed(2),
        "x-quick": "1",
        ...(startMs ? { "x-start-ms": startMs } : {}),
        ...(more?.earlyBytes ? { "x-early-bytes": String(more.earlyBytes) } : {}),
        // a card's answer waits for its words (finish with fill): never Sent early.
        ...(more?.accept && !o.fill ? { "x-accept": JSON.stringify(more.accept) } : {}),
      };
      const r = await f(`${base}/notes/${id}/segments/${n}`, { method: "POST", headers, body: audio });
      const j = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `console answered ${r.status}`), { status: r.status, code: j?.error?.code });
      return j;
    },
    // a chat note is Sent once its audio is safe on the console (quick); a card's answer waits for its words.
    finish: (id, segments, page, skip) => call("POST", `/notes/${id}/finish`, { segments, ...(page ? { page } : {}), ...(skip?.length ? { skip } : {}), ...(o.fill ? { fill: true } : { quick: true }) }),
    timing: (id, sentMs, parts) => call("POST", `/notes/${id}/timing`, { sentMs: Math.round(sentMs), ...(parts && Object.keys(parts).length ? { parts } : {}) }),
    early: async (id, n, offset, bytes) => {
      const r = await f(`${base}/notes/${id}/segments/${n}/early`, { method: "POST", headers: { "content-type": bytes.type || "audio/webm", "x-offset": String(offset) }, body: bytes });
      const j = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `console answered ${r.status}`), { status: r.status, code: j?.error?.code });
      return j;
    },
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
    microphone: noteMicrophone,
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
