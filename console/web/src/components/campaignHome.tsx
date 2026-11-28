import { Plus } from "lucide-react";
import { useMemo } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api, type Milestone } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { ScorecardNode, ScorecardRow, ScorecardRowState } from "@/api/pursuit-types";
import { BriefingSlot } from "@/components/briefing";
import { AnswerBox, STATE_FILL, TabStrip, WheelsTable, keyResultsOf, lightOf } from "@/components/goalSets";
import { INBOX_PATH } from "@/components/inboxLine";
import { campaignMilestones, campaignsByMilestone, useCampaigns } from "@/lib/campaign";
import { splitBigRoots } from "@/lib/bigRoots";
import { useSharedQuery } from "@/lib/data";
import { blockedItems, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { milestoneName } from "@/lib/format";
import { useSnoozes } from "@/lib/snooze";
import { statusOf } from "@/lib/status";
import { cn } from "@/lib/utils";
import { brandOfRepo } from "@/lib/project";
import { SidebarObjective } from "@/components/goalSets";
import { SET_NAME } from "@/lib/scorecards";

/**
 * the social skin's Home and the top of its sidebar, built on the console skin's All objectives page (one shared console, L-62).
 * The owner, 12 Nov 16:02Z (vn_26245cfc): "If you look at the sidebar of the Epic Social, it's a total mess … we have
 * two campaigns going on, only two … I just want to see the thing that I put there … it should just look like Epic Team
 * for the most part." His answer on the mock-up, 13 Nov: "Sidebar in the right direction home design stale look at what
 * we did in epicteam go deliver".
 *
 * So a campaign is an objective here: the campaigns he pinned, in his order, each one lean row of the same table
 * the console skin's Home draws (traffic light, name, a colour bar, the inbox pills), and the sidebar lists the same campaigns
 * with their number in a ring. A world with nothing pinned shows its live campaigns. Read only.
 */

type Metric = NonNullable<NonNullable<CampaignCard["goal"]>["metric"]>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso ?? "";
};

/** the goal number's colour: at target green, on its way amber, nothing yet red, unread grey. */
export function metricState(m: Metric | null | undefined): ScorecardRowState {
  if (!m || m.now === null) return "unknown";
  if (m.now >= m.target) return "green";
  return m.now > 0 ? "amber" : "red";
}

const SIGN_IN: Record<string, ScorecardRowState> = { green: "green", amber: "amber", red: "red", grey: "unknown" };

/**
 * a campaign's key results, read from its card: its goal number, whether it posts, and each channel's sign-in. The colour
 * bar of its row is these, one block each.
 */
export function campaignKeyResults(card: CampaignCard | undefined): ScorecardRow[] {
  if (!card) return [];
  const m = card.goal?.metric ?? null;
  const rows: ScorecardRow[] = [
    {
      label: m ? `${cap(m.label)}` : "Its goal number",
      kind: "key-result",
      state: metricState(m),
      value: m ? `${m.now === null ? "?" : m.now} of ${m.target}` : "no number yet",
      ...(m ? { target: `${m.target}${m.by ? ` by ${day(m.by)}` : ""}` } : {}),
      ...(m?.proposed ? { note: "number proposed, yours to set" } : {}),
    },
  ];
  if (card.posting) rows.push({ label: "Posting", kind: "check", state: card.posting.live ? "green" : "amber", value: card.posting.line });
  for (const ch of card.channels ?? []) rows.push({ label: `${ch.name} sign-in`, kind: "check", state: SIGN_IN[ch.signIn.state] ?? "unknown", value: ch.signIn.line });
  return rows;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * one of the world's objectives (his "it's objective everywhere", 28 Nov 12:47Z, Log/2026-11-28.md#^e-497258) as an
 * objective node, named `Product: goal` like every EpicTeam objective (the product from its repo), so the sidebar row and
 * the home table draw it exactly as the console skin draws its objectives.
 */
export function campaignNode(m: Pick<Milestone, "id" | "title" | "docTitle" | "titleOverride">, card: CampaignCard | undefined): ScorecardNode {
  const goal = card?.campaign?.name ?? card?.title ?? milestoneName(m as Milestone);
  const product = card?.repo ? brandOfRepo(card.repo).replace(/\s+/g, "") : "";
  const name = product && !goal.includes(":") ? `${product}: ${goal}` : goal;
  const krs = campaignKeyResults(card);
  return { id: m.id, kind: "pursuit", name, headline: name, milestoneId: m.id, greens: krs.filter((r) => r.state === "green").length, total: krs.length, spines: [], children: [], rows: [], keyResults: krs };
}

/**
 * the campaigns Home and the sidebar show: the ones he pinned (big roots) in his order; with none pinned, every live
 * campaign. `all` is every campaign of the world (the More fold lists them).
 */
export function useCampaignHome() {
  const ms = useSharedQuery("sb:milestones", () => api.listMilestones());
  const camps = useCampaigns();
  const { data: statuses } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  const { cards } = useReviewCards();
  const byMs = useMemo(() => campaignsByMilestone(camps.data?.campaigns), [camps.data]);
  const all = useMemo(() => campaignMilestones(camps.data?.campaigns, ms.data), [camps.data, ms.data]);
  const { roots } = splitBigRoots(all);
  const pinned = roots.length > 0;
  // only the world's objectives, never a milestone with no card of its own (one entry type, one page: ^e-483365)
  const shown = (pinned ? roots : all).filter((m) => byMs.has(m.id));
  const nodes = shown.map((m) => campaignNode(m, byMs.get(m.id)));
  const countFor = (id: string) => ({
    ask: statusOf(statuses, id)?.loading ? 0 : blockedItems(statusOf(statuses, id), { snoozing }).length,
    review: (cards ?? []).filter((c) => c.milestoneId === id).length,
  });
  const loading = (ms.loading && !ms.data) || (camps.loading && !camps.data);
  return { nodes, cardOf: (id: string) => byMs.get(id), countFor, pinned, all, loading, error: ms.error ?? camps.error, read: !!ms.data && !!camps.data };
}

/** the goal number in a small ring ("2/10"), filled as far as it got; an empty ring with a dash when there is none. */
export function CampaignRing({ metric, size = 30 }: { metric: Metric | null | undefined; size?: number }) {
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  const share = metric && metric.now !== null && metric.target > 0 ? Math.max(0, Math.min(1, metric.now / metric.target)) : 0;
  const text = metric ? `${metric.now === null ? "?" : metric.now}/${metric.target}` : "–";
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={metric ? `${metric.now ?? "?"} of ${metric.target} ${metric.label}` : "no goal number yet"} data-testid="campaign-ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={3} className="text-muted" />
        {share > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STATE_FILL[metricState(metric)]} strokeWidth={3} strokeLinecap="round" strokeDasharray={`${Math.max(share * c, 2)} ${c}`} />}
      </svg>
      <span className={cn("relative font-semibold tabular-nums leading-none text-foreground", text.length > 4 ? "text-[8px]" : "text-[9px]")}>{text}</span>
    </span>
  );
}

