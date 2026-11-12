import os from "node:os";
import path from "node:path";
import type { Context, Hono } from "hono";
import type { DB } from "../db.js";
import { proxied, trustedPeer } from "../auth/identity.js";
import type { ConnSummary, MemoryEntry, MemoryListed, MemoryLookup, VoiceNoteList } from "../plug/memory.js";
import { verifyStripeSignature } from "../auth/signedHook.js";
import { homeRepo, memoryName, memoryPattern, ownerName } from "../identity.js";

/**
 * the owner's WhatsApp voice notes reach the Team desk. the memory service transcribes each one into his memory; the console
 * polls the memory service for new ones (search_memory contentType voice_note, source whatsapp) and posts each transcript into the desk
 * thread as his message, with the note's the memory service reference and GitHub link. The desk places it (seed v13) and links back.
 * Once per note: a row per evidenceRef here, and a stable clientRequestId per note, so neither a retry nor a restart posts
 * twice. Notes captured before the relay was first switched on (minus BACKFILL_MS) are recorded as seeded, never posted.
 *
 * push instead of polling. the memory service (memory-mt, on this host) POSTs a signed hook with the new note's evidenceRef the
 * moment it stores a voice note; the console reads that note itself with get_memory (the hook is only a pointer, never
 * trusted for content), checks it is the owner's WhatsApp voice note and posts it like a polled one. Once a signed hook about
 * a freshly captured note has arrived the minute poll becomes a safety net every SAFETY_NET_MS; if that net ever finds a note no hook announced, the
 * relay goes back to the minute poll until the next signed hook.
 */

/** Page hint of a relayed note: the desk's seed says what to do with it. */
export const voiceNotePage = (): string => `voice note to ${memoryName()}`;
/** First characters of a relayed note's text (the chat shows it as the owner's message). */
export const VOICE_NOTE_HEAD = "🎙 Voice note";
/** On first switch-on, notes from this far back are still posted (older ones are seeded as already handled). */
export const BACKFILL_MS = 2 * 60 * 60_000;
/**
 * The most characters of his words in one desk message. A longer transcript goes to the desk in parts of at most this many
 * (it was cut here before, so the desk never read the last ~25 minutes of his one-hour note of 2026-11-10 23:08Z).
 */
export const TRANSCRIPT_MAX = 30_000;
/** How far before the newest posted note each poll looks again (the memory service may index a note minutes after it was captured). */
export const LOOKBACK_MS = 6 * 60 * 60_000;
/** Give up on a note after this many failed posts (it stays listed as failed). */
const MAX_TRIES = 10;
/** with the push live, the poll only runs this often (a net for a hook that never came). */
export const SAFETY_NET_MS = 20 * 60_000;
/** a hooked note the memory service cannot answer yet is read again after these delays; after the last, the net has it. */
export const HOOK_RETRY_MS = [5_000, 30_000, 120_000];
/** only a hook about a note captured this recently proves the push (a replay of an old note never does). */
export const HOOK_FRESH_MS = 15 * 60_000;
/** a signed hook older or newer than this (seconds) is refused: a replayed capture is useless after it. */
export const HOOK_TOLERANCE_SEC = 300;

