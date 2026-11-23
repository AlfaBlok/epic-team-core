import fs from "node:fs";
import path from "node:path";
import { inside } from "../adapters/doc.js";
import { section, stripInline, tables } from "../adapters/markdown.js";
import type { SpineNode, SpinesJson } from "../adapters/spines.js";
import { FEATURES_FILE, readFeatureLists, readTopJourneys, type FeatureList, type TopJourneys } from "./features.js";
import { deliverablesFor, firstDates, readCards, readDocEntries, readNotedPreviews, type Deliverable, type PreviewEntry } from "./deliverables.js";
import { applyFolds, readFolds } from "../folds.js";
import { readArchiveOf } from "../adapters/spineArchive.js";

/**
 * the Epic Book, one page that answers "where are we". Built from `spines.py --json` (goal,
 * serves, Current State, asks, Outcome), each spine's `## Decisions` table (the "why") and the repo's git log (the
 * timeline of fixes); never a hand-kept copy. This file is pure apart from reading spine files: the git log is passed
 * in (book/service.ts reads it in the background, never on a request).
 */

export interface BookCommit {
  sha: string;
  /** ISO commit date. */
  date: string;
  subject: string;
  /** Repo-relative paths the commit touched. */
  files: string[];
}

export interface BookDecision {
  date: string;
  outcome: string;
  decision: string;
  summary: string;
}

export interface BookEvent {
  date: string;
  kind: "commit" | "decision";
  text: string;
  sha?: string;
}

/** moving: open and nothing waits on a human; stuck: blocked or an open ask; parked: draft or deferred; done: done, review, superseded. */
export type BookState = "moving" | "stuck" | "parked" | "done";

export interface BookEpic {
  path: string;
  /** Short code from the title (M6) or the file name. */
  code: string;
  title: string;
  depth: number;
  parent: string | null;
  /** view-only fold (docs/epic-folds.json): the parent epic's path this one is shown inside; `parent` is that path too. */
  foldedInto?: string;
  status: string;
  state: BookState;
  goal: string | null;
  /** Why this way: the spine's Serves line and its Decisions, newest first. */
  serves: string | null;
  decisions: BookDecision[];
  /** Timeline of fixes, newest first (capped; `timelineTotal` counts all). */
  timeline: BookEvent[];
  timelineTotal: number;
  next: string | null;
  lastAttempted: string | null;
  verifiedAt: string | null;
  /** What it waits on (Current State `Waiting on`, when not none) and its open asks. */
  waitingOn: string | null;
  asks: { code: string; who: string; question: string }[];
  dod: { done: number; total: number };
  outcome: string | null;
  /** Link to the spine on GitHub when the repo has a GitHub origin. */
  href?: string;
  /** kept on the server for the per-milestone book (book/milestone.ts); `slimBook` drops them from GET /api/book. */
  doneMeans?: BookDoneMean[];
  result?: string | null;
  phase?: string | null;
  /** date of the newest commit that touched this spine file (ISO), for the book's "last updated". */
  spineChangedAt?: string | null;
  /** everything made for this epic (mockups, decks, proposals, live pages, evidence), newest first. */
  made?: Deliverable[];
}

export interface BookDoneMean {
  id: string;
  text: string;
  done: boolean;
}

/** one cell of the services x capabilities table, tested live and dated. */
export interface CapabilityCell {
  state: "works" | "stale" | "gap" | "n/a";
  summary: string;
  /** When it was last tested live (ISO). */
  tested: string;
  /** What the test ran (a read, a dry run, or why it could not run). */
  test: string;
  lastGood?: string;
  lastReal?: { at: string; what: string; url?: string };
  /** For a gap or a stale cell: why, and what fixes it. */
  why?: string;
  fix?: string;
  /** rework: the egress this cell needs, when it differs from the service's (e.g. X posts: "none (API)"). */
  egress?: string;
  /** The egress the act tool reported at the last live test (e.g. "laptop (MX 189.128.x.x)"). */
  egressSeen?: string;
  /** the plain word shown on the chip, and the reason + fix in plain words. */
  plain?: CapabilityPlain;
}

/** Works / Partly / Not yet, in words the owner reads cold. */
export type PlainWord = "works" | "partly" | "not yet" | "n/a";
export interface CapabilityPlain {
  word: PlainWord;
  text: string;
}

