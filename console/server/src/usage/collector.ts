import { type ExecFileException } from "node:child_process";
import { execFile } from "../spawnHost.js";
import fs from "node:fs";
import type { DB } from "../db.js";
import { costUsd, DEFAULT_PRICES, type PriceTable, type TokenCounts } from "./prices.js";
import { type HostId, mainHost, workerHost } from "../identity.js";

/**
 * tokens used per wake. When a run ends (and in a periodic sweep) the console finds the run's Claude Code
 * transcript on the host its persona runs on (the main server here; the worker server over ssh, deferred while the worker server is asleep), sums the usage
 * per model with scripts/run_usage.py (which prints numbers only, never message text) and stores it on `runs.usage`.
 * A run without a thread (a skipped / parked wake) whose transcript is not found gets zeros.
 * read 1 min after the run ends (provisional, `final: false`) and again at 5 min (final; credits debit only final
 * usage); runs still working get their tokens so far in `runs.usage_live` every 2 min (never final, never debited); every
 * seat dir on the host is scanned and `seat` names the config dir the tokens came from (the run row's seat can be wrong).
 */
export type UsageHost = HostId;

export interface ModelUsage extends TokenCounts {
  turns: number;
}
export interface RunUsage extends ModelUsage {
  /** The model with the most tokens (several when a run used more than one: see byModel). */
  model: string;
  /** API list-price estimate (seats are subscriptions): always an estimate. */
  costUsd: number | null;
  estimate: true;
  collectedAt: string;
  /** Where the numbers came from: `claude-code:<host>` (transcripts), `no-thread` (a skipped wake: zeros), or `no-turn`
   * (the run had a thread but never got a turn: skipped as unchanged, host down, persona never woke: zeros), or
   * `same-as:<run>` (a second row for a worker counted on <run>: zeros). */
  source: string;
  /** the seat (Claude config dir) most tokens came from: `seat3`, `default` (~/.claude). */
  seat?: string;
  /** the config dirs the scan read on that host. */
  dirs?: string[];
  /** run_usage.py's SCAN_VERSION (matching rules); older reads in the last 7 days are re-read at boot. */
  scan?: number;
  /** false = read 1 min after the run ended, re-read at 5 min; absent (older rows) or true = final. */
  final?: boolean;
  /** tokens so far of a run still working (`runs.usage_live`); never stored as final usage. */
  live?: boolean;
  byModel: Record<string, ModelUsage & { costUsd: number | null }>;
}

/** What run_usage.py prints per run id: null = no transcript line belongs to that run (plus `_meta`: dirs read). */
/** sameAs: a second run row for the same worker session (counted on that run; this one is 0). */
export type ScanEntry = { models: Record<string, ModelUsage>; files: number; seat?: string | null; sameAs?: string };
export type ScanResult = Record<string, ScanEntry | null> & { _meta?: { dirs: string[]; scan?: number } };

/** The host could not be read now (asleep, unreachable, not configured): retry later, nothing recorded as missing. */
export class HostUnavailable extends Error {}

export interface Scanner {
  scan(host: UsageHost, runs: { id: string; since: number; thread?: string | null }[]): Promise<ScanResult>;
}

export interface UsageOptions {
  scanner?: Scanner;
  prices?: PriceTable;
  /** Wait this long after a run ends before the first (provisional) read. Default 1 min. */
  settleMs?: number;
  /** Re-read a provisional run this long after it ended (its last reply is written after the finishing PATCH) and mark it
   * final. Default 5 min. */
  finalMs?: number;
  /** Runs still working that started longer ago than this get no live reads. Default 12 h. */
  liveMaxAgeMs?: number;
  /** A run whose transcript was missing or whose host was asleep is looked at again after this long. Default 10 min. */
  retryMs?: number;
  /** Runs that ended longer ago than this are not collected any more. Default 7 days. */
  maxAgeMs?: number;
  /** Max runs per host per sweep. Default 100. */
  batch?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** told which runs got usage in a pass (credits debit them at their provider's price). */
  onCollected?: (runIds: string[]) => void;
}

interface PendingRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  thread_id: string | null;
  host: string | null;
  summary: string | null;
  outcome: string | null;
  usage: string | null;
}

/**
 * a run with a thread but no transcript that never got a turn: the console wrote its summary itself (skipped as
 * unchanged, the host was down, the persona never woke and the turn failed). Counted as 0 tokens, not as missing.
 */
export function neverRan(r: { summary: string | null; outcome: string | null }): boolean {
  const s = r.summary ?? "";
  if (/^skipped: /.test(s)) return true;
  if (/^Run now failed: /.test(s)) return true;
  return r.outcome === "failed" && /^(Run now|Cadence wake)\b[^:]*: waiting for the persona to wake/.test(s) && !/timed out/.test(s);
}

