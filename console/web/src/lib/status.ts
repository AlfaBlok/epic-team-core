import type { MilestoneStatusView, MonitorItem, PendingItem, Run, RunOutcome, WaitingItem } from "@/api";
import { needsAnswer } from "@/api/inbox-types";
import { isWakeRun, runLiveState } from "@/lib/derive";

/**
 * the milestone's flow word comes from the server (GET /api/milestones/:id/status, /api/status), the same
 * object everywhere (header strip, sidebar, Team home, Team badge); nothing here derives it. Order (server): Settled >
 * Paused > Needs you > Working > Planning > Parked > Monitoring > Queued > Stalled > Nothing to do. `loading` = the status is not read yet.
 */
export type MilestoneWord = MilestoneStatusView["flow"]["word"] | "loading";

export const WORD_LABEL: Record<MilestoneWord, string> = {
  settled: "Settled",
  paused: "Paused",
  needs_you: "Needs you",
  planning: "Planning",
  parked: "Parked",
  working: "Working",
  monitoring: "Monitoring",
  queued: "Queued",
  stalled: "Stalled",
  nothing_to_do: "Nothing to do",
  loading: "…",
};

export interface MilestoneState {
  word: MilestoneWord;
  /** The server's flow (reason, nextWakeAt, personas). */
  flow?: MilestoneStatusView["flow"];
  /** needs_you: the open items (codes when they have one). */
  asks?: PendingItem[];
  /** Answers received that no agent has acted on yet (their own pending lines). */
  answered?: PendingItem[];
  /** working: the live run, and its wake number when it is a wake. */
  run?: NonNullable<MilestoneStatusView["flow"]["run"]>;
  wake?: number;
  /** monitoring: the dated items of the spine's `Monitoring:` line (never from a run's report). */
  monitoring?: MonitorItem[];
}

/** The milestone's state, read from the server's status object (undefined while loading). */
export function milestoneState(status: MilestoneStatusView | undefined): MilestoneState {
  if (!status || status.loading) return { word: "loading" }; // spines not read yet: no state from half data
  const f = status.flow;
  // the owner's own change (a snooze, an answer) takes the last open item out at once, before the refresher works
  // out the new flow: until then "…", never "Needs you · 0".
  if (f.word === "needs_you" && !status.items.some((i) => i.state === "open")) return { word: "loading" };
  const answered = status.items.filter((i) => i.state === "answered");
  return {
    word: f.word,
    flow: f,
    ...(f.word === "needs_you" ? { asks: status.items.filter((i) => i.state === "open") } : {}),
    ...(answered.length ? { answered } : {}),
    ...(f.run ? { run: f.run, ...(f.run.wake ? { wake: f.run.wake } : {}) } : {}),
    ...(f.monitoring?.length ? { monitoring: f.monitoring } : {}),
  };
}

/** The status of milestone `id` out of a batch (GET /api/status). */
export const statusOf = (batch: { milestones: MilestoneStatusView[] } | undefined, id: string) => batch?.milestones.find((s) => s.milestoneId === id);

/** Codes of the asks open for the owner now (upper case), from the waiting-on-you list. */
export const openAskCodes = (waiting: WaitingItem[] | undefined): Set<string> =>
  new Set((waiting ?? []).filter(needsAnswer).flatMap((i) => (i.code ? [i.code.toUpperCase()] : [])));

/** Ask codes a summary cites (same rule as the server's citedAskCodes), upper case. */
export function citedAskCodes(text: string): string[] {
  return [...text.matchAll(/(?:^|[^\w-])(?:[\w.]+\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[Aa]\d+)(?![\w-])/g)].map((m) => m[1].toUpperCase());
}

/**
 * The word a run shows (Activity, Team home): running → Working; blocked → Needs you only while a cited code is still
 * open (when the open codes are known), else Monitoring; old `blocked` runs render the same way.
 */
export type RunWord = "working" | "needs_you" | "monitoring" | "progressed" | "failed" | "idle" | "blank_report" | "stopped" | "deferred";
export function runWord(r: Pick<Run, "outcome" | "summary">, open?: Set<string>): RunWord {
  const o: RunOutcome = r.outcome;
  if (o === "running") return "working";
  if (o === "blocked") return !open || citedAskCodes(r.summary).some((c) => open.has(c)) ? "needs_you" : "monitoring";
  return o;
}
export const RUN_WORD_LABEL: Record<RunWord, string> = {
  working: "Working",
  needs_you: "Needs you",
  monitoring: "Monitoring",
  progressed: "Progressed",
  failed: "Failed",
  idle: "Idle",
  blank_report: "Ended without report",
  stopped: "Stopped",
  deferred: "Deferred · will retry",
};

/** A run that is live now: T3 says live, or it is running with no T3 read yet and started in the last 3 h. */
export function isLiveNow(r: Run, now: number): boolean {
  const s = runLiveState(r, now);
  return s === "live" || (s === "unknown" && now - Date.parse(r.startedAt) < 3 * 3_600_000 && !/^Run now: send failed/.test(r.summary));
}

/** Day N of M of a since → until watch (N clamped to 1..M), and the fraction elapsed; undefined without both dates. */
export function holdProgress(item: Pick<MonitorItem, "since" | "until">, now: number = Date.now()): { day: number; days: number; fraction: number } | undefined {
  if (!item.since || !item.until) return undefined;
  const a = Date.parse(item.since);
  const b = Date.parse(item.until);
  if (!(b > a)) return undefined;
  const days = Math.max(1, Math.round((b - a) / 86_400_000));
  const day = Math.min(days, Math.max(1, Math.floor((now - a) / 86_400_000) + 1));
  return { day, days, fraction: Math.min(1, Math.max(0, (now - a) / (b - a))) };
}

/** "Oct 25, 02:00 UTC": the browser's zone, with the zone shown. */
export function zoned(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) });
}

/** A failed wake whose next wake in the same assignment went on (progressed / monitoring / idle): when that was. */
export function recoveredAt(failed: Run, newerFirst: Run[]): string | undefined {
  if (failed.outcome !== "failed") return undefined;
  const later = newerFirst.filter((r) => isWakeRun(r) && r.startedAt > failed.startedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const next = later[0];
  return next && ["progressed", "monitoring", "idle"].includes(next.outcome) ? next.startedAt : undefined;
}