/** one line of the plain status block at the top of the table: a platform in a world. */
export interface CapabilityStatusLine extends CapabilityPlain {
  world: string;
  platform: string;
}

/** rework (the owner 2026-11-02): which network exit a service needs, and what happens when it is offline. */
export interface CapabilityEgress {
  /** One of the legend's keys: api, server, direct, laptop, proxy, none. */
  kind: string;
  /** Short label for the column, e.g. "the owner's Mac (laptop egress)". */
  label: string;
  /** What a seat gets when that egress is offline: HELD, refused, or "not affected". */
  offline?: string;
  /** Residential proxy needed? and other detail. */
  detail?: string;
  /** How the same service works in a tester world (its own Team Browser), when it differs. */
  tester?: string;
}

export interface CapabilityService {
  id: string;
  label: string;
  account?: string;
  route?: string;
  pending?: string;
  egress?: CapabilityEgress;
  cells: Record<string, CapabilityCell>;
}

export interface CapabilityTable {
  title: string;
  about: string;
  /** Who the table is for: any seat or persona launched from the code repo, per world. */
  scope?: string;
  checkedAt: string;
  states: Record<string, string>;
  /** Egress kinds → plain meaning (the legend under the table). */
  egressLegend?: Record<string, string>;
  /** the plain status block shown above the table, one line per platform and world. */
  plainStatus?: CapabilityStatusLine[];
  capabilities: { id: string; label: string }[];
  services: CapabilityService[];
  /** Other team services a seat can use (MCP servers, APIs) with their egress; not in the capability grid. */
  other?: { id: string; label: string; what: string; egress: CapabilityEgress; tested?: string }[];
  /** Repo-relative path of the data file, and its GitHub link when the repo has one. */
  source: string;
  href?: string;
}

/** The data file a repo keeps its capability table in; refreshed by browser/scripts/probe-service-capabilities.py. */
export const CAPABILITIES_FILE = "docs/status/service-capabilities.json";
const CELL_KEYS = ["state", "summary", "tested", "test", "lastGood", "lastReal", "why", "fix", "egress", "egressSeen", "plain"] as const;
const PLAIN_WORDS: readonly string[] = ["works", "partly", "not yet", "n/a"];
const isPlain = (p: any): boolean => !!p && typeof p === "object" && PLAIN_WORDS.includes(p.word) && typeof p.text === "string";
const EGRESS_KEYS = ["kind", "label", "offline", "detail", "tester"] as const;
const pickEgress = (e: any): CapabilityEgress | undefined =>
  e && typeof e === "object" && e.kind && e.label ? (Object.fromEntries(EGRESS_KEYS.filter((k) => e[k] !== undefined).map((k) => [k, String(e[k])])) as unknown as CapabilityEgress) : undefined;

/** The repo's capability table, or undefined when it has none (or it does not parse). Probe specs stay out of the payload. */
export function readCapabilities(repoDir: string, remote?: string): CapabilityTable | undefined {
  const abs = inside(repoDir, CAPABILITIES_FILE);
  let raw: any;
  try {
    raw = abs ? JSON.parse(fs.readFileSync(abs, "utf8")) : undefined;
  } catch {
    return undefined;
  }
  if (!raw || !Array.isArray(raw.capabilities) || !Array.isArray(raw.services)) return undefined;
  const pick = (c: any): CapabilityCell =>
    Object.fromEntries(CELL_KEYS.filter((k) => c?.[k] !== undefined && (k !== "plain" || isPlain(c[k]))).map((k) => [k, c[k]])) as unknown as CapabilityCell;
  return {
    title: String(raw.title ?? "Capabilities"),
    about: String(raw.about ?? ""),
    ...(raw.scope ? { scope: String(raw.scope) } : {}),
    checkedAt: String(raw.checkedAt ?? ""),
    states: raw.states && typeof raw.states === "object" ? raw.states : {},
    ...(raw.egressLegend && typeof raw.egressLegend === "object" ? { egressLegend: raw.egressLegend } : {}),
    ...(Array.isArray(raw.plainStatus)
      ? {
          plainStatus: raw.plainStatus
            .filter((l: any) => isPlain(l) && l.world && l.platform)
            .map((l: any) => ({ world: String(l.world), platform: String(l.platform), word: l.word, text: String(l.text) })),
        }
      : {}),
    capabilities: raw.capabilities.map((c: any) => ({ id: String(c.id), label: String(c.label ?? c.id) })),
    services: raw.services.map((s: any) => ({
      id: String(s.id),
      label: String(s.label ?? s.id),
      ...(s.account ? { account: String(s.account) } : {}),
      ...(s.route ? { route: String(s.route) } : {}),
      ...(s.pending ? { pending: String(s.pending) } : {}),
      ...(pickEgress(s.egress) ? { egress: pickEgress(s.egress) } : {}),
      cells: Object.fromEntries(Object.entries(s.cells ?? {}).map(([k, c]) => [k, pick(c)])),
    })),
    ...(Array.isArray(raw.other)
      ? {
          other: raw.other
            .filter((o: any) => o?.id && pickEgress(o.egress))
            .map((o: any) => ({ id: String(o.id), label: String(o.label ?? o.id), what: String(o.what ?? ""), egress: pickEgress(o.egress)!, ...(o.tested ? { tested: String(o.tested) } : {}) })),
        }
      : {}),
    source: CAPABILITIES_FILE,
    ...(remote ? { href: `https://github.com/${remote}/blob/main/${CAPABILITIES_FILE}` } : {}),
  };
}

