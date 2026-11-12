import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import type { Milestone, Run, Store } from "../store.js";
import { parseDoc } from "../adapters/doc.js";
import type { Tree, TreeNode } from "../adapters/tree.js";
import { parseAsks } from "../inbox/asks.js";
import { ownerName } from "../identity.js";

/**
 * "what changed since your last message". Every message the owner sends in a milestone chat goes to the repo desk with a
 * short block before it: commits in the milestone's repo (its subtree's spines and pages, or the whole repo for a root
 * milestone), runs of the milestone, asks opened/answered in its spines or the console, ledger rows whose Status changed.
 * All of it is diffed against the previous message's time (first message: the thread's start, at most SINCE_MAX_AGE_MS back).
 * Nothing new → no block. Cheap: one `git log`, one `git rev-list`, one `git show` per subtree spine, the console's tree and DB.
 * The chat view and every reader of the owner's words (stamps, ask answers) strip the block again (`splitSince`).
 */
export const SINCE_MARKER = "[since your last message]";
export const SINCE_END = "[/since]";
export const SINCE_MAX_CHARS = 1_500;
export const SINCE_MAX_AGE_MS = 7 * 24 * 3_600_000;
const CAP = { commits: 8, runs: 6, asks: 6, rows: 8 };
const MAX_SPINES = 40;

export type Git = (repoDir: string, args: string[]) => Promise<string>;
export const git: Git = (repoDir, args) =>
  new Promise((resolve, reject) =>
    execFile("git", ["-C", repoDir, ...args], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

const BLOCK = /^\[since your last message\]\n[\s\S]*?\n\[\/since\]\n/;
/** the owner's own words and the block before them (the block is console context, never his). */
export function splitSince(text: string): { text: string; since?: string } {
  const b = BLOCK.exec(text);
  if (!b) return { text };
  return { text: text.slice(b[0].length), since: b[0].slice(SINCE_MARKER.length + 1, -(SINCE_END.length + 2)) };
}

/** No keys in the block: anything that looks like a token or a long secret is masked. */
export const maskSecrets = (s: string) =>
  s
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp]|AKIA|glpat)[-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\b(?=[A-Za-z0-9+/_]*\d)(?=[A-Za-z0-9+/_]*[A-Za-z])[A-Za-z0-9+/_]{32,}={0,2}/g, (w) => (/^[0-9a-f]{40}$/.test(w) ? w : "[redacted]"))
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]");

