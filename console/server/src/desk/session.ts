import path from "node:path";
import { requestIdOf, type RequestRow, type RequestRows } from "./requests.js";
import { classifyRefusal, refusalText } from "../cycle/capRefusal.js";
import { DEFAULT_TENANT, type DB } from "../db.js";
import type { Store, Persona } from "../store.js";
import { modelId } from "../cycle/service.js";
import { randomUUID } from "node:crypto";
import { errorText, isT3Unavailable, matchProject, t3DownReason, type T3Client, type T3ThreadMessage, type T3ThreadState } from "../t3/client.js";
import type { Dispatcher } from "../t3/dispatcher.js";
import { splitSince } from "./since.js";
import { forTenant } from "../store.js";
import type { StartGate } from "../cycle/startGate.js";
import { type HostId, mainHost, ownerName, workerHost, hostReposRoot } from "../identity.js";

/**
 * The desk's replies once opened with a `Plot: …` line, a name the owner never asked for ("I never asked you for any
 * feature that has the word plot in it"): the chat drops that
 * first line from the replies that still carry it, so he no longer reads it anywhere.
 */
export function dropLabelLine(text: string): string {
  return text.replace(/^Plot:[^\n]*\n*/, "");
}

/**
 * the keyed chat-session engine shared by the Team desk (key `team`) and every milestone's repo desk (key
 * `milestone:<id>`). Each key has ONE long-lived T3 thread run by a persona: the console only records which thread that is
 * (`desk_session`, one live row per key); the transcript is the T3 thread, read back on demand through a settled cursor. The
 * thread is launched on first need, reused while T3 has it, relaunched with a short summary when T3 lost it, and told a new
 * endpoint list by one versioned update message (never a relaunch).
 */

/** A message the owner sends from a page starts with `[page: <hint>]` on its own line; the chat shows the hint as a chip. */
export const PAGE_PREFIX = /^\[page: ([^\]\n]{1,200})\]\n/;
export const PAGE_HINT_MAX = 200;
/** Newest messages returned per read (the thread keeps the rest). */
export const TAIL_MESSAGES = 120;
/**
 * a chat open waits at most this long for T3 (2-3 MCP calls of 0.1-4 s each on the main server);
 * past it the last good view answers (memory, else the desk_view_cache row) and the live read lands for the next poll.
 */
export const VIEW_BUDGET_MS = 250;
/** a cold read of a long thread starts this many items (positions) from its end, not at position 0. */
export const TAIL_WINDOW = 300;
/** newest messages kept in desk_view_cache (the first screen shows 30). */
export const CACHED_MESSAGES = 40;
/** A message that never reached `completed` this long after its last update stops holding the read cursor back. */
const UNSETTLED_MAX_MS = 10 * 60_000;
/** Pages of 100 items read per call before giving up on a very long thread (the next call continues from the cursor). */
const MAX_PAGES = 40;
/**
 * the owner's send answers after at most this long (`pending: true`), the T3 work (thread check, send, busy
 * retries) runs on after the reply; a failure lands on `sendError` with his message's clientRequestId. Was 20 s, which
 * held his phone's Send on three T3 calls over the worker server's tunnel (0.2 to 2.2 s each, measured 2026-11-12).
 */
export const SEND_WAIT_MS = 1_200;
/**
 * right after a send the next view waits for T3 at most this long (so his message shows from the thread), then the last good
 * view answers (`stale: true`) and his own bubble stays on the page until a later read shows it. Was unbounded: on
 * 2026-11-13 a read after his send held the Chat for 41 s while the worker server's tunnel dropped calls.
 */
export const SEND_VIEW_WAIT_MS = 2_000;
/**
 * an older page (scrolling up) waits for T3 at most this long; past it the page answers `loading: true` with nothing, the read
 * runs on into the cache and the chat retries by itself. Was unbounded: on 2026-11-14 Team desk reads took 10.5 to 56.4 s.
 */
export const EARLIER_BUDGET_MS = 2_000;
export const WORKING = new Set(["preparing", "queued", "starting", "running"]);
/**
 * the start of the turn in progress: the active run (by id, else the newest unfinished one), startedAt else
 * requestedAt. Undefined when the thread is not working or T3 sent no runs.
 */
export function turnStart(st: Pick<T3ThreadState, "status" | "activeRunId" | "runs">): string | undefined {
  if (!WORKING.has(st.status) || !st.runs?.length) return undefined;
  const open = st.runs.filter((r) => !r.completedAt);
  const run =
    (st.activeRunId ? st.runs.find((r) => r.runId === st.activeRunId) : undefined) ??
    open.sort((a, b) => Date.parse(b.requestedAt ?? b.startedAt ?? "") - Date.parse(a.requestedAt ?? a.startedAt ?? ""))[0];
  return run?.startedAt ?? run?.requestedAt ?? undefined;
}
const GONE = /not[_ ]found|does not exist|no such thread|unknown thread/i;
/** The Team desk's key (its rows predate keys: migrated to it). */
export const TEAM_KEY = "team";

