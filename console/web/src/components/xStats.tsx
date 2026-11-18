import { useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { XStatsAccount, XStatsBody, XStatsTotals } from "@/api/pages-types";
import { PageHeader } from "@/components/common";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { X_STATS_PATH } from "@/lib/routePaths";
export { X_STATS_PATH };

/**
 * The team's X accounts in one place: per post its likes, replies, reposts and views, read only.
 * scripts/x_stats.py writes one file a day (data/x-stats/<date>.json); GET /api/x-stats reads it (server/src/xStats.ts).
 * The answer first (all accounts summed), then one box per account with the change since the day before, then the posts.
 */

const KEYS = ["likes", "replies", "reposts", "views"] as const;
const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
/** The channel's name and a stable anchor (X and TikTok handles can match). */
const PLATFORM: Record<string, string> = { x: "X", reddit: "Reddit", tiktok: "TikTok" };
const channel = (a: XStatsAccount) => PLATFORM[a.platform ?? "x"] ?? a.platform ?? "X";
const anchor = (a: XStatsAccount) => `${a.platform ?? "x"}-${a.handle.replace(/[^A-Za-z0-9_]/g, "")}`;
const sum = (accs: XStatsAccount[], k: keyof XStatsTotals) => accs.reduce((a, x) => a + (x.totals[k] ?? 0), 0);

function delta(now: number, before: number | undefined) {
  if (before === undefined || now === before) return null;
  const d = now - before;
  return <span className={cn("ml-1 text-[11px]", d > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{d > 0 ? `+${d}` : d}</span>;
}

function AccountBox({ a, before }: { a: XStatsAccount; before?: XStatsTotals }) {
  const read = a.state === "read";
  return (
    <a
      href={`#${anchor(a)}`}
      className="grid gap-2 rounded-md border border-border p-3 hover:bg-accent/40"
      data-testid="x-stats-account"
      data-state={a.state}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">
          {channel(a)} {a.handle}
        </span>
        <span className={cn("shrink-0 text-xs", read ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{read ? "✓ read" : `✗ ${a.state}`}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {a.product} · {a.count} posts in the window{a.followers !== null ? ` · ${n(a.followers)} followers` : ""}
      </div>
      <dl className="grid grid-cols-4 gap-1 text-center">
        {KEYS.map((k) => (
          <div key={k}>
            <dt className="text-[11px] text-muted-foreground">{k}</dt>
            <dd className="text-sm font-medium tabular-nums">
              {n(a.totals[k])}
              {delta(a.totals[k], before?.[k])}
            </dd>
          </div>
        ))}
      </dl>
    </a>
  );
}

function Posts({ a }: { a: XStatsAccount }) {
  return (
    <section id={anchor(a)} className="grid gap-1" data-testid="x-stats-posts">
      <h2 className="text-sm font-medium">
        {channel(a)} {a.handle} <span className="font-normal text-muted-foreground">· {a.count} posts{a.postsAllTime !== null ? ` · ${a.postsAllTime} ever` : ""}</span>
      </h2>
      {a.notes.length > 0 && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{a.notes.join(" · ")}</p>}
      {a.posts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No posts in this window.</p>
      ) : (
        <ul className="grid">
          {a.posts.map((p) => (
            <li key={p.id} className="grid gap-0.5 border-t border-border py-2 text-sm" data-testid="x-stats-post">
              <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-muted-foreground">
                <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
                  {when(p.at)}
                </a>
                <span>{p.kind}</span>
                <span className="tabular-nums">♥ {n(p.likes)}</span>
                <span className="tabular-nums">↩ {n(p.replies)}</span>
                <span className="tabular-nums">⟳ {n(p.reposts)}</span>
                <span className="tabular-nums">👁 {n(p.views)}</span>
              </div>
              <p className="truncate text-muted-foreground" title={p.text}>
                {p.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function XStatsPage() {
  const [params, setParams] = useSearchParams();
  const date = params.get("date") || undefined;
  const { data, error, loading } = useQuery<XStatsBody>(() => api.getXStats(date), [date]);
  const day = data?.day;
  const accs = day?.accounts ?? [];
  const i = data && day ? data.history.findIndex((h) => h.date === day.date) : -1;
  const prev = i > 0 ? data!.history[i - 1] : undefined;
  const readN = accs.filter((a) => a.state === "read").length;
  const posted = accs.filter((a) => a.count > 0).length;
  const posts = accs.reduce((a, x) => a + x.count, 0);
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="x-stats-page">
      <PageHeader title="Post stats" description="Likes, replies, reposts and views on every post on X, Reddit and TikTok, read once a day." />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the X stats…</div>}
      {error && <div className="text-sm text-destructive">Could not read the X stats: {error.message}</div>}
      {data && !day && <div className="text-sm text-muted-foreground">No X stats stored yet.</div>}
      {day && (
        <>
          <div className="rounded-md border-2 border-foreground/80 p-3" data-testid="x-stats-answer">
            <p className="text-base font-medium">
              Last {day.windowDays} days: {posts} posts, {sum(accs, "likes")} likes, {sum(accs, "replies")} replies, {sum(accs, "reposts")} reposts and{" "}
              {sum(accs, "views").toLocaleString()} views across {accs.length} accounts.
            </p>
            <p className="text-xs text-muted-foreground">
              {readN} of {accs.length} accounts read · {posted} posted in the window · read {when(day.readAt)}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2" data-testid="x-stats-accounts">
            {accs.map((a) => (
              <AccountBox key={anchor(a)} a={a} before={prev?.accounts[a.handle]} />
            ))}
          </div>
          {data!.dates.length > 1 && (
            <div className="flex flex-wrap gap-1 text-xs" role="tablist" aria-label="Day">
              {data!.dates.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={d === day.date}
                  onClick={() => setParams(d === data!.dates[data!.dates.length - 1] ? {} : { date: d }, { replace: true })}
                  className={cn("rounded-md px-2 py-0.5 text-muted-foreground hover:bg-accent", d === day.date && "bg-accent text-foreground")}
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          {accs.map((a) => (
            <Posts key={anchor(a)} a={a} />
          ))}
          <p className="text-xs text-muted-foreground" data-testid="x-stats-rule">
            Read only, never posts or likes. X: the post list comes from each profile (through the Team Browser when the laptop is online, else the public
            fxtwitter read), each post's counts from fxtwitter. Reddit and TikTok: every post with a live link in the campaign posts ledgers, read from
            its own page; Reddit shows views only to the author. Totals are as read at that moment, so a day's change is today minus the day before.
          </p>
        </>
      )}
    </div>
  );
}