const oneLine = (s: string | undefined, max = 110) => {
  const t = maskSecrets((s ?? "").split("\n")[0].replace(/\s+/g, " ").trim());
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

interface Section {
  title: string;
  lines: string[];
  shown: number;
}
const section = (title: string, lines: string[], cap: number): Section => ({ title, lines, shown: Math.min(cap, lines.length) });
const render = (x: Section): string[] =>
  x.lines.length
    ? [`${x.title} (${x.lines.length}):`, ...x.lines.slice(0, x.shown), ...(x.lines.length > x.shown ? [`  … ${x.lines.length - x.shown} more`] : [])]
    : [];

export interface SinceDeps {
  db: DB;
  store: Pick<Store, "listRuns" | "getPersona" | "listNeedsJordi">;
  /** The milestone's checkout and its spine path inside it. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string }>;
  /** The console's tree of the milestone (spine and ticket paths of its subtree). */
  tree?: (m: Milestone) => Promise<Tree | undefined>;
  git?: Git;
  now?: () => number;
}

/** Repo-relative `.md` paths of the subtree (spines first), only files present in the checkout. */
function subtreePaths(repoDir: string, rel: string, tree?: Tree): { spines: string[]; pages: string[] } {
  const repo = path.basename(repoDir);
  const norm = (p?: string) => {
    if (!p) return undefined;
    let r = p.replace(/^\.\//, "").split("#")[0];
    if (path.isAbsolute(r)) r = path.relative(repoDir, r);
    else if (r.startsWith(`${repo}/`) && !fs.existsSync(path.join(repoDir, r))) r = r.slice(repo.length + 1);
    r = r.split(path.sep).join("/");
    return r.endsWith(".md") && !r.startsWith("..") && fs.existsSync(path.join(repoDir, r)) ? r : undefined;
  };
  const spines = new Set<string>([rel]);
  const pages = new Set<string>();
  const walk = (n: TreeNode) => {
    const p = norm(n.path);
    if (p) (n.kind === "spine" ? spines : pages).add(p);
    n.children.forEach(walk);
  };
  if (tree) walk(tree.root);
  return { spines: [...spines].slice(0, MAX_SPINES), pages: [...pages].filter((p) => !spines.has(p)) };
}

/** Ids of the subtree (spine ids like → also E19-; ledger rows), to recognise its commits by subject. */
function subtreeIds(tree?: Tree): RegExp | undefined {
  const ids = new Set<string>();
  const walk = (n: TreeNode) => {
    if (n.kind !== "dod" && /^[A-Z][A-Z0-9]*-\d+[A-Z0-9-]*$/.test(n.id)) ids.add(n.id);
    // spines.py ids are slugs: the epic number comes from the id or the file name (`epic-19-….md` →, E19-…).
    const epic = n.kind === "spine" ? (/^EPIC-(\d+)$/.exec(n.id) ?? /^epic-(\d+)\b/i.exec(path.basename(n.path ?? ""))) : null;
    if (epic) ids.add(`EPIC-${epic[1]}`).add(`E${epic[1]}-`);
    n.children.forEach(walk);
  };
  if (tree) walk(tree.root);
  if (!ids.size) return undefined;
  const esc = [...ids].map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (i.endsWith("-") ? "" : "(?![\\w-]*\\d)"));
  return new RegExp(`(?<![A-Za-z0-9])(?:${esc.join("|")})`);
}

/** The milestone is its repo's root spine (no `Parent spine:` or `Parent spine: none`, or no spine to tell): every commit counts. */
const isRepoRoot = (repoDir: string, rel: string) => {
  try {
    const parent = /^\s*Parent spine:\s*(.*)$/im.exec(fs.readFileSync(path.join(repoDir, rel), "utf8"))?.[1];
    return !parent || /^[`*_]*(none|n\/a|-|—)?[`*_.]*\s*$/i.test(parent.trim());
  } catch {
    return true;
  }
};

async function commitLines(g: Git, repoDir: string, rel: string, sinceIso: string, tree?: Tree): Promise<string[]> {
  const out = await g(repoDir, ["log", "--no-merges", `--since=${sinceIso}`, "-n", "200", "--name-only", "--format=%x1e%h%x1f%s", "HEAD"]).catch(() => "");
  const commits = out
    .split("\x1e")
    .filter((r) => r.includes("\x1f"))
    .map((r) => {
      const [head, ...files] = r.split("\n");
      const [sha, subject] = head.split("\x1f");
      return { sha, subject: subject ?? "", files: files.map((f) => f.trim()).filter(Boolean) };
    });
  let keep = commits;
  if (!isRepoRoot(repoDir, rel)) {
    const { spines, pages } = subtreePaths(repoDir, rel, tree);
    const paths = new Set([...spines, ...pages]);
    const ids = subtreeIds(tree);
    keep = commits.filter((c) => c.files.some((f) => paths.has(f)) || (ids?.test(c.subject) ?? false));
  }
  return keep.map((c) => `- ${c.sha} ${oneLine(c.subject)}`);
}

const PERSONA_FALLBACK = "a persona";
function runLines(d: SinceDeps, m: Milestone, since: number): string[] {
  const after = (iso?: string) => !!iso && Date.parse(iso) > since;
  const runs = d.store
    .listRuns({ milestoneId: m.id, limit: 200 })
    .filter((r) => r.kind !== "toggle" && (after(r.startedAt) || after(r.endedAt)))
    .reverse();
  const name = (r: Run) => (r.personaId ? d.store.getPersona(r.personaId)?.name : undefined) ?? PERSONA_FALLBACK;
  return runs.map((r) => {
    const what = r.parentRunId ? "worker" : r.kind === "answer_run" ? "answer" : "wake";
    const summary = oneLine(r.summary, 90);
    return `- ${name(r)} ${what}: ${r.outcome}${summary ? `: ${summary}` : ""}`;
  });
}

const readAt = async (g: Git, repoDir: string, base: string | undefined, rel: string) =>
  base ? g(repoDir, ["show", `${base}:${rel}`]).catch(() => "") : "";

async function spineDiff(g: Git, repoDir: string, rel: string, sinceIso: string, tree?: Tree) {
  const base = (await g(repoDir, ["rev-list", "-1", `--before=${sinceIso}`, "HEAD"]).catch(() => "")).trim() || undefined;
  const { spines } = subtreePaths(repoDir, rel, tree);
  const asks: string[] = [];
  const rows: string[] = [];
  for (const p of spines) {
    const now = (() => {
      try {
        return fs.readFileSync(path.join(repoDir, p), "utf8");
      } catch {
        return "";
      }
    })();
    const then = await readAt(g, repoDir, base, p);
    if (now === then) continue;
    const key = (a: { code: string | null; question: string }) => a.code ?? a.question.slice(0, 80);
    const before = new Map(parseAsks(then, p).map((a) => [key(a), a]));
    for (const a of parseAsks(now, p)) {
      const was = before.get(key(a));
      const label = `${a.code ? `${a.code} ` : ""}${oneLine(a.question, 90)}`;
      if (a.state === "open" && was?.state !== "open") asks.push(`- opened: ${label}`);
      else if (a.state === "answered" && was?.state === "open") asks.push(`- answered: ${label}`);
    }
    const old = new Map(parseDoc(then).ledger.map((r) => [r.id, r.status?.trim() ?? ""]));
    for (const r of parseDoc(now).ledger) {
      const st = r.status?.trim() ?? "";
      const was = old.get(r.id);
      if (was === st) continue;
      rows.push(`- ${r.id}${r.title ? ` ${oneLine(r.title, 60)}` : ""}: ${was === undefined ? "new" : oneLine(was, 30) || "—"} → ${oneLine(st, 30) || "—"}`);
    }
  }
  return { asks, rows };
}

/** Answers the owner gave in the console and Needs the owner rows opened, since then (the spine lines may not be written yet). */
function consoleAskLines(d: SinceDeps, m: Milestone, sinceIso: string): { codes: Set<string>; lines: string[] } {
  const codes = new Set<string>();
  const lines: string[] = [];
  const answered = d.db
    .prepare("SELECT item, kind, created_at FROM jordi_responses WHERE milestone_id = ? AND created_at > ? AND replaces_id IS NULL ORDER BY created_at")
    .all(m.id, sinceIso) as { item: string; kind: string }[];
  for (const r of answered) {
    let item: { code?: string; question?: string } = {};
    try {
      item = JSON.parse(r.item);
    } catch {
      /* unreadable item: still one line */
    }
    if (item.code) codes.add(item.code);
    lines.push(`- answered in the console (${r.kind}): ${item.code ? `${item.code} ` : ""}${oneLine(item.question, 90)}`);
  }
  // the raise log (ops): asks raised through the API, each a coded line in its spine (`<repo>/<code>`).
  for (const n of d.store.listNeedsJordi({ milestoneId: m.id }))
    if (n.createdAt > sinceIso) lines.push(`- ask raised through the API${n.supersededBy && n.supersededBy !== "moot" ? ` (${n.supersededBy.split("/").pop()})` : ""}: ${oneLine(n.question, 90)}`);
  return { codes, lines };
}

/** The block for a message sent now, given the previous message's time; undefined when nothing changed. */
export async function sinceBlock(d: SinceDeps, m: Milestone, sinceIso: string): Promise<string | undefined> {
  const g = d.git ?? git;
  const nowMs = (d.now ?? Date.now)();
  const since = Math.max(Date.parse(sinceIso) || 0, nowMs - SINCE_MAX_AGE_MS);
  const iso = new Date(since).toISOString();
  const { repoDir, rel } = await d.locate(m).catch(() => ({}) as { repoDir?: string; rel?: string });
  const tree = repoDir && rel ? await d.tree?.(m).catch(() => undefined) : undefined;
  const [commits, diff] = repoDir && rel ? await Promise.all([commitLines(g, repoDir, rel, iso, tree), spineDiff(g, repoDir, rel, iso, tree)]) : [[], { asks: [], rows: [] }];
  const fromConsole = consoleAskLines(d, m, iso);
  // A spine answer the console already reported is one ask, not two.
  const spineAsks = diff.asks.filter((l) => ![...fromConsole.codes].some((c) => l.startsWith(`- answered: ${c} `)));
  const sections = [
    section("Commits", commits, CAP.commits),
    section("Runs", runLines(d, m, since), CAP.runs),
    section("Asks", [...fromConsole.lines, ...spineAsks], CAP.asks),
    section("Ledger rows", diff.rows, CAP.rows),
  ].filter((x) => x.lines.length);
  if (!sections.length) return undefined;
  const head = `${SINCE_MARKER}\nSince ${iso.slice(0, 16).replace("T", " ")}Z (console context, not ${ownerName()}'s words):`;
  // Over the cap: every section keeps its title and count; the one showing the most lines gives one up, until it fits.
  const text = () => [head, ...sections.flatMap(render), SINCE_END].join("\n");
  while (text().length > SINCE_MAX_CHARS) {
    const widest = sections.reduce((a, b) => (b.shown > a.shown ? b : a));
    if (widest.shown === 0) break;
    widest.shown--;
  }
  const body = sections.flatMap(render);
  return [head, ...body, SINCE_END].join("\n");
}
