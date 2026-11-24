import fs from "node:fs";
import path from "node:path";
import { homeRepo, ownerName } from "./identity.js";
import { inForceWords, NEWEST_WORD_RULE, replacedWords, type HisWordsFile } from "./desk/hisObjectives.js";
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
  keyResults?: { label?: string; state?: string; value?: string; target?: string; evidence?: { what: string; url: string }; work?: TicketRef[] }[];
  /** its open tickets that hang under no key result. */
  unplaced?: TicketRef[];
  /** another objective's page shows this one inside it: listed with that one, not on its own. */
  foldedInto?: string;
  /** the screen's own colour (the worst key result); read first. */
  state?: string;
  idle?: { idle: boolean; reason?: string };
}
export interface TicketRef {
  code: string;
  repo?: string;
  kind?: string;
  state?: string;
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
/** Root L-100 in one line (his vn_cdef45cd, 24 Nov: "I've explained it more than 20 times ... this is the last time"):
 * every wake prompt (objectivesBlock) and every worker brief (objectivesRule) carries it, so no agent asks him again. */
export const OBJECT_SHAPE_RULE =
  "What an objective is (root L-100, never ask him again): every objective, and every campaign, is an object of one class, always the same shape; each tab is one of its chapters, a part of its knowledge enforced to exist, both a UX and a data thing; Chapter is his word for one, never property, totem or facet on what he reads. " +
  "Each product has its own count of chapters (never a fixed nine or ten), some shared by every product and some its own, listed below as read from docs/totems/<product>.json `wheel.tabs`. " +
  "Write only into those chapters: the console's /made-of screen and `scripts/totems.py for <repo>` say what each holds, where it lives and who reads and writes it.";

/**(the owner, 24 Nov 20:37Z: "When you are born as an agent, you are told about these chapters"): each
 * product's chapters, read from its graph file in the home checkout, in one line every wake prompt and worker brief carries. */
export interface ChapterList {
  product: string;
  kind: string;
  tabs: string[];
}
export interface Chapters {
  lists: ChapterList[];
  shared: string[];
  inTwo?: string;
  kept?: string;
}
export function readChapters(home: string | undefined): Chapters | undefined {
  if (!home) return undefined;
  const dir = path.join(home, "docs", "totems");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  const lists: ChapterList[] = [];
  let rules: { shared?: unknown; inTwo?: unknown; kept?: unknown } = {};
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { name?: string; product?: string; chapters?: typeof rules; wheel?: { class?: { name?: string }; tabs?: { label?: string }[] } };
      if (o.chapters) rules = o.chapters;
      const tabs = (o.wheel?.tabs ?? []).map((t) => t.label).filter((l): l is string => typeof l === "string" && !!l);
      if (tabs.length) lists.push({ product: o.name ?? o.product ?? n.replace(/\.json$/, ""), kind: o.wheel?.class?.name ?? "Wheel", tabs });
    } catch {
      /* a broken map file: scripts/totems.py check names it */
    }
  }
  if (!lists.length) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { lists, shared: Array.isArray(rules.shared) ? rules.shared.filter((x): x is string => typeof x === "string") : [], inTwo: str(rules.inTwo), kept: str(rules.kept) };
}
export function chaptersLine(c: Chapters | undefined): string {
  if (!c?.lists.length) return "";
  const shared = new Set(c.shared);
  const each = c.lists.map((l) => {
    const own = l.tabs.filter((t) => !shared.has(t));
    return `${l.product} ${l.kind.toLowerCase()}, ${l.tabs.length}: ${l.tabs.join(", ")}${own.length ? ` (its own: ${own.join(", ")})` : ""}`;
  });
  const rules = [c.inTwo && "An item may sit in two chapters.", c.kept && "A campaign's or objective's chapters are kept after it ends."].filter(Boolean).join(" ");
  return `Your chapters, told at birth (docs/totems/<product>.json \`wheel.tabs\`): ${each.join(" ; ")}.${c.shared.length ? ` Shared by every product: ${c.shared.join(", ")}.` : ""}${rules ? ` ${rules}` : ""}`;
}
/** the block rides on every wake: kept short. */
export const OBJECTIVES_MAX_CHARS = 3_600; // room for each objective's tickets line

