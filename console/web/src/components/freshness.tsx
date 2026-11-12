import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type RefreshResult, type RepoFreshness } from "@/api";
import { invalidate, mutate, useQuery } from "@/lib/data";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RelTime } from "@/components/common";
import { mainHost } from "../lib/identity";

/** re-fetch the page this long after an open whose pull had not landed yet. */
export const PULLING_RECHECK_MS = 3_000;

/** "6 min" under an hour, else "N h". */
export const lagText = (min: number) => (min < 60 ? `${min} min` : `${Math.round(min / 60)} h`);

const behindText = (f: RepoFreshness) => (f.behind ? ` · ${f.behind} commit${f.behind === 1 ? "" : "s"} behind` : "");

/**
 * milestone header: `Synced from GitHub 40 s ago · <sha7>` (+ `N commits behind`), amber when the last pull
 * failed or the tree is dirty/diverged (reason on hover); Refresh pulls the repo and reloads the page's data. Also the
 * Current State's age, amber when a child spine or ticket was committed after its `Verified at`.
 */
export function FreshnessLine({ milestoneId }: { milestoneId: string }) {
  const { data: f } = useQuery(() => api.getFreshness(milestoneId), [milestoneId]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  // The open's pull is still running (it waited 3 s): re-fetch everything once it should have landed.
  useEffect(() => {
    if (!f?.pulling) return;
    const t = setTimeout(invalidate, PULLING_RECHECK_MS);
    return () => clearTimeout(t);
  }, [f?.pulling, f?.syncedAt]);
  if (!f) return null;
  const amber = !!f.error || !!f.behind;
  const refresh = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const r: RefreshResult = await mutate(() => api.refreshMilestone(milestoneId));
      setNote(r.rateLimited ? "just refreshed, try again in a few seconds" : r.error ? `pull failed: ${r.error}` : r.pulled ? "pulled" : "already in line");
    } catch (e) {
      setNote(`refresh failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const n = f.narrative;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs" data-testid="freshness">
      <span
        data-testid="freshness-line"
        data-state={f.error ? "failed" : f.behind ? "behind" : "fresh"}
        className={cn(amber && "text-amber-600 dark:text-amber-400")}
        title={f.error ?? (f.behind ? `${mainHost()}'s checkout of ${f.repo} is behind origin/main` : `${mainHost()}'s checkout of ${f.repo} matches GitHub as of the last fetch`)}
      >
        Synced from GitHub {f.syncedAt ? <RelTime iso={f.syncedAt} /> : "never"}
        {f.sha ? <span className="font-mono"> · {f.sha.slice(0, 7)}</span> : null}
        {behindText(f)}
        {f.error ? " · not in line" : ""}
        {f.pulling ? " · pulling…" : ""}
      </span>
      <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs" onClick={refresh} disabled={busy} title="Pull this repo from GitHub now and reload">
        <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} /> Refresh
      </Button>
      {note && <span className="text-muted-foreground" data-testid="refresh-note">{note}</span>}
      {n?.behindMinutes ? (
        <span
          className="text-amber-600 dark:text-amber-400"
          data-testid="narrative-age"
          title={`Verified at ${n.verifiedAt ? formatDateTime(n.verifiedAt) : "—"}; newest child commit ${n.childCommitAt ? formatDateTime(n.childCommitAt) : "—"}. The next Delivery Manager wake refreshes it.`}
        >
          Current State is {lagText(n.behindMinutes)} behind its children
        </span>
      ) : n?.verifiedAt ? (
        <span className="text-muted-foreground" data-testid="narrative-age">
          Current State verified <RelTime iso={n.verifiedAt} />
        </span>
      ) : null}
    </span>
  );
}

/** Team footer: the oldest 'synced' time over the repos with an unsettled milestone (no per-item pull). */
export function SyncFooter() {
  const { data } = useQuery(() => api.getFreshnessSummary(), []);
  if (!data?.oldestSyncedAt) return null;
  const oldest = data.repos.find((r) => r.syncedAt === data.oldestSyncedAt);
  const off = data.repos.filter((r) => r.error || r.behind);
  return (
    <p className="mt-6 text-xs text-muted-foreground" data-testid="sync-footer" title={data.repos.map((r) => `${r.repo}: ${r.syncedAt ?? "never"}${behindText(r)}${r.error ? ` · ${r.error}` : ""}`).join("\n")}>
      Oldest sync from GitHub: <RelTime iso={data.oldestSyncedAt} />
      {oldest ? ` (${oldest.repo})` : ""} · {data.repos.length} repo{data.repos.length === 1 ? "" : "s"}
      {off.length ? <span className="text-amber-600 dark:text-amber-400"> · not in line: {off.map((r) => r.repo).join(", ")}</span> : null}
    </p>
  );
}
