import { type HostId } from "../identity.js";
/**
 * what a null dispatcher pick means, in the owner's words. The dispatchers refuse with a reason string (a stable,
 * tested contract: m0/broker/broker.py and the infra repo provision/the worker server-dispatcher.py):
 *   "high load on <host>: load5 <x> on <n> CPUs (cap <c>)"        host CPU gate (the worker server, the main server)
 *   "low memory on <host>: <n> MB available (floor <f>)"          host memory floor
 *   "session cap on <host>: <n> live (cap <c>)"                  the infra repo S9 agent-session cap on the main server
 *   "session start gap on the main server: last start <n> s ago (gap <g> s)"  one new the main server session per gap (cycle/startGate.ts)
 *   "team worker ceiling <n> reached (<m> open)"                 team ceiling
 *   "no seat: seat1 …; seat2 …" / "all seats busy or maxed"      every seat busy, maxed or logged out
 *   "the worker server dispatcher unreachable: …" / "central dispatcher on the main server unreachable"
 *   "no credits" / "paused" / a providers-registry error          not something a retry fixes
 * the dispatchers now also send `retryable` + `retry_after_s` (same classes as below) and, from the worker server client,
 * `fallback: "console"`; the reason text is unchanged, so this parser stays the console's one reading of it.
 * the console no longer acts on `fallback: "console"` (its worker route refuses unless CONSOLE_CAP_FALLBACK=1).
 * A host cap (load or memory) is `load-cap, will retry`; the worker server cap tries the main server only under that override; every refusal but
 * the final ones defers the wake (one run row, outcome `deferred`) and is retried with backoff, never a red Failed.
 */
export type CapHost = HostId;
export type RefusalKind = "load" | "memory" | "sessions" | "seats" | "ceiling" | "unreachable" | "final";
export interface Refusal {
  kind: RefusalKind;
  host?: CapHost;
  /** the short human phrase, e.g. `load-cap on the worker server (load5 25.5 / cap 16)` */
  text: string;
  /** the dispatcher's own reason, verbatim */
  reason: string;
  retryable: boolean;
}

const LOAD = /high load on ([A-Za-z0-9_.-]+): load5 ([\d.]+) on (\d+) CPUs \(cap ([\d.]+)\)/;
const MEM = /low memory on ([A-Za-z0-9_.-]+): (-?\d+) MB available \(floor (\d+)\)/;
const SESSIONS = /session cap on ([A-Za-z0-9_.-]+): (\d+) live \(cap (\d+)\)/;
const CEILING = /team worker ceiling (\d+) reached \((\d+) open\)/;
const GAP = /session start gap on ([A-Za-z0-9_.-]+): last start (\d+) s ago \(gap (\d+) s\)/;

export function classifyRefusal(reason: string): Refusal {
  const r = reason.trim();
  let m = LOAD.exec(r);
  if (m) return { kind: "load", host: m[1] as CapHost, text: `load-cap on ${m[1]} (load5 ${m[2]} / cap ${m[4]})`, reason: r, retryable: true };
  if ((m = MEM.exec(r)))
    return { kind: "memory", host: m[1] as CapHost, text: `load-cap on ${m[1]} (memory ${m[2]} MB / floor ${m[3]})`, reason: r, retryable: true };
  if ((m = SESSIONS.exec(r)))
    return { kind: "sessions", host: m[1] as CapHost, text: `session-cap on ${m[1]} (${m[2]} live / cap ${m[3]})`, reason: r, retryable: true };
  if ((m = GAP.exec(r)))
    return { kind: "sessions", host: m[1] as CapHost, text: `session-start gap on ${m[1]} (last start ${m[2]} s ago / gap ${m[3]} s)`, reason: r, retryable: true };
  if ((m = CEILING.exec(r))) return { kind: "ceiling", text: `team ceiling reached (${m[2]} of ${m[1]} workers open)`, reason: r, retryable: true };
  if (/unreachable/i.test(r)) return { kind: "unreachable", text: `dispatcher unreachable (${r})`, reason: r, retryable: true };
  if (/^no seat:/i.test(r)) return { kind: "seats", text: `all seats busy (${r.replace(/^no seat:\s*/i, "")})`, reason: r, retryable: true };
  if (/^no seat\b|all seats busy|maxed/i.test(r)) return { kind: "seats", text: r, reason: r, retryable: true };
  return { kind: "final", text: r || "no seat", reason: r, retryable: false };
}

export const isHostCap = (r: Refusal) => r.kind === "load" || r.kind === "memory" || r.kind === "sessions";

/**
 * The run summary of a deferred wake. One host cap: `load-cap on the worker server (load5 25.5 / cap 16), will retry`; the worker server capped
 * and the main server fallback refused too: `load-cap on the worker server (…); the main server: load-cap (…), will retry`.
 */
export function refusalText(rs: Refusal[]): string {
  const [first, ...rest] = rs;
  const head = first?.text ?? "no seat";
  const tail = rest.map((r) => (r.host ? `${r.host}: ${r.text.replace(` on ${r.host}`, "")}` : r.text));
  const all = [head, ...tail].join("; ");
  return rs.every((r) => r.retryable) ? `${all}, will retry` : all;
}

/** Backoff between attempts of a deferred wake: 1, 2, 4, 8, then every 10 min. */
export function deferDelayMs(attempts: number): number {
  return Math.min(10, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

/** A deferred wake gives up (failed, with the reason) after this long. */
export const DEFER_MAX_MS = 60 * 60_000;

/** The state a deferred run carries (runs.deferred, JSON). */
export interface Deferral {
  /** what refused the last attempt (refusalText) */
  reason: string;
  /** the host the wake was meant for (the persona's) */
  host: CapHost;
  /** attempts so far (the first refusal is 1) */
  attempts: number;
  firstAt: string;
  nextAt: string;
}

/**
 * `retryInMs` (the session start gate's wait) replaces the backoff: a wake held only by the start gap tries again
 * when the gate opens, not 2-10 min later; several such wakes then start one per gap.
 */
export function nextDeferral(prev: Deferral | undefined, reason: string, host: CapHost, now = Date.now(), retryInMs?: number): Deferral {
  const attempts = (prev?.attempts ?? 0) + 1;
  return {
    reason,
    host,
    attempts,
    firstAt: prev?.firstAt ?? new Date(now).toISOString(),
    nextAt: new Date(now + (retryInMs ?? deferDelayMs(attempts))).toISOString(),
  };
}

/** the refusal is the session start gap (cycle/startGate.ts), not a cap. */
export const isStartGap = (reason: string) => GAP.test(reason) || /session-start gap on [A-Za-z0-9_.-]+ \(/.test(reason);

/** `Deferred: <reason> (attempt n, next 16:42Z)`: the run summary while it waits. */
export function deferredSummary(d: Deferral): string {
  return `Deferred: ${d.reason} (attempt ${d.attempts}, next try ${d.nextAt.slice(11, 16)}Z)`;
}