const DOT: Record<string, string> = { green: "🟢", amber: "🟡", red: "🔴" };
const cut = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** the first line of every plan and report: which objective this moves. */
/** every ticket hangs under a key result: the wake places each one its line names. */
export const TICKETS_RULE =
  "Every open ticket hangs under one key result: a key result's `work` list in its scorecard names it. A line below naming tickets under none: put each in the `work` of the key result it moves (`python3 scripts/kr_tickets.py place <row> <objective id> <key result number>`), or close it when it moves none.";
export const OBJECTIVE_LINE = "`Objective: <its name>: how this step moves it`";
/** How every objective is named (the owner: "they have to be short and they need to be well clear"; which product: the one whose scope covers it),
 * carried by the worker rule, every wake's objectives block and the desk's; scripts/objectives_check.py fails a name that breaks it. */
export const OBJECTIVE_NAME_RULE =
  "Name an objective `Product: short goal`: the product it belongs to first (the one whose `scope` in docs/totems/<product>.json covers what it is about, never the one whose users it serves: " +
  "a product that only communicates holds no platform, login or server objective; scripts/objectives_check.py refuses one outside its scope), " +
  "a colon, then 2 to 6 plain words starting with a verb " +
  "with a capital letter (`Acme: Get 5 testers`, `Acme: Get the team browser fully working`), the owner's words where he said them, no two names alike; " +
  "every key result line starts with a capital letter too; " +
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
  /** its tickets: how many open ones hang under its key results, and the ones under none by code. */
  tickets?: string;
  words?: string;
}

/** a key result's open tickets (done ones left out), by code. */
export function openTickets(work: TicketRef[] | undefined): string[] {
  return [...new Set((work ?? []).filter((w) => (w.kind ?? "ticket") === "ticket" && w.state !== "green").map((w) => w.code))];
}

/**
 * the brief's key result line for one row: every worker knows which key result its ticket moves, or that it
 * hangs under none yet and how to place it. `repo` is the row's repo folder name.
 */
export function keyResultLines(input: ObjectivesInput | undefined, row: string, repo: string, planOf?: (objective: string, kr: number) => string): string {
  const hits: string[] = [];
  for (const n of input?.nodes ?? []) {
    if (n.kind !== "pursuit") continue;
    (n.keyResults ?? []).forEach((k, i) => {
      if (!(k.work ?? []).some((w) => w.code === row && (!w.repo || w.repo === repo))) return;
      hits.push(`Key result: ${n.headline || n.name}: ${k.label ?? ""} (key result ${n.id}#${i}). Your work moves it; say how in your report.`);
      // its plan (the objective's Plan tab): the worker builds the step it is on, the way the plan says (vn_9c02d869).
      if (planOf) hits.push(`The plan for this key result (its objective's Plan tab; your row is one of its steps, build it the way the plan says, and say in your report what moved):\n${planOf(n.id, i + 1)}`);
    });
  }
  return hits.length
    ? hits.join("\n")
    : `Key result: none yet. ${row} hangs under no key result: before you plan, put it under the key result it moves (\`python3 ~/github/${homeRepo()}/scripts/kr_tickets.py place ${row} <objective id> <n>${repo === homeRepo() ? "" : ` --repo ${repo}`}\`), or say in your report why it moves none.`;
}

/** "4 open tickets under its key results; 2 under none: E907-S1, E907-S2". */
export function ticketsLine(n: Pick<ObjectiveNode, "keyResults" | "unplaced">): string | undefined {
  if (!n.keyResults?.length) return undefined;
  const under = new Set(n.keyResults.flatMap((k) => openTickets(k.work)));
  const none = (n.unplaced ?? []).map((w) => w.code);
  const head = `${under.size} open ticket${under.size === 1 ? "" : "s"} under its key results`;
  if (!none.length) return `${head}, none under no key result`;
  return `${head}; ${none.length} under none: ${none.slice(0, 4).join(", ")}${none.length > 4 ? ` +${none.length - 4}` : ""}`;
}