export function ensureVoiceNoteTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_voice_notes (
      evidence_ref TEXT PRIMARY KEY,
      captured_at TEXT,
      url TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      seen_at TEXT NOT NULL,
      posted_at TEXT,
      tries INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS desk_voice_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS desk_voice_hooks (evidence_ref TEXT PRIMARY KEY, received_at TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'received');
  `);
  // when the note's transcript reached the team repo (voice/<day>.md); null = not yet.
  const cols = (db.prepare("PRAGMA table_info(desk_voice_notes)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("archived_at")) db.exec("ALTER TABLE desk_voice_notes ADD COLUMN archived_at TEXT");
  // how the note reached the desk (poll | hook) and when its hook came (latency = posted_at - hook_at).
  if (!cols.includes("via")) db.exec("ALTER TABLE desk_voice_notes ADD COLUMN via TEXT");
  if (!cols.includes("hook_at")) db.exec("ALTER TABLE desk_voice_notes ADD COLUMN hook_at TEXT");
}

/** Notes copied to the team repo per pass at most (a backlog drains over a few passes). */
const ARCHIVE_BATCH = 25;

/** The words of the memory service voice-note entry: the block after its ingest header (`Voice note "…" ingested…`, `User context: …`). */
export function transcriptOf(content: string): string {
  const text = content.replace(/\r\n/g, "\n").trim();
  const cut = text.indexOf("\n\n");
  if (cut > 0 && new RegExp(`ingested through ${memoryPattern()}|^Raw artifact|^Transcribed by|^User context`, "m").test(text.slice(0, cut))) return text.slice(cut + 2).trim();
  return text;
}

const hhmm = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : "time unknown");

/**
 * his words in parts of at most `max` characters, nothing dropped. Each part ends at the last sentence end (else
 * the last space) in its window, so no word is split; a window with neither is cut hard.
 */
export function splitWords(words: string, max = TRANSCRIPT_MAX): string[] {
  const text = words.trim();
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let at = -1;
    for (const m of window.matchAll(/[.!?…]["'”’)]*\s+/g)) if (m.index! + m[0].length <= max + 1 && m.index! > max / 2) at = m.index! + m[0].length;
    if (at < 0) at = window.lastIndexOf(" ") > max / 2 ? window.lastIndexOf(" ") + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * a note longer than this many characters of his words (about two minutes of speech) is read in two
 * passes before anything is filed: pass 1 every ask with his quote, pass 2 merge into ideas and match each to open work, then
 * file. Measured on one long note of the owner's: one pass 5 repeats and 6 dropped, two passes 0 and 0.
 */
export const LONG_NOTE_CHARS = 2_000;
/** First characters of the long-note line under a relayed note's header (the desk seed names it). */
export const TWO_PASS_HEAD = "📋 Long note";

/**
 * The line a long note carries under its header, or "" for a short one (one pass, as before). For a note in parts each part
 * carries it, and only the last says to start: the passes need the whole note.
 */
export function twoPassLine(words: string, k = 1, n = 1): string {
  const chars = words.trim().length;
  if (chars <= LONG_NOTE_CHARS) return "";
  const when = n > 1 && k < n ? `wait for part ${n} of ${n}, then` : "now";
  return `${TWO_PASS_HEAD} (${chars.toLocaleString("en-US")} characters, over ${LONG_NOTE_CHARS.toLocaleString("en-US")}): two passes before filing, ${when} run them (seed: Long voice notes, two passes).`;
}

/** The header lines of one part: header (with "part k of n"), the long-note line when it applies, the memory reference. */
export function noteHeadLines(head: string, refLine: string, words: string, k: number, n: number): string[] {
  const long = twoPassLine(words, k, n);
  return [partHead(head, k, n), ...(long ? [long] : []), refLine];
}

/** The header line of a relayed note, with "part k of n" when it comes in parts. */
const partHead = (head: string, k: number, n: number) => (n > 1 ? `${head} · part ${k} of ${n}${k > 1 ? " (continues the part before)" : ""}` : head);

/**
 * The desk messages for one note: header, the memory service ref + link, then his words. A transcript over TRANSCRIPT_MAX is
 * sent whole in parts, each part its own message with "part k of n" in the header.
 */
export function voiceNoteMessages(ref: string, e: Pick<MemoryEntry, "content" | "capturedAt" | "githubUrl" | "url">): string[] {
  const link = e.githubUrl || e.url;
  const all = transcriptOf(e.content ?? "") || "(no transcript)";
  const parts = splitWords(all);
  const head = `${VOICE_NOTE_HEAD} (WhatsApp → ${memoryName()}), ${hhmm(e.capturedAt)}`;
  const refLine = `${memoryName()}: ${ref}${link ? ` · ${link}` : ""}`;
  return parts.map((words, i) => [...noteHeadLines(head, refLine, all, i + 1, parts.length), "", words].join("\n"));
}

/** The whole note as one text (its words never cut), for readers that are not the desk thread (the card-touch pass). */
export function voiceNoteMessage(ref: string, e: Pick<MemoryEntry, "content" | "capturedAt" | "githubUrl" | "url">): string {
  const link = e.githubUrl || e.url;
  const words = transcriptOf(e.content ?? "") || "(no transcript)";
  return [`${VOICE_NOTE_HEAD} (WhatsApp → ${memoryName()}), ${hhmm(e.capturedAt)}`, `${memoryName()}: ${ref}${link ? ` · ${link}` : ""}`, "", words].join("\n");
}

/** The request id of part k (1-based) of a note: part 1 keeps the id a one-part note always had, so nothing is posted twice. */
export const partRequestId = (base: string, k: number) => (k > 1 ? `${base}-p${k}` : base);

export interface VoiceRelayOptions {
  db: DB;
  list: VoiceNoteList;
  read: MemoryLookup;
  /** Post into the desk thread as the owner's message: true once T3 took it (or is retrying it), else why not. */
  post: (text: string, page: string, clientRequestId: string) => Promise<true | string>;
  now?: () => Date;
  /**
   * copy transcripts into the team repo (voice/<day>.md); returns the note ids now on file. Absent = no copy.
   * Posted notes are copied, and notes recorded before the switch-on (seeded) from the archive floor on (meta
   * `archive_since`, default the start of the UTC day of the first copy), so the day's notes the desk placed by hand
   * are there too. A failed copy is retried on the next poll.
   */
  archive?: (notes: { ref: string; capturedAt?: string; url?: string; text: string }[]) => Promise<{ status?: string; archived: string[] }>;
  /** delays before a hooked note is read again (tests pass []). */
  hookRetryMs?: number[];
  /** the safety-net interval once the push is live. */
  safetyNetMs?: number;
  /** run `fn` after `ms` (tests run it at once or never). */
  later?: (fn: () => void, ms: number) => void;
  /**
   * this relay's world's the memory service connection (Connections → Webhooks), if live. While it is, notes come by push to
   * that connection, the minute poll on our own token is off (app.ts), and the status says so.
   */
  connection?: () => ConnSummary | undefined;
  /** every world the platform runs and its connection, for the per-world lines of the status. */
  worlds?: () => { world: string; team: string; connection?: ConnSummary }[];
}

/** one world's path for voice notes, as GET /desk/voice-notes shows it. */
export interface VoiceWorldStatus {
  world: string;
  team: string;
  /** push: the memory service calls the world's connection; poll: our own token every minute (the home world before it connected); off: neither. */
  mode: "push" | "poll" | "off";
  via?: string;
  connectedAt?: string;
  pollEveryMs?: number;
  safetyEveryMs?: number;
  safety?: { at?: string; result?: string };
  today: { day: string; hookDeliveries: number; safetySearches: number; pollSearches: number };
  lastNote?: { ref: string; capturedAt?: string; postedAt?: string; via?: string; hookAt?: string; ms?: number };
}

export interface VoiceRelayStatus {
  state: "unchecked" | "polling" | "error" | "push";
  detail: string;
  checkedAt?: string;
  since?: string;
  recent: { ref: string; capturedAt?: string; url?: string; state: string; reason?: string; postedAt?: string; archivedAt?: string; via?: string; hookAt?: string }[];
  /** the team-repo copy: last outcome and its floor. */
  archive?: { since?: string; detail?: string; at?: string };
  /** push (a signed hook arrived; the poll is a net every pollEveryMs) or poll (every minute). */
  mode: "push" | "poll";
  /** The minute poll's interval; null while a connection carries the notes (the poll is off). */
  pollEveryMs: number | null;
  /** the connection that carries the notes (zcn_…) while mode is push by connection. */
  via?: string;
  /** the connection's safety check (its only search) while the poll is off. */
  safetyEveryMs?: number;
  /** minute-poll searches on our own token since the connection was made (0 = the poll is really off). */
  pollSearchesSinceConnected?: number;
  /** today (UTC) at a glance. */
  today?: VoiceWorldStatus["today"];
  /** the newest real note on the desk and the path that carried it. */
  lastNote?: VoiceWorldStatus["lastNote"];
  worlds?: VoiceWorldStatus[];
  hook: { okAt?: string; missed?: string; last?: { ref: string; at: string; result: string } };
  /**
   * the memory service calls per UTC day: minute-poll searches and reads on our own token (search, get), hooks received (the
   * old env hook plus, r4, the connection's signed deliveries) and, with a connection, its safety searches and reads.
   */
  calls: Record<string, { search: number; get: number; hooks: number; safety?: number; reads?: number }>;
}

export function createVoiceNoteRelay(o: VoiceRelayOptions) {
  ensureVoiceNoteTables(o.db);
  const now = o.now ?? (() => new Date());
  const retryMs = o.hookRetryMs ?? HOOK_RETRY_MS;
  const safetyNetMs = o.safetyNetMs ?? SAFETY_NET_MS;
  const later = o.later ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms).unref());
  let last: Omit<VoiceRelayStatus, "recent" | "since" | "mode" | "pollEveryMs" | "hook" | "calls"> = { state: "unchecked", detail: "not polled yet" };
  let running: Promise<{ posted: number; seeded: number; archived?: number }> | undefined;
  let archiveLast: { detail?: string; at?: string } = {};
  let lastPollAt = 0;
  // Polls and hook deliveries take turns, so one note is never read and posted by both at once.
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = lock.then(fn, fn);
    lock = p.catch(() => undefined);
    return p;
  };

  const meta = (k: string) => (o.db.prepare("SELECT value FROM desk_voice_meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const setMeta = (k: string, v: string) =>
    o.db.prepare("INSERT INTO desk_voice_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
  const row = (ref: string) => o.db.prepare("SELECT state, tries FROM desk_voice_notes WHERE evidence_ref = ?").get(ref) as { state: string; tries: number } | undefined;
  const put = (ref: string, capturedAt: string | undefined, url: string | undefined, state: string, reason?: string) =>
    o.db
      .prepare(
        `INSERT INTO desk_voice_notes (evidence_ref, captured_at, url, state, reason, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (evidence_ref) DO UPDATE SET state = excluded.state, reason = excluded.reason, url = COALESCE(excluded.url, url)`,
      )
      .run(ref, capturedAt ?? null, url ?? null, state, reason ?? null, now().toISOString());
  const failed = (ref: string, capturedAt: string | undefined, url: string | undefined, why: string) => {
    const tries = (row(ref)?.tries ?? 0) + 1;
    put(ref, capturedAt, url, tries >= MAX_TRIES ? "failed" : "pending", why);
    o.db.prepare("UPDATE desk_voice_notes SET tries = ? WHERE evidence_ref = ?").run(tries, ref);
  };

  // what the relay costs the memory service, per UTC day (the before/after measure of the push).
  const count = (k: "search" | "get" | "hooks") => {
    const day = now().toISOString().slice(0, 10);
    const c = { search: 0, get: 0, hooks: 0, ...(JSON.parse(meta(`calls:${day}`) ?? "{}") as object) } as Record<typeof k, number>;
    c[k]++;
    setMeta(`calls:${day}`, JSON.stringify(c));
  };
  const list: VoiceNoteList = (after) => {
    count("search");
    // r4: a search while a connection carries the notes (a manual poll or backfill) is counted against it, never hidden.
    const conn = o.connection?.();
    if (conn) setMeta(`poll_since:${conn.id}`, String(Number(meta(`poll_since:${conn.id}`) ?? 0) + 1));
    return o.list(after);
  };
  const read: MemoryLookup = (ref) => (count("get"), o.read(ref));

  const floor = () => {
    let since = meta("since");
    if (!since) {
      since = new Date(now().getTime() - BACKFILL_MS).toISOString();
      setMeta("since", since);
    }
    return since;
  };
  /** Push mode: a signed hook has arrived and the net has not since found a note no hook announced. */
  const pushLive = () => {
    const ok = meta("hook_ok_at");
    const missed = meta("hook_missed_at");
    return !!ok && (!missed || missed < ok);
  };

  /** One note: seeded if older than the floor, else read (unless `entry` is already read) and posted once. */
  async function handle(n: MemoryListed, since: string, via: "poll" | "hook", entry?: MemoryEntry): Promise<"posted" | "seeded" | "skip" | "failed"> {
    if (n.source && n.source !== "whatsapp") return "skip"; // only his own captures, never an agent's write
    if (n.contentType && n.contentType !== "voice_note") return "skip";
    const r = row(n.evidenceRef);
    if (r && r.state !== "pending") return "skip";
    const url = n.githubUrl || n.url;
    if (!r && n.capturedAt && n.capturedAt < since) {
      put(n.evidenceRef, n.capturedAt, url, "seeded", "recorded before the relay was switched on");
      return "seeded";
    }
    let e = entry;
    if (!e) {
      const got = await read(n.evidenceRef);
      if ("error" in got) {
        failed(n.evidenceRef, n.capturedAt, url, got.error);
        return "failed";
      }
      e = got.entry;
    }
    const texts = voiceNoteMessages(n.evidenceRef, { ...e, capturedAt: e.capturedAt ?? n.capturedAt, githubUrl: e.githubUrl ?? n.githubUrl, url: e.url ?? n.url });
    const base = `voice-note-${n.evidenceRef.replace(/[^\w.-]+/g, "-").slice(0, 100)}`;
    for (let k = 1; k <= texts.length; k++) {
      // a retry posts every part again under the same ids; the desk thread takes each id once.
      const res = await o.post(texts[k - 1]!, voiceNotePage(), partRequestId(base, k));
      if (res !== true) {
        failed(n.evidenceRef, n.capturedAt, url, texts.length > 1 ? `part ${k} of ${texts.length}: ${res}` : res);
        return "failed";
      }
    }
    put(n.evidenceRef, n.capturedAt, url, "posted");
    o.db.prepare("UPDATE desk_voice_notes SET posted_at = ?, via = ? WHERE evidence_ref = ?").run(now().toISOString(), via, n.evidenceRef);
    // The net found a note no hook announced while the push was live: back to the minute poll until the next hook.
    if (via === "poll" && pushLive() && !o.db.prepare("SELECT 1 FROM desk_voice_hooks WHERE evidence_ref = ?").get(n.evidenceRef)) {
      setMeta("hook_missed_at", now().toISOString());
      setMeta("hook_missed_ref", n.evidenceRef);
    }
    return "posted";
  }

  async function pass(): Promise<{ posted: number; seeded: number }> {
    const since = floor();
    // Look back 6 h before the newest note posted, so a note the memory service indexes late is still found (its row keeps it once).
    const newest = (o.db.prepare("SELECT MAX(captured_at) AS at FROM desk_voice_notes WHERE state = 'posted'").get() as { at: string | null }).at;
    const from = new Date(Math.max(Date.parse(since), newest ? Date.parse(newest) - LOOKBACK_MS : 0)).toISOString();
    const got = await list(from);
    const checkedAt = now().toISOString();
    if ("error" in got) {
      last = { state: "error", detail: got.error, checkedAt };
      return { posted: 0, seeded: 0 };
    }
    let posted = 0;
    let seeded = 0;
    // Oldest first, so the desk reads them in the order the owner spoke.
    const todo = [...got.entries].sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
    for (const n of todo) {
      const r = await handle(n, since, "poll");
      if (r === "posted") posted++;
      else if (r === "seeded") seeded++;
    }
    last = { state: "polling", detail: `${ownerName()}'s WhatsApp voice notes in ${memoryName()} go to the Team desk (checked ${got.entries.length} since ${from})`, checkedAt };
    return { posted, seeded };
  }

  /** read the hooked note from the memory service and post it; a note the memory service cannot answer yet is tried again later. */
  async function deliver(ref: string, attempt: number): Promise<string> {
    const r = row(ref);
    const got = r && r.state !== "pending" ? undefined : await read(ref);
    let result: string;
    if (!got) result = `already ${r!.state}`;
    else if ("error" in got) {
      if (attempt < retryMs.length) {
        later(() => void serial(() => deliver(ref, attempt + 1)).catch((e) => console.error("voice hook:", e)), retryMs[attempt]);
        result = `not readable yet (${got.error.slice(0, 120)}); try ${attempt + 2} in ${Math.round(retryMs[attempt] / 1000)} s`;
      } else result = `not readable (${got.error.slice(0, 120)}); left to the safety-net poll`;
    } else {
      const e = got.entry;
      const n: MemoryListed = { evidenceRef: ref, ...(e.capturedAt ? { capturedAt: e.capturedAt } : {}), source: e.source ?? "", contentType: e.contentType ?? "", ...(e.url ? { url: e.url } : {}), ...(e.githubUrl ? { githubUrl: e.githubUrl } : {}) };
      // The entry decides, never the hook: only the owner's WhatsApp voice notes go to the desk.
      if (n.source !== "whatsapp" || n.contentType !== "voice_note") result = `ignored: ${n.source || "no source"}/${n.contentType || "no type"} is not a WhatsApp voice note`;
      else {
        // A hook about a note just captured is the memory service pushing: from now on the poll is only the safety net.
        if (n.capturedAt && Math.abs(now().getTime() - Date.parse(n.capturedAt)) <= HOOK_FRESH_MS) setMeta("hook_ok_at", now().toISOString());
        result = await handle(n, floor(), "hook", e);
      }
    }
    o.db.prepare("UPDATE desk_voice_hooks SET result = ? WHERE evidence_ref = ?").run(result, ref);
    return result;
  }

  /** Seed rows for notes recorded before the switch-on that have none (a backfill from `from`): copied, never posted. */
  async function seedOld(from: string): Promise<number | string> {
    const since = meta("since");
    if (!since) return 0;
    const got = await list(from);
    if ("error" in got) return got.error;
    let n = 0;
    for (const e of got.entries) {
      if ((e.source && e.source !== "whatsapp") || row(e.evidenceRef) || !e.capturedAt || e.capturedAt >= since) continue;
      put(e.evidenceRef, e.capturedAt, e.githubUrl || e.url, "seeded", "recorded before the relay was switched on");
      n++;
    }
    return n;
  }

  /** copy posted (and floor-on seeded) notes not yet in the team repo; returns how many reached it. */
  async function archivePass(): Promise<number> {
    if (!o.archive) return 0;
    let floor = meta("archive_since");
    if (!floor) {
      floor = `${now().toISOString().slice(0, 10)}T00:00:00.000Z`;
      setMeta("archive_since", floor);
    }
    const todo = o.db
      .prepare(
        "SELECT evidence_ref, captured_at, url FROM desk_voice_notes WHERE archived_at IS NULL AND state IN ('posted', 'seeded') AND captured_at >= ? ORDER BY captured_at LIMIT ?",
      )
      .all(floor, ARCHIVE_BATCH) as { evidence_ref: string; captured_at: string; url: string | null }[];
    if (!todo.length) return 0;
    const notes: { ref: string; capturedAt?: string; url?: string; text: string }[] = [];
    const errors: string[] = [];
    for (const t of todo) {
      const e = await read(t.evidence_ref);
      if ("error" in e) {
        errors.push(`${t.evidence_ref}: ${e.error}`);
        continue;
      }
      notes.push({ ref: t.evidence_ref, capturedAt: e.entry.capturedAt ?? t.captured_at, url: e.entry.githubUrl || e.entry.url || t.url || undefined, text: transcriptOf(e.entry.content ?? "") });
    }
    const at = now().toISOString();
    let archived: string[] = [];
    let status: string | undefined;
    if (notes.length) {
      try {
        ({ archived, status } = await o.archive(notes));
      } catch (e) {
        status = `failed: ${(e as Error).message}`;
      }
    }
    for (const ref of archived) o.db.prepare("UPDATE desk_voice_notes SET archived_at = ? WHERE evidence_ref = ? AND archived_at IS NULL").run(at, ref);
    archiveLast = { at, detail: [`${archived.length}/${todo.length} copied to the team repo`, status, ...errors.slice(0, 3)].filter(Boolean).join("; ") };
    return archived.length;
  }

  function tick(): Promise<{ posted: number; seeded: number; archived?: number }> {
    lastPollAt = now().getTime();
    running ??= serial(pass)
      .then(async (r) => (o.archive ? { ...r, archived: await archivePass().catch(() => 0) } : r))
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    /** One poll (never two at once), then the team-repo copy. */
    tick,
    /** the timer's call (every minute): polls each time in poll mode, once per safety-net interval in push mode. */
    timerTick(): Promise<{ posted: number; seeded: number; archived?: number } | undefined> {
      if (pushLive() && now().getTime() - lastPollAt < safetyNetMs) return Promise.resolve(undefined);
      return tick();
    },
    /**
     * a verified hook for `ref`. A ref seen before answers `duplicate` and reads nothing (the memory service may deliver twice);
     * a new one is recorded and read and posted in the background; push mode starts once a hooked note is fresh (HOOK_FRESH_MS).
     */
    hook(ref: string): { accepted: boolean; duplicate: boolean } {
      const at = now().toISOString();
      count("hooks");
      const fresh = o.db.prepare("INSERT INTO desk_voice_hooks (evidence_ref, received_at) VALUES (?, ?) ON CONFLICT (evidence_ref) DO NOTHING").run(ref, at).changes > 0;
      if (!fresh) return { accepted: true, duplicate: true };
      o.db.prepare("UPDATE desk_voice_notes SET hook_at = COALESCE(hook_at, ?) WHERE evidence_ref = ?").run(at, ref);
      void serial(() => deliver(ref, 0))
        .then(() => o.db.prepare("UPDATE desk_voice_notes SET hook_at = COALESCE(hook_at, ?) WHERE evidence_ref = ?").run(at, ref))
        .then(() => (o.archive ? archivePass().catch(() => 0) : 0))
        .catch((e) => console.error("voice hook:", e));
      return { accepted: true, duplicate: false };
    },
    /**
     * a note a world's the memory service connection already put on the Team desk. It gets a posted row (via `connection`), so the
     * minute poll, should it run again (the connection removed), never posts it a second time, and the team-repo copy still
     * picks it up. A note this relay already has a row for keeps it.
     */
    postedElsewhere(ref: string, capturedAt: string | undefined, via = "connection"): boolean {
      if (row(ref)) return false;
      put(ref, capturedAt, undefined, "posted");
      o.db.prepare("UPDATE desk_voice_notes SET posted_at = ?, via = ? WHERE evidence_ref = ?").run(now().toISOString(), via, ref);
      if (o.archive) void serial(() => archivePass()).catch((e) => console.error("voice archive:", e));
      return true;
    },
    /** minute-poll searches on our own token today (UTC), for the Webhooks card. */
    pollSearchesToday: (): number => Number((JSON.parse(meta(`calls:${now().toISOString().slice(0, 10)}`) ?? "{}") as { search?: number }).search ?? 0),
    /** wait until queued hook deliveries are done. */
    settled: () => lock.then(() => undefined),
    /**
     * backfill: notes recorded since `from` that predate the switch-on get a seeded row, the copy floor moves back to
     * `from` (never forward), and the copy runs now. Notes after the switch-on are copied once the poll has posted them.
     */
    async backfill(from: string): Promise<{ seeded: number | string; archived: number }> {
      if (!Number.isFinite(Date.parse(from))) throw new Error("from must be an ISO time");
      const iso = new Date(from).toISOString();
      const cur = meta("archive_since");
      if (!cur || iso < cur) setMeta("archive_since", iso);
      const seeded = await seedOld(iso);
      let archived = 0;
      for (let i = 0; i < 10; i++) {
        const n = await archivePass();
        archived += n;
        if (n < ARCHIVE_BATCH) break;
      }
      return { seeded, archived };
    },
    status(limit = 10): VoiceRelayStatus {
      const recent = (
        o.db
          .prepare("SELECT evidence_ref, captured_at, url, state, reason, posted_at, archived_at, via, hook_at FROM desk_voice_notes WHERE state != 'seeded' OR archived_at IS NOT NULL ORDER BY captured_at DESC LIMIT ?")
          .all(limit) as { evidence_ref: string; captured_at: string | null; url: string | null; state: string; reason: string | null; posted_at: string | null; archived_at: string | null; via: string | null; hook_at: string | null }[]
      ).map((r) => ({
        ref: r.evidence_ref,
        ...(r.captured_at ? { capturedAt: r.captured_at } : {}),
        ...(r.url ? { url: r.url } : {}),
        state: r.state,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.posted_at ? { postedAt: r.posted_at } : {}),
        ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
        ...(r.via ? { via: r.via } : {}),
        ...(r.hook_at ? { hookAt: r.hook_at } : {}),
      }));
      const push = pushLive();
      const lastHook = o.db.prepare("SELECT evidence_ref, received_at, result FROM desk_voice_hooks ORDER BY received_at DESC, rowid DESC LIMIT 1").get() as
        | { evidence_ref: string; received_at: string; result: string }
        | undefined;
      const okAt = meta("hook_ok_at");
      const missedAt = meta("hook_missed_at");
      const hook = {
        ...(okAt ? { okAt } : {}),
        ...(missedAt ? { missed: `${missedAt}: the safety net found ${meta("hook_missed_ref") ?? "a note"} with no hook` } : {}),
        ...(lastHook ? { last: { ref: lastHook.evidence_ref, at: lastHook.received_at, result: lastHook.result } } : {}),
      };
      const calls: VoiceRelayStatus["calls"] = {};
      for (const r of o.db.prepare("SELECT key, value FROM desk_voice_meta WHERE key LIKE 'calls:%' ORDER BY key DESC LIMIT 7").all() as { key: string; value: string }[])
        calls[r.key.slice(6)] = { search: 0, get: 0, hooks: 0, ...(JSON.parse(r.value) as object) };
      const since = meta("since");
      const archiveSince = meta("archive_since");
      const archive = o.archive ? { archive: { ...(archiveSince ? { since: archiveSince } : {}), ...archiveLast } } : {};
      const conn = o.connection?.();
      if (!conn && !o.worlds) return { ...last, ...(since ? { since } : {}), mode: push ? "push" : "poll", pollEveryMs: push ? safetyNetMs : 60_000, hook, calls, recent, ...archive };
      // r4: the connection's deliveries are hooks too; its safety searches and reads are counted beside the poll's.
      for (const [day, c] of Object.entries(conn?.calls ?? {})) {
        const r = (calls[day] ??= { search: 0, get: 0, hooks: 0 });
        r.hooks += c.hooks;
        r.safety = c.safety;
        r.reads = c.reads;
      }
      const day = now().toISOString().slice(0, 10);
      const lp = o.db
        .prepare("SELECT evidence_ref, captured_at, posted_at, via, hook_at FROM desk_voice_notes WHERE state = 'posted' AND posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 1")
        .get() as { evidence_ref: string; captured_at: string | null; posted_at: string; via: string | null; hook_at: string | null } | undefined;
      const lastNote = lp
        ? {
            ref: lp.evidence_ref,
            ...(lp.captured_at ? { capturedAt: lp.captured_at } : {}),
            postedAt: lp.posted_at,
            ...(lp.via ? { via: lp.via } : {}),
            ...(lp.hook_at ? { hookAt: lp.hook_at } : {}),
            ...(conn?.lastNote && !conn.lastNote.test && conn.lastNote.ref === lp.evidence_ref && conn.lastNote.ms !== undefined ? { ms: conn.lastNote.ms } : {}),
          }
        : undefined;
      const worldOf = (w: { world: string; team: string; connection?: ConnSummary }, own: boolean): VoiceWorldStatus => {
        const c = w.connection;
        const t = c?.calls[day];
        const polls = own ? (calls[day]?.search ?? 0) : 0;
        const today = { day, hookDeliveries: (t?.hooks ?? 0) + (own && !c ? (calls[day]?.hooks ?? 0) : 0), safetySearches: t?.safety ?? 0, pollSearches: polls };
        if (c) {
          const ln = own ? lastNote : c.lastNote && !c.lastNote.test ? { ref: c.lastNote.ref, postedAt: c.lastNote.at, ...(c.lastNote.via ? { via: c.lastNote.via } : {}) } : undefined;
          return { world: w.world, team: w.team, mode: "push", via: c.id, ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}), safetyEveryMs: c.safety.everyMs, safety: { ...(c.safety.at ? { at: c.safety.at } : {}), ...(c.safety.result ? { result: c.safety.result } : {}) }, today, ...(ln ? { lastNote: ln } : {}) };
        }
        if (own) return { world: w.world, team: w.team, mode: "poll", pollEveryMs: push ? safetyNetMs : 60_000, today, ...(lastNote ? { lastNote } : {}) };
        return { world: w.world, team: w.team, mode: "off", today };
      };
      const worlds = (o.worlds?.() ?? []).map((w, i) => worldOf(w, i === 0));
      if (!conn) return { ...last, ...(since ? { since } : {}), mode: push ? "push" : "poll", pollEveryMs: push ? safetyNetMs : 60_000, hook, calls, ...(worlds[0] ? { today: worlds[0].today } : {}), ...(lastNote ? { lastNote } : {}), worlds, recent, ...archive };
      const sinceConn = Number(meta(`poll_since:${conn.id}`) ?? 0);
      const safetyLine = conn.safety.at ? `; last safety check ${conn.safety.at}${conn.safety.result ? `: ${conn.safety.result}` : ""}` : "";
      return {
        state: "push",
        detail: `${memoryName()} pushes each new voice note to connection ${conn.id}${conn.connectedAt ? ` (connected ${conn.connectedAt})` : ""}; the 60 s poll on our own ${memoryName()} token is off; a safety check asks ${memoryName()} every ${Math.round(conn.safety.everyMs / 60_000)} min${safetyLine}`,
        ...(conn.safety.at ? { checkedAt: conn.safety.at } : {}),
        ...(since ? { since } : {}),
        mode: "push",
        via: conn.id,
        pollEveryMs: null,
        safetyEveryMs: conn.safety.everyMs,
        pollSearchesSinceConnected: sinceConn,
        ...(worlds[0] ? { today: worlds[0].today } : {}),
        ...(lastNote ? { lastNote } : {}),
        worlds,
        hook,
        calls,
        recent,
        ...archive,
      };
    },
  };
}
export type VoiceNoteRelay = ReturnType<typeof createVoiceNoteRelay>;

