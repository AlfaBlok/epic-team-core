import { Link } from "react-router-dom";
import { ObjectiveName } from "@/components/objectiveName";
import { api } from "@/api";
import type { Experiment, ExperimentKeyResult, WorldCampaign, WorldInbox } from "@/api/company-types";
import { pursuitTitle, type Pursuit } from "@/api/pursuit-types";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { GoalBlock, useGoals } from "@/components/goalLights";
import { useOtherWorlds } from "@/components/otherWorlds";
import { useSlotReady } from "@/components/slot";
import { useQuery } from "@/lib/data";
import { saysNeedle, useSearchNeedle } from "@/lib/inboxSearch";
import { cn } from "@/lib/utils";

/**
 * The owner (2026-11-12 22:19Z: "I want to see like each campaign, each pursuit … One thing that is
 * meaningful to me is [the] testers … we can count the number … we want that number to go to 10"). After what is blocked
 * on him, his Inbox shows each live campaign as one line: its name, its one number toward its goal ("1 of 10 testers
 * signed up") and today's change; then each pursuit with its green lines. Further down, a goal-talk line for every
 * campaign whose number is not set, and a few "since yesterday" lines. All read only, from the campaign worlds' own
 * lists (GET /api/worlds, campaigns with goal.metric) and GET /api/pursuits; nothing here writes.
 */

export interface CampaignRow {
  name: string;
  app: string;
  openUrl: string;
  sentence?: string;
  metric?: NonNullable<WorldCampaign["metric"]>;
  digest?: WorldCampaign["digest"];
}

/** every world's live campaigns, once each, in the order the owner cares about: a number he set first (the one he
 *  counts, e.g. testers), then a proposed number, then none; inside each, the world's own order. */
export function campaignRows(worlds: WorldInbox[] | undefined): CampaignRow[] {
  const seen = new Set<string>();
  const rows: CampaignRow[] = [];
  for (const w of worlds ?? []) {
    for (const c of w.campaigns ?? []) {
      if (seen.has(c.milestoneId)) continue;
      seen.add(c.milestoneId);
      rows.push({ name: c.name, app: w.app, openUrl: c.openUrl, ...(c.sentence ? { sentence: c.sentence } : {}), ...(c.metric ? { metric: c.metric } : {}), ...(c.digest ? { digest: c.digest } : {}) });
    }
  }
  const rank = (r: CampaignRow) => (!r.metric ? 2 : r.metric.proposed ? 1 : 0);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** "1 of 10" (or "? of 10" when the number could not be read: never a fake zero). */
export const countText = (m: NonNullable<CampaignRow["metric"]>) => `${m.now === null ? "?" : m.now} of ${m.target}`;

/** today's change in plain words, or undefined when there is no earlier reading. */
export function changeText(m: NonNullable<CampaignRow["metric"]>): string | undefined {
  if (m.was === undefined || m.now === null) return undefined;
  const d = m.now - m.was;
  return d === 0 ? "no change today" : `${d > 0 ? "+" : ""}${d} today`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDay = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso;
};

/** the share of the goal reached, 0 to 100 (0 while unread). */
export const reached = (m: NonNullable<CampaignRow["metric"]>) => (m.now === null || m.target <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((m.now / m.target) * 100))));

/** the goal talk: one question per campaign whose number is not his yet (none written, or only proposed). */
export function goalTalk(rows: CampaignRow[]): { name: string; openUrl: string; app: string; text: string }[] {
  return rows
    .filter((r) => !r.metric || r.metric.proposed)
    .map((r) => ({
      name: r.name,
      openUrl: r.openUrl,
      app: r.app,
      text: r.metric
        ? `The team proposes ${r.metric.target} ${r.metric.label}${r.metric.by ? ` by ${shortDay(r.metric.by)}` : ""}. Is that the goal?`
        : r.sentence
          ? `It has no number yet. What number would tell you it worked?`
          : `It has no goal yet. What should it reach, and by when?`,
    }));
}

/** since yesterday: each number that moved today, then each report of the last two days (one line, once each). */
export function sinceYesterday(rows: CampaignRow[], now = new Date()): { key: string; text: string; openUrl?: string }[] {
  const out: { key: string; text: string; openUrl?: string }[] = [];
  for (const r of rows) {
    const m = r.metric;
    if (m && m.was !== undefined && m.now !== null && m.now !== m.was) out.push({ key: `move:${r.name}`, text: `${r.name} went from ${m.was} to ${m.now} ${m.label}.`, openUrl: r.openUrl });
  }
  const cutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const lines = new Set<string>();
  for (const r of rows) {
    const d = r.digest;
    if (!d || d.date < cutoff || lines.has(d.line)) continue;
    lines.add(d.line);
    out.push({ key: `report:${d.date}:${r.name}`, text: `${shortDay(d.date)} report: ${plainLine(d.line)}`, openUrl: r.openUrl });
  }
  return out;
}