/** one entry per objective (top-level pursuit nodes, his order, parked ones left out). */
export function objectiveLines(input: ObjectivesInput | undefined, plot?: HisWordsFile): Line[] {
  const words = new Map<string, { words: string; said?: string; replaces: string }>();
  for (const p of plot?.objectives ?? []) {
    const w = inForceWords(p); // his newest word wins: an aim only while it is newer than his newest words
    const r = replacedWords(p)[0]; // the older word it replaces: named before the quote, so a cut line still shows it
    if (w?.words) words.set(p.id, { words: w.words, said: w.said, replaces: r ? ` (replaces his word${r.said ? ` of ${r.said.slice(5, 10)}` : ""})` : "" });
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
    const tickets = ticketsLine(n);
    return {
      id: n.id,
      rank: i + 1,
      name: cut(title(n), 90) + (holds.length ? ` (with: ${cut(holds.join(", "), 80)})` : ""),
      light,
      krs: `${greens} of ${total} key results green`,
      today,
      ...(tickets ? { tickets } : {}),
      ...(w ? { words: `his words${w.said ? ` ${w.said.slice(5, 10)}` : ""}, in force${w.replaces}: "${cut(w.words, 110)}"` } : {}),
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
  keyResults: { label: string; state?: string; value?: string; target?: string; tickets?: string[] }[];
  stands: string;
  words?: string;
  said?: string;
}[] {
  const nodes = new Map((input?.nodes ?? []).map((n) => [n.id, n]));
  const said = new Map<string, { words: string; said?: string }>();
  for (const p of plot?.objectives ?? []) {
    const w = inForceWords(p);
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
      keyResults: (n?.keyResults ?? []).map((k) => ({ label: k.label ?? "", ...(k.state ? { state: k.state } : {}), ...(k.value ? { value: k.value } : {}), ...(k.target ? { target: k.target } : {}), ...(k.evidence ? { evidence: k.evidence.what } : {}), ...(openTickets(k.work).length ? { tickets: openTickets(k.work) } : {}) })),
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
      const w = inForceWords(p);
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
export function objectivesBlock(input: ObjectivesInput | undefined, plot?: HisWordsFile, red?: RedLine[], chapters?: string): string {
  const lines = objectiveLines(input, plot);
  if (!lines.length) return "";
  const head = [
    OBJECTIVES_HEAD,
    `${ownerName()}'s objectives, his order, live from the objectives screen (docs/pursuits.json; his newest words from docs/his-words.json, read from his voice notes and the desk chat). Every wake and every worker reads this same list.`,
    NEWEST_WORD_RULE,
    `Before you plan, ask which objective it moves: the first line of your plan, of each worker brief you write and of your report is ${OBJECTIVE_LINE} (none: \`Objective: none, <why>\`, and it waits behind work that moves one). Remove fluff rather than add it.`,
    OBJECTIVE_NAME_RULE,
    TICKETS_RULE,
    OBJECT_SHAPE_RULE,
    ...(chapters ? [chapters] : []),
  ];
  const body = lines.map((l) => [`${l.rank}. ${DOT[l.light] ?? "⚪"} ${l.name}`, l.krs, l.today, l.tickets, l.words].filter(Boolean).join(" · "));
  const also = alsoHis(plot);
  const reds = redLineWords(red, lines);
  const tail = [...(also.length ? [`Also his: ${also.join(" · ")}`] : []), ...(reds ? [`Red lines (docs/pursuits.json): ${reds}`] : [])];
  let out = [...head, ...body, ...tail].join("\n");
  // too long: each part is cut on its own, so neither its tickets nor his words in force (and what they replace) are cut away
  const short = () => lines.map((l) => [`${l.rank}. ${DOT[l.light] ?? "⚪"} ${cut(l.name, 50)}`, l.krs, cut(l.today, 30), l.tickets && cut(l.tickets, 70), l.words && cut(l.words, 100)].filter(Boolean).join(" · "));
  if (out.length > OBJECTIVES_MAX_CHARS) out = [...head, ...short(), ...tail.map((t) => cut(t, 220))].join("\n");
  return out;
}

/** the same list in one line, for the worker rule (one quoted rule a line). */
export function objectivesOneLine(input: ObjectivesInput | undefined, plot?: HisWordsFile): string {
  const lines = objectiveLines(input, plot);
  return lines.map((l) => `${l.rank}. ${l.name} (${l.krs}; ${l.today.replace(/ \(.*\)$/, "")})`).join(" ; ");
}

/** the worker rule with the live list in it (the console serves it first at /api/worker-rules). */
export function objectivesRule(oneLine?: string, chapters?: string): string {
  return (oneLine ? `${OBJECTIVES_RULE} His objectives now: ${oneLine}.` : `${OBJECTIVES_RULE} Read them at GET /api/objectives on the console.`) + ` ${OBJECT_SHAPE_RULE}` + (chapters ? ` ${chapters}` : "");
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
