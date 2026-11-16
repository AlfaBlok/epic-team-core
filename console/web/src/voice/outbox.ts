/**
 * every voice note is kept in this browser
 * (IndexedDB: each part's audio plus where the note belongs) from the moment a part stops recording until the console says it
 * stored it. The note has a client id (`cid`) from its first moment; the console opens it once per cid, takes each part once
 * and posts it once, so a resend after a failure, a reload, an outage or a closed tab never makes a second note.
 *
 * Two writers share this outbox: the tab's NoteEngine (the note being recorded) and `drain` (every note no engine holds: a
 * page that was reloaded or closed, a send that failed, a server that restarted). `drain` runs on every page load, when the
 * browser is back online and every DRAIN_EVERY_MS while anything is waiting.
 */

export interface OutNote {
  /** The client id: the note's name in this browser and on the console (`clientId` on start). */
  cid: string;
  /** The console's note route the note was started on (`/api/voice`, `/api/milestones/<id>/voice`, a steps page's). */
  base: string;
  /** A card's answer (`fill`): its words were for a card's box. Sent by `drain`, it is posted to the chat instead. */
  fill?: boolean;
  /** Where it was recorded (the page hint the console keeps). */
  page?: string;
  /** Where it goes, in words (the waiting line: "to: Chat", a card's title). */
  to?: string;
  /** The console's id, once it opened the note. */
  id?: string;
  /** Parts recorded so far (0..parts-1); a part not in the outbox and not in `done` had no audio. */
  parts: number;
  done: number[];
  /** Send was pressed (or the page closed): the note is to be posted once every part is in. */
  send?: boolean;
  /** Last time the recording tab touched it (ms). A note untouched for ABANDON_MS that no tab holds is sent by `drain`. */
  at: number;
  /** When it was recorded (ms), for the waiting line. */
  startedAt: number;
  seconds: number;
  tries?: number;
  error?: string;
  /** No try before this time (ms): the wait doubles after each failed try, up to RETRY_MAX_MS, and never gives up. */
  nextAt?: number;
}
export interface OutPart {
  cid: string;
  n: number;
  blob: Blob;
  seconds: number;
}

/** A note the console confirmed, kept on this device afterwards (the last KEEP_SENT), its parts' audio in order. */
export interface SentRec {
  cid: string;
  to?: string;
  page?: string;
  startedAt: number;
  sentAt: number;
  seconds: number;
  parts: { n: number; blob: Blob; seconds: number }[];
}
/** How many sent recordings stay on the device after the console confirmed them. */
export const KEEP_SENT = 5;

export interface OutboxStore {
  putNote(n: OutNote): Promise<void>;
  getNote(cid: string): Promise<OutNote | undefined>;
  notes(): Promise<OutNote[]>;
  delNote(cid: string): Promise<void>;
  putPart(p: OutPart): Promise<void>;
  parts(cid: string): Promise<OutPart[]>;
  delPart(cid: string, n: number): Promise<void>;
  /** the last sent recordings (newest first) */
  sent(): Promise<SentRec[]>;
  putSent(r: SentRec): Promise<void>;
  delSent(cid: string): Promise<void>;
}

const DB = "epicteam-voice-outbox";
const NOTES = "notes";
const PARTS = "parts";
const SENT = "sent";

/** IndexedDB, where the browser has it; undefined in tests and in browsers that keep none (the memory store takes over). */
export function idbOutbox(idb: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): OutboxStore | undefined {
  if (!idb) return undefined;
  let dbP: Promise<IDBDatabase> | undefined;
  const open = () =>
    (dbP ??= new Promise<IDBDatabase>((ok, no) => {
      const r = idb.open(DB, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(SENT)) db.createObjectStore(SENT, { keyPath: "cid" });
        if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: "cid" });
        if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS, { keyPath: ["cid", "n"] }).createIndex("cid", "cid");
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => {
        dbP = undefined;
        no(r.error ?? new Error("IndexedDB did not open"));
      };
    }));
  const run = async <T,>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> => {
    const db = await open();
    return new Promise<T>((ok, no) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => ok((req ? req.result : undefined) as T);
      tx.onerror = () => no(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => no(tx.error ?? new Error("IndexedDB write aborted"));
    });
  };
  return {
    putNote: (n) => run(NOTES, "readwrite", (s) => void s.put(n)),
    getNote: (cid) => run<OutNote | undefined>(NOTES, "readonly", (s) => s.get(cid)),
    notes: () => run<OutNote[]>(NOTES, "readonly", (s) => s.getAll()),
    delNote: async (cid) => {
      const db = await open();
      await new Promise<void>((ok, no) => {
        const tx = db.transaction([NOTES, PARTS], "readwrite");
        tx.objectStore(NOTES).delete(cid);
        tx.objectStore(PARTS).delete(IDBKeyRange.bound([cid, -Infinity], [cid, Infinity]));
        tx.oncomplete = () => ok();
        tx.onerror = () => no(tx.error ?? new Error("IndexedDB delete failed"));
      });
    },
    putPart: (p) => run(PARTS, "readwrite", (s) => void s.put(p)),
    parts: (cid) => run<OutPart[]>(PARTS, "readonly", (s) => s.index("cid").getAll(cid)),
    delPart: (cid, n) => run(PARTS, "readwrite", (s) => void s.delete([cid, n])),
    sent: async () => (await run<SentRec[]>(SENT, "readonly", (s) => s.getAll())).sort((a, b) => b.sentAt - a.sentAt),
    putSent: (x) => run(SENT, "readwrite", (s) => void s.put(x)),
    delSent: (cid) => run(SENT, "readwrite", (s) => void s.delete(cid)),
  };
}

