import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";
import type { GitOut } from "./freshness.js";

/**
 * The owner's pursuits: the big goals he wants to see through. `docs/pursuits.json` of the home repo names each one,
 * its "green when" line, its scorecard lines, its totems (deck, social kit, value proposition) and the paths whose
 * commits count as movement; the rest is read here, never typed: a light from the launch board, Done-means boxes
 * ticked in a spine, or a check value a script wrote into the same file. A pursuit is stalled when nothing it watches
 * changed in `staleDays` (claim, lease, desk-note and review-gate commits do not count as movement). The repo is the
 * record; this is a read.
 */
export const PURSUITS_FILE = "docs/pursuits.json";

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
}
export interface PursuitsBody {
  pursuits: Pursuit[];
  staleDays: number;
  said?: { source: string; words: string };
  boardAt?: string | null;
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
}
interface Check {
  state?: string;
  value?: string;
  note?: string;
  at?: string;
}
export interface PursuitsDoc {
  staleDays: number;
  said?: { source: string; words: string };
  pursuits: Declared[];
  checks: Record<string, Check>;
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
    return { staleDays: 3, pursuits: [], checks: {} };
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
    return [{ id, name, greenWhen, watch, lines, totems }];
  });
  const said = obj(doc.said);
  const checks: Record<string, Check> = {};
  for (const [k, v] of Object.entries(obj(doc.checks))) checks[k] = obj(v) as Check;
  return {
    staleDays,
    ...(str(said.source) && str(said.words) ? { said: { source: str(said.source)!, words: str(said.words)! } } : {}),
    pursuits,
    checks,
  };
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
  o: { board: BoardView | null; spineText: (repo: string, file: string) => string | undefined; repoDir: (name: string) => string | undefined; git: GitOut; now?: number },
): Promise<PursuitsBody> {
  const now = o.now ?? Date.now();
  const staleMs = doc.staleDays * 86_400_000;
  const pursuits: Pursuit[] = [];
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
    });
  }
  return { pursuits, staleDays: doc.staleDays, ...(doc.said ? { said: doc.said } : {}), boardAt: o.board?.checkedAt ?? null };
}

/** Reads the home repo's file and every spine it names; kept a few minutes (git log per watched repo). */
export function createPursuits(o: { reposRoot: string; board: () => BoardView | null; git: GitOut; ttlMs?: number; home?: string }) {
  const ttl = o.ttlMs ?? 5 * 60_000;
  let cached: { at: number; body: PursuitsBody } | null = null;
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
      const body = text ? await buildPursuits(parsePursuits(text), { board: o.board(), spineText, repoDir, git: o.git, now }) : { pursuits: [], staleDays: 3 };
      cached = { at: now, body };
      return body;
    },
    clear() {
      cached = null;
    },
  };
}
