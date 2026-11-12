import type { C6StyleRule, DigestPost, SocialDigestView, SocialPost } from "@/api/types";
import { sampleSocialExport } from "@/lib/social";
import { socialWorld } from "@/lib/identity";

/**
 * the 20:00 digest (server social/digest.ts builds it from the pack export) and the C6 Style rule line shape
 * `<text> [C6 S1: feedback F1, F3 on P-0138, P-0143]` (server social/styleRules.ts), for the Digest page and any screen
 * that lists Style rules with an Undo.
 */

const C6_LINE = /\[C6 (S\d+):\s*([^\]]*)\]\s*$/;

/** A Style rules line → its C6 rule (undefined for any other rule). */
export function parseC6(line: string): C6StyleRule | undefined {
  const m = C6_LINE.exec(line);
  if (!m) return undefined;
  const body = line.replace(/^\s*[-*]\s+/, "");
  return { id: m[1], text: body.slice(0, body.lastIndexOf("[C6")).trim(), feedback: m[2].match(/\bF\d+\b/g) ?? [], posts: m[2].match(/\bP-\d+\b/g) ?? [] };
}

/** The write action that undoes a C6 rule. */
export const undoAction = (id: string) => ({ action: `style-rules/${id}/undo` as const });

const digestPost = (p: SocialPost): DigestPost => ({
  id: p.id ?? "",
  kind: p.kind,
  platform: p.platform,
  community: p.community,
  title: p.title ?? p.text,
  link: p.link,
  replies: p.replies,
  metrics: p.metrics,
  result: p.result,
  feedback: p.feedback,
  status: p.status,
});

/** The mock's digest: the sample export's live posts as "went out", its held posts; nothing sent. */
export function sampleDigest(tenantId: string, date = new Date().toISOString().slice(0, 10)): SocialDigestView {
  const exp = sampleSocialExport();
  const live = exp.posts.filter((p) => (p.status === "posted" || p.status === "measured") && p.link);
  const posts = live.filter((p) => (p.kind ?? "post") === "post").map(digestPost);
  const replies = live.filter((p) => p.kind === "reply" || p.kind === "outreach").map(digestPost);
  const held = exp.posts.filter((p) => p.status === "held").map(digestPost);
  const styleRules = [{ id: "S1", text: "shorter on X", feedback: ["F1", "F2"], posts: posts.slice(0, 2).map((p) => p.id), new: true }];
  return {
    tenantId,
    repo: socialWorld(),
    page: `/digest?date=${date}`,
    reportUrl: null,
    sent: null,
    warnings: [],
    digest: {
      date,
      counts: { posts: posts.length, replies: replies.filter((p) => p.kind === "reply").length, outreach: replies.filter((p) => p.kind === "outreach").length, held: held.length, pulled: 0, feedback: 0, ideas: 0, styleRules: styleRules.length },
      posts,
      replies,
      held,
      pulled: [],
      ideas: [],
      feedback: [],
      styleRules,
      report: null,
    },
  };
}