/** The same, in memory (tests; a browser with no IndexedDB still keeps the note for the life of the tab). */
export function memoryOutbox(): OutboxStore {
  const notes = new Map<string, OutNote>();
  const parts = new Map<string, OutPart>();
  const sent = new Map<string, SentRec>();
  const k = (cid: string, n: number) => `${cid}:${n}`;
  return {
    putNote: async (n) => void notes.set(n.cid, { ...n, done: [...n.done] }),
    getNote: async (cid) => {
      const n = notes.get(cid);
      return n ? { ...n, done: [...n.done] } : undefined;
    },
    notes: async () => [...notes.values()].map((n) => ({ ...n, done: [...n.done] })),
    delNote: async (cid) => {
      notes.delete(cid);
      for (const key of [...parts.keys()]) if (key.startsWith(`${cid}:`)) parts.delete(key);
    },
    putPart: async (p) => void parts.set(k(p.cid, p.n), p),
    parts: async (cid) => [...parts.values()].filter((p) => p.cid === cid).sort((a, b) => a.n - b.n),
    delPart: async (cid, n) => void parts.delete(k(cid, n)),
    sent: async () => [...sent.values()].sort((a, b) => b.sentAt - a.sentAt),
    putSent: async (x) => void sent.set(x.cid, x),
    delSent: async (cid) => void sent.delete(cid),
  };
}

/** A store whose every call is safe: a full or broken IndexedDB never stops a note (it is still sent from memory). */
function safe(s: OutboxStore): OutboxStore {
  const wrap =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>, dflt: R) =>
    async (...a: A): Promise<R> => {
      try {
        return await f(...a);
      } catch (e) {
        console.warn("voice outbox:", (e as Error).message);
        return dflt;
      }
    };
  return {
    putNote: wrap(s.putNote, undefined),
    getNote: wrap(s.getNote, undefined),
    notes: wrap(s.notes, []),
    delNote: wrap(s.delNote, undefined),
    putPart: wrap(s.putPart, undefined),
    parts: wrap(s.parts, []),
    delPart: wrap(s.delPart, undefined),
    sent: wrap(s.sent, []),
    putSent: wrap(s.putSent, undefined),
    delSent: wrap(s.delSent, undefined),
  };
}

/**
 * The console confirmed the note: its audio moves from the waiting list to the last KEEP_SENT kept on this device (older ones
 * leave), and the note leaves the outbox. `keep: false` (thrown away, nothing recorded): it just leaves.
 */
export async function settle(store: OutboxStore, cid: string, keep = true, now = Date.now()): Promise<void> {
  if (keep) {
    const n = await store.getNote(cid);
    const parts = (await store.parts(cid)).filter((p) => p.blob && p.blob.size > 0);
    if (parts.length) {
      await store.putSent({
        cid,
        ...(n?.to ? { to: n.to } : {}),
        ...(n?.page ? { page: n.page } : {}),
        startedAt: n?.startedAt ?? now,
        sentAt: now,
        seconds: n?.seconds || parts.reduce((t, p) => t + p.seconds, 0),
        parts: parts.map((p) => ({ n: p.n, blob: p.blob, seconds: p.seconds })),
      });
      for (const old of (await store.sent()).slice(KEEP_SENT)) await store.delSent(old.cid);
    }
  }
  await store.delNote(cid);
  sentChanged();
}