/** the hook's shared secret (the memory service signs with the same value; regenerated on both sides, never the only copy of anything). */
export const defaultMemoryHookSecretFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.CONSOLE_MEMORY_HOOK_SECRET_FILE || path.join(os.homedir(), `.config/${homeRepo()}/memory-voice-hook.secret`);

/** who may call the hook: this host (loopback), the tailnet, or a container on this host's docker bridges (memory-mt). */
export function hookPeer(addr: string | undefined): boolean {
  if (trustedPeer(addr)) return true;
  const m = /^(?:::ffff:)?172\.(\d+)\.\d+\.\d+$/.exec((addr ?? "").trim().toLowerCase());
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** the hook's evidenceRef: the memory service log anchor (`Log/2026-11-02.md#^e-c927b7`), nothing else. */
const HOOK_REF = /^[\w./-]{1,160}#\^?[\w-]{1,64}$/;

/**
 * POST /hooks/memory/voice-note: the memory service's push. Open in routeScope (no login: memory-mt has none) and guarded here:
 * a direct caller on this host, the tailnet or a docker bridge (never through Traefik: a forwarded request is refused),
 * then `X-Memory-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` with the shared secret, within HOOK_TOLERANCE_SEC.
 * Body `{"event":"voice_note.stored","evidenceRef":"…"}`; only the ref is used, the note itself is read from the memory service.
 * Answers 202 at once (the memory service never waits on the desk); a ref seen before answers 202 duplicate and reads nothing.
 */
export function mountVoiceHook(api: Hono, relay: VoiceNoteRelay, o: { secret: () => string | undefined; nowSec?: () => number }) {
  const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;
  api.post("/hooks/memory/voice-note", async (c) => {
    if (!hookPeer(peerOf(c)) || proxied((n) => c.req.header(n))) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    const secret = o.secret();
    if (!secret) return c.json({ error: { code: "not_configured", message: "no hook secret on this console" } }, 503);
    const body = await c.req.text();
    if (body.length > 4096) return c.json({ error: { code: "too_large", message: "body over 4 KB" } }, 413);
    const nowSec = o.nowSec?.() ?? Math.floor(Date.now() / 1000);
    if (!verifyStripeSignature(body, c.req.header("x-memory-signature"), secret, nowSec, HOOK_TOLERANCE_SEC))
      return c.json({ error: { code: "bad_signature", message: "signature missing, wrong or outside the replay window" } }, 401);
    let ref: unknown;
    try {
      ref = (JSON.parse(body) as { evidenceRef?: unknown }).evidenceRef;
    } catch {
      return c.json({ error: { code: "bad_request", message: "body is not JSON" } }, 400);
    }
    if (typeof ref !== "string" || !HOOK_REF.test(ref)) return c.json({ error: { code: "bad_request", message: `evidenceRef: a ${memoryName()} log anchor` } }, 400);
    return c.json(relay.hook(ref), 202);
  });
}

/** GET /desk/voice-notes (what was relayed), POST /desk/voice-notes/poll (poll the memory service now), POST /desk/voice-notes/backfill {from} (team-repo copy). */
export function mountVoiceNotes(api: Hono, relay: VoiceNoteRelay) {
  api.get("/desk/voice-notes", (c) => c.json(relay.status()));
  api.post("/desk/voice-notes/poll", async (c) => c.json({ ...(await relay.tick()), status: relay.status() }));
  api.post("/desk/voice-notes/backfill", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { from?: string };
    if (!b.from || !Number.isFinite(Date.parse(b.from))) return c.json({ error: { code: "bad_request", message: "from: an ISO time" } }, 400);
    return c.json({ ...(await relay.backfill(b.from)), status: relay.status() });
  });
}
