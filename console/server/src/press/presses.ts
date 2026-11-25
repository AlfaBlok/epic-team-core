import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";

/**
 * every button press, its result and why. Until now the console kept only
 * the presses that worked (126 answers since 1 Nov, every one written); a press whose spine write failed left no trace,
 * so nobody could say how often a button failed, and on 2026-11-07 21:20Z every press failed for an hour unseen.
 *
 * One row per press (operational data, not work state: the repo stays the only source, root L-45; a row only carries a
 * press until it lands in the repo, then it is its log line):
 * - `landing`: saved here before any git write (the outbox); a worker replays it with backoff until it lands.
 * - `landed`: the repo has it (result `ok` on the first try, `retried` after more).
 * - `failed`: refused for a reason a retry cannot fix (the row left review, bad input), or still not landed after
 *   GIVE_UP_MS; the reason is kept and /api/write-health shows it.
 * Answers (respond) already have their own save-first job (inbox/answerJobs.ts): their press row follows that
 * job (`ref` = the jordi_responses id) instead of being replayed here.
 */
export type PressState = "landing" | "landed" | "failed" | "undone";
export type PressResult = "ok" | "queued" | "retried" | "failed" | "undone";

/**
 * a card press sent with `x-undo-ms: <ms>` (Team home's cards) waits that long before it is written, so the
 * floating "Saved · Bring it back" note can take it back: an undone press writes nothing and wakes nobody (state
 * `undone`, never counted as a failure). At most UNDO_MAX_MS; other callers (the daily press test, agents) send none.
 */
export const UNDO_MAX_MS = 15_000;
export const undoHoldMs = (h: string | undefined | null): number => {
  const n = Number(h ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), UNDO_MAX_MS) : 0;
};

export interface PressTry {
  at: string;
  ms: number;
  status: number;
  reason?: string;
  /** `Server-Timing` steps of that try (fetch, commit, push, …), when the route sent them. */
  steps?: Record<string, number>;
}

export interface Press {
  id: string;
  at: string;
  action: string;
  target: string;
  who: string;
  via?: string;
  route: string;
  state: PressState;
  result: PressResult;
  reason?: string;
  attempts: number;
  tries: PressTry[];
  nextAt?: string;
  landedAt?: string;
  /** Total time from the press to its landing (or its final failure). */
  ms?: number;
  sha?: string;
  httpStatus?: number;
  /** The jordi_responses row whose answer job carries this press. */
  ref?: string;
  /** What the route answered when it landed (the card's new state), for the page that waits on it. */
  response?: unknown;
  /**
   * kept, not written yet: the row it writes could be read two ways (cells out of line with its header), so the
   * press waits in the outbox, its row's owner was woken, and it is tried every minute until the row is whole.
   * While `state` is `landing` the card says it was kept; the value stays after it lands (it was kept that long).
   */
  held?: string;
  /** when it was first kept. */
  heldAt?: string;
}

/**
 * a row the console cannot read one way (rows.ts `outOfColumns`: more or fewer cells than its header, not the one
 * stray empty cell the console mends): nothing is written until the row is repaired. Such a refusal keeps the press.
 */
export const OUT_OF_COLUMNS = /row (\S+) has (\d+) cells but its header has (\d+)/;
/** a kept press is tried again this often for HELD_FAST_MS, then every HELD_SLOW_MS. */
export const HELD_RETRY_MS = 60_000;
export const HELD_FAST_MS = 2 * 3600_000;
export const HELD_SLOW_MS = 5 * 60_000;
/** a kept press whose row is still not repaired after this fails (and shows on /api/write-health): 7 days. */
export const HELD_GIVE_UP_MS = 7 * 86_400_000;

/** Pause before try 2, 3, …; the last pause repeats until GIVE_UP_MS. */
export const PRESS_RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/** A press still not landed after this is failed (and counted, and shown): 48 h. */
export const PRESS_GIVE_UP_MS = 48 * 3600_000;

