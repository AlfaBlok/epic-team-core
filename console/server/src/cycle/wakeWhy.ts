import type { Run } from "../store.js";
import { newsPart } from "./wakeNews.js";
import { CADENCE_SKIP_MAX_AGE_MS, SKIP_AFTER, SKIP_PREFIX, checkDue, readyPart, seatFreed, seatFreedNews, textHash, type WakeState } from "./skipUnchanged.js";

/**
 * every real cadence wake records why it woke. A wake stores its fingerprint parts (`runs.wake_parts`,
 * refreshed with the fingerprint when it ends), so the next cadence wake can name the part that changed; when none
 * did, the skip rule that let it run (a child that ended, the last wake's outcome, the max age since the last real wake).
 * ready rows + a free seat are news only when that set changed (the `ready` part), never on their own.
 */
export const WAKE_PARTS = ["spines", "prompt", "answer", "running", "ready", "data", "rollup", "news"] as const;
export type WakePart = (typeof WAKE_PARTS)[number];
export type WakeParts = Record<WakePart, string>;

/** One short value per fingerprint part (hashes, the newest answer id; ready = "0" / "1:<rows hash>" free seat / "2:<rows hash>" no free seat). */
export function wakeParts(s: WakeState): WakeParts {
  return {
    spines: s.spines,
    prompt: textHash(s.prompt ?? ""),
    answer: s.answer,
    running: textHash([...s.running].sort().join(",")),
    ready: readyPart(s),
    data: s.data ?? "",
    rollup: s.rollup ?? "",
    news: newsPart(s.news ?? []),
  };
}

export function parseWakeParts(text: string | null | undefined): WakeParts | undefined {
  if (!text) return undefined;
  try {
    // parts recorded before `data` existed read as "" (no data/ tree); likewise `rollup` (no lag) and `news` (no open fault).
    const o = { data: "", rollup: "", news: "", ...(JSON.parse(text) as Partial<WakeParts>) };
    return WAKE_PARTS.every((k) => typeof o[k] === "string") ? (o as WakeParts) : undefined;
  } catch {
    return undefined;
  }
}

export function changedParts(before: WakeParts, now: WakeParts): WakePart[] {
  return WAKE_PARTS.filter((k) => before[k] !== now[k]);
}

const PART_WORDS: Record<WakePart, string> = {
  spines: "spines changed",
  prompt: "prompt changed (to-do or grants)",
  answer: "new answer",
  running: "running children changed",
  ready: "ready rows + a free seat changed",
  data: "data/ files changed",
  rollup: "a Current State lag changed (roll-up due or done)",
  news: "open faults changed (a red server-wheel key result, a failing check, a channel down or an open desk note)",
};

const counted = (r: Run) => !r.parentRunId && r.kind !== "answer_run" && !!r.askFingerprint;
const isSkip = (r: Run) => r.summary.startsWith(SKIP_PREFIX);

/**
 * Why a cadence wake of a non-Unblocker persona is real (mirrors cadenceSkipDecision): `runs` newest first, without
 * the wake itself; `parts` what it sees now (undefined: no readable tree); `readyIds` the ready rows nobody is on.
 * Returns e.g. "spines changed" or "ready rows nobody is on + a free seat (S6)".
 */
export function wokeBecause(
  runs: Run[],
  parts: WakeParts | undefined,
  fingerprint: string | undefined,
  o: { readyIds?: string[]; maxAgeMs?: number; now?: number } = {},
): string {
  if (!parts || !fingerprint) return "no readable tree (never skipped)";
  const why: string[] = [];
  const ids = o.readyIds?.length ? ` (${o.readyIds.slice(0, 5).join(", ")})` : "";
  const ready = () => (parts.ready.startsWith("2:") ? `ready rows changed, no free seat${ids}` : `ready rows nobody is on + a free seat${ids}`);
  const fp = runs.filter(counted);
  const newest = fp[0];
  const rowsNow = parts.ready !== "0";
  const last = fp.find((r) => !isSkip(r));
  if (!newest) return parts.ready.startsWith("1") ? `first wake; ${ready()}` : "first wake (no earlier wake to compare)";
  if (newest.outcome === "running") why.push("a wake is still running");
  if (newest.askFingerprint !== fingerprint) {
    const before = newest.wakeParts;
    const diff = before ? changedParts(before, parts) : [];
    const words = diff.flatMap((k) => {
      if (k !== "ready") return [PART_WORDS[k]];
      // after a blocked end a freed seat is not news (seatFreedNews): only the seat changed
      if (seatFreed(before!.ready, parts.ready)) return last?.outcome === "blocked" ? [] : [`a seat freed for ready rows${ids}`];
      if (before!.ready.length > 2 && before!.ready.slice(2) === parts.ready.slice(2)) return []; // only the seat changed: no news
      return [rowsNow ? ready() : PART_WORDS[k]];
    });
    if (words.length) why.push(...words);
    else why.push(before ? "fingerprint changed" : "fingerprint changed (parts not recorded then)");
  }
  if (last && newest.askFingerprint === fingerprint && seatFreedNews(last, parts.ready)) why.push(`a seat freed for ready rows${ids}`);
  const now = o.now ?? Date.now();
  const maxAge = o.maxAgeMs ?? CADENCE_SKIP_MAX_AGE_MS;
  if (last && now - Date.parse(last.startedAt) >= maxAge)
    why.push(`max age (last real wake ${Math.floor((now - Date.parse(last.startedAt)) / 3_600_000)} h ago, cap ${Math.round(maxAge / 3_600_000)} h)`);
  if (last && last.outcome !== "running") {
    if (!SKIP_AFTER.includes(last.outcome)) why.push(`last wake ended ${last.outcome}`);
    if (checkDue(last, now)) why.push("its next check is due");
    const since = Date.parse(last.startedAt);
    if (runs.some((r) => r.parentRunId && r.endedAt && Date.parse(r.endedAt) >= since)) why.push("a child run ended");
  }
  if (!last) why.push("no earlier real wake");
  return why.length ? why.join("; ") : "nothing changed (skip not applied)";
}

// the Unblocker's why comes from memorySkipDecision (cycle/askMemory.ts): which asks are new or changed.
