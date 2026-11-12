import { Link } from "react-router-dom";
import { CheckCircle2, ExternalLink, Hand, Megaphone } from "lucide-react";
import { api } from "@/api";
import type { BuildingCount } from "@/api/building-types";
import type { Milestone } from "@/api/types";
import { useQuery } from "@/lib/data";
import { COMPANY_PATH, REPOS_PARAM, repoName } from "@/lib/company";
import { useCompanyView } from "@/lib/companyView";
import { cn } from "@/lib/utils";
import { CountPill } from "@/components/homeSection";

/**
 * the EpicTeam home
 * opens with what he builds. Each list names where its personas wake, its named the social product campaigns under it and how much
 * waits on his hands there, all read from the spines (GET /api/building); no scoreboard of numbers.
 */
// one card frame, no colour stripe per product.
const ACCENT = [""];

const total = (c: BuildingCount) => c.asks + c.review;

/** "3 answers and 5 to check", or nothing waiting. */
export function waitWords(c: BuildingCount): string {
  if (!total(c)) return "Nothing waits on you";
  const parts = [c.asks ? `${c.asks} ${c.asks === 1 ? "answer" : "answers"}` : "", c.review ? `${c.review} to check` : ""].filter(Boolean);
  return `${parts.join(" and ")} ${total(c) === 1 ? "waits" : "wait"} on you`;
}

/** The project page where a repo's personas wake: its root spine's milestone, else its first. */
function repoProject(milestones: Milestone[], repo: string): Milestone | undefined {
  const mine = milestones.filter((m) => repoName(m.repo) === repo && !m.settledAt);
  return mine.find((m) => /(^|\/)root\.md$/.test(m.path ?? "")) ?? mine[0];
}

