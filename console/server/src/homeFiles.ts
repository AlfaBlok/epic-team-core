import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Every file homed in a tab shows in that tab (the owner: "History and Pages show every file homed there"). The
 * homes map gives every file the team writes a home in one tab
 * of its product's wheel: each tab's `homes` in docs/totems/<product>.json are file patterns (Python fnmatch: `*`
 * crosses folders) in the repos `wheel.homes.repos` names. This lists the files one tab homes, as entries a person
 * opens: a folder holding an HTML page is one page (its assets with it), every other note (Markdown, JSON, a log) is
 * its own entry, and what is left in a folder (screenshots) is one folder entry. Every homed file sits in exactly one
 * entry, so `homed` equals `covered` by construction; scripts/totems.py check compares the homes map with what this
 * answers (GET /api/homes/:product/:tab) and fails when a file is missing. Newest first by git; each entry names the
 * row that made it (its folder, else the commit that added it) and, for a log under docs/log/<spine>/, its spine, so
 * the objective and campaign screens place it. Read-only: the files open through GET /api/homes/file/:repo/<path>.
 */

export interface HomeTab {
  id: string;
  label: string;
  homes: string[];
}
export interface HomeWheel {
  product: string;
  name: string;
  repos: string[];
  tabs: HomeTab[];
}
export interface HomeEntry {
  /** repo:path of what it opens. */
  id: string;
  repo: string;
  /** the folder (a page or a folder of screenshots) or the file the entry is. */
  path: string;
  /** what a tap opens, repo-relative (the page's HTML, the note, or the folder with a trailing `/`). */
  open: string;
  title: string;
  kind: "page" | "note" | "folder";
  /** newest commit that touched any of its files, ISO. */
  date?: string;
  /** the row that made it: its folder's name (docs/status/e6-s221), else the row code of the commit that added it. */
  row?: string;
  /** repo-relative spine a log sits under (docs/log/<spine>/… → docs/spines/<spine>.md), when that spine exists. */
  spine?: string;
  files: number;
  /** the objective it was made for, when its row's spine sits in no objective's tree (homePlace.ts). */
  objective?: string;
  /** how: a key result lists its row, its row's epic, or its path. */
  placedBy?: "kr" | "epic" | "path";
  /** why no objective holds it, from docs/pages/registry.json notPlacedByPath. */
  notPlaced?: string;
}
export interface HomeTabBody {
  product: string;
  tab: string;
  label: string;
  repos: string[];
  patterns: string[];
  /** files the homes map puts in this tab (code files left out, as totems.py does). */
  homed: number;
  /** files the entries below cover: always `homed`. */
  covered: number;
  entries: HomeEntry[];
}

const KNOWLEDGE = /^(docs|data|desk|state|research|feedback|personas|social-kit)\//;
const CODE = /\.(service|timer|py|sh|ts)$/;
/** a file the tabs show: knowledge, not code (the same test as scripts/totems.py home_of). */
export const shownFile = (p: string) => KNOWLEDGE.test(p) && !CODE.test(p);
/** a note read on its own (a report, a log, run notes); JSON data and pictures stay with their folder. */
const NOTE = /\.(md|markdown|txt|jsonl|csv)$/i;
const HTML = /\.html?$/i;
const ROW = /^(e\d+-[sa]\d+)/i;
const ROW_IN = /\b(E\d+-[SA]\d+)\b/;

