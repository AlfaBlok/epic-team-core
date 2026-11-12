import fs from "node:fs";
import path from "node:path";
import { inside } from "../adapters/doc.js";
import { firstH1, sections, stripInline, tables } from "../adapters/markdown.js";
import { sites } from "../identity.js";

/**
 * everything made for an epic, so the owner finds every mockup, deck, proposal, live page and piece of
 * evidence in its Epic Book section. Read from the repo only (root L-45): the spine's lines (Current State, Waiting on asks
 * open and answered, Issue Ledger cells, Decisions, Outcome), its review cards (docs/cards), and the epic's own pages under
 * docs/proposals, docs/plans and docs/status (named e<n>-…). De-duplicated, labelled in plain words, dated, never dropped:
 * a link that no longer answers is marked (book/links.ts), and a stopped tailnet preview names the folder it was served
 * from (docs/status/previews.json, written by hosted/console/scripts/preview-registry.mjs) so it can be served again.
 */

export type DeliverableKind = "mockup" | "deck" | "proposal" | "live page" | "preview" | "evidence";

export interface Deliverable {
  /** What the owner opens: a live URL, a tailnet preview, or the repo file on GitHub. */
  url: string;
  /** What it is, in plain words. */
  label: string;
  kind: DeliverableKind;
  /** When it was made (YYYY-MM-DD), null when nothing dates it. */
  date: string | null;
  /** The row or ask it came from, when one names it. */
  row?: string;
  /** A repo file (repo-relative): checked on disk, not over the network. */
  file?: string;
  /** A tailnet preview: the folder it was served from (repo/path, or an absolute path outside the repos). */
  servePath?: string;
  /** A preview of a folder in the repo: that folder on GitHub, so it can be read when the preview is not running. */
  repoUrl?: string;
  /** Set at build time for a repo file that is gone; set at read time from the link checker for a URL. */
  check?: LinkCheck;
}

export type LinkState = "ok" | "not running" | "gone" | "down";
export interface LinkCheck {
  state: LinkState;
  /** When it was checked (ISO). */
  at: string;
  /** HTTP status or the network error, for the hover. */
  detail?: string;
}

/** One tailnet preview seen serving a folder (docs/status/previews.json). */
export interface PreviewEntry {
  url: string;
  dir: string;
  repo?: string;
  path?: string;
  seenAt?: string;
}
export const PREVIEWS_FILE = "docs/status/previews.json";

/** Tailnet IPs named by their MagicDNS host, so one preview written both ways is one item. */
export const TAILNET_NAMES = (): Record<string, string> => sites().tailnetNames;
const TAILNET = /\.ts\.net$|^100\.\d+\.\d+\.\d+$/;

/** URLs that are not something made for the owner: sign-ins, code hosting chatter (PRs, commits), local-only addresses. */
const SKIP_URL =
  /^https?:\/\/(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)|login\.|accounts\.|(?:www\.)?github\.com\/[^/]+\/[^/]+(?:\/(?:pull|pulls|issues|commit|commits|compare|actions|tree\/(?!main)|releases)|\/?$)|api\.github\.com|example\.(?:com|org))/i;
const URL_RE = /https?:\/\/[^\s<>"'`|\]]+/g;
const MD_LINK = /!?\[([^\]]*)\]\(([^)\s]+)\)/g;
const DATE = /\b(20\d\d-\d\d-\d\d)\b/;
const ROW_CODE = /^(?:[A-Z][A-Za-z0-9]*-)*[A-Z]+\d*-[A-Z]{0,3}\d+[a-z]?$/;
const GENERIC = /^(?:page|here|link|live|open|url|the page|this|it|evidence|status|card|deck|proposal|mockup|screenshot|shots?|report|plan|plan page|preview|site|demo|e\d+(?:-[a-z]{0,3}\d+)+[a-z0-9-]*|[a-z0-9_-]+\.(?:md|html|png|jpe?g|pdf))$/i;

/** Trailing punctuation a sentence leaves on a bare URL. */
const trimUrl = (u: string) => u.replace(/\*+$/, "").replace(/[.,;:!?)]+$/, (m) => (u.includes("(") && m.startsWith(")") ? m.slice(1).replace(/[.,;:!?]+$/, "") : ""));

