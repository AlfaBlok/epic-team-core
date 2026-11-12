import { quickStatusText, voiceInstructions, VOICE_TOOLS, type QuickMilestone, type QuickStatus } from "./voice.js";
import { ownerName, ownerPattern } from "../identity.js";

/**
 * The Call on one of the owner's own milestones and the quick status a milestone or campaign Call reads, moved
 * unchanged from voice/campaign.ts: every console has milestone Calls; the campaign and world-desk Calls are the
 * social skin's.
 */
/**
 * the Call on one of the owner's own milestones (a Team home card, the Milestone page): the Team desk's voice re-aimed
 * at that milestone's desk. the owner's world, so it keeps his name and the word milestone; the brief adds the tree and its book.
 */
export function milestoneInstructions(milestone: string, base: string = voiceInstructions()): string {
  return [
    toMilestone(base, milestone),
    `This call is about one milestone, "${name(milestone)}": its own desk (the repo desk of that milestone) answers what you pass on. quick_status lists this milestone first, then the others.`,
  ].join("\n");
}

export function milestoneTools(milestone: string, tools: typeof VOICE_TOOLS = VOICE_TOOLS): typeof VOICE_TOOLS {
  return JSON.parse(toMilestone(JSON.stringify(tools), milestone));
}

function toMilestone(text: string, milestone: string): string {
  const n = name(milestone).replace(/"/g, "'");
  return text.replace(new RegExp(String.raw`${ownerPattern()}'s Team desk`, "g"), `the desk of ${ownerName()}'s milestone "${n}"`).replace(/the Team desk/g, "the milestone's desk");
}

export const callName = (campaign: string) => campaign.replace(/\s+/g, " ").trim().slice(0, 120) || "this campaign";
const name = callName;

/** One campaign status line set as the voice reads it: this campaign first, then the world's others; only this world's rows. */
export function campaignQuickStatus(
  o: {
  campaign: QuickMilestone;
  others: QuickMilestone[];
  waiting: { title: string; code?: string; milestone?: string }[];
  stuck: { title: string; milestone?: string; why?: string }[];
  working: { milestone: string; what?: string }[];
  },
  /** the owner's own milestone (the home world): "This milestone", his name kept. */
  as: "campaign" | "milestone" = "campaign",
): QuickStatus {
  let body = quickStatusText({ milestones: [{ ...o.campaign, bigRoot: 1 }, ...o.others.map(({ bigRoot: _b, ...m }) => m)], waiting: o.waiting, stuck: o.stuck, working: o.working })
    .replace(`Priorities (${ownerName()}'s focus milestones, in his order, 1 = top priority): 1.`, as === "milestone" ? "This milestone:" : "This campaign:")
    .replace(/^1\. /m, "");
  if (as === "milestone") body = body.replace(/Other milestones \(not in focus, after the focus milestones\)/, `Other milestones (in ${ownerName()}'s priority order, focus milestones first)`);
  else
    body = body
      .replace(/Other milestones \(not in focus, after the focus milestones\)/, "Other campaigns in this world")
      .replace(new RegExp(String.raw`Waiting on ${ownerPattern()}`, "g"), "Waiting on you")
      .replace(new RegExp(String.raw`waits on ${ownerPattern()}`, "g"), "waits on you");
  return { text: body, waiting: o.waiting.length, stuck: o.stuck.length, working: o.working.length, milestones: 1 + o.others.length };
}