/* the last sent recordings: the list on the voice notes page follows them */
const sentSubs = new Set<() => void>();
let sentVer = 0;
function sentChanged() {
  sentVer++;
  for (const f of sentSubs) f();
}
export const sentVersion = () => sentVer;
export function subscribeSent(f: () => void) {
  sentSubs.add(f);
  return () => void sentSubs.delete(f);
}

let shared: OutboxStore | undefined;
/** The tab's outbox (IndexedDB where there is one). */
export function outbox(): OutboxStore {
  return (shared ??= safe(idbOutbox() ?? memoryOutbox()));
}
/** Send now (the waiting list's button): every waiting note tries at once. */
export const sendNow = () => drain(undefined, undefined, undefined, { force: true });
/** Tests: a fresh outbox. */
export function setOutbox(s: OutboxStore | undefined) {
  shared = s ? safe(s) : undefined;
  changed();
}

export const newCid = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

/** Notes the engines of this tab hold right now (recording, paused, sending): `drain` leaves them to their engine. */
export const held = new Set<string>();

/* --- the waiting line: what is kept here and not yet confirmed --- */
export interface OutboxState {
  /** Notes kept on this phone, not yet confirmed by the console. */
  waiting: number;
  /** Notes `drain` confirmed since the page loaded (the "sent" line shows a few seconds). */
  sentAt?: number;
  sent: number;
  error?: string;
  /** the next try of a waiting note (ms), when it is in the future. */
  nextAt?: number;
}
let state: OutboxState = { waiting: 0, sent: 0 };
const subs = new Set<() => void>();
function changed() {
  for (const f of subs) f();
}
export const outboxState = () => state;
export function subscribeOutbox(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}
function setState(p: Partial<OutboxState>) {
  state = { ...state, ...p };
  changed();
}
/** Recount what waits (after any engine or `drain` change). Only notes no engine holds count: those are the "kept here" ones. */
export async function recount(store = outbox()): Promise<number> {
  const all = (await store.notes()).filter((n) => !held.has(n.cid));
  const waiting = all.length;
  const next = all.map((n) => n.nextAt ?? 0).filter((t) => t > Date.now());
  const nextAt = waiting && next.length === waiting ? Math.min(...next) : undefined;
  if (waiting !== state.waiting || nextAt !== state.nextAt) setState({ waiting, nextAt });
  return waiting;
}

/* --- drain: send every note no engine holds --- */
/** The console's note routes `drain` uses (fetch in the page; tests fake them). */
export interface DrainApi {
  start(base: string, cid: string, page?: string): Promise<{ id: string }>;
  segment(base: string, id: string, n: number, blob: Blob, seconds: number): Promise<unknown>;
  finish(base: string, id: string, segments: number, page?: string, skip?: number[]): Promise<{ state: string }>;
}
/** A note no tab touched for this long, and not held here, is sent as it is (its page was closed or reloaded mid-note). */
export const ABANDON_MS = 3 * 60_000;
/** While anything waits, `drain` looks this often (each note itself waits its own backoff, `nextAt`). */
export const DRAIN_EVERY_MS = 20_000;
/** The wait after a failed try: 20 s, doubling each try, at most 30 minutes; a note is never given up, for days if need be. */
export const RETRY_FIRST_MS = 20_000;
export const RETRY_MAX_MS = 30 * 60_000;
export const backoffMs = (tries: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, tries - 1));
const status = (e: unknown) => (e as { status?: number })?.status;
/** The console's answer for a note it already closed (409 note_closed: posted, transcribed, empty or thrown away; 404: gone). */
export const closed = (e: unknown) => (status(e) === 404 && /^no voice note/.test((e as Error).message ?? "")) || (status(e) === 409 && /\bis (posted|transcribed|discarded|empty)\b/.test((e as Error).message ?? ""));

let running: Promise<number> | undefined;
/**
 * Send every kept note no engine holds: open it (once per cid), upload each kept part (the console takes a part once), post it
 * (once). Confirmed notes leave the outbox. Returns how many were confirmed. Never two drains at once in a tab.
 */
