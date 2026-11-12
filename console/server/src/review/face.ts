import fs from "node:fs";
import path from "node:path";
import { inside } from "../adapters/doc.js";
import { field, stripInline } from "../adapters/markdown.js";
import { parseCard, plainProblem, type CardFields, type CardFrom, type DeliveredLine, type NextStep } from "./card.js";

/**
 * what the card face shows, read from the repo only (L-45): the card file's fields, the project name (root spine,
 * once per repo; an epic may name its own), the epic's goal sentence (once per epic), the plain task names and the ledger
 * around the row ("Where it sits in the tree"). Nothing is judged at render time.
 */

export interface TreeLine {
  mark: "done" | "progress" | "this" | "next";
  text: string;
  /** "waiting for your check", "in progress", … */
  sub?: string;
}

export interface CardFace {
  project: { name: string; url?: string };
  /** The epic's goal sentence; `code` + the row's milestone make its Epic Book link (/book/<milestone>#<code>). */
  goal: { text: string; code: string };
  /** Tasks of the epic done, of all (superseded ones left out). */
  tasks: { done: number; total: number };
  title: string;
  taskGoal: string;
  delivered: DeliveredLine[];
  evidence: { url: string; label: string };
  /** Repo-relative path of the screenshot (served by GET /api/review-items/<id>/screenshot). */
  screenshot?: string;
  tree: TreeLine[];
  /** What the team does next once it is marked complete (sub-line of the button). */
  after?: string;
  next: NextStep[];
  /** Case C: the last open piece of the goal (an explicit `completes:` only). */
  closesGoal: boolean;
  /** For case C's confirm: what else is open in the goal (plain name when there is one). */
  openInGoal: { ref: string; name?: string }[];
  /** the persona that sent the card on its own, and where it lives. */
  from?: CardFrom;
}

/** a goal a follow-up names (`in:` or a spine file), found in the repo's docs/spines. */
export interface TargetGoal {
  code: string;
  /** Repo-relative spine file. */
  rel: string;
  /** Plain name: the goal sentence, else the title without its code. */
  name: string;
}

/** Every goal in `<repo>/docs/spines` by its code (``) and its file name, read once per call. */
export function targetGoals(repoDir: string): Map<string, TargetGoal> {
  const out = new Map<string, TargetGoal>();
  const dir = path.join(repoDir, "docs", "spines");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of names) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 4000);
    } catch {
      continue;
    }
    const h = /^#\s+(EPIC-\d+)\s*:\s*(.+)$/m.exec(text);
    if (!h) continue;
    const g: TargetGoal = { code: h[1], rel: `docs/spines/${f}`, name: (goalSentenceOf(text) ?? stripInline(h[2])).replace(/\.$/, "") };
    if (!out.has(h[1])) out.set(h[1], g);
    out.set(f, g);
    out.set(g.rel, g);
  }
  return out;
}

// ---------- once per repo / once per epic ----------

/** `Project name: [the memory service, the memory app](https://memory.dev/)` (or plain words, with an optional `Project link:`). */
export function projectOf(text: string): { name: string; url?: string } | undefined {
  const v = field(text, "Project name");
  if (!v) return undefined;
  const l = /^\s*\[([^\]]+)\]\(([^)\s]+)\)/.exec(v);
  if (l) return { name: l[1].trim(), url: l[2] };
  const link = field(text, "Project link");
  const url = link ? (/\(([^)\s]+)\)/.exec(link)?.[1] ?? /https?:\/\/\S+/.exec(link)?.[0]) : undefined;
  return { name: stripInline(v), ...(url ? { url } : {}) };
}

/** `Goal sentence: Get the memory service into every AI tool directory.` */
export const goalSentenceOf = (text: string) => {
  const v = field(text, "Goal sentence");
  return v ? stripInline(v).trim() : undefined;
};

/** `## Plain names`: `- E10-R1: The plan was made.` one plain name per row, for the tree. */
export function plainNamesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let on = false;
  for (const l of text.split("\n")) {
    if (/^#{1,6}\s/.test(l)) on = /^#{1,6}\s+plain names\b/i.test(l);
    if (!on) continue;
    const m = /^\s*[-*]\s+\**([A-Za-z][\w-]*\d[\w]*)\**\s*(?::|—|–|-)\s+(.+?)\s*$/.exec(l);
    if (m && !out.has(m[1])) out.set(m[1], stripInline(m[2]));
  }
  return out;
}

// ---------- card files ----------

export interface CardFile {
  /** Repo-relative path of the card file. */
  rel: string;
  fields: CardFields;
}

const cardCache = new Map<string, { stamp: string; card?: CardFields }>();

/** One markdown file's card fields (cached by mtime and size). */
export function readCardFile(abs: string): CardFields | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    cardCache.delete(abs);
    return undefined;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cardCache.get(abs);
  if (hit?.stamp === stamp) return hit.card;
  let card: CardFields | undefined;
  try {
    card = parseCard(fs.readFileSync(abs, "utf8"));
  } catch {
    card = undefined;
  }
  cardCache.set(abs, { stamp, card });
  return card;
}