const ZERO = (): ModelUsage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 });

/** Sum a scan entry into the stored shape (prices per model; unknown model = no cost). */
export function toRunUsage(
  entry: { models: Record<string, ModelUsage>; seat?: string | null } | null,
  source: string,
  collectedAt: string,
  prices: PriceTable = DEFAULT_PRICES,
  extra: Pick<RunUsage, "dirs" | "scan" | "final" | "live"> = {},
): RunUsage {
  const total = ZERO();
  const byModel: RunUsage["byModel"] = {};
  let cost: number | null = 0;
  let top = "";
  let topTokens = -1;
  for (const [model, u] of Object.entries(entry?.models ?? {})) {
    const c = costUsd(model, u, prices);
    byModel[model] = { ...u, costUsd: c === undefined ? null : round6(c) };
    if (c === undefined) cost = null;
    else if (cost !== null) cost += c;
    for (const k of ["input", "cacheWrite", "cacheRead", "output", "turns"] as const) total[k] += u[k];
    const tokens = u.input + u.cacheWrite + u.cacheRead + u.output;
    if (tokens > topTokens) [top, topTokens] = [model, tokens];
  }
  return {
    model: top,
    ...total,
    costUsd: cost === null ? null : round6(cost),
    estimate: true,
    collectedAt,
    source,
    ...(entry?.seat ? { seat: entry.seat } : {}),
    ...extra,
    byModel,
  };
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function parseUsage(text: string | null | undefined): RunUsage | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as RunUsage;
  } catch {
    return undefined;
  }
}