/** One URL the way it is compared: host lower-cased and named, no trailing slash or index.html, no fragment. */
export function urlKey(u: string): string {
  try {
    const x = new URL(u);
    const host = TAILNET_NAMES()[x.hostname] ?? x.hostname.toLowerCase();
    const p = x.pathname.replace(/\/index\.html?$/i, "/").replace(/\/+$/, "");
    return `${x.protocol}//${host}${x.port ? `:${x.port}` : ""}${p}${x.search}`;
  } catch {
    return u;
  }
}

/** The URL as shown: a tailnet IP becomes its MagicDNS name (the owner's devices resolve both). */
export function displayUrl(u: string): string {
  try {
    const x = new URL(u);
    const name = TAILNET_NAMES()[x.hostname];
    if (!name) return u;
    x.hostname = name;
    return x.toString();
  } catch {
    return u;
  }
}

export const isTailnet = (u: string): boolean => {
  try {
    const h = new URL(u).hostname;
    // a Tailscale name or address, or a private-network host the sites config names (either side of the pair)
    return TAILNET.test(h) || Object.entries(TAILNET_NAMES()).some(([ip, name]) => h === ip || h === name);
  } catch {
    return false;
  }
};

/** A line of plain words: markdown, ids and stray brackets out, cut at a word near `max`. */
export function plainLabel(text: string, max = 110): string {
  let t = stripInline(text)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s*\b(?:run|as|ms|tok)_[0-9a-f][0-9a-f-]{5,}/gi, "")
    .replace(/\s*\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, "")
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/^\s*(?:EPIC-\d+|M\d+|E\d+-[A-Z]{0,3}\d+)\s*[:—–-]\s*/i, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:—–-]+|[\s,;:—–(-]+$/g, "")
    .trim();
  if (t.length > max) t = `${t.slice(0, t.lastIndexOf(" ", max) > max * 0.5 ? t.lastIndexOf(" ", max) : max).replace(/[,;:(\s-]+$/, "")}…`;
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function kindOf(url: string, label: string, near = "", file = false): DeliverableKind {
  const u = url.toLowerCase();
  const s = `${u} ${label} ${near}`.toLowerCase();
  if (/mock-?ups?\b/.test(s)) return "mockup";
  if (/\bdecks?\b|\bslides?\b/.test(s)) return "deck";
  if (/\/(?:docs\/)?(?:status|cards|evidence|reports)\/|\.(?:png|jpe?g|gif|webp|pdf)$|screenshot|evidence|\breport\b/.test(u + " " + label.toLowerCase())) return "evidence";
  if (/proposal|options|\/plans?\/|\bplan\b|naming|style trials?/.test(s)) return "proposal";
  if (isTailnet(url)) return "preview";
  // A page kept in a repo (a report, an audit, a guide) is evidence; a live page is one served on the web.
  if (file || /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\//i.test(url)) return "evidence";
  return "live page";
}

/** Repo-relative target of a relative link in `fromFile`; only pages under docs/ (spines and code are not deliverables). */
function repoTarget(fromFile: string, target: string): string | undefined {
  if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return undefined;
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target.split("#")[0].split("?")[0]));
  if (rel.startsWith("..") || !rel.startsWith("docs/") || rel.startsWith("docs/spines/")) return undefined;
  if (/\.(?:ts|tsx|js|mjs|py|sh|json|ya?ml)$/i.test(rel)) return undefined;
  return rel.replace(/\/+$/, "");
}

/** The heading of a repo page (first `# ` of a.md, `<title>` of an.html), as plain words; undefined for other files. */
function pageTitle(repoDir: string, rel: string): string | undefined {
  const abs = inside(repoDir, rel);
  if (!abs) return undefined;
  try {
    const st = fs.statSync(abs);
    const file = st.isDirectory() ? ["index.html", "README.md", "index.md"].map((f) => path.join(abs, f)).find((f) => fs.existsSync(f)) : abs;
    if (!file || fs.statSync(file).size > 2_000_000) return undefined;
    const head = fs.readFileSync(file, "utf8").slice(0, 20_000);
    const t = /\.html?$/i.test(file) ? /<title>([^<]+)<\/title>/i.exec(head)?.[1] : firstH1(head);
    return t ? plainLabel(t.replace(/&amp;/g, "&").replace(/&[a-z]+;/g, " "), 110) : undefined;
  } catch {
    return undefined;
  }
}