export function drain(api: DrainApi = fetchDrainApi(), store = outbox(), now = Date.now, o: { force?: boolean } = {}): Promise<number> {
  if (running) return running;
  running = (async () => {
    let sent = 0;
    try {
      for (const n of await store.notes()) {
        if (held.has(n.cid)) continue;
        if (!n.send && now() - n.at < ABANDON_MS) continue;
        // backing off after a failed try (back online, a page opened, Send now: `force` tries at once).
        if (!o.force && n.nextAt && n.nextAt > now()) continue;
        try {
          if (await sendOne(n, api, store, now)) sent++;
        } catch (e) {
          // The console closed the note already (posted from another tab, or thrown away there): nothing more to send.
          if (closed(e)) {
            await settle(store, n.cid, true, now());
            continue;
          }
          // Anything else (offline, a restart, a 5xx, a part not in yet) waits for the next try, the note kept here.
          const kept = (await store.getNote(n.cid)) ?? n;
          const tries = (kept.tries ?? 0) + 1;
          await store.putNote({ ...kept, tries, nextAt: now() + backoffMs(tries), error: (e as Error).message });
          setState({ error: (e as Error).message });
        }
      }
    } finally {
      running = undefined;
      const left = await recount(store);
      if (sent) setState({ sent: state.sent + sent, sentAt: now(), ...(left ? {} : { error: undefined }) });
    }
    return sent;
  })();
  return running;
}

/** One kept note to the console. True: the console confirmed it (posted, or nothing was heard); it left the outbox. */
async function sendOne(n: OutNote, api: DrainApi, store: OutboxStore, now = Date.now): Promise<boolean> {
  const parts = await store.parts(n.cid);
  if (!n.id) {
    if (!parts.length && !n.done.length) {
      // Nothing recorded and nothing on the console: nothing to keep.
      await store.delNote(n.cid);
      return false;
    }
    n = { ...n, id: (await api.start(n.base, n.cid, n.page)).id };
    await store.putNote(n);
  }
  const done = new Set(n.done);
  for (const p of parts) {
    if (!done.has(p.n)) {
      await api.segment(n.base, n.id!, p.n, p.blob, p.seconds);
      done.add(p.n);
      n = { ...n, done: [...done] };
      await store.putNote(n);
    }
    // the part's audio stays here until the note is confirmed (then it is one of the last ones kept on this device).
  }
  const segments = Math.max(n.parts, ...[...done].map((x) => x + 1), ...parts.map((p) => p.n + 1), 0);
  if (!segments) {
    await store.delNote(n.cid);
    return false;
  }
  const skip = [...Array(segments).keys()].filter((x) => !done.has(x));
  await api.finish(n.base, n.id!, segments, n.page, skip);
  await settle(store, n.cid, true, now());
  return true;
}

/** The console's routes for `drain`. A card's answer (fill) goes as a chat note: its card box is gone with the page. */
export function fetchDrainApi(f: typeof fetch = (...a) => fetch(...a)): DrainApi {
  const call = async <T,>(url: string, init: RequestInit): Promise<T> => {
    const r = await f(url, init);
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `console answered ${r.status}`), { status: r.status });
    return j as T;
  };
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    start: async (base, cid, page) => (await call<{ note: { id: string } }>(`${base}/notes`, json({ clientId: cid, ...(page ? { page } : {}) }))).note,
    segment: (base, id, n, blob, seconds) =>
      call(`${base}/notes/${id}/segments/${n}`, { method: "POST", headers: { "content-type": blob.type || "audio/webm", "x-seconds": seconds.toFixed(2) }, body: blob }),
    finish: async (base, id, segments, page, skip) => (await call<{ note: { state: string } }>(`${base}/notes/${id}/finish`, json({ segments, ...(page ? { page } : {}), ...(skip?.length ? { skip } : {}) }))).note,
  };
}

let started = false;
/** Once per tab (App): drain now, when back online, when the page is shown again, and every DRAIN_EVERY_MS while notes wait. */
export function startOutbox(win: Window | undefined = typeof window === "undefined" ? undefined : window): () => void {
  if (started || !win) return () => undefined;
  started = true;
  const go = () => void drain().catch(() => undefined);
  // back online, or the page shown again: every waiting note tries now, whatever its backoff.
  const now = () => void drain(undefined, undefined, undefined, { force: true }).catch(() => undefined);
  const t = setInterval(() => {
    if (state.waiting) go();
  }, DRAIN_EVERY_MS);
  win.addEventListener("online", now);
  win.addEventListener("pageshow", now);
  // ask the browser to keep this site's storage (the audio waiting here) even when the device runs low on space.
  void (win.navigator as Navigator | undefined)?.storage?.persist?.().catch(() => undefined);
  void recount().then(now);
  return () => {
    started = false;
    clearInterval(t);
    win.removeEventListener("online", now);
    win.removeEventListener("pageshow", now);
  };
}
