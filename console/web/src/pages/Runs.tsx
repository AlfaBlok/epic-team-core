import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { api, type Assignment, type Milestone, type Persona, type Run, type RunOutcome } from "@/api";
import { useQuery } from "@/lib/data";
import { isAnswerRun, isOrphanRun, nestRuns, runPersonaId, type RunNode } from "@/lib/derive";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { OpenAsksContext } from "@/components/status";
import { openAskCodes } from "@/lib/status";
import { Empty, ErrorBox, Loading, OutcomeBadge, outcomeLabel, PageHeader, RelTime, RunNote, RuleBrokenLines, ThreadLink, WokeBecause } from "@/components/common";
import { ClampText } from "@/components/unblock";
import { RunChecks, RunOutcomeChip } from "@/components/runChecks";
import { RunControls } from "@/components/runControls";
import { DiscussButton, runTicketId } from "@/components/ticketSession";
import { formatUsd, UsageChip, UsagePanel } from "@/components/usage";
import { UnblockerPanel } from "@/components/unblockerStats";
import { milestoneName } from "@/lib/format";
import { cap, useWords } from "@/lib/skin";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { LimitControl, ListPane, limitList, useListLimit } from "@/components/listPane";
import { ActiveAgentsSection } from "@/components/activeAgents";
import { RunHostsSection } from "@/components/runHosts";
import { ownerName } from "@/lib/identity";

const OUTCOMES: RunOutcome[] = ["running", "progressed", "blocked", "monitoring", "idle", "failed", "blank_report", "stopped", "deferred"];

/**
 * global Runs: every run across milestones, newest first, child runs nested; filter by milestone, persona, outcome.
 * the wakes sit in the shared scroll pane with Show 20 / 50 / all (default 20). With no filter or only the
 * milestone one the server sends just those wakes and their child runs (`?top=`, ~900 KB → a few dozen KB); a persona,
 * outcome or kind filter reads the newest 500 runs as before and cuts the matches here. Wide lines are clipped as the
 * Card did (overflow-x-hidden), never a sideways scroll in the pane.
 * each wake is one line (outcome, persona, milestone, age, seat, cost, the summary cut to one line with the
 * full text on hover); a click opens its full card inline (child runs, Steer / Stop / Discuss, Woken by). A running wake
 * keeps a pulsing live dot on its line. On a phone the line drops milestone, seat and cost.
 * above the filters, the Active agents chart of the day (every run of the world, not the filters).
 * under it, Live runs by host: the last 24 h / 7 d stacked by the host each run ran on.
 */
