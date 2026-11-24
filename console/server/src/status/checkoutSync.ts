import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { GitOut } from "../freshness.js";
import { headBranch, headSha, originMainSha } from "../gitRefs.js";

/**
 * A console checkout whose main is ahead of or behind
 * origin/main stops every spine write ("local main is diverged") and every pull, and until now nobody heard about it
 * (the main server 2026-11-03 07:54Z to 09:35Z: one unpushed console commit). Each tick compares every tracked checkout's HEAD with
 * its origin/main (local refs only: the console's pullers fetch); a checkout out of sync for more than `afterMs`
 * (5 min) raises one alert per episode: a log line, `alert` (WhatsApp in production) and /api/health. Back in sync
 * clears it.
 */
export interface CheckoutSyncState {
  dir: string;
  repo: string;
  branch: string;
  ahead: number;
  behind: number;
  /** When it was first seen out of sync (ISO). */
  since: string;
  /** Out of sync for longer than the limit. */
  alert: boolean;
}

export const CHECKOUT_SYNC_AFTER_MS = 5 * 60_000;

/** the least time between two self-heal pulls of one checkout that is behind. */
export const CHECKOUT_HEAL_EVERY_MS = 5 * 60_000;

export function createCheckoutSync(o: {
  dirs: () => string[];
  git: GitOut;
  /** read in-sync checkouts from the git files (default true) */ fromFiles?: boolean;
  now?: () => number;
  afterMs?: number;
  log?: (m: string) => void;
  alert?: (text: string) => void;
  /**
   * a checkout behind origin/main is pulled through this (the self-healing pull, cycle/syncRecover.ts) at most
   * every `healEveryMs`, so it follows main even when no wake or press pulls it; its answer is checked again at once.
   */
  heal?: (dir: string) => Promise<{ ok: boolean; reason?: string }>;
  healEveryMs?: number;
  /**
   * the console's own write clones (inbox/writeClone.ts), each with the shared checkout it writes for. A clone
   * behind origin is normal (it fast-forwards at its next write); one ahead of origin refuses every write to its repo,
   * so only ahead counts. One clone sat 18 ahead and 165 behind for 30 hours, unseen, because only the shared
   * checkouts were watched. Never healed here: the spine writer heals it at its next write when origin holds it all.
   */
  clones?: () => { shared: string; clone: string }[];
}) {
  const now = () => o.now?.() ?? Date.now();
  const afterMs = o.afterMs ?? CHECKOUT_SYNC_AFTER_MS;
  const out = new Map<string, CheckoutSyncState>();
  const alerted = new Set<string>();
  let checkedAt: string | undefined;
  const healedAt = new Map<string, number>();
  const healEveryMs = o.healEveryMs ?? CHECKOUT_HEAL_EVERY_MS;

  async function check(dir: string): Promise<{ branch: string; ahead: number; behind: number } | undefined> {
    // the usual case (on main, main == origin/main) is read from the git files, with no fork
    if (o.fromFiles !== false && headBranch(dir) === "main") {
      const local = headSha(dir);
      if (local && local === originMainSha(dir)) return { branch: "main", ahead: 0, behind: 0 };
    }
    const branch = (await o.git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
    if (branch !== "main") return undefined; // a checkout off main is not written by the console
    const lr = await o.git(dir, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]).catch(() => "");
    const [ahead, behind] = lr.trim().split(/\s+/).map(Number);
    if (Number.isNaN(ahead) || Number.isNaN(behind) || ahead === undefined || behind === undefined) return undefined;
    return { branch, ahead, behind };
  }

  const cloneFor = new Map<string, string>();
  async function tick(): Promise<CheckoutSyncState[]> {
    const t = now();
    const shared = [...new Set(o.dirs().map((d) => path.resolve(d)))];
    cloneFor.clear();
    for (const c of o.clones?.() ?? []) if (fs.existsSync(path.join(c.clone, ".git"))) cloneFor.set(path.resolve(c.shared), path.resolve(c.clone));
    const clones = new Set(cloneFor.values());
    const dirs = [...shared, ...[...clones].filter((c) => !shared.includes(c))];
    for (const dir of dirs) {
      let s = await check(dir);
      if (s && clones.has(dir)) s = s.ahead ? s : undefined; // a clone only behind is fine
      else if (s && s.behind > 0 && o.heal && t - (healedAt.get(dir) ?? -Infinity) >= healEveryMs) {
        healedAt.set(dir, t);
        const h = await o.heal(dir).catch((e) => ({ ok: false, reason: (e as Error).message }));
        if (!h.ok) o.log?.(`checkout sync: ${dir} is ${s.behind} behind origin/main and the self-healing pull failed: ${h.reason ?? "no reason"}`);
        s = await check(dir);
      }
      if (!s || (s.ahead === 0 && s.behind === 0)) {
        if (out.has(dir) && alerted.has(dir)) o.log?.(`checkout sync: ${dir} matches origin/main again`);
        out.delete(dir);
        alerted.delete(dir);
        continue;
      }
      const prev = out.get(dir);
      const since = prev?.since ?? new Date(t).toISOString();
      const cur: CheckoutSyncState = { dir, repo: clones.has(dir) ? `${path.basename(dir)} (console write copy)` : path.basename(dir), ...s, since, alert: t - Date.parse(since) > afterMs };
      out.set(dir, cur);
      if (cur.alert && !alerted.has(dir)) {
        alerted.add(dir);
        const text = describe(cur, t);
        o.log?.(`checkout sync ALERT: ${text}`);
        o.alert?.(text);
      }
    }
    for (const d of [...out.keys()]) if (!dirs.includes(d)) out.delete(d);
    checkedAt = new Date(t).toISOString();
    return view();
  }

  const view = () => [...out.values()];
  const health = () => {
    const v = view();
    return { state: !checkedAt ? ("pending" as const) : v.some((x) => x.alert) ? ("alert" as const) : ("ok" as const), checkedAt, out: v.filter((x) => x.alert).map((x) => ({ repo: x.repo, ahead: x.ahead, behind: x.behind, since: x.since })) };
  };
  /** The Delivery Manager's wake line for the checkout of `dir` (undefined when it is in sync or not yet alerting). */
  const section = (dir: string | undefined): string | undefined => {
    const own = dir ? out.get(path.resolve(dir)) : undefined;
    const copy = dir ? out.get(cloneFor.get(path.resolve(dir)) ?? "") : undefined;
    const s = own?.alert ? own : copy;
    if (!s?.alert) return undefined;
    return [
      "## Console checkout out of sync",
      `- ${describe(s, now())}. Every console spine write to this repo is refused until it matches origin/main again. ` +
        "This wake: look at the local commits (`git log origin/main..main`). Push or rebase a person's or agent's commit; a console commit the console did not heal goes to a `backup/` branch before the reset. Never force-push.",
    ].join("\n");
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const start = (everyMs: number) => {
    if (timer || everyMs <= 0) return;
    let busy = false;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void tick()
        .catch((e) => o.log?.(`checkout sync: check failed: ${(e as Error).message}`))
        .finally(() => (busy = false));
    }, everyMs);
    timer.unref?.();
  };
  const stop = () => (timer && clearInterval(timer), (timer = undefined));
  return { tick, view, health, section, start, stop };
}
export type CheckoutSync = ReturnType<typeof createCheckoutSync>;

function describe(s: CheckoutSyncState, t: number): string {
  const how = s.ahead && s.behind ? `diverged from origin/main (ahead ${s.ahead}, behind ${s.behind})` : s.ahead ? `${s.ahead} commit(s) ahead of origin/main (not pushed)` : `${s.behind} commit(s) behind origin/main (pulls fail)`;
  return `Team console: the ${s.repo} checkout (${s.dir}) is ${how} since ${s.since.slice(0, 16).replace("T", " ")}Z (${Math.round((t - Date.parse(s.since)) / 60_000)} min)`;
}

/** GET /api/checkout-sync: every tracked checkout that is out of sync with origin right now. */
export function mountCheckoutSync(api: Hono, sync: () => CheckoutSync) {
  api.get("/checkout-sync", (c) => c.json({ ...sync().health(), checkouts: sync().view() }));
}
