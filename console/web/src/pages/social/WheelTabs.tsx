import { useMemo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api, type Milestone } from "@/api";
import type { CampaignKeyResult, CampaignWheel } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { STATUS_SAYS, TrafficLight, krMeasured } from "@/components/goalSets";
import { useHomeTab, WheelPagesTab } from "@/components/wheelPages";
import { WhereWeAreView } from "@/components/whereWeAre";
import { useQuery } from "@/lib/data";
import { sameRepo } from "@/lib/repoNames";
import { worldId } from "@/lib/useSocial";

/**
 * The owner asked for the same tabs on every wheel: a campaign's Key results, Context and Pages tabs, the same
 * three an objective has, read from the objective the campaign serves (GET /tenants/:id/campaigns/:mid/wheel): its key
 * results now against target, its one where-we-are, the pages made for it. A campaign serving none says so.
 */
const useCampaignWheel = (m: Milestone) => useQuery<CampaignWheel>(async () => api.getCampaignWheel(await worldId(), m.id), [m.id]);

type Light = "green" | "amber" | "red" | "unknown";
const lightOf = (c?: string): Light => (c === "green" || c === "amber" || c === "red" ? c : "unknown");

function NoWheel({ what }: { what: string }) {
  return (
    <p className="max-w-2xl rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="campaign-wheel-none">
      This campaign serves no objective yet, so it has no {what}. Its {what} are the objective's it moves.
    </p>
  );
}

function WheelLoad({ m, what, children }: { m: Milestone; what: string; children: (w: CampaignWheel) => ReactNode }) {
  const q = useCampaignWheel(m);
  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  if (!q.data.wheels.length) return <NoWheel what={what} />;
  return <>{children(q.data)}</>;
}

/** one key result: its light and status word, its name, now against target, the note and when it was read. */
function KeyResultLine({ wheel, k }: { wheel: string; k: CampaignKeyResult }) {
  const light = lightOf(k.colour);
  const read = krMeasured({ measuredAt: k.measuredAt });
  return (
    <li id={`kr-${wheel}-${k.n}`} className="grid scroll-mt-4 gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4" data-testid="campaign-kr" data-light={light}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-[5px] shrink-0">
          <TrafficLight light={light} size="sm" testId="campaign-kr-light" />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-sm font-medium text-foreground [overflow-wrap:anywhere]" data-testid="campaign-kr-label">
            {k.label}
          </span>
          {k.note && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{k.note}</span>}
          <span className="text-xs text-muted-foreground">
            {read.words}
            {k.owner ? ` · owner ${k.owner}` : ""}
            {k.evidence?.url && (
              <>
                {" · "}
                <a href={k.evidence.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground">
                  evidence <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </>
            )}
          </span>
        </div>
      </div>
      <div className="flex items-baseline gap-2 pl-6 text-sm sm:justify-end sm:pl-0" data-testid="campaign-kr-now">
        <span className="text-muted-foreground">{STATUS_SAYS[light]}</span>
        <span className="font-semibold tabular-nums text-foreground">{k.value ?? "–"}</span>
        {k.target && <span className="tabular-nums text-muted-foreground">of {k.target}</span>}
      </div>
    </li>
  );
}

/**
 * The owner: "each product's social repo ... holds the chapters, [the social] data [repo] holds only the list of
 * campaigns and their key results". One quiet line on each of the campaign's own chapters says where it is read from,
 * only what is true: Key results from the list in the social data repo; Product, Benefits, Pipeline, History from the
 * product's social repo; Plan from the plan of the objective it serves (the owner: "It's the plan for the wheel").
 */
export const CHAPTER_FROM: Record<string, "list" | "repo" | "plan"> = { table: "list", product: "repo", benefits: "repo", pipeline: "repo", history: "repo", plan: "plan" };
export function ChapterHome({ m, tab }: { m: Milestone; tab: string }) {
  const q = useCampaignWheel(m);
  const from = CHAPTER_FROM[tab];
  const h = q.data?.homes;
  if (!from || !h) return null;
  const where =
    from === "list"
      ? h.list.listed
        ? `${h.list.repo} · ${h.list.path}`
        : null
      : from === "plan"
        ? h.plan?.length
          ? h.plan.map((p) => `${p.repo} · ${p.path}`).join(", ")
          : null
        : h.chapters.repo;
  if (!where) return null;
  return (
    <p className="mb-3 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="chapter-home" data-chapter={tab} data-from={from}>
      Read from <span className="font-medium text-foreground">{where}</span>
    </p>
  );
}

/** Key results: the objective's key results, each one line with its light, the first tab as on an objective. */
export function CampaignKeyResultsTab({ m }: { m: Milestone }) {
  return (
    <div data-testid="campaign-key-results">
      <WheelLoad m={m} what="key results">
        {(w) => (
          <div className="grid gap-6">
            {w.wheels.map((x) => {
              const greens = x.keyResults.filter((k) => k.colour === "green").length;
              return (
                <section key={x.id} id={`kr-${x.id}`} className="grid gap-2" data-testid="campaign-kr-wheel" data-wheel={x.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <h2 className="text-base font-semibold">{x.name}</h2>
                    <span className="text-sm tabular-nums text-muted-foreground" data-testid="campaign-kr-count">
                      {greens} of {x.keyResults.length} green
                    </span>
                  </div>
                  {x.keyResults.length ? (
                    <ul className="divide-y rounded-xl border bg-card">
                      {x.keyResults.map((k) => (
                        <KeyResultLine key={k.n} wheel={x.id} k={k} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No key result written for this objective yet.</p>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </WheelLoad>
    </div>
  );
}

/** Context: the objective's one where-we-are, then (passed in) the campaign's lessons. */
export function CampaignContextTab({ m, lessons }: { m: Milestone; lessons: ReactNode }) {
  return (
    <div className="grid gap-8" data-testid="campaign-context">
      <WheelLoad m={m} what="where-we-are">
        {(w) => (
          <div className="grid gap-4">
            {w.wheels.map((x) => (
              <div key={x.id} className="grid gap-1.5" data-wheel={x.id}>
                {w.wheels.length > 1 && <h2 className="text-sm font-medium text-muted-foreground">{x.name}</h2>}
                <WhereWeAreView data={x.where} />
              </div>
            ))}
          </div>
        )}
      </WheelLoad>
      <section id="campaign-lessons" className="scroll-mt-4" data-testid="campaign-lessons">
        {lessons}
      </section>
    </div>
  );
}

/** Pages: the served pages made for the objective, then the pages and notes kept in the campaign's repo. */
export function CampaignPagesTab({ m, repo }: { m: Milestone; repo?: string }) {
  const q = useCampaignWheel(m);
  const files = useHomeTab("all", "pages");
  const pages = useMemo(() => {
    const seen = new Set<string>();
    return (q.data?.wheels ?? []).flatMap((w) => w.pages).filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
  }, [q.data]);
  const mine = useMemo(() => (files.data?.entries ?? []).filter((e) => sameRepo(e.repo, repo ?? m.repo)), [files.data, repo, m.repo]);
  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  return <WheelPagesTab pages={pages} loading={q.loading} what="objective" files={{ entries: mine, loading: files.loading }} />;
}
