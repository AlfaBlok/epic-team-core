import { plain } from "../book/milestone.js";
import type { BookEpic } from "../book/build.js";
import { ownerName } from "../identity.js";

/**
 * every voice session starts briefed, so "what is this about" and "what are the top
 * milestones" are answered on the call without asking the desk. Two parts, both cut short (they ride on every turn's input):
 * the root tree (the top-level milestones: code, one-line goal, status, priority order) and the Epic Book summary at the
 * call's level (the desk: the root book; a milestone: its own page: Goal, Done means, Phase, Waiting on, Next action).
 */

/** The heading line of the briefing: what it is for (the voice answers from it, never asking the desk for it). */
export const briefHead = (noun = "milestones") =>
  `Briefing (as of the call's start). Questions about what this is about, what the top ${noun} are, their goals, phase or next step: answer from this briefing at once, briefly, with no tool call (no quick_status, no ask_the_desk), and name the top ${noun} in the order given here. For anything newer or not here, use your tools:`;
/** Focus milestones get a full line each; other milestones only a name, at most this many. */
export const TREE_OTHERS_MAX = 8;
/** Open Done means listed in a book brief (the rest are counted). */
export const OPEN_GOALS_MAX = 4;

export interface TreeEntry {
  /** M6; empty when the milestone has no spine code (a campaign). */
  code?: string;
  title: string;
  goal?: string | null;
  /** The spine's Status (active, blocked, review…) or the console's state word. */
  status?: string | null;
  /** 1-based focus position (big root); absent = not in focus. */
  rank?: number;
}

const one = (s: string) => s.replace(/\s+/g, " ").trim();
/** Only a real spine code (M6) is said; a file-name fallback ("root", "epic-x") is not. */
const label = (e: TreeEntry) => one(`${e.code && /^(EPIC-\d+|M\d+)$/i.test(e.code) ? `${e.code} ` : ""}${e.title.replace(/^\s*(EPIC-\d+|M\d+)\s*[:—–-]\s*/i, "")}`);

/** The root tree: focus milestones in priority order with a one-line goal and status, then the others by name. */
export function treeBrief(entries: TreeEntry[], o: { who?: string; noun?: string } = {}): string {
  const who = o.who ?? `${ownerName()}'s`;
  const noun = o.noun ?? "milestones";
  const focus = entries.filter((e) => e.rank != null).sort((a, b) => a.rank! - b.rank!);
  const rest = entries.filter((e) => e.rank == null);
  if (!focus.length && !rest.length) return "";
  const lines: string[] = [];
  const full = (e: TreeEntry) => {
    const goal = plain(e.goal ?? null, 110);
    return `${label(e)}${e.status ? ` (${one(e.status).toLowerCase()})` : ""}${goal ? `: ${goal}` : ""}`;
  };
  if (focus.length) {
    lines.push(`Root tree: ${who} top-level ${noun}, in priority order (1 = top):`);
    focus.forEach((e, i) => lines.push(`${i + 1}. ${full(e)}`));
    if (rest.length)
      lines.push(`Other ${noun}: ${rest.slice(0, TREE_OTHERS_MAX).map(label).join("; ")}${rest.length > TREE_OTHERS_MAX ? `; and ${rest.length - TREE_OTHERS_MAX} more` : ""}.`);
  } else {
    lines.push(`Root tree: ${who} ${noun} (no priority set):`);
    for (const e of rest.slice(0, TREE_OTHERS_MAX)) lines.push(`- ${full(e)}`);
    if (rest.length > TREE_OTHERS_MAX) lines.push(`- and ${rest.length - TREE_OTHERS_MAX} more`);
  }
  return lines.join("\n");
}

/** One Epic Book page as the voice reads it: Goal's first paragraph, Done means (met / open), Phase, Waiting on, Next action. */
export function bookBrief(e: Pick<BookEpic, "code" | "title" | "goal" | "doneMeans" | "phase" | "waitingOn" | "next" | "dod">, o: { title?: string; level?: string } = {}): string {
  const lines = [`Epic Book, ${o.level ?? "this milestone"}: ${label({ code: e.code, title: o.title || e.title })}`];
  const goal = plain(e.goal, 300);
  if (goal) lines.push(`Goal: ${goal}`);
  const dm = e.doneMeans ?? [];
  if (dm.length) {
    const open = dm.filter((d) => !d.done);
    const listed = open.slice(0, OPEN_GOALS_MAX).map((d) => `${d.id} ${plain(d.text, 90) ?? ""}`.trim());
    lines.push(`Done means: ${dm.length - open.length} of ${dm.length} met.${listed.length ? ` Open: ${listed.join("; ")}${open.length > listed.length ? `; and ${open.length - listed.length} more` : ""}.` : ""}`);
  } else if (e.dod?.total) lines.push(`Done means: ${e.dod.done} of ${e.dod.total} met.`);
  const phase = plain(e.phase, 200);
  if (phase) lines.push(`Phase: ${phase}`);
  const waiting = plain(e.waitingOn, 160);
  if (waiting) lines.push(`Waiting on: ${waiting}`);
  const next = plain(e.next, 200);
  if (next) lines.push(`Next action: ${next}`);
  return lines.join("\n");
}

/** The whole briefing, appended to the session's instructions; empty when there is nothing to say. */
export function briefing(parts: (string | null | undefined)[], noun?: string): string {
  const body = parts.filter((p): p is string => !!p && !!p.trim());
  return body.length ? [briefHead(noun), ...body].join("\n") : "";
}

/** Rough token count of a text (OpenAI's tokenizers average about 4 characters per token in English). */
export const tokensOf = (text: string) => Math.ceil(text.length / 4);
