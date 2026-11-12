import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type OrphanCommitItem } from "@/api";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { LimitControl, ListPane, useListLimit } from "@/components/listPane";
import { useProject } from "@/lib/project";

/**
 * commits on a tracked repo's main that name no ticket (row code or spine path).
 * The Delivery Manager's wake gets the same list and names each commit in the row it belongs to; a commit a spine names
 * drops off. Folded by default; nothing renders when every commit names its ticket (L-39: count in the header, one line
 * per commit, Show 20 / 50 / all).
 */
export function OrphanCommits() {
  const [limit, setLimit] = useListLimit("orphan-commits");
  // inside Epic Social the list follows the selected project; narrowed, it asks for every
  // item and cuts to the limit here, so the count is the project's.
  const project = useProject();
  const narrowed = !!project.current;
  const { data, error } = useQuery(() => api.listOrphanCommits(narrowed ? undefined : limit || undefined), [limit, narrowed]);
  const [open, setOpen] = useSectionOpen("orphan-commits", false);
  const mine = (data?.items ?? []).filter((i) => project.keep(i.milestoneId));
  const items = narrowed && limit ? mine.slice(0, limit) : mine;
  const total = narrowed ? mine.length : (data?.total ?? items.length);
  if (error || !items.length) return null;
  return (
    <FoldSection
      title="Changes with no task"
      count={total}
      testId="orphan-commits"
      open={open}
      onToggle={setOpen}
      actions={<LimitControl limit={limit} onChange={setLimit} total={total} testId="orphan-commits" />}
    >
      <div className="grid gap-3 text-sm">
        <p className="text-xs text-muted-foreground">These changes reached the main branch without naming the task they belong to. The Delivery manager links each one to its task on its next wake.</p>
        <ListPane shown={items.length} total={total} testId="orphan-commits" className="gap-1">
          {items.map((i) => (
            <OrphanLine key={i.sha} item={i} />
          ))}
        </ListPane>
      </div>
    </FoldSection>
  );
}

/** One commit cut to one line (full text on hover); a click opens it in full (phones have no hover). */
function OrphanLine({ item: i }: { item: OrphanCommitItem }) {
  const [full, setFull] = useState(false);
  return (
    <li className="grid min-w-0" data-testid="orphan-commits-item">
      <button
        type="button"
        className={cn("flex min-w-0 items-baseline gap-x-2 text-left", !full && "whitespace-nowrap")}
        title={`${i.repo} ${i.short} · ${i.author} · ${i.date.slice(0, 16).replace("T", " ")}: ${i.subject}`}
        aria-expanded={full}
        onClick={() => setFull(!full)}
      >
        <span className="shrink-0 font-mono text-xs">{i.short}</span>
        <span className={cn("min-w-0 flex-1", full ? "break-words" : "truncate")}>{i.subject}</span>
      </button>
      {full && (
        <span className="text-xs text-muted-foreground">
          <Link className="underline" to={`/milestones/${i.milestoneId}`}>
            {i.repo}
          </Link>{" "}
          · {i.author} · {i.date.slice(0, 16).replace("T", " ")} UTC
        </span>
      )}
    </li>
  );
}
