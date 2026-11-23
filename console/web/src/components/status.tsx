import { createContext, Fragment, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AskKind, MilestoneStatusView, PendingItem, WakeNote } from "@/api";
import { holdProgress, milestoneState, WORD_LABEL, zoned, type MilestoneState, type MilestoneWord } from "@/lib/status";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StalledActions } from "@/components/stalled";
import { ownerName } from "@/lib/identity";
import { FoldChevron } from "@/components/foldChevron";

/**
 * the open ask codes of the page (from Waiting on you), so an old `blocked` run badge reads Needs you only while
 * a code it cites is still open, else Monitoring. Undefined = not known (blocked reads Needs you).
 */
export const OpenAsksContext = createContext<Set<string> | undefined>(undefined);
export const useOpenAsks = () => useContext(OpenAsksContext);

/**
 * Amber is the attention colour (Needs you; Stalled orange,: an alarm, nobody will wake); Monitoring and Queued calm
 * blue; the rest neutral. Red is never a flow colour: it marks only open items for the owner.
 */
// a state is a grey word; "needs you" in ink; only a live worker is green (LIVE_DOT).
export const WORD_TONE: Record<MilestoneWord, { dot: string; text: string; box: string }> = {
  needs_you: { dot: "bg-foreground", text: "text-foreground", box: "border-border bg-muted/40" },
  working: { dot: "bg-zinc-500", text: "text-muted-foreground", box: "border-border bg-muted/40" },
  monitoring: { dot: "bg-zinc-500", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  queued: { dot: "bg-zinc-500", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  stalled: { dot: "bg-zinc-500", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  nothing_to_do: { dot: "bg-zinc-300 dark:bg-zinc-600", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  planning: { dot: "bg-zinc-300 dark:bg-zinc-600", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  parked: { dot: "bg-zinc-300 dark:bg-zinc-600", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  paused: { dot: "bg-zinc-300 dark:bg-zinc-600", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  settled: { dot: "bg-zinc-300 dark:bg-zinc-600", text: "text-muted-foreground", box: "border-border bg-muted/20" },
  loading: { dot: "bg-zinc-200 dark:bg-zinc-700", text: "text-muted-foreground", box: "border-border bg-muted/10" },
};

/**
 * Working with at least one worker T3 confirms live (the server's `flow.live`, the same rule
 * as Activity's "N workers running") gets a green pulsing dot, static green under prefers-reduced-motion.
 */
export const LIVE_DOT = "bg-emerald-500 animate-pulse motion-reduce:animate-none";

/** The milestone's live worker count when it is Working (0 otherwise), from its server status. */
export const liveWorkers = (status: Pick<MilestoneStatusView, "flow"> | undefined): number => (status?.flow.word === "working" ? status.flow.live ?? 0 : 0);

/** The dot classes of a state word: LIVE_DOT for Working with a live worker, else the word's tone. */
export const wordDot = (word: MilestoneWord, live = 0) => (word === "working" && live > 0 ? LIVE_DOT : WORD_TONE[word].dot);

/** One word + colour dot: the milestone's state (sidebar, Team home, the FLOW chip). `live` = flow.live. */
export function StateWord({ word, live = 0, className, title }: { word: MilestoneWord; live?: number; className?: string; title?: string }) {
  const tone = WORD_TONE[word];
  const isLive = word === "working" && live > 0;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] font-medium leading-4", tone.text, className)}
      title={[title, isLive ? `${live} worker${live === 1 ? "" : "s"} running` : undefined].filter(Boolean).join(" · ") || undefined}
      data-testid="state-word"
      data-state={word}
      data-live={isLive ? live : undefined}
    >
      <span className={cn("inline-block h-2 w-2 rounded-full", wordDot(word, live))} aria-hidden data-testid="state-dot" />
      {WORD_LABEL[word]}
    </span>
  );
}

const NOUN: Record<AskKind, [string, string]> = {
  decide: ["decision", "decisions"],
  approve: ["approval", "approvals"],
  provide: ["thing to provide", "things to provide"],
  do: ["action", "actions"],
  unknown: ["question", "questions"],
};

/**
 * "1 decision, 2 approvals", counted by kind (same words as the server's flow reason):
 * a Ready to mark item is "1 to mark", a failed run "1 failed run", never "question" for a non-question.
 */
export function asksPhrase(asks: (Pick<PendingItem, "code"> & { ask?: AskKind; kind?: PendingItem["kind"] })[]): string {
  const counts = new Map<AskKind, number>();
  const marks = asks.filter((a) => a.kind === "ready_to_mark").length;
  const readies = asks.filter((a) => a.kind === "mark_ready").length;
  const runs = asks.filter((a) => a.kind === "failed_run").length;
  const alerts = asks.filter((a) => a.kind === "monitor_alert").length;
  for (const a of asks) if (a.kind !== "ready_to_mark" && a.kind !== "failed_run" && a.kind !== "mark_ready" && a.kind !== "monitor_alert") counts.set(a.ask ?? "unknown", (counts.get(a.ask ?? "unknown") ?? 0) + 1);
  const parts = [...(alerts ? [`${alerts} monitor alert${alerts === 1 ? "" : "s"}`] : []), ...(marks ? [`${marks} to mark`] : []), ...(readies ? [`${readies} to mark ready`] : []), ...[...counts].map(([k, n]) => `${n} ${NOUN[k][n === 1 ? 0 : 1]}`), ...(runs ? [`${runs} failed run${runs === 1 ? "" : "s"}`] : [])];
  const codes = asks.flatMap((a) => (a.code ? [a.code] : []));
  return `${parts.join(", ")}${codes.length ? ` (${codes.slice(0, 4).join(", ")}${codes.length > 4 ? ", …" : ""})` : ""}`;
}

/** The header strip's sentences (one per Monitoring item), without markup; tests and the strip share them. */
export function stripLines(
  st: MilestoneState,
  o: { now?: number; timeZone?: string } = {},
): string[] {
  const now = o.now ?? Date.now();
  // relative labels ("in 2 h", "3 min ago"); stripStamps gives the exact times for the hover title.
  const z = (iso: string) => formatRelative(iso, new Date(now));
  switch (st.word) {
    case "needs_you":
      // the number first, the same N as the sidebar badge, the Waiting on you tab and the Tree red count.
      return [`Needs you · ${(st.asks ?? []).length} · ${asksPhrase(st.asks ?? [])}`];
    case "working": {
      const r = st.run!;
      const who = st.wake ? `wake #${st.wake}` : r.parentRunId ? `worker ${r.summary.split(/\s/)[0] || ""}`.trim() : "a run";
      return [`Working · ${who} started ${z(r.startedAt)}`];
    }
    case "monitoring":
      return (st.monitoring ?? []).map((i) => {
        const p = holdProgress(i, now);
        const parts = [`Monitoring · ${i.what}${p ? `, day ${p.day} of ${p.days}` : ""}`];
        if (i.nextCheckAt) parts.push(`next check ${z(i.nextCheckAt)}${i.nextCheck ? ` (${i.nextCheck})` : ""}`);
        else if (i.nextCheck) parts.push(`next check: ${i.nextCheck}`);
        if (i.until) parts.push(`ready ${z(i.until)} if it stays green`);
        return parts.join(" · ");
      });
    case "queued": {
      const f = st.flow!;
      const who = f.personas?.length ? ` of ${f.personas.join(", ")}` : "";
      return [`Queued · ${f.reason.split(";")[0]}${f.nextWakeAt ? ` · next wake${who} ${z(f.nextWakeAt)}` : ""}`];
    }
    case "stalled":
      return [`Stalled · ${st.flow!.reason}`];
    case "nothing_to_do":
      return ["Nothing to do · no step is ready"];
    case "loading":
      return ["…"];
    case "paused":
      return ["Paused · no wakes until it is resumed"];
    case "planning":
      return [`Planning · a draft: no wake works it until ${ownerName()} stamps it ready for delivery`];
    case "parked":
      return ["Parked · deferred: no wake works it"];
    case "settled":
      return ["Settled · hidden from the sidebar and Team home"];
  }
}

/** The exact times behind each stripLines sentence ("Oct 25, 02:00 UTC"), for its hover title; undefined = none. */
export function stripStamps(st: MilestoneState, o: { timeZone?: string } = {}): (string | undefined)[] {
  const z = (iso: string) => zoned(iso, o.timeZone);
  switch (st.word) {
    case "working":
      return [`started ${z(st.run!.startedAt)}`];
    case "monitoring":
      return (st.monitoring ?? []).map((i) => {
        const parts = [i.nextCheckAt && `next check ${z(i.nextCheckAt)}`, i.until && `ready ${z(i.until)}`].filter(Boolean);
        return parts.length ? parts.join(" · ") : undefined;
      });
    case "queued":
      return [st.flow?.nextWakeAt ? `next wake ${z(st.flow.nextWakeAt)}` : undefined];
    default:
      return [];
  }
}

/** a header note line; a repeat names its start relative to now ("steward: same report ×5 since 3 h ago"). */
export function wakeNoteLine(n: WakeNote, now: number = Date.now()): string {
  if (n.kind === "repeating" && n.n) return `${n.persona}: same report ×${n.n}${n.since ? ` since ${formatRelative(n.since, new Date(now))}` : ""}`;
  return n.text;
}

/** the Waiting on you link that scrolls to one item (`item=<id>`, Milestone.tsx rings it). */
export const answerHref = (waitingHref: string, item: Pick<PendingItem, "id">) => `${waitingHref}${waitingHref.includes("?") ? "&" : "?"}item=${encodeURIComponent(item.id)}`;

/**
 * header strip (milestone page top, under the title): the state in its colour, in one sentence; Needs you links
 * to Waiting on you; a Monitoring item with since + until shows a thin day-N-of-M bar.
 */
/**
 * a milestone's notes for the Delivery Manager show two lines, then "and N more notes for the
 * Delivery Manager", which opens the rest. Every line stays in the page (folded ones hidden), so nothing is lost.
 */
export function DefectFold({ children, show = 2 }: { children: ReactNode[]; show?: number }) {
  const [open, setOpen] = useState(false);
  const more = children.length - show;
  return (
    <>
      {children.map((c, i) =>
        !open && i >= show ? (
          <div key={i} hidden>
            {c}
          </div>
        ) : (
          <Fragment key={i}>{c}</Fragment>
        ),
      )}
      {more > 0 && (
        <button type="button" className="justify-self-start text-xs text-muted-foreground hover:text-foreground hover:underline" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="defect-more">
          <FoldChevron open={open} className="mr-1.5" />
          {open ? "Show fewer notes" : `and ${more} more ${more === 1 ? "note" : "notes"} for the Delivery Manager`}
        </button>
      )}
    </>
  );
}

export function MilestoneStrip({
  status,
  waitingHref = "?tab=waiting",
  markHref = "?mark=1",
  now = Date.now(),
  timeZone,
}: {
  /** the server's status of the milestone (undefined while loading). */
  status?: MilestoneStatusView;
  waitingHref?: string;
  /** where "review and mark" goes (the Summary tab's mark dialog). */
  markHref?: string;
  now?: number;
  /** Tests pin the zone; the browser's otherwise. */
  timeZone?: string;
}) {
  const st = milestoneState(status);
  const tone = WORD_TONE[st.word];
  const lines = stripLines(st, { now, timeZone });
  const stamps = stripStamps(st, { timeZone });
  // "answer →" lands on the first counted item the owner can press (the page scrolls to it and rings it).
  const answerTo = st.asks?.find((a) => a.kind !== "ready_to_mark");
  return (
    <div className={cn("mb-4 grid gap-2 rounded-lg border px-4 py-2.5 text-sm", tone.box)} data-testid="state-strip" data-state={st.word} data-live={liveWorkers(status) || undefined} data-needs-you={status && !status.loading ? (status.needsYou ?? undefined) : undefined}>
      {lines.map((line, i) => {
        const item = st.monitoring?.[i];
        const p = item && holdProgress(item, now);
        const [head, ...rest] = line.split(" · ");
        return (
          <div key={i} className="grid gap-1.5">
            <div className={cn("flex min-w-0 flex-wrap items-baseline gap-x-1.5", tone.text)}>
              <span className={cn("inline-block h-2 w-2 shrink-0 self-center rounded-full", wordDot(st.word, liveWorkers(status)))} aria-hidden data-testid="state-dot" />
              <span className="font-semibold">{head}</span>
              {rest.length > 0 && (
                <span className="min-w-0 break-words" title={stamps[i]}>
                  · {rest.join(" · ")}
                </span>
              )}
              {st.word === "needs_you" && answerTo && (
                <Link to={answerHref(waitingHref, answerTo)} className="ml-1 font-medium underline-offset-2 hover:underline" data-testid="answer-link">
                  answer →
                </Link>
              )}
              {st.word === "needs_you" && st.asks?.some((a) => a.kind === "ready_to_mark") && (
                <Link to={markHref} className="ml-1 font-medium underline-offset-2 hover:underline" data-testid="review-and-mark">
                  review and mark →
                </Link>
              )}
            </div>
            {p && (
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-sky-500/15"
                role="progressbar"
                aria-label={`day ${p.day} of ${p.days}`}
                aria-valuemin={0}
                aria-valuemax={p.days}
                aria-valuenow={p.day}
              >
                <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.round(p.fraction * 100)}%` }} />
              </div>
            )}
            {item?.then && <div className="text-xs text-muted-foreground">then: {item.then}</div>}
          </div>
        );
      })}
      {status?.wakeNotes?.map((n) => (
        <div
          key={`${n.kind}:${n.runId}`}
          className={cn("text-xs", n.kind === "ready_ignored" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground")}
          data-testid="wake-note"
          data-kind={n.kind}
          title={n.since ? zoned(n.since, timeZone) : undefined}
        >
          {wakeNoteLine(n, now)}
        </div>
      ))}
      {/* a code in the spines that names no ask is the Delivery Manager's to fix, never an item for the owner; so is a line naming the owner with no ask. */}
      <DefectFold>{[...(status?.defects ?? []).map((d) => (
        <div key={`${d.path}:${d.line}:${d.code ?? d.kind}`} className="text-xs text-muted-foreground" data-testid="defect-line" data-kind={d.kind ?? "ref"}>
          Delivery Manager to fix:{" "}
          {d.url ? (
            <a href={d.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {d.path}:{d.line + 1}
            </a>
          ) : (
            `${d.path}:${d.line + 1}`
          )}{" "}
          {d.note ?? `names ${d.repo}/${d.code}, which is no ask`}
        </div>
      )),
      /* a stopped monitor item that names no open ask is the Delivery Manager's to fix, never the owner's. */
      ...(status?.items ?? [])
        .filter((i) => i.kind === "monitor_alert" && i.state === "alarm")
        .map((i) => (
          <div key={i.id} className="text-xs text-muted-foreground" data-testid="defect-line" data-kind="monitor_alert">
            Delivery Manager to fix: {i.title.replace(/^Monitor alert:\s*/, "")} — {i.monitor?.next ?? "names no open ask"}
          </div>
        ))]}</DefectFold>
      {st.word === "stalled" && status?.items.filter((i) => i.kind === "stalled").map((i) => <StalledActions key={i.id} item={i} />)}
      {st.answered?.map((a) => (
        <div key={a.id} className="text-xs text-muted-foreground" data-testid="answered-line">
          {a.title}
          {a.since && <> · asked {formatRelative(a.since, new Date(now))}</>}
        </div>
      ))}
    </div>
  );
}