function WaitPill({ c, to, testId }: { c: BuildingCount; to?: string; testId?: string }) {
  const n = total(c);
  const body = (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 text-left text-[13px] leading-snug", n ? "font-medium text-foreground" : "text-muted-foreground")} data-testid={testId} data-count={n}>
      {n ? <Hand className="h-3.5 w-3.5 shrink-0" strokeWidth={2} /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
      <span className="min-w-0">{waitWords(c)}</span>
    </span>
  );
  return n && to ? (
    <Link to={to} className="inline-flex max-w-full hover:opacity-90" aria-label={`${waitWords(c)}: open them`}>
      {body}
    </Link>
  ) : (
    body
  );
}

export function BuildingLists({ milestones = [], list }: { milestones?: Milestone[]; list?: boolean }) {
  const { data } = useQuery(() => api.listBuilding(), [], { tag: "inbox" });
  const lists = data?.lists ?? [];
  const companyView = useCompanyView(); // the waits pill opens the Company view's inbox only while it is on
  if (!lists.length) return null;
  // Settings (the round 2 mockup): one quiet row per product, its line, campaigns and site in grey, its red and green counts.
  if (list)
    return (
      <section className="mb-6" data-testid="building-lists" data-look="list" aria-labelledby="building-heading">
        <h2 id="building-heading" className="mb-2 text-[15px] font-semibold text-foreground">
          What you build
        </h2>
        <div className="divide-y rounded-xl border bg-card">
          {lists.map((l) => {
            const m = l.repos.map((r) => repoProject(milestones, r)).find(Boolean);
            const campaigns = l.campaigns.length ? `${l.campaigns.length} ${l.campaigns.length === 1 ? "campaign" : "campaigns"}` : "";
            const grey = [l.line?.replace(/\.$/, ""), campaigns].filter(Boolean);
            return (
              <div key={l.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 [overflow-wrap:anywhere]" data-testid="building-list" data-list={l.id}>
                <span className="min-w-0 flex-1 basis-48 text-sm">
                  {m ? (
                    <Link to={`/milestones/${encodeURIComponent(m.id)}`} className="text-foreground hover:underline" data-testid="building-repo">
                      {l.name}
                    </Link>
                  ) : (
                    <span className="text-foreground">{l.name}</span>
                  )}
                  {grey.length > 0 && <span className="text-xs text-muted-foreground"> · {grey.join(" · ")}</span>}
                  {l.open && (
                    <>
                      <span className="text-xs text-muted-foreground"> · </span>
                      <a className="text-xs text-muted-foreground underline decoration-foreground/25 underline-offset-[3px] hover:text-foreground" href={l.open.url} target="_blank" rel="noreferrer">
                        {l.open.label}
                      </a>
                    </>
                  )}
                </span>
                {total(l.waits) ? (
                  <span className="flex shrink-0 items-center gap-1" data-testid="building-waits" data-count={total(l.waits)} title={waitWords(l.waits)}>
                    {l.waits.asks > 0 && <CountPill count={l.waits.asks} tone="needs-you" />}
                    {l.waits.review > 0 && <CountPill count={l.waits.review} tone="review" />}
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground" data-testid="building-waits" data-count={0}>
                    nothing waits
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  return (
    <section className="mb-6" data-testid="building-lists" aria-labelledby="building-heading">
      <h2 id="building-heading" className="mb-2 text-[15px] font-semibold text-foreground">
        What you build
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {lists.map((l, i) => {
          const inbox = companyView ? `/${COMPANY_PATH}?${REPOS_PARAM}=${encodeURIComponent(l.repos.join(","))}` : undefined;
          return (
            <article key={l.id} className={cn("min-w-0 rounded-xl border bg-card p-4 [overflow-wrap:anywhere]", ACCENT[i % ACCENT.length])} data-testid="building-list" data-list={l.id}>
              {/* gap-x-2 gap-y-2, not gap-2: polish.css pins `.mb-6.flex.flex-wrap.gap-2 > a` to 34px, which cut the two-line pill on a phone */}
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
                <h3 className="text-base font-semibold leading-tight text-foreground">{l.name}</h3>
                <WaitPill c={l.waits} to={inbox} testId="building-waits" />
              </div>
              {l.line && <p className="mt-1 text-sm leading-snug text-muted-foreground">{l.line}</p>}
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-sm text-foreground" data-testid="building-wakes">
                <span className="font-semibold">Personas wake in</span>
                {l.repos.map((r) => {
                  const m = repoProject(milestones, r);
                  const n = total(l.repoWaits[r] ?? { asks: 0, review: 0 });
                  const chip = (
                    <>
                      {r}
                      {n > 0 && <span className="ml-1 text-xs text-muted-foreground">{n}</span>}
                    </>
                  );
                  return m ? (
                    <Link key={r} to={`/milestones/${encodeURIComponent(m.id)}`} className="rounded-md border border-border bg-background px-2 py-0.5 font-medium hover:bg-muted" data-testid="building-repo">
                      {chip}
                    </Link>
                  ) : (
                    <span key={r} className="rounded-md border border-border px-2 py-0.5 font-medium" data-testid="building-repo">
                      {chip}
                    </span>
                  );
                })}
                {l.world && <span className="text-muted-foreground">· world: {l.world}</span>}
              </div>
              <div className="mt-3" data-testid="building-campaigns">
                <div className="mb-1 text-[13px] font-semibold text-foreground">Campaigns</div>
                {l.campaigns.length ? (
                  <ul className="grid gap-1">
                    {l.campaigns.map((c) => {
                      const n = total(c.waits);
                      const name = c.deck ? (
                        <a className="font-semibold underline-offset-2 hover:underline" href={c.deck} target="_blank" rel="noreferrer">
                          {c.name}
                        </a>
                      ) : (
                        <span className="font-semibold">{c.name}</span>
                      );
                      return (
                        <li key={`${c.repo}:${c.code}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-foreground" data-testid="building-campaign">
                          <Megaphone className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden />
                          {name}
                          {c.platform && <span className="text-sm text-muted-foreground">{c.platform}</span>}
                          {n > 0 && <span className="text-xs text-muted-foreground">{n} for you</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No campaign yet.</p>
                )}
              </div>
              {l.open && (
                <a className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current" href={l.open.url} target="_blank" rel="noreferrer">
                  Open {l.open.label} <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