/** Python fnmatch: `*` any run (folders too), `?` one character, `[...]` a set. */
export function globRe(pat: string): RegExp {
  let s = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === "*") s += ".*";
    else if (ch === "?") s += ".";
    else if (ch === "[") {
      const j = pat.indexOf("]", i + 1);
      if (j < 0) s += "\\[";
      else {
        let set = pat.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = "^" + set.slice(1);
        s += `[${set}]`;
        i = j;
      }
    } else s += ch.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${s}$`, "s");
}

/** the literal folder a pattern lists under (`docs/status/*` → `docs/status/`, a plain file → its folder). */
export function rootOf(pat: string): string {
  const w = pat.search(/[*?[]/);
  const lit = w < 0 ? pat : pat.slice(0, w);
  return lit.slice(0, lit.lastIndexOf("/") + 1);
}

/** each product's wheel tabs with their homes, from docs/totems/<product>.json of the home repo. */
export function readHomeWheels(homeDir: string | undefined): HomeWheel[] {
  if (!homeDir) return [];
  const dir = path.join(homeDir, "docs", "totems");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: HomeWheel[] = [];
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as {
        product?: string;
        name?: string;
        wheel?: { tabs?: { id?: string; label?: string; homes?: unknown }[]; homes?: { repos?: unknown } };
      };
      const tabs = (o.wheel?.tabs ?? []).flatMap((t) =>
        t.id && t.label && Array.isArray(t.homes) ? [{ id: t.id, label: t.label, homes: t.homes.filter((h): h is string => typeof h === "string" && !h.includes("..") && !h.startsWith("/")) }] : [],
      );
      const repos = Array.isArray(o.wheel?.homes?.repos) ? (o.wheel!.homes!.repos as unknown[]).filter((r): r is string => typeof r === "string" && /^[\w.-]+$/.test(r)) : [];
      if (o.product && tabs.length) out.push({ product: o.product, name: o.name ?? o.product, repos, tabs });
    } catch {
      /* a broken map file: totems.py check names it */
    }
  }
  return out;
}

/** whether a repo-relative path is homed in any tab of a wheel that holds this repo. */
export function homedAnywhere(wheels: HomeWheel[], repo: string, rel: string): boolean {
  return wheels.some((w) => w.repos.includes(repo) && w.tabs.some((t) => t.homes.some((h) => globRe(h).test(rel))));
}

export interface GitInfo {
  /** newest commit time per path (unix seconds). */
  time: Map<string, number>;
  /** the row code of the oldest commit that touched the path (the one that made it). */
  row: Map<string, string>;
  /** the words of the oldest commit that touched the path, its row code left out. */
  subject?: Map<string, string>;
}

/** git, read without blocking the server (a big folder's log takes seconds); "" when it fails. */
const gitOut = (repoDir: string, args: string[]) =>
  new Promise<string>((resolve) =>
    execFile("git", ["-c", "core.quotePath=false", "-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, out) => resolve(err ? "" : out)),
  );

/** one `git log` over the given folders: newest time and the making row per file. */
export async function gitInfo(repoDir: string, roots: string[]): Promise<GitInfo> {
  const time = new Map<string, number>();
  const row = new Map<string, string>();
  const subject = new Map<string, string>();
  if (!roots.length) return { time, row, subject };
  const out = await gitOut(repoDir, ["log", "--format=@@%ct %s", "--name-only", "--", ...roots.map((r) => r || ".")]);
  let t = 0;
  let code: string | undefined;
  let words = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const sp = line.indexOf(" ");
      t = Number(line.slice(2, sp));
      const subj = line.slice(sp + 1);
      code = ROW_IN.exec(subj)?.[1];
      words = cleanSubject(subj);
    } else if (line) {
      if (!time.has(line)) time.set(line, t);
      // oldest wins: git log runs newest first, so every older commit naming a row overwrites.
      if (code) row.set(line, code);
      if (words) subject.set(line, words);
    }
  }
  return { time, row, subject };
}