/** "e65-r3-epic-team" → "Epic team, round 3". */
function nameOfPath(rel: string): string {
  const base = path.posix.basename(rel).replace(/\.[a-z0-9]+$/i, "");
  const round = /(?:^|-)r(\d+)(?:-|$)/i.exec(base)?.[1];
  const words = base
    .replace(/^e\d+(?:-[a-z]{0,3}\d+)*-?/i, "")
    .replace(/(?:^|-)r\d+(?=-|$)/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const t = words || (rel.startsWith("docs/status/") ? "Evidence pages and screenshots" : rel.startsWith("docs/plans/") ? "The plan" : rel.startsWith("docs/proposals/") ? "The proposal" : base);
  return plainLabel(`${t}${round ? `, round ${round}` : ""}`);
}

export interface DeliverableSources {
  repoDir: string;
  /** The repo's name as the book shows it (a worktree's folder name may differ). */
  repoName?: string;
  remote?: string;
  spinePath: string;
  markdown: string;
  /** → 71: the epic's own pages under docs/proposals, docs/plans and docs/status are named e71-…. */
  number?: number;
  /** When a repo file was first committed (repo-relative path → ISO date), from the book's git log. */
  fileDates: Map<string, string>;
  cards: Card[];
  previews: PreviewEntry[];
  /** Repo-relative entries under docs/proposals, docs/plans and docs/status (one level), read once per repo. */
  docEntries: string[];
  /** A tailnet preview (host:port) → the folder whose own notes name it ("Open it at http://the worker server…:8975/"). */
  noted?: Map<string, string>;
}

export interface Card {
  file: string;
  row: string;
  spine?: string;
  title?: string;
  evidence?: string;
  screenshot?: string;
  delivered: string[];
}

/** Every docs/cards/*.md front matter of a repo (docs/review-cards.md format). */
export function readCards(repoDir: string): Card[] {
  const dir = inside(repoDir, "docs/cards");
  let names: string[] = [];
  try {
    names = dir ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  } catch {
    return [];
  }
  const out: Card[] = [];
  for (const f of names) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir!, f), "utf8");
    } catch {
      continue;
    }
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    if (!fm) continue;
    const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim();
    const delivered = [...fm.matchAll(/^\s+-\s+(.+)$/gm)].map((m) => m[1]);
    out.push({ file: `docs/cards/${f}`, row: get("row") ?? f.replace(/\.md$/, ""), spine: get("spine"), title: get("title"), evidence: get("evidence"), screenshot: get("screenshot"), delivered });
  }
  return out;
}

export function readPreviews(repoDir: string): PreviewEntry[] {
  const abs = inside(repoDir, PREVIEWS_FILE);
  try {
    const raw = abs ? JSON.parse(fs.readFileSync(abs, "utf8")) : undefined;
    return Array.isArray(raw?.previews) ? raw.previews.filter((p: any) => p?.url && p?.dir).map((p: any) => ({ url: String(p.url), dir: String(p.dir), ...(p.repo ? { repo: String(p.repo) } : {}), ...(p.path !== undefined ? { path: String(p.path) } : {}), ...(p.seenAt ? { seenAt: String(p.seenAt) } : {}) })) : [];
  } catch {
    return [];
  }
}

/** One level of docs/proposals, docs/plans and docs/status (folders and files), repo-relative. */
export function readDocEntries(repoDir: string): string[] {
  const out: string[] = [];
  for (const d of ["docs/proposals", "docs/plans", "docs/status"]) {
    const abs = inside(repoDir, d);
    try {
      if (abs) for (const f of fs.readdirSync(abs)) out.push(`${d}/${f}`);
    } catch {
      /* none */
    }
  }
  return out;
}

/**
 * Folders whose notes (index.md, README.md) name a tailnet preview: the first one each names is the one it was served at,
 * so a stopped preview the registry never saw still says where to serve it from.
 */
