import { Link } from "react-router-dom";
import { api } from "@/api";
import type { SocialThread } from "@/api/types";
import type { CampaignCard } from "@/api/campaign-types";
import { postImages, postsOf, type Post } from "@/lib/social";
import { worldId } from "@/lib/useSocial";
import { repoCards } from "@/lib/campaign";
import { socialHref } from "@/pages/social/nav";
import { MESSAGES_PATH, useMessages } from "@/lib/messages";
import { useProject } from "@/lib/project";

/** The chats that need the owner (server social/messages.ts needsOwner): the count `counts.waiting` gives for the whole world. */
const NEEDS_YOU = new Set(["reply", "left", "hidden"]);

/**
 * "Drafts to approve", its own list in the owner's inbox (Team page), next to "Waiting on you" (asks) and E48's
 * "Done, waiting for your review": every held post of the world's campaigns (repos with the social pack). Post it,
 * Change it (the Writer makes a new version and it comes back here), Don't post (with Undo), through the same write API as
 * the Pipeline. Renders nothing when no campaign holds a post.
 * one line per draft (campaign · platform · slot, the post's first line)
 * in a fixed-height pane with Show 20 / 50 / all, folded like every inbox list. Each row names its campaign, so the count
 * here and each campaign's Pipeline agree (the mockup's "6 drafts vs Pipeline 0"). The title
 * and Open go to the post's own page (full text, diagram, history, every button of its card); the row's buttons still
 * act in place.
 */
export interface DraftItem {
  repo: string;
  campaign: string;
  /** the campaign's milestone (its page opens on the Pipeline); null = no milestone tracks the repo yet. */
  milestoneId: string | null;
  post: Post;
  /** the post's diagram(s), served by /social/file. */
  images: { id: string; url: string }[];
  /** a held reply in someone else's thread: its row in data/threads.md (Reply = this post), when the export has it. */
  thread?: SocialThread;
}

/** a reply in someone else's thread (Kind outreach), held by hold rule R4 for the owner's Approve. */
export const isThreadReply = (p: Pick<Post, "kind">) => (p.kind ?? "").toLowerCase() === "outreach";
/** The thread a reply answers, from data/threads.md (its Reply cell names the post). */
export const threadOf = (threads: SocialThread[] | undefined, id: string) => (threads ?? []).find((t) => (t.reply ?? "").split(/[\s,;]+/).includes(id));

export async function loadDrafts(): Promise<{ tenantId: string; items: DraftItem[] }> {
  const tenantId = await worldId();
  const { campaigns } = await api.listCampaigns(tenantId);
  const items: DraftItem[] = [];
  // one read per repo; a draft tagged with a named campaign's code goes under that campaign, the rest under the
  // repo's card. A retired campaign's held drafts stay held and leave this list (it is paused).
  for (const c of repoCards(campaigns).filter((x) => x.held > 0)) {
    const s = await api.getSocial(tenantId, c.repo).catch(() => undefined);
    for (const post of postsOf(s?.data)) {
      if (post.status !== "held") continue;
      const home = homeCard(campaigns, c.repo, post) ?? c;
      if (home.retired) continue;
      const thread = isThreadReply(post) ? threadOf(s?.data.threads, post.id) : undefined;
      items.push({ repo: c.repo, campaign: home.title, milestoneId: home.milestoneId, post, images: postImages(s, post), ...(thread ? { thread } : {}) });
    }
  }
  return { tenantId, items };
}

/** the campaign a post counts toward: the named one its Campaign cell names (code or name), else its repo's card. */
export function homeCard(campaigns: CampaignCard[], repo: string, post: Pick<Post, "campaign">): CampaignCard | undefined {
  const tag = (post.campaign ?? "").trim().toLowerCase();
  const own = tag ? campaigns.find((n) => n.campaign && n.repo === repo && [n.campaign.code, n.campaign.name].some((k) => k.toLowerCase() === tag)) : undefined;
  return own ?? campaigns.find((n) => !n.campaign && n.repo === repo);
}

/** The campaign's page (it opens on Pipeline), else the repo's Pipeline screen (the post page's Back when it came from nowhere). */
export const draftHref = (i: Pick<DraftItem, "milestoneId" | "repo">) => (i.milestoneId ? `/milestones/${encodeURIComponent(i.milestoneId)}` : socialHref("pipeline", i.repo));

/** The campaign's name as the mockup prints it: no "<repo> · " prefix, no "EPIC-<n>: " code (the card title keeps both). */
export const campaignName = (t: string) => t.replace(/^[^·]*·\s*(?=EPIC-\d+:)/, "").replace(/^EPIC-\d+:\s*/, "");

/**
 * DMs are not drafts. While chats wait for the owner (a reply to
 * Send, a chat left by rule, a hidden request) one line under Drafts to approve points at Messages, so nothing leaves his
 * inbox unseen; the menu's Messages entry carries the same count.
 */
export function ChatsWaitingLine({ className }: { className?: string }) {
  const { data } = useMessages();
  // inside Epic Social the line counts the selected project's chats only (each chat names its repo).
  const project = useProject().current;
  const mine = (repo: string) => repo === project?.repo || repo.replace(/\/+$/, "").split("/").pop() === project?.repo;
  const n = project ? (data?.chats ?? []).filter((c) => mine(c.repo) && NEEDS_YOU.has(c.status)).length : (data?.counts.waiting ?? 0);
  if (!n) return null;
  return (
    <p className={className ?? "mt-2 text-sm"} data-testid="chats-waiting">
      {n} chat{n === 1 ? " waits" : "s wait"} for you on{" "}
      <Link to={`/${MESSAGES_PATH}`} className="font-medium underline">
        Messages
      </Link>
    </p>
  );
}

// the Drafts to approve list is gone: a held post is a card in "Done, waiting for your review" (components/review.tsx
// PostReviewCard), reached through the one review API. The helpers above stay for the Pipeline, the post page and the chats line.
