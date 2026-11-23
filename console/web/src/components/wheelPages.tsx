import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { api } from "@/api";
import type { HomeEntry, HomeTabBody, PagesBody, PageView } from "@/api/pages-types";
import { useQuery } from "@/lib/data";
import { homeFileUrl } from "@/lib/wheelPages";
import { LimitControl, ListPane, limitList, useListLimit } from "@/components/listPane";
import { useRoutes } from "@/lib/skin";
import { PAGES_PATH } from "@/lib/routePaths";

/** the page list (GET /api/pages), read for a wheel's Pages tab without loading the Pages screen's code. */
export const useWheelPages = () => useQuery<PagesBody>(() => api.listPages(), []);

/**
 * A wheel's Pages tab (the owner, vn_dad96778): the pages made for this objective or milestone, newest row first,
 * each opening the page; the global Pages list (one tap away) still holds every page together.
 */
export function WheelPagesTab({ pages, loading, what, files }: { pages: PageView[]; loading?: boolean; what: string; files?: { entries: HomeEntry[]; loading?: boolean } }) {
  // the global list is a console screen; where the skin hides it, the tab stands alone.
  const all = useRoutes()("book");
  const sorted = [...pages].sort((a, b) => b.row.localeCompare(a.row, undefined, { numeric: true }) || (b.port ?? 0) - (a.port ?? 0));
  return (
    <section className="grid gap-3" data-testid="wheel-pages" data-count={pages.length}>
      <p className="text-sm text-muted-foreground" data-testid="wheel-pages-answer" data-total={pages.length + (files?.entries.length ?? 0)}>
        {loading && !pages.length ? "Reading the pages…" : pagesAnswer(pages.length, files?.entries.length, what)}{" "}
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
      {files && <HomeFilesList entries={files.entries} loading={files.loading} title="Pages and notes kept in the repo" empty={`No page or note in the repo was made for this ${what} yet.`} testId="wheel-page-files" />}
    </section>
  );
}

/**
 * The tab's one-line answer counts everything it lists (the owner: "Pages shows every file
 * homed there"): the served pages and the pages and notes kept in the repo, so the number never shows fewer.
 */
export function pagesAnswer(served: number, kept: number | undefined, what: string): string {
  const total = served + (kept ?? 0);
  if (!total) return `No page was made for this ${what} yet.`;
  if (!kept) return `${served} ${served === 1 ? "page was" : "pages were"} made for this ${what}.`;
  return `${total} pages and notes were made for this ${what}: ${served} served, ${kept} kept in the repo.`;
}

/** the files a wheel tab homes (GET /api/homes/:product/:tab), read once for the tab. */
export const useHomeTab = (product: string | undefined, tab: string) =>
  useQuery<HomeTabBody | undefined>(() => (product ? api.homeTab(product, tab) : Promise.resolve(undefined)), [product, tab]);

const KIND: Record<HomeEntry["kind"], string> = { page: "page", note: "note", folder: "pictures" };
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

/**
 * The files a tab homes (the owner: "History and Pages show every file homed there"): newest first, one line
 * each (its date, its name, page / note / pictures, the row that made it), each opening the file read-only.
 */
export function HomeFilesList({ entries, loading, title, empty, testId }: { entries: HomeEntry[]; loading?: boolean; title: string; empty: string; testId: string }) {
  const [limit, setLimit] = useListLimit(testId);
  const sorted = [...entries].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  const shown = limitList(sorted, limit);
  return (
    <section className="grid gap-2" data-testid={testId} data-count={entries.length}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">
          {title} <span className="font-normal tabular-nums text-muted-foreground">{entries.length}</span>
        </h3>
        <LimitControl limit={limit} onChange={setLimit} total={sorted.length} testId={testId} />
      </div>
      {loading && !entries.length ? (
        <p className="text-sm text-muted-foreground">Reading the files…</p>
      ) : !entries.length ? (
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>{empty}</p>
      ) : (
        <ListPane shown={shown.length} total={sorted.length} testId={testId} className="gap-0 divide-y rounded-xl border bg-card">
          {shown.map((e) => (
            <li key={e.id} className="min-w-0" data-testid={`${testId}-row`}>
              <a href={homeFileUrl(e)} target="_blank" rel="noreferrer" className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2 hover:bg-accent" title={`${e.repo} ${e.open}`}>
                <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{day(e.date)}</span>
                <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{e.title}</span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{KIND[e.kind]}</span>
                {e.row && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{e.row}</span>}
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ListPane>
      )}
    </section>
  );
}
