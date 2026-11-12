import { useState } from "react";
import { Link } from "react-router-dom";
import { Stamp, Undo2 } from "lucide-react";
import { api, type NextWakeItem, type StampTo } from "@/api";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { mutate, useQuery } from "@/lib/data";
import { zoned } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/project";

/**
 * the owner stamps a Planning (draft) epic ready for delivery, or moves a ready one back to Planning. The
 * server writes Status + a Decisions row and refuses any call that is not the owner's browser page (403 for personas).
 * Mark ready is the primary (filled) button so it stands out; Move back stays secondary; a refusal shows under it.
 */
export function StampButton({ milestoneId, path, to, className }: { milestoneId: string; path?: string; to: StampTo; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const click = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await mutate(() => api.stampMilestone(milestoneId, { to, ...(path ? { path } : {}) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button
        type="button"
        size="sm"
        variant={to === "ready" ? "default" : "outline"}
        className={cn("gap-1 text-xs", to === "ready" ? "h-8 px-3 font-semibold" : "h-7 px-2")}
        disabled={busy}
        onClick={click}
        data-testid={to === "ready" ? "stamp-ready" : "stamp-draft"}
        title={to === "ready" ? "Write Status: ready (only you can): the next standing wake may start it" : "Write Status: draft: no wake works it"}
      >
        {to === "ready" ? <Stamp className="h-3.5 w-3.5" /> : <Undo2 className="h-3.5 w-3.5" />}
        {busy ? "Writing…" : to === "ready" ? "Mark ready for delivery" : "Move back to Planning"}
      </Button>
      {error && (
        <span role="alert" className="max-w-sm rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300" data-testid="stamp-error">
          {to === "ready" ? "Not marked ready" : "Not moved back"}: {error}
        </span>
      )}
    </span>
  );
}

/** Grey "Planning" / "Parked" word of a spine node (spines.py run_state, as the server sent it). */
export function HoldWord({ runState }: { runState?: string }) {
  if (runState !== "planning" && runState !== "parked") return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground" data-testid="hold-word" data-state={runState}>
      <span className="inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600" aria-hidden />
      {runState === "planning" ? "Planning" : "Parked"}
    </span>
  );
}

/**
 * "Next wake picks up": every ready epic and ready row the next standing wake will start, with the persona and
 * its wake time. the owner's guard rail: he sees what he is about to release. One milestone (Tree tab) or all (Team home).
 */
export function NextWakeList({ milestoneId, now = Date.now() }: { milestoneId?: string; now?: number }) {
  const q = useQuery(() => api.nextWake(milestoneId), [milestoneId]);
  // on the Team home of the social skin the list follows the selected project (its milestones, and any no project
  // owns); one milestone's own list (its page) shows all of it.
  const project = useProject();
  const items = (q.data?.items ?? []).filter((i) => milestoneId || project.keep(i.milestoneId));
  const groups = new Map<string, NextWakeItem[]>();
  for (const i of items) groups.set(i.milestoneId, [...(groups.get(i.milestoneId) ?? []), i]);
  return (
    <section className="mb-4 rounded-lg border px-4 py-2.5 text-sm" data-testid="next-wake">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next wake picks up</h3>
      {q.loading && !q.data && <p className="text-muted-foreground">…</p>}
      {q.data && items.length === 0 && (
        <p className="text-muted-foreground" data-testid="next-wake-empty">
          Nothing is stamped ready
        </p>
      )}
      <ul className="grid gap-1">
        {[...groups.values()].map((list) => (
          <li key={list[0].milestoneId} className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-1.5" title={zoned(list[0].at)}>
              {!milestoneId && (
                <Link to={`/milestones/${list[0].milestoneId}?tab=tree`} className="font-medium hover:underline">
                  {list[0].milestoneTitle}
                </Link>
              )}
              <span className="text-muted-foreground">
                {list[0].persona} · next wake {formatRelative(list[0].at, new Date(now))}
              </span>
            </div>
            <ul className="ml-3 grid gap-0.5">
              {list.map((i) => (
                <li key={i.nodeKey} className="flex min-w-0 items-baseline gap-1.5" data-testid="next-wake-item" data-kind={i.kind}>
                  <span className="shrink-0 text-[10px] font-semibold uppercase text-muted-foreground">{i.kind}</span>
                  {/* a long epic slug wraps anywhere; unbroken it made the Team home 616 px wide on a 390 px phone
                      (and pushed every dialog off screen). */}
                  <span className="min-w-0 max-w-[45%] break-all font-mono text-xs" data-testid="next-wake-id">{i.id}</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{i.title}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
