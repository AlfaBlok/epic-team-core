import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "../adapters/repos.js";
import type { Store } from "../store.js";
import { hooks } from "../plug/hooks.js";

/**
 * the Prioritizer persona reads
 * his recent voice notes once a day and writes one priority per open epic and per ready or review row, with a why that
 * quotes him, into `docs/priorities.json` of the world's repo (the repo is the record, root L-45). The inbox sorts by it:
 * high first, then normal (and anything it did not rank), then low; inside one level the milestone order and the
 * old order stay. The console only reads the file; it never writes it.
 */
export type JordiLevel = "high" | "normal" | "low";
export const PRIORITIES_FILE = "docs/priorities.json";
/**
 * One objectives file every agent and the desk read: the owner's objectives, their
 * order and his red lines live in one file, docs/pursuits.json; docs/priorities.json keeps only the levels.
 */
export const OBJECTIVES_FILE = "docs/pursuits.json";
/** his words on each objective, with the words that tell a message is about it (scripts/his_words.py). */
export const HIS_WORDS_FILE = "docs/his-words.json";
/** each objective's scorecard (its key results and their work lists). */
const SCORECARD_DIR = "docs/scorecards";

/** the file a checkout's red lines live in: the objectives file when it holds `redLines`, else docs/priorities.json (a world with no pursuits file). */
export function redLinesFile(dir: string): string {
  try {
    const f = JSON.parse(textOf(path.join(dir, OBJECTIVES_FILE)) ?? "{}") as { redLines?: unknown };
    if (Array.isArray(f.redLines)) return OBJECTIVES_FILE;
  } catch {
    // no objectives file here
  }
  return PRIORITIES_FILE;
}

export interface JordiPriority {
  level: JordiLevel;
  /** One line in plain words: why this level. */
  why: string;
  /** His words it rests on, quoted. */
  words?: string;
  /** When he said them (YYYY-MM-DD). */
  said?: string;
  /** Where his words are (the memory service ref like `Log/2026-11-10.md#^e-4eb4cd`, or a `vn_…` id). */
  source?: string;
  /** The row or epic code the level was given to (a row's own, else its epic's). */
  ref: string;
  /** The day the persona wrote the file. */
  at?: string;
  /**
   * the item is on the owner's red line (the file's `redLine`): above every level, with a red marker. The line's
   * sentence, the day it was proposed and whether he agreed come along so the marker can say it.
   */
  redLine?: RedLineMark;
  /** the owner was frustrated about it or asked for it again (the file's `pressing`): first of all, until it is answered. */
  pressing?: PressingMark;
  /** the objective of his it moves (his order, docs/pursuits.json): the first leads, the rest break ties. */
  objective?: ObjectiveMark;
}

/**
 * a general rule, no section of its own: an item tied to something the owner said with frustration or said again leads
 * every list (above the red line) until it is answered or closed. `scripts/pressing.py` writes the entries into the
 * levels file from his voice notes (and the desk adds one by hand); the console only reads them.
 */
/** `first`: one item the owner asked by name to be first; it leads even his first objective. */
export type PressingKind = "frustrated" | "repeated" | "first";
export interface PressingMark {
  kind: PressingKind;
  why: string;
  words?: string;
  said?: string;
  source?: string;
  /** its place in the file (0 = first): the order inside the pressing tier, the newest or hand-added first. */
  order?: number;
}
export interface PressingEntry extends PressingMark {
  repo: string;
  ref: string;
  path?: string;
}
/**
 * the objective an item moves, read from his objectives (docs/pursuits.json, his order; the one objectives file) and
 * the words that tell a message is about each (docs/his-words.json `match`, read from his voice notes). No hand-set
 * rule: the first objective's items lead every list, and inside every tier his order breaks the tie. `n` 0 is his first.
 */
export interface ObjectiveMark {
  n: number;
  id: string;
  name: string;
}
export interface ObjectiveDef extends ObjectiveMark {
  /** groups of word patterns, every pattern of one group in the item's words (his_words.py `matches`). */
  match: RegExp[][];
  /** repos only this objective names (its epics, watched paths, campaign): an item living there moves it. */
  repos: string[];
  /** `<repo>:<file>` of its epics and watched files. */
  spines: string[];
  /** `<repo>:<code>` of every ticket and ask its key results list in their `work` (its scorecard): the item's own key result. */
  work?: string[];
  /** a shared objective shown inside another one (its scorecard's `foldedInto`): its items name that one. */
  foldedInto?: string;
}
/** the objective tier: items on his first objective lead, above what is pressing. */
export const OBJECTIVE_TIER = -2;