export function readNotedPreviews(repoDir: string, docEntries: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of docEntries) {
    for (const f of ["index.md", "README.md"]) {
      const abs = inside(repoDir, `${rel}/${f}`);
      let text = "";
      try {
        text = abs ? fs.readFileSync(abs, "utf8").slice(0, 40_000) : "";
      } catch {
        continue;
      }
      // "Open it at …" names its own preview; a page that only mentions an earlier round's URL does not.
      const own = text.split("\n").find((l) => /\b(?:open (?:it )?at|served (?:at|on)|live at|preview(?: is)? at)\b/i.test(l) && [...l.matchAll(URL_RE)].some((m) => isTailnet(trimUrl(m[0]))));
      const u = [...(own ?? text).matchAll(URL_RE)].map((m) => trimUrl(m[0])).find(isTailnet);
      if (u && !out.has(portKey(u))) out.set(portKey(u), rel);
      if (text) break;
    }
  }
  return out;
}

/** First commit date of each file in the book's git log (newest first in), repo-relative path → ISO. */
export function firstDates(commits: { date: string; files: string[] }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of commits) for (const f of c.files) m.set(f, c.date);
  return m;
}

/** The preview port's folder, as shown: "the code repo/docs/proposals/e71-benefits", or the absolute path outside a repo. */
const servedFrom = (p: PreviewEntry): string => (p.repo && p.path !== undefined ? `${p.repo}/${p.path}`.replace(/\/$/, "") : p.dir);
const portKey = (u: string) => {
  try {
    const x = new URL(u);
    return `${TAILNET_NAMES()[x.hostname] ?? x.hostname}:${x.port}`;
  } catch {
    return u;
  }
};

interface Hit {
  url: string;
  label: string;
  near: string;
  date: string | null;
  row?: string;
  file?: string;
  /** Lower ranks win the label when one thing is found twice: a card's title, then a link's own words. */
  rank: number;
}

