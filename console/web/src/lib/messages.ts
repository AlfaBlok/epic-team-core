import { api } from "@/api";
import type { ChatStatus, MessagesView, SocialChat, SocialMessage } from "@/api/types";
import { useSharedQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";

/**
 * DMs are not posts. The Messages page and the conversation page read
 * GET /api/tenants/:id/social/messages (every chat of the world's social repos, grouped by the server: waiting for you,
 * waiting for them, done) and write through the one social write API (`messages/<id>/send` …, `chats/<id>/done` …).
 */

export async function loadMessages(): Promise<MessagesView> {
  return api.getMessages(await worldId());
}

/** The world's chats; `tag: "inbox"` so the menu pill and Team home refresh with the other inbox reads. */
export function useMessages() {
  return useSharedQuery("sb:messages", loadMessages, { tag: "inbox" });
}

/** The conversation page's address: chat ids repeat across repos. */
export const MESSAGES_PATH = "messages";
export const CHAT_PATH = "messages/:repo/:id";
export const chatHref = (repo: string, id: string) => `/messages/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`;

/** What the row's status line says, in the owner's words (the mockup's badges). */
export const STATUS_LABEL: Record<ChatStatus, string> = {
  reply: "reply waiting for you",
  drafting: "draft on the way",
  left: "left by rule",
  hidden: "can't read yet",
  sending: "sending",
  waiting: "no answer yet",
  done: "done",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "31 Oct 23:50", "22 Sep", "6 Aug 2025" (another year), "" for none. UTC, the same in every locale. */
export function whenLabel(at: string | null | undefined, now: Date = new Date()): string {
  const v = (at ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v);
  if (!m) return v;
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  if (Number(m[1]) !== now.getUTCFullYear()) return `${day} ${m[1]}`;
  return m[4] ? `${day} ${m[4]}` : day;
}

/** "Reddit DM", "Reddit chat request". */
export const chatKind = (c: Pick<SocialChat, "platform" | "kind">) => [c.platform, c.kind === "dm" ? "DM" : c.kind].filter(Boolean).join(" ");

/** Their message as one line: a summary drops its `summary:` mark (the page marks it). */
export const theirLine = (m: Pick<SocialMessage, "text"> | null | undefined) => (m?.text ?? "").replace(/^summary:\s*/i, "");
export const isSummary = (m: Pick<SocialMessage, "text"> | null | undefined) => /^summary:/i.test(m?.text ?? "");

/** the owner's newest note of a kind (`Draft requested 2026-11-02 21:14 UTC` → "21:14"). */
export const noteTime = (feedback: string | null | undefined, word: string) => {
  const all = [...(feedback ?? "").matchAll(new RegExp(`${word} (\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}) UTC`, "gi"))];
  const last = all.at(-1);
  return last ? `${last[1]} ${last[2]}` : undefined;
};

/** the owner's newest Change it note on a draft, while the Responder has not answered it with a new version. */
export const lastReviseAsk = (m: Pick<SocialMessage, "feedback"> | null | undefined) => /Revise requested [^:]+:\s*([^;]*)$/.exec(m?.feedback ?? "")?.[1]?.trim();

// The sample chats (the mock client's) live apart: the mock client imports them, and this file imports the client.
export { sampleMessages } from "./messagesSample";