export function ensurePresses(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS presses (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      who TEXT NOT NULL,
      via TEXT,
      route TEXT NOT NULL,
      state TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      tries TEXT NOT NULL DEFAULT '[]',
      next_at TEXT,
      landed_at TEXT,
      ms INTEGER,
      sha TEXT,
      http_status INTEGER,
      ref TEXT,
      request TEXT,
      response TEXT,
      client_key TEXT,
      tenant_id TEXT
    );
    CREATE INDEX IF NOT EXISTS presses_at ON presses(at);
    CREATE INDEX IF NOT EXISTS presses_state ON presses(state, next_at);
    CREATE INDEX IF NOT EXISTS presses_ref ON presses(ref);
    CREATE UNIQUE INDEX IF NOT EXISTS presses_key ON presses(client_key) WHERE client_key IS NOT NULL;
  `);
  // a press kept for a row that could be read two ways (added to logs made before it)
  const cols = new Set((db.prepare("PRAGMA table_info(presses)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("held")) db.exec("ALTER TABLE presses ADD COLUMN held TEXT");
  if (!cols.has("held_at")) db.exec("ALTER TABLE presses ADD COLUMN held_at TEXT");
}

/** What the outbox replays: the original request, minus anything secret (a secret press is never replayed). */
export interface PressRequest {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  /** the console-host caller the replay acts as (the daily press test), never a login or a token. */
  peer?: string;
  /** the card's row when pressed (repo, spine, code): his words still land there if the row moves on. */
  card?: { repo: string; path: string; ref: string; title?: string; milestoneId?: string };
}

/**
 * a repeat refused within this long after the same press landed takes that landing (the first press already
 * did it); a refusal this soon after another press on the same card landed is tried again (the view may lag behind).
 */
export const REPEAT_WINDOW_MS = 15 * 60_000;
export const SIBLING_WINDOW_MS = 2 * 60_000;

type Row = {
  id: string;
  at: string;
  action: string;
  target: string;
  who: string;
  via: string | null;
  route: string;
  state: PressState;
  result: PressResult;
  reason: string | null;
  attempts: number;
  tries: string;
  next_at: string | null;
  landed_at: string | null;
  ms: number | null;
  sha: string | null;
  http_status: number | null;
  ref: string | null;
  request: string | null;
  response: string | null;
  tenant_id: string | null;
  held?: string | null;
  held_at?: string | null;
};

const parse = <T>(s: string | null, d: T): T => {
  if (!s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

/** Two request bodies say the same (JSON compared by value; an empty body and `{}` are the same). */
function sameBody(a: string | undefined, b: string): boolean {
  const norm = (s: string | undefined) => {
    const t = (s ?? "").trim();
    if (!t) return "{}";
    try {
      return JSON.stringify(sortKeys(JSON.parse(t)));
    } catch {
      return t;
    }
  };
  return norm(a) === norm(b);
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

function toPress(r: Row, withResponse = false): Press {
  return {
    id: r.id,
    at: r.at,
    action: r.action,
    target: r.target,
    who: r.who,
    ...(r.via ? { via: r.via } : {}),
    route: r.route,
    state: r.state,
    result: r.result,
    ...(r.reason ? { reason: r.reason } : {}),
    attempts: r.attempts,
    tries: parse<PressTry[]>(r.tries, []),
    ...(r.next_at ? { nextAt: r.next_at } : {}),
    ...(r.landed_at ? { landedAt: r.landed_at } : {}),
    ...(r.ms !== null ? { ms: r.ms } : {}),
    ...(r.sha ? { sha: r.sha } : {}),
    ...(r.http_status !== null ? { httpStatus: r.http_status } : {}),
    ...(r.ref ? { ref: r.ref } : {}),
    ...(withResponse && r.response ? { response: parse<unknown>(r.response, undefined) } : {}),
    ...(r.held ? { held: r.held } : {}),
    ...(r.held_at ? { heldAt: r.held_at } : {}),
  };
}

/** How a try ended: in the repo, worth another try, or refused for good. */
export type Verdict = { kind: "landed"; sha?: string; note?: string } | { kind: "retry"; reason: string } | { kind: "refused"; reason: string } | { kind: "held"; reason: string };

/** Checkout and git trouble a later try can get past (a write refused for the checkout's state, not for the press). */
const CHECKOUT_TROUBLE =
  /uncommitted changes|diverged|not fast-forwardable|commit\(s\) ahead|detached HEAD|is on \S+, not main|not a git checkout|git (fetch|push|status|commit|merge|clone)|fast-forward|rebase|timed out|\block\b|index\.lock|could not|ECONN|ETIMEDOUT|EAI_AGAIN|no own clone/i;

/** Judge a route's answer: 2xx landed; a write that landed but whose follow-up (a wake) failed landed; 5xx and checkout trouble retry. */
export function judge(status: number, body: unknown): Verdict {
  const b = (body ?? {}) as {
    error?: { code?: string; message?: string; item?: { sha?: string } };
    sha?: string;
    item?: { sha?: string };
    spine?: { sha?: string };
  };
  const sha = b.sha ?? b.item?.sha ?? b.spine?.sha ?? b.error?.item?.sha;
  if (status >= 200 && status < 300) return { kind: "landed", ...(sha ? { sha } : {}) };
  const code = b.error?.code ?? "";
  const reason = (b.error?.message ?? `HTTP ${status}`).slice(0, 600);
  if (code === "wake_failed") return { kind: "landed", ...(sha ? { sha } : {}), note: reason };
  if (status >= 500) return { kind: "retry", reason };
  // the row could be read two ways: kept until it is repaired, never refused into nothing
  if (status === 409 && OUT_OF_COLUMNS.test(reason)) return { kind: "held", reason };
  if (status === 409 && CHECKOUT_TROUBLE.test(reason)) return { kind: "retry", reason };
  return { kind: "refused", reason };
}

export function serverTiming(h: string | null | undefined): Record<string, number> | undefined {
  if (!h) return undefined;
  const out: Record<string, number> = {};
  for (const part of h.split(",")) {
    const m = /^\s*([\w-]+)\s*;\s*dur=([\d.]+)/.exec(part);
    if (m) out[m[1]] = Math.round(Number(m[2]));
  }
  return Object.keys(out).length ? out : undefined;
}

export interface DayCount {
  day: string;
  presses: number;
  ok: number;
  retried: number;
  queued: number;
  failed: number;
  /** failed / presses, 0..1 */
  failureRate: number;
}

export interface WriteHealth {
  days: DayCount[];
  today: DayCount;
  pending: Press[];
  lastFailures: Press[];
  /** failures in the last 24 h (the console's /api/health shows it). */
  failed24h: number;
}

export interface Presses {
  /** Save a press before anything runs; its id. */
  open(p: { action: string; target: string; who: string; via?: string; route: string; request?: PressRequest; clientKey?: string; tenant?: string; ref?: string; due?: boolean; /** due only after this many ms (the undo window) */ holdMs?: number }): string;
  /** take back a press not tried yet (Bring it back): true when it was still waiting, now `undone`. */
  undo(id: string, why: string): boolean;
  /** the presses an answer job carried, taken back with it. */
  undoRef(ref: string, why: string): number;
  /**
   * the press this one repeats while it is still landing: the newest outbox press on the same target, if it is the
   * same route with the same body and not landed yet. A landed press is never returned here (the card may be in review
   * again: a new press writes again); see landedTwin.
   */
  repeatOf(target: string, route: string, body: string): (Press & { response?: unknown }) | undefined;
  /** an earlier press with the same target, route and body that landed within REPEAT_WINDOW_MS of press `id`. */
  landedTwin(id: string): (Press & { response?: unknown }) | undefined;
  /** another press on the same target that landed within SIBLING_WINDOW_MS before now. */
  siblingLanded(id: string): Press | undefined;
  /** how the press was answered (`202` once saved, in `ms`), kept as its first try line. */
  replied(id: string, reply: { status: number; ms: number }): void;
  /** due outbox presses still waiting for an earlier press on the same target (they land in press order). */
  earlierLanding(id: string): boolean;
  /** One try ended (`ms` its time): landed, retry later (outbox presses only), or refused. */
  settle(
    id: string,
    t: {
      verdict: Verdict;
      status: number;
      ms: number;
      steps?: Record<string, number>;
      response?: unknown;
      retry?: boolean;
    },
  ): Press;
  /** Link a press to the answer job that carries it. */
  /** Link a press to the answer job that carries it; `reply` = how the route answered (status, ms), kept as its first try. */
  link(id: string, ref: string, reply?: { status: number; ms: number }): void;
  /** The answer job of `ref` changed state (jobs: pending/running/done/failed). */
  answerJob(
    ref: string,
    j: {
      state: "pending" | "running" | "done" | "failed";
      attempts: number;
      error?: string | null;
      sha?: string | null;
    },
  ): void;
  /**
   * landed presses whose commit the background push could not land (a conflict on origin): back in the outbox,
   * due now, to be written again on the fresh spine. How many went back.
   */
  requeue(ids: string[], why: string): number;
  get(id: string, withResponse?: boolean): Press | undefined;
  byKey(key: string): Press | undefined;
  list(o?: { limit?: number; state?: PressState }): Press[];
  /** Outbox presses whose next try is due now. */
  due(): { id: string; request: PressRequest; tenant?: string; target: string }[];
  health(days?: number): WriteHealth;
}

export function createPresses(db: DB, o: { now?: () => number; retryMs?: number[]; giveUpMs?: number; heldRetryMs?: number } = {}): Presses {
  ensurePresses(db);
  const now = o.now ?? Date.now;
  const retryMs = o.retryMs ?? PRESS_RETRY_MS;
  const giveUpMs = o.giveUpMs ?? PRESS_GIVE_UP_MS;
  const iso = (t = now()) => new Date(t).toISOString();
  const row = (id: string) => db.prepare("SELECT * FROM presses WHERE id = ?").get(id) as Row | undefined;

  /** One press follows the answer job `ref` (see answerJob). */
  function followJob(r: Row, ref: string, j: Parameters<Presses["answerJob"]>[1]): void {
    // the commit that carried the answer (the job's row says it once written)
    if (j.sha === undefined && j.state === "done") {
      try {
        j = {
          ...j,
          sha: (db.prepare("SELECT spine_sha FROM jordi_responses WHERE id = ?").get(ref) as { spine_sha: string | null } | undefined)?.spine_sha ?? null,
        };
      } catch {
        /* no answers table (a bare press log): no sha */
      }
    }
    const total = now() - Date.parse(r.at);
    const tries = parse<PressTry[]>(r.tries, []);
    if (j.state === "done" || j.state === "failed" || (j.state === "pending" && j.error))
      tries.push({
        at: iso(),
        ms: 0,
        status: j.state === "done" ? 200 : 502,
        ...(j.error ? { reason: j.error.slice(0, 300) } : {}),
      });
    const kept = JSON.stringify(tries.slice(-20));
    if (j.state === "done")
      db.prepare(`UPDATE presses SET state = 'landed', result = ?, attempts = ?, tries = ?, landed_at = ?, ms = ?, sha = COALESCE(?, sha), next_at = NULL WHERE id = ?`).run(
        j.attempts > 1 ? "retried" : "ok",
        j.attempts,
        kept,
        iso(),
        total,
        j.sha ?? null,
        r.id,
      );
    else if (j.state === "failed")
      db.prepare(`UPDATE presses SET state = 'failed', result = 'failed', reason = ?, attempts = ?, tries = ?, ms = ?, next_at = NULL WHERE id = ?`).run(
        j.error ?? "the answer job failed",
        j.attempts,
        kept,
        total,
        r.id,
      );
    else db.prepare(`UPDATE presses SET reason = COALESCE(?, reason), attempts = ?, tries = ? WHERE id = ?`).run(j.error ?? null, j.attempts, kept, r.id);
  }

  const self: Presses = {
    open(p) {
      const id = `pr_${randomUUID()}`;
      const at = iso();
      db.prepare(
        `INSERT INTO presses (id, at, action, target, who, via, route, state, result, attempts, tries, request, client_key, tenant_id, ref, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'landing', 'queued', 0, '[]', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        at,
        p.action,
        p.target.slice(0, 300),
        p.who.slice(0, 200),
        p.via ?? null,
        p.route,
        p.request ? JSON.stringify(p.request) : null,
        p.clientKey ?? null,
        p.tenant ?? null,
        p.ref ?? null,
        p.due ? (p.holdMs ? iso(Date.parse(at) + p.holdMs) : at) : null,
      );
      return id;
    },
    undo(id, why) {
      return (
        db.prepare("UPDATE presses SET state = 'undone', result = 'undone', reason = ?, next_at = NULL, ms = ? WHERE id = ? AND state = 'landing' AND attempts = 0").run(why.slice(0, 300), Math.max(0, now() - Date.parse(row(id)?.at ?? iso())), id).changes > 0
      );
    },
    undoRef(ref, why) {
      return db.prepare("UPDATE presses SET state = 'undone', result = 'undone', reason = ?, next_at = NULL WHERE ref = ? AND state = 'landing'").run(why.slice(0, 300), ref).changes;
    },
    repeatOf(target, route, body) {
      const r = db.prepare("SELECT * FROM presses WHERE target = ? AND request IS NOT NULL AND state != 'failed' ORDER BY at DESC, rowid DESC LIMIT 1").get(target.slice(0, 300)) as Row | undefined;
      if (!r || r.route !== route) return undefined;
      if (r.state !== "landing") return undefined;
      if (!sameBody(parse<PressRequest | undefined>(r.request, undefined)?.body, body)) return undefined;
      return toPress(r, true);
    },
    landedTwin(id) {
      const me = row(id);
      if (!me) return undefined;
      const body = parse<PressRequest | undefined>(me.request, undefined)?.body ?? "";
      const since = iso(Date.parse(me.at) - REPEAT_WINDOW_MS);
      const twins = db
        .prepare("SELECT * FROM presses WHERE target = ? AND route = ? AND state = 'landed' AND id != ? AND at <= ? AND landed_at >= ? ORDER BY landed_at DESC LIMIT 5")
        .all(me.target, me.route, id, me.at, since) as Row[];
      const twin = twins.find((t) => sameBody(parse<PressRequest | undefined>(t.request, undefined)?.body, body));
      return twin ? toPress(twin, true) : undefined;
    },
    siblingLanded(id) {
      const me = row(id);
      if (!me) return undefined;
      const r = db
        .prepare("SELECT * FROM presses WHERE target = ? AND state = 'landed' AND id != ? AND request IS NOT NULL AND landed_at >= ? ORDER BY landed_at DESC LIMIT 1")
        .get(me.target, id, iso(now() - SIBLING_WINDOW_MS)) as Row | undefined;
      return r ? toPress(r) : undefined;
    },
    replied(id, reply) {
      const r = row(id);
      if (!r) return;
      const tries = parse<PressTry[]>(r.tries, []);
      tries.push({ at: iso(), ms: reply.ms, status: reply.status, reason: "saved; the worker writes it" });
      db.prepare("UPDATE presses SET tries = ? WHERE id = ?").run(JSON.stringify(tries.slice(-20)), id);
    },
    earlierLanding(id) {
      const r = row(id);
      if (!r) return false;
      return !!db.prepare("SELECT 1 FROM presses WHERE target = ? AND state = 'landing' AND request IS NOT NULL AND id != ? AND (at < ? OR (at = ? AND rowid < (SELECT rowid FROM presses WHERE id = ?))) LIMIT 1").get(r.target, id, r.at, r.at, id);
    },
    settle(id, t) {
      const r = row(id);
      if (!r) throw new Error(`press ${id} not found`);
      const attempts = r.attempts + 1;
      const tries = parse<PressTry[]>(r.tries, []);
      const reason = t.verdict.kind === "landed" ? t.verdict.note : t.verdict.reason;
      tries.push({
        at: iso(),
        ms: t.ms,
        status: t.status,
        ...(reason ? { reason: reason.slice(0, 300) } : {}),
        ...(t.steps ? { steps: t.steps } : {}),
      });
      const kept = tries.slice(-20);
      const total = now() - Date.parse(r.at);
      if (t.verdict.kind === "landed") {
        db.prepare(
          `UPDATE presses SET state = 'landed', result = ?, reason = ?, attempts = ?, tries = ?, next_at = NULL, landed_at = ?, ms = ?, sha = COALESCE(?, sha), http_status = ?, response = ? WHERE id = ?`,
        ).run(
          attempts > 1 ? "retried" : "ok",
          t.verdict.note ?? null,
          attempts,
          JSON.stringify(kept),
          iso(),
          total,
          t.verdict.sha ?? null,
          t.status,
          t.response === undefined ? null : JSON.stringify(t.response).slice(0, 200_000),
          id,
        );
      } else if (t.verdict.kind === "held" && t.retry && total < HELD_GIVE_UP_MS) {
        // kept: the row is flagged to its owner; tried every minute (then every 5) until the row is whole
        const heldAt = r.held_at ?? iso();
        const wait = o.heldRetryMs ?? (now() - Date.parse(heldAt) < HELD_FAST_MS ? HELD_RETRY_MS : HELD_SLOW_MS);
        db.prepare(`UPDATE presses SET state = 'landing', result = 'queued', reason = ?, held = ?, held_at = ?, attempts = ?, tries = ?, next_at = ?, http_status = ? WHERE id = ?`).run(
          t.verdict.reason,
          t.verdict.reason.slice(0, 600),
          heldAt,
          attempts,
          JSON.stringify(kept),
          iso(now() + wait),
          t.status,
          id,
        );
      } else if (t.verdict.kind === "retry" && t.retry && total < giveUpMs) {
        // a kept press (its row being repaired) never waits longer than a kept press would
        const wait = r.held ? Math.min(retryMs[Math.min(attempts - 1, retryMs.length - 1)], HELD_SLOW_MS) : retryMs[Math.min(attempts - 1, retryMs.length - 1)];
        db.prepare(`UPDATE presses SET state = 'landing', result = 'queued', reason = ?, attempts = ?, tries = ?, next_at = ?, http_status = ? WHERE id = ?`).run(
          t.verdict.reason,
          attempts,
          JSON.stringify(kept),
          iso(now() + wait),
          t.status,
          id,
        );
      } else {
        const why =
          (t.verdict.kind === "retry" || t.verdict.kind === "held") && t.retry
            ? `still not landed after ${attempts} tries in ${Math.round(total / 3600_000)} h: ${t.verdict.reason}`
            : t.verdict.reason;
        db.prepare(`UPDATE presses SET state = 'failed', result = 'failed', reason = ?, attempts = ?, tries = ?, next_at = NULL, ms = ?, http_status = ?, response = ? WHERE id = ?`).run(
          attempts > 1 ? `on try ${attempts}: ${why}` : why,
          attempts,
          JSON.stringify(kept),
          total,
          t.status,
          t.response === undefined ? null : JSON.stringify(t.response).slice(0, 200_000),
          id,
        );
      }
      return toPress(row(id)!);
    },
    link(id, ref, reply) {
      const r = row(id);
      const tries = parse<PressTry[]>(r?.tries ?? null, []);
      if (reply) tries.push({ at: iso(), ms: reply.ms, status: reply.status, reason: "saved; the answer job writes it" });
      db.prepare("UPDATE presses SET ref = ?, tries = ? WHERE id = ?").run(ref, JSON.stringify(tries.slice(-20)), id);
    },
    answerJob(ref, j) {
      // every press the job carries (a repeated press of the same answer returns the stored one and follows the same job)
      const all = db.prepare("SELECT * FROM presses WHERE ref = ? AND state = 'landing' ORDER BY at").all(ref) as Row[];
      for (const r of all) followJob(r, ref, j);
    },
    requeue(ids, why) {
      let n = 0;
      for (const id of ids)
        n += db
          .prepare("UPDATE presses SET state = 'landing', result = 'queued', reason = ?, next_at = ?, landed_at = NULL, sha = NULL WHERE id = ? AND state = 'landed' AND request IS NOT NULL")
          .run(why.slice(0, 600), iso(), id).changes;
      return n;
    },
    get: (id, withResponse = false) => {
      const r = row(id);
      return r ? toPress(r, withResponse) : undefined;
    },
    byKey: (key) => {
      const r = db.prepare("SELECT * FROM presses WHERE client_key = ?").get(key) as Row | undefined;
      return r ? toPress(r, true) : undefined;
    },
    list: ({ limit = 50, state } = {}) =>
      (state
        ? (db.prepare("SELECT * FROM presses WHERE state = ? ORDER BY at DESC LIMIT ?").all(state, Math.min(limit, 500)) as Row[])
        : (db.prepare("SELECT * FROM presses ORDER BY at DESC LIMIT ?").all(Math.min(limit, 500)) as Row[])
      ).map((r) => toPress(r)),
    due: () =>
      (
        db.prepare("SELECT id, request, tenant_id, target FROM presses WHERE state = 'landing' AND request IS NOT NULL AND next_at IS NOT NULL AND next_at <= ? ORDER BY at, rowid").all(iso()) as {
          id: string;
          request: string;
          tenant_id: string | null;
          target: string;
        }[]
      )
        .map((r) => ({
          id: r.id,
          target: r.target,
          request: parse<PressRequest | undefined>(r.request, undefined),
          ...(r.tenant_id ? { tenant: r.tenant_id } : {}),
        }))
        .filter((r): r is { id: string; request: PressRequest; tenant?: string; target: string } => !!r.request),
    health(days = 14) {
      const since = iso(now() - days * 86_400_000).slice(0, 10);
      const rows = db
        .prepare(
          `SELECT substr(at, 1, 10) AS day, COUNT(*) AS presses, SUM(result = 'ok') AS ok, SUM(result = 'retried') AS retried, SUM(result = 'queued') AS queued, SUM(result = 'failed') AS failed FROM presses WHERE substr(at, 1, 10) >= ? GROUP BY day ORDER BY day DESC`,
        )
        .all(since) as Omit<DayCount, "failureRate">[];
      const withRate = (d: Omit<DayCount, "failureRate">): DayCount => ({
        ...d,
        ok: d.ok ?? 0,
        retried: d.retried ?? 0,
        queued: d.queued ?? 0,
        failed: d.failed ?? 0,
        failureRate: d.presses ? Math.round(((d.failed ?? 0) / d.presses) * 1000) / 1000 : 0,
      });
      const list = rows.map(withRate);
      const todayKey = iso().slice(0, 10);
      const today = list.find((d) => d.day === todayKey) ?? {
        day: todayKey,
        presses: 0,
        ok: 0,
        retried: 0,
        queued: 0,
        failed: 0,
        failureRate: 0,
      };
      const failed24h = (db.prepare("SELECT COUNT(*) AS n FROM presses WHERE result = 'failed' AND at >= ?").get(iso(now() - 86_400_000)) as { n: number }).n;
      return {
        days: list,
        today,
        pending: (db.prepare("SELECT * FROM presses WHERE state = 'landing' ORDER BY at DESC LIMIT 50").all() as Row[]).map((r) => toPress(r)),
        lastFailures: (db.prepare("SELECT * FROM presses WHERE state = 'failed' ORDER BY at DESC LIMIT 20").all() as Row[]).map((r) => toPress(r)),
        failed24h,
      };
    },
  };
  return self;
}

/**
 * the row a review card was on, read from the answer of a press on it that landed (a review card's press answers
 * with the card, its repo, path and ref): for a card whose row left review before his words were pressed.
 */
export function cardFromPresses(db: DB, id: string): { repo: string; path: string; ref: string; title?: string; milestoneId?: string } | undefined {
  let rows: { response: string | null }[];
  try {
    rows = db.prepare("SELECT response FROM presses WHERE target = ? AND state = 'landed' AND response IS NOT NULL ORDER BY at DESC LIMIT 20").all(id) as { response: string | null }[];
  } catch {
    return undefined;
  }
  for (const r of rows) {
    let it: Record<string, unknown> | undefined;
    try {
      it = JSON.parse(r.response ?? "") as Record<string, unknown>;
    } catch {
      continue;
    }
    const s = (k: string) => (typeof it?.[k] === "string" && it[k] ? (it[k] as string) : undefined);
    const repo = s("repo"), path = s("path"), ref = s("ref");
    if (repo && path && ref) return { repo, path, ref, ...(s("title") ? { title: s("title") } : {}), ...(s("milestoneId") ? { milestoneId: s("milestoneId") } : {}) };
  }
  return undefined;
}
