import { useMemo } from "react";
import { NavLink } from "react-router-dom";
import { api, type Milestone } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { ScorecardNode, ScorecardRow, ScorecardRowState } from "@/api/pursuit-types";
import { AnswerBox, STATE_FILL, TabStrip, WheelsTable, keyResultsOf, lightOf } from "@/components/goalSets";
import { CountPill, PILL_TITLES } from "@/components/homeSection";
import { INBOX_PATH } from "@/components/inboxLine";
import { campaignMilestones, campaignsByMilestone, useCampaigns } from "@/lib/campaign";
import { splitBigRoots } from "@/lib/bigRoots";
import { useQuery } from "@/lib/data";
import { blockedItems, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { milestoneName } from "@/lib/format";
import { useSnoozes } from "@/lib/snooze";
import { statusOf } from "@/lib/status";
import { cn } from "@/lib/utils";

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

/** one campaign as an objective node, so the console skin's table draws it. */
export function campaignNode(m: Pick<Milestone, "id" | "title" | "docTitle" | "titleOverride">, card: CampaignCard | undefined): ScorecardNode {
  const name = card?.campaign?.name ?? card?.title ?? milestoneName(m as Milestone);
  const krs = campaignKeyResults(card);
  return { id: m.id, kind: "pursuit", name, headline: name, milestoneId: m.id, greens: krs.filter((r) => r.state === "green").length, total: krs.length, spines: [], children: [], rows: [], keyResults: krs };
}

/**
 * the campaigns Home and the sidebar show: the ones he pinned (big roots) in his order; with none pinned, every live
 * campaign. `all` is every campaign of the world (the More fold lists them).
 */
export function useCampaignHome() {
  const ms = useQuery(() => api.listMilestones(), []);
  const camps = useCampaigns();
  const { data: statuses } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  const { cards } = useReviewCards();
  const byMs = useMemo(() => campaignsByMilestone(camps.data?.campaigns), [camps.data]);
  const all = useMemo(() => campaignMilestones(camps.data?.campaigns, ms.data), [camps.data, ms.data]);
  const { roots } = splitBigRoots(all);
  const pinned = roots.length > 0;
  const shown = pinned ? roots : all.filter((m) => byMs.has(m.id));
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
 * the sidebar's campaigns (social skin): his pinned campaigns, each its ring, its name and its inbox pills (the owner,
 * 13 Nov 20:03Z, on the console skin's sidebar: "we only need name, inbox and circle").
 */
export function SidebarCampaigns({ onNavigate }: { onNavigate?: () => void }) {
  const { nodes, cardOf, countFor, read } = useCampaignHome();
  if (!read || !nodes.length) return null;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1" data-testid="sidebar-campaigns">
      <div className="px-2.5 pb-0.5 text-xs font-medium text-muted-foreground">Your campaigns</div>
      <ul className="grid min-w-0 gap-1">
        {nodes.map((n) => {
          const card = cardOf(n.id);
          const c = countFor(n.id);
          return (
            <li key={n.id} className="grid min-w-0" data-testid="sidebar-campaign" data-milestone-id={n.id}>
              <NavLink
                to={`/milestones/${n.id}`}
                onClick={onNavigate}
                className={({ isActive }) => cn("flex min-w-0 items-center gap-2 rounded-md border-l-[3px] px-2.5 py-1.5", isActive ? "border-l-foreground bg-card shadow-sm ring-1 ring-border" : "border-l-transparent hover:bg-accent/60")}
                title={[n.name, card?.goal?.line].filter(Boolean).join(": ")}
                data-testid="sidebar-campaign-link"
              >
                <CampaignRing metric={card?.goal?.metric} />
                <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="sidebar-campaign-name">
                  {n.name}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {c.ask > 0 && <CountPill count={c.ask} tone="needs-you" title={PILL_TITLES["needs-you"](c.ask)} testId="sidebar-campaign-asks" />}
                  {c.review > 0 && <CountPill count={c.review} tone="review" title={PILL_TITLES.review(c.review)} testId="sidebar-campaign-review" />}
                </span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** the one-line answer: each campaign's number, then what waits on him. */
export function campaignAnswer(nodes: ScorecardNode[], cardOf: (id: string) => CampaignCard | undefined, waits: number): string {
  const numbers = nodes.map((n) => {
    const m = cardOf(n.id)?.goal?.metric;
    return m ? `${n.name} ${m.now === null ? "?" : m.now} of ${m.target} ${m.label}` : `${n.name} has no number yet`;
  });
  const lead = nodes.length === 1 ? "One campaign" : `${nodes.length} campaigns`;
  return `${lead}: ${numbers.join(", ")}. ${waits === 0 ? "Nothing waits on you." : `${waits} ${waits === 1 ? "thing waits" : "things wait"} on you.`}`;
}

const HOME_TABS = [{ id: "table", label: "Campaigns" }] as const;

/** the social skin's Home: the console skin's All objectives page with his campaigns as the objectives. */
export function CampaignsHome() {
  const { nodes, cardOf, countFor, pinned, all, loading, error } = useCampaignHome();
  const krs = nodes.flatMap(keyResultsOf);
  const waits = nodes.reduce((s, n) => s + countFor(n.id).ask + countFor(n.id).review, 0);
  const others = all.length - nodes.length;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="campaigns-home">
      <AnswerBox light={lightOf(krs)} title={pinned ? "Your campaigns" : "Every campaign"} testId="campaigns-answer" answer={loading ? "Reading your campaigns…" : nodes.length ? campaignAnswer(nodes, cardOf, waits) : "No campaign runs yet."} />
      {error && <div className="text-sm text-destructive">Could not read the campaigns: {error.message}</div>}
      <TabStrip tabs={HOME_TABS} tab="table" links={{ inbox: { label: "Inbox", to: `/${INBOX_PATH}`, count: waits } }} label="Home pages" />
      {nodes.length > 0 && (
        <WheelsTable nodes={nodes} countFor={countFor} hrefOf={(n) => `/milestones/${n.id}`} lead={(n) => <CampaignRing metric={cardOf(n.id)?.goal?.metric} size={34} />} />
      )}
      {others > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="campaigns-home-more">
          {others} more {others === 1 ? "campaign is" : "campaigns are"} under More in the menu{pinned ? ": pin one to show it here." : "."}
        </p>
      )}
    </div>
  );
}