export class DeskError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** the T3 of the host a thread runs on cannot be reached now (the worker server's tunnel down): the chat says so and retries. */
export class HostUnreachableError extends DeskError {
  constructor(
    readonly host: DeskHost,
    message: string,
  ) {
    super(503, "desk_unavailable", message);
  }
}

export function migrateDeskSessions(db: DB) {
  // Side table (like the cycle's): one row per chat thread; the live one of a key has ended_at NULL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_session (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      project_id TEXT,
      seat TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    );
  `);
  const cols = (db.prepare("PRAGMA table_info(desk_session)").all() as { name: string }[]).map((c) => c.name);
  // the seed version the thread has been told (NULL = the S1/S2 seed, version 1).
  if (!cols.includes("seed_version")) db.exec("ALTER TABLE desk_session ADD COLUMN seed_version INTEGER");
  // which chat the thread belongs to (`team`, `milestone:<id>`); rows from before keys are the Team desk's.
  if (!cols.includes("desk_key")) {
    db.exec("ALTER TABLE desk_session ADD COLUMN desk_key TEXT");
    db.prepare("UPDATE desk_session SET desk_key = ? WHERE desk_key IS NULL").run(TEAM_KEY);
  }
  // the host whose T3 runs the thread (the persona's host at launch); every read and send of it goes there.
  if (!cols.includes("host")) db.exec(`ALTER TABLE desk_session ADD COLUMN host TEXT NOT NULL DEFAULT '${mainHost()}'`);
  db.exec("CREATE INDEX IF NOT EXISTS desk_session_key ON desk_session (desk_key, ended_at)");
  // the owner's chat sends made while T3 was down, delivered once it is back with their original clientRequestId.
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_key TEXT NOT NULL,
      client_request_id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      page TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      thread_id TEXT,
      failed_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS desk_outbox_key ON desk_outbox (desk_key, sent_at, failed_at);
  `);
  // the last view of each chat, read back from its T3 thread (a cache: safe to drop, rebuilt on the next read), so
  // the first open after a console restart paints at once instead of re-reading the whole thread from T3.
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_view_cache (
      desk_key TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      view TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/** a chat send stored while T3 was down (the chat shows it as a "queued" bubble until T3 takes it). */
export interface QueuedMessage {
  id: string;
  text: string;
  page?: string;
  at: string;
}

export interface DeskSession {
  seq: number;
  key: string;
  threadId: string;
  projectId?: string;
  seat?: string;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
  /** Version of the endpoint list the thread has received (seed, or a later update message). */
  seedVersion: number;
  /** the host whose T3 runs the thread. */
  host: DeskHost;
}

export interface DeskMessage {
  id: string;
  role: "user" | "assistant";
  /** `seed` = the launch message of a session: the chat shows a divider (text is empty). */
  kind: "message" | "seed";
  text: string;
  /** The page the owner was looking at when he sent it. */
  page?: string;
  /** the console's "since your last message" block sent before his words (the chat shows it folded). */
  since?: string;
  status: string;
  at?: string;
  /** Seed only: which session this starts (1 = first; more = the earlier thread was gone). */
  session?: number;
  /**
   * seed only: why this session followed an earlier one, as the divider says it ("New session: the desk moved to the worker server;
   * the earlier chat is above"). Unset on a chat's first session.
   */
  note?: string;
  truncated?: boolean;
  /** his message's request id (one request, one ticket row; desk/requests.ts requestIdOf). */
  request?: string;
  /** the ticket rows holding that request id now; [] = on no row yet; unset = not read yet. */
  rows?: RequestRow[];
  /** the item's position in the T3 thread (`?before=<position>` pages older messages). */
  position?: number;
}

export interface DeskView {
  /** false = no T3 (cycle off): the chat is unavailable and says why. */
  available: boolean;
  reason?: string;
  threadId?: string;
  environmentId?: string;
  session?: number;
  /** T3's status of the thread (idle, running, …). */
  status?: string;
  /** The persona is mid-turn: the page polls faster and shows "working…". */
  working: boolean;
  /** when the current turn started (T3's run startedAt, else requestedAt), so the page's timer survives a reload. */
  workingSince?: string;
  /** Messages the owner sent that T3 has not accepted yet (a busy thread retries for minutes). */
  sending: number;
  /** the last send that failed after its request answered; `clientRequestId` names his message. */
  sendError?: { text: string; at: string; clientRequestId?: string };
  messages: DeskMessage[];
  /** Older messages exist beyond the tail returned. */
  hasEarlier: boolean;
  /**
   * T3 is down: `restarting`, or `maintenance` when it was stopped on purpose. The messages are the last good read;
   * the chat shows one quiet line instead of an error.
   */
  t3?: "restarting" | "maintenance";
  /** sends stored while T3 was down, oldest first (delivered once it is back). */
  queued?: QueuedMessage[];
  /** T3 did not answer within the view budget: this is the last good view, a fresh read is under way. */
  stale?: boolean;
  /** the host whose T3 runs the live thread. */
  host?: DeskHost;
  /**
   * that host's T3 cannot be reached now (the worker server tunnel is down, …): the messages are the last good read and the chat
   * says "Can't reach <host>, retrying" instead of going blank or showing a raw error.
   */
  unreachable?: DeskHost;
}

/** what a chat read asks for: the newest `limit` messages, or (with `before`) the page older than that position. */
export interface ViewOpts {
  limit?: number;
  before?: number;
}
/** an older page of a chat (scrolling up). */
export interface EarlierPage {
  messages: DeskMessage[];
  hasEarlier: boolean;
  /** T3 did not answer within EARLIER_BUDGET_MS: the read goes on into the cache, ask again in a moment (never an error). */
  loading?: boolean;
}
/** `?limit=&before=` of a chat read (absent or not a number = unset). */
export function viewOpts(q: (name: string) => string | undefined): ViewOpts {
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
  const limit = num(q("limit"));
  // an earlier session's messages carry negative positions (historyPosition), so `before` may be negative
  const b = q("before");
  const before = b !== undefined && /^-?\d+$/.test(b) ? Number(b) : undefined;
  return { ...(limit ? { limit } : {}), ...(before !== undefined ? { before } : {}) };
}
/** a chat read: the older page when `before` is set, else the view. */
export function readChat(chat: Pick<ChatSession, "view" | "earlier">, o: ViewOpts): Promise<DeskView | EarlierPage> {
  return o.before !== undefined ? chat.earlier(o.before, o.limit) : chat.view(o);
}

export interface SessionDeps {
  db: DB;
  /** which ticket rows hold each request id (one request, one row); unset = his messages show no ticket line. */
  requestRows?: RequestRows;
  store: Store;
  /** a desk persona made on first need also gets its file in the world's team repo (best effort, logged). */
  personaCreated?: (p: Persona, world: string) => void;
  /** the main server's T3 (unset = the cycle is off: no chat). */
  t3?: T3Client;
  dispatcher?: Dispatcher;
  /**
   * the T3 of a host, like cycle/service.ts clientFor (the worker server over the console's tunnel); undefined = not
   * reachable now. Unset = the main server only (`t3`), and every chat runs there whatever its persona's host.
   */
  clientFor?: (host: DeskHost) => T3Client | undefined;
  /** the dispatcher a launch on that host picks through (the worker server: its own client, the worker server memory); unset = `dispatcher`. */
  dispatcherFor?: (host: DeskHost) => Dispatcher | undefined;
  /** T3 environment of a host (t3code:// links); unset = `environmentId` for every host. */
  environmentIdFor?: (host: DeskHost) => string | undefined;
  /**
   * why a seat cannot take a turn now (`seat1 limited until …`, `seat2 logged out`; seatBlockerFor over
   * seats.json), else undefined. Unset = never blocked (as before).
   */
  seatBlocked?: (seat: string | undefined) => string | undefined;
  /**
   * the seat the broker keeps for the owner when his pick would get it now (ownerSeatFree over seats.json), else
   * undefined. A chat whose profile has `preferOwnerSeat` (the Team desk) moves there before his send. Unset = no move.
   */
  ownerSeat?: () => string | undefined;
  /** T3 environment of the local T3 (t3code:// links), when known. */
  environmentId?: () => string | undefined;
  now?: () => number;
  sendWaitMs?: number;
  /** how long a chat view waits for T3 before the last good view answers (tests). */
  viewBudgetMs?: number;
  /** how long the first view after a send waits for T3 before the last good view answers (tests). */
  sendViewWaitMs?: number;
  /** how long an older page waits for T3 before it answers `loading: true` (tests). */
  earlierBudgetMs?: number;
  /** why T3 is down (default: the maintenance markers under the console user's home). */
  t3DownReason?: () => "restarting" | "maintenance";
  /**
   * the main server's session start gate (desks run on the main server's T3). The console's own sends (endpoint update, queued sends,
   * notes) wait for it; the owner's own message and a launch for it never wait but count. Unset = no gate.
   */
  startGate?: StartGate;
}

/** where a desk thread runs. */
export type DeskHost = HostId;
/** end_reason of a session the console moved because its persona moved to another host. */
export const HOST_MOVE = "host moved to ";
/**
 * an earlier session's messages are shown above the live thread's (the chat keeps its conversation across a host or
 * seat move). Positions are per thread, so the j-th earlier session (1 = the one right before the live one) shows position
 * `p` as `p - j * HISTORY_STRIDE`: below every live position, ordered across sessions, and a valid `before` for paging.
 */
export const HISTORY_STRIDE = 1_000_000_000;
export const historyPosition = (j: number, position: number) => position - j * HISTORY_STRIDE;
/** the session (j, 0 = the live one) and the thread position of a shown position. */
export function fromHistoryPosition(shown: number): { j: number; position: number } {
  if (shown >= 0) return { j: 0, position: shown };
  const j = Math.ceil(-shown / HISTORY_STRIDE);
  return { j, position: shown + j * HISTORY_STRIDE };
}
/** an empty live thread shows at least this many earlier messages on open (the first screen shows 30). */
export const HISTORY_FILL = 30;
/** the divider of a session that followed another: why it started, in the owner's words. */
export function sessionNote(prev: Pick<DeskSession, "endReason" | "host"> | undefined): string | undefined {
  if (!prev) return undefined;
  const r = prev.endReason ?? "";
  if (r.startsWith(HOST_MOVE)) return `New session: the desk moved from ${prev.host} to ${r.slice(HOST_MOVE.length)}. The earlier chat is above.`;
  if (r.startsWith(SEAT_MOVE) && r.includes("the seat kept for")) return `New session: the Team desk moved to the seat kept for you. The earlier chat is above.`;
  if (r.startsWith(SEAT_MOVE)) return `New session: the desk moved to a seat with headroom (${r.slice(SEAT_MOVE.length)}). The earlier chat is above.`;
  return `New session: the earlier thread was gone${r ? ` (${r})` : ""}. What could still be read is above.`;
}

/** What makes one chat different from another: its key, persona, project, seed and markers. */
export interface ChatProfile {
  key: string;
  /** Repo whose T3 project hosts the thread. */
  repo: string;
  /** T3 thread title. */
  title: string;
  personaName: string;
  /** the world whose persona of that name runs this chat (a milestone's world; unset = the store's, i.e. the home world's desk). */
  tenant?: string;
  /** Remit the persona row is created with on first need (afterwards the Personas page owns it). */
  remit: () => string;
  /** First line of the launch message: the chat shows it as a divider, never as text. */
  seedMarker: string;
  /** First line of the console's endpoint-list update to the live thread (plumbing: the chat hides it). */
  updateMarker: string;
  /** Raise when the endpoint list changes: the live thread gets one update message (once per version). */
  seedVersion: number;
  /** The launch message; `summary` = what the previous thread said last, when it was lost. */
  seed: (o: { persona: Persona; summary?: string }) => string | Promise<string>;
  /** The update message for seedVersion. */
  update: () => string | Promise<string>;
  /** Other console → persona messages that are plumbing, not conversation (the chat never shows them). */
  plumbing?: string[];
  /** Shown when the console has no T3. */
  unavailable: string;
  /** Client request id of the endpoint-list update (stable per version and session). */
  updateRequestId?: (seq: number) => string;
  /** this chat (the Team desk) runs on the seat kept for the owner whenever that seat can take a turn. */
  preferOwnerSeat?: boolean;
}

const rowTo = (r: any): DeskSession => ({
  seq: r.seq,
  key: r.desk_key ?? TEAM_KEY,
  threadId: r.thread_id,
  projectId: r.project_id ?? undefined,
  seat: r.seat ?? undefined,
  createdAt: r.created_at,
  endedAt: r.ended_at ?? undefined,
  endReason: r.end_reason ?? undefined,
  seedVersion: r.seed_version ?? 1,
  host: r.host === workerHost() ? workerHost() : mainHost(),
});

/** The live session of a key, without creating anything. */
/** end_reason of a session the console moved off a limited / logged-out seat (`seat moved off seat1 limited until …`). */
export const SEAT_MOVE = "seat moved off ";

export function liveSession(db: DB, key: string): DeskSession | undefined {
  const r = db.prepare("SELECT * FROM desk_session WHERE desk_key = ? AND ended_at IS NULL ORDER BY seq DESC LIMIT 1").get(key);
  return r ? rowTo(r) : undefined;
}

export function createChatSession(d: SessionDeps, profile: ChatProfile) {
  const p = profile;
  const now = d.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const sendWaitMs = d.sendWaitMs ?? SEND_WAIT_MS;
  const plumbing = [p.seedMarker, p.updateMarker, ...(p.plumbing ?? [])];
  const isPlumbing = (text: string) => plumbing.some((x) => text.startsWith(x));

  const current = () => liveSession(d.db, p.key);
  const sessions = (): DeskSession[] => (d.db.prepare("SELECT * FROM desk_session WHERE desk_key = ? ORDER BY seq").all(p.key) as any[]).map(rowTo);

  /** The persona row (created from the remit on first need); the owner edits it on the Personas page like any other. */
  const persona = (): Persona => {
    const s = p.tenant ? forTenant(d.db, p.tenant) : d.store; // a social world repo's milestones use its own clone
    const have = s.listPersonas().find((x) => x.name === p.personaName);
    if (have) return have;
    const made = s.createPersona({ name: p.personaName, remit: p.remit(), skills: [], model: "claude-opus-5-5", mayWrite: true });
    d.personaCreated?.(made, p.tenant ?? DEFAULT_TENANT);
    return made;
  };

  /** the host a new thread of this chat launches on: its persona's (the main server when hosts are not wired). */
  const launchHost = (per: Persona = persona()): DeskHost => (d.clientFor && per.host === workerHost() ? workerHost() : mainHost());
  /** the T3 of a host; the thread's own host for every read and send (never the main server for the worker server thread). */
  const clientOn = (host: DeskHost): T3Client => {
    if (!d.t3) throw new DeskError(503, "desk_unavailable", `${p.personaName} needs the console's T3 connection (cycle is off)`);
    if (host === mainHost()) return d.clientFor?.(mainHost()) ?? d.t3;
    const c = d.clientFor?.(host);
    if (!c) throw new HostUnreachableError(host, `${p.personaName} runs on ${host}, whose T3 cannot be reached now`);
    return c;
  };
  /** the host of a thread of this chat (its desk_session row; the main server for a thread the console never recorded). */
  const hostOfThread = (threadId: string): DeskHost =>
    (d.db.prepare("SELECT host FROM desk_session WHERE thread_id = ? ORDER BY seq DESC LIMIT 1").get(threadId) as { host?: string } | undefined)?.host === workerHost() ? workerHost() : mainHost();
  const client = (s: Pick<DeskSession, "host"> | undefined = current()): T3Client => clientOn(s?.host ?? mainHost());
  const envOf = (host: DeskHost) => (d.environmentIdFor ? d.environmentIdFor(host) : d.environmentId?.());
  /**'s gate is the main server's: the worker server thread neither waits for it nor counts. */
  const gateFor = (host: DeskHost) => (host === mainHost() ? d.startGate : undefined);
  /**
   * the console's own automated sends to the main server thread (endpoint update) waits while
   * the main server is at its session cap (the broker's count: turns in flight or live provider processes). the owner's own messages,
   * queued ones included, never wait for it. An unreadable count never blocks.
   */
  const capFull = async (host: DeskHost): Promise<string | undefined> => {
    if (host !== mainHost() || !d.dispatcher?.sessions) return undefined;
    const c = await d.dispatcher.sessions().catch(() => undefined);
    return c?.full ? `session cap on ${mainHost()}: ${c.live} live (cap ${c.cap})` : undefined;
  };

  // ---- readback cache: derived from T3, rebuilt on demand, never the transcript's home ----
  interface Cache {
    threadId: string;
    cursor: number | undefined;
    byItem: Map<string, T3ThreadMessage>;
    /** the lowest position read (0 = from the thread's start); a cold read of a long thread starts at its tail. */
    from: number;
  }
  let cache: Cache | undefined;
  const cacheFor = (threadId: string): Cache => {
    if (!cache || cache.threadId !== threadId) cache = { threadId, cursor: undefined, byItem: new Map(), from: 0 };
    return cache;
  };
  const reader = (threadId: string) => {
    const c = clientOn(hostOfThread(threadId));
    if (!c.readThreadMessages) throw new DeskError(503, "desk_unavailable", "this T3 client cannot read thread messages");
    return c.readThreadMessages.bind(c);
  };

  /**
   * read positions [start, cache.from) into the cache (older messages), then cache.from = start. Pages forward
   * from start until they pass what is already read.
   */
  async function readBack(k: Cache, start: number): Promise<void> {
    const read = reader(k.threadId);
    const stop = k.from;
    if (start >= stop) return;
    let after: number | undefined = start > 0 ? start - 1 : undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await read(k.threadId, { afterPosition: after, limit: 100 });
      for (const m of r.messages) if (m.position < stop && !k.byItem.has(m.itemId)) k.byItem.set(m.itemId, m);
      if (r.nextPosition === null || r.nextPosition >= stop - 1 || !r.hasMore) break;
      after = r.nextPosition;
    }
    k.from = start; // a cache replaced meanwhile is simply dropped (earlier sessions' caches are read the same way)
  }

  /**
   * Pull what T3 has after the settled cursor into the cache (several pages at most). `tailOf` (the chat view): the
   * thread's item count; a cache that has read nothing yet starts TAIL_WINDOW items before the end instead of at 0. Anything
   * else (the unread pill, the owner's last message, the team repo's copy) reads the whole thread first (`full`, the default).
   */
  async function refresh(threadId: string, o: { tailOf?: number } = {}): Promise<Map<string, T3ThreadMessage>> {
    const read = reader(threadId);
    const k = cacheFor(threadId);
    if (k.cursor === undefined && k.byItem.size === 0 && k.from === 0 && o.tailOf !== undefined && o.tailOf > TAIL_WINDOW) k.from = o.tailOf - TAIL_WINDOW;
    if (o.tailOf === undefined && k.from > 0) await readBack(k, 0);
    let after = k.cursor ?? (k.from > 0 ? k.from - 1 : undefined);
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await read(threadId, { afterPosition: after, limit: 100 });
      for (const m of r.messages) k.byItem.set(m.itemId, m);
      if (r.nextPosition !== null) after = r.nextPosition;
      // The read cursor settles up to the first message that may still change.
      const open = [...k.byItem.values()]
        .filter((m) => m.status !== "completed" && now() - Date.parse(m.updatedAt ?? "") < UNSETTLED_MAX_MS)
        .map((m) => m.position);
      const settled = open.length ? Math.min(...open) - 1 : (after ?? undefined);
      k.cursor = settled !== undefined && settled >= 0 ? settled : undefined;
      if (!r.hasMore) break;
    }
    return k.byItem;
  }

  /**
   * the session's number within this chat (1 = its first). `seq` counts every chat's sessions together, so a chat's
   * first thread could carry seq 9 and its divider said "the earlier chat was gone" on a brand-new chat.
   */
  const ordinal = (seq: number): number => (d.db.prepare("SELECT COUNT(*) n FROM desk_session WHERE desk_key = ? AND seq <= ?").get(p.key, seq) as { n: number }).n || 1;
  /** the session of this chat right before the one with this seq (its end reason starts the next one's divider). */
  const before = (seq: number): DeskSession | undefined => {
    const r = d.db.prepare("SELECT * FROM desk_session WHERE desk_key = ? AND seq < ? ORDER BY seq DESC LIMIT 1").get(p.key, seq);
    return r ? rowTo(r) : undefined;
  };
  /** `seq` = the session's number within this chat (ordinal); `o` = its row seq, for the divider's note, and a shown position. */
  const present = (m: T3ThreadMessage, seq: number, o: { rowSeq?: number; position?: number } = {}): DeskMessage => {
    const base = { id: m.itemId, role: m.role, status: m.status, at: m.updatedAt, position: o.position ?? m.position, ...(m.truncated ? { truncated: true } : {}) };
    if (m.role === "user" && m.text.startsWith(p.seedMarker)) {
      const note = seq > 1 && o.rowSeq !== undefined ? sessionNote(before(o.rowSeq)) : undefined;
      return { ...base, kind: "seed", text: "", session: seq, ...(note ? { note } : {}) };
    }
    const hint = m.role === "user" ? PAGE_PREFIX.exec(m.text) : null;
    const said = m.role === "user" ? splitSince(hint ? m.text.slice(hint[0].length) : m.text) : { text: dropLabelLine(m.text) };
    const request = m.role === "user" ? requestIdOf(m.itemId, said.text) : undefined;
    const rows = request ? d.requestRows?.rowsOf(request) : undefined;
    return { ...base, kind: "message", text: said.text, ...(hint ? { page: hint[1] } : {}), ...(said.since ? { since: said.since } : {}), ...(request ? { request } : {}), ...(rows ? { rows } : {}) };
  };

  // ---- the one session of this key ----
  let ensuring: Promise<{ session: DeskSession; status?: string }> | undefined;

  /** Short recovery note for a relaunch: what the old thread said last, when it can still be read. */
  async function summaryOf(old: DeskSession): Promise<string> {
    const lines = old.endReason?.startsWith(SEAT_MOVE)
      ? [`The previous ${p.personaName} thread (${old.threadId}, since ${old.createdAt.slice(0, 10)}) ran on a ${old.endReason.slice(SEAT_MOVE.length)}, so the console moved this chat to a seat with headroom; the old thread is left as is and the chat shows "New session" here.`]
      : [`The previous ${p.personaName} thread (${old.threadId}, since ${old.createdAt.slice(0, 10)}) is gone${old.endReason ? ` (${old.endReason})` : ""}; the chat shows "New session" there.`];
    try {
      const page = await clientOn(old.host).readThreadMessages?.(old.threadId, { limit: 100 });
      const tail = (page?.messages ?? []).filter((m) => !isPlumbing(m.text)).slice(-6);
      for (const m of tail) lines.push(`- ${m.role === "user" ? ownerName() : "you"}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`);
    } catch {
      /* gone for real: the spines hold what matters */
    }
    lines.push(`Re-read the open tree before answering; ask ${ownerName()} if he refers to something from before.`);
    return lines.join("\n");
  }

  /** a home-world chat is the owner's own: its pick may take the seat kept for him (`pick --for owner`). */
  const ownerChat = (p.tenant ?? DEFAULT_TENANT) === DEFAULT_TENANT;
  /** `only`: launch only on that seat (a move to the owner's kept seat); any other answer releases it and keeps the old session. */
  async function launch(old?: DeskSession, only?: string): Promise<DeskSession> {
    const per = persona();
    const host = launchHost(per);
    const c = clientOn(host);
    const projects = await c.listProjects();
    // T3 does not always report a project's repositoryIdentity (the worker server 2026-11-03: listed without it now and then), so
    // like the cycle's ensureProject fall back to the checkout path every host shares: ~/github/<repo name>.
    const name = p.repo.trim().replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop();
    const project = matchProject(projects, p.repo) ?? projects.find((x) => x.workspaceRoot === path.join(hostReposRoot(), name ?? ""));
    if (!project) throw new DeskError(503, "unknown_project", `no T3 project is registered for repo ${p.repo}${host === mainHost() ? "" : ` on ${host}`}`);
    const dispatcher = d.dispatcherFor?.(host) ?? d.dispatcher;
    if (!dispatcher) throw new DeskError(503, "no_dispatcher", "EPICSPINE_DISPATCHER is not set");
    const pick = await dispatcher.pick(ownerChat ? { for: "owner" } : undefined);
    // say what refused (load-cap on the worker server …, all seats busy …), never a bare "no seat available"
    if (pick.seat === null) throw new DeskError(503, "no_seat", refusalText([classifyRefusal(pick.reason)]));
    // A long-lived thread holds no seat: release it right away (same as a persona's home thread).
    await dispatcher.done(pick.seat).catch(() => undefined);
    if (only && pick.seat !== only) throw new DeskError(503, "no_seat", `the seat kept for ${ownerName()} (${only}) was not given (${pick.seat})`);
    const message = await p.seed({ persona: per, summary: old ? await summaryOf(old) : undefined });
    let threadId: string;
    try {
      ({ threadId } = await c.launchThread({
        projectId: project.id,
        title: p.title,
        message,
        modelSelection: { instanceId: pick.providerInstanceId, model: modelId(per.model) },
      }));
      gateFor(host)?.mark(`desk ${p.key} launch`);
    } catch (e) {
      if (isT3Unavailable(e)) throw e;
      throw new DeskError(502, "t3_error", errorText(e));
    }
    const r = d.db
      .prepare("INSERT INTO desk_session (desk_key, thread_id, project_id, seat, created_at, seed_version, host) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.key, threadId, project.id, pick.seat, iso(), p.seedVersion, host);
    cache = undefined;
    return rowTo(d.db.prepare("SELECT * FROM desk_session WHERE seq = ?").get(r.lastInsertRowid));
  }

  /** T3 says the thread is gone (not found / archived) → the live row ends and the next call relaunches. */
  async function alive(s: DeskSession): Promise<{ ok: true; status: string; state: T3ThreadState } | { ok: false; reason: string }> {
    try {
      const st = await client(s).readThreadStatus(s.threadId);
      if ((st.raw as { archived?: boolean }).archived === true) return { ok: false, reason: "archived" };
      return { ok: true, status: st.status, state: st };
    } catch (e) {
      if (e instanceof DeskError || isT3Unavailable(e)) throw e; // T3 down is not "thread gone"
      if (GONE.test(errorText(e))) return { ok: false, reason: "not found in T3" };
      throw new DeskError(502, "t3_error", errorText(e));
    }
  }

  /**
   * The live thread: launched once (concurrent callers share the launch), reused while T3 still has it, relaunched with a
   * short summary when T3 lost it.
   */
  function ensureLive(): Promise<{ session: DeskSession; status?: string; state?: T3ThreadState }> {
    ensuring ??= (async () => {
      const s = current();
      if (!s) return { session: await launch() };
      const moved = await moveHost(s);
      if (moved) return { session: moved };
      const a = await alive(s);
      if (a.ok) {
        void syncSeed().catch(() => undefined); // a busy thread retries for minutes: never hold the chat on it
        return { session: s, status: a.status, state: a.state };
      }
      d.db.prepare("UPDATE desk_session SET ended_at = ?, end_reason = ? WHERE seq = ?").run(iso(), a.reason, s.seq);
      return { session: await launch({ ...s, endedAt: iso(), endReason: a.reason }) };
    })().finally(() => {
      ensuring = undefined;
    });
    return ensuring;
  }
  const ensureSession = async () => (await ensureLive()).session;

  /**
   * the persona now runs on another host than the live thread: launch a new thread there, seeded with a summary
   * of the old one (read from the old host), and end the old row. The new host unreachable, or any launch error, keeps
   * the old thread (plumbing never fails a chat). Undefined = no move.
   */
  async function moveHost(s: DeskSession): Promise<DeskSession | undefined> {
    const want = launchHost();
    if (want === s.host || (want !== mainHost() && !d.clientFor?.(want))) return undefined;
    const reason = `${HOST_MOVE}${want}`;
    try {
      const next = await launch({ ...s, endedAt: iso(), endReason: reason });
      d.db.prepare("UPDATE desk_session SET ended_at = ?, end_reason = ? WHERE seq = ? AND ended_at IS NULL").run(iso(), reason, s.seq);
      console.log(`desk ${p.key}: persona on ${want}: moved to ${next.threadId} on ${want} (old ${s.threadId} on ${s.host} left as is)`);
      // the old thread is no longer this chat's: settle it so its idle provider process stops (T3 refuses a running one)
      void Promise.resolve()
        .then(() => clientOn(s.host).settleThread?.(s.threadId))
        .catch((e) => console.warn(`desk ${p.key}: old thread ${s.threadId} on ${s.host} not settled: ${errorText(e)}`));
      return next;
    } catch (e) {
      console.warn(`desk ${p.key}: persona on ${want}, could not move (${errorText(e)}): staying on ${s.threadId} on ${s.host}`);
      return undefined;
    }
  }

  /** why the live session's seat cannot take a turn now, else undefined. */
  const blocked = (s: DeskSession | undefined = current()) => (s ? d.seatBlocked?.(s.seat) : undefined);
  /** the kept seat this chat should move to (it prefers it, can take a turn there now, and is elsewhere), else undefined. */
  const keptSeat = (s: DeskSession): string | undefined => {
    if (!p.preferOwnerSeat || !ownerChat) return undefined;
    const k = d.ownerSeat?.();
    return k && s.seat !== k ? k : undefined;
  };
  let moving: Promise<DeskSession> | undefined;
  /**
   * before the owner's send, a session on a limited / logged-out seat moves to a new thread on a seat from `pick`,
   * seeded with a summary of the old one (as when T3 lost it); the old thread is left as is. No seat with headroom (or
   * any launch error) keeps the old session: plumbing never fails a chat.
   */
  function moveIfBlocked(s: DeskSession): Promise<DeskSession> {
    const kept = blocked(s) ? undefined : keptSeat(s);
    const why = blocked(s) ?? (kept ? `${s.seat ?? "its seat"}: the Team desk goes to ${kept}, the seat kept for ${ownerName()}` : undefined);
    if (!why) return Promise.resolve(s);
    moving ??= (async () => {
      const cur = current();
      if (!cur || cur.seq !== s.seq) return cur ?? s; // someone moved it meanwhile
      const reason = `${SEAT_MOVE}${why}`;
      try {
        const next = await launch({ ...cur, endedAt: iso(), endReason: reason }, kept);
        d.db.prepare("UPDATE desk_session SET ended_at = ?, end_reason = ? WHERE seq = ? AND ended_at IS NULL").run(iso(), reason, cur.seq);
        console.log(`desk ${p.key}: ${why}: moved to ${next.seat} thread ${next.threadId} (old ${cur.threadId} left as is)`);
        return next;
      } catch (e) {
        console.warn(`desk ${p.key}: ${why}, could not move (${errorText(e)}): staying on ${cur.threadId}`);
        return cur;
      }
    })().finally(() => {
      moving = undefined;
    });
    return moving;
  }

  /**
   * The messages the owner sees: the console's own messages (endpoint-list updates, other plumbing) stay out, and so does the
   * persona's bare "Updated." acknowledgement of an update. The seed stays (the chat draws it as a divider).
   */
  function visible(sorted: T3ThreadMessage[]): T3ThreadMessage[] {
    const out: T3ThreadMessage[] = [];
    let ack = false;
    for (const m of sorted) {
      if (m.role === "user") {
        ack = m.text.startsWith(p.updateMarker);
        if (!m.text.startsWith(p.seedMarker) && isPlumbing(m.text)) continue;
      } else if (ack) {
        ack = false;
        if (m.text.trim().replace(/[.!\s]+$/, "").toLowerCase() === "updated") continue;
      }
      out.push(m);
    }
    return out;
  }

  // ----: the chat's earlier sessions, read as history (each on its own host; an ended thread no longer changes) ----
  const history = new Map<string, Cache>();
  /** Earlier threads that could not be read (host down, thread gone), until when they are skipped. */
  const unreadable = new Map<string, number>();
  const UNREADABLE_MS = 60_000;
  /** The sessions of this chat before `s`, newest first: the j-th earlier one is index j - 1. */
  const earlierSessions = (s: DeskSession): DeskSession[] =>
    (d.db.prepare("SELECT * FROM desk_session WHERE desk_key = ? AND seq < ? ORDER BY seq DESC").all(p.key, s.seq) as any[]).map(rowTo);
  /** An earlier thread's cache: a first read starts at its tail (its item count), like the live thread's. */
  async function historyOf(old: DeskSession): Promise<Cache> {
    const have = history.get(old.threadId);
    if (have) return have;
    const st = await clientOn(old.host).readThreadStatus(old.threadId);
    const count = Number((st.raw as { itemCount?: unknown } | undefined)?.itemCount);
    const k: Cache = { threadId: old.threadId, cursor: undefined, byItem: new Map(), from: Number.isFinite(count) && count > 0 ? count + 1 : Number.MAX_SAFE_INTEGER };
    history.set(old.threadId, k);
    return k;
  }
  /** The newest `want` visible messages of an earlier thread below position `below`, reading back windows as needed. */
  async function historyMessages(old: DeskSession, below: number, want: number): Promise<{ messages: T3ThreadMessage[]; more: boolean }> {
    const k = await historyOf(old);
    const older = () => visible([...k.byItem.values()].sort((a, b) => a.position - b.position)).filter((m) => m.position < below);
    let have = older();
    while (have.length <= want && k.from > 0) {
      // an unknown item count reads the whole thread once
      await readBack(k, k.from >= Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, Math.min(k.from, below) - TAIL_WINDOW));
      have = older();
    }
    return { messages: have.slice(-Math.max(0, want)), more: have.length > want || k.from > 0 };
  }
  /**
   * the page of earlier sessions' messages older than `beforeShown` (a shown position, negative; undefined = from the
   * newest earlier session's end), newest `n` of them, oldest first, with shown positions (historyPosition) and their dividers.
   * A thread that cannot be read is skipped (and retried a minute later): the chat never fails on its history.
   */
  async function historyPage(s: DeskSession, beforeShown: number | undefined, n: number): Promise<EarlierPage> {
    const prev = earlierSessions(s);
    const start = beforeShown !== undefined && beforeShown < 0 ? fromHistoryPosition(beforeShown) : { j: 1, position: Number.POSITIVE_INFINITY };
    let out: DeskMessage[] = [];
    let more = false;
    for (let j = start.j; j <= prev.length; j++) {
      const want = n - out.length;
      if (want <= 0) {
        more = true;
        break;
      }
      const old = prev[j - 1]!;
      if ((unreadable.get(old.threadId) ?? 0) > now()) continue;
      let got: { messages: T3ThreadMessage[]; more: boolean };
      try {
        got = await historyMessages(old, j === start.j ? start.position : Number.POSITIVE_INFINITY, want);
      } catch (e) {
        unreadable.set(old.threadId, now() + UNREADABLE_MS);
        history.delete(old.threadId);
        console.warn(`desk ${p.key}: earlier thread ${old.threadId} on ${old.host} not read (${errorText(e)}): left out of the history for now`);
        continue;
      }
      const nth = ordinal(old.seq);
      out = [...got.messages.map((m) => present(m, nth, { rowSeq: old.seq, position: historyPosition(j, m.position) })), ...out];
      if (got.more) {
        more = true;
        break;
      }
    }
    return { messages: out, hasEarlier: more };
  }

  /**
   * the page of messages older than `before` (a position) of the live session `s`, newest `n` of them. Reads back from T3 only
   * what the cache does not hold yet; past the live thread's start it goes on into the earlier sessions.
   */
  async function readEarlier(s: DeskSession, before: number, n: number): Promise<EarlierPage> {
    // a negative position is an earlier session's (the chat scrolled up past the live thread's start)
    if (before < 0) return historyPage(s, before, n);
    const k = cacheFor(s.threadId);
    // a cache that has read nothing yet (a restart, while the chat page kept its older pages) reads back from `before`, not from 0
    if (k.cursor === undefined && k.byItem.size === 0 && k.from === 0) k.from = before;
    const older = () => visible([...k.byItem.values()].sort((a, b) => a.position - b.position)).filter((m) => m.position < before);
    let have = older();
    while (have.length <= n && k.from > 0) {
      await readBack(k, Math.max(0, Math.min(k.from, before) - TAIL_WINDOW));
      have = older();
    }
    const nth = ordinal(s.seq);
    const mine = have.slice(-n).map((m) => present(m, nth, { rowSeq: s.seq }));
    if (have.length > n || k.from > 0) return { messages: mine, hasEarlier: true };
    // the live thread's start: the chat goes on into its earlier sessions
    const h = await historyPage(s, undefined, n - mine.length);
    return { messages: [...h.messages, ...mine], hasEarlier: h.hasEarlier };
  }

  // ----: tell the live thread the current endpoint list, once per seed version ----
  let syncing: Promise<void> | undefined;
  let syncError: string | undefined;

  /**
   * The live thread got an older endpoint list than seedVersion: send it one update message with the current list (no
   * relaunch), then record the version. Once per version: concurrent callers share one send, the request id is stable per
   * (version, session), and the version is recorded only after T3 took the message (a failure is retried by the next call).
   * Never launches a thread: with no live session there is nothing to update (a new one is seeded with the current list).
   */
  /** why the update waits, logged once per reason (a desk once sat on an old list for days with nothing in the log). */
  let lastSkip: string | undefined;
  const skipped = (why: string) => {
    if (why !== lastSkip) console.warn(`desk ${p.key}: endpoint update v${p.seedVersion} waits: ${why}`);
    lastSkip = why;
  };
  function syncSeed(): Promise<void> {
    syncing ??= (async () => {
      const s = current();
      if (!s || s.seedVersion >= p.seedVersion || !d.t3) return;
      // the seat is limited / logged out: the update waits for headroom (it never reaches the owner, so it never moves the
      // chat by itself; the next owner send or console note moves it, and a move seeds the new list)
      const seat = blocked(s);
      if (seat) return skipped(seat);
      // the main server at its session cap: the update waits (the next open of this chat tries again)
      const cap = await capFull(s.host);
      if (cap) return skipped(cap);
      // one desk update per the main server session start gap (a deploy that raised the version updated 8 desks in 2 min); a later open sends it
      const gate = gateFor(s.host);
      const slot = gate?.take(`desk ${p.key} endpoint update v${p.seedVersion}`);
      if (slot && !slot.ok) return skipped("session start gap");
      try {
        const id = p.updateRequestId?.(s.seq) ?? `${p.key}-seed-v${p.seedVersion}-s${s.seq}`;
        await client(s).sendToThread(s.threadId, await p.update(), id, "auto").catch((e) => {
          if (slot?.ok) gate?.cancel(slot.token);
          throw e;
        });
        d.db.prepare("UPDATE desk_session SET seed_version = ? WHERE seq = ? AND (seed_version IS NULL OR seed_version < ?)").run(p.seedVersion, s.seq, p.seedVersion);
        syncError = undefined;
      } catch (e) {
        syncError = errorText(e);
        console.warn(`desk ${p.key}: endpoint update v${p.seedVersion} not delivered: ${syncError}`);
      }
    })().finally(() => {
      syncing = undefined;
    });
    return syncing;
  }

  /** the owner's own messages in the live thread (plumbing excluded, page hint stripped), oldest first. */
  async function jordiMessages(): Promise<{ text: string; at?: string; position: number; request?: string }[]> {
    const s = current();
    if (!s || !d.t3) return [];
    const all = [...(await refresh(s.threadId)).values()].filter((m) => m.role === "user").sort((a, b) => a.position - b.position);
    return all.filter((m) => !isPlumbing(m.text)).map((m) => {
      const text = splitSince(m.text.replace(PAGE_PREFIX, "")).text;
      const request = requestIdOf(m.itemId, text);
      return { text, at: m.updatedAt, position: m.position, ...(request ? { request } : {}) };
    });
  }

  /** The newest user-role message in the live thread, plumbing included (the stamp guard needs to know whose it is). */
  async function newestUserMessage(): Promise<{ text: string; at?: string; seed: boolean; plumbing: boolean } | undefined> {
    const s = current();
    if (!s || !d.t3) return undefined;
    const last = [...(await refresh(s.threadId)).values()].filter((m) => m.role === "user").sort((a, b) => b.position - a.position)[0];
    if (!last) return undefined;
    return { text: last.text, at: last.updatedAt, seed: last.text.startsWith(p.seedMarker), plumbing: isPlumbing(last.text) };
  }

  // ---- sends in flight ----
  let sending = 0;
  let sendError: { text: string; at: string; clientRequestId?: string } | undefined;
  /** the words of the message `sendError` is about: once they show in the thread, it was no failure and the error goes. */
  let sendErrorFor: string | undefined;
  /**
   * T3 did not answer the send in time: it may well have taken it (his message, 18 Nov 18:1xZ, said "Not sent: The
   * operation was aborted due to timeout" while the desk had it). Such a send is queued and sent again with the same
   * request id (T3 drops a copy it already took), never shown as a failure.
   */
  const timedOut = (e: unknown) => (e as Error)?.name === "TimeoutError" || /aborted due to timeout|timed? ?out/i.test(errorText(e));
  /** the owner's sends reach T3 one at a time, in the order he wrote them. */
  let sendChain: Promise<unknown> = Promise.resolve();

  /** Frame the owner's text with the page hint he sent it from. */
  const frame = (text: string, page?: string) => {
    const hint = page?.replace(/[\r\n[\]]+/g, " ").trim().slice(0, PAGE_HINT_MAX);
    return hint ? `[page: ${hint}]\n${text}` : text;
  };

  // ----: T3 down: last good view, and an outbox for the owner's sends ----
  let lastGood: DeskView | undefined;
  /** the live read in flight, shared by every caller. */
  let viewing: Promise<DeskView> | undefined;
  /** a send went out since the last good view: the next view waits for T3 instead of answering from that view. */
  let mustWait = false;
  /** the desk_view_cache row last written by this process. */
  let persisted: string | undefined;
  const viewBudgetMs = d.viewBudgetMs ?? VIEW_BUDGET_MS;
  const sendViewWaitMs = d.sendViewWaitMs ?? SEND_VIEW_WAIT_MS;
  const earlierBudgetMs = d.earlierBudgetMs ?? EARLIER_BUDGET_MS;
  /** older-page reads in flight, by `before|n`: a retry joins the read under way instead of starting another. */
  const olderReads = new Map<string, Promise<EarlierPage>>();
  const downReason = () => (d.t3DownReason ?? t3DownReason)();

  interface OutboxRow {
    seq: number;
    client_request_id: string;
    text: string;
    page: string | null;
    message: string;
    created_at: string;
  }
  const unsent = (): OutboxRow[] =>
    d.db.prepare("SELECT * FROM desk_outbox WHERE desk_key = ? AND sent_at IS NULL AND failed_at IS NULL ORDER BY seq").all(p.key) as OutboxRow[];
  const queued = (): QueuedMessage[] =>
    unsent().map((r) => ({ id: `queued-${r.seq}`, text: r.text, ...(r.page ? { page: r.page } : {}), at: r.created_at }));
  /**
   * Store a send for later (a retried request with the same clientRequestId is stored once). A held send that failed is
   * held again by its retry (a voice note keeps one request id for life, so a failed row must not swallow it);
   * one already sent stays sent (T3 drops the repeat).
   */
  function enqueue(clientRequestId: string, text: string, page: string | undefined, message: string) {
    d.db
      .prepare(
        "INSERT INTO desk_outbox (desk_key, client_request_id, text, page, message, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_request_id) DO UPDATE SET failed_at = NULL, error = NULL WHERE sent_at IS NULL AND failed_at IS NOT NULL",
      )
      .run(p.key, clientRequestId, text, page ?? null, message, iso());
    console.log(`desk ${p.key}: T3 is down, send ${clientRequestId} queued`);
  }

  let flushing: Promise<number> | undefined;
  /**
   * Deliver the queued sends, oldest first, each with its original clientRequestId (T3 drops a duplicate, so a send that did
   * reach T3 before it went down is never doubled). Stops while T3 is still down; another failure marks that send failed (the
   * chat shows "Not sent"). Concurrent callers share one pass.
   */
  function flushQueued(): Promise<number> {
    flushing ??= (async () => {
      let n = 0;
      for (const r of unsent()) {
        if (!d.t3) break;
        // queued sends go out through the main server session start gate (after a T3 restart they all wait at once)
        const gate = gateFor(current()?.host ?? launchHost());
        const slot = gate?.take(`desk ${p.key} queued send`);
        if (slot && !slot.ok) break; // the next read or tick tries again
        try {
          const s = await moveIfBlocked(await ensureSession());
          sending++;
          try {
            await client(s).sendToThread(s.threadId, r.message, r.client_request_id, "auto");
          } catch (e) {
            if (slot?.ok) gate?.cancel(slot.token);
            throw e;
          } finally {
            sending--;
          }
          d.db.prepare("UPDATE desk_outbox SET sent_at = ?, thread_id = ? WHERE seq = ?").run(iso(), s.threadId, r.seq);
          console.log(`desk ${p.key}: queued send ${r.client_request_id} delivered to ${s.threadId}`);
          n++;
        } catch (e) {
          if (isT3Unavailable(e) || timedOut(e)) break; // still down, or no answer in time: the next read or tick tries again (same request id)
          d.db.prepare("UPDATE desk_outbox SET failed_at = ?, error = ? WHERE seq = ?").run(iso(), errorText(e), r.seq);
          sendError = { text: errorText(e), at: iso() };
          sendErrorFor = r.text;
        }
      }
      return n;
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  /**
   * The chat while T3 is down: the last good read of this thread (or what the cache holds), a quiet reason, the queue.
   * `unreachable` = the thread's own host cannot be reached (the chat says "Can't reach <host>, retrying"); the last
   * good read is also the desk_view_cache row after a restart, so the chat does not go blank.
   */
  function downView(unreachable?: DeskHost): DeskView {
    const s = current();
    const last = lastGood && (!s || lastGood.threadId === s.threadId) ? lastGood : lastView();
    const base: DeskView =
      last
        ? last
        : {
            available: true,
            ...(s ? { threadId: s.threadId, session: s.seq } : {}),
            environmentId: envOf(s?.host ?? launchHost()),
            working: false,
            sending: 0,
            messages:
              s && cache?.threadId === s.threadId
                ? visible([...cache.byItem.values()].sort((a, b) => a.position - b.position)).map((m) => present(m, ordinal(s.seq), { rowSeq: s.seq })).slice(-TAIL_MESSAGES)
                : [],
            hasEarlier: false,
          };
    const { workingSince: _w, sendError: _e, ...rest } = base;
    const q = queued();
    const host = s?.host ?? launchHost();
    return {
      ...rest,
      host,
      working: false,
      sending,
      ...(sendError ? { sendError } : {}),
      ...(unreachable ? { unreachable } : { t3: downReason() }),
      ...(q.length ? { queued: q } : {}),
    };
  }

  return {
    profile: p,
    persona,
    /** the T3 of a session's own host (console notes into the thread go there). */
    clientOf: (s: DeskSession) => client(s),
    /** the session start gate of a session's host (the main server's; none for the worker server thread). */
    gateOf: (s: DeskSession) => gateFor(s.host),
    current,
    sessions,
    ensureSession,
    syncSeed,
    /** why the live session's seat cannot take a turn now (still blocked after moveIfBlocked = no seat with headroom), else undefined. */
    blocked: () => blocked(),
    /**
     * a console note that must reach the owner (the 20:00 digest, the evening scorecard, a delivered note) moves off
     * a limited / logged-out seat exactly like his own send; no seat with headroom keeps the old session.
     */
    moveIfBlocked,
    syncError: () => syncError,
    jordiMessages,
    newestUserMessage,

    /**
     * every finished message of the live thread as the owner sees it (plumbing out, seed as a divider), oldest first,
     * for the team repo's copy of the chat. Never launches a thread: no live session = nothing to copy.
     */
    async transcript(): Promise<DeskMessage[]> {
      const s = current();
      if (!s || !d.t3) return [];
      const items = await refresh(s.threadId);
      return visible([...items.values()].sort((a, b) => a.position - b.position))
        .filter((m) => m.status === "completed")
        .map((m) => present(m, ordinal(s.seq), { rowSeq: s.seq }));
    },

    /**
     * what the unread pill counts, read through the same cache as the chat (only what T3 has past the cursor): when
     * each finished reply the owner would see arrived, and when he last wrote himself (plumbing and the seed are not his).
     * Never launches a thread: no live session = nothing to count.
     */
    async replyTimes(): Promise<{ threadId: string; replies: string[]; lastOwnAt?: string; lastText?: string } | undefined> {
      const s = current();
      if (!s || !d.t3) return undefined;
      const shown = visible([...(await refresh(s.threadId)).values()].sort((a, b) => a.position - b.position));
      const done = shown.filter((m) => m.role === "assistant" && m.status === "completed" && m.updatedAt);
      const replies = done.map((m) => m.updatedAt!);
      const own = shown.filter((m) => m.role === "user" && !m.text.startsWith(p.seedMarker)).at(-1);
      const lastText = done.at(-1)?.text; // the phone notification's body
      return { threadId: s.threadId, replies, ...(own?.updatedAt ? { lastOwnAt: own.updatedAt } : {}), ...(lastText ? { lastText } : {}) };
    },

    /**
     * The chat as the owner sees it. Launches the thread on first open (that is its one-time creation). The newest
     * `limit` messages (default TAIL_MESSAGES); T3 gets VIEW_BUDGET_MS, then the last good view answers (`stale: true`)
     * while the live read finishes for the next poll. Right after a send it waits for T3 up to SEND_VIEW_WAIT_MS, so his message shows.
     */
    async view(o: ViewOpts = {}): Promise<DeskView> {
      const idle = { working: false, sending: 0, messages: [], hasEarlier: false };
      if (!d.t3) return { available: false, reason: p.unavailable, ...idle };
      const limit = Math.max(1, Math.min(TAIL_MESSAGES, Math.floor(o.limit ?? TAIL_MESSAGES)));
      const live = freshView();
      const last = lastView();
      if (!last) return shape(await live, limit);
      // right after a send it waits longer (his message should come from the thread), never unbounded
      const budget = mustWait ? sendViewWaitMs : viewBudgetMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const won = await Promise.race([live, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), budget)))]).finally(() => clearTimeout(timer));
      if (won) return shape(won, limit);
      // one waited read per send. The page keeps his own bubble and re-reads every second while stale; were
      // mustWait left on, each of those re-reads would wait sendViewWaitMs again (14 reads of 2 s in a row on 2026-11-14).
      mustWait = false;
      live.catch((e) => console.warn(`desk ${p.key}: background read failed: ${errorText(e)}`));
      const q = queued();
      const { queued: _q, sendError: _e, ...rest } = last;
      return shape({ ...rest, sending, ...(sendError ? { sendError } : {}), ...(q.length ? { queued: q } : {}), stale: true }, limit);
    },

    /**
     * the page of messages older than `before` (a position), newest `limit` of them, for the owner scrolling up.
     * T3 gets EARLIER_BUDGET_MS, then `loading: true` answers and the read finishes into the cache for the chat's retry.
     * Never launches a thread.
     */
    async earlier(before: number, limit = 30): Promise<EarlierPage> {
      const s = current();
      if (!s || !d.t3) return { messages: [], hasEarlier: false };
      const n = Math.max(1, Math.min(TAIL_MESSAGES, Math.floor(limit)));
      const key = `${s.threadId}|${before}|${n}`;
      let read = olderReads.get(key);
      if (!read) {
        read = readEarlier(s, before, n).finally(() => olderReads.delete(key));
        olderReads.set(key, read);
      }
      const r = read;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const won = await Promise.race([r, new Promise<undefined>((ok) => (timer = setTimeout(() => ok(undefined), earlierBudgetMs)))]).finally(() => clearTimeout(timer));
      if (won) return won;
      // the read runs on into the cache (the chat's retry finds it there); its failure is logged, never shown red
      r.catch((e) => console.warn(`desk ${p.key}: older page before ${before} failed: ${errorText(e)}`));
      return { messages: [], hasEarlier: true, loading: true };
    },

    /** deliver the sends queued while T3 was down (the desk tick calls it too). */
    flushQueued,
    /** queued sends not delivered yet. */
    queued,

    /**
     * Send the owner's message (auto mode, with T3's busy retries) with the page hint. Answers once T3 accepted it, or after
     * sendWaitMs with `pending: true` while the retries run on (a failure then shows as `sendError` on the next read).
     * `prefix` (hook): console context put before his words, e.g. what changed since his last message.
     * T3 down (or earlier sends still queued) = the message is stored and sent once T3 is back (`queued: true`).
     */
    async send(text: string, page?: string, clientRequestId?: string, prefix?: string): Promise<{ threadId: string; pending: boolean; queued?: boolean }> {
      const body = text.trim();
      if (!body) throw new DeskError(400, "empty_message", "message is required");
      const crid = clientRequestId ?? `${p.key}-send-${randomUUID()}`;
      const message = frame(prefix ? `${prefix}\n${body}` : body, page);
      const queue = () => {
        enqueue(crid, body, page, message);
        return { threadId: current()?.threadId ?? "", pending: true, queued: true };
      };
      if (unsent().length) {
        // keep the owner's order: behind what already waits
        const out = queue();
        void flushQueued().catch(() => undefined);
        return out;
      }
      // the thread check and the send run after the reply (never longer than sendWaitMs), behind his earlier sends.
      let threadId = current()?.threadId ?? "";
      mustWait = true; // the next view waits for T3, so his message shows (not the view from before it)
      sending++;
      const run = async (): Promise<"done" | "queued"> => {
        let s: DeskSession;
        try {
          s = await moveIfBlocked(await ensureSession()); // off a limited seat first
        } catch (e) {
          if (isT3Unavailable(e)) {
            enqueue(crid, body, page, message);
            return "queued";
          }
          throw e;
        }
        threadId = s.threadId;
        // a thread behind the seed version takes the update first, then his message: his message starts a turn anyway, and
        // an update fired beside it raced his turn, met a busy thread and gave up, again on every send (the desk sat 3 days on
        // an old list). A failed update never holds his message.
        if (current()?.seq === s.seq && (current()?.seedVersion ?? p.seedVersion) < p.seedVersion) await syncSeed().catch(() => undefined);
        gateFor(s.host)?.mark(`desk ${p.key} ${ownerName()}'s message`); // never waits, but the next automated start keeps its distance
        try {
          await client(s).sendToThread(s.threadId, message, crid, "auto");
        } catch (e) {
          if (isT3Unavailable(e) || timedOut(e)) {
            enqueue(crid, body, page, message);
            return "queued";
          }
          throw e;
        }
        sendError = undefined;
        sendErrorFor = undefined;
        return "done";
      };
      const job = sendChain.then(run, run);
      sendChain = job.catch(() => undefined);
      const settled = job
        .catch((e) => {
          sendError = { text: errorText(e), at: iso(), clientRequestId: crid };
          sendErrorFor = body;
          throw e;
        })
        .finally(() => {
          sending--;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([settled, new Promise<"wait">((r) => (timer = setTimeout(() => r("wait"), sendWaitMs)))])
        .catch((e) => {
          throw e instanceof DeskError ? e : new DeskError(502, "t3_error", errorText(e));
        })
        .finally(() => clearTimeout(timer));
      if (outcome === "wait") settled.catch(() => undefined); // keeps going; a failure is on sendError with his clientRequestId
      return { threadId: threadId || (current()?.threadId ?? ""), pending: outcome !== "done", ...(outcome === "queued" ? { queued: true } : {}) };
    },
  };

  /** one live read at a time per chat (concurrent opens and polls share it); a success becomes the last good view. */
  function freshView(): Promise<DeskView> {
    viewing ??= (async () => {
      let v: DeskView;
      try {
        v = await liveView();
      } catch (e) {
        // the thread's host cannot be reached (no tunnel to the worker server): the last good read and "can't reach", never blank
        if (e instanceof HostUnreachableError) return downView(e.host);
        if (!isT3Unavailable(e)) throw e;
        const host = current()?.host;
        return downView(host && host !== mainHost() ? host : undefined); // never the raw ECONNREFUSED
      }
      lastGood = v;
      mustWait = false;
      persist(v);
      const q = queued();
      if (q.length) void flushQueued().catch(() => undefined); // T3 answered: deliver what waited
      return q.length ? { ...v, queued: q } : v;
    })().finally(() => {
      viewing = undefined;
    });
    return viewing;
  }

  /** the newest `limit` messages of a view; older ones exist when the view had more (or T3 has more). */
  function shape(v: DeskView, limit: number): DeskView {
    if (v.messages.length <= limit) return v;
    return { ...v, messages: v.messages.slice(-limit), hasEarlier: true };
  }

  /** the last good view of the live thread: this process's, else the desk_view_cache row (after a restart). */
  function lastView(): DeskView | undefined {
    const s = current();
    if (!s) return undefined;
    if (lastGood?.threadId === s.threadId) return lastGood;
    const r = d.db.prepare("SELECT thread_id, view FROM desk_view_cache WHERE desk_key = ?").get(p.key) as { thread_id: string; view: string } | undefined;
    if (!r || r.thread_id !== s.threadId) return undefined;
    try {
      return JSON.parse(r.view) as DeskView;
    } catch {
      return undefined;
    }
  }

  /** keep the newest CACHED_MESSAGES of the view in desk_view_cache, written only when they changed. */
  function persist(v: DeskView) {
    if (!v.threadId) return;
    const { sendError: _e, queued: _q, stale: _s, ...rest } = v;
    const keep = { ...rest, sending: 0, messages: v.messages.slice(-CACHED_MESSAGES), hasEarlier: v.hasEarlier || v.messages.length > CACHED_MESSAGES };
    const json = JSON.stringify(keep);
    if (json === persisted) return;
    try {
      d.db.prepare("INSERT INTO desk_view_cache (desk_key, thread_id, view, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(desk_key) DO UPDATE SET thread_id = excluded.thread_id, view = excluded.view, updated_at = excluded.updated_at").run(p.key, v.threadId, json, iso());
      persisted = json;
    } catch (e) {
      console.warn(`desk ${p.key}: view cache not written: ${errorText(e)}`);
    }
  }

  async function liveView(): Promise<DeskView> {
    const live = await ensureLive();
    const s = live.session;
    // ensureLive already read the status of a thread it reused; a fresh launch has not been read yet.
    const state = live.state ?? (await client(s).readThreadStatus(s.threadId));
    const status = state.status;
    const since = turnStart(state);
    // a long thread read for the first time starts at its tail (the item count comes with the status read)
    const count = Number((state.raw as { itemCount?: unknown } | undefined)?.itemCount);
    const items = await refresh(s.threadId, { tailOf: Number.isFinite(count) && count > 0 ? count : 0 });
    const nth = ordinal(s.seq);
    const all = visible([...items.values()].sort((a, b) => a.position - b.position)).map((m) => present(m, nth, { rowSeq: s.seq }));
    // a send shown as failed whose message is in the thread after all was no failure: the error goes.
    const said = sendErrorFor?.trim().slice(0, 120);
    if (sendError && said && all.some((m) => m.role === "user" && m.text.includes(said))) {
      sendError = undefined;
      sendErrorFor = undefined;
    }
    let tail = all.slice(-TAIL_MESSAGES);
    let earlierMore = false;
    // a live thread that holds less than a screen (a new session after a host move) shows the earlier session above it
    if (tail.length < HISTORY_FILL && all.length === tail.length && !(cache?.threadId === s.threadId && cache.from > 0)) {
      const h = await historyPage(s, undefined, HISTORY_FILL - tail.length);
      tail = [...h.messages, ...tail];
      earlierMore = h.hasEarlier;
    }
    return {
      available: true,
      threadId: s.threadId,
      environmentId: envOf(s.host),
      session: s.seq,
      status,
      working: WORKING.has(status),
      ...(since ? { workingSince: since } : {}),
      sending,
      ...(sendError ? { sendError } : {}),
      host: s.host,
      messages: tail,
      hasEarlier: all.length > TAIL_MESSAGES || (cache?.threadId === s.threadId && cache.from > 0) || earlierMore,
    };
  }
}

export type ChatSession = ReturnType<typeof createChatSession>;
