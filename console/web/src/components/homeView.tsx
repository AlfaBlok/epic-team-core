import { GoalSetsPage, useGoalSets } from "@/components/goalSets";
import { useShows, useSkin } from "@/lib/skin";
import { INBOX_PATH } from "@/components/inboxLine";
import { HomeBuyLine } from "@/components/buyPlan";
import { CampaignsHome, useCampaignHome } from "@/components/campaignHome";
import { lazyPage } from "@/lib/lazyPage";

// The Inbox page (and Home in a world with no goal sets) loads its script when shown.
const TeamPage = lazyPage(() => import("@/pages/Team"), "TeamPage");

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
      {campaigns ? <CampaignsHomeOr fallback={fallback} /> : shows("goalSets") ? <GoalsHome fallback={fallback} /> : fallback}
    </>
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