/** At most this many items lead the inbox as pressing (the newest first in the file): a few, never a second backlog. */
export const PRESSING_MAX = 7;

/** what a red-line item carries: the line's sentence and where it stands with the owner. */
export interface RedLineMark {
  sentence: string;
  state: RedLineState;
  ask?: string;
  at?: string;
  /** the line's name ("the memory service's first tester", "Data-product flywheel") and its place (0 = the first line). */
  name?: string;
  line?: number;
}

/**
 * the ONE line that moves us forward most tangibly now, from his recent voice
 * notes, answers and presses, with the 3 to 7 rows and asks on it. The Prioritizer writes it into `docs/priorities.json`
 * (`redLine`) and the root spine's Current State (`Red line:`), and proposes it as one coded ask; its items lead the inbox.
 */
export type RedLineState = "proposed" | "agreed" | "changed";
export interface RedLineItem {
  repo: string;
  /** A row code (``), an ask code (``) or an epic (`` with its `path`). */
  ref: string;
  path?: string;
  /** One line: why this item is on the line. */
  why?: string;
}
export interface RedLine {
  /**
   * red lines can be several, each named; the first
   * one leads.
   */
  name?: string;
  /** the line's deadline (YYYY-MM-DD), when the owner gave one ("by the end of the month"). */
  target?: string;
  sentence: string;
  why?: string;
  words?: string;
  said?: string;
  source?: string;
  state: RedLineState;
  /** The coded ask that proposed it (``). */
  ask?: string;
  /** When this line was proposed (ISO). */
  at?: string;
  items: RedLineItem[];
  /** The repo whose file holds the line (its `ask` is in that repo's). */
  repo?: string;
  /** the objective (its docs/pursuits.json id) the line serves. */
  objective?: string;
  /**
   * pages the
   * line is about, each one plain label and an https address, shown on its band.
   */
  links?: RedLineLink[];
  /** live numbers on the band, each read from a remote source (`memory-counts#active_testers`, remoteCounts.ts). */
  counts?: RedLineCount[];
}
export interface RedLineLink {
  label: string;
  url: string;
}
export interface RedLineCount {
  label: string;
  /** `<source>#<field>`. */
  source: string;
  /** Filled by the route: the number (null when never read), where it came from, when it was read. */
  value?: number | null;
  sourceText?: string;
  note?: string;
  page?: { name: string; address: string; url: string };
}
/** At most this many links and counts on a band. */
export const RED_LINE_EXTRAS_MAX = 3;

interface Entry extends JordiPriority {
  repo: string;
  path?: string;
}

export interface PriorityFile {
  version?: number;
  at?: string;
  by?: string;
  run?: string;
  items: Entry[];
  /** one line. `redLines`, several named ones; `redLine` is still read as the only line. */
  redLine?: RedLine;
  redLines?: RedLine[];
  pressing?: PressingEntry[];
}

const LEVELS = new Set<JordiLevel>(["high", "normal", "low"]);
/** tier 0 is the red line, above every level. */
const TIER: Record<JordiLevel, number> = { high: 1, normal: 2, low: 3 };
export const RED_LINE_TIER = 0;
/** above the red line: what he was frustrated about or said again (a negative tier keeps every other number as it was). */
export const PRESSING_TIER = -1;
/** The tier of an item the persona did not rank: with the normal ones. */
export const UNRANKED_TIER = TIER.normal;
/** an item the owner asked by name to be first leads every tier, his first objective too. */
export const FIRST_TIER = -3;
export const tierOf = (p?: Pick<JordiPriority, "level" | "redLine" | "pressing" | "objective">) =>
  p?.pressing?.kind === "first" ? FIRST_TIER : p?.objective?.n === 0 ? OBJECTIVE_TIER : p?.pressing ? PRESSING_TIER : p?.redLine ? RED_LINE_TIER : p ? TIER[p.level] : UNRANKED_TIER;

const STATES = new Set<RedLineState>(["proposed", "agreed", "changed"]);
/** At most this many items lead the inbox, whatever the file says (the owner: a line, not a second backlog). */
export const RED_LINE_MAX = 7;

