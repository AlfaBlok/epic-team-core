import { GoalHeader, GoalSetsPage, KeyResultSheet, useGoalSets } from "@/components/goalSets";
import type { ScorecardRow } from "@/api/pursuit-types";
import type { FirstObjective } from "@/api/client";
import { useShows, useSkin } from "@/lib/skin";
import { INBOX_PATH } from "@/components/inboxLine";
import { HomeBuyLine } from "@/components/buyPlan";
import { CampaignsHome, useCampaignHome } from "@/components/campaignHome";
import { lazyPage } from "@/lib/lazyPage";
import { useState } from "react";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { homeWorld } from "@/lib/identity";
import { knownDoor, knownWorld, worldId } from "@/lib/useSocial";
import { Loading } from "@/components/common";

// The Inbox page (and Home in a world with no goal sets) loads its script when shown.
const TeamPage = lazyPage(() => import("@/pages/Team"), "TeamPage");
const GettingGoingChat = lazyPage(() => import("@/pages/Chat"), "GettingGoingChat");

export { INBOX_PATH };

/**
 * the owner, 2026-11-12 22:43Z: "at the top, I need a navigation direct to the inbox, a direct access,
 * just as I have a direct access to the chat and the microphone". Home is the bird's-eye goals view (All goal sets: every
 * set's rows, green, amber or red, and the combined inbox tab); the full Inbox has its own route, one tap away in the top
 * bar beside Chat and the mic, in both skins.
 *
 * One place picks what Home shows. A world with no goal sets keeps what it had: the social skin its projects' campaigns
 * (the inbox lists on their own page), the console skin the Inbox.
 */
export function HomePage() {
  const shows = useShows();
  const campaigns = !!useSkin().campaigns;
  const fallback = campaigns ? <TeamPage only="goals" /> : <TeamPage />;
  // a customer world that can buy the paid plan sees one line with the Buy button on top of Home
  return (
    <>
      <HomeBuyLine />
      {/* the same page in both skins (L-62): the console skin's All objectives with its objectives, the social skin's with his
          pinned campaigns as the objectives (the owner 13 Nov: "look at what we did in epicteam"). */}
      {campaigns ? <CampaignsHomeOr fallback={fallback} /> : <ChatHomeOr fallback={shows("goalSets") ? <GoalsHome fallback={fallback} /> : fallback} />}
    </>
  );
}

/**
 * the owner 2026-11-17 (vn_7bc94847: "one objective and several key results ... First objective, get set up, and then key
 * results, each of the key results"; 16 Nov: "it should just chat ... load with first objective ... make them all green.
 * With an eager chat agent focused on getting green"): a paid EpicTeam customer workspace's Home is its one objective,
 * Get set up, with its key results and their lights, drawn like the owner's own objectives (GoalHeader, KeyResultSheet), and
 * its chat beside it (under it on a phone), which works them green. Every other world (ours, an unpaid workspace, through
 * the door) keeps what it had.
 */
function ChatHomeOr({ fallback }: { fallback: JSX.Element }) {
  const [known] = useState(knownWorld);
  const world = useQuery(() => worldId(), []);
  const w = world.data ?? known;
  const customer = !!w && w !== homeWorld() && !knownDoor();
  const objective = useQuery(() => (customer ? api.getFirstObjective(w) : Promise.resolve(undefined)), [customer, w]);
  if (!customer) return world.loading && w === undefined ? <Loading /> : fallback;
  if (objective.loading && !objective.data) return <Loading />;
  if (!objective.data) return fallback;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-5" data-testid="get-set-up-home">
      <GetSetUp objective={objective.data} />
      <GettingGoingChat world={w} fresh={objective.data.green <= 1} />
    </div>
  );
}

const KR_VALUE = { green: "Done", amber: "Not yet", red: "Waiting" } as const;

/** the workspace's one first objective as the owner's objectives are drawn: its wheel, its name, its answer, its key results. */
export function GetSetUp({ objective: o }: { objective: FirstObjective }) {
  const krs: ScorecardRow[] = o.keyResults.map((k) => ({ label: k.name, state: k.state, kind: "key-result", value: KR_VALUE[k.state], target: k.target, note: k.note, measuredAt: o.measuredAt }));
  const next = o.keyResults.find((k) => k.state === "amber") ?? o.keyResults.find((k) => k.state !== "green");
  return (
    <section className="grid min-w-0 content-start gap-3" data-testid="get-set-up" aria-label={`${o.name}: ${o.green} of ${o.total} key results green`}>
      <GoalHeader rows={krs} title={o.name} answer={next ? `${o.green} of ${o.total} key results are green. Next: ${next.name.toLowerCase()}.` : `All ${o.total} key results are green: you are set up.`} />
      <KeyResultSheet krs={krs} setId={o.milestoneId} plain />
    </section>
  );
}

function GoalsHome({ fallback }: { fallback: JSX.Element }) {
  const { data, error } = useGoalSets();
  // no goal sets here (the server names none, or cannot read them): Home stays what it was.
  if (error || (data && !data.nodes?.length)) return fallback;
  return <GoalSetsPage />;
}

function CampaignsHomeOr({ fallback }: { fallback: JSX.Element }) {
  const { read, all, error } = useCampaignHome();
  // a world with no campaign yet (or that cannot read them) keeps what it had: the goals view.
  if (error || (read && !all.length)) return fallback;
  return <CampaignsHome />;
}

/** the Inbox page: what waits on him, every section, nothing else (both skins). */
export function InboxPage() {
  return <TeamPage only="inbox" />;
}