export interface BookRepo {
  name: string;
  remote?: string;
  root: string | null;
  epics: BookEpic[];
  counts: Record<BookState, number>;
  /** the repo's services x capabilities table, when it keeps one (docs/status/service-capabilities.json). */
  capabilities?: CapabilityTable;
  /** the service's feature list, when the repo keeps one (docs/features/epicteam.json). */
  features?: FeatureList;
  /** Every service's feature list in the repo (docs/features/*.json), EpicTeam's first; set when there is more than one. */
  featureLists?: FeatureList[];
  /** The ranked top hero journeys (docs/features/hero-journeys.json `top`), the ones shown first. */
  topJourneys?: TopJourneys;
  /** spines.py or git failed for this repo: the reason (the repo still shows with what was read). */
  error?: string;
}

export interface Book {
  builtAt: string;
  repos: BookRepo[];
  counts: Record<BookState, number>;
}

/** Open epics keep this many timeline entries; done and parked ones a few (the payload stays small for a phone). */
export const TIMELINE_CAP = 15;
export const CLOSED_TIMELINE_CAP = 4;
const DECISIONS_CAP = 6;
const NONE = /^(none|nothing|nobody|no one|n\/a|-|—)\b/i;

const clean = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const t = stripInline(s).trim();
  return t && !NONE.test(t) ? t : null;
};

export function stateOf(status: string, waitingOn: string | null, openAsks: number): BookState {
  const s = status.toLowerCase();
  if (/^(done|review|superseded|testing)/.test(s)) return "done";
  if (/^(draft|deferred|paused|parked)/.test(s)) return "parked";
  if (s.startsWith("blocked") || openAsks > 0 || waitingOn) return "stuck";
  return "moving";
}

/** → 40, ": M6 — …" → 6, "M2 — …" → 2; undefined when the title carries no number. */
export function epicNumber(title: string): number | undefined {
  const m = /^\s*(?:EPIC-(\d+)|M(\d+))\b/i.exec(title);
  return m ? Number(m[1] ?? m[2]) : undefined;
}

export function codeOf(n: SpineNode): string {
  const m = /^\s*(EPIC-\d+|M\d+)\b/i.exec(n.title || "");
  return m ? m[1].toUpperCase() : path.basename(n.path, ".md");
}

