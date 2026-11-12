import fs from "node:fs";
import path from "node:path";
import { readDoc, inside } from "./doc.js";
import { repoKey } from "./repoNames.js";

export interface Repo {
  name: string;
  path: string;
  /** `owner/name` when origin is on GitHub. */
  remote?: string;
  hasEpicSpine: boolean;
}

export interface DocItem {
  path: string;
  kind: "spine" | "ticket";
  title: string;
  status?: string;
  dod: { done: number; total: number };
  /** "spines" = listed by EpicSpine `spines.py --json`; "fallback" = path rules (spines.py missing or failed). */
  via?: "spines" | "fallback";
  /** spines.py tree nodes: depth below the root (0 = root), parent path, spine type, and the aggregate status when it differs. */
  depth?: number;
  parent?: string | null;
  type?: string;
  rollupStatus?: string;
  /** Goal doc outside the tree: spines.py's reason (e.g. "not reachable from the root"). */
  orphan?: string;
}

/** `owner/name` from a GitHub remote URL (https, ssh or scp-style). */
export function githubSlug(url: string): string | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** origin URL read from.git/config (no git subprocess). */
function originUrl(gitDir: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(gitDir, "config"), "utf8");
  } catch {
    return undefined;
  }
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) {
      inOrigin = /^remote\s+"origin"$/.test(sec[1].trim());
      continue;
    }
    const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (inOrigin && kv) return kv[1];
  }
  return undefined;
}

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function hasEpicSpine(dir: string): boolean {
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      if (/epicspine|epic-spine|EpicSpine/i.test(fs.readFileSync(path.join(dir, f), "utf8"))) return true;
    } catch {
      /* missing */
    }
  }
  if (exists(path.join(dir, "docs", "spines"))) return true;
  try {
    return fs.readdirSync(path.join(dir, "docs")).some((f) => /^EPIC-.*\.md$/.test(f));
  } catch {
    return false;
  }
}

/** the repo set almost never changes, but every tree node used to rescan it; a scan is reused this long. */
export const REPO_SCAN_TTL_MS = 5_000;
let repoScanTtlMs = REPO_SCAN_TTL_MS;
const scans = new Map<string, { at: number; repos: Repo[] }>();

/** Tests: drop every memoized scan, and optionally set the TTL (0 = no memo; omit = back to the default). */
export function resetRepoScans(ttlMs: number = REPO_SCAN_TTL_MS): void {
  scans.clear();
  repoScanTtlMs = ttlMs;
}

/**
 * Repo names this process may see: the indexer of a console that sets CONSOLE_INDEX_REPOS (staging: `the code repo`)
 * scans only these, so a second console on the same host does not re-read every repo production already reads.
 * Unset (production) = every checkout. Set per process, in the indexer only (indexer/main.ts).
 */
let onlyRepos: Set<string> | undefined;
export function setRepoAllowlist(names: string | undefined): string[] | undefined {
  const list = (names ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  onlyRepos = list.length ? new Set(list) : undefined;
  scans.clear();
  return onlyRepos ? [...onlyRepos] : undefined;
}
const allowed = (name: string) => !onlyRepos || onlyRepos.has(name);

/** Git checkouts directly under root: only dirs whose `.git` is a directory (worktrees have a `.git` file). Memoized for a few seconds. */
export function listRepos(root: string): Repo[] {
  const hit = scans.get(root);
  if (hit && Date.now() - hit.at < repoScanTtlMs) return hit.repos.slice();
  const repos = scanRepos(root);
  if (repoScanTtlMs > 0) scans.set(root, { at: Date.now(), repos });
  return repos.slice();
}

function scanRepos(root: string): Repo[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Repo[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".") || !allowed(name)) continue;
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(path.join(dir, ".git")).isDirectory()) continue;
    } catch {
      continue;
    }
    const url = originUrl(path.join(dir, ".git"));
    out.push({ name, path: dir, remote: url ? githubSlug(url) : undefined, hasEpicSpine: hasEpicSpine(dir) });
  }
  return out;
}

