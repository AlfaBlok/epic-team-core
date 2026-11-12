import type { Run } from "../store.js";

/**
 * repeat detector: a wake that gives the same report as the wakes before it (same outcome, same summary once
 * numbers, times, dates, run ids, shas and the console's own notes are dropped; step/ask codes count) is marked
 * `repeating: n` when n ≥ REPEAT_MIN. Activity and the milestone header show "same report ×n since <time>". No inbox
 * item: it is not the owner's to act on (a wake blocked on him already has its ask).
 */
export const REPEAT_MIN = 4;

/**
 * Step and ask codes: a new code is a new report, so they are kept while every
 * other number is dropped.
 */
const CODE = /\b[A-Z][A-Z0-9]*-[A-Z]?\d+\b/g;

/**
 * The summary as compared: no `[console: …]` notes, run ids, short shas, ISO times, clock times or numbers (counts,
 * percentages); step/ask codes kept; lower case, one space.
 */
export function normaliseSummary(s: string): string {
  const stripped = s
    .replace(/\[console:[^\]]*\]/gi, " ")
    .replace(/\b[a-z]+_[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, " ") // run_<uuid>, asg_<uuid>
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?z?\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:z|utc)?\b/gi, " ")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, " "); // short/long shas
  const codes = stripped.match(CODE) ?? [];
  return stripped
    .split(CODE)
    .map((part) => part.replace(/\d+(?:[.,]\d+)?/g, " "))
    .reduce((acc, part, i) => acc + part + (i < codes.length ? ` ${codes[i]} ` : ""), "")
    .replace(/[\s.,;:·—–-]+/g, " ")
    .trim()
    .toLowerCase();
}

const isEndedWake = (r: Pick<Run, "kind" | "parentRunId" | "outcome">) => r.kind === "wake" && !r.parentRunId && r.outcome !== "running";

/**
 * The streak ending at `latest` (an ended wake, not yet stored): it and the assignment's earlier ended wakes `before`
 * (any order; `latest` itself is skipped if present), newest first, while outcome and normalised summary match.
 * Returns n and when the first of them started; n < REPEAT_MIN reads as no repeat (undefined).
 */
export function repeatStreak(latest: Run, before: Run[]): { n: number; since: string } | undefined {
  if (!isEndedWake(latest)) return undefined;
  const key = normaliseSummary(latest.summary);
  const prior = before.filter((r) => r.id !== latest.id && isEndedWake(r) && r.startedAt <= latest.startedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  let n = 1;
  let since = latest.startedAt;
  for (const r of prior) {
    if (r.outcome !== latest.outcome || normaliseSummary(r.summary) !== key) break;
    n++;
    since = r.startedAt;
  }
  return n >= REPEAT_MIN ? { n, since } : undefined;
}

/** "same report ×5 since 2026-10-25 08:00Z" (server wording; the web formats the time itself). */
export const repeatPhrase = (n: number, since: string) => `same report ×${n} since ${since.slice(0, 16).replace("T", " ")}Z`;