/** The epic's deliverables, newest first (undated last). */
export function deliverablesFor(s: DeliverableSources): Deliverable[] {
  const hits: Hit[] = [];
  const blob = (rel: string) => (s.remote ? `https://github.com/${s.remote}/${/\.[a-z0-9]+$/i.test(rel) ? "blob" : "tree"}/main/${rel}` : rel);

  /** Every link in one piece of text: markdown links with their words, then bare URLs with the words around them. */
  const scan = (text: string, ctx: { row?: string; date: string | null; about: string; from: string }) => {
    const start = hits.length;
    const bare = text.replace(MD_LINK, (all, words: string, target: string) => {
      const t = target.trim();
      const before = text.slice(Math.max(0, text.indexOf(all) - 60), text.indexOf(all));
      if (/^https?:\/\//i.test(t)) {
        const url = trimUrl(t);
        if (!SKIP_URL.test(url) && wholeHost(url)) hits.push({ url, label: GENERIC.test(stripInline(words).trim()) || ROW_CODE.test(words.trim()) ? "" : plainLabel(words), near: `${before} ${words}`, date: ctx.date, row: ctx.row, rank: 1 });
        else {
          // A GitHub link to a page in this repo is that page.
          const m = new RegExp(`^https://github\\.com/${(s.remote ?? "\u0000").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:blob|tree)/main/(docs/[^#?]+)`, "i").exec(url);
          if (m) hits.push({ url: "", file: m[1].replace(/\/+$/, ""), label: GENERIC.test(words.trim()) ? "" : plainLabel(words), near: before, date: ctx.date, row: ctx.row, rank: 1 });
        }
      } else {
        const rel = repoTarget(ctx.from, t);
        if (rel) hits.push({ url: "", file: rel, label: GENERIC.test(stripInline(words).trim()) || ROW_CODE.test(words.trim()) ? "" : plainLabel(words), near: `${before} ${words}`, date: ctx.date, row: ctx.row, rank: 1 });
      }
      return " ";
    });
    for (const m of bare.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      if (SKIP_URL.test(url) || !wholeHost(url)) continue;
      const at = m.index ?? 0;
      const after = /^\s*\(([^)]{3,140})\)/.exec(bare.slice(at + m[0].length))?.[1];
      const before = bare.slice(Math.max(0, at - 70), at).split(/[;|·]|\s[—–]\s/).pop() ?? "";
      // "(curl 200 2026-11-02)" is a check, not what the page is.
      const words = after && !/^\s*(?:curl|http|status|\d{3}\b)/i.test(after) ? after : lastClause(before);
      hits.push({ url, label: words && !GENERIC.test(words.trim()) && words.trim().split(/\s+/).length >= 2 ? plainLabel(words) : "", near: `${before} ${after ?? ""}`, date: ctx.date, row: ctx.row, rank: 2 });
    }
    // Hits from this text that found no words of their own say what the row or ask is about.
    if (ctx.about && !/^\s*!?\[[^\]]*\]\([^)]*\)\s*$/.test(ctx.about))
      for (const h of hits.slice(start)) if (!h.label) (h.label = plainLabel(ctx.about, 100)), (h.rank = 3);
  };

  // 1. The spine: every section but the ones that cite others (learnings, non-goals, the goal and why).
  const skipSection = /^(operating learnings|non-goals|goal|serves|done means|plain names|team|links|related)\b/i;
  const ledgerRows = new Set<string>();
  for (const sec of sections(s.markdown)) {
    if (sec.level !== 2 || skipSection.test(sec.title)) continue;
    for (const t of tables(sec.lines)) {
      const h = t.headers.map((x) => x.toLowerCase());
      const iDate = [h.findIndex((x) => /^(last verified|verified|updated|date|when)/.test(x)), h.findIndex((x) => /date/.test(x))].find((i) => i >= 0) ?? -1;
      const iTitle = h.findIndex((x) => /^(title|decision|what|task|ask)/.test(x));
      for (const r of t.rows) {
        const code = ROW_CODE.test(r.cells[0] ?? "") ? r.cells[0] : undefined;
        if (code && /issue ledger/i.test(sec.title)) ledgerRows.add(code);
        const date = (iDate >= 0 ? DATE.exec(r.cells[iDate] ?? "")?.[1] : undefined) ?? DATE.exec(r.cells.join(" "))?.[1] ?? null;
        const about = iTitle >= 0 ? r.cells[iTitle] ?? "" : r.cells[1] ?? "";
        for (const c of r.raw) scan(c, { row: code, date, about, from: s.spinePath });
      }
    }
    for (const line of sec.lines) {
      if (!line.trim() || line.trim().startsWith("|")) continue;
      // An ask, open or answered: `- [ask: …]`, `- [feedback …]`, `- [answered …]`.
      const ask = /\[[a-z]*\s*([A-Z][\w-]*-A\d+)\b[^\]]*\]\s*(.*)$/.exec(line);
      const date = DATE.exec(line)?.[1] ?? null;
      if (ask) scan(ask[2], { row: ask[1], date, about: ask[2].split(/\s[—–]\s/)[0], from: s.spinePath });
      else {
        const key = /^\s*(?:[-*]\s+)?(?:\*\*)?([A-Z][\w ]{2,30}?)(?:\*\*)?:\s/.exec(line)?.[1];
        scan(line, { row: /\b([A-Z]+\d*-[A-Z]{0,3}\d+)\b/.exec(line)?.[1], date, about: key && !/evidence|result|last attempted/i.test(key) ? `${key}` : "", from: s.spinePath });
      }
    }
  }

  // 2. The epic's review cards: the card's own title says what was delivered.
  const base = path.posix.basename(s.spinePath);
  for (const c of s.cards) {
    if (c.spine ? c.spine !== base : !ledgerRows.has(c.row)) continue;
    const date = s.fileDates.get(c.file)?.slice(0, 10) ?? null;
    const title = c.title ? plainLabel(c.title, 120) : "";
    for (const d of c.delivered) scan(d, { row: c.row, date, about: d, from: c.file });
    if (c.evidence) {
      const before = hits.length;
      scan(c.evidence, { row: c.row, date, about: c.title ?? "", from: c.file });
      for (const h of hits.slice(before)) if (title) (h.label = title), (h.rank = 0);
    }
    if (c.screenshot) {
      const rel = repoTarget(c.file, c.screenshot);
      if (rel) hits.push({ url: "", file: rel, label: title ? `Screenshot: ${title}` : "Screenshot", near: "screenshot", date, row: c.row, rank: 0 });
    }
  }

  // 3. The epic's own pages: docs/proposals/e71-…, docs/plans/e71-…, docs/status/e71-… (a page or folder per row).
  if (s.number !== undefined) {
    const mine = new RegExp(`^e${s.number}(?:-|$)`, "i");
    for (const rel of s.docEntries) {
      const name = path.posix.basename(rel);
      if (!mine.test(name)) continue;
      if (rel.startsWith("docs/status/") && !/\.(?:md|html?)$/i.test(name) && !isDir(s.repoDir, rel)) continue;
      const row = /^e(\d+)-([a-z]{0,3}\d+)/i.exec(name);
      hits.push({ url: "", file: rel, label: "", near: rel, date: null, row: row ? `E${row[1]}-${row[2].toUpperCase()}` : undefined, rank: 3 });
    }
  }

  // Resolve: repo files to their URL (a preview that serves the folder wins over GitHub), merge duplicates.
  const byDir = new Map<string, PreviewEntry>();
  for (const p of s.previews) if (p.path !== undefined && p.repo === path.basename(s.repoDir)) byDir.set(p.path.replace(/\/$/, ""), p);
  const byPort = new Map(s.previews.map((p) => [portKey(p.url), p]));
  const out = new Map<string, Deliverable & { rank: number }>();
  for (const h of hits) {
    let url = h.url;
    let file = h.file && /\/(?:index\.(?:html?|md)|README\.md)$/i.test(h.file) ? path.posix.dirname(h.file) : h.file;
    let servePath: string | undefined;
    if (file) {
      const served = byDir.get(file);
      url = served ? served.url : blob(file);
      if (served) servePath = servedFrom(served);
    } else if (isTailnet(url)) {
      const p = byPort.get(portKey(url));
      servePath = p ? servedFrom(p) : guessServed(s, url, h.near);
    }
    // A page's own heading says best what it is; then a card's title, the link's words, the words around it, the row.
    const titled = h.rank > 0 ? (file ? pageTitle(s.repoDir, file) : servedTitle(s, url, servePath)) : undefined;
    const rank = titled ? 0.5 : h.label ? h.rank : 9;
    const label = titled || h.label || (file ? nameOfPath(file) : servePath ? nameOfPath(servePath) : hostLabel(url));
    const kind = kindOf(file ?? url, label, h.near, !!file);
    const fileDate = file ? s.fileDates.get(file) ?? s.fileDates.get(firstFileUnder(s.fileDates, file) ?? "") : undefined;
    const date = (fileDate?.slice(0, 10) ?? h.date) || null;
    const key = urlKey(displayUrl(url));
    const prev = out.get(key);
    if (!prev) {
      out.set(key, {
        url: displayUrl(url),
        label,
        kind,
        date,
        ...(h.row ? { row: h.row } : {}),
        ...(file ? { file } : {}),
        ...(servePath ? { servePath } : {}),
        rank,
      });
      continue;
    }
    // The same thing twice: the earliest date is when it was made; the best words win the label.
    if (date && (!prev.date || date < prev.date)) prev.date = date;
    if (rank < prev.rank) (prev.label = label), (prev.rank = rank), (prev.kind = kindOf(file ?? url, label, h.near, !!file));
    if (!prev.row && h.row) prev.row = h.row;
    if (!prev.servePath && servePath) prev.servePath = servePath;
  }
  // A preview of a repo folder and that folder are one thing: keep the preview, with the folder as its fallback.
  const repo = s.repoName ?? path.basename(s.repoDir);
  for (const [k, d] of out) {
    if (!d.servePath?.startsWith(`${repo}/`) || d.file) continue;
    const rel = d.servePath.slice(repo.length + 1);
    const fk = urlKey(displayUrl(blob(rel)));
    const twin = out.get(fk);
    d.repoUrl = blob(rel);
    if (!twin || fk === k) continue;
    if (twin.date && (!d.date || twin.date < d.date)) d.date = twin.date;
    if (twin.rank < d.rank) (d.label = twin.label), (d.rank = twin.rank), (d.kind = twin.kind === "evidence" ? d.kind : twin.kind);
    if (!d.row && twin.row) d.row = twin.row;
    out.delete(fk);
  }
  const now = new Date().toISOString();
  return [...out.values()]
    .map(({ rank: _r, ...d }) => (d.file && !exists(s.repoDir, d.file) ? { ...d, check: { state: "gone" as const, at: now, detail: "no longer in the repo" } } : d))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.label.localeCompare(b.label));
}

