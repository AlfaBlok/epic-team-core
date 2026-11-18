import fs from "node:fs";
import path from "node:path";
import { ownerName } from "./identity.js";
import type { HisWordsFile } from "./desk/hisObjectives.js";
import { redLinesFile } from "./inbox/jordiPriority.js";

/**
 * The owner's objectives are the one thing every agent rereads. The owner: "let's crystallize the objectives and let's
 * just be obsessive about the objectives. Let's read these objectives repeatedly so that they're kind of top of mind ...
 * It's removing fluff and crystallizing into the simplest form."
 *
 * Nothing new is kept here: the block is read from what already exists. The objectives and their lights are the
 * objectives screen's (scorecards: docs/pursuits.json in his order, each one's short objective and key results);
 * "moved today" is that screen's own count of key results turned green today; his words come from the
 * desk (docs/his-words.json, the desk's [his objectives] block); the Red lines from the same docs/pursuits.json (one objectives file). The same block opens every
 * wake prompt of the home world and rides in every worker brief as its first rule, so desk, wakes and workers read
 * one list in one order.
 */

/** the part of a scorecard node this reads (scorecards.ts ScorecardNode). */
export interface ObjectiveNode {
  id: string;
  kind: string;
  name: string;
  rank?: number | null;
  parked?: boolean;
  headline?: string;
  objective?: string;
  greens: number;
  total: number;
  keyResults?: { label?: string; state?: string; value?: string; target?: string; evidence?: { what: string; url: string } }[];
  /** another objective's page shows this one inside it: listed with that one, not on its own. */
  foldedInto?: string;
  /** the screen's own colour (the worst key result); read first. */
  state?: string;
  idle?: { idle: boolean; reason?: string };
}
export interface ObjectivesInput {
  nodes: ObjectiveNode[];
  progress?: { sets?: Record<string, { today: number; week: number }> };
}
export interface RedLine {
  name: string;
  sentence?: string;
  target?: string;
  state?: string;
  /** the objective (pursuit id) the red line sits inside; none = a line of its own. */
  objective?: string;
}

export const OBJECTIVES_HEAD = "## His objectives: reread them before any work";
/** the block rides on every wake: kept short. */
export const OBJECTIVES_MAX_CHARS = 2_400;

const DOT: Record<string, string> = { green: "🟢", amber: "🟡", red: "🔴" };
const cut = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** the first line of every plan and report: which objective this moves. */
export const OBJECTIVE_LINE = "`Objective: <its name>: how this step moves it`";
/** How every objective is named (the owner: "they have to be short and they need to be well clear"),
 * carried by the worker rule, every wake's objectives block and the desk's; scripts/objectives_check.py fails a name that breaks it. */
export const OBJECTIVE_NAME_RULE =
  "Name an objective `Product: short goal`: the product it belongs to first, a colon, then 2 to 5 plain words " +
  "(`Acme: 5 testers`, `Acme: team browser fully operational`), the owner's words where he said them, no two names alike; " +
  "the name goes in docs/pursuits.json `name`, the longer sentence stays in its green-when.";
export const OBJECTIVES_RULE =
  `Objectives first: before any work reread ${ownerName()}'s objectives below (his order, live; the same list opens every wake prompt and is served at GET /api/objectives). ` +
  `Ask "which objective does this move?" before you plan: the first line of your plan and of your report is ${OBJECTIVE_LINE} ` +
  "(several: name each; none: `Objective: none, <why it is still worth doing>`, and that work waits behind work that moves one). " +
  "Keep to them and keep it lean: remove fluff rather than add it; never add a second list, priority file or order of your own. " +
  OBJECTIVE_NAME_RULE;

interface Line {
  id: string;
  rank: number;
  name: string;
  light: string;
  krs: string;
  today: string;
  words?: string;
}

/** one entry per objective (top-level pursuit nodes, his order, parked ones left out). */
export function objectiveLines(input: ObjectivesInput | undefined, plot?: HisWordsFile): Line[] {
  const words = new Map<string, { words: string; said?: string }>();
  for (const p of plot?.objectives ?? []) {
    const w = p.aim?.words ? p.aim : p.after; // an aim he confirmed first, else his newest words naming it
    if (w?.words) words.set(p.id, { words: w.words, said: w.said });
  }
  const all = (input?.nodes ?? []).filter((n) => n.kind === "pursuit" && !n.parked && n.rank != null);
  const nodes = all.filter((n) => !n.foldedInto).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const title = (n: ObjectiveNode) => n.headline || n.objective || n.name;
  return nodes.map((n, i) => {
    const krs = n.keyResults?.length ? n.keyResults : undefined;
    const greens = krs ? krs.filter((k) => k.state === "green").length : n.greens;
    const total = krs ? krs.length : n.total;
    const light = n.state && DOT[n.state] ? n.state : greens === total && total > 0 ? "green" : (krs ?? []).some((k) => k.state === "red") || (!krs && n.greens < n.total) ? "red" : "amber";
    const holds = all.filter((x) => x.foldedInto === n.id).map(title);
    const t = input?.progress?.sets?.[n.id]?.today;
    const today =
      t === undefined
        ? "moved today: not counted"
        : t > 0
          ? `moved today: ${t} turned green`
          : `not moved today${n.idle?.reason ? ` (${cut(n.idle.reason, 70)})` : ""}`;
    const w = words.get(n.id);
    return {
      id: n.id,
      rank: i + 1,
      name: cut(title(n), 90) + (holds.length ? ` (with: ${cut(holds.join(", "), 80)})` : ""),
      light,
      krs: `${greens} of ${total} key results green`,
      today,
      ...(w ? { words: `his words${w.said ? ` ${w.said.slice(5, 10)}` : ""}: "${cut(w.words, 110)}"` } : {}),
    };
  });
}

