import fs from "node:fs";
import path from "node:path";
import { mainHost } from "../identity.js";

/**
 * at most one new agent session on the main server every `gapMs` (default 90 s). the main server's agent
 * slice has 1.5 cores, and a Claude session start costs a burst of CPU: 8 starts within 2 min after one console deploy
 * (02:30 CET 2026-11-03, every live repo desk got its `[repo-desk update]` at once) pinned the slice and put load1 > 8.
 * The S9 cap counts turns in flight, so those 8 passed it with 0 deferrals.
 *
 * Every automated the main server start (a wake's send or pick, a re-send, a console worker, a desk's endpoint update, delivery
 * note or queued send) `take`s the gate first: closed = it waits (a wake is deferred until the gate opens, a desk
 * update waits for the next desk tick). the owner's own sends never wait but `mark` the gate, so the next automated start
 * keeps its distance. The last start is kept in `file`, so after a console restart the queued starts still go out one
 * per gap. gapMs <= 0 = off (env CONSOLE_SESSION_START_GAP_MS=0 is the rollback switch).
 */
export const SESSION_START_GAP_MS = 90_000;

export type StartTake = { ok: true; token: number } | { ok: false; waitMs: number; lastAgoMs: number; reason: string };

export interface StartGate {
  readonly gapMs: number;
  /** Claim the next the main server start for `what` (logged); closed = how long until it opens and the refusal reason. */
  take(what: string): StartTake;
  /** The start did not happen (the pick was refused, the send failed): give the slot back if nobody took one since. */
  cancel(token: number): void;
  /** A start that does not wait (the owner's own message) still counts. */
  mark(what: string): void;
  /** ms until the gate opens (0 = open). */
  waitMs(): number;
}

/** `session start gap on the main server: last start 30 s ago (gap 90 s)`: read by cycle/capRefusal.ts (kind sessions, retryable). */
export const gapReason = (lastAgoMs: number, gapMs: number) =>
  `session start gap on ${mainHost()}: last start ${Math.max(0, Math.round(lastAgoMs / 1000))} s ago (gap ${Math.round(gapMs / 1000)} s)`;

export function createStartGate(o: { gapMs?: number; file?: string; now?: () => number; log?: (m: string) => void } = {}): StartGate {
  const gapMs = o.gapMs ?? 0;
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? ((m: string) => console.log(m));
  let last = 0;
  let prev = 0;
  let seq = 0;
  if (o.file && gapMs > 0)
    try {
      const at = Number(JSON.parse(fs.readFileSync(o.file, "utf8")).at);
      if (Number.isFinite(at) && at <= now()) last = at;
    } catch {
      /* none yet */
    }
  const save = () => {
    if (!o.file) return;
    try {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      fs.writeFileSync(`${o.file}.tmp`, JSON.stringify({ at: last }));
      fs.renameSync(`${o.file}.tmp`, o.file);
    } catch {
      /* the in-memory gate still holds */
    }
  };
  const waitMs = () => (gapMs > 0 && last ? Math.max(0, last + gapMs - now()) : 0);
  return {
    gapMs,
    waitMs,
    take(what) {
      if (gapMs <= 0) return { ok: true, token: 0 };
      const w = waitMs();
      if (w > 0) return { ok: false, waitMs: w, lastAgoMs: now() - last, reason: gapReason(now() - last, gapMs) };
      const ago = last ? Math.round((now() - last) / 1000) : undefined;
      prev = last;
      last = now();
      save();
      log(`session start gate: ${mainHost()} start ${what}${ago !== undefined ? ` (previous ${ago} s ago)` : ""}, next not before ${new Date(last + gapMs).toISOString().slice(11, 19)}Z`);
      return { ok: true, token: ++seq };
    },
    cancel(token) {
      if (!token || token !== seq) return;
      last = prev;
      seq++;
      save();
      log(`session start gate: ${mainHost()} start given back (did not happen)`);
    },
    mark(what) {
      if (gapMs <= 0) return;
      prev = last;
      last = now();
      seq++;
      save();
      log(`session start gate: ${mainHost()} start ${what} (not gated), next not before ${new Date(last + gapMs).toISOString().slice(11, 19)}Z`);
    },
  };
}

/** The gate that never closes (tests, staging, CONSOLE_SESSION_START_GAP_MS=0). */
export const openGate: StartGate = createStartGate({ gapMs: 0 });