const isDir = (repoDir: string, rel: string) => {
  try {
    return fs.statSync(inside(repoDir, rel) ?? "\u0000").isDirectory();
  } catch {
    return false;
  }
};
const exists = (repoDir: string, rel: string) => {
  const abs = inside(repoDir, rel);
  return !!abs && fs.existsSync(abs);
};
const firstFileUnder = (dates: Map<string, string>, dir: string): string | undefined => {
  let best: string | undefined;
  for (const [f, d] of dates) if (f.startsWith(`${dir}/`) && (!best || d < dates.get(best)!)) best = f;
  return best;
};
const hostLabel = (u: string) => {
  try {
    const x = new URL(u);
    if (isTailnet(u)) return `A page on ${(TAILNET_NAMES()[x.hostname] ?? x.hostname).split(".")[0]}, port ${x.port || 80}${x.pathname.length > 1 ? `, ${x.pathname.slice(1)}` : ""}`;
    const p = x.pathname.replace(/\/+$/, "");
    return p && p !== "/index.html" ? `${x.hostname}${p}` : x.hostname;
  } catch {
    return u;
  }
};

/** A preview the registry never saw: the folder named by its path (/e59-s16.html in docs/status/e59-s16) or the line's docs/ path. */
function guessServed(s: DeliverableSources, url: string, near: string): string | undefined {
  const repo = s.repoName ?? path.basename(s.repoDir);
  const noted = s.noted?.get(portKey(url));
  if (noted) return `${repo}/${noted}`;
  const fromText = /\b(docs\/(?:proposals|plans|status|reports)\/[\w.-]+)/.exec(near)?.[1];
  if (fromText && isDir(s.repoDir, fromText)) return `${repo}/${fromText}`;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0]?.replace(/\.html?$/i, "");
    if (seg) for (const d of ["docs/proposals", "docs/plans", "docs/status"]) if (isDir(s.repoDir, `${d}/${seg}`)) return `${repo}/${d}/${seg}`;
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** A URL whose host is cut short in the spine ("https://tea…") is not a link. */
const wholeHost = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h.includes(".") && !h.endsWith(".");
  } catch {
    return false;
  }
};