export function RunsPage() {
  const [limit, setLimit] = useListLimit("runs");
  const [wakesOpen, setWakesOpen] = useSectionOpen("runs");
  const [params, setParams] = useSearchParams();
  const f = { milestone: params.get("milestone") ?? "", persona: params.get("persona") ?? "", outcome: params.get("outcome") ?? "", kind: params.get("kind") ?? "" };
  const clientFilter = !!(f.persona || f.outcome || f.kind);
  const { data: page, error, loading } = useQuery(
    async () => (clientFilter ? { runs: await api.listRuns(), total: undefined } : api.listRunsTop({ top: limit || undefined, milestoneId: f.milestone || undefined })),
    [clientFilter, limit, f.milestone],
  );
  const runs = page?.runs;
  const { data: milestones = [] } = useQuery(() => api.listMilestones(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const w = useWords();
  // an old `blocked` run reads Needs you only while a code it cites is open, else Monitoring.
  const { data: waiting } = useQuery(() => api.listWaitingOnOwner(), [], { tag: "inbox" });
  // Until assignments load every run would look orphaned ("assignment deleted"): the list waits for them.
  const { data: assignments, error: assignmentsError } = useQuery(() => api.listAssignments(), []);
  const set = (key: keyof typeof f, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // Filters pick top-level runs (wakes); their child runs come along nested.
  const ready = runs && assignments;
  const roots = (ready ? nestRuns(runs) : []).filter(
    ({ run: r }) =>
      (!f.milestone || r.milestoneId === f.milestone) &&
      (!f.persona || runPersonaId(r, assignments!) === f.persona) &&
      (!f.outcome || r.outcome === f.outcome) &&
      (!f.kind || (f.kind === "answer_run") === isAnswerRun(r)),
  );
  // The server already cut to `limit` wakes (top); filtered here, the cut is ours.
  const shown = page?.total === undefined ? limitList(roots, limit) : roots;
  const total = page?.total ?? roots.length;
  const select = "h-8 min-w-0 rounded-md border bg-background px-2 text-sm";
  // Wakes opened to their full card (by run id); every wake starts as one line.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <OpenAsksContext.Provider value={openAskCodes(waiting)}>
      <PageHeader title="Runs" description={`Every persona run across ${w.milestonesWord}, newest first; child runs nested under the wake that launched them.`} />
      <UsagePanel />
      <UnblockerPanel />
      <ActiveAgentsSection />
      <RunHostsSection />
      <div className="mb-4 flex flex-wrap gap-2" data-testid="runs-filters">
        <select aria-label={cap(w.milestone)} className={cn(select, "max-w-full sm:max-w-xs")} value={f.milestone} onChange={(e) => set("milestone", e.target.value)}>
          <option value="">All {w.milestonesWord}</option>
          {milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {milestoneName(m)}
            </option>
          ))}
        </select>
        <select aria-label="Persona" className={select} value={f.persona} onChange={(e) => set("persona", e.target.value)}>
          <option value="">All personas</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select aria-label="Outcome" className={select} value={f.outcome} onChange={(e) => set("outcome", e.target.value)}>
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {outcomeLabel(o)}
            </option>
          ))}
        </select>
        <select aria-label="Kind" className={select} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="">All kinds</option>
          <option value="wake">Wake runs</option>
          <option value="answer_run">Answer runs</option>
        </select>
      </div>
      {(error ?? assignmentsError) && <ErrorBox error={(error ?? assignmentsError)!} />}
      {loading && !ready && !error && !assignmentsError && <Loading />}
      {ready && roots.length === 0 && <Empty>{runs.length ? "No runs match these filters." : "No runs yet."}</Empty>}
      {roots.length > 0 && (
        <>
          <FoldSection
            title="Wakes"
            count={total}
            testId="runs"
            open={wakesOpen}
            onToggle={setWakesOpen}
            actions={<LimitControl limit={limit} onChange={setLimit} total={total} testId="runs" />}
            bodyClassName="p-0"
          >
            <ListPane shown={shown.length} total={total} testId="runs" className="gap-0 overflow-x-hidden" footClassName="mt-0 border-t px-4 py-2">
              {shown.map((n) => (
                <WakeLine key={n.run.id} node={n} open={opened.has(n.run.id)} onToggle={() => toggle(n.run.id)} milestones={milestones} personas={personas} assignments={assignments!} />
              ))}
            </ListPane>
          </FoldSection>
        </>
      )}
    </OpenAsksContext.Provider>
  );
}

