import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, ExternalLink, Pencil, Pin, PinOff, RefreshCw, Search } from "lucide-react";
import { api } from "@/api";
import type { PageGroup, PagesBody, PageView, PinnedStatus } from "@/api/pages-types";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelative } from "@/lib/format";
import { mutate, useQuery } from "@/lib/data";
import { nameProblem, NAME_MAX, proposeName } from "@/lib/pageName";
import { cn } from "@/lib/utils";
import { PAGES_PATH } from "@/lib/routePaths";
import type { ScorecardsBody } from "@/api/pursuit-types";
import { indexScorecards, scorecardHref, SET_NAME } from "@/lib/scorecards";
import { placePages, wheelCounts, type PlacedPage } from "@/lib/wheelPages";
export { PAGES_PATH };

/**
 * No floating pages: every one-off page the team made (a summary, a report, a proposal, a mockup), by repo, then by
 * epic inside each repo, each linking down to the page. Repos and epics start folded; what he opens stays
 * open (localStorage). A search box filters repos, epics and pages as he types. Each page links back up here
 * (`#<repo>-<epic>`, which opens that repo and epic) and to its epic deck with the small header its page server
 * adds; each epic deck links down here. The repo file docs/pages/registry.json is the record; GET /api/pages reads it
 * (server/src/pagesIndex.ts). Reached from the top bar (Pages, beside One-offs) and the menu.
 */
const OPEN_STORE = "pages.open";

export function usePages() {
  return useQuery<PagesBody>(() => api.listPages(), []);
}

/** where an epic deck links down to: its group on the Pages list, or nothing when it has no pages. */
export function epicPagesLink(data: PagesBody | undefined, repo: string, epic: string): { href: string; count: number } | null {
  const g = data?.groups.find((x) => x.repo === repo && x.epic === epic);
  return g && g.pages.length ? { href: `/${PAGES_PATH}#${g.id}`, count: g.pages.length } : null;
}

const repoKey = (repo: string) => `repo:${repo}`;