/** The words just before a bare URL: the last clause, without "is live at" and the like. */
function lastClause(before: string): string {
  const t = (before.split(/https?:\/\/\S+/).pop() ?? "")
    .replace(/[\s:(—–-]+$/, "")
    .split(/[:.]\s|\(|,\s|\s[—–]\s/)
    .pop()!
    .replace(/^\s*(?:and|or|plus|then|with)\s+/i, "")
    .replace(/^\s*(?:\d+[).]|step \d+:?)\s*/i, "");
  const words = t.replace(/\b(?:is |are |now )?(?:live |served |up )?(?:at|on|in|see|via|url|link)\s*[:(]?\s*$/i, "").replace(/[:(\s]+$/, "").trim();
  // A cut-off fragment ("paste the") says nothing: the row's own words are better.
  return /\b(?:the|a|an|to|at|of|in|on|and|or|for|from|your|its)$/i.test(words) ? "" : words;
}

/** The heading of the page a preview serves, when the registry or a guess names its folder in this repo. */
function servedTitle(s: DeliverableSources, url: string, servePath: string | undefined): string | undefined {
  const repo = s.repoName ?? path.basename(s.repoDir);
  if (!servePath?.startsWith(`${repo}/`)) return undefined;
  let rel = servePath.slice(repo.length + 1);
  try {
    const p = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
    if (p) rel = `${rel}/${p}`;
  } catch {
    /* the folder itself */
  }
  return pageTitle(s.repoDir, rel.replace(/\/+$/, ""));
}
