import { GoalHeader, GoalSetsPage, KeyResultSheet, useGoalSets } from "@/components/goalSets";
import type { ScorecardRow } from "@/api/pursuit-types";
import { isCleanWorkspace, type CleanWorkspace, type FirstObjective } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useShows, useSkin } from "@/lib/skin";
import { INBOX_PATH } from "@/components/inboxLine";
import { HomeBuyLine } from "@/components/buyPlan";
import { HomeRepoLine } from "@/components/worldRepo";
import { CampaignsHome, useCampaignHome } from "@/components/campaignHome";
import { lazyPage } from "@/lib/lazyPage";
import { useState } from "react";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { homeWorld } from "@/lib/identity";
import { knownDoor, knownWorld, worldId } from "@/lib/useSocial";
import { Loading } from "@/components/common";
import { useOnboardingLeads } from "@/lib/onboardingLeads";

// The Inbox page (and Home in a world with no goal sets) loads its script when shown.
const TeamPage = lazyPage(() => import("@/pages/Team"), "TeamPage");
const GettingGoingChat = lazyPage(() => import("@/pages/Chat"), "GettingGoingChat");
const MilestoneDialog = lazyPage(() => import("@/components/dialogs"), "MilestoneDialog", null);
// the onboarding call loads its call code only on a customer workspace's Home (never in the main script)
const OnboardingCall = lazyPage(() => import("@/components/onboardingCall"), "OnboardingCall", null);

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
  const w = useCustomerWorld();
  const leads = useOnboardingLeads();
  // an onboarding call that wrote the first objective reads Home again at its end
  const [ended, setEnded] = useState(0);
  // a customer world that can buy the paid plan sees one line with the Buy button on top of Home
  return (
    <>
      {/* (call_910685a3: "guide the user towards a button at the beginning"): a new EpicTeam workspace's first screen
          leads to one Call, its onboarding helper, until it has an objective of its own; the rest waits under it */}
      {!campaigns && w && (
        <div className="mb-6 max-w-3xl empty:hidden">
          <OnboardingCall world={w} onWritten={() => setEnded((n) => n + 1)} />
        </div>
      )}
      <HomeBuyLine />
      {!leads && <HomeRepoLine />}
      {/* the same page in both skins (L-62): the console skin's All objectives with its objectives, the social skin's with his
          pinned campaigns as the objectives (the owner 13 Nov: "look at what we did in epicteam"). */}
      {campaigns ? <CampaignsHomeOr fallback={fallback} /> : <ChatHomeOr ended={ended} fallback={shows("goalSets") ? <GoalsHome fallback={fallback} /> : fallback} />}
    </>
  );
}

/**
 * the owner 2026-11-17 (vn_7bc94847: "one objective and several key results ... First objective, get set up, and then key
 * results, each of the key results"; 16 Nov: "it should just chat ... load with first objective ... make them all green.
 * With an eager chat agent focused on getting green"): a paid EpicTeam customer workspace's Home is its one objective,
 * Get set up, with its key results and their lights, drawn like the owner's own objectives (GoalHeader, KeyResultSheet), and
 * its chat under it in one column (the owner 22 Nov, step note on the four steps: "hate this 2 col design for this home"), which works them green. Every other world (ours, an unpaid workspace, through
 * the door) keeps what it had.
 */
/** the caller's world when it is a customer's (not ours, not through the door), else undefined. */
function useCustomerWorld(): string | undefined {
  const [known] = useState(knownWorld);
  const world = useQuery(() => worldId(), []);
  const w = world.data ?? known;
  return !!w && w !== homeWorld() && !knownDoor() ? w : undefined;
}