/** a report line in plain words: no heading marks, no bold, links as their words. */
export const plainLine = (t: string) =>
  t
    .replace(/^#+\s*/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();

/** a key result's number against its goal: "0 of 3" for a count, "+9 of 30" for what was added since the start. */
export function keyResultText(k: ExperimentKeyResult): string {
  if (k.kind === "gain") return k.gained === null ? `? of ${k.goal}` : `${k.gained > 0 ? "+" : ""}${k.gained} of ${k.goal}`;
  return `${k.now === null ? "?" : k.now} of ${k.goal}`;
}
/** the share of a key result's goal reached, 0 to 100. */
export const keyResultPct = (k: ExperimentKeyResult) => {
  const v = k.kind === "gain" ? k.gained : k.now;
  return v === null || k.goal <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((v / k.goal) * 100)));
};

const useExperiments = () => useQuery(() => (api.listExperiments ? api.listExperiments() : Promise.resolve({ experiments: [] as Experiment[] })), [], { tag: "inbox" });

const usePursuits = () => useQuery(() => (api.listPursuits ? api.listPursuits() : Promise.resolve({ pursuits: [], staleDays: 0 })), [], { tag: "inbox" });

/** the pursuits in his order (parked ones out). */
export const livePursuits = (ps: Pursuit[] | undefined) =>
  (ps ?? []).filter((p) => p.rank !== null).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

/** each campaign and each pursuit as one line: its goal and its one number, the first one the one he counts. */
export function CampaignGoals() {
  const worlds = useOtherWorlds();
  const pursuits = usePursuits();
  const exps = useExperiments();
  const goals = useGoals();
  useSlotReady((!!worlds.data || !!worlds.error) && (!!pursuits.data || !!pursuits.error) && (!!exps.data || !!exps.error) && (!!goals.data || !!goals.error));
  const [open, setOpen] = useSectionOpen("campaign-goals");
  // E948-S78: the Inbox search keeps only the goals, experiments, campaigns and pursuits whose words hold it; none left, the block hides.
  const needle = useSearchNeedle();
  const rows = campaignRows(worlds.data?.worlds).filter((r) => r.metric && saysNeedle(needle, r.name, r.metric.label));
  const ps = livePursuits(pursuits.data?.pursuits).filter((p) => saysNeedle(needle, pursuitTitle(p), p.name));
  const xs = (exps.data?.experiments ?? []).filter((x) => saysNeedle(needle, x.headline, x.name, ...x.keyResults.map((k) => k.label)));
  const gs = (goals.data?.goals ?? []).filter((g) => saysNeedle(needle, g.name, g.label, ...g.keyResults.map((k) => k.label)));
  if (!rows.length && !ps.length && !xs.length && !gs.length) return null;
  return (
    <FoldSection title="Your goals and their numbers" count={rows.length + ps.length + xs.length + gs.length} tone="info" testId="campaign-goals" open={open || !!needle} onToggle={setOpen}>
      {/* the home repo's one goal first ("5 testers using SocialApp · N of 5"), its key results with a light each. */}
      {gs.map((g) => (
        <GoalBlock key={g.id} g={g} className="mb-2" />
      ))}
      {xs.map((x) => (
        <ExperimentBlock key={x.id} x={x} />
      ))}
      <ul className="grid gap-1.5" data-testid="campaign-goals-list">
        {rows.map((r) => (
          <CampaignLine key={r.openUrl} r={r} />
        ))}
        {ps.map((p) => (
          <PursuitLine key={p.id} p={p} />
        ))}
      </ul>
    </FoldSection>
  );
}

