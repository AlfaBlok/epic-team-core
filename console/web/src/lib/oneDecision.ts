/**
 * E948-S128 (the owner 2026-11-17 17:27Z, vn_dc4a25de, on the "Delivery Manager's 2 recommendations" card that joined an
 * application send and a chat bot opening under one "Yes to all two: make them tasks": "Why do we have two things on
 * the, are they related? If they're not related, why are they two things and you make, you make me approve them both
 * at the same time? ... I don't like this card."): unrelated decisions are separate cards, each with buttons that say
 * exactly what yes does. A card holds several asks only when they are one decision: written in the same spine and
 * holding up the same work (their `unblocks:` name a row or step in common).
 */
import type { WaitingItem } from "@/api";
import { FEEDBACK_OPTION } from "@/lib/cardKind";

/** the row and step codes an ask's `unblocks:` names (`E995-2`, `E946-S5`, `home_repo/E948-S1`), lower-cased. */
export function unblockCodes(i: Pick<WaitingItem, "unblocks">): Set<string> {
  const out = new Set<string>();
  for (const m of (i.unblocks ?? "").matchAll(/(?<![\w.-])(?:[\w.-]+\/)?([A-Za-z][A-Za-z0-9]*-[A-Za-z]{0,3}\d+)(?![\w-])/g)) out.add(m[1].toLowerCase());
  return out;
}

/** true when two asks are parts of one decision: one repo, one spine, and the same work waits on both. */
export function oneDecision(a: WaitingItem, b: WaitingItem): boolean {
  if (!a.path || a.path !== b.path || (a.repo ?? "") !== (b.repo ?? "") || (a.milestoneId ?? "") !== (b.milestoneId ?? "")) return false;
  const ua = unblockCodes(a);
  if (!ua.size) return false;
  for (const c of unblockCodes(b)) if (ua.has(c)) return true;
  return false;
}

/** `items` split into groups of one decision each (linked by `oneDecision`), in the order their first ask comes. */
export function decisionGroups(items: WaitingItem[]): WaitingItem[][] {
  const groups: WaitingItem[][] = [];
  for (const i of items) {
    const joined = groups.filter((g) => g.some((x) => oneDecision(x, i)));
    if (!joined.length) {
      groups.push([i]);
      continue;
    }
    // an ask that links two groups merges them into the first
    const [first, ...rest] = joined;
    first.push(i);
    for (const g of rest) {
      first.push(...g);
      groups.splice(groups.indexOf(g), 1);
    }
  }
  return groups.map((g) => items.filter((i) => g.includes(i)));
}

/**
 * The ask's own Yes and No words, when its `options:` say what each does (`Yes: we press Submit · No: say what to
 * change`, also written `Yes: open it ; No: keep it to me only`): the approve card's buttons show them, so yes says
 * exactly what happens. The answer sent stays approve or decline.
 */
export function ownYesNo(i: Pick<WaitingItem, "options">): { yes?: string; no?: string } {
  const opts = (i.options ?? []).flatMap((o) => o.split(/\s+;\s+/)).map((o) => o.trim().replace(/[.!]$/, ""));
  const yes = opts.find((o) => /^(?:yes|approve|ok)\b\s*[:,]\s*\S/i.test(o));
  // a No that only asks for his words ("No: say what to change") is the feedback box every card has, never the decline
  const no = opts.find((o) => /^(?:no|decline|not now)\b\s*[:,]\s*\S/i.test(o) && !FEEDBACK_OPTION.test(o));
  return { ...(yes ? { yes } : {}), ...(no ? { no } : {}) };
}
