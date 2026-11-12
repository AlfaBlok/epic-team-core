import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { SpinesJson } from "../adapters/spines.js";
import { proseLines } from "../adapters/markdown.js";
import { sectionRange } from "../approvals.js";
import type { Milestone } from "../store.js";
import { movingLimit } from "../cycle/movement.js";
import { ownerName } from "../identity.js";

/**
 * "asked, no row yet". An open Done-means line in a runnable epic that no Issue Ledger row covers is
 * something asked for that no wake will build: sat like that, added from the console as lines with no
 * row. Each Delivery manager wake lists them (plan a row for each) and the Team home shows them, so none is invisible.
 * A row covers a criterion when it cites its id anywhere in the row: ``, a range `..3` / `..` /
 * `–3`, or a list ``, `, 2`.
 */
export interface AskedNoRow {
  milestoneId: string;
  milestoneTitle: string;
  /** Repo-relative spine path. */
  path: string;
  spineTitle: string;
  /** The Done-means id (``) and its text. */
  id: string;
  text: string;
}

const DM_OPEN = /^\s*[-*]\s+\[ \]\s+([A-Za-z]+\d+-\d+)\b[:.]?\s*(.*)$/;
const REF = /\b([A-Za-z]+\d+)-(\d+)\b((?:\s*(?:\.\.\.?|–|—)\s*(?:[A-Za-z]+\d+-)?\d+\b)?)((?:\s*[,/&]\s*\d{1,2}\b(?![-.\d]))*)/g;

/** Criterion ids the Issue Ledger rows of `text` cite (ranges and lists expanded). */
export function coveredIds(text: string): Set<string> {
  const out = new Set<string>();
  const r = sectionRange(text, /^(issue ledger|ledger)\b/i);
  if (!r) return out;
  const lines = proseLines(text).slice(r.head + 1, r.end).filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l));
  for (const l of lines) {
    for (const m of l.matchAll(REF)) {
      const [, prefix, first, range, list] = m;
      const a = Number(first);
      const to = range ? Number(/(\d+)\s*$/.exec(range)![1]) : a;
      for (let k = a; k <= Math.min(to, a + 50); k++) out.add(`${prefix}-${k}`);
      for (const x of list.matchAll(/\d+/g)) out.add(`${prefix}-${Number(x[0])}`);
    }
  }
  return out;
}

/** The unticked Done-means lines of `text` that no ledger row covers. */
export function uncoveredDoneMeans(text: string): { id: string; text: string }[] {
  const r = sectionRange(text, /^done means\b/i);
  if (!r) return [];
  const covered = coveredIds(text);
  const out: { id: string; text: string }[] = [];
  for (const l of proseLines(text).slice(r.head + 1, r.end)) {
    const m = DM_OPEN.exec(l.replace(/\r$/, ""));
    if (m && !covered.has(m[1])) out.push({ id: m[1], text: m[2].trim().slice(0, 300) });
  }
  return out;
}

const RUNNABLE = new Set(["ready", "active", "blocked"]);
const runnable = (n: SpinesJson["nodes"][number]) => (typeof n.runnable === "boolean" ? n.runnable : RUNNABLE.has(n.status.trim().toLowerCase()));

/** The spine at `rel` and every spine below it (each once). */
export function subtree(spines: SpinesJson, rel: string): SpinesJson["nodes"] {
  const out: SpinesJson["nodes"] = [];
  const seen = new Set<string>();
  const visit = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const n = spines.nodes.find((x) => x.path === p);
    if (!n) return;
    out.push(n);
    n.children.forEach(visit);
  };
  visit(rel);
  return out;
}