/** a wake's one line; open, its full card (and child runs) follows under it. */
function WakeLine({
  node,
  open,
  onToggle,
  milestones,
  personas,
  assignments,
}: {
  node: RunNode;
  open: boolean;
  onToggle: () => void;
  milestones: Milestone[];
  personas: Persona[];
  assignments: Assignment[];
}) {
  const r = node.run;
  const m = milestones.find((x) => x.id === r.milestoneId);
  const persona = personas.find((p) => p.id === runPersonaId(r, assignments));
  const who = r.assignmentId.startsWith("bootstrap:") ? "bootstrap" : persona?.name ?? (isOrphanRun(r, assignments) ? "deleted assignment" : "persona");
  const live = r.outcome === "running";
  const cost = r.usage?.costUsd ?? r.usageLive?.costUsd;
  const where = m ? milestoneName(m) : r.milestoneId;
  const kids = node.children.length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <li className={cn("min-w-0 border-b last:border-0", open && "bg-muted/40")} data-testid="wake-line" data-open={open || undefined} data-live={live || undefined}>
        <button
          type="button"
          className="flex h-9 w-full min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap px-3 text-left text-xs text-muted-foreground hover:bg-muted/50 sm:h-8"
          aria-expanded={open}
          onClick={onToggle}
          title={r.summary || undefined}
        >
          <Chevron className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {live && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" data-testid="wake-live" title="Running now" aria-label="running" />}
          {/* Phone: a long chip (Unblocker · answered 1 · left 0 · split 1) is clipped so age and summary still show; two
              chips (Monitoring + stalled) stay on the one line (OutcomeBadge's own group wraps elsewhere). */}
          <span className="flex min-w-0 max-w-[7.5rem] shrink-0 flex-nowrap items-center gap-1 overflow-hidden sm:max-w-none [&_*]:flex-nowrap [&_*]:whitespace-nowrap" data-testid="wake-chip">
            {isAnswerRun(r) && <Badge variant="blue">answer run</Badge>}
            <RunOutcomeChip run={r} personaName={persona?.name} />
          </span>
          <span className="max-w-[5.5rem] shrink-0 truncate font-medium text-foreground sm:max-w-[10rem]">{who}</span>
          {where && (
            <span className="hidden max-w-[11rem] shrink-0 truncate sm:inline" title={where} data-testid="wake-milestone">
              {where}
            </span>
          )}
          <span className="shrink-0">
            <RelTime iso={r.startedAt} />
          </span>
          {r.seat && (
            <span className="hidden shrink-0 md:inline" data-testid="wake-seat">
              {r.seat}
            </span>
          )}
          {cost != null && (
            <span className="hidden shrink-0 tabular-nums md:inline" data-testid="wake-cost">
              {formatUsd(cost)}
              {r.usage ? "" : " so far"}
            </span>
          )}
          {kids > 0 && (
            <span className="hidden shrink-0 lg:inline" title={`${kids} child run${kids === 1 ? "" : "s"}`}>
              ↳{kids}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-foreground/80" data-testid="wake-summary">
            {r.summary.split("\n")[0]}
          </span>
        </button>
      </li>
      {open && <RunRow node={node} depth={0} milestones={milestones} personas={personas} assignments={assignments} />}
    </>
  );
}

function RunRow({
  node,
  depth,
  milestones,
  personas,
  assignments,
}: {
  node: RunNode;
  depth: number;
  milestones: Milestone[];
  personas: Persona[];
  assignments: Assignment[];
}) {
  const r: Run = node.run;
  const m = milestones.find((x) => x.id === r.milestoneId);
  const bootstrap = r.assignmentId.startsWith("bootstrap:");
  const orphan = isOrphanRun(r, assignments);
  const persona = personas.find((p) => p.id === runPersonaId(r, assignments));
  const who = bootstrap ? "bootstrap" : persona?.name ?? (orphan ? "deleted assignment" : "persona");
  return (
    <>
      <li
        className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 border-b px-4 py-3 last:border-0", depth > 0 && "bg-muted/30")}
        style={{ paddingLeft: 16 + depth * 24 }}
        data-testid="run-row"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {depth > 0 && <span className="font-medium text-foreground">↳ child run</span>}
          {isAnswerRun(r) && <Badge variant="blue" title={`A turn ${ownerName()} started in the home thread via Send to; not a wake`}>answer run</Badge>}
          {depth > 0 ? <OutcomeBadge outcome={r.outcome} run={r} /> : <RunOutcomeChip run={r} personaName={persona?.name} />}
          <span className="font-medium text-foreground">{who}</span>
          {orphan && (
            <Badge variant="gray" title={r.assignmentId}>
              assignment deleted
            </Badge>
          )}
          {m ? (
            <Link className="min-w-0 max-w-full truncate hover:text-foreground hover:underline" to={`/milestones/${m.id}?tab=activity`}>
              {milestoneName(m)}
            </Link>
          ) : (
            r.milestoneId && <span className="font-mono">{r.milestoneId}</span>
          )}
          <RelTime iso={r.startedAt} />
          {r.seat && <span>{r.seat}</span>}
          <UsageChip usage={r.usage} live={r.usageLive} />
          {r.threadId && (
            <ThreadLink className="inline-flex items-center gap-1 hover:text-foreground hover:underline" threadId={r.threadId} environmentId={r.environmentId} title={r.threadId}>
              {depth > 0 ? "child thread" : "thread"} <ExternalLink className="h-3 w-3" />
            </ThreadLink>
          )}
          <RunControls run={r} workers={node.children.filter((c) => c.run.outcome === "running").length} who={depth > 0 ? undefined : persona?.name} />
          {r.milestoneId && runTicketId(r) && <DiscussButton milestoneId={r.milestoneId} row={runTicketId(r)!} run={r.id} />}
        </div>
        <RunNote text={r.instructions} by={r.instructionsBy} ack={r.noteAck} />
        {r.summary && <ClampText className="text-sm" text={r.summary} milestoneId={r.milestoneId} />}
        <WokeBecause run={r} />
        <RuleBrokenLines run={r} />
        <RunChecks checks={r.checks} remote={m?.remote} />
      </li>
      {node.children.map((c) => (
        <RunRow key={c.run.id} node={c} depth={depth + 1} milestones={milestones} personas={personas} assignments={assignments} />
      ))}
    </>
  );
}
