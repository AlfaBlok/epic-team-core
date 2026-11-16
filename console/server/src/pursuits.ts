import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";
import type { GitOut } from "./freshness.js";
import type { Cadence } from "./schemas.js";
import { repoKey } from "./adapters/repoNames.js";
import { productsIn, type ProductRef } from "./products.js";

/**
 * The owner's pursuits: the big goals he wants to see through. `docs/pursuits.json` of the home repo names each one,
 * its "green when" line, its scorecard lines, its totems (deck, social kit, value proposition) and the paths whose
 * commits count as movement; the rest is read here, never typed: a light from the launch board, Done-means boxes
 * ticked in a spine, or a check value a script wrote into the same file. A pursuit is stalled when nothing it watches
 * changed in `staleDays` (claim, lease, desk-note and review-gate commits do not count as movement). The repo is the
 * record; this is a read.
 */
export const PURSUITS_FILE = "docs/pursuits.json";
/** a wheel with no `owner` in the file is owned by the Delivery Manager of the world that holds it. */
export const DEFAULT_OWNER = "Delivery Manager";

export type LineState = "green" | "amber" | "red" | "unknown";

export interface PursuitLine {
  label: string;
  state: LineState;
  /** The number or check behind the colour ("2 of 5", "1 waiting", "not yet"). */
  value: string;
  /** One grey line: where it was read and what turns it green. */
  note?: string;
}
export interface PursuitTotem {
  label: string;
  url?: string;
  /** No url: the totem does not exist yet, and why. */
  missing?: string;
}
export interface PursuitMove {
  /** ISO time of the newest commit that counts as movement. */
  at: string;
  repo: string;
  subject: string;
}
export interface Pursuit {
  id: string;
  name: string;
  greenWhen: string;
  /** The worst line sets the colour. */
  state: LineState;
  greens: number;
  total: number;
  lines: PursuitLine[];
  totems: PursuitTotem[];
  /** moving: something it watches changed in the last `staleDays`; stalled: nothing did; unknown: no history read. */
  motion: "moving" | "stalled" | "unknown";
  lastMove: PursuitMove | null;
  /** the pursuit has a social kit the console shows on its own page (/pursuits/<id>/social-kit). */
  kit?: boolean;
  /** the product it moves (docs/scorecard/products.json): its kit and words are written there once. */
  product?: { id: string; name: string };
  /** its place in the owner's order, 1 first; parked pursuits have none. */
  rank: number | null;
  parked: boolean;
  /** `"pinned": false` in the file: the sidebar shows it folded under More objectives, not in the pinned list. */
  unpinned?: boolean;
  /** what its rank buys: wake pace, worker ceiling, stall watch patience, in plain words too. */
  effort: PursuitEffort;
  /** the epics that carry it (spines), each with its deck code when the spine has one. */
  epics: PursuitEpic[];
  /** the goal's one number, copied from its source file (docs/goals/<name>.json). */
  goal?: PursuitGoal;
  /** the persona that owns the wheel (file `owner`, default the Delivery Manager): the idle watch wakes it. */
  owner?: string;
}
export interface PursuitGoal {
  now: number;
  target: number;
  by?: string;
}
export interface PursuitEpic {
  repo: string;
  path: string;
  /** EPIC-946 etc., read from the spine's first heading; absent = no deck code. */
  code?: string;
  title?: string;
}
/** One effort tier (docs/pursuits.json `effort.tiers`): the ranks up to `upToRank` get it. */
export interface EffortTier {
  name: string;
  upToRank: number;
  /** cadence wakes come this many times as often as set (2 = twice as often, 0.5 = half). */
  wakeFactor: number;
  maxWorkers: number;
  /** the stall watch nudges an idle epic after this many hours. */
  stallHours: number;
}
export interface PursuitEffort {
  tier: string;
  wakeFactor: number;
  maxWorkers: number;
  stallHours: number;
  /** "Wakes twice as often, up to 10 workers, nudged after 1 h idle." / "Parked: no wakes, no workers." */
  words: string;
}
export interface EffortPolicy {
  tiers: EffortTier[];
  minWakeMinutes: number;
  /** a milestone in no pursuit keeps the pace it was set to (words for the page). */
  outside: string;
}
export interface PursuitsBody {
  pursuits: Pursuit[];
  /** the effort rule the ranks follow. */
  effort?: EffortPolicy;
  staleDays: number;
  said?: { source: string; words: string };
  boardAt?: string | null;
  /** the milestones he retired (`retired.milestones` in the file): out of his list of goals, their pages kept. */
  retired?: { repo: string; path: string }[];
}