/** a commit's words as a title: its leading row codes and "iteration n" dropped, the first clause, at most 90 characters. */
export function cleanSubject(subj: string): string {
  let w = subj.replace(/^(\s*(E\d+-[SAG]\d+|EPIC-\d+)[\s,]*)+/i, "").replace(/^(iteration|round|r)\s*\d+\s*[:,-]?\s*/i, "").replace(/^[:\s-]+/, "").trim();
  w = w.split(/;\s|\s\(|\s—\s/)[0].trim();
  if (w.length > 90) w = w.slice(0, 89).replace(/\s+\S*$/, "") + "…";
  return w ? w[0].toUpperCase() + w.slice(1) : "";
}

/** the files git tracks in a repo under these folders, read without blocking. */
export async function trackedFilesAsync(repoDir: string, roots: string[]): Promise<string[]> {
  if (!roots.length) return [];
  return (await gitOut(repoDir, ["ls-files", "-z", "--", ...roots.map((r) => r || ".")])).split("\0").filter(Boolean);
}

/** the files git tracks in a repo under these folders (one folder's list, small: read at once). */
export function trackedFiles(repoDir: string, roots: string[]): string[] {
  if (!roots.length) return [];
  try {
    return execFileSync("git", ["-C", repoDir, "ls-files", "-z", "--", ...roots.map((r) => r || ".")], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const humanize = (s: string) =>
  s
    .replace(/\.[a-z0-9]+$/i, "")
    // dashes between words become spaces; a date keeps its own (2026-11-23).
    .replace(/(?<!\d)[-_]+|[-_]+(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "\u2019", lsquo: "\u2018", mdash: "\u2014", ndash: "\u2013", middot: "\u00b7", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

/** a page's <title>, a note's first heading; else its name in words. */
export function titleOf(repoDir: string, rel: string, fallback: string): string {
  return ownTitle(repoDir, rel) ?? (humanize(fallback) || fallback);
}

/** a page's <title> or a note's first heading, when it has one. */
export function ownTitle(repoDir: string, rel: string): string | undefined {
  if (HTML.test(rel) || /\.md$/i.test(rel)) {
    try {
      const fd = fs.openSync(path.join(repoDir, rel), "r");
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, n).toString("utf8");
      const m = HTML.test(rel) ? /<title[^>]*>([^<]{2,200})<\/title>/i.exec(head) : /^#\s+(.{2,200})$/m.exec(head.replace(/^---\n[\s\S]*?\n---\n/, ""));
      if (m) return decode(m[1]).replace(/\s+/g, " ").trim();
    } catch {
      /* unreadable: its name */
    }
  }
  return undefined;
}

/** the page a folder opens: index.html at its top, proof.html, else its shallowest HTML. */
const bestHtml = (folder: string, files: string[]) => {
  const html = files.filter((f) => HTML.test(f));
  return html.find((f) => f === `${folder}/index.html`) ?? html.find((f) => f === `${folder}/proof.html`) ?? [...html].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
};

/**
 * The entries of one tab in one repo: the homed files grouped as a person opens them. Pure but for reading titles
 * (repoDir); `files` are repo-relative paths already homed in the tab.
 */
export function entriesOf(repo: string, repoDir: string, patterns: string[], files: string[], git: GitInfo): HomeEntry[] {
  const roots = patterns.map(rootOf);
  const groups = new Map<string, string[]>();
  for (const f of files) {
    // the longest root that holds it (docs/status/ over docs/), then its first folder below that root.
    const r = roots.filter((x) => f.startsWith(x)).sort((a, b) => b.length - a.length)[0] ?? "";
    const rest = f.slice(r.length);
    const slash = rest.indexOf("/");
    const key = slash < 0 ? f : r + rest.slice(0, slash);
    const g = groups.get(key) ?? [];
    g.push(f);
    groups.set(key, g);
  }
  const iso = (fs_: string[]) => {
    const t = Math.max(0, ...fs_.map((f) => git.time.get(f) ?? 0));
    return t ? new Date(t * 1000).toISOString() : undefined;
  };
  const rowOf = (key: string, fs_: string[]) => {
    const m = ROW.exec(path.basename(key));
    if (m) return m[1].toUpperCase();
    for (const f of [...fs_].sort()) {
      const r = git.row.get(f);
      if (r) return r;
    }
    return undefined;
  };
  const spineOf = (rel: string) => {
    const m = /^docs\/log\/([^/]+)\//.exec(rel);
    if (!m) return undefined;
    const s = `docs/spines/${m[1]}.md`;
    return fs.existsSync(path.join(repoDir, s)) ? s : undefined;
  };
  const make = (p: string, open: string, kind: HomeEntry["kind"], fs_: string[]): HomeEntry => {
    const row = rowOf(p, fs_);
    const spine = spineOf(p + (kind === "note" ? "" : "/"));
    const name = path.basename(p);
    const parent = path.basename(path.dirname(p));
    // a note named only by its date (docs/log/root/2026-W47.md) keeps its folder in the title.
    const fallback = kind === "note" && /^\d{4}-/.test(name) && parent && !/^(docs|data|status|log|reports)$/.test(parent) ? `${parent} ${name}` : name;
    // its own title first; a folder, or a file named only by its row or a date, takes the words of the commit that made it.
    const own = kind === "folder" ? undefined : ownTitle(repoDir, open);
    const bare = kind === "folder" || /\.jsonl$/i.test(name) ? kind === "folder" : ROW.test(name) || /^\d{4}-\d\d-\d\d/.test(name) || /^(index|proof|README)\.\w+$/i.test(name);
    const said = bare ? fs_.map((f) => git.subject?.get(f)).find(Boolean) : undefined;
    const title = own ?? said ?? (humanize(fallback) || fallback);
    return {
      id: `${repo}:${open}`,
      repo,
      path: p,
      open,
      title,
      kind,
      ...(iso(fs_) ? { date: iso(fs_) } : {}),
      ...(row ? { row } : {}),
      ...(spine ? { spine } : {}),
      files: fs_.length,
    };
  };
  const out: HomeEntry[] = [];
  for (const [key, fs_] of groups) {
    if (fs_.length === 1 && fs_[0] === key) {
      out.push(make(key, key, HTML.test(key) ? "page" : "note", fs_));
      continue;
    }
    const page = bestHtml(key, fs_);
    if (page) {
      out.push(make(key, page, "page", fs_));
      continue;
    }
    const notes = fs_.filter((f) => NOTE.test(f));
    for (const n of notes) out.push(make(n, n, "note", [n]));
    const rest = fs_.filter((f) => !NOTE.test(f));
    if (rest.length) out.push(make(key, `${key}/`, "folder", rest));
  }
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
}

/** one tab's body: every repo the product's homes name, its files grouped, newest first. */
export async function homeTab(o: { wheels: HomeWheel[]; product: string; tab: string; repoDir: (repo: string) => string | undefined }): Promise<HomeTabBody | null> {
  const w = o.wheels.find((x) => x.product === o.product);
  const t = w?.tabs.find((x) => x.id === o.tab);
  if (!w || !t) return null;
  const res = t.homes.map(globRe);
  // a file another tab of this product homes first stays there (one file, one tab: totems.py takes the first match).
  const earlier = w.tabs.slice(0, w.tabs.indexOf(t)).flatMap((x) => x.homes.map(globRe));
  const roots = [...new Set(t.homes.map(rootOf))];
  let homed = 0;
  let covered = 0;
  const entries: HomeEntry[] = [];
  for (const repo of w.repos) {
    const dir = o.repoDir(repo);
    if (!dir) continue;
    const files = (await trackedFilesAsync(dir, roots)).filter((f) => shownFile(f) && res.some((r) => r.test(f)) && !earlier.some((r) => r.test(f)));
    if (!files.length) continue;
    homed += files.length;
    const es = entriesOf(repo, dir, t.homes, files, await gitInfo(dir, roots));
    covered += es.reduce((n, e) => n + e.files, 0);
    entries.push(...es);
  }
  entries.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  return { product: w.product, tab: t.id, label: t.label, repos: w.repos, patterns: t.homes, homed, covered, entries };
}

/**
 * The tab's body, kept until any of its repos moves (its HEAD). A moved repo answers the kept body at once and reads
 * the new one behind it (the team commits every few minutes, a big tab's log takes seconds); only a first read waits.
 */
export function createHomeTabs(o: { wheels: () => HomeWheel[]; repoDir: (repo: string) => string | undefined }) {
  const cache = new Map<string, { stamp: string; body: HomeTabBody | null }>();
  const reading = new Map<string, Promise<HomeTabBody | null>>();
  const stampOf = async (w: HomeWheel) => JSON.stringify([w.tabs, await Promise.all(w.repos.map(async (r) => { const d = o.repoDir(r); return d ? (await gitOut(d, ["rev-parse", "HEAD"])).trim() : "-"; }))]);
  const read = (key: string, stamp: string, product: string, tab: string, wheels: HomeWheel[]) => {
    const now = reading.get(key);
    if (now) return now;
    const p = homeTab({ wheels, product, tab, repoDir: o.repoDir })
      .then((body) => {
        cache.set(key, { stamp, body });
        return body;
      })
      .finally(() => reading.delete(key));
    reading.set(key, p);
    return p;
  };
  return {
    async get(product: string, tab: string): Promise<HomeTabBody | null> {
      const wheels = o.wheels();
      const w = wheels.find((x) => x.product === product);
      if (!w || !w.tabs.some((t) => t.id === tab)) return null;
      const key = `${product}/${tab}`;
      const stamp = await stampOf(w);
      const hit = cache.get(key);
      if (hit && hit.stamp === stamp) return hit.body;
      const fresh = read(key, stamp, product, tab, wheels);
      return hit ? hit.body : fresh;
    },
    /** that tab of every product that has one, as one body; none has it: none. */
    async all(tab: string): Promise<HomeTabBody | null> {
      const ws = o.wheels().filter((w) => w.tabs.some((t) => t.id === tab));
      const bodies = (await Promise.all(ws.map((w) => this.get(w.product, tab)))).filter((b): b is HomeTabBody => !!b);
      if (!bodies.length) return null;
      return {
        product: "all",
        tab,
        label: bodies[0].label,
        repos: [...new Set(bodies.flatMap((b) => b.repos))],
        patterns: [...new Set(bodies.flatMap((b) => b.patterns))],
        homed: bodies.reduce((n, b) => n + b.homed, 0),
        covered: bodies.reduce((n, b) => n + b.covered, 0),
        entries: bodies.flatMap((b) => b.entries).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id)),
      };
    },
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SHELL = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<style>:root{color-scheme:light dark;--bg:#f6f3ec;--ink:#1d1b17;--mute:#6b665c;--line:#ddd6c8}@media (prefers-color-scheme:dark){:root{--bg:#171613;--ink:#ece7dc;--mute:#a39d90;--line:#35322c}}` +
  `body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,sans-serif}main{max-width:76ch;margin:0 auto;padding:24px 16px 48px}` +
  `h1{font-size:15px;font-weight:600;color:var(--mute);margin:0 0 16px;word-break:break-all}pre{white-space:pre-wrap;word-wrap:break-word;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}` +
  `ul{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}li{border-bottom:1px solid var(--line)}li a{display:block;padding:10px 0;color:var(--ink);text-decoration:none;word-break:break-all}li a:hover{text-decoration:underline}</style></head><body><main>${body}</main></body></html>`;

export type FileAnswer = { status: 200; type: string; body: Buffer | string; sandbox?: boolean } | { status: 404 | 400; error: string };

/**
 * One homed file (or folder) as a browser shows it: HTML as the page (sandboxed: it runs in its own origin, never with
 * the console's sign-in), images and assets as themselves, a note as calm readable text, a folder as its list of files.
 * Only paths a tab homes, in a repo its product names, and never code.
 */
export function readHomeFile(o: { wheels: HomeWheel[]; repo: string; rel: string; repoDir: string | undefined }): FileAnswer {
  const rel = o.rel.replace(/^\/+/, "");
  if (!o.repoDir || rel.split("/").some((s) => s === ".." || s === ".") || rel.includes("\0")) return { status: 400, error: "bad path" };
  const abs = path.join(o.repoDir, rel);
  if (!abs.startsWith(path.resolve(o.repoDir) + path.sep)) return { status: 400, error: "bad path" };
  const isDir = rel.endsWith("/") || (fs.existsSync(abs) && fs.statSync(abs).isDirectory());
  const clean = rel.replace(/\/+$/, "");
  if (isDir) {
    // a folder: the homed files inside it.
    const files = trackedFiles(o.repoDir, [clean]).filter((f) => !CODE.test(f) && homedAnywhere(o.wheels, o.repo, f));
    if (!files.length) return { status: 404, error: "nothing homed here" };
    // relative links: below a folder address ending in `/` they start at the folder, else at its parent.
    const base = rel.endsWith("/") ? "" : `${encodeURIComponent(path.basename(clean))}/`;
    const items = files.map((f) => `<li><a href="${base}${f.slice(clean.length + 1).split("/").map(encodeURIComponent).join("/")}">${esc(f.slice(clean.length + 1))}</a></li>`).join("");
    return { status: 200, type: "text/html; charset=utf-8", body: SHELL(clean, `<h1>${esc(o.repo)} · ${esc(clean)} · ${files.length} files</h1><ul>${items}</ul>`) };
  }
  if (CODE.test(clean) || !homedAnywhere(o.wheels, o.repo, clean)) return { status: 404, error: "not a homed file" };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { status: 404, error: "no such file" };
  }
  const ext = path.extname(clean).toLowerCase();
  if (MIME[ext]) return { status: 200, type: MIME[ext], body: buf, ...(HTML.test(clean) ? { sandbox: true } : {}) };
  // a note (Markdown, JSON, a log): readable text on a calm page.
  return { status: 200, type: "text/html; charset=utf-8", body: SHELL(path.basename(clean), `<h1>${esc(o.repo)} · ${esc(clean)}</h1><pre>${esc(buf.toString("utf8"))}</pre>`) };
}