/** the file's (first) red line; none (or a broken one: no sentence, no items) is undefined and the inbox is as before. */
export function parseRedLine(text: string, repoName: string): RedLine | undefined {
  return parseRedLines(text, repoName)[0];
}

/** at most this many lines: a few named lines, not a second backlog. */
export const RED_LINES_MAX = 4;

/**
 * every red line of the file, in its order (the first leads): `redLines` (a list of named lines), else the
 * `redLine` (one object, or a list). A broken line is skipped; a second line's name repeats are dropped.
 */
export function parseRedLines(text: string, repoName: string): RedLine[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const f = raw as PriorityFile;
  const list: unknown[] = Array.isArray(f.redLines) ? f.redLines : Array.isArray(f.redLine) ? (f.redLine as unknown[]) : f.redLine ? [f.redLine] : [];
  const out: RedLine[] = [];
  const names = new Set<string>();
  for (const r of list) {
    const line = oneLine(r, repoName);
    if (!line) continue;
    const key = norm(line.name ?? line.sentence);
    if (names.has(key)) continue;
    names.add(key);
    out.push(line);
    if (out.length >= RED_LINES_MAX) break;
  }
  return out;
}

function oneLine(r: unknown, repoName: string): RedLine | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
  const e = r as Record<string, unknown>;
  const s = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const sentence = s(e, "sentence");
  if (!sentence) return undefined;
  const items: RedLineItem[] = [];
  for (const it of Array.isArray(e.items) ? (e.items as unknown[]) : []) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const ref = s(o, "ref");
    if (!ref) continue;
    items.push({ repo: s(o, "repo") ?? repoName, ref, ...(s(o, "path") ? { path: s(o, "path") } : {}), ...(s(o, "why") ? { why: s(o, "why") } : {}) });
    if (items.length >= RED_LINE_MAX) break;
  }
  if (!items.length) return undefined;
  const state = s(e, "state") as RedLineState | undefined;
  const opt = (k: string) => (s(e, k) ? { [k]: s(e, k) } : {});
  const list = (k: string) => (Array.isArray(e[k]) ? (e[k] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const links = list("links")
    .map((o) => ({ label: s(o, "label") ?? "", url: s(o, "url") ?? "" }))
    .filter((l) => l.label && /^https:\/\/[^\s"<>]+$/.test(l.url))
    .slice(0, RED_LINE_EXTRAS_MAX);
  const counts = list("counts")
    .map((o) => ({ label: s(o, "label") ?? "", source: hooks.counts.sourceId(s(o, "source") ?? "") ?? "" }))
    .filter((c) => c.label && c.source)
    .slice(0, RED_LINE_EXTRAS_MAX);
  return { ...opt("name"), sentence, state: state && STATES.has(state) ? state : "proposed", items, repo: repoName, ...opt("why"), ...opt("words"), ...opt("said"), ...opt("source"), ...opt("ask"), ...opt("at"), ...opt("target"), ...opt("objective"), ...(links.length ? { links } : {}), ...(counts.length ? { counts } : {}) };
}

/** Parse one file; a broken entry is skipped, a broken file is none (the inbox keeps the milestone order). */
export function parsePriorities(text: string, repoName: string): Entry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const items = raw && typeof raw === "object" && Array.isArray((raw as PriorityFile).items) ? (raw as PriorityFile).items : [];
  const at = typeof (raw as PriorityFile).at === "string" ? (raw as PriorityFile).at : undefined;
  const out: Entry[] = [];
  for (const it of items as unknown[]) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    const s = (k: string) => (typeof e[k] === "string" && (e[k] as string).trim() ? (e[k] as string).trim() : undefined);
    const level = s("level") as JordiLevel | undefined;
    const ref = s("ref");
    const why = s("why");
    if (!level || !LEVELS.has(level) || !ref || !why) continue;
    out.push({
      repo: s("repo") ?? repoName,
      ref,
      level,
      why,
      ...(s("path") ? { path: s("path") } : {}),
      ...(s("words") ? { words: s("words") } : {}),
      ...(s("said") ? { said: s("said") } : {}),
      ...(s("source") ? { source: s("source") } : {}),
      ...(at ? { at: at.slice(0, 10) } : {}),
    });
  }
  return out;
}

/** the file's pressing entries (a broken one is skipped, a ref twice keeps the first), at most PRESSING_MAX. */
export function parsePressing(text: string, repoName: string): PressingEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = raw && typeof raw === "object" && Array.isArray((raw as PriorityFile).pressing) ? ((raw as PriorityFile).pressing as unknown[]) : [];
  const out: PressingEntry[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const e = it as Record<string, unknown>;
    const s = (k: string) => (typeof e[k] === "string" && (e[k] as string).trim() ? (e[k] as string).trim() : undefined);
    const ref = s("ref");
    const why = s("why");
    const kind = s("kind");
    if (!ref || !why || (kind !== "frustrated" && kind !== "repeated" && kind !== "first")) continue;
    const repo = s("repo") ?? repoName;
    const key = `${norm(repo)}#${norm(ref)}#${s("path") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, ref, kind, why, ...(s("path") ? { path: s("path") } : {}), ...(s("words") ? { words: s("words") } : {}), ...(s("said") ? { said: s("said") } : {}), ...(s("source") ? { source: s("source") } : {}) });
    if (out.length >= PRESSING_MAX) break;
  }
  return out;
}

/** a citation of where his words are kept ("<Name> Log/2026-11-14.md#^e-…") names the memory service, not what an item is about. */
const NOT_ABOUT = /\b[\w-]+ Log\/\S*/g;
/** one pattern of the words file as a word-start match (his_words.py `matches`); a broken one is dropped. */
function pattern(t: string): RegExp | undefined {
  try {
    return new RegExp(`\\b(?:${t})`, "i");
  } catch {
    return undefined;
  }
}
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const str = (o: Obj, k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
const cleanPath = (f: string) => f.replace(/^\.?\//, "");

/**
 * his objectives in his order (docs/pursuits.json `pursuits`) with their words (docs/his-words.json, by id; its name
 * is the one he uses). A broken or missing objectives file is none: the order is as before.
 */
export function parseObjectives(pursuitsText: string | undefined, wordsText?: string, cards: Record<string, string | undefined> = {}): ObjectiveDef[] {
  let ps: Obj[];
  try {
    const p = JSON.parse(pursuitsText ?? "") as Obj;
    // an objective he switched inactive (`"active": false`) orders nothing; a parked one (`"parked": true`) has no place
    // in his sidebar, so it takes no number either (every later card read one too high): the number on a card is the
    // one his sidebar shows.
    ps = (Array.isArray(p.pursuits) ? (p.pursuits as unknown[]) : []).filter((x): x is Obj => isObj(x) && !!str(x, "id") && x.active !== false && x.parked !== true);
  } catch {
    return [];
  }
  let ws: Obj[] = [];
  try {
    const w = JSON.parse(wordsText ?? "") as Obj;
    ws = Array.isArray(w.objectives) ? (w.objectives as unknown[]).filter(isObj) : [];
  } catch {
    // no words file: matched by where items live only
  }
  const places = ps.map((o) => {
    const repos = new Set<string>();
    const spines: string[] = [];
    for (const e of [...(Array.isArray(o.epics) ? o.epics : []), ...(Array.isArray(o.watch) ? o.watch : [])] as unknown[]) {
      if (!isObj(e) || !str(e, "repo")) continue;
      const r = norm(str(e, "repo")!);
      repos.add(r);
      const files = [...(str(e, "spine") ? [str(e, "spine")!] : []), ...(Array.isArray(e.paths) ? (e.paths as unknown[]).filter((x): x is string => typeof x === "string") : [])];
      for (const f of files) spines.push(`${r}:${cleanPath(f)}`);
    }
    const camp = isObj(o.numbers) ? str(o.numbers, "campaign") : undefined;
    if (camp) repos.add(norm(camp));
    return { repos, spines };
  });
  // a repo is an objective's own only when no other objective names it (the code repo serves them all)
  const named = new Map<string, number>();
  for (const p of places) for (const r of p.repos) named.set(r, (named.get(r) ?? 0) + 1);
  // its key results' work lists and its fold, from its scorecard (docs/scorecards/<id>.json); a plain code means its first epic's repo
  const sheets = ps.map((o) => {
    let card: Obj = {};
    try {
      const c = JSON.parse(cards[str(o, "id")!] ?? "{}") as unknown;
      if (isObj(c)) card = c;
    } catch {
      // no scorecard: no work lists
    }
    const first = (Array.isArray(o.epics) ? (o.epics as unknown[]) : []).find((e): e is Obj => isObj(e) && !!str(e, "repo"));
    const home = first ? norm(str(first, "repo")!) : "";
    const work = (Array.isArray(card.keyResults) ? (card.keyResults as unknown[]) : [])
      .flatMap((k) => (isObj(k) && Array.isArray(k.work) ? (k.work as unknown[]) : []))
      .filter((w): w is string => typeof w === "string" && !w.startsWith("note:"))
      .map((w) => {
        const m = /^([\w.-]+):(.+)$/.exec(w.trim());
        return m ? `${norm(m[1])}:${m[2].trim()}` : `${home}:${w.trim()}`;
      });
    return { work, foldedInto: str(card, "foldedInto") };
  });
  // his order as every list shows it: a folded copy takes no place of its own
  const ids = new Set(ps.map((o) => str(o, "id")!));
  const shown = ps.map((o, i) => !(sheets[i].foldedInto && ids.has(sheets[i].foldedInto!)));
  return ps.map((o, i) => {
    const id = str(o, "id")!;
    const w = ws.find((x) => str(x, "id") === id);
    const match = (w && Array.isArray(w.match) ? (w.match as unknown[]) : [])
      .map((g) => (Array.isArray(g) ? g.filter((t): t is string => typeof t === "string" && !!t.trim()).map(pattern) : []))
      .filter((g): g is RegExp[] => g.length > 0 && g.every(Boolean));
    const n = shown.slice(0, i).filter(Boolean).length;
    return {
      n,
      id,
      name: (w && str(w, "name")) ?? str(o, "name") ?? id,
      match,
      repos: [...places[i].repos].filter((r) => named.get(r) === 1),
      spines: places[i].spines,
      work: sheets[i].work,
      ...(shown[i] ? {} : { foldedInto: sheets[i].foldedInto }),
    };
  });
}

/**
 * the objective an item moves: its red line's objective, else the first in his order whose epic or watched file it lives
 * in, else the one whose own repo it lives in, else (only when none owns where it lives) the first whose words
 * its title or question says (an ask: its question and its epic's title, never the title of a row it sits on, E948-S160).
 */
export function objectiveOf(defs: ObjectiveDef[], i: Locatable, redLineObjective?: string): ObjectiveMark | undefined {
  const repo = i.repo ? norm(i.repo) : undefined;
  const spine = repo && i.path ? `${repo}:${cleanPath(i.path)}` : undefined;
  // E948-S160 (the owner's E995-A10 card read "Bitwarden" for an Exa ask): an ask is read in its own words and its epic's
  // title. An ask on a row carries that row's title instead, whose side chores ("Bitwarden item updated") are not what
  // the ask is about, so it is left out.
  const own = i.code && i.question && i.row ? [i.question] : [i.title, i.question];
  const text = own.filter(Boolean).join(" ").replace(NOT_ABOUT, " ");
  // the red line first, then the objective that owns the item's spine or repo; title words count only when no objective
  // owns where it lives, so a title naming another product does not pull a card away from its own epic's objective.
  // the item's own key result before where it lives: a key result listing its row, card or ask names the objective
  // (a ticket in an epic two objectives share moves the one whose key result lists it).
  const codes = repo ? [i.code, i.row, i.ref].filter((c): c is string => !!c).map((c) => `${repo}:${c}`) : [];
  const found =
    (redLineObjective ? defs.find((d) => d.id === redLineObjective) : undefined) ??
    (codes.length ? defs.find((d) => codes.some((c) => (d.work ?? []).includes(c))) : undefined) ??
    (spine ? defs.find((d) => d.spines.includes(spine)) : undefined) ??
    (repo ? defs.find((d) => d.repos.includes(repo)) : undefined) ??
    (text.trim() ? defs.find((d) => d.match.some((g) => g.every((re) => re.test(text)))) : undefined);
  // a folded copy of a shared objective names the one it is shown inside: its own product, its place in his order
  const d = found?.foldedInto ? (defs.find((x) => x.id === found.foldedInto) ?? found) : found;
  return d ? { n: d.n, id: d.id, name: d.name } : undefined;
}

/** What an inbox item tells about where it lives: its repo (checkout name), spine file, row code and own code. */
export interface Locatable {
  repo?: string;
  path?: string;
  /** Review item: its row code. */
  ref?: string;
  /** Ask: the ledger row it blocks. */
  row?: string;
  /** Ask: its code (``). */
  code?: string;
  /** its words (a card's title, an ask's question): his objectives' words are read in them. */
  title?: string;
  question?: string;
}

export type PriorityLookup = (i: Locatable) => JordiPriority | undefined;

const norm = (s: string) => s.trim().toLowerCase();
const strip = ({ repo: _r, path: _p, ...p }: Entry): JordiPriority => p;

/**
 * A lookup over entries: the item's row first, then its epic by code (an ask written in the root spine, ``, or a
 * row code `` belongs to of the same repo; a number two epics share is no match), then its epic by spine
 * file; never another repo's.
 */
export function lookupOf(entries: Entry[], redLines?: RedLine | RedLine[], pressing: PressingEntry[] = [], objectives: ObjectiveDef[] = []): PriorityLookup {
  const lines = Array.isArray(redLines) ? redLines : redLines ? [redLines] : [];
  const pressed = pressedLookup(entries, lines, pressing);
  if (!objectives.length) return pressed;
  return (i) => {
    const p = pressed(i);
    const o = objectiveOf(objectives, i, p?.redLine ? lines[p.redLine.line ?? 0]?.objective : undefined);
    if (!o) return p;
    // an item only an objective ranks says which, in his objective's words
    return { ...(p ?? { level: "normal" as const, ref: i.ref ?? i.code ?? i.row ?? o.id, why: `It moves your objective ${o.n + 1}: ${o.name}.` }), objective: o };
  };
}

function pressedLookup(entries: Entry[], redLines: RedLine | RedLine[] | undefined, pressing: PressingEntry[]): PriorityLookup {
  const lined = linedLookup(levelLookup(entries), (Array.isArray(redLines) ? redLines : redLines ? [redLines] : []).map((l, n) => lineMatcher(l, n)));
  if (!pressing.length) return lined;
  const hit = pressingMatcher(pressing);
  return (i) => {
    const p = lined(i);
    const repo = i.repo ? norm(i.repo) : undefined;
    const h = repo ? hit(i, repo) : undefined;
    if (!h) return p;
    const { repo: _r, ref, path: _p, ...mark } = h;
    return { ...(p ?? { level: "high" as const, ref, why: mark.why }), pressing: { ...mark, order: pressing.indexOf(h) } };
  };
}

/** a pressing entry is matched like a red-line item: by its own code (row, ask), or an epic's own status item by its file. */
function pressingMatcher(list: PressingEntry[]) {
  const clean = (f?: string) => f?.replace(/^\.?\//, "");
  return (i: Locatable, repo: string): PressingEntry | undefined =>
    list.find((e) => {
      if (norm(e.repo) !== repo) return false;
      if (IS_EPIC.test(e.ref) && e.path) return !i.code && !i.row && !i.ref && clean(i.path) === clean(e.path);
      // a review row is matched in its own spine (a code is unique only there); an ask, by its code or the row it blocks, from any spine
      if (i.ref && norm(i.ref) === norm(e.ref)) return !e.path || !i.path || clean(e.path) === clean(i.path);
      return [i.code, i.row].some((c) => c && norm(c) === norm(e.ref));
    });
}

function linedLookup(base: PriorityLookup, lines: ReturnType<typeof lineMatcher>[]): PriorityLookup {
  if (!lines.length) return base;
  return (i) => {
    const p = base(i);
    const repo = i.repo ? norm(i.repo) : undefined;
    if (!repo) return p;
    // an item on two lines is marked with the first one (the lines keep their order).
    for (const { line, mark, hit: find } of lines) {
      const hit = find(i, repo);
      if (!hit) continue;
      const why = hit.why ?? line.why ?? line.sentence;
      // the marker's why is why the item is on the line (its own `why`), not its level's; the level stays.
      if (p) return { ...p, ...(hit.why ? { why: hit.why, words: undefined, said: undefined, source: undefined } : {}), redLine: mark };
      return { level: "high" as const, ref: hit.ref, why, ...(line.words ? { words: line.words, said: line.said, source: line.source } : {}), redLine: mark };
    }
    return p;
  };
}

/**
 * a red-line item is matched by its own code only (a row, an ask, or an epic by its spine file), never by its
 * epic's number: the line names 3 to 7 things, it must not pull a whole epic's asks to the top. A row code is unique
 * only inside its spine (memory has a `T1` in two epics): an item with a `path` matches only there.
 */
const IS_EPIC = /^EPIC-[\w.]+$/i;

function lineMatcher(redLine: RedLine, n: number) {
  const codes = new Map<string, RedLineItem[]>();
  const epics = new Map<string, RedLineItem>();
  for (const it of redLine.items) {
    const repo = norm(it.repo);
    // an epic is ``; `` is an ask of it (deal-funnels, airbnb-observatory code asks that way).
    if (IS_EPIC.test(it.ref) && it.path) epics.set(`${repo}:${it.path.replace(/^\.?\//, "")}`, it);
    else codes.set(`${repo}#${norm(it.ref)}`, [...(codes.get(`${repo}#${norm(it.ref)}`) ?? []), it]);
  }
  // While the line waits for his yes, the ask that proposes it leads the inbox too: he sees the question first.
  if (redLine.state === "proposed" && redLine.ask && redLine.repo) {
    const k = `${norm(redLine.repo)}#${norm(redLine.ask)}`;
    codes.set(k, [...(codes.get(k) ?? []), { repo: redLine.repo, ref: redLine.ask, why: "Your answer sets the red line: agree, or say it in your words." }]);
  }
  const clean = (f?: string) => f?.replace(/^\.?\//, "");
  const codeHit = (repo: string, code: string, at?: string) => codes.get(`${repo}#${norm(code)}`)?.find((it) => !it.path || clean(it.path) === clean(at));
  const mark: RedLineMark = {
    sentence: redLine.sentence,
    state: redLine.state,
    ...(redLine.ask ? { ask: redLine.ask } : {}),
    ...(redLine.at ? { at: redLine.at.slice(0, 10) } : {}),
    ...(redLine.name ? { name: redLine.name } : {}),
    line: n,
  };
  const hit = (i: Locatable, repo: string): RedLineItem | undefined => {
    let h: RedLineItem | undefined;
    for (const code of [i.code, i.ref, i.row]) if (!h && code) h = codeHit(repo, code, i.path);
    // an epic on the line: the epic's own status item (no row, no ask code) only
    if (!h && !i.code && !i.row && !i.ref && i.path) h = epics.get(`${repo}:${i.path.replace(/^\.?\//, "")}`);
    return h;
  };
  return { line: redLine, mark, hit };
}

function levelLookup(entries: Entry[]): PriorityLookup {
  const rows = new Map<string, Entry>();
  const epics = new Map<string, Entry>();
  const byNumber = new Map<string, Entry | null>();
  for (const e of entries) {
    const repo = norm(e.repo);
    rows.set(`${repo}#${norm(e.ref)}`, e);
    if (e.path) epics.set(`${repo}:${e.path.replace(/^\.?\//, "")}`, e);
    const n = /^EPIC-(\d+)$/i.exec(e.ref)?.[1];
    if (n) {
      const k = `${repo}#e${Number(n)}`;
      byNumber.set(k, byNumber.has(k) && byNumber.get(k)?.path !== e.path ? null : e);
    }
  }
  return (i) => {
    const repo = i.repo ? norm(i.repo) : undefined;
    if (!repo) return undefined;
    for (const code of [i.ref, i.row]) {
      const hit = code ? rows.get(`${repo}#${norm(code)}`) : undefined;
      if (hit) return strip(hit);
    }
    for (const code of [i.code, i.row, i.ref]) {
      const n = code ? /^E(\d+)-[A-Z]/i.exec(code.trim())?.[1] : undefined;
      const hit = n ? byNumber.get(`${repo}#e${Number(n)}`) : undefined;
      if (hit) return strip(hit);
    }
    const epic = i.path ? epics.get(`${repo}:${i.path.replace(/^\.?\//, "")}`) : undefined;
    return epic ? strip(epic) : undefined;
  };
}

const cache = new Map<string, { mtimeMs: number; text: string }>();

/** a file's text, cached by mtime; undefined when it is not there. */
function textOf(f: string): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(f);
  } catch {
    cache.delete(f);
    return undefined;
  }
  const hit = cache.get(f);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
  try {
    const text = fs.readFileSync(f, "utf8");
    cache.set(f, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return undefined;
  }
}

/** a checkout's levels (docs/priorities.json) and red lines (the objectives file when they live there). */
function readFile(dir: string, name: string): { entries: Entry[]; redLines: RedLine[]; pressing: PressingEntry[]; objectives: ObjectiveDef[] } {
  const levels = textOf(path.join(dir, PRIORITIES_FILE));
  const lines = textOf(path.join(dir, redLinesFile(dir)));
  return { entries: levels ? parsePriorities(levels, name) : [], redLines: lines ? parseRedLines(lines, name) : [], pressing: levels ? parsePressing(levels, name) : [], objectives: objectivesIn(dir) };
}

/** a checkout's objectives, parsed again only when either file changes. */
const parsedObjectives = new Map<string, { key: string; defs: ObjectiveDef[] }>();
function objectivesIn(dir: string): ObjectiveDef[] {
  const p = textOf(path.join(dir, OBJECTIVES_FILE));
  if (!p) return [];
  const w = textOf(path.join(dir, HIS_WORDS_FILE));
  // each objective's scorecard: its key results' work lists and its fold
  const cards: Record<string, string | undefined> = {};
  try {
    for (const o of (JSON.parse(p) as { pursuits?: { id?: unknown }[] }).pursuits ?? []) {
      if (typeof o?.id === "string" && /^[\w.-]+$/.test(o.id)) cards[o.id] = textOf(path.join(dir, SCORECARD_DIR, `${o.id}.json`));
    }
  } catch {
    // a broken objectives file parses to none below
  }
  const key = JSON.stringify([p, w, cards]);
  const hit = parsedObjectives.get(dir);
  if (hit && hit.key === key) return hit.defs;
  const defs = parseObjectives(p, w, cards);
  parsedObjectives.set(dir, { key, defs });
  return defs;
}

/** his objectives in the order the inbox follows (GET /api/inbox-first shows them). */
export function worldObjectives(store: Pick<Store, "listMilestones">, reposRoot: string): ObjectiveMark[] {
  return worldFiles(store, reposRoot).objectives.map(({ n, id, name }) => ({ n, id, name }));
}

/** his objectives with what tells an item moves each (its key results' work lists, epics, repos, words). */
export function worldObjectiveDefs(store: Pick<Store, "listMilestones">, reposRoot: string): ObjectiveDef[] {
  return worldFiles(store, reposRoot).objectives;
}

/**
 * Every priority of this world: the `docs/priorities.json` of each checkout its milestones track (a world reads only its
 * own). None written yet: undefined, so the lists keep the milestone order exactly as before.
 */
export function worldPriorities(store: Pick<Store, "listMilestones">, reposRoot: string): PriorityLookup | undefined {
  const { entries, redLines, pressing, objectives } = worldFiles(store, reposRoot);
  return entries.length || redLines.length || pressing.length || objectives.length ? lookupOf(entries, redLines, pressing, objectives) : undefined;
}

/**
 * the world's red line: the first file (in milestone order) that has one. One world, one file: the Prioritizer
 * writes it only into the world's home repo (the code repo for the home world). The first of its lines.
 */
export function worldRedLine(store: Pick<Store, "listMilestones">, reposRoot: string): RedLine | undefined {
  return worldFiles(store, reposRoot).redLines[0];
}

/** every named red line of the world, in order (the first leads): a band each on top of the Team home. */
export function worldRedLines(store: Pick<Store, "listMilestones">, reposRoot: string): RedLine[] {
  return worldFiles(store, reposRoot).redLines;
}

function worldFiles(store: Pick<Store, "listMilestones">, reposRoot: string): { entries: Entry[]; redLines: RedLine[]; pressing: PressingEntry[]; objectives: ObjectiveDef[] } {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const pressing: PressingEntry[] = [];
  let objectives: ObjectiveDef[] = [];
  let redLines: RedLine[] = [];
  for (const m of store.listMilestones({ includeSettled: true })) {
    const r = m.repo ? resolveRepo(reposRoot, m.repo) : undefined;
    if (!r || seen.has(r.path)) continue;
    seen.add(r.path);
    const f = readFile(r.path, r.name);
    entries.push(...f.entries);
    pressing.push(...f.pressing);
    if (!redLines.length) redLines = f.redLines;
    // one world, one objectives file: the first checkout (in milestone order) that has it
    if (!objectives.length) objectives = f.objectives;
  }
  return { entries, redLines, pressing, objectives };
}

/** the lines with their counts read now (each remote source at most once an hour; a failed read says so). */
export async function withCounts(lines: RedLine[], read: (counts: RedLineCount[]) => Promise<RedLineCount[]> = (c) => hooks.counts.read(c)): Promise<RedLine[]> {
  if (!lines.some((l) => l.counts?.length)) return lines;
  return Promise.all(lines.map(async (l) => (l.counts?.length ? { ...l, counts: await read(l.counts) } : l)));
}
