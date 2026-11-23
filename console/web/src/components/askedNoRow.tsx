import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type AskedNoRowItem } from "@/api";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { LimitControl, ListPane, useListLimit } from "@/components/listPane";
import { useProject } from "@/lib/project";
import { FoldChevron } from "@/components/foldChevron";

/**
 * "Asked, no row yet" on the Team home. Open Done-means lines in runnable epics that no ledger row
 * covers: asked for, but no wake builds them until a row exists (sat like that). The Delivery manager's
 * wakes get the same list and plan a row for each. Folded by default; nothing renders when every line has a row.
 * open, one line per Done-means line under a one-line epic heading, in the shared scroll pane; Show 20 /
 * 50 / all is what the server sends (`?limit=`), the count is its total.
 */
export function AskedNoRow() {
  const [limit, setLimit] = useListLimit("asked-no-row");
  // inside Epic Social the list follows the selected project; narrowed, it asks for every
  // item and cuts to the limit here, so the count is the project's.
  const project = useProject();
  const narrowed = !!project.current;
  const { data, error } = useQuery(() => api.listAskedNoRow(narrowed ? undefined : limit || undefined), [limit, narrowed]);
  const [open, setOpen] = useSectionOpen("asked-no-row", false);
  const mine = (data?.items ?? []).filter((i) => project.keep(i.milestoneId));
  const items = narrowed && limit ? mine.slice(0, limit) : mine;
  const total = narrowed ? mine.length : (data?.total ?? items.length);
  if (error || !items.length) return null;
  const groups = new Map<string, AskedNoRowItem[]>();
  for (const i of items) groups.set(`${i.milestoneId}\0${i.path}`, [...(groups.get(`${i.milestoneId}\0${i.path}`) ?? []), i]);
  return (
    <FoldSection
      title="Asked, no row yet"
      count={total}
      testId="asked-no-row"
      open={open}
      onToggle={setOpen}
      actions={<LimitControl limit={limit} onChange={setLimit} total={total} testId="asked-no-row" />}
    >
        <div className="grid gap-3 text-sm">
          <p className="text-xs text-muted-foreground">Done-means lines in running epics with no ledger row building them. The Delivery manager plans a row for each on its next wake.</p>
          <ListPane shown={items.length} total={total} testId="asked-no-row" className="gap-2">
            {[...groups.values()].map((g) => (
              <li key={`${g[0].milestoneId}:${g[0].path}`} className="grid min-w-0 gap-0.5" data-testid="asked-no-row-group">
                <Link className="truncate text-xs text-muted-foreground underline" to={`/milestones/${g[0].milestoneId}`} title={`${g[0].spineTitle} · ${g[0].path}`}>
                  {g[0].spineTitle} · {g[0].path}
                </Link>
                {g.map((i) => (
                  <AskedLine key={i.id} item={i} />
                ))}
              </li>
            ))}
          </ListPane>
        </div>
    </FoldSection>
  );
}

/** one Done-means line cut to one line (full text on hover); a click opens it in full (phones have no hover). */
function AskedLine({ item: i }: { item: AskedNoRowItem }) {
  const [full, setFull] = useState(false);
  return (
    <button
      type="button"
      className={cn("flex min-w-0 items-baseline gap-x-2 text-left", !full && "whitespace-nowrap")}
      data-testid="asked-no-row-item"
      title={`${i.id} ${i.text}`}
      aria-expanded={full}
      onClick={() => setFull(!full)}
    >
      <FoldChevron open={full} className="self-center" />
      <span className="shrink-0 font-medium">{i.id}</span>{" "}
      <span className={cn("min-w-0 flex-1", full ? "break-words" : "truncate")}>{i.text}</span>
    </button>
  );
}
