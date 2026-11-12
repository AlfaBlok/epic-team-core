import { useState } from "react";
import { ClampText } from "@/components/unblock";
import { ExternalLink, GitCommit } from "lucide-react";
import type { Persona, Run, RunCommit } from "@/api";
import { OutcomeBadge, RelTime, RunNote, ThreadLink, RuleBrokenLines, WokeBecause } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { evidenceLink } from "@/components/outcome";
import { formatCadence, formatDateTime, formatRelative, scheduleLabel } from "@/lib/format";
import { countLive, isAnswerRun, runLiveState, T3_STALE_MS, type RunNode, type TimelineGroup } from "@/lib/derive";
import { cn } from "@/lib/utils";
import { RunChecks, RunOutcomeChip } from "@/components/runChecks";
import { RunControls } from "@/components/runControls";
import { DiscussButton, runTicketId } from "@/components/ticketSession";
import { recoveredAt, zoned } from "@/lib/status";
import { UsageChip } from "@/components/usage";
import { ownerName } from "@/lib/identity";

function Commits({ commits, remote }: { commits?: RunCommit[]; remote?: string }) {
  if (!commits?.length) return null;
  return (
    <ul className="mt-1.5 grid gap-0.5">
      {commits.map((c) => {
        const { href } = evidenceLink(c.sha, remote);
        return (
          <li key={c.sha} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GitCommit className="h-3 w-3 shrink-0" />
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="font-mono text-sky-700 hover:underline dark:text-sky-400">
                {c.sha}
              </a>
            ) : (
              <span className="font-mono">{c.sha}</span>
            )}
            <span className="truncate" title={c.subject}>
              {c.subject}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * a running run's chip from the T3 state the server's reconciler last read (replaces's
 * "not closed by persona", which never looked at T3 and made live workers look abandoned).
 */
function LiveChip({ run, child, now }: { run: Run; child: boolean; now: number }) {
  const kind = runLiveState(run, now) ?? "unknown";
  const t = run.t3;
  const checked = t ? `T3 ${t.detail ?? t.status}, last checked ${formatRelative(t.checkedAt, new Date(now))} (${formatDateTime(t.checkedAt)})` : "T3 not checked yet";
  if (kind === "live") {
    const mins = Math.max(1, Math.round((now - Date.parse(t?.startedAt ?? run.startedAt)) / 60000));
    return (
      <Badge variant="green" title={checked}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
        {child ? "worker running" : "running"} · {mins} min
      </Badge>
    );
  }
  if (kind === "finished")
    return (
      <Badge variant="amber" title={`The T3 turn ended and nobody reported; the console records it as ended without report. ${checked}`}>
        finished · no report
      </Badge>
    );
  if (kind === "failed" || kind === "stopped")
    return (
      <Badge variant="red" title={checked}>
        {kind === "stopped" ? "stopped" : child ? "worker failed" : "failed"}
      </Badge>
    );
  const why = !run.threadId
    ? "No T3 thread recorded for this run."
    : !t
      ? "The console has not read this thread yet."
      : t.status === "unknown"
        ? `T3 read gave no answer (${t.detail ?? "unknown"}).`
        : now - Date.parse(t.checkedAt) > T3_STALE_MS
          ? "The last T3 read is more than 5 min old."
          : "";
  return (
    <Badge variant="amber" title={`${why} ${checked}`.trim()}>
      status unknown · {t ? `last checked ${formatRelative(t.checkedAt, new Date(now))}` : "not checked yet"}
    </Badge>
  );
}

function Wake({
  node,
  wake,
  depth,
  commits,
  remote,
  now,
  personaName,
  recovered,
}: {
  node: RunNode;
  wake?: number;
  depth: number;
  commits: Record<string, RunCommit[]>;
  remote?: string;
  now: number;
  /** the group's persona; an Unblocker wake reads "answered N · left M", never "idle". */
  personaName?: string;
  /** a failed wake whose next wake went on: when (a muted note, not an alarm). */
  recovered?: string;
}) {
  const r = node.run;
  return (
    <>
      <li id={`run-${r.id}`} className={cn("border-b px-4 py-3 last:border-0", depth > 0 && "bg-muted/30")} style={{ paddingLeft: 16 + depth * 24 }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{depth > 0 ? "↳ child run" : isAnswerRun(r) ? "answer run" : `wake #${wake}`}</span>
          <RelTime iso={r.startedAt} now={now} />
          {r.seat && <span>{r.seat}</span>}
          {runLiveState(r, now) ? (
            <LiveChip run={r} child={depth > 0} now={now} />
          ) : depth > 0 ? (
            <OutcomeBadge outcome={r.outcome} run={r} />
          ) : recovered ? (
            <Badge variant="gray" data-testid="recovered" title={`This wake failed; the next wake went on at ${zoned(recovered)}.`}>
              failed · recovered {formatRelative(recovered, new Date(now))}
            </Badge>
          ) : (
            <RunOutcomeChip run={r} personaName={personaName} />
          )}
          {r.endedAt && <span>{Math.max(1, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60000))} min</span>}
          <UsageChip usage={r.usage} live={r.usageLive} />
          {r.threadId && (
            <ThreadLink className="inline-flex items-center gap-1 hover:text-foreground hover:underline" threadId={r.threadId} environmentId={r.environmentId} title={r.threadId}>
              {depth > 0 ? "child thread" : "home thread"} <ExternalLink className="h-3 w-3" />
            </ThreadLink>
          )}
          <RunControls run={r} workers={node.children.filter((c) => c.run.outcome === "running").length} who={depth > 0 ? undefined : personaName} />
          {r.milestoneId && runTicketId(r) && <DiscussButton milestoneId={r.milestoneId} row={runTicketId(r)!} run={r.id} />}
        </div>
        <RunNote className="mt-1" text={r.instructions} by={r.instructionsBy} ack={r.noteAck} />
        {r.steers?.map((st, i) => <RunNote key={i} className="mt-1" text={st.message} label={`${ownerName()} steered${st.mode === "auto" ? " (queued)" : ""} ${zoned(st.at)}:`} />)}
        {r.summary && <ClampText className="mt-1 text-sm" text={r.summary} lines={3} milestoneId={r.milestoneId} />}
        <WokeBecause className="mt-0.5" run={r} />
        <RuleBrokenLines className="mt-1" run={r} />
        <RunChecks className="mt-1.5" checks={r.checks} remote={remote} />
        <Commits commits={commits[r.id]} remote={remote} />
      </li>
      {node.children.map((c) => (
        <Wake key={c.run.id} node={c} depth={depth + 1} commits={commits} remote={remote} now={now} />
      ))}
    </>
  );
}

/** summary prefix of a cadence wake the console skipped (nothing new since the last real wake). */
export const SKIP_PREFIX = "skipped: nothing new since";
const isSkip = (n: RunNode) => n.run.summary.startsWith(SKIP_PREFIX) && !n.children.length;

/** Consecutive skipped wakes become one item; everything else stays a single wake. */
function collapseSkips(wakes: TimelineGroup["wakes"]) {
  const out: ({ kind: "wake"; node: TimelineGroup["wakes"][number] } | { kind: "skips"; nodes: TimelineGroup["wakes"] })[] = [];
  for (const w of wakes) {
    const last = out[out.length - 1];
    if (isSkip(w) && last?.kind === "skips") last.nodes.push(w);
    else out.push(isSkip(w) ? { kind: "skips", nodes: [w] } : { kind: "wake", node: w });
  }
  return out;
}

/** skipped wakes collapse to one "<persona>: nothing new" row (newest summary); Show lists each. */
function NothingNew({ nodes, ...rest }: { nodes: TimelineGroup["wakes"] } & Omit<Parameters<typeof Wake>[0], "node" | "wake" | "depth">) {
  const [open, setOpen] = useState(false);
  const newest = nodes[0].run;
  const oldest = nodes[nodes.length - 1].run;
  return (
    <>
      <li className="border-b px-4 py-2 last:border-0" data-testid="nothing-new">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Badge variant="gray">{rest.personaName ?? "Persona"}: nothing new</Badge>
          <span title={nodes.length > 1 ? `${formatDateTime(oldest.startedAt)} – ${formatDateTime(newest.startedAt)}` : formatDateTime(newest.startedAt)}>
            {nodes.length} wake{nodes.length === 1 ? "" : "s"} skipped
            {nodes.length > 1 ? ` · ${formatRelative(oldest.startedAt, new Date(rest.now))} – ${formatRelative(newest.startedAt, new Date(rest.now))}` : ` · ${formatRelative(newest.startedAt, new Date(rest.now))}`}
          </span>
          <button type="button" className="hover:text-foreground hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"}
          </button>
        </div>
        {!open && <ClampText className="mt-1 text-xs text-muted-foreground" text={newest.summary} lines={1} milestoneId={newest.milestoneId} />}
      </li>
      {open && nodes.map((w) => <Wake key={w.run.id} node={w} wake={w.wake} depth={0} {...rest} />)}
    </>
  );
}

const wakeCount = (g: TimelineGroup) => g.wakes.filter((w) => !isAnswerRun(w.run)).length;

/** Activity: one card per assignment, wakes newest first with their child runs and spine commits. */
export function RunTimeline({
  groups,
  personas,
  commits = {},
  remote,
  now = Date.now(),
}: {
  groups: TimelineGroup[];
  personas: Persona[];
  commits?: Record<string, RunCommit[]>;
  remote?: string;
  /** Tests pin the clock; the page re-renders on every poll. */
  now?: number;
}) {
  return (
    <div className="grid gap-4">
      {groups.map((g) => {
        const persona = personas.find((p) => p.id === g.personaId);
        const live = countLive(g.wakes, now);
        const name = g.assignmentId.startsWith("bootstrap:") ? "bootstrap" : persona?.name ?? (g.deleted ? "deleted assignment" : "persona");
        return (
          <section key={g.assignmentId} aria-label={`runs of ${name}`}>
            <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{name}</span>
              {g.assignment && (
                <span className="text-xs text-muted-foreground" data-testid="schedule-label" title={g.assignment.enabled ? undefined : `switched off (cadence when on: ${formatCadence(g.assignment.cadence)})`}>
                  {scheduleLabel(g.assignment)}
                </span>
              )}
              {g.deleted && (
                <Badge variant="gray" title={g.assignmentId}>
                  assignment deleted
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {wakeCount(g)} wake{wakeCount(g) === 1 ? "" : "s"}
                {g.wakes.length > wakeCount(g) && `, ${g.wakes.length - wakeCount(g)} answer run${g.wakes.length - wakeCount(g) === 1 ? "" : "s"}`}
              </span>
              {live > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                  {live} worker{live === 1 ? "" : "s"} running
                </span>
              )}
            </h3>
            <Card className="overflow-hidden">
              <ul>
                {collapseSkips(g.wakes).map((item) =>
                  item.kind === "skips" ? (
                    <NothingNew key={item.nodes[0].run.id} nodes={item.nodes} commits={commits} remote={remote} now={now} personaName={persona?.name} />
                  ) : (
                    <Wake
                      key={item.node.run.id}
                      node={item.node}
                      wake={item.node.wake}
                      depth={0}
                      commits={commits}
                      remote={remote}
                      now={now}
                      personaName={persona?.name}
                      recovered={recoveredAt(item.node.run, g.wakes.map((x) => x.run))}
                    />
                  ),
                )}
              </ul>
            </Card>
          </section>
        );
      })}
    </div>
  );
}