/** The part of the launch board this reads: each product's lights. */
export interface BoardView {
  checkedAt?: string;
  products: { id: string; greens: number; total: number; lights: { label: string; state: string; fix?: string }[] }[];
}

interface DeclaredLine {
  label: string;
  from: string;
  product?: string;
  light?: string;
  repo?: string;
  spine?: string;
  ids?: string[];
  check?: string;
}
interface Declared {
  id: string;
  name: string;
  greenWhen: string;
  watch: { repo: string; paths: string[] }[];
  lines: DeclaredLine[];
  totems: PursuitTotem[];
  /** its social kit, a folder of the home repo holding kit.json and previews/, and where the full-size files live. */
  kit?: PursuitKitRef;
  /** the product it moves, by id in docs/scorecard/products.json; its kit is the product's. */
  product?: string;
  parked: boolean;
  unpinned: boolean;
  epics: { repo: string; path: string }[];
  goal?: PursuitGoal;
  /** its owner persona: the one the idle watch wakes; default the Delivery Manager of the world holding it. */
  owner: string;
  /** the campaign spine that carries its plan (often another world's repo): the Plan tab reads it there, never a copy. */
  plan?: { repo: string; path: string };
}
export interface PursuitKitRef {
  /** Repo-relative folder: kit.json, previews/*.webp; the fonts sit in its parent's fonts/. */
  dir: string;
  /** Where the full-size files are downloaded (a file store); the console links into it, never sends the owner there to look. */
  files?: string;
}
interface Check {
  state?: string;
  value?: string;
  note?: string;
  at?: string;
}
export interface PursuitsDoc {
  staleDays: number;
  effort: EffortPolicy;
  said?: { source: string; words: string };
  pursuits: Declared[];
  checks: Record<string, Check>;
  retired?: { repo: string; path: string }[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => (str(x) ? [str(x)!] : [])) : []);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const SAFE_URL = /^(https?:\/\/|\/(?!\/))/;

