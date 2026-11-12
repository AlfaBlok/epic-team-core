import type { ChatStatus, ChatView, MessagesView, SocialChat, SocialMessage } from "@/api/types";
import { socialWorld } from "@/lib/identity";

/** The mock client's chats: a social world repo's shape, a reply waiting, one left by rule, a hidden request, one waiting, one done. */
export function sampleMessages(tenantId: string): MessagesView {
  const chat = (v: Partial<SocialChat>): SocialChat => ({ _line: 1, id: null, platform: "Reddit", account: "u/jordimr", who: null, kind: "dm", link: "https://www.reddit.com/chat", started: null, state: "open", reason: null, feedback: null, messages: [], ...v });
  const msg = (v: Partial<SocialMessage>): SocialMessage => ({ _line: 1, id: null, chat: null, at: null, from: "them", persona: null, text: null, answers: null, checks: null, feedback: null, result: null, status: "received", ...v });
  const view = (c: SocialChat, messages: SocialMessage[], status: ChatStatus): ChatView => {
    const ours = messages.filter((m) => m.from === "us");
    return {
      repo: socialWorld(),
      chat: { ...c, messages: messages.map((m) => m.id!) },
      messages,
      status,
      group: status === "done" ? "done" : status === "waiting" || status === "sending" ? "them" : "you",
      theirs: messages.filter((m) => m.from === "them").at(-1) ?? null,
      draft: ours.filter((m) => m.status === "draft" || m.status === "scheduled").at(-1) ?? null,
      lastOurs: ours.filter((m) => m.status === "posted").at(-1) ?? null,
      at: messages.at(-1)?.at ?? c.started ?? "",
    };
  };
  const chats: ChatView[] = [
    view(chat({ id: "C-0001", who: "u/WillowEmberly", started: "2026-09-08", state: "open" }), [
      msg({ id: "M-0007", chat: "C-0001", at: "2026-10-31 23:47", text: "summary: thousands of notes to move and organize" }),
      msg({ id: "M-0008", chat: "C-0001", at: "2026-11-01 01:04", from: "us", persona: "Responder", text: "Thousands of notes to organize is the case I built it for. Which notes app are they in, and can it export them?", answers: "M-0007", checks: "about Memo, they wrote last", status: "draft" }),
    ], "reply"),
    view(chat({ id: "C-0005", who: "u/dottedmag", started: "2026-09-22", state: "left", reason: "Tax and money (VAT on Telegram Stars): not about Memo." }), [msg({ id: "M-0012", chat: "C-0005", at: "2026-09-22", text: "summary: asked about VAT on Telegram Stars" })], "left"),
    view(chat({ id: "C-0004", who: "u/Ok-Car6047", kind: "chat request", state: "hidden", reason: "Reddit hides the request until it is accepted, and accepting shows them we saw it." }), [], "hidden"),
    view(chat({ id: "C-0002", who: "u/documentordie", kind: "chat request", started: "2026-09-11", state: "waiting" }), [
      msg({ id: "M-0009", chat: "C-0002", at: "2026-09-11", text: "👋" }),
      msg({ id: "M-0010", chat: "C-0002", at: "2026-11-02 18:26", from: "us", persona: "Responder", text: "Hey, thanks for the wave, and sorry it took me this long to get back to you.", answers: "M-0009", result: "sent 2026-11-02 18:26 UTC", status: "posted" }),
    ], "waiting"),
    view(chat({ id: "C-0009", who: "u/WorldsBetsDude", state: "done", reason: "Our message is the last one: nothing to answer." }), [], "done"),
  ];
  const counts = { you: 0, them: 0, done: 0, waiting: 0 };
  for (const c of chats) counts[c.group] += 1;
  counts.waiting = chats.filter((c) => c.status === "reply" || c.status === "left" || c.status === "hidden").length;
  return { tenantId, repos: [{ repo: socialWorld(), warnings: [] }], chats, counts };
}