export function createUsageCollector(db: DB, o: UsageOptions = {}) {
  const scanner = o.scanner;
  const prices = o.prices ?? DEFAULT_PRICES;
  const settleMs = o.settleMs ?? 60_000;
  const finalMs = Math.max(o.finalMs ?? 5 * 60_000, settleMs);
  const retryMs = o.retryMs ?? 10 * 60_000;
  const maxAgeMs = o.maxAgeMs ?? 7 * 24 * 3600_000;
  const liveMaxAgeMs = o.liveMaxAgeMs ?? 12 * 3600_000;
  const batch = o.batch ?? 100;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const iso = (ms: number) => new Date(ms).toISOString();
  const host = (r: PendingRow): UsageHost => (r.host === workerHost() ? workerHost() : mainHost());
  const since = (r: PendingRow) => Math.floor(Date.parse(r.started_at) / 1000) - 60;
  // where the thread actually ran (launch_host: the worker server at its cap -> the main server), else the persona's host.
  const HOST = `COALESCE(r.launch_host, p.host, (SELECT p2.host FROM assignments a JOIN personas p2 ON p2.id = a.persona_id WHERE a.id = r.assignment_id)) AS host`;

  /**
   * Ended wake runs (wakes, run-now, children, bootstrap; not answer runs) due for a look: no usage yet (settled, not
   * looked at within retryMs), or provisional usage whose final read is due.
   */
  const pending = (ids?: string[]): PendingRow[] => {
    const t = now();
    const rows = db
      .prepare(
        `SELECT r.id, r.started_at, r.ended_at, r.thread_id, r.summary, r.outcome, r.usage, ${HOST}
           FROM runs r LEFT JOIN personas p ON p.id = r.persona_id
          WHERE r.ended_at IS NOT NULL AND r.kind = 'wake' AND r.ended_at >= @oldest
            ${ids ? "AND r.id IN (SELECT value FROM json_each(@ids)) -- a run's own 1- and 5-min reads look it up by key, not a scan of every run" : ""}
            AND ((r.usage IS NULL AND r.ended_at <= @settled
                  AND (r.usage_checked_at IS NULL OR r.usage_checked_at <= @retry
                    -- missing at the 1-min read: look again once the final read is due
                    OR (r.ended_at <= @final AND r.usage_checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', r.ended_at, @finalOffset))))
              OR (r.usage IS NOT NULL AND json_extract(r.usage, '$.final') = 0 AND r.ended_at <= @final))
          ORDER BY r.ended_at DESC`,
      )
      .all({
        settled: iso(t - settleMs),
        final: iso(t - finalMs),
        finalOffset: `+${Math.round(finalMs / 1000)} seconds`,
        oldest: iso(t - maxAgeMs),
        retry: iso(t - retryMs),
        ...(ids ? { ids: JSON.stringify(ids) } : {}),
      }) as PendingRow[];
    return rows;
  };

  const setUsage = db.prepare(`UPDATE runs SET usage = @usage, usage_live = NULL, usage_checked_at = @at, usage_note = NULL WHERE id = @id`);
  const setNote = db.prepare(`UPDATE runs SET usage_checked_at = @at, usage_note = @note WHERE id = @id`);
  const markFinal = db.prepare(`UPDATE runs SET usage = json_set(usage, '$.final', json('true')), usage_checked_at = @at WHERE id = @id`);
  const setLive = db.prepare(`UPDATE runs SET usage_live = @usage WHERE id = @id AND ended_at IS NULL`);

  let running: Promise<{ collected: string[]; missing: string[]; deferred: string[] }> | undefined;

  /** One pass: every due run (or only `ids`), one scan per host. Never throws; concurrent callers share the pass. */
  function collect(ids?: string[]) {
    if (running) return running;
    running = (async () => {
      const out = { collected: [] as string[], missing: [] as string[], deferred: [] as string[] };
      if (!scanner) return out;
      const byHost = new Map<UsageHost, PendingRow[]>();
      for (const r of pending(ids)) {
        const list = byHost.get(host(r)) ?? [];
        if (list.length < batch) list.push(r);
        byHost.set(host(r), list);
      }
      const finals: string[] = [];
      for (const [h, rows] of byHost) {
        const at = iso(now());
        let result: ScanResult;
        try {
          result = await scanner.scan(h, rows.map((r) => ({ id: r.id, since: since(r), thread: r.thread_id })));
        } catch (e) {
          const why = e instanceof HostUnavailable ? `deferred: ${h} ${e.message}` : `error: ${(e as Error).message}`.slice(0, 300);
          if (!(e instanceof HostUnavailable)) log(`usage scan on ${h} failed: ${(e as Error).message}`);
          for (const r of rows) if (!r.usage) setNote.run({ id: r.id, at, note: why });
          out.deferred.push(...rows.map((r) => r.id));
          continue;
        }
        const dirs = result._meta?.dirs;
        const scan = result._meta?.scan;
        for (const r of rows) {
          const entry = result[r.id];
          // Final once the run ended finalMs ago; a 1-min read is provisional and read again.
          const final = Date.parse(r.ended_at!) <= now() - finalMs;
          if (entry) {
            const source = entry.sameAs ? `same-as:${entry.sameAs}` : `claude-code:${h}`;
            setUsage.run({ id: r.id, at, usage: JSON.stringify(toRunUsage(entry, source, at, prices, { dirs, scan, final })) });
            out.collected.push(r.id);
            if (final) finals.push(r.id);
          } else if (r.usage) {
            // provisional usage, nothing found on the re-read (file rotated?): keep it, now final
            markFinal.run({ id: r.id, at });
            out.collected.push(r.id);
            finals.push(r.id);
          } else if (!r.thread_id || neverRan(r)) {
            setUsage.run({ id: r.id, at, usage: JSON.stringify(toRunUsage(null, r.thread_id ? "no-turn" : "no-thread", at, prices, { dirs, scan })) });
            out.collected.push(r.id);
            finals.push(r.id);
          } else {
            setNote.run({ id: r.id, at, note: `missing: no transcript on ${h} names this run` });
            out.missing.push(r.id);
          }
        }
      }
      if (finals.length && o.onCollected) {
        try {
          o.onCollected(finals);
        } catch (e) {
          log(`usage onCollected: ${(e as Error).message}`);
        }
      }
      return out;
    })().finally(() => (running = undefined));
    return running;
  }

  let liveRunning: Promise<string[]> | undefined;
  /** tokens so far of runs still working (with a thread, started within liveMaxAgeMs) into `runs.usage_live`. */
  function collectLive() {
    if (liveRunning) return liveRunning;
    liveRunning = (async () => {
      const done: string[] = [];
      if (!scanner) return done;
      const rows = db
        .prepare(
          `SELECT r.id, r.started_at, r.ended_at, r.thread_id, r.summary, r.outcome, r.usage, ${HOST}
             FROM runs r LEFT JOIN personas p ON p.id = r.persona_id
            WHERE r.ended_at IS NULL AND r.kind = 'wake' AND r.thread_id IS NOT NULL AND r.started_at >= ?
            ORDER BY r.started_at DESC`,
        )
        .all(iso(now() - liveMaxAgeMs)) as PendingRow[];
      const byHost = new Map<UsageHost, PendingRow[]>();
      for (const r of rows) {
        const list = byHost.get(host(r)) ?? [];
        if (list.length < batch) list.push(r);
        byHost.set(host(r), list);
      }
      for (const [h, list] of byHost) {
        let result: ScanResult;
        try {
          result = await scanner.scan(h, list.map((r) => ({ id: r.id, since: since(r), thread: r.thread_id })));
        } catch (e) {
          if (!(e instanceof HostUnavailable)) log(`usage live scan on ${h} failed: ${(e as Error).message}`);
          continue;
        }
        const at = iso(now());
        for (const r of list) {
          const entry = result[r.id];
          if (!entry) continue;
          setLive.run({ id: r.id, usage: JSON.stringify(toRunUsage(entry, `claude-code:${h}`, at, prices, { dirs: result._meta?.dirs, scan: result._meta?.scan, final: false, live: true })) });
          done.push(r.id);
        }
      }
      return done;
    })().finally(() => (liveRunning = undefined));
    return liveRunning;
  }

  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    t.unref();
  };
  return {
    collect,
    collectLive,
    /** A run ended: read it once its first reply has settled (settleMs, provisional), and again at finalMs (final). */
    runEnded(runId: string) {
      later(settleMs + 1_000, () => void collect([runId]).catch(() => undefined));
      if (finalMs > settleMs) later(finalMs + 1_000, () => void collect([runId]).catch(() => undefined));
    },
    /** Periodic sweep for ended runs without usage (also retries missing / deferred ones, and finalizes provisional ones);
     * liveEveryMs: the live read of running runs (0 = off). */
    start(everyMs: number, liveEveryMs = 0) {
      const tick = () => void collect().catch((e) => log(`usage sweep: ${(e as Error).message}`));
      const a = setTimeout(tick, 30_000);
      const b = setInterval(tick, everyMs);
      a.unref();
      b.unref();
      timers.push(a, b);
      if (liveEveryMs > 0) {
        const c = setInterval(() => void collectLive().catch((e) => log(`usage live: ${(e as Error).message}`)), liveEveryMs);
        c.unref();
        timers.push(c);
      }
    },
    stop() {
      timers.forEach((t) => clearTimeout(t));
    },
  };
}
export type UsageCollector = ReturnType<typeof createUsageCollector>;