/** The file's pursuits; one with no id, name or green-when line is skipped. Bad JSON: none. */
export function parsePursuits(text: string): PursuitsDoc {
  let doc: Record<string, unknown>;
  try {
    doc = obj(JSON.parse(text));
  } catch {
    return { staleDays: 3, effort: DEFAULT_EFFORT, pursuits: [], checks: {} };
  }
  const staleDays = typeof doc.staleDays === "number" && doc.staleDays > 0 ? doc.staleDays : 3;
  const seen = new Set<string>();
  const pursuits: Declared[] = (Array.isArray(doc.pursuits) ? doc.pursuits : []).flatMap((p) => {
    const o = obj(p);
    const id = str(o.id);
    const name = str(o.name);
    const greenWhen = str(o.greenWhen);
    if (!id || !name || !greenWhen || seen.has(id)) return [];
    seen.add(id);
    const watch = (Array.isArray(o.watch) ? o.watch : []).flatMap((w) => {
      const r = str(obj(w).repo);
      const paths = strs(obj(w).paths).filter((x) => !x.startsWith("-") && !x.includes(".."));
      return r && paths.length ? [{ repo: r, paths }] : [];
    });
    const lines = (Array.isArray(o.lines) ? o.lines : []).flatMap((l): DeclaredLine[] => {
      const x = obj(l);
      const label = str(x.label);
      const from = str(x.from);
      if (!label || !from) return [];
      return [{ label, from, product: str(x.product), light: str(x.light), repo: str(x.repo), spine: str(x.spine), ids: strs(x.ids), check: str(x.check) }];
    });
    const totems = (Array.isArray(o.totems) ? o.totems : []).flatMap((t): PursuitTotem[] => {
      const x = obj(t);
      const label = str(x.label);
      if (!label) return [];
      const url = str(x.url);
      if (url && SAFE_URL.test(url)) return [{ label, url }];
      return [{ label, missing: str(x.missing) ?? "not made yet" }];
    });
    const k = obj(o.kit);
    const dir = str(k.dir);
    const files = str(k.files);
    const kit = dir && /^[\w./-]+$/.test(dir) && !dir.includes("..") && !dir.startsWith("/") ? { dir, ...(files && /^https?:\/\//.test(files) ? { files } : {}) } : undefined;
    const epics = (Array.isArray(o.epics) ? o.epics : []).flatMap((e) => {
      const r = str(obj(e).repo);
      const sp = str(obj(e).spine);
      return r && sp && /^[\w./-]+\.md$/.test(sp) && !sp.includes("..") && !sp.startsWith("/") ? [{ repo: r, path: sp }] : [];
    });
    const g = obj(o.goal);
    const goal = typeof g.now === "number" && typeof g.target === "number" && g.target > 0 ? { now: g.now, target: g.target, ...(str(g.by) ? { by: str(g.by) } : {}) } : undefined;
    const product = str(o.product);
    const pr = str(obj(o.plan).repo);
    const pp = str(obj(o.plan).path);
    const plan = pr && pp && /^[\w./-]+\.md$/.test(pp) && !pp.includes("..") && !pp.startsWith("/") ? { repo: pr, path: pp } : undefined;
    return [{ id, name, greenWhen, watch, lines, totems, ...(plan ? { plan } : {}), ...(kit ? { kit } : {}), ...(product && /^[\w-]+$/.test(product) ? { product } : {}), parked: o.parked === true, unpinned: o.pinned === false, epics, ...(goal ? { goal } : {}), owner: str(o.owner) ?? DEFAULT_OWNER }];
  });
  const said = obj(doc.said);
  // retired milestones: each by its repo and spine, as the epics name theirs.
  const retired = (Array.isArray(obj(doc.retired).milestones) ? (obj(doc.retired).milestones as unknown[]) : []).flatMap((e) => {
    const r = str(obj(e).repo);
    const sp = str(obj(e).spine);
    return r && sp && /^[\w./-]+\.md$/.test(sp) && !sp.includes("..") && !sp.startsWith("/") ? [{ repo: r, path: sp }] : [];
  });
  const checks: Record<string, Check> = {};
  for (const [k, v] of Object.entries(obj(doc.checks))) checks[k] = obj(v) as Check;
  return {
    staleDays,
    effort: parseEffort(doc.effort),
    ...(str(said.source) && str(said.words) ? { said: { source: str(said.source)!, words: str(said.words)! } } : {}),
    pursuits,
    checks,
    ...(retired.length ? { retired } : {}),
  };
}

// ---------- priority and effort ----------

/**
 * Effort follows priority: the file's order is the owner's order (he drags it on the Pursuits page), parked pursuits
 * have no rank. Each rank falls in a tier that sets how often its milestones' teams wake, how many workers they may run
 * at once and how soon the stall watch nudges an idle epic. A parked pursuit gets no cadence wakes, no workers and no
 * nudges; a milestone in no pursuit keeps the pace it was set to. The file is the record (root L-45).
 */
export const DEFAULT_EFFORT: EffortPolicy = {
  tiers: [
    { name: "Top", upToRank: 1, wakeFactor: 2, maxWorkers: 10, stallHours: 1 },
    { name: "High", upToRank: 3, wakeFactor: 1, maxWorkers: 6, stallHours: 2 },
    { name: "Low", upToRank: 99, wakeFactor: 0.5, maxWorkers: 3, stallHours: 6 },
  ],
  minWakeMinutes: 15,
  outside: "A team in no pursuit keeps the pace it was set to, up to 10 workers.",
};

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

export function parseEffort(v: unknown): EffortPolicy {
  const o = obj(v);
  const tiers = (Array.isArray(o.tiers) ? o.tiers : []).flatMap((t): EffortTier[] => {
    const x = obj(t);
    const name = str(x.name);
    const upToRank = num(x.upToRank, 1, 1000);
    const wakeFactor = num(x.wakeFactor, 0.05, 20);
    const maxWorkers = num(x.maxWorkers, 0, 50);
    const stallHours = num(x.stallHours, 0.25, 24 * 7);
    return name && upToRank && wakeFactor && maxWorkers !== undefined && stallHours ? [{ name, upToRank: Math.floor(upToRank), wakeFactor, maxWorkers: Math.floor(maxWorkers), stallHours }] : [];
  });
  return {
    tiers: tiers.length ? tiers.sort((a, b) => a.upToRank - b.upToRank) : DEFAULT_EFFORT.tiers,
    minWakeMinutes: num(o.minWakeMinutes, 1, 24 * 60) ?? DEFAULT_EFFORT.minWakeMinutes,
    outside: str(o.outside) ?? DEFAULT_EFFORT.outside,
  };
}

const PARKED_EFFORT: PursuitEffort = { tier: "Parked", wakeFactor: 0, maxWorkers: 0, stallHours: 0, words: "Parked: no wakes, no workers, no nudges." };

const paceWords = (f: number) =>
  f === 1 ? "Wakes at the pace set" : f === 2 ? "Wakes twice as often" : f > 1 ? `Wakes ${f} times as often` : f === 0.5 ? "Wakes half as often" : `Wakes ${f} times as often`;

/** The effort a rank buys (last tier for ranks past every tier); parked: none. */
export function effortOf(rank: number | null, parked: boolean, policy: EffortPolicy): PursuitEffort {
  if (parked || rank === null) return PARKED_EFFORT;
  const t = policy.tiers.find((x) => rank <= x.upToRank) ?? policy.tiers[policy.tiers.length - 1];
  const hours = t.stallHours === 1 ? "1 h" : `${t.stallHours} h`;
  return {
    tier: t.name,
    wakeFactor: t.wakeFactor,
    maxWorkers: t.maxWorkers,
    stallHours: t.stallHours,
    words: `${paceWords(t.wakeFactor)}, up to ${t.maxWorkers} worker${t.maxWorkers === 1 ? "" : "s"}, nudged after ${hours} idle.`,
  };
}

/** Ranks in file order, parked ones skipped (null). */
export function ranksOf(doc: Pick<PursuitsDoc, "pursuits">): Map<string, number | null> {
  const out = new Map<string, number | null>();
  let n = 0;
  for (const p of doc.pursuits) out.set(p.id, p.parked ? null : ++n);
  return out;
}

/** A cadence scaled by the effort: an interval wakes `wakeFactor` times as often, never under `minWakeMinutes`; a fixed time stays. */
export function scaleCadence(c: Cadence, e: Pick<PursuitEffort, "wakeFactor"> | null | undefined, minWakeMinutes = DEFAULT_EFFORT.minWakeMinutes): Cadence {
  if (!e || c.type !== "interval" || e.wakeFactor <= 0 || e.wakeFactor === 1) return c;
  const every = Math.round(c.everyMinutes / e.wakeFactor);
  const floor = Math.min(minWakeMinutes, c.everyMinutes); // never faster than the floor, never slower because of it
  return { type: "interval", everyMinutes: Math.max(floor, Math.min(60 * 24 * 31, every)) };
}

const sameRepo = (a: string, b: string) => repoKey(a.split("/").pop()!) === repoKey(b.split("/").pop()!);
const plain = (p: string) => p.replace(/^\.\//, "");

/** The effort of the best-ranked pursuit carrying one spine; parked only when every pursuit carrying it is parked. */
export interface SpineEffort extends PursuitEffort {
  pursuitId: string;
  pursuitName: string;
  rank: number | null;
  parked: boolean;
}
export function effortForSpine(doc: PursuitsDoc, repo: string, spinePath: string): SpineEffort | null {
  const ranks = ranksOf(doc);
  let best: SpineEffort | null = null;
  for (const p of doc.pursuits) {
    if (!p.epics.some((e) => sameRepo(e.repo, repo) && plain(e.path) === plain(spinePath))) continue;
    const rank = ranks.get(p.id) ?? null;
    const e: SpineEffort = { ...effortOf(rank, p.parked, doc.effort), pursuitId: p.id, pursuitName: p.name, rank, parked: p.parked };
    if (!best || (best.parked && !e.parked) || (!e.parked && !best.parked && (e.rank ?? 1e9) < (best.rank ?? 1e9))) best = e;
  }
  return best;
}

/** The pursuit epics in one repo, in rank order (parked last), for a wake's priority lines. */
export function epicsInRepo(doc: PursuitsDoc, repo: string): { path: string; effort: SpineEffort }[] {
  const seen = new Set<string>();
  const out: { path: string; effort: SpineEffort }[] = [];
  for (const p of doc.pursuits)
    for (const e of p.epics) {
      if (!sameRepo(e.repo, repo) || seen.has(plain(e.path))) continue;
      seen.add(plain(e.path));
      const eff = effortForSpine(doc, repo, e.path);
      if (eff) out.push({ path: plain(e.path), effort: eff });
    }
  return out.sort((a, b) => (a.effort.rank ?? 1e9) - (b.effort.rank ?? 1e9));
}

/** The wake's priority section: which epics come first, each one's ceiling, parked ones none. Empty: no lines. */
export function priorityLines(doc: PursuitsDoc, repo: string, skip: (path: string) => boolean = () => false): string {
  const list = epicsInRepo(doc, repo).filter((x) => !skip(x.path));
  if (!list.length) return "";
  return [
    "## Priority (the owner's pursuits)",
    "Effort follows his order on the Pursuits page: start ready rows of higher pursuits first, keep each epic within its ceiling, and start nothing in a parked pursuit's epics (say `queued: pursuit parked` for those rows).",
    ...list.map((x) =>
      x.effort.parked
        ? `- ${x.path}: ${x.effort.pursuitName}, parked: no workers.`
        : `- ${x.path}: ${x.effort.pursuitName}, rank ${x.effort.rank} (${x.effort.tier}): at most ${x.effort.maxWorkers} workers at once.`,
    ),
  ].join("\n");
}

/** Rewrites the file's pursuits into `ids` order (every id once, the same set); null when it is not a reorder. */
export function reorderText(text: string, ids: string[]): string | null {
  const doc = obj(JSON.parse(text));
  const list = Array.isArray(doc.pursuits) ? (doc.pursuits as Record<string, unknown>[]) : [];
  const have = list.map((p) => str(obj(p).id) ?? "");
  if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((id) => have.includes(id))) return null;
  doc.pursuits = ids.map((id) => list[have.indexOf(id)]);
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Parks or un-parks one pursuit (`parked: true` or no field); null when no such pursuit. */
export function parkText(text: string, id: string, parked: boolean): string | null {
  const doc = obj(JSON.parse(text));
  const list = Array.isArray(doc.pursuits) ? (doc.pursuits as Record<string, unknown>[]) : [];
  const p = list.find((x) => str(obj(x).id) === id);
  if (!p) return null;
  if (parked) p.parked = true;
  else delete p.parked;
  return JSON.stringify(doc, null, 2) + "\n";
}

/** `# EPIC-946: Social launch` → code and title. */
export function epicHeading(markdown: string): { code?: string; title?: string } {
  const h = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (!h) return {};
  const m = /^(EPIC-\d+[A-Z]?)\s*[:·—-]\s*(.+)$/.exec(h);
  return m ? { code: m[1], title: m[2].trim() } : { title: h };
}

const RANK: Record<LineState, number> = { red: 0, amber: 1, unknown: 2, green: 3 };
/** The worst line sets the colour; unknown lines do not hide a red, and no lines at all is unknown. */
export function worst(lines: PursuitLine[]): LineState {
  if (!lines.length) return "unknown";
  const known = lines.filter((l) => l.state !== "unknown");
  if (!known.length) return "unknown";
  return known.reduce<LineState>((w, l) => (RANK[l.state] < RANK[w] ? l.state : w), "green");
}

/** All done is green, under half is red, the rest amber. */
const share = (n: number, of: number): LineState => (of === 0 ? "unknown" : n === of ? "green" : n * 2 < of ? "red" : "amber");

/** Done-means boxes (`- [x] ID …`) in a spine's `## Done means`; only `ids` when given. */
export function doneMeansOf(markdown: string, ids: string[]): { done: number; total: number; open: string[] } {
  const sec = /^##\s+Done means\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  let done = 0;
  let total = 0;
  const open: string[] = [];
  for (const m of sec.matchAll(/^\s*-\s*\[( |x|X)\]\s*(\S+)/gm)) {
    const id = m[2].replace(/[*`:]/g, "");
    if (ids.length && !ids.includes(id)) continue;
    total++;
    if (m[1].toLowerCase() === "x") done++;
    else open.push(id);
  }
  return { done, total, open };
}

function lightLine(l: DeclaredLine, board: BoardView | null): PursuitLine {
  const p = board?.products.find((x) => x.id === l.product);
  if (!board || !p) return { label: l.label, state: "unknown", value: "not read yet", note: "the launch board has not run yet" };
  if (l.from === "board") {
    return { label: l.label, state: share(p.greens, p.total), value: `${p.greens} of ${p.total} lights`, note: "the launch board, every light a real check" };
  }
  const want = (l.light ?? l.label).toLowerCase();
  const light = p.lights.find((x) => x.label.toLowerCase() === want) ?? p.lights.find((x) => x.label.toLowerCase().startsWith(want));
  if (!light) return { label: l.label, state: "unknown", value: "no such light", note: `not on the launch board: ${l.light ?? l.label}` };
  if (light.state === "green") return { label: l.label, state: "green", value: "yes" };
  if (light.state === "red") return { label: l.label, state: "red", value: "not yet", ...(light.fix ? { note: light.fix } : {}) };
  return { label: l.label, state: "unknown", value: "not checked" };
}

function checkLine(l: DeclaredLine, checks: Record<string, Check>, staleMs: number, now: number): PursuitLine {
  const c = l.check ? checks[l.check] : undefined;
  if (!c || !str(c.value)) return { label: l.label, state: "unknown", value: "not checked yet" };
  const at = c.at ? Date.parse(c.at) : NaN;
  if (!Number.isFinite(at) || now - at > staleMs) return { label: l.label, state: "unknown", value: `${c.value}, checked too long ago`, ...(c.at ? { note: `last checked ${c.at}` } : {}) };
  const state = (["green", "amber", "red"] as const).find((s) => s === c.state) ?? "unknown";
  return { label: l.label, state, value: c.value!, ...(c.note ? { note: c.note } : {}) };
}

/** Commit subjects that are bookkeeping, not progress toward the goal. */
const NOT_MOVEMENT = /^(claim|release|renew|lease|desk note|review gate)\b/i;

/** The newest commit touching any watched path in each repo that is not bookkeeping. */
export async function lastMoveOf(
  watch: { repo: string; paths: string[] }[],
  repoDir: (name: string) => string | undefined,
  git: GitOut,
): Promise<PursuitMove | null> {
  let best: PursuitMove | null = null;
  for (const w of watch) {
    const dir = repoDir(w.repo);
    if (!dir) continue;
    let out = "";
    try {
      out = await git(dir, ["log", "-n", "60", "--format=%ct%x09%s", "--", ...w.paths]);
    } catch {
      continue;
    }
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const subject = line.slice(tab + 1).trim();
      if (NOT_MOVEMENT.test(subject)) continue;
      const at = new Date(Number(line.slice(0, tab)) * 1000).toISOString();
      if (!best || at > best.at) best = { at, repo: w.repo, subject };
      break;
    }
  }
  return best;
}

/** Each pursuit with its lines read, its colour and whether it moved. */
export async function buildPursuits(
  doc: PursuitsDoc,
  o: { board: BoardView | null; spineText: (repo: string, file: string) => string | undefined; repoDir: (name: string) => string | undefined; git: GitOut; now?: number; products?: ProductRef[] },
): Promise<PursuitsBody> {
  const products = new Map((o.products ?? []).map((p) => [p.id, p]));
  const now = o.now ?? Date.now();
  const staleMs = doc.staleDays * 86_400_000;
  const pursuits: Pursuit[] = [];
  const ranks = ranksOf(doc);
  for (const d of doc.pursuits) {
    const lines = d.lines.map((l): PursuitLine => {
      if (l.from === "light" || l.from === "board") return lightLine(l, o.board);
      if (l.from === "check") return checkLine(l, doc.checks, staleMs, now);
      if (l.from === "doneMeans" && l.repo && l.spine) {
        const text = o.spineText(l.repo, l.spine);
        if (text === undefined) return { label: l.label, state: "unknown", value: "spine not found" };
        const dm = doneMeansOf(text, l.ids ?? []);
        if (!dm.total) return { label: l.label, state: "unknown", value: "no such box" };
        return { label: l.label, state: share(dm.done, dm.total), value: `${dm.done} of ${dm.total} done`, ...(dm.open.length ? { note: `open: ${dm.open.join(", ")}` } : {}) };
      }
      return { label: l.label, state: "unknown", value: "unknown kind" };
    });
    const lastMove = await lastMoveOf(d.watch, o.repoDir, o.git);
    const motion = !lastMove ? "unknown" : now - Date.parse(lastMove.at) <= staleMs ? "moving" : "stalled";
    pursuits.push({
      id: d.id,
      name: d.name,
      greenWhen: d.greenWhen,
      state: worst(lines),
      greens: lines.filter((l) => l.state === "green").length,
      total: lines.length,
      lines,
      totems: d.totems,
      motion,
      lastMove,
      ...(d.kit || (d.product && products.get(d.product)?.kit) ? { kit: true } : {}),
      ...(d.product && products.get(d.product) ? { product: { id: d.product, name: products.get(d.product)!.name } } : {}),
      ...(d.goal ? { goal: d.goal } : {}),
      owner: d.owner,
      rank: ranks.get(d.id) ?? null,
      parked: d.parked,
      ...(d.unpinned ? { unpinned: true } : {}),
      effort: effortOf(ranks.get(d.id) ?? null, d.parked, doc.effort),
      epics: d.epics.map((e) => {
        const text = o.spineText(e.repo, e.path);
        return { repo: e.repo, path: e.path, ...(text ? epicHeading(text) : {}) };
      }),
    });
  }
  // parked pursuits sit after the ranked ones, in file order.
  pursuits.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return { pursuits, effort: doc.effort, staleDays: doc.staleDays, ...(doc.said ? { said: doc.said } : {}), boardAt: o.board?.checkedAt ?? null, ...(doc.retired?.length ? { retired: doc.retired } : {}) };
}

/** Reads the home repo's file and every spine it names; kept a few minutes (git log per watched repo). */
export function createPursuits(o: { reposRoot: string; board: () => BoardView | null; git: GitOut; ttlMs?: number; home?: string }) {
  const ttl = o.ttlMs ?? 5 * 60_000;
  let cached: { at: number; body: PursuitsBody } | null = null;
  let docCache: { file: string; mtime: number; doc: PursuitsDoc } | null = null;
  const repoDir = (name: string) => resolveRepo(o.reposRoot, name)?.path;
  const spineText = (repo: string, file: string) => {
    const dir = repoDir(repo);
    if (!dir || file.includes("..")) return undefined;
    try {
      return fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    async get(now = Date.now()): Promise<PursuitsBody> {
      if (cached && now - cached.at < ttl && now >= cached.at) return cached.body;
      const home = repoDir(o.home ?? homeRepo());
      let text = "";
      try {
        if (home) text = fs.readFileSync(path.join(home, PURSUITS_FILE), "utf8");
      } catch {
        /* no pursuits file: none */
      }
      const body = text ? await buildPursuits(parsePursuits(text), { board: o.board(), spineText, repoDir, git: o.git, now, products: home ? productsIn(home) : [] }) : { pursuits: [], staleDays: 3 };
      cached = { at: now, body };
      return body;
    },
    clear() {
      cached = null;
      docCache = null;
    },
    /** The parsed file, re-read when it changes (the scheduler asks every minute; one stat per call). Null: no file. */
    doc(): PursuitsDoc | null {
      const home = repoDir(o.home ?? homeRepo());
      if (!home) return null;
      const file = path.join(home, PURSUITS_FILE);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        return null;
      }
      if (docCache?.file === file && docCache.mtime === mtime) return docCache.doc;
      try {
        docCache = { file, mtime, doc: parsePursuits(fs.readFileSync(file, "utf8")) };
      } catch {
        return null;
      }
      return docCache.doc;
    },
    /** The home repo checkout (where the file is written). */
    homeDir: () => repoDir(o.home ?? homeRepo()),
    /** one pursuit's social kit (its kit.json) for the console's Social kit tab, its product's when it names one; null when it has none. */
    kit(id: string): PursuitKitBody | null {
      const ref = kitRef(id);
      if (!ref) return null;
      const kit = readKit(ref.root, ref.kit);
      return kit ? { pursuit: { id, name: ref.name }, ...(ref.product ? { product: ref.product } : {}), kit, ...(ref.kit.files ? { files: ref.kit.files } : {}) } : null;
    },
    /** A kit's preview (previews/<name>.webp) or font (../fonts/<name>.woff2), by a plain file name only. */
    kitFile(id: string, kind: "previews" | "fonts", name: string): { body: Buffer; type: string } | null {
      const ref = kitRef(id);
      return ref ? readKitFile(ref.root, ref.kit, kind, name) : null;
    },
  };
  function kitRef(id: string): { root: string; name: string; kit: PursuitKitRef; product?: { id: string; name: string } } | null {
    const home = repoDir(o.home ?? homeRepo());
    if (!home) return null;
    let text = "";
    try {
      text = fs.readFileSync(path.join(home, PURSUITS_FILE), "utf8");
    } catch {
      return null;
    }
    const d = parsePursuits(text).pursuits.find((p) => p.id === id);
    if (!d) return null;
    // the product's kit, written once, wins over a kit the wheel still names itself.
    const prod = d.product ? productsIn(home).find((p) => p.id === d.product) : undefined;
    if (prod?.kit) return { root: home, name: d.name, kit: prod.kit, product: { id: prod.id, name: prod.name } };
    return d.kit ? { root: home, name: d.name, kit: d.kit } : null;
  }
}

/** A kit's kit.json, read from the home repo; null when missing or bad. */
export function readKit(root: string, ref: PursuitKitRef): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(fs.readFileSync(path.join(root, ref.dir, "kit.json"), "utf8")));
  } catch {
    return null;
  }
}

/** A kit's preview (previews/<name>.webp) or font (../fonts/<name>.woff2), by a plain file name only. */
export function readKitFile(root: string, ref: PursuitKitRef, kind: "previews" | "fonts", name: string): { body: Buffer; type: string } | null {
  const ext = kind === "previews" ? "webp" : "woff2";
  if (!new RegExp(`^[a-z0-9][a-z0-9-]*\\.${ext}$`).test(name)) return null;
  const rel = kind === "previews" ? path.posix.join(ref.dir, "previews", name) : path.posix.join(path.posix.dirname(ref.dir), "fonts", name);
  const type = kind === "previews" ? "image/webp" : "font/woff2";
  try {
    return { body: fs.readFileSync(path.join(root, rel)), type };
  } catch {
    /* not on disk: a checkout without media (sparse) still holds the file in git */
  }
  try {
    return { body: execFileSync("git", ["-C", root, "show", `HEAD:${rel}`], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }), type };
  } catch {
    return null;
  }
}

/** GET /api/pursuits/<id>/kit: the kit as its kit.json holds it, the pursuit it belongs to, and the full-size file store. */
export interface PursuitKitBody {
  pursuit: { id: string; name: string };
  /** the product the kit belongs to, when the wheel names one (the kit is written once, on the product). */
  product?: { id: string; name: string };
  kit: Record<string, unknown>;
  files?: string;
}