/**
 * the sidebar's objectives (social skin), drawn by the very row the console skin's objectives use (SidebarObjective): his
 * 28 Nov words, "every entry of the sidebar is identical in structure ... Single schema per app. Single UX per app"
 * (Log/2026-11-28.md#^e-483365) and "let's just call them objectives" (^e-497258). One heading, one entry type, each
 * opening its objective page with this app's chapters.
 */
export function SidebarCampaigns({ onNavigate }: { onNavigate?: () => void }) {
  const { nodes, countFor, read } = useCampaignHome();
  const { pathname } = useLocation();
  if (!read) return null;
  const activeId = pathname.startsWith("/milestones/") ? decodeURIComponent(pathname.split("/")[2] ?? "") : undefined;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1" data-testid="sidebar-campaigns">
      {nodes.length > 0 && <div className="px-2.5 pb-0.5 text-xs font-medium text-muted-foreground" data-testid="sidebar-objectives-heading">{SET_NAME.many}</div>}
      {nodes.length > 0 && <ul className="grid min-w-0 gap-1" data-testid="sidebar-objectives">
        {nodes.map((n) => (
          <SidebarObjective key={n.id} n={n} countFor={countFor} onNavigate={onNavigate} activeId={activeId} href={`/milestones/${n.id}`} inboxHref={`/milestones/${n.id}?tab=waiting`} />
        ))}
      </ul>}
      <NavLink to="/campaigns/new" onClick={onNavigate} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground" data-testid="sidebar-add-campaign">
        <Plus className="h-4 w-4" />
        Add objective
      </NavLink>
    </div>
  );
}

/** the one-line answer: each campaign's number, then what waits on him. */
export function campaignAnswer(nodes: ScorecardNode[], cardOf: (id: string) => CampaignCard | undefined, waits: number): string {
  const numbers = nodes.map((n) => {
    const m = cardOf(n.id)?.goal?.metric;
    return m ? `${n.name} ${m.now === null ? "?" : m.now} of ${m.target} ${m.label}` : `${n.name} has no number yet`;
  });
  const lead = nodes.length === 1 ? "One objective" : `${nodes.length} objectives`;
  return `${lead}: ${numbers.join(", ")}. ${waits === 0 ? "Nothing waits on you." : `${waits} ${waits === 1 ? "thing waits" : "things wait"} on you.`}`;
}

const HOME_TABS = [{ id: "table", label: "Objectives" }] as const;

/** the social skin's Home: the console skin's All objectives page with his campaigns as the objectives. */
export function CampaignsHome() {
  const { nodes, cardOf, countFor, pinned, all, loading, error } = useCampaignHome();
  const krs = nodes.flatMap(keyResultsOf);
  const waits = nodes.reduce((s, n) => s + countFor(n.id).ask + countFor(n.id).review, 0);
  const others = all.length - nodes.length;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="campaigns-home">
      <AnswerBox light={lightOf(krs)} title={pinned ? "Your objectives" : "Every objective"} testId="campaigns-answer" answer={loading ? "Reading your objectives…" : nodes.length ? campaignAnswer(nodes, cardOf, waits) : "No objective runs yet."} />
      {error && <div className="text-sm text-destructive">Could not read the campaigns: {error.message}</div>}
      <TabStrip tabs={HOME_TABS} tab="table" links={{ inbox: { label: "Inbox", to: `/${INBOX_PATH}`, count: waits } }} label="Home pages" />
      {!loading && <BriefingSlot nodes={nodes} kind="campaign" />}
      {nodes.length > 0 && (
        <WheelsTable nodes={nodes} countFor={countFor} hrefOf={(n) => `/milestones/${n.id}`} lead={(n) => <CampaignRing metric={cardOf(n.id)?.goal?.metric} size={34} />} />
      )}
      {others > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="campaigns-home-more">
          {others} more {others === 1 ? "objective is" : "objectives are"} kept, not on the menu{pinned ? ": pin one to show it here." : "."}
        </p>
      )}
    </div>
  );
}