/** a running experiment: its headline, then each key result as now against goal, with its source. */
function ExperimentBlock({ x }: { x: Experiment }) {
  return (
    <div className="mb-2 grid gap-2 rounded-md bg-card px-3 py-3" data-testid="experiment" data-id={x.id}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 text-sm font-semibold" data-testid="experiment-headline">
          {x.headline}
        </span>
        {x.plan && (
          // a finger-sized target (44 px) on every screen: the quality pass measured it 87x18 at 390 and 768 px.
          <a href={x.plan} target="_blank" rel="noreferrer" data-testid="experiment-plan" className="ml-auto inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium underline-offset-2 hover:bg-muted/60 hover:underline">
            Open the plan
          </a>
        )}
      </div>
      {(x.from || x.status) && (
        <span className="text-xs text-muted-foreground">
          {x.from && x.to ? `${shortDay(x.from)} to ${shortDay(x.to)}` : ""}
          {x.from && x.status ? ", " : ""}
          {x.status ?? ""}
        </span>
      )}
      <ul className="grid gap-1.5">
        {x.keyResults.map((k) => (
          <li key={k.id} className="grid gap-1" data-testid="experiment-kr">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              <span className="min-w-0">{k.label}</span>
              <span className="ml-auto font-semibold tabular-nums">{keyResultText(k)}</span>
            </span>
            <Bar pct={keyResultPct(k)} tone={k.onTrack ? "green" : "violet"} />
            {k.source && (
              <span className="text-xs text-muted-foreground">
                {k.kind === "gain" && x.from ? `since ${shortDay(x.from)}, ` : ""}
                {k.sourceUrl ? (
                  <a href={k.sourceUrl} target="_blank" rel="noreferrer" data-testid="experiment-source" className="inline-flex min-h-11 items-center underline-offset-2 hover:underline">
                    {k.source}
                  </a>
                ) : (
                  k.source
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bar({ pct, tone }: { pct: number; tone: "violet" | "green" | "red" }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className={cn("block h-full rounded-full", tone === "violet" ? "bg-violet-600" : tone === "green" ? "bg-emerald-600" : "bg-red-500")} style={{ width: `${Math.max(pct, 2)}%` }} />
    </span>
  );
}

function CampaignLine({ r }: { r: CampaignRow }) {
  const m = r.metric!;
  const change = changeText(m);
  return (
    <li data-testid="campaign-goal" data-name={r.name}>
      <a href={r.openUrl} target="_blank" rel="noreferrer" data-line="" className="grid gap-1 rounded-md bg-card px-3 py-2.5 hover:bg-muted/60">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{r.name}</span>
          <span className="ml-auto text-base font-semibold tabular-nums" data-testid="campaign-goal-count">
            {countText(m)}
          </span>
        </span>
        <Bar pct={reached(m)} tone="violet" />
        <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>
            {m.label}
            {m.by ? ` by ${shortDay(m.by)}` : ""}
            {m.proposed ? ", number proposed" : ""}
          </span>
          {change && (
            <span className={cn("ml-auto font-medium", change.startsWith("+") ? "text-emerald-700 dark:text-emerald-400" : change.startsWith("-") ? "text-red-600" : "")} data-testid="campaign-goal-change">
              {change}
            </span>
          )}
        </span>
      </a>
    </li>
  );
}

function PursuitLine({ p }: { p: Pursuit }) {
  const pct = p.total ? Math.round((p.greens / p.total) * 100) : 0;
  return (
    <li data-testid="pursuit-goal" data-name={p.name}>
      <Link to={`/pursuits/${encodeURIComponent(p.id)}`} data-line="" className="grid gap-1 rounded-md bg-card px-3 py-2.5 hover:bg-muted/60">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]" data-testid="pursuit-goal-name"><ObjectiveName name={pursuitTitle(p)} /></span>
          {!p.goal && (
            <span className="ml-auto text-base font-semibold tabular-nums">
              {p.greens} of {p.total}
            </span>
          )}
        </span>
        <Bar pct={p.goal ? Math.round((Math.min(p.goal.now, p.goal.target) / p.goal.target) * 100) : pct} tone={p.state === "green" ? "green" : "red"} />
        <span className="text-xs text-muted-foreground">
          {p.goal ? `${p.greens} of ${p.total} lines green` : "lines green"}
          {p.motion === "stalled" ? ", stalled" : ""}
        </span>
      </Link>
    </li>
  );
}

/** each campaign whose goal number is not his yet, as one question (the Inbox's search applied). */
export function useGoalTalk() {
  const { data, error } = useOtherWorlds();
  const needle = useSearchNeedle();
  return { talk: goalTalk(campaignRows(data?.worlds)).filter((t) => saysNeedle(needle, t.name, t.text)), ready: !!data || !!error, needle };
}

/** a few lines: what moved today and the newest reports. */
export function SinceYesterday() {
  const { data } = useOtherWorlds();
  const [open, setOpen] = useSectionOpen("since-yesterday");
  const needle = useSearchNeedle();
  const lines = sinceYesterday(campaignRows(data?.worlds)).filter((l) => saysNeedle(needle, l.text));
  if (!lines.length) return null;
  return (
    <FoldSection title="Since yesterday" count={lines.length} tone="info" testId="since-yesterday" open={open || !!needle} onToggle={setOpen}>
      <ul className="grid gap-1.5 text-sm">
        {lines.map((l) => (
          <li key={l.key} data-testid="since-yesterday-line">
            <a href={l.openUrl} target="_blank" rel="noreferrer" data-line="" className="block rounded-md bg-card px-3 py-2 hover:bg-muted/60">
              {l.text}
            </a>
          </li>
        ))}
      </ul>
    </FoldSection>
  );
}
