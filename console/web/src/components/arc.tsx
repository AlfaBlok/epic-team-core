import { Link } from "react-router-dom";
import { api, type Arc } from "@/api";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";

const PLACE: Record<Arc["phases"][number]["place"], string> = { now: "Now", next: "Next", after: "After" };

/**
 * the project's arc, its three-phase plan (docs/arcs.md): three epics in order, the current one marked
 * "we are here". Quiet on purpose (docs/design/console.md): one panel, ink and grey, a filled dot for where we are.
 */
export function ArcView({ arc }: { arc: Arc }) {
  const proposal = arc.fileStatus && /proposal/i.test(arc.fileStatus);
  return (
    <section data-testid="arc" aria-label="The plan" className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold">The plan</h2>
        {proposal && <span className="text-xs text-muted-foreground">Proposed order, yours to change</span>}
      </div>
      {arc.aim && <p className="mt-1 text-sm text-muted-foreground">{arc.aim}</p>}
      <ol className="mt-4 grid gap-4 sm:grid-cols-3 sm:gap-6">
        {arc.phases.map((p, i) => {
          const here = p.place === "now";
          const title = p.title ?? p.code;
          return (
            <li key={`${p.repo}/${p.code}`} data-testid={`arc-${p.place}`} className="relative min-w-0 pl-6 sm:pl-0 sm:pt-6">
              {/* the dot on the line: filled ink where we are, hollow ahead */}
              <span
                aria-hidden
                className={cn("absolute left-0 top-1 h-3 w-3 rounded-full border border-foreground sm:top-0", here ? "bg-foreground" : "bg-card")}
              />
              {i < arc.phases.length - 1 && (
                <span aria-hidden className="absolute left-[5px] top-5 h-[calc(100%-4px)] w-px bg-border sm:left-5 sm:top-[5px] sm:h-px sm:w-[calc(100%+4px)]" />
              )}
              <div className={cn("text-xs font-medium", here ? "text-foreground" : "text-muted-foreground")}>
                {PLACE[p.place]}
                {here && " · we are here"}
              </div>
              <div className={cn("mt-1 text-sm", here ? "font-medium text-foreground" : "text-foreground")}>
                {p.href ? (
                  <Link to={p.href} className="underline-offset-2 hover:underline">
                    {title}
                  </Link>
                ) : (
                  title
                )}
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">{p.line}</p>
              <div className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono">{p.code}</span>
                {p.status ? ` · ${p.status}` : ""}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** the arc of a milestone, or nothing while it loads or when the project has none. */
export function MilestoneArc({ id }: { id: string }) {
  const { data } = useQuery(() => api.getMilestoneArc(id), [id]);
  return data?.arc ? <ArcView arc={data.arc} /> : null;
}
