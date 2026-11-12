import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";

/**
 * the watching for job servers. `box/provision.py` on the main server keeps its records
 * as files in the console's home dir (JOB_STATE_DIR, default the console dir):
 *   job-status.json   one status line per customer (the customer's status line, our admin page)
 *   job-alerts.jsonl  alerts for the owner (job-outlived: a server outlived the sweep; job-fails: a customer's jobs failed 3
 *                     times in a row; job-spend: the daily total passed its limit), each written once
 *   job-spend.json    the daily spend total of job servers
 * Each tick sends every alert line written since this console started (and in the last 30 min) once, through the
 * WhatsApp notifier's `alert` (its caps apply: one per kind per 12 h, three a day; production only). GET
 * /api/job-servers is the admin page's data: every customer's status line, today's spend, the recent alerts.
 */
export const JOB_ALERT_FRESH_MS = 30 * 60_000;

export interface JobAlert {
  id: string;
  at: string;
  kind: string;
  text: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readAlerts(path: string): JobAlert[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: JobAlert[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as JobAlert;
      if (a && typeof a.id === "string" && typeof a.text === "string" && typeof a.kind === "string") out.push(a);
    } catch {
      /* a half-written last line: next tick */
    }
  }
  return out;
}

export function createJobServers(o: { dir: string; now?: () => number; log?: (m: string) => void; alert?: (kind: string, text: string) => void }) {
  const now = () => o.now?.() ?? Date.now();
  const startedAt = now();
  const sent = new Set<string>();
  let checkedAt: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const file = (n: string) => join(o.dir, n);

  function tick() {
    const t = now();
    for (const a of readAlerts(file("job-alerts.jsonl"))) {
      if (sent.has(a.id)) continue;
      const at = Date.parse(a.at);
      sent.add(a.id);
      if (!Number.isFinite(at) || at < startedAt - JOB_ALERT_FRESH_MS || at < t - JOB_ALERT_FRESH_MS) continue;
      o.log?.(`job servers ALERT ${a.kind}: ${a.text}`);
      o.alert?.(a.kind, `EpicTeam job servers: ${a.text}`);
    }
    checkedAt = new Date(t).toISOString();
    return view();
  }

  function view() {
    const status = readJson<Record<string, { state?: string; line?: string; at?: string; fails_in_row?: number }>>(file("job-status.json"), {});
    const spend = readJson<{ days?: Record<string, { eur: number; servers: number; limit_eur: number }> }>(file("job-spend.json"), {});
    const days = spend.days ?? {};
    const today = Object.keys(days).sort().pop();
    const customers = Object.entries(status).map(([customer, s]) => ({ customer, state: s.state ?? "unknown", line: s.line ?? "", at: s.at ?? null, failsInRow: s.fails_in_row ?? 0 }));
    return {
      customers,
      spend: today ? { day: today, ...days[today] } : null,
      alerts: readAlerts(file("job-alerts.jsonl")).slice(-10).reverse(),
      checkedAt: checkedAt ?? null,
    };
  }

  function health() {
    const v = view();
    const failing = v.customers.filter((c) => c.state === "failed").map((c) => c.customer);
    return { state: timer ? (failing.length ? "alert" : "ok") : "off", customers: v.customers.length, failing, spendToday: v.spend?.eur ?? null };
  }

  return {
    tick,
    view,
    health,
    start(everyMs: number) {
      if (timer || !everyMs) return;
      timer = setInterval(tick, everyMs);
      timer.unref?.();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type JobServers = ReturnType<typeof createJobServers>;

export function mountJobServers(api: Hono, get: () => JobServers | undefined) {
  api.get("/job-servers", (c) => {
    const j = get();
    return j ? c.json({ ok: true, ...j.view() }) : c.json({ ok: false, error: "off" }, 404);
  });
}
