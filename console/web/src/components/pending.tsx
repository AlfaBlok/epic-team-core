import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, MessageSquarePlus } from "lucide-react";
import { api, type Milestone, type PendingItem } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { milestoneName } from "@/lib/format";
import { groupPending, pendingAction } from "@/lib/pending";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useProject } from "@/lib/project";
import { Card } from "@/components/ui/card";
import { Empty, ErrorBox, Loading, RelTime } from "@/components/common";
import { ownerName } from "@/lib/identity";

/**
 * Pending selector: everything pending across projects, one list from GET /api/status `items`, grouped Needs you
 * / Ready to mark / Stalled / Failed or unreported runs. Its count is the batch's `needsYou`, the same number as the
 * Team badge. A free-text ask (the owner named, no coded ask) is amber "ask not in console format": Rewrite as a coded ask
 * sends the Delivery Manager the rewrite instruction; the spine link opens the line.
 * no longer on the Team home (it repeated "Waiting on you"; its status-only rows show there as rows).
 */
export function PendingSelector() {
  const { data: all, error, loading } = useQuery(() => api.listStatus(), [], { tag: "inbox" });
  // the selected project's pending items only.
  const project = useProject();
  const data = all && project.current ? { ...all, items: all.items.filter((i) => project.keep(i.milestoneId)) } : all;
  const { data: milestones } = useQuery(() => api.listMilestones(), []);
  const groups = groupPending(data?.items);
  const count = project.current ? new Set((data?.items ?? []).filter((i) => i.state === "open").map((i) => i.id)).size : (data?.needsYou ?? 0);
  const byId = new Map((milestones ?? []).map((m) => [m.id, m]));
  return (
    <section className="mb-6" data-testid="pending-selector">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Pending
        {data?.loading ? (
          <span className="rounded-full bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground" data-testid="pending-count-loading" title="counting… (the console just restarted)">
            …
          </span>
        ) : (
          <span className={cn("rounded-full px-1.5 text-[11px] leading-5", count > 0 ? "bg-amber-500 text-white" : "bg-muted text-muted-foreground")} data-testid="pending-count" title="open items for you (the Team badge)">
            {count}
          </span>
        )}
      </h2>
      {error && <ErrorBox error={error} />}
      {loading && !data && <Loading />}
      {data?.loading && <Loading />}
      {data && !data.loading && groups.length === 0 && <Empty>Nothing pending.</Empty>}
      {groups.length > 0 && (
        <Card className="min-w-0 divide-y [overflow-wrap:anywhere]">
          {groups.map((g) => (
            <div key={g.key} className="grid grid-cols-1 gap-1 p-3" data-testid={`pending-group-${g.key}`}>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {g.label} ({g.items.length})
              </div>
              <ul className="grid grid-cols-1 gap-1">
                {g.items.map((i) => (
                  <PendingRow key={i.id} item={i} milestone={byId.get(i.milestoneId)} />
                ))}
              </ul>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

/** below sm the row stacks (text full width, action under it, right-aligned) with a 44 px tap target. */
const PENDING_ACTION = "shrink-0 max-sm:min-h-11 max-sm:self-end max-sm:px-4 max-sm:text-sm";

function PendingRow({ item, milestone }: { item: PendingItem; milestone?: Milestone }) {
  const action = pendingAction(item);
  const free = item.kind === "free_text_ask";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string }>();
  const rewrite = async (r: { milestoneId: string; path: string }) => {
    setBusy(true);
    setResult(undefined);
    try {
      const m = await mutate(() => api.requestAsks({ ...r, to: "delivery-manager" }));
      setResult(m.delivery === "sent" ? { ok: true, msg: "Sent to the Delivery Manager." } : { ok: false, msg: `Not delivered: ${m.deliveryError ?? m.delivery}` });
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const project = [item.repo, milestone ? milestoneName(milestone) : undefined].filter(Boolean).join(" · ");
  return (
    <li
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-sm max-sm:flex-col max-sm:items-stretch max-sm:gap-y-2 max-sm:py-2.5", free && "border border-amber-500/40 bg-amber-500/5", item.kind === "stalled" && "border border-orange-500/50 bg-orange-500/10")}
      data-testid="pending-item"
      data-kind={item.kind}
    >
      <span className="grid min-w-0 flex-1 gap-0.5 max-sm:flex-none">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          {item.code && <span className="shrink-0 font-mono text-xs font-semibold">{item.code}</span>}
          <span className="min-w-0 break-words">{item.title}</span>
          {free && (
            <Badge variant="amber" title={`${ownerName()} is named in the spine but no coded ask was written`} data-testid="free-text-badge">
              ask not in console format
            </Badge>
          )}
        </span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {project && (
            <Link className="hover:underline" to={`/milestones/${encodeURIComponent(item.milestoneId)}`}>
              {project}
            </Link>
          )}
          {item.since && <RelTime iso={item.since} />}
          {free && item.url && (
            <a className="inline-flex items-center gap-1 hover:underline" href={item.url} target="_blank" rel="noreferrer">
              open spine <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {result && <span className={result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>{result.msg}</span>}
        </span>
      </span>
      {"to" in action ? (
        <Button asChild size="sm" variant="outline" className={PENDING_ACTION}>
          <Link to={action.to}>{action.label}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="outline" className={PENDING_ACTION} disabled={busy || !!result?.ok} pending={busy} pendingLabel="Sending…" onClick={() => rewrite(action.rewrite)}>
          <MessageSquarePlus /> {action.label}
        </Button>
      )}
    </li>
  );
}
