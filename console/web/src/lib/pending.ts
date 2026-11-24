import type { PendingItem, PendingKind } from "@/api";
import { aboutFrom } from "@/lib/about";
import { askLead, plainMarkdown, type LeadKind } from "@/lib/askLead";

/**
 * the Pending selector is the one inbox. Every count of "waiting on you" (Team badge, the selector, a
 * milestone's tab, its Waiting on you box) is the number of open items of the server's status (GET /api/status,
 * /api/milestones/:id/status): nothing counts from its own list.
 */

/** Open items for the owner, within a tree node's subtree when `nodeKey` is given (same rule as the server's node filter). */
export function openItems(items: PendingItem[] | undefined, nodeKey?: string): PendingItem[] {
  return (items ?? []).filter((i) => i.state === "open" && (!nodeKey || i.nodeKey === nodeKey || !!i.nodeKey?.startsWith(nodeKey + "/")));
}

export type PendingGroupKey = "alerts" | "needs_you" | "ready_to_mark" | "stalled" | "runs";
export const PENDING_GROUPS: { key: PendingGroupKey; label: string; kinds: PendingKind[] }[] = [
  { key: "alerts", label: "Monitor alerts", kinds: ["monitor_alert"] },
  { key: "needs_you", label: "Needs you", kinds: ["ask", "needs_jordi", "free_text_ask", "mark_ready"] },
  { key: "ready_to_mark", label: "Ready to mark", kinds: ["ready_to_mark"] },
  { key: "stalled", label: "Stalled", kinds: ["stalled"] },
  { key: "runs", label: "Failed or unreported runs", kinds: ["failed_run"] },
];

/** The selector's groups, in order, empty ones left out. Answers already given (kind answered) are not listed. */
export function groupPending(items: PendingItem[] | undefined): { key: PendingGroupKey; label: string; items: PendingItem[] }[] {
  const list = (items ?? []).filter((i) => i.kind !== "answered");
  return PENDING_GROUPS.map((g) => ({ key: g.key, label: g.label, items: list.filter((i) => g.kinds.includes(i.kind)) })).filter((g) => g.items.length > 0);
}

/** The one action an item offers: where it goes (in the console), or the rewrite request for a free-text ask. */
export type PendingAction = { label: string; to: string } | { label: string; rewrite: { milestoneId: string; path: string } };
export function pendingAction(i: PendingItem): PendingAction {
  const ms = `/milestones/${encodeURIComponent(i.milestoneId)}`;
  switch (i.kind) {
    case "free_text_ask":
      return i.path ? { label: "Rewrite as a coded ask", rewrite: { milestoneId: i.milestoneId, path: i.path } } : { label: "Answer", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
    case "ready_to_mark":
      return { label: "Open the goal", to: `${ms}?tab=summary` };
    case "mark_ready":
      return { label: "Mark ready", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
    case "stalled":
      return { label: "Switch on", to: `${ms}?tab=personas` };
    case "failed_run":
      return { label: "Open run", to: `${ms}?tab=activity` };
    case "monitor_alert":
      return { label: "Open alert", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
    default:
      return { label: "Answer", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
  }
}

/**
 * E948-S198 (the owner 24 Nov 14:12Z, vn_c408c78f, his phone screenshot of the E907-S32 card: "it's usually a question ...
 * there is no question, you really need to see the question mark"): a status row in Blocked on you (an ask whose full
 * card is not in the list, a held ask, a stalled team) leads with ONE plain question ending in "?", built from the ask's
 * own words, never the row's internal line (`E907-S32 Acme testers can … Core: changes app: His voice note …`).
 */
export function statusQuestion(item: Pick<PendingItem, "kind" | "title" | "ask" | "question">): { question: string; why?: string } {
  if ((item.kind === "ask" || item.kind === "needs_jordi") && item.question?.trim()) {
    const lead = askLead({ ask: item.ask ?? "unknown", question: item.question });
    return { question: asQuestion(lead.kind, plainMarkdown(lead.what)), ...(lead.why ? { why: plainMarkdown(lead.why) } : {}) };
  }
  const title = plainMarkdown(item.title ?? "").trim();
  // a status line that already asks in plain words ("3 open items to work, nobody on. Switch on Delivery Manager?",
  // "Is <goal> finished?") keeps its own words; one carrying a row code is a ticket line, never shown as the question
  if (title.endsWith("?") && !/\b[A-Z][A-Z0-9]{0,5}-[A-Z]{0,2}\d/.test(title)) return { question: title };
  const about = aboutFrom(item.title) ?? "this";
  const thing = lcFirst(about);
  switch (item.kind) {
    case "mark_ready":
      return { question: `Is ${thing} ready for the team to start?` };
    case "failed_run":
      return { question: `Should the team run ${thing} again?` };
    case "stalled":
      return { question: `Should a team member work on ${thing}?` };
    default:
      return { question: `What should the team do about ${thing}?` };
  }
}

/** words a sentence may start with that read lower-case inside a question ("Do you approve one private repo?"). */
const DETERMINER = /^(?:a|an|the|one|two|three|our|your|its|this|that|these|those|each|every|some|any|no|all|more|less|new|both)\b/i;
/** a name ("Acme", "Northwind") keeps its capital; only a common opening word is lowered. */
const lcFirst = (s: string) => (DETERMINER.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** the lead's one thing as a question by its kind; a sentence that already asks keeps its own question mark. */
function asQuestion(kind: LeadKind, what: string): string {
  const w = what.replace(/[\s.:;,!]+$/, "").trim();
  if (!w) return "What do you answer here?";
  if (w.endsWith("?")) return w[0]!.toUpperCase() + w.slice(1);
  const plain = DETERMINER.test(w);
  const it = lcFirst(w);
  switch (kind) {
    case "approve":
      return plain ? `Do you approve ${it}?` : `Do you approve this: ${it}?`;
    case "decide":
      return /^(?:how|what|which|where|when|who|why|whether)\b/i.test(w) ? `${w[0]!.toUpperCase()}${w.slice(1)}?` : `What do you decide on ${it}?`;
    case "give":
      return `Can you give us ${it}?`;
    case "do":
      return `Will you do this: ${it}?`;
    case "check":
      return `Does this look right: ${it}?`;
    default:
      return /^(?:how|what|which|where|when|who|why|whether|is|are|do|does|did|can|could|should|will|would)\b/i.test(w) ? `${w[0]!.toUpperCase()}${w.slice(1)}?` : `What is your answer on ${it}?`;
  }
}

/**
 * E948-S198: a review card leads with the one question it asks him, its decision's first sentence up to the question mark
 * ("Is this the import you meant for testers?"); the team's pick stays by the buttons. A card whose decision asks
 * nothing (the review gate holds those, review/card.ts decisionAskProblem) still leads with a question built from
 * its own title, never a row line.
 */
export function reviewQuestion(face: { decision?: string; title: string }): string {
  const d = plainMarkdown(face.decision ?? "").replace(/\s+/g, " ").trim();
  const q = /^[^?]*?\?/.exec(d)?.[0]?.trim();
  if (q && q.length > 3) return q;
  const t = plainMarkdown(face.title).replace(/\s+/g, " ").trim().replace(/[\s.!:;,]+$/, "");
  return t ? `Is this what you asked for: ${lcFirst(t)}?` : "Is this what you asked for?";
}