/** prefix the store puts on a world milestone's repo outside that world's own checkouts (tenancy/repoScope.ts). */
export const REFUSED_REPO = "refused:";

/**
 * Checkout for a milestone's `repo`: an absolute path, a name under root, or `owner/name` matched against
 * origin remotes (falling back to the name part). A `refused:` repo resolves to nothing.
 */
export function resolveRepo(root: string, repo: string): Repo | undefined {
  const r = repo.trim().replace(/\/+$/, "");
  if (r.startsWith(REFUSED_REPO)) return undefined;
  const repos = listRepos(root);
  if (path.isAbsolute(r)) {
    const hit = repos.find((x) => x.path === path.resolve(r));
    if (hit) return hit;
    return allowed(path.basename(r)) && exists(path.join(r, ".git")) ? { name: path.basename(r), path: path.resolve(r), hasEpicSpine: hasEpicSpine(r) } : undefined;
  }
  // a renamed repo answers to both names (repoNames.ts): its remote may say either, its folder keeps the old one.
  if (r.includes("/")) {
    const slug = r.toLowerCase().replace(/^https?:\/\/github\.com\//, "");
    const name = slug.split("/").pop()!;
    return (
      repos.find((x) => x.remote?.toLowerCase() === slug) ??
      repos.find((x) => !!x.remote && repoKey(x.remote) === repoKey(slug)) ??
      repos.find((x) => x.name === name) ??
      repos.find((x) => repoKey(x.name) === repoKey(name))
    );
  }
  return repos.find((x) => x.name === r) ?? repos.find((x) => repoKey(x.name) === repoKey(r));
}

/** Checkout that owns a directory: the dir itself, or for a worktree the repo its `.git` file points to. */
export function repoForDir(root: string, dir: string): Repo | undefined {
  const repos = listRepos(root);
  const abs = path.resolve(dir);
  const direct = repos.find((x) => abs === x.path || abs.startsWith(x.path + path.sep));
  if (direct) return direct;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(abs, ".git"), "utf8"));
    if (m) {
      const main = path.resolve(abs, m[1].trim()).replace(/\/\.git\/worktrees\/[^/]+$/, "");
      return repos.find((x) => x.path === main);
    }
  } catch {
    /* not a worktree */
  }
  return undefined;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "venv", ".venv", "__pycache__"]);
const MAX_DEPTH = 5;
const MAX_BYTES = 512 * 1024;

function walkMd(dir: string, depth: number, out: string[]) {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) walkMd(p, depth + 1, out);
    } else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
}

function hasSpineIdLine(abs: string): boolean {
  try {
    if (fs.statSync(abs).size > MAX_BYTES) return false;
    return /^\s*(?:[-*]\s+)?(?:\*\*)?Spine ID(?::\*\*|\*\*:|:)/m.test(fs.readFileSync(abs, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Candidate milestone files in a checkout: docs/spines/*.md, docs/EPIC-*.md, any *.md with a `Spine ID:` line
 * (spines), and *.md under tickets/ and docs/tickets/ (tickets). Spines first, then by path.
 */
export function listDocs(repoDir: string): DocItem[] {
  const files: string[] = [];
  walkMd(repoDir, 0, files);
  const items: DocItem[] = [];
  for (const abs of files) {
    const rel = path.relative(repoDir, abs).split(path.sep).join("/");
    const spineByPath = /^docs\/spines\/[^/]+\.md$/.test(rel) || /^docs\/EPIC-[^/]*\.md$/.test(rel);
    const ticketByPath = /^(docs\/)?tickets\/.+\.md$/.test(rel);
    if (!spineByPath && !ticketByPath && !hasSpineIdLine(abs)) continue;
    const info = readDoc(abs);
    if (!info) continue;
    const kind = spineByPath || info.spineId ? "spine" : "ticket";
    items.push({
      path: rel,
      kind,
      title: info.title ?? path.basename(rel, ".md"),
      status: info.statusLine,
      dod: { done: info.dod.done, total: info.dod.total },
    });
  }
  return items.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "spine" ? -1 : 1));
}

export { inside };
