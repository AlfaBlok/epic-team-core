import { api, type Milestone } from "@/api";
import { ApprovalsTab } from "@/components/approvals";
import { Empty, ErrorBox, Loading } from "@/components/common";
import { Switch } from "@/components/ui/switch";
import { mutate, useQuery } from "@/lib/data";
import { personasOfObjective } from "@/lib/objectivePersonas";
import { ActivityTab, PersonasTab } from "@/pages/Milestone";

/**
 * One objective, one screen (the owner, vn_748ec5a1): "It's like we have
 * two contexts, like two dashboards for one objective ... I never approved that." The objective's Personas tab switches
 * its personas on or off in place (the same controls the old milestone page had), with their runs and the pause switch
 * under them; the old milestone page now sends every link here (pages/Milestone.tsx objectiveOf).
 */
export function ObjectivePersonas({
  milestoneId,
  objective,
  fallback,
}: {
  milestoneId?: string;
  /** the objective whose page this is: only its own personas show. */
  objective?: { id: string; shared?: boolean };
  /** shown when no milestone and no persona names the objective. */
  fallback?: React.ReactNode;
}) {
  // an objective whose epics sit under no milestone of its own (one on another repo's spine) wakes its personas on the milestone they name
  const { data: all = [], loading: listing } = useQuery(() => (objective ? api.listAssignments() : Promise.resolve([])), [objective?.id]);
  const msId = milestoneId ?? (objective ? personasOfObjective(all, { id: objective.id })[0]?.milestoneId : undefined);
  const { data: m, error, loading } = useQuery(() => (msId ? api.getMilestone(msId) : Promise.resolve(undefined)), [msId]);
  // no milestone and no persona naming it (yet): the objective's own teams list, once the assignments are read
  if (!msId) return listing ? <Loading /> : fallback ? <>{fallback}</> : <Empty>No personas here yet.</Empty>;
  if (error) return <ErrorBox error={error} />;
  if (loading && !m) return <Loading />;
  if (!m) return fallback ? <>{fallback}</> : <Empty>No personas here yet.</Empty>;
  const only = objective ? personasOfObjective(all, { id: objective.id, milestoneId: m.id, shared: objective.shared }).map((a) => a.id) : undefined;
  return (
    <div className="grid gap-6" data-testid="objective-personas">
      <PersonasTab m={m} objective={objective} />
      {/* pausing a milestone other objectives share would stop their personas too: their own switches above do it */}
      {!objective?.shared && <PauseLine m={m} />}
      <details className="group rounded-xl border bg-card/50" data-testid="objective-runs">
        <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm text-muted-foreground hover:text-foreground">Their runs</summary>
        <div className="p-3 pt-0">
          <ActivityTab m={m} only={only} />
        </div>
      </details>
    </div>
  );
}

/** pausing stops every persona wake for this objective's personas (was the old page's Settings tab). */
function PauseLine({ m }: { m: Milestone }) {
  return (
    <label className="flex min-w-0 items-center justify-between gap-4 rounded-xl border bg-card p-3" data-testid="objective-pause">
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium">Pause every persona here</span>
        <span className="text-xs text-muted-foreground">While paused, none of them wakes.</span>
      </span>
      <Switch checked={m.paused} onCheckedChange={(v) => mutate(() => api.updateMilestone(m.id, { paused: v }))} />
    </label>
  );
}

/** the standing approvals (yeses given up front) of the objective's spine, on its Context tab (was the old page's Approvals tab). */
export function ObjectiveApprovals({ milestoneId }: { milestoneId: string }) {
  const { data: m, error } = useQuery(() => api.getMilestone(milestoneId), [milestoneId]);
  if (error) return <ErrorBox error={error} />;
  if (!m) return null;
  return (
    <details className="group rounded-xl border bg-card/50" data-testid="objective-approvals">
      <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm text-muted-foreground hover:text-foreground">Standing approvals</summary>
      <div className="p-3 pt-0">
        <ApprovalsTab m={m} />
      </div>
    </details>
  );
}
