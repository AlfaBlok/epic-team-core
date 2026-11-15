import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api, type BookEpic, type BookRepo, type BookState } from "@/api";
import type { CapabilityCell, CapabilityEgress, CapabilityStatusLine, CapabilityTable, FeatureList } from "@/api/types";
import { useLiveBook } from "@/lib/useLiveBook";
import { BOOK_PATH, EGRESS_STYLE, PLAIN_LABEL, PLAIN_STYLE, FILTERS, questionsUrl, STATE_DOT, STATE_LABEL, day, orderRepos, plainOf, shows, titleRest, type BookFilter } from "@/lib/book";
import { Card } from "@/components/ui/card";
import { Empty, ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { MadeList } from "@/components/bookMade";
import { ownerName } from "@/lib/identity";

/**
 * the Epic Book, one URL that answers "where are we" (L-33). Every repo's spines, per epic:
 * what we are trying to do (Goal), why this way (Serves + Decisions), the timeline of fixes (commits + decisions),
 * what is next and what it is stuck on. Built on the server from spines.py, the Decisions tables and git log
 * (GET /api/book, book/build.ts), never hand-kept. `?repo=` and `?show=` make a view linkable.
 */
export { BOOK_PATH };

const FILTER_IDS = FILTERS.map((f) => f.id);

function StateDot({ state }: { state: BookState }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[state]}`} title={STATE_LABEL[state]} aria-label={STATE_LABEL[state]} />;
}

function Counts({ counts }: { counts: Record<BookState, number> }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
      {(["moving", "stuck", "parked", "done"] as BookState[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StateDot state={s} />
          {counts[s]} {STATE_LABEL[s]}
        </span>
      ))}
    </span>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-sm">{children}</div>
    </div>
  );
}

function Epic({ e, repo, folded = [] }: { e: BookEpic; repo: BookRepo; folded?: BookEpic[] }) {
  const stuck = e.state === "stuck";
  const commitHref = (sha: string) => (repo.remote ? `https://github.com/${repo.remote}/commit/${sha}` : undefined);
  return (
    <details id={e.code} className="group rounded-md border bg-card" style={{ marginLeft: `${Math.min(e.depth, 4) * 0.75}rem` }} data-testid="book-epic">
      <summary className="flex cursor-pointer list-none items-start gap-2 p-3 max-sm:min-h-11">
        <span className="mt-1.5">
          <StateDot state={e.state} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs text-muted-foreground">{e.code}</span>
            <span className="font-medium">{titleRest(e)}</span>
            <span className="text-xs text-muted-foreground">
              {e.status}
              {e.dod.total > 0 && ` · ${e.dod.done}/${e.dod.total} done`}
            </span>
          </span>
          {stuck && (
            <span className="mt-1 block text-sm text-red-700 dark:text-red-400" data-testid="book-stuck">
              Stuck on: {e.asks.length ? e.asks.map((a) => `${a.code} (${a.who})`).join(", ") : e.waitingOn}
            </span>
          )}
          {!stuck && e.next && e.state === "moving" && <span className="mt-1 block truncate text-sm text-muted-foreground">Next: {e.next}</span>}
          {folded.length > 0 && (
            <span className="mt-1 block text-sm text-muted-foreground" data-testid="book-folded">
              Folded in: {folded.map((f, i) => (
                <span key={f.path} id={f.code} title={`${f.code} ${titleRest(f)} (${f.status})`}>
                  {i > 0 && ", "}
                  <span className="font-mono text-xs">{f.code}</span> {titleRest(f)}
                </span>
              ))}
            </span>
          )}
        </span>
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t p-3">
        {e.goal && <Line label="Goal">{e.goal}</Line>}
        {(e.serves || e.decisions.length > 0) && (
          <Line label="Why">
            {e.serves && <p>{e.serves}</p>}
            {e.decisions.length > 0 && (
              <ul className="mt-1 grid gap-1">
                {e.decisions.map((d, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground tabular-nums">{day(d.date)}</span> {d.decision}
                    {d.summary && <span className="text-muted-foreground"> — {d.summary}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Line>
        )}
        {e.outcome && <Line label="Outcome">{e.outcome}</Line>}
        {stuck && (
          <Line label="Stuck on">
            {e.waitingOn && <p>{e.waitingOn}</p>}
            {e.asks.map((a) => (
              <p key={a.code}>
                <span className="font-mono text-xs">{a.code}</span> ({a.who}): {a.question}
              </p>
            ))}
          </Line>
        )}
        {e.next && <Line label="Next">{e.next}</Line>}
        {e.lastAttempted && <Line label="Last done">{e.lastAttempted}</Line>}
        {e.made && e.made.length > 0 && (
          <Line label={`Everything made for this (${e.made.length})`}>
            <MadeList items={e.made} initial={10} />
          </Line>
        )}
        {e.timeline.length > 0 && (
          <Line label="Timeline">
            <ol className="grid gap-1" data-testid="book-timeline">
              {e.timeline.map((t, i) => {
                const href = t.sha ? commitHref(t.sha) : undefined;
                return (
                  <li key={i} className="flex gap-2">
                    <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{day(t.date)}</span>
                    <span className="min-w-0">
                      {t.kind === "decision" && <span className="mr-1 rounded bg-muted px-1 text-[11px] uppercase">decision</span>}
                      {t.text}
                      {t.sha &&
                        (href ? (
                          <a href={href} target="_blank" rel="noreferrer" className="ml-1 font-mono text-xs text-muted-foreground underline">
                            {t.sha}
                          </a>
                        ) : (
                          <span className="ml-1 font-mono text-xs text-muted-foreground">{t.sha}</span>
                        ))}
                    </span>
                  </li>
                );
              })}
            </ol>
            {e.timelineTotal > e.timeline.length && <p className="mt-1 text-xs text-muted-foreground">{e.timelineTotal - e.timeline.length} older entries in git log</p>}
          </Line>
        )}
        {e.href && (
          <a href={e.href} target="_blank" rel="noreferrer" className="text-sm underline">
            Open the spine
          </a>
        )}
      </div>
    </details>
  );
}

function CapCell({ c }: { c: CapabilityCell | undefined }) {
  if (!c) return <span className="text-xs text-muted-foreground">not listed</span>;
  const p = plainOf(c);
  return (
    <div className="grid gap-1" data-testid="cap-cell" data-state={c.state}>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${PLAIN_STYLE[p.word] ?? PLAIN_STYLE["n/a"]}`} data-testid="cap-word" data-word={p.word}>
          {PLAIN_LABEL[p.word] ?? p.word}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums" title={`${c.tested}: ${c.test} (probe state: ${c.state})`}>
          tested {day(c.tested)}
        </span>
      </span>
      <span className="font-medium" data-testid="cap-plain">
        {p.text}
      </span>
      <span className="text-xs text-muted-foreground">{c.summary}</span>
      {c.egress && (
        <span className="text-xs" data-testid="cap-cell-egress">
          <span className="font-medium">Egress:</span> {c.egress}
        </span>
      )}
      {c.egressSeen && <span className="text-xs text-muted-foreground">went out via {c.egressSeen}</span>}
      {c.why && (
        <span className="text-xs text-muted-foreground">
          <span className="font-medium">Why:</span> {c.why}
        </span>
      )}
      {c.fix && (
        <span className="text-xs text-muted-foreground">
          <span className="font-medium">Fix:</span> {c.fix}
        </span>
      )}
      {c.lastGood && c.state !== "works" && <span className="text-xs text-muted-foreground">last worked {day(c.lastGood)}</span>}
      {c.lastReal && (
        <span className="text-xs text-muted-foreground">
          last real: {day(c.lastReal.at)}{" "}
          {c.lastReal.url ? (
            <a href={c.lastReal.url} target="_blank" rel="noreferrer" className="underline">
              {c.lastReal.what}
            </a>
          ) : (
            c.lastReal.what
          )}
        </span>
      )}
    </div>
  );
}

/** rework (the owner 2026-11-02): the network exit a service needs, what happens when it is offline, and in a tester world. */
function EgressCell({ e }: { e: CapabilityEgress | undefined }) {
  if (!e) return <span className="text-xs text-muted-foreground">not listed</span>;
  return (
    <div className="grid gap-1" data-testid="cap-egress" data-kind={e.kind}>
      <span className={`w-fit rounded px-1.5 py-0.5 text-[11px] font-medium ${EGRESS_STYLE[e.kind] ?? EGRESS_STYLE.none}`}>{e.label}</span>
      {e.detail && <span className="text-xs">{e.detail}</span>}
      {e.offline && (
        <span className="text-xs">
          <span className="font-medium">When offline:</span> {e.offline}
        </span>
      )}
      {e.tester && (
        <span className="text-xs text-muted-foreground">
          <span className="font-medium">Tester world:</span> {e.tester}
        </span>
      )}
    </div>
  );
}

/** one plain line per platform and world, above the table. */
function PlainStatus({ lines }: { lines: CapabilityStatusLine[] }) {
  return (
    <div className="grid gap-1.5" data-testid="cap-status">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status in plain words</p>
      <ul className="grid gap-1.5 text-sm">
        {lines.map((l) => (
          <li key={`${l.world}/${l.platform}`} className="flex items-start gap-2" data-testid="cap-status-line" data-word={l.word}>
            <span className={`mt-0.5 w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${PLAIN_STYLE[l.word] ?? PLAIN_STYLE["n/a"]}`}>{PLAIN_LABEL[l.word] ?? l.word}</span>
            <span>
              <span className="font-medium">
                {l.world}, {l.platform}:
              </span>{" "}
              {l.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The first list keeps the #features anchor (links); another service's gets #features-<service>. */
export const featuresAnchor = (f: FeatureList, first: boolean) => (first ? "features" : `features-${(f.service || f.source).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);

/** Every feature list a repo keeps: EpicTeam's first, then the others (worker: the social product's). */
const featureListsOf = (r: BookRepo): FeatureList[] => r.featureLists ?? (r.features ? [r.features] : []);

/**
 * the service's feature list, from the repo's one data file (docs/features/epicteam.json), the same
 * file epicspine.dev/team/ draws. Each line names the rows that built it.
 */
export function Features({ f, first = true }: { f: FeatureList; first?: boolean }) {
  const n = f.groups.reduce((a, g) => a + g.features.length, 0);
  // the social product's list (docs/features/social.json) is drawn on epicspine.dev/social, EpicTeam's on /team.
  const page = `epicspine.dev/${(f.service || "EpicTeam").toLowerCase().replace(/^epic/, "")}`;
  return (
    <details id={featuresAnchor(f, first)} open className="mb-4 rounded-md border bg-card" data-testid="book-features">
      <summary className="cursor-pointer list-none p-3 max-sm:min-h-11">
        <span className="font-medium">{f.title}</span>{" "}
        <span className="text-xs text-muted-foreground">
          {f.updated && <>updated {day(f.updated)} · </>}
          {n} features
        </span>
      </summary>
      <div className="grid grid-cols-1 gap-4 border-t p-3">
        {f.groups.map((g) => (
          <section key={g.id} id={`${featuresAnchor(f, first)}-${g.id}`} className="grid gap-2" data-testid="feature-group">
            <h3 className="text-sm font-semibold">{g.title}</h3>
            {g.intro && <p className="text-sm text-muted-foreground">{g.intro}</p>}
            <ul className="grid gap-2 text-sm sm:grid-cols-2">
              {g.features.map((x) => (
                <li key={x.id} className="grid content-start gap-1 rounded border p-2" data-testid="feature">
                  <span className="font-medium">{x.title}</span>
                  <span>{x.text}</span>
                  <span className="text-xs text-muted-foreground">
                    {[x.rows.length > 0 && `built by ${x.rows.join(", ")}`, x.learning, x.since && `since ${day(x.since)}`].filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-xs text-muted-foreground">
          One list, read by this page and {page}. When {ownerName()} approves something new a user can see, its line is added here.{" "}
          {f.href ? (
            <a href={f.href} target="_blank" rel="noreferrer" className="underline">
              Data: {f.source}
            </a>
          ) : (
            <>Data: {f.source}</>
          )}
        </p>
      </div>
    </details>
  );
}

/** the services x capabilities table, generated from the repo's data file, never hand-typed. */
export function Capabilities({ t }: { t: CapabilityTable }) {
  return (
    <details id="capabilities" open className="mb-4 rounded-md border bg-card" data-testid="book-capabilities">
      <summary className="cursor-pointer list-none p-3 max-sm:min-h-11">
        <span className="font-medium">{t.title}</span>{" "}
        <span className="text-xs text-muted-foreground">
          checked {day(t.checkedAt)} · {t.services.length} services
        </span>
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t p-3">
        {t.plainStatus && t.plainStatus.length > 0 && <PlainStatus lines={t.plainStatus} />}
        {t.scope && (
          <p className="text-sm" data-testid="cap-scope">
            {t.scope}
          </p>
        )}
        {t.about && <p className="text-sm text-muted-foreground">{t.about}</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[66rem] border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 bg-card p-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Service</th>
                <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Egress (proxy?)</th>
                {t.capabilities.map((c) => (
                  <th key={c.id} className="p-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.services.map((s) => (
                <tr key={s.id} className="border-t align-top" data-testid="cap-row">
                  <th scope="row" className="sticky left-0 w-36 bg-card p-2 text-left font-medium">
                    {s.label}
                    {s.account && <span className="block text-xs font-normal text-muted-foreground">{s.account}</span>}
                    {s.pending && <span className="block text-xs font-normal text-red-700 dark:text-red-400">waits on {s.pending}</span>}
                  </th>
                  <td className="w-44 p-2">
                    <EgressCell e={s.egress} />
                  </td>
                  {t.capabilities.map((c) => (
                    <td key={c.id} className="w-1/6 p-2">
                      <CapCell c={s.cells[c.id]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {t.egressLegend && (
          <dl className="grid gap-1 text-xs sm:grid-cols-2" data-testid="cap-egress-legend">
            {Object.entries(t.egressLegend).map(([k, v]) => (
              <div key={k} className="flex items-start gap-1.5">
                <dt className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${EGRESS_STYLE[k] ?? EGRESS_STYLE.none}`}>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {t.other && t.other.length > 0 && (
          <div className="grid gap-1" data-testid="cap-other">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Other team services a seat can use</p>
            <ul className="grid gap-2 text-sm sm:grid-cols-2">
              {t.other.map((o) => (
                <li key={o.id} className="grid gap-1 rounded border p-2">
                  <span>
                    <span className="font-medium">{o.label}</span>: {o.what}
                    {o.tested && <span className="text-xs text-muted-foreground"> · tested {day(o.tested)}</span>}
                  </span>
                  <EgressCell e={o.egress} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {Object.entries(t.states)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
          .{" "}
          {t.href ? (
            <a href={t.href} target="_blank" rel="noreferrer" className="underline">
              Data: {t.source}
            </a>
          ) : (
            <>Data: {t.source}</>
          )}
        </p>
      </div>
    </details>
  );
}

export function BookPage() {
  const [params, setParams] = useSearchParams();
  // rework: the last book at once (server store, else this browser's copy), refreshed behind it.
  const { data, error, loading, savedCopy } = useLiveBook(() => api.getBook(), [], "epic-book:all");
  // `/book#capabilities`: scroll once the book has rendered (the browser's own hash scroll runs before it exists).
  const hash = useLocation().hash.slice(1);
  const ready = !!data?.book;
  useEffect(() => {
    if (!hash || !ready) return;
    let id = hash;
    try {
      id = decodeURIComponent(hash);
    } catch {
      // keep the raw hash
    }
    document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [hash, ready]);
  const show = (FILTER_IDS as string[]).includes(params.get("show") ?? "") ? (params.get("show") as BookFilter) : "open";
  const repoName = params.get("repo") ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const book = data?.book;
  const header = (
    <PageHeader
      title="Every epic"
      description={
        <>
          <Link to="/deck" className="mr-2 underline" data-testid="book-decks">
            Epic decks
          </Link>
          <Link to="/rocks" className="mr-2 underline" data-testid="book-rocks">
            Big rocks
          </Link>
          Where we are, every repo: goal, why, timeline of fixes, what is next, what is stuck. Built from the spines and git log
          {book && (
            <>
              , <RelTime iso={book.builtAt} />
            </>
          )}
          {(data?.building || savedCopy) && (
            <span className="text-muted-foreground" data-testid="book-refreshing">
              {" "}
              (refreshing)
            </span>
          )}
          .{" "}
          {data && "refreshedAt" in data && (
            <span data-testid="book-refreshed">
              Refreshed {data.refreshedAt ? <RelTime iso={data.refreshedAt} /> : "not yet"}
              {data.dailyRefreshAt !== undefined && <> (daily pull {data.dailyRefreshAt ? <RelTime iso={data.dailyRefreshAt} /> : "not run yet"})</>}.{" "}
            </span>
          )}
          {questionsUrl() && (
            <a href={questionsUrl()} target="_blank" rel="noreferrer" className="underline" data-testid="book-questions">
              Your open questions (28 Oct voice note)
            </a>
          )}
          {featureListsOf(book?.repos.find((r) => r.features) ?? ({} as BookRepo)).map((f, i) => (
            <span key={f.source}>
              {" · "}
              <a href={`#${featuresAnchor(f, i === 0)}`} className="underline" data-testid="book-features-link">
                {f.title}
              </a>
            </span>
          ))}
          {book?.repos.some((r) => r.capabilities) && (
            <>
              {" · "}
              <a href="#capabilities" className="underline" data-testid="book-capabilities-link">
                What the team can do, per service
              </a>
            </>
          )}
        </>
      }
    />
  );
  if (!book)
    return (
      <div>
        {header}
        <Empty>The first book is being built from the spines; it appears here by itself in a few seconds.</Empty>
      </div>
    );

  const stale = data?.staleBooks ?? [];
  const repos = orderRepos(book.repos).filter((r) => !repoName || r.name === repoName);
  const visible = repos.map((r) => ({ r, epics: r.epics.filter((e) => shows(show, e)) })).filter((x) => x.epics.length > 0 || x.r.capabilities || x.r.features);
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm max-sm:min-h-9 ${active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`;

  return (
    <div className="min-w-0">
      {header}
      {stale.length > 0 && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40" data-testid="book-stale">
          <p className="font-medium text-red-800 dark:text-red-300">
            Stuck: {stale.length} epic {stale.length === 1 ? "deck is" : "decks are"} older than 2 days (the daily refresh has not run)
          </p>
          <ul className="mt-1 grid gap-0.5">
            {stale.map((s) => (
              <li key={s.milestoneId}>
                <Link to={`/book/${s.milestoneId}`} className="underline">
                  {s.title}
                </Link>{" "}
                <span className="text-muted-foreground">
                  ({s.repo}, last updated {s.updatedAt ? <RelTime iso={s.updatedAt} /> : "never"})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mb-4 grid gap-3">
        <Counts counts={book.counts} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={chip(show === f.id)} onClick={() => set("show", f.id === "open" ? "" : f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Repo">
          <button type="button" className={chip(!repoName)} onClick={() => set("repo", "")}>
            All repos
          </button>
          {orderRepos(book.repos).map((r) => (
            <button key={r.name} type="button" className={chip(repoName === r.name)} onClick={() => set("repo", r.name)}>
              {r.name}
              <span className="ml-1 tabular-nums opacity-70">{r.counts.moving + r.counts.stuck}</span>
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 && <Empty>Nothing to show for this filter.</Empty>}
      <div className="grid grid-cols-1 gap-6">
        {visible.map(({ r, epics }) => (
          <Card key={r.name} className="min-w-0 p-4" data-testid="book-repo">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">{r.name}</h2>
              <Counts counts={r.counts} />
            </div>
            {r.error && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">{r.error}</p>}
            {featureListsOf(r).map((f, i) => (
              <Features key={f.source} f={f} first={i === 0} />
            ))}
            {r.capabilities && <Capabilities t={r.capabilities} />}
            <div className="grid grid-cols-1 gap-2">
              {epics
                .filter((e) => !e.foldedInto)
                .map((e) => (
                  <Epic key={e.path} e={e} repo={r} folded={r.epics.filter((f) => f.foldedInto === e.path)} />
                ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