/** Open, uncovered Done-means lines of the runnable spines in a milestone's tree. */
export function askedNoRowFor(m: Pick<Milestone, "id" | "title">, repoDir: string, rel: string, spines: SpinesJson, read = (f: string) => fs.readFileSync(f, "utf8")): AskedNoRow[] {
  const out: AskedNoRow[] = [];
  for (const n of subtree(spines, rel).filter(runnable)) {
    let text: string;
    try {
      text = read(path.join(repoDir, n.path));
    } catch {
      continue;
    }
    for (const u of uncoveredDoneMeans(text)) out.push({ milestoneId: m.id, milestoneTitle: m.title, path: n.path, spineTitle: n.title, ...u });
  }
  return out;
}

export const ASKED_NO_ROW_MAX = 30;

/** The Delivery manager's wake section, or undefined when every open line has a row. */
export function askedNoRowSection(items: AskedNoRow[]): string | undefined {
  if (!items.length) return undefined;
  return [
    "## Asked, no row yet",
    "These open Done-means lines in runnable epics have no Issue Ledger row covering them (a row citing the id, or a range such as `E48-1..3`, covers it), so no wake builds them. " +
      `Plan a row for each in this wake (its title starts with the id, e.g. \`E48-4: …\`). Make it \`ready\` when ${ownerName()} asked for it (root L-37: a Decisions row naming ${ownerName()} and L-37, quoting his words); ` +
      "otherwise add it `draft` and name it in your summary. Never leave one without a row.",
    ...items.slice(0, ASKED_NO_ROW_MAX).map((i) => `- ${i.path} ${i.id}: ${i.text}`),
    ...(items.length > ASKED_NO_ROW_MAX ? [`- …and ${items.length - ASKED_NO_ROW_MAX} more (GET /api/asked-no-row)`] : []),
  ].join("\n");
}

/**
 * `GET /asked-no-row`: every milestone's open lines with no row, each once (the milestone whose spine it is wins). A list
 * missing a milestone whose spines were not read in time (`partial`, a cold cache after a deploy) is kept 5 s, not a minute.
 * per world. `world` is the caller's (the home world when auth is off), `list(world)` that world's milestones only, and the
 * memo and in-flight read are kept per world, so one world never sees another's lines.
 */
export function mountAskedNoRow(
  api: Hono,
  o: { list: (world: string) => Promise<{ items: AskedNoRow[]; partial?: boolean }>; world?: () => string; ttlMs?: number; now?: () => number },
) {
  const memo = new Map<string, { at: number; ttl: number; items: AskedNoRow[]; partial: boolean }>();
  const inFlight = new Map<string, Promise<{ items: AskedNoRow[]; partial?: boolean }>>();
  const now = o.now ?? Date.now;
  api.get("/asked-no-row", async (c) => {
    const w = o.world?.() ?? "";
    let m = memo.get(w);
    if (!m || now() - m.at > m.ttl) {
      let p = inFlight.get(w);
      if (!p) inFlight.set(w, (p = o.list(w).finally(() => inFlight.delete(w))));
      const r = await p;
      memo.set(w, (m = { at: now(), ttl: r.partial ? 5_000 : (o.ttlMs ?? 60_000), items: r.items, partial: !!r.partial }));
    }
    // `?limit=20|50|all`: the first n lines (the Team home's Show 20 / 50 / all) and how many there are.
    const limit = movingLimit(c.req.query("limit"));
    return c.json({ items: limit ? m.items.slice(0, limit) : m.items, total: m.items.length, ...(m.partial ? { partial: true } : {}) });
  });
}

/** One entry per spine line: prefer the milestone whose own spine holds it, else the first that saw it. */
export function dedupeAsked(lists: { repoDir: string; rel: string; items: AskedNoRow[] }[]): AskedNoRow[] {
  const by = new Map<string, { own: boolean; item: AskedNoRow }>();
  for (const l of lists)
    for (const i of l.items) {
      const k = `${l.repoDir}\0${i.path}\0${i.id}`;
      const own = i.path === l.rel;
      const had = by.get(k);
      if (!had || (own && !had.own)) by.set(k, { own, item: i });
    }
  return [...by.values()].map((v) => v.item);
}
