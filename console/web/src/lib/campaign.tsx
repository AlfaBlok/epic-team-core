import { createContext, useContext, type ReactNode } from "react";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import { useSharedQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";

/**
 * a campaign is a milestone whose repo has the social pack. Its page shows the social
 * screens as tabs (Pipeline, Brief & directions, History), each fed that milestone's repo instead of a `?repo=` picker,
 * so the Pipeline of "Epic campaign" shows Epic campaign's drafts (the mockup found 6 drafts on the Team page and 0 on
 * the Pipeline, which only ever showed the world's first social repo).
 */
export interface CampaignScope {
  /** The checkout name the social routes take as `?repo=` (GET /api/tenants/:id/campaigns `repo`). */
  repo: string;
  card: CampaignCard;
  milestoneId: string;
  /** a named campaign's code (``): the social screens read only its rows (`?campaign=`); unset = the whole repo. */
  campaign?: string;
}

const CampaignContext = createContext<CampaignScope | undefined>(undefined);

/** Inside a campaign tab: the social screens read this repo and drop their page header (the milestone page has one). */
export function CampaignProvider({ scope, children }: { scope: CampaignScope; children: ReactNode }) {
  return <CampaignContext.Provider value={scope}>{children}</CampaignContext.Provider>;
}

/** The campaign tab the screen sits in, if any. */
export const useCampaignScope = () => useContext(CampaignContext);

/** The world's campaign cards (GET /api/tenants/:id/campaigns): one per repo with `Pack: social`, with its milestone. */
export function useCampaigns() {
  return useSharedQuery("sb:campaigns", async () => api.listCampaigns(await worldId()));
}

/** the cards the owner works with (retired ones hidden); repoCards: one per repo that has a live campaign (its repo card, retired or not), for repo-wide lists (job repo picker, drafts). */
export const liveCards = (cards: CampaignCard[] | undefined) => (cards ?? []).filter((c) => !c.retired);
export const repoCards = (cards: CampaignCard[] | undefined) => {
  const live = new Set(liveCards(cards).map((c) => c.repo));
  return (cards ?? []).filter((c) => !c.campaign && live.has(c.repo));
};

/** milestone id → its campaign card (milestones whose repo has the social pack). */
export function campaignsByMilestone(cards: CampaignCard[] | undefined): Map<string, CampaignCard> {
  return new Map((cards ?? []).filter((c) => c.milestoneId).map((c) => [c.milestoneId!, c]));
}

/**
 * the repo's own milestone (every row) of a
 * repo that runs a live named campaign. It is the team's level, not a campaign ("... it's meaningless to me"), so the
 * skin's sidebar and Team home leave it out; its Publisher and Delivery Manager keep working there for every campaign, its
 * open items stay in Team's list. Reversible by itself: with no live named campaign the repo card shows again.
 */
export function repoLevelIds(cards: CampaignCard[] | undefined): Set<string> {
  const named = new Set(liveCards(cards).filter((c) => c.campaign).map((c) => c.repo));
  return new Set((cards ?? []).flatMap((c) => (!c.campaign && c.milestoneId && named.has(c.repo) ? [c.milestoneId] : [])));
}

/** a repo's names a card or milestone may carry: the checkout name, `owner/name`, a path's last part; lower case. */
const repoNames = (...names: (string | null | undefined)[]) =>
  names.flatMap((n) => {
    const s = (n ?? "").trim().replace(/\/+$/, "").toLowerCase();
    return s ? [s, s.split("/").pop()!] : [];
  });

/**
 * the milestones the social skin shows as campaigns (Home and the menu). The definition is the
 * campaign list itself (GET /api/tenants/:id/campaigns: a repo with the social pack, a name, one goal): a
 * live campaign's milestone, or a job in a repo that runs a live campaign (Add job makes it there). Every other
 * milestone of the world (a house decision, a server, taxes) belongs to the EpicTeam side and is left out, as are retired
 * campaigns and a repo's own level (repoLevelIds). The owner, on opening the old list: "it felt like a little bit of a mess".
 */
export function campaignMilestones<M extends { id: string; repo?: string | null; remote?: string | null }>(cards: CampaignCard[] | undefined, ms: M[] | undefined): M[] {
  const live = liveCards(cards);
  const liveIds = new Set(live.flatMap((c) => (c.milestoneId ? [c.milestoneId] : [])));
  const retired = new Set((cards ?? []).flatMap((c) => (c.retired && c.milestoneId && !liveIds.has(c.milestoneId) ? [c.milestoneId] : [])));
  const level = repoLevelIds(cards);
  const repos = new Set(live.flatMap((c) => repoNames(c.repo, c.remote)));
  return (ms ?? []).filter((m) => !level.has(m.id) && !retired.has(m.id) && (liveIds.has(m.id) || repoNames(m.remote, m.repo).some((n) => repos.has(n))));
}
