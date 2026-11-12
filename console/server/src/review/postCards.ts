import type { PushResult } from "../gitPush.js";

/**
 * The held-post cards' contract with the review screen: core lists a post card beside the rows and routes its
 * buttons to the post review, which the hosted social layer makes (review/posts.ts createPostReview). The card id moved
 * here unchanged; the shapes are the ones review/posts.ts returns.
 */
export const POST_CARD = "post~";
export const postCardId = (repo: string, postId: string) => `${POST_CARD}${repo}~${postId}`;
/** `post~<repo>~<id>`; the repo may be empty (`post~~P-0001`: the world's social repo that has that post). */
export function parsePostCardId(id: string): { repo: string; postId: string } | undefined {
  if (!id.startsWith(POST_CARD)) return undefined;
  const rest = id.slice(POST_CARD.length);
  const at = rest.lastIndexOf("~");
  if (at < 0 || at === rest.length - 1) return undefined;
  return { repo: rest.slice(0, at), postId: rest.slice(at + 1) };
}

/** What a post card shows (review/posts.ts fills it). */
export interface PostCardInfo {
  tenantId: string;
  repo: string;
  id: string;
  kind?: string;
  platform?: string;
  community?: string;
  slot?: string;
  title?: string;
  text?: string;
  images: { id: string; url: string }[];
  revisedFor?: string;
  project: { name: string; url?: string };
}

/** A post card as the review API lists it. */
export interface PostCard {
  id: string;
  kind: "post";
  title: string;
  liveUrl: string;
  summary?: string;
  ref: string;
  repo: string;
  path: string;
  milestoneId: string;
  status: string;
  state: "review" | "approved" | "relaunched" | "denied";
  createdAt: string;
  links: { url: string; title: string }[];
  closes: { row: string; epic: string; openRows: string[]; openAsks: string[] };
  verdict: { kind: "card" };
  post: PostCardInfo;
  sha?: string;
}

/** The social write a post button made (commit, push, the rows written). */
export interface PostWriteResult {
  action: string;
  id: string;
  commit: string | null;
  push: PushResult;
  files: string[];
}

export type PostActionResult = { item: PostCard; write: PostWriteResult } | { error: 404 | 409 | 422 | 502 | 503; code: string; message: string; issues?: string[]; item?: PostCard };

/** The post review (review/posts.ts createPostReview) as the review screen calls it. */
export interface PostReview {
  list(): Promise<PostCard[]>;
  get(id: string): Promise<PostCard | undefined>;
  schedule(id: string, b: { feedback?: string; slot?: string; now?: boolean; release?: boolean }): Promise<PostActionResult>;
  relaunch(id: string, feedback: string): Promise<PostActionResult>;
  deny(id: string): Promise<PostActionResult>;
}