// ---------- the real scanner: run_usage.py here, or over ssh on the worker server ----------

export interface RealScannerOptions {
  /** Path of scripts/run_usage.py. */
  script: string;
  /** Claude config dirs to read (`~` allowed; expanded by the script on the host it runs on); [] = all seat dirs. */
  dirs: string[];
  /** the worker server ssh (the console's existing host access); unset = the worker server runs are deferred. */
  worker?: { ssh: string; sshKey?: string; knownHosts: string };
  python?: string;
  timeoutMs?: number;
  /** the sandboxed worlds' root on the host (its `.logs/<world>/<run>.jsonl` are job transcripts); unset = not read. */
  worldLogs?: string;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function realScanner(o: RealScannerOptions): Scanner {
  const timeout = o.timeoutMs ?? 240_000;
  return {
    scan(host, runs) {
      // no dirs = every ~/.claude and ~/.claude_seat* dir on that host (run_usage.py discovers them).
      const req = JSON.stringify({ runs, dirs: o.dirs, ...(o.worldLogs ? { worldLogs: o.worldLogs } : {}) });
      return new Promise<ScanResult>((resolve, reject) => {
        const done = (err: ExecFileException | null, stdout: string, stderr: string) => {
          if (err) {
            // ssh exits 255 when it cannot connect: the box is asleep or unreachable, try again later.
            if (host === workerHost() && (err.code === 255 || err.killed))
              return reject(new HostUnavailable(err.killed ? "ssh timed out" : String(stderr).trim().split("\n").pop() || "unreachable"));
            return reject(new Error(String(stderr).trim().split("\n").pop() || err.message));
          }
          try {
            resolve(JSON.parse(stdout) as ScanResult);
          } catch (e) {
            reject(new Error(`run_usage.py output: ${(e as Error).message}`));
          }
        };
        if (host === mainHost()) {
          execFile(o.python ?? "python3", ["-I", o.script, req], { timeout, maxBuffer: 4 << 20, encoding: "utf8" }, done);
          return;
        }
        if (!o.worker) return reject(new HostUnavailable("not configured (CONSOLE_VPS3_SSH unset)"));
        const args = [
          "-o", "BatchMode=yes",
          "-o", "ConnectTimeout=10",
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", `UserKnownHostsFile=${o.worker.knownHosts}`,
          ...(o.worker.sshKey ? ["-i", o.worker.sshKey] : []),
          o.worker.ssh,
          `python3 -I - ${shq(req)}`,
        ];
        const child = execFile("ssh", args, { timeout, maxBuffer: 4 << 20, encoding: "utf8" }, done);
        child.stdin?.end(fs.readFileSync(o.script));
      });
    },
  };
}