function ChatHomeOr({ fallback, ended = 0 }: { fallback: JSX.Element; ended?: number }) {
  const [known] = useState(knownWorld);
  const world = useQuery(() => worldId(), []);
  const w = world.data ?? known;
  const customer = !!w && w !== homeWorld() && !knownDoor();
  const objective = useQuery(() => (customer ? api.getFirstObjective(w) : Promise.resolve(undefined)), [customer, w, ended]);
  if (!customer) return world.loading && w === undefined ? <Loading /> : fallback;
  if (objective.loading && !objective.data) return <Loading />;
  if (!objective.data) return fallback;
  // the owner 17 Nov (vn_c149df3a): a new workspace of an account that already has one has no Get set
  // up: Home shows the workspace, the objectives its owner added (none at first) and its chat
  if (isCleanWorkspace(objective.data))
    return (
      <div className="grid min-w-0 max-w-3xl gap-8" data-testid="clean-workspace-home">
        <CleanWorkspaceHome workspace={objective.data} />
        <GettingGoingChat world={w} fresh={!objective.data.objectives.length} clean />
      </div>
    );
  return (
    <div className="grid min-w-0 max-w-3xl gap-8" data-testid="get-set-up-home">
      <GetSetUp objective={objective.data} />
      <GettingGoingChat world={w} fresh={objective.data.green <= 1} />
    </div>
  );
}

/** a clean workspace's Home: its name, its objectives each with its results green of total, and Add objective. */
export function CleanWorkspaceHome({ workspace: o }: { workspace: CleanWorkspace }) {
  const [adding, setAdding] = useState(false);
  const none = !o.objectives.length;
  return (
    <section className="grid min-w-0 content-start gap-4" data-testid="clean-workspace" aria-label={`${o.workspace}: ${o.objectives.length} objectives`}>
      <div className="grid min-w-0 gap-1">
        <h1 className="text-xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-3xl">{o.workspace}</h1>
        <p className="text-sm text-muted-foreground" data-testid="clean-workspace-answer">
          {none ? "A new workspace, with no objective yet. Add the first one, or tell the chat what this workspace is for." : `${o.objectives.length} objective${o.objectives.length === 1 ? "" : "s"} in this workspace.`}
        </p>
      </div>
      {!none && (
        <ul className="grid min-w-0 divide-y rounded-md border" data-testid="clean-workspace-objectives">
          {o.objectives.map((x) => (
            <li key={x.milestoneId}>
              <a href={`/milestones/${encodeURIComponent(x.milestoneId)}`} className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/60">
                <span className="min-w-0 flex-1 truncate text-foreground">{x.title}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{x.total ? `${x.green} of ${x.total} green` : "no results yet"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button size="sm" onClick={() => setAdding(true)} data-testid="clean-workspace-add">
          {none ? "Add the first objective" : "Add an objective"}
        </Button>
      </div>
      {adding && <MilestoneDialog open={adding} onOpenChange={setAdding} />}
    </section>
  );
}

const KR_VALUE = { green: "Done", amber: "Not yet", red: "Waiting" } as const;

/** the workspace's one first objective as the owner's objectives are drawn: its wheel, its name, its answer, its key results. */
export function GetSetUp({ objective: o }: { objective: FirstObjective }) {
  const krs: ScorecardRow[] = o.keyResults.map((k) => ({ label: k.name, state: k.state, kind: "key-result", value: KR_VALUE[k.state], target: k.target, note: k.note, measuredAt: o.measuredAt }));
  // the optional step (Connect MCP for WhatsApp) never holds "you are set up" back, and is never the next step while another is open
  const must = o.keyResults.filter((k) => !k.optional);
  const next = must.find((k) => k.state === "amber") ?? must.find((k) => k.state !== "green");
  const todo = o.keyResults.find((k) => k.state !== "green" && k.action);
  return (
    <section className="grid min-w-0 content-start gap-3" data-testid="get-set-up" aria-label={`${o.name}: ${o.green} of ${o.total} key results green`}>
      <GoalHeader rows={krs} title={o.name} answer={next ? `${o.green} of ${o.total} key results are green. Next: ${next.name}.` : o.green === o.total ? `All ${o.total} key results are green: you are set up.` : "You are set up. One optional step is left."} />
      <KeyResultSheet krs={krs} setId={o.milestoneId} plain />
      {todo?.action && next && todo.id !== o.keyResults[0]?.id && (
        <div>
          <Button asChild size="sm" variant="outline" data-testid="get-set-up-action">
            <a href={todo.action.href}>{todo.action.label}</a>
          </Button>
        </div>
      )}
      {o.later && (
        <p className="text-xs text-muted-foreground" data-testid="get-set-up-later">
          {o.later}
        </p>
      )}
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