function readOpen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(OPEN_STORE);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeOpen(open: Set<string>) {
  try {
    window.localStorage.setItem(OPEN_STORE, JSON.stringify([...open]));
  } catch {
    /* private mode: the folds just do not persist. */
  }
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase();

/** the groups and pages the search keeps: a repo or epic that matches keeps all its pages; else only matching pages. */
export function filterGroups(groups: PageGroup[], q: string): PageGroup[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const hit = (...fields: (string | undefined)[]) => {
    const hay = fields.map(norm).join(" ");
    return words.every((w) => hay.includes(w));
  };
  const out: PageGroup[] = [];
  for (const g of groups) {
    if (hit(g.repo, g.epic, g.epicTitle)) {
      out.push(g);
      continue;
    }
    const pages = g.pages.filter((p: PageView) => hit(g.repo, g.epic, g.epicTitle, p.name, p.title, p.url, p.row));
    if (pages.length) out.push({ ...g, pages });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Fold({ open, onToggle, className, children, testId }: { open: boolean; onToggle: () => void; className?: string; children: React.ReactNode; testId: string }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className={cn("flex min-h-[40px] w-full min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-accent md:min-h-[32px]", className)} data-testid={testId}>
      <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      {children}
    </button>
  );
}

/**
 * The box that names a page when it is pinned or renamed. It offers a plain name from the
 * page's title, he keeps or changes it; Save writes `pinned` and `name` to docs/pages/registry.json (one commit).
 */
export function NameForm({ p, onDone, label }: { p: PageView; onDone: () => void; label: string }) {
  const [name, setName] = useState(p.name || proposeName(p.title));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const why = nameProblem(name);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (why) return setErr(why);
    setBusy(true);
    setErr("");
    try {
      await mutate(() => api.pinPage({ ...(p.port !== undefined ? { port: p.port } : { url: p.url }), pinned: true, name: name.trim() }));
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="grid w-full gap-1.5 py-1" data-testid="pages-name-form">
      <label className="text-xs text-muted-foreground" htmlFor={`pin-name-${p.port ?? p.url}`}>
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={`pin-name-${p.port ?? p.url}`} autoFocus value={name} maxLength={NAME_MAX + 10} onChange={(e) => (setName(e.target.value), setErr(""))} className="min-w-0 flex-1 basis-40" data-testid="pages-name-input" />
        <Button type="submit" size="sm" disabled={busy} className="min-h-[40px] md:min-h-0" data-testid="pages-name-save">
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} className="min-h-[40px] md:min-h-0">
          Cancel
        </Button>
      </div>
      {err && (
        <span className="text-xs text-destructive" data-testid="pages-name-error">
          {err}
        </span>
      )}
    </form>
  );
}

/**
 * Every page sits in the wheel it was made for (vn_dad96778): one line per objective in his order with its pages,
 * opening that objective's Pages tab, then the pages no objective holds. The list below still holds them all together.
 */
function ByWheel({ placed, nodes }: { placed: PlacedPage[]; nodes: ScorecardsBody["nodes"] }) {
  const wheels = wheelCounts(placed, nodes);
  const loose = placed.filter((p) => !p.wheel).length;
  if (!placed.length) return null;
  return (
    <section className="grid gap-1.5" data-testid="pages-by-wheel" aria-label={`By ${SET_NAME.one.toLowerCase()}`}>
      <h2 className="text-sm font-semibold text-foreground">By {SET_NAME.one.toLowerCase()}</h2>
      <ul className="divide-y rounded-xl border bg-card">
        {wheels.map((w) => (
          <li key={w.id} data-testid="pages-wheel" data-wheel={w.id}>
            <Link to={scorecardHref(w.id, "pages")} className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2 hover:bg-accent">
              <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{w.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{plural(w.count, "page")}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
        <li className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2" data-testid="pages-not-placed">
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">Not placed: its row sits in no {SET_NAME.one.toLowerCase()}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{plural(loose, "page")}</span>
        </li>
      </ul>
    </section>
  );
}

function PageRow({ p, wheel }: { p: PageView; wheel?: PlacedPage["wheel"] | null }) {
  const [naming, setNaming] = useState(false);
  return (
    <li className="grid min-w-0 text-sm" data-testid="pages-page">
      <div className="flex min-w-0 items-baseline gap-3">
        <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate py-1 text-foreground underline-offset-2 hover:underline" title={p.url}>
          {p.name || p.title || p.url}
        </a>
        {wheel !== undefined && (
          <span className="hidden max-w-[12rem] shrink-0 truncate text-xs text-muted-foreground sm:inline" data-testid="pages-page-wheel" title={wheel ? `Made for ${wheel.name}` : "Not placed in an objective"}>
            {wheel ? <Link to={scorecardHref(wheel.id, "pages")} className="underline-offset-2 hover:text-foreground hover:underline">{wheel.name}</Link> : "Not placed"}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground" title="The row that made this page keeps its link">
          {p.row}
        </span>
        {p.pinned ? (
          <span className="shrink-0 text-xs text-muted-foreground" data-testid="pages-page-pinned">
            Pinned
          </span>
        ) : (
          !naming && (
            <button type="button" onClick={() => setNaming(true)} className="inline-flex min-h-[40px] shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground md:min-h-0" data-testid="pages-pin" aria-label={`Pin ${p.name || p.title}`}>
              <Pin className="h-3.5 w-3.5" />
              Pin
            </button>
          )
        )}
      </div>
      {naming && <NameForm p={p} label="Pin it under a name you will know it by" onDone={() => setNaming(false)} />}
    </li>
  );
}

function Group({ g, open, onToggle, wheelOf }: { g: PageGroup; open: boolean; onToggle: () => void; wheelOf?: Map<string, PlacedPage["wheel"] | null> }) {
  return (
    <section id={g.id} className="scroll-mt-16 grid gap-0.5" data-testid="pages-group" data-group={g.id} data-open={open ? "true" : "false"}>
      <div className="flex min-w-0 items-center gap-2">
        <Fold open={open} onToggle={onToggle} className="flex-1" testId="pages-group-toggle">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {g.epic}
            {g.epicTitle && <span className="font-normal text-muted-foreground">: {g.epicTitle}</span>}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="pages-group-count">
            {g.pages.length}
          </span>
        </Fold>
        <Link to={`/deck/${encodeURIComponent(g.repo)}/${encodeURIComponent(g.epic)}`} className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-testid="pages-deck-link">
          Epic deck
        </Link>
      </div>
      {open && (
        <ul className="ml-6 grid gap-0.5 border-l border-border pb-2 pl-3">
          {g.pages.map((p) => (
            <PageRow key={p.url} p={p} wheel={wheelOf?.get(p.url)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** where a pinned page opens: its short address on the console when it has one, else its own address. */
export const pinnedHref = (p: PageView) => (p.slug ? `/${p.slug}` : p.url);

/**
 * one pinned page: its name, when it last refreshed and a Refresh button that reruns its builder on the page
 * host (its timer keeps running). The pin, its name and its short address live in docs/pages/registry.json
 * (`scripts/pages.py pin <port> --name …`), never only here.
 */
function PinnedCard({ p }: { p: PageView }) {
  const [status, setStatus] = useState<PinnedStatus | null>(null);
  const port = p.port;
  useEffect(() => {
    if (port === undefined) return;
    let live = true;
    const read = () => api.pinnedPageStatus(port).then((s) => live && setStatus(s), () => undefined);
    // once on open; while it rebuilds, again every 10 s until the new page is there
    if (!status?.running) read();
    const t = status?.running ? window.setInterval(read, 10_000) : undefined;
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [port, !!status?.running]);
  const refresh = async () => {
    if (port === undefined) return;
    try {
      setStatus(await api.refreshPinnedPage(port));
    } catch (e) {
      setStatus((s) => ({ refreshedAt: s?.refreshedAt ?? null, refreshable: true, running: false, error: (e as Error).message }));
    }
  };
  const running = !!status?.running;
  const [renaming, setRenaming] = useState(false);
  const [unpinErr, setUnpinErr] = useState("");
  const unpin = async () => {
    try {
      await mutate(() => api.pinPage({ ...(p.port !== undefined ? { port: p.port } : { url: p.url }), pinned: false }));
    } catch (e) {
      setUnpinErr((e as Error).message);
    }
  };
  if (renaming)
    return (
      <li className="rounded-lg border bg-card p-3" data-testid="pages-pinned-page" data-port={p.port}>
        <NameForm p={p} label="Rename this pinned page" onDone={() => setRenaming(false)} />
      </li>
    );
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card p-3" data-testid="pages-pinned-page" data-port={p.port}>
      <a href={pinnedHref(p)} target="_blank" rel="noreferrer" className="grid min-w-0 flex-1 basis-48 gap-0.5" title={p.url}>
        <span className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          {p.name}
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </span>
        <span className="text-xs text-muted-foreground" data-testid="pages-pinned-refreshed">
          {running
            ? "Refreshing now…"
            : status?.refreshedAt
              ? `Refreshed ${formatRelative(status.refreshedAt)}`
              : status?.error
                ? "Last refresh unknown: the page host did not answer"
                : "Reading when it last refreshed…"}
        </span>
        {/* the address on its own line, wrapping, never cut off on a phone */}
        {p.slug && <span className="break-all text-xs text-muted-foreground" data-testid="pages-pinned-address">{window.location.host}/{p.slug}</span>}
        {/* the code that made it stays small, never the title */}
        {p.row && <span className="text-[11px] text-muted-foreground/80" data-testid="pages-pinned-row">made by {p.row}</span>}
        {unpinErr && <span className="text-xs text-destructive">{unpinErr}</span>}
      </a>
      {p.refresh && (
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={running} data-testid="pages-pinned-refresh" className="min-h-[40px] md:min-h-0">
          <RefreshCw className={cn("h-4 w-4", running && "animate-spin")} />
          Refresh
        </Button>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(true)} aria-label={`Rename ${p.name}`} title="Rename" data-testid="pages-pinned-rename" className="min-h-[40px] min-w-[40px] md:min-h-0">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={unpin} aria-label={`Unpin ${p.name}`} title="Unpin" data-testid="pages-pinned-unpin" className="min-h-[40px] min-w-[40px] md:min-h-0">
          <PinOff className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

function PinnedPages({ pages }: { pages: PageView[] }) {
  if (!pages.length) return null;
  return (
    <section className="grid gap-2" data-testid="pages-pinned" aria-label="Pinned">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Pin className="h-4 w-4" />
        Pinned
      </h2>
      <ul className="grid gap-2">
        {pages.map((p) => (
          <PinnedCard key={p.url} p={p} />
        ))}
      </ul>
    </section>
  );
}

export function PagesIndexPage() {
  const { data, error, loading } = usePages();
  // where each page sits: the objective its row (or its epic) is in, from the objectives' tree.
  const sets = useQuery<ScorecardsBody>(() => api.listScorecards(), []);
  const placed = useMemo(() => (data && sets.data ? placePages(data, sets.data, indexScorecards(sets.data)) : undefined), [data, sets.data]);
  const wheelOf = useMemo(() => (placed ? new Map(placed.map((p) => [p.url, p.wheel ?? null])) : undefined), [placed]);
  const { hash } = useLocation();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const target = hash ? decodeURIComponent(hash.slice(1)) : "";

  // a page's header (or an epic deck) links up to `#<repo>-<epic>`: open that repo and epic, then scroll to it.
  useEffect(() => {
    if (!target || !data) return;
    const g = data.groups.find((x) => x.id === target);
    if (g) {
      setOpen((prev) => {
        if (prev.has(g.id) && prev.has(repoKey(g.repo))) return prev;
        const next = new Set(prev).add(g.id).add(repoKey(g.repo));
        writeOpen(next);
        return next;
      });
    }
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "start" }));
  }, [target, data]);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeOpen(next);
      return next;
    });

  const searching = q.trim().length > 0;
  const shown = useMemo(() => (data ? filterGroups(data.groups, q) : []), [data, q]);
  const repos = useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, PageGroup[]>();
    for (const g of shown) {
      if (!by.has(g.repo)) {
        by.set(g.repo, []);
        order.push(g.repo);
      }
      by.get(g.repo)!.push(g);
    }
    return order.map((repo) => ({ repo, groups: by.get(repo)!, pages: by.get(repo)!.reduce((n, g) => n + g.pages.length, 0) }));
  }, [shown]);
  const shownPages = repos.reduce((n, r) => n + r.pages, 0);

  const setAll = (to: boolean) => {
    const next = new Set<string>();
    if (to) for (const r of repos) [repoKey(r.repo), ...r.groups.map((g) => g.id)].forEach((k) => next.add(k));
    writeOpen(next);
    setOpen(next);
  };

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="pages-index">
      <PageHeader title="Pages" description="Every page the team made, together: by objective, then by repo and epic. Each objective has its own Pages tab." />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the page list…</div>}
      {error && <div className="text-sm text-destructive">Could not read the page list: {error.message}</div>}
      {data && !searching && <PinnedPages pages={data.pinned ?? []} />}
      {placed && !searching && <ByWheel placed={placed} nodes={sets.data?.nodes ?? []} />}
      {data && data.total === 0 && <div className="text-sm text-muted-foreground">No pages yet: docs/pages/registry.json names them.</div>}
      {data && data.total > 0 && (
        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="search" aria-label="Search pages" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, epics, repos…" data-testid="pages-search" />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="pages-summary">
              {searching ? `${plural(shownPages, "page")} match, of ${data.total}` : `${plural(data.total, "page")} in ${plural(data.groups.length, "epic")} across ${plural(repos.length, "repo")}`}
            </span>
            {!searching && (
              <>
                <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => setAll(true)} data-testid="pages-open-all">
                  Open all
                </button>
                <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => setAll(false)} data-testid="pages-close-all">
                  Close all
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {searching && data && repos.length === 0 && <div className="text-sm text-muted-foreground" data-testid="pages-none">No page, epic or repo matches “{q.trim()}”.</div>}
      <div className="grid gap-2">
        {repos.map((r) => {
          // while searching every match shows; folds come back as they were when the search is cleared.
          const repoOpen = searching || open.has(repoKey(r.repo));
          return (
            <div key={r.repo} className="grid gap-1 border-t border-border pt-2" data-testid="pages-repo" data-repo={r.repo} data-open={repoOpen ? "true" : "false"}>
              <Fold open={repoOpen} onToggle={() => toggle(repoKey(r.repo))} testId="pages-repo-toggle">
                <span className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{r.repo}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="pages-repo-count">
                  {plural(r.groups.length, "epic")} · {plural(r.pages, "page")}
                </span>
              </Fold>
              {repoOpen && (
                <div className="ml-3 grid gap-0.5">
                  {r.groups.map((g) => (
                    <Group key={g.id} g={g} open={searching || open.has(g.id)} onToggle={() => toggle(g.id)} wheelOf={wheelOf} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {data && data.total > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="pages-rule">
          {data.total} pages. The row that makes a page adds it here; an hourly check and the weekly harmonizer pass name any page without a parent.
        </p>
      )}
    </div>
  );
}