/** Matches a commit subject that names epic `n` or one of its rows; never. */
export function codeMatcher(n: number): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9-])(?:EPIC-${n}|M${n}|[EM]${n}-[A-Z]{0,3}\\d+)(?![0-9])`, "i");
}

/** `## Decisions` rows (Date | Outcome | Decision | Durable Summary …), newest first. */
export function parseDecisions(markdown: string): BookDecision[] {
  const s = section(markdown, /^decisions\b/i);
  if (!s) return [];
  const out: BookDecision[] = [];
  for (const t of tables(s.lines)) {
    const h = t.headers.map((x) => x.toLowerCase());
    const at = (re: RegExp) => h.findIndex((x) => re.test(x));
    const iDate = at(/^date/);
    const iOut = at(/^(outcome|status|verdict)/);
    const iDec = at(/^(decision|attempt|what)/);
    const iSum = at(/^(durable summary|summary|why|rationale)/);
    if (iDate < 0 || (iDec < 0 && iSum < 0)) continue;
    for (const r of t.rows) {
      const date = r.cells[iDate] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
      out.push({
        date: date.slice(0, 10),
        outcome: iOut >= 0 ? r.cells[iOut] ?? "" : "",
        decision: iDec >= 0 ? r.cells[iDec] ?? "" : "",
        summary: iSum >= 0 ? r.cells[iSum] ?? "" : "",
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * `git log --format=%x1e%h%x1f%cI%x1f%s --name-only` output → commits. One record per commit: a 0x1e separator, the
 * header line, then the touched files.
 */
export function parseGitLog(text: string): BookCommit[] {
  const out: BookCommit[] = [];
  for (const rec of text.split("\x1e")) {
    const lines = rec.split("\n");
    const [sha, date, subject] = (lines[0] ?? "").split("\x1f");
    if (!sha || !date) continue;
    const t = Date.parse(date);
    out.push({ sha, date: Number.isNaN(t) ? date : new Date(t).toISOString(), subject: subject ?? "", files: lines.slice(1).map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

const readSpine = (repoDir: string, rel: string): string => {
  const abs = inside(repoDir, rel);
  try {
    return abs ? fs.readFileSync(abs, "utf8") : "";
  } catch {
    return "";
  }
};

function openAsks(n: SpineNode): BookEpic["asks"] {
  const w = (n as { waiting_on?: unknown }).waiting_on;
  if (!Array.isArray(w)) return [];
  return w
    .filter((a) => a && (a.state ?? "open") === "open")
    .map((a) => ({ code: String(a.code ?? ""), who: String(a.who ?? ""), question: stripInline(String(a.question ?? a.ask ?? "")) }));
}

/** Commits of one epic: those touching its spine or its linked pages, or naming its code in the subject. */
/** A sync merge of the integration branch into a work branch ("Merge remote-tracking branch 'origin/main' into wt/x"): not a fix. */
export const SYNC_MERGE = /^Merge (?:remote-tracking )?branch '(?:origin\/)?(?:main|master)'/;

/**
 * the commits once per build, sync merges out, with an index file -> commits: every epic scanned every commit's
 * file list (60 epics x thousands of commits, up to 0.6 s of one console stall).
 */
interface CommitIndex {
  real: BookCommit[];
  byFile: Map<string, number[]>;
}
function indexCommits(commits: BookCommit[]): CommitIndex {
  const real = commits.filter((c) => !SYNC_MERGE.test(c.subject));
  const byFile = new Map<string, number[]>();
  real.forEach((c, i) => {
    for (const f of new Set(c.files)) {
      const at = byFile.get(f);
      if (at) at.push(i);
      else byFile.set(f, [i]);
    }
  });
  return { real, byFile };
}

function commitsFor(n: SpineNode, ix: CommitIndex): BookCommit[] {
  const files = new Set([n.path, ...(n.pages ?? []).map((p) => p.path)]);
  const num = epicNumber(n.title || "");
  const re = num !== undefined ? codeMatcher(num) : undefined;
  const hit = new Set<number>();
  for (const f of files) for (const i of ix.byFile.get(f) ?? []) hit.add(i);
  if (re) ix.real.forEach((c, i) => re.test(c.subject) && hit.add(i));
  return [...hit].sort((a, b) => a - b).map((i) => ix.real[i]);
}

export function buildRepoBook(
  repo: { name: string; path: string; remote?: string },
  spines: SpinesJson,
  commits: BookCommit[],
  error?: string,
  opts: { previews?: PreviewEntry[] } = {},
): BookRepo {
  const depth = new Map<string, number>();
  const counts: Record<BookState, number> = { moving: 0, stuck: 0, parked: 0, done: 0 };
  const ix = indexCommits(commits);
  // read once per repo, shared by every epic's "everything made for this".
  const docEntries = readDocEntries(repo.path);
  const made = { fileDates: firstDates(commits), cards: readCards(repo.path), docEntries, noted: readNotedPreviews(repo.path, docEntries), previews: opts.previews ?? [] };
  const nodes = applyFolds(spines.nodes, readFolds(repo.path));
  const epics: BookEpic[] = nodes.map((n) => {
    const d = n.parent && depth.has(n.parent) ? depth.get(n.parent)! + 1 : 0;
    depth.set(n.path, d);
    const cs = (n.current_state ?? {}) as Record<string, unknown>;
    const asks = openAsks(n);
    const waitingOn = clean(cs.waiting_on);
    const status = (n.status || String(cs.status ?? "") || "unknown").toLowerCase();
    const state = stateOf(status, waitingOn, asks.length);
    counts[state]++;
    const markdown = readSpine(repo.path, n.path);
    const archive = readArchiveOf(path.join(repo.path, n.path));
    // its older decisions moved to the archive stay on its Book page
    const decisions = archive ? [...parseDecisions(markdown), ...parseDecisions(archive)].sort((x, y) => y.date.localeCompare(x.date)) : parseDecisions(markdown);
    const mine = commitsFor(n, ix);
    const events: BookEvent[] = [
      ...mine.map((c) => ({ date: c.date, kind: "commit" as const, text: c.subject, sha: c.sha })),
      ...decisions.map((x) => ({ date: x.date, kind: "decision" as const, text: [x.decision, x.summary].filter(Boolean).join(": ") })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const dod = n.done_means?.length ? n.done_means : n.dod;
    return {
      path: n.path,
      code: codeOf(n),
      title: n.title || path.basename(n.path, ".md"),
      depth: d,
      parent: n.parent,
      ...(n.folded_into ? { foldedInto: n.folded_into } : {}),
      status,
      state,
      goal: clean(n.goal),
      serves: clean(n.serves),
      decisions: decisions.slice(0, state === "moving" || state === "stuck" ? DECISIONS_CAP : 2),
      timeline: events.slice(0, state === "moving" || state === "stuck" ? TIMELINE_CAP : CLOSED_TIMELINE_CAP),
      timelineTotal: events.length,
      next: clean(cs.next_action),
      lastAttempted: clean(cs.last_attempted),
      verifiedAt: clean(cs.verified_at),
      waitingOn,
      asks,
      dod: { done: dod.filter((i) => i.done).length, total: dod.length },
      outcome: clean(n.outcome?.sentence),
      doneMeans: dod.map((i) => ({ id: String(i.id ?? ""), text: stripInline(String(i.text ?? "")), done: !!i.done })),
      result: clean(cs.result),
      phase: clean(cs.phase),
      spineChangedAt: commits.find((c) => c.files.includes(n.path))?.date ?? null,
      made: deliverablesFor({ repoDir: repo.path, repoName: repo.name, remote: repo.remote, spinePath: n.path, markdown: withArchiveText(markdown, archive), number: epicNumber(n.title || ""), ...made }),
      ...(repo.remote ? { href: `https://github.com/${repo.remote}/blob/main/${n.path}` } : {}),
    };
  });
  const capabilities = readCapabilities(repo.path, repo.remote);
  const featureLists = readFeatureLists(repo.path, repo.remote);
  const features = featureLists.find((f) => f.source === FEATURES_FILE) ?? featureLists[0];
  const topJourneys = readTopJourneys(repo.path, repo.remote);
  return { name: repo.name, ...(repo.remote ? { remote: repo.remote } : {}), root: spines.root, epics, counts, ...(capabilities ? { capabilities } : {}), ...(topJourneys ? { topJourneys } : {}), ...(features ? { features } : {}), ...(featureLists.length > 1 ? { featureLists } : {}), ...(error ? { error } : {}) };
}

/** GET /api/book keeps its shape and size: the per-milestone fields stay on the server. */
export function slimBook(book: Book): Book {
  return {
    ...book,
    repos: book.repos.map((r) => ({ ...r, epics: r.epics.map(({ doneMeans: _d, result: _r, phase: _p, spineChangedAt: _s, ...e }) => e) })),
  };
}

export function assembleBook(repos: BookRepo[], now: Date): Book {
  const counts: Record<BookState, number> = { moving: 0, stuck: 0, parked: 0, done: 0 };
  for (const r of repos) for (const k of Object.keys(counts) as BookState[]) counts[k] += r.counts[k];
  return { builtAt: now.toISOString(), repos, counts };
}

/** an epic's spine and its archive's finished rows, read as one: what it made stays on its Book page. */
export function withArchiveText(markdown: string, archive: string | undefined): string {
  return archive ? `${markdown}\n\n${archive.replace(/^# .*$/m, "")}` : markdown;
}
