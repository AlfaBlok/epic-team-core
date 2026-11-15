import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { api } from "@/api";
import type { PagesBody, PageView } from "@/api/pages-types";
import { useQuery } from "@/lib/data";
import { useRoutes } from "@/lib/skin";
import { PAGES_PATH } from "@/lib/routePaths";

/** the page list (GET /api/pages), read for a wheel's Pages tab without loading the Pages screen's code. */
export const useWheelPages = () => useQuery<PagesBody>(() => api.listPages(), []);

/**
 * A wheel's Pages tab (the owner, vn_dad96778): the pages made for this objective or milestone, newest row first,
 * each opening the page; the global Pages list (one tap away) still holds every page together.
 */
export function WheelPagesTab({ pages, loading, what }: { pages: PageView[]; loading?: boolean; what: string }) {
  // the global list is a console screen; where the skin hides it, the tab stands alone.
  const all = useRoutes()("book");
  const sorted = [...pages].sort((a, b) => b.row.localeCompare(a.row, undefined, { numeric: true }) || (b.port ?? 0) - (a.port ?? 0));
  return (
    <section className="grid gap-3" data-testid="wheel-pages" data-count={pages.length}>
      <p className="text-sm text-muted-foreground" data-testid="wheel-pages-answer">
        {loading && !pages.length
          ? "Reading the pages…"
          : pages.length
            ? `${pages.length} ${pages.length === 1 ? "page was" : "pages were"} made for this ${what}.`
            : `No page was made for this ${what} yet.`}{" "}
        {all && (
        <Link to={`/${PAGES_PATH}`} className="underline underline-offset-4 hover:text-foreground" data-testid="wheel-pages-all">
          Every page
        </Link>
        )}
      </p>
      {sorted.length > 0 && (
        <ul className="divide-y rounded-xl border bg-card">
          {sorted.map((p) => (
            <li key={p.url} className="min-w-0" data-testid="wheel-page">
              <a href={p.url} target="_blank" rel="noreferrer" className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2.5 hover:bg-accent" title={p.url}>
                <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{p.name || p.title || p.url}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{p.row}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
