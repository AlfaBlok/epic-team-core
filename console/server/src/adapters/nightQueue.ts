import { ownerName } from "../identity.js";
import type { Tree, TreeNode } from "./tree.js";

/**
 * The night queue. A measure of 14 Nov 2026 found that from 3 to 8 am Mexico City only 2 agents work at once (8 to 10 by
 * day) and 42% of night wakes find nothing new: at night ready work runs out, not machines. The queue lives in the
 * spine, never in the console (root L-45): the Delivery Manager adds `[night]` to the Next action cell of each ready
 * row that needs no yes from the owner, in its evening wake, and the night wakes start those rows first. Not a second
 * priority list (his pursuits stay the one order): a mark on rows that are already ready. Only the owner readies a
 * draft (root L-37), so the queue never grows a row past what he readied.
 */
export const NIGHT_TAG = "[night]";
export const NIGHT_ZONE = "America/Mexico_City";
/** local hours: the evening wakes mark the queue, the night wakes drain it. */
export const EVENING_FROM = 19;
export const NIGHT_FROM = 22;
export const NIGHT_TO = 8;

export type NightPhase = "evening" | "night" | "day";

export function localHour(now: number, zone = NIGHT_ZONE): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date(now));
  return Number(h) % 24;
}

export function nightPhase(now = Date.now(), zone = NIGHT_ZONE): NightPhase {
  const h = localHour(now, zone);
  if (h >= NIGHT_FROM || h < NIGHT_TO) return "night";
  return h >= EVENING_FROM ? "evening" : "day";
}

const TAG_RE = /\[night\]/i;
export const isNightMarked = (n: Pick<TreeNode, "nextAction">) => TAG_RE.test(n.nextAction ?? "");

/** the ready rows of the tree (nobody's claim is checked here: the claims section and the 409 `claimed` do that). */
export function readyRows(t: Tree): TreeNode[] {
  const out: TreeNode[] = [];
  const seen = new Set<string>();
  const visit = (n: TreeNode) => {
    if (n.ready && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
    n.children.forEach(visit);
  };
  visit(t.root);
  return out;
}

const line = (n: TreeNode) => `- ${n.id} — ${n.title.slice(0, 110)}${n.path ? ` — ${n.path}` : ""}`;

/** the wake prompt's night queue block ([] by day, or when the tree has no ready row). */
export function nightQueueSection(t: Tree, now = Date.now()): string[] {
  const phase = nightPhase(now);
  if (phase === "day") return [];
  const ready = readyRows(t);
  if (!ready.length) return [];
  const marked = ready.filter(isNightMarked);
  const who = ownerName();
  if (phase === "evening")
    return [
      "",
      `## Night queue: mark it now, before ${who} sleeps (${EVENING_FROM}:00 to ${NIGHT_FROM}:00 Mexico City)`,
      `Add \`${NIGHT_TAG}\` to the Next action cell of each ready row in your scope that needs no yes from ${who} to finish tonight ` +
        `(no spend, publishing, his Mac, a login of his or a decision of his on the way); take it off a row that does. ` +
        `Never ready a draft for the queue: only ${who} readies (root L-37). The night wakes start \`${NIGHT_TAG}\` rows first.`,
      `Marked now: ${marked.length} of ${ready.length} ready${marked.length ? ` (${marked.map((n) => n.id).join(", ")})` : ""}.`,
    ];
  const rest = ready.filter((n) => !isNightMarked(n));
  return [
    "",
    `## Night queue (${NIGHT_FROM}:00 to ${String(NIGHT_TO).padStart(2, "0")}:00 Mexico City: ${who} is asleep)`,
    marked.length
      ? `Start these first, one worker each, within the worker ceiling and the memory floor (pick); they need no yes from ${who}:`
      : `No row is marked \`${NIGHT_TAG}\`: start the ready rows that need no yes from ${who}; leave a row that does for the morning and say so in your summary.`,
    ...marked.map(line),
    ...(marked.length && rest.length ? [`Then the other ready rows (${rest.length}) that need no yes from ${who}.`] : []),
  ];
}