/**
 * his objectives one by one for the call's briefing: the same list in the same order as the block (one source),
 * each with its key results, where it stands (moved today, else what moves it next) and his newest words whole.
 */
export function objectiveCards(input: ObjectivesInput | undefined, plot?: HisWordsFile): {
  id: string;
  name: string;
  light: string;
  krs: string;
  keyResults: { label: string; state?: string; value?: string; target?: string }[];
  stands: string;
  words?: string;
  said?: string;
}[] {
  const nodes = new Map((input?.nodes ?? []).map((n) => [n.id, n]));
  const said = new Map<string, { words: string; said?: string }>();
  for (const p of plot?.objectives ?? []) {
    const w = p.aim?.words ? p.aim : p.after;
    if (w?.words) said.set(p.id, { words: w.words, said: w.said });
  }
  return objectiveLines(input, plot).map((l) => {
    const n = nodes.get(l.id);
    const t = input?.progress?.sets?.[l.id]?.today;
    const stands = t && t > 0 ? `moved today: ${t} key result${t === 1 ? "" : "s"} turned green` : n?.idle?.reason ? `not moved today: ${n.idle.reason}` : "not moved today";
    const w = said.get(l.id);
    return {
      id: l.id,
      name: l.name,
      light: l.light,
      krs: l.krs,
      keyResults: (n?.keyResults ?? []).map((k) => ({ label: k.label ?? "", ...(k.state ? { state: k.state } : {}), ...(k.value ? { value: k.value } : {}), ...(k.target ? { target: k.target } : {}), ...(k.evidence ? { evidence: k.evidence.what } : {}) })),
      stands,
      ...(w ? { words: w.words, ...(w.said ? { said: w.said } : {}) } : {}),
    };
  });
}

/** the other worlds he names in docs/pursuits.json (`otherWorlds`, their record lives there: notes only), as his words file holds them. */
function alsoHis(plot?: HisWordsFile): string[] {
  return (plot?.objectives ?? [])
    .filter((p) => p.world)
    .map((p) => {
      const w = p.aim?.words ? p.aim : p.after;
      return `${p.name ?? p.id} (its own world ${p.world?.repo ?? "?"}: notes only)${w?.words ? `: "${cut(w.words, 90)}"` : ""}`;
    });
}

function redLineWords(red: RedLine[] | undefined, lines: Line[]): string {
  if (!red?.length) return "";
  return red
    .map((r) => {
      const inside = r.objective ? lines.find((l) => l.id === r.objective)?.rank : undefined;
      return `${r.name}${r.target ? ` by ${r.target}` : ""} (${inside ? `inside objective ${inside}` : "no objective of its own yet"})`;
    })
    .join(" · ");
}

/** the block every wake prompt opens with (after its header). Empty: no objectives read. */
export function objectivesBlock(input: ObjectivesInput | undefined, plot?: HisWordsFile, red?: RedLine[]): string {
  const lines = objectiveLines(input, plot);
  if (!lines.length) return "";
  const head = [
    OBJECTIVES_HEAD,
    `${ownerName()}'s objectives, his order, live from the objectives screen (docs/pursuits.json; his newest words from docs/his-words.json, read from his voice notes). Every wake and every worker reads this same list.`,
    `Before you plan, ask which objective it moves: the first line of your plan, of each worker brief you write and of your report is ${OBJECTIVE_LINE} (none: \`Objective: none, <why>\`, and it waits behind work that moves one). Remove fluff rather than add it.`,
    OBJECTIVE_NAME_RULE,
  ];
  const body = lines.map((l) => [`${l.rank}. ${DOT[l.light] ?? "⚪"} ${l.name}`, l.krs, l.today, l.words].filter(Boolean).join(" · "));
  const also = alsoHis(plot);
  const reds = redLineWords(red, lines);
  const tail = [...(also.length ? [`Also his: ${also.join(" · ")}`] : []), ...(reds ? [`Red lines (docs/pursuits.json): ${reds}`] : [])];
  let out = [...head, ...body, ...tail].join("\n");
  if (out.length > OBJECTIVES_MAX_CHARS) out = [...head, ...body.map((b) => cut(b, 150)), ...tail.map((t) => cut(t, 220))].join("\n");
  return out;
}

/** the same list in one line, for the worker rule (one quoted rule a line). */
export function objectivesOneLine(input: ObjectivesInput | undefined, plot?: HisWordsFile): string {
  const lines = objectiveLines(input, plot);
  return lines.map((l) => `${l.rank}. ${l.name} (${l.krs}; ${l.today.replace(/ \(.*\)$/, "")})`).join(" ; ");
}

/** the worker rule with the live list in it (the console serves it first at /api/worker-rules). */
export function objectivesRule(oneLine?: string): string {
  return oneLine ? `${OBJECTIVES_RULE} His objectives now: ${oneLine}.` : `${OBJECTIVES_RULE} Read them at GET /api/objectives on the console.`;
}

/** a checkout's Red lines, from the one objectives file (docs/pursuits.json; else docs/priorities.json); [] when missing or broken. */
export function readRedLines(dir: string | undefined): RedLine[] {
  if (!dir) return [];
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, redLinesFile(dir)), "utf8")) as { redLines?: RedLine[] };
    return Array.isArray(f.redLines) ? f.redLines.filter((r) => r && typeof r.name === "string" && r.state !== "dropped") : [];
  } catch {
    return [];
  }
}