/** Every card file of a repo: `docs/cards/*.md` (one per row). */
export function repoCards(repoDir: string): CardFile[] {
  const dir = path.join(repoDir, "docs", "cards");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: CardFile[] = [];
  for (const f of names) {
    const fields = readCardFile(path.join(dir, f));
    if (fields) out.push({ rel: `docs/cards/${f}`, fields: fields.row ? fields : { ...fields, row: f.replace(/\.md$/, "") } });
  }
  return out;
}

const MD_TARGET = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

/**
 * The card of row `ref` in spine `spineRel`: a page the row links (any cell) whose front matter names the row, else
 * `docs/cards/<file>.md` naming it (its `spine:` must match when it has one).
 */
export function cardFor(repoDir: string, spineRel: string, ref: string, cells: string[], cards: CardFile[]): CardFile | undefined {
  for (const c of cells)
    for (const m of c.matchAll(MD_TARGET)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(spineRel), m[1]));
      const abs = inside(repoDir, rel);
      const f = abs && !rel.startsWith("..") ? readCardFile(abs) : undefined;
      if (f?.row === ref) return { rel, fields: f };
    }
  const base = path.posix.basename(spineRel);
  const named = cards.filter((c) => c.fields.row === ref);
  return named.find((c) => c.fields.spine && path.posix.basename(c.fields.spine) === base) ?? named.find((c) => !c.fields.spine);
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** The screenshot's repo-relative path when the file is in the repo: relative to the card file, the repo, or docs/status. */
export function screenshotPath(repoDir: string, cardRel: string, shot: string | undefined): string | undefined {
  if (!shot || !IMAGE.test(shot) || /^[a-z]+:/i.test(shot)) return undefined;
  const tries = [path.posix.join(path.posix.dirname(cardRel), shot), shot.replace(/^\/+/, ""), path.posix.join("docs/status", shot)];
  for (const t of tries) {
    const rel = path.posix.normalize(t);
    if (rel.startsWith("..")) continue;
    const abs = inside(repoDir, rel);
    try {
      if (abs && fs.statSync(abs).isFile()) return rel;
    } catch {
      /* next */
    }
  }
  return undefined;
}

// ---------- the tree ----------

export interface Sibling {
  ref: string;
  status: string;
  name?: string;
}

type Kind = "done" | "progress" | "next" | "gone";
const kindOf = (status: string): { kind: Kind; sub?: string } => {
  const s = stripInline(status).toLowerCase();
  if (/^(superseded|cancell?ed|moved|dropped)\b/.test(s)) return { kind: "gone" };
  if (/^done\b/.test(s)) return { kind: "done" };
  if (/^review\b/.test(s)) return { kind: "progress", sub: "waiting for your check" };
  if (/^blocked\b/.test(s)) return { kind: "progress", sub: "waiting on an answer" };
  if (/^(active|running|dispatched|in[ -]progress|testing|monitoring)\b/.test(s)) return { kind: "progress", sub: "in progress" };
  return { kind: "next" };
};

/** A name fit for the card (plain, short), else undefined. */
export const plainName = (n: string | undefined) => (n && !plainProblem("name", n, 16) ? n.replace(/\s+/g, " ").trim() : undefined);

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Tasks done of all, and the tree around row `ref`: done, in progress, this task, next (at most 4 lines). */
export function treeOf(siblings: Sibling[], ref: string, thisName: string): { tasks: { done: number; total: number }; lines: TreeLine[] } {
  const live = siblings.map((s) => ({ ...s, ...kindOf(s.status) })).filter((s) => s.kind !== "gone");
  const others = live.filter((s) => s.ref !== ref);
  const done = others.filter((s) => s.kind === "done");
  const progress = others.filter((s) => s.kind === "progress");
  const next = others.filter((s) => s.kind === "next");
  const lines: TreeLine[] = [];
  if (done.length) {
    const named = done.length === 1 ? plainName(done[0].name) : undefined;
    lines.push({ mark: "done", text: named ?? `${done.length} earlier ${plural(done.length, "task is", "tasks are")} done.` });
  }
  if (progress.length) {
    const first = progress.find((s) => plainName(s.name));
    const more = progress.length - (first ? 1 : 0);
    if (first) lines.push({ mark: "progress", text: plainName(first.name)!, sub: [first.sub, more ? `${more} more in progress` : ""].filter(Boolean).join(" · ") });
    else lines.push({ mark: "progress", text: `${progress.length} other ${plural(progress.length, "task is", "tasks are")} in progress or waiting for your check` });
  }
  lines.push({ mark: "this", text: `This task: ${thisName}` });
  if (next.length) {
    const first = next.find((s) => plainName(s.name));
    const more = next.length - (first ? 1 : 0);
    lines.push({ mark: "next", text: first ? `Next: ${plainName(first.name)}${more ? `, then ${more} more` : ""}` : `${next.length} more ${plural(next.length, "task is", "tasks are")} planned` });
  }
  return { tasks: { done: done.length, total: live.length }, lines };
}

export const isDoneStatus = (s: string) => kindOf(s).kind === "done";
export const isGoneStatus = (s: string) => kindOf(s).kind === "gone";
