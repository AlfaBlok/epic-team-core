import fs from "node:fs";
import { turnerOf } from "./personaGaps.js";
import path from "node:path";
import { ledgerLines } from "./review/rows.js";
import { FOLDS_FILE, foldMap, parseFolds } from "./folds.js";
import { doneMeansOf, epicHeading, type PursuitsBody } from "./pursuits.js";

/**
 * The scorecard tree (the owner vn_fe52ef4a 2026-11-12 22:19Z: "for each entry on the left,
 * on the sidebar, is a scorecard ... They can be inside of each other ... you should see the scorecard. You should be
 * able to chat. You should be able to see the queues, the inbox for that entry. And then at the top ... the aggregated
 * inbox ... I can sort across all the scorecards").
 *
 * GET /api/scorecards: every pursuit (in his order) is a scorecard; the epics that carry it are scorecards inside it, and
 * their child epics inside those (a child is a linked spine whose `Parent spine:` points back). Each node names the spines
 * of its whole subtree (`spines`, "repo:path"); `spineInfo` holds, per spine, its open ask codes, its row codes and its
 * queue (rows ready, running or waiting). The web matches the inbox (open asks of the status batch, review cards) to a
 * scorecard by those codes and paths, so one list serves the sidebar, every scorecard and the aggregated inbox.
 */

export type QueueState = "ready" | "running" | "waiting";
export interface QueueRow {
  code: string;
  title: string;
  state: QueueState;
  /** the status cell's first words ("ready", "active (iteration 2 …)"), cut short. */
  status: string;
}
export interface SpineInfo {
  repo: string;
  path: string;
  code?: string;
  title?: string;
  doneMeans: { done: number; total: number };
  /** the spine's `Goal sentence:` line: the objective of the epic. */
  goal?: string;
  /** each Done-means box: its id, words and whether it is ticked. */
  boxes: { id: string; text: string; done: boolean }[];
  /** codes of the rows and asks written in this spine (the inbox matches its items by them). */
  codes: string[];
  queue: QueueRow[];
  /** rows whose status reads review (a card for the owner): the wheel waits on him, not idle. */
  review?: string[];
}
export type RowState = "green" | "amber" | "red" | "unknown";
/** one measurable row of a scorecard's table (the owner vn_fd4f7a7a: "a table of measurable rows coloured green/amber/red"). */
export interface ScorecardRow {
  label: string;
  state: RowState;
  /** what it measures now ("3 of 5", "12 testers"). */
  value: string;
  target?: string;
  /** key-result and health come from the scorecard's file (OKR shape); check, epic and done-means are read live. */
  kind: "key-result" | "health" | "check" | "epic" | "done-means" | "flow";
  note?: string;
  /** the proposal's shape: the row's group heading, where its value is read, the date its target is due. */
  group?: string;
  source?: string;
  by?: string;
  /** the epics and tickets working to turn this row green (the owner vn_c15874bc); empty = nothing works on it. */
  work?: WorkLink[];
  /** when it last turned green (this console's history), for today's and this week's count. */
  greenSince?: string;
  /** a key result: the Done-means box of its epic it measures (E907-4), or how it is read ("check", "light"). */
  doneMeans?: string;
  /** the file's `live` spec, read by the source registered for its kind; dropped once read. */
  live?: LiveSpec;
}

/** a key result's `live` spec in its set's file: `kind` names the source, the rest is the source's own settings. */
export type LiveSpec = { kind: string } & Record<string, unknown>;
/** what a live source answers: the value in words and its colour; undefined keeps the file's value. */
export interface LiveAnswer {
  value: string;
  state: RowState;
  note?: string;
}
export type LiveSource = (spec: LiveSpec) => Promise<LiveAnswer | undefined>;
const LIVE_SOURCES = new Map<string, LiveSource>();
/** the hosted layer names a live source once at load (a product's tester count, say); the open core has none. */
export function registerLiveKeyResult(kind: string, source: LiveSource): void {
  LIVE_SOURCES.set(kind, source);
}
/** every key result with a `live` spec read now: its value and colour replace the file's; a failed read keeps them. */
export async function applyLiveKeyResults<T extends { nodes: ScorecardNode[] }>(body: T): Promise<T> {
  const all: ScorecardRow[] = [];
  const walk = (n: ScorecardNode) => {
    all.push(...(n.keyResults ?? []));
    n.children.forEach(walk);
  };
  body.nodes.forEach(walk);
  await Promise.all(
    all.map(async (r) => {
      const spec = r.live;
      delete r.live;
      const src = spec ? LIVE_SOURCES.get(spec.kind) : undefined;
      if (!spec || !src) return;
      try {
        const a = await src(spec);
        if (!a) return;
        r.value = a.value;
        r.state = a.state;
        if (a.note) r.note = a.note;
        else delete r.note;
      } catch {
        // the file's value stands until the next read
      }
    }),
  );
  return body;
}
export interface WorkLink {
  code: string;
  repo: string;
  title?: string;
  /** a ticket's status word, or an epic's Done-means count. */
  status?: string;
  kind: "epic" | "ticket" | "done-means" | "unknown";
  /** its colour: done green, moving amber, stuck red, unknown grey. */
  state?: RowState;
  /** the spine it lives in (the deck link). */
  path?: string;
  epicCode?: string;
}
export interface ScorecardTeam {
  persona: string;
  enabled: boolean;
  parked?: boolean;
  pace: string;
  paceNow: string;
}
export interface ScorecardNode {
  /** pursuit id, or `<pursuit id>~<repo>:<path>` for an epic inside it. */
  id: string;
  kind: "pursuit" | "epic";
  name: string;
  /** pursuit: its rank (1 first; null parked). */
  rank?: number | null;
  parked?: boolean;
  repo?: string;
  path?: string;
  code?: string;
  /** the milestone whose chat (repo desk) this scorecard talks to. */
  milestoneId?: string;
  /** green lines / lines (pursuit) or Done-means boxes ticked / boxes (epic). */
  greens: number;
  total: number;
  state?: string;
  motion?: string;
  /** "repo:path" of every spine in this scorecard's subtree, itself first. */
  spines: string[];
  children: ScorecardNode[];
  /** its table, file rows first, then the rows read live. */
  rows: ScorecardRow[];
  /** the Objective: a set's file, or its epic's Goal sentence (else the pursuit's green-when line). */
  objective?: string;
  /** the short objective the sidebar and the page lead with (a set's file `objective`), and whether he agreed it. */
  headline?: string;
  objectiveStatus?: "proposed" | "agreed";
  /** the longer line it replaces, kept for the record. */
  objectiveWas?: string;
  /** the file its rows come from (docs/scorecards/<pursuit id>.json in the home repo), present or not. */
  file?: { path: string; present: boolean; proposal?: string };
  /** the personas on the milestone that runs it. */
  teams?: ScorecardTeam[];
  /** no Delivery Manager turns it ("none") or its one is switched off ("off"); the objectives screen flags it. */
  noPersona?: "none" | "off";
  /**
   * Its key results (the owner's yes to the objectives mock-up: "build as shown"): 4 to 6 coloured rows, each the epic's
   * Done-means box it measures, its value now and the work under it. A set's come from its file; an epic's are its
   * Done means.
   */
  keyResults?: ScorecardRow[];
  /** the spine whose Goal sentence is this objective ("app EPIC-907"). */
  spineRef?: { repo: string; code: string };
  /** the child epics the sidebar shows under the objective, in short words, each its own scorecard. */
  sidebar?: { id: string; name: string; greens: number; total: number }[];
  /** shown inside another objective (its file's `foldedInto`): the sidebar and the all list leave it out. */
  foldedInto?: string;
  /** the wheel's owner persona, the one the idle watch wakes. */
  owner?: string;
  /** set by the idle watch: below all-green with no worker, no ask and no card: it must move. */
  idle?: { idle: boolean; reason: string; nudgedAt?: string; runId?: string };
}
export interface ScorecardsBody {
  nodes: ScorecardNode[];
  spineInfo: Record<string, SpineInfo>;
}

const MAX_SPINES = 400;
/** how deep the sidebar nests epics under a pursuit (the declared epic is depth 1). */
const NODE_DEPTH = 3;
const LINK = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;
const ASK_CODE = /\[ask\s+([A-Z][A-Z0-9]*-[A-Z]*\d+)\b/g;

export function queueStateOf(status: string): QueueState | null {
  const w = status.trim().toLowerCase().replace(/^[*_`]+/, "");
  if (/^(ready|queued)\b/.test(w)) return "ready";
  if (/^(active|dispatched|claimed|running|in progress|in-progress|doing|monitoring)\b/.test(w)) return "running";
  if (/^(blocked|waiting|pending|needs|on hold)\b/.test(w)) return "waiting";
  return null;
}

const strip = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").trim();
/** a row's task cell, shortened to its name ("Pursuits in priority order: …" → "Pursuits in priority order"). */
export function rowTitle(cell: string): string {
  const t = strip(cell);
  const head = t.split(/:\s/)[0];
  const out = head.length >= 8 ? head : t;
  return out.length > 140 ? `${out.slice(0, 138)}…` : out;
}

/** One spine's facts and the spines that name it as their parent (relative to the repo). */
export function readSpineInfo(repo: string, rel: string, text: string): SpineInfo & { links: string[]; parent?: string } {
  const head = epicHeading(text);
  const dm = doneMeansOf(text, []);
  const codes = new Set<string>();
  const queue: QueueRow[] = [];
  const review: string[] = [];
  for (const r of ledgerLines(text)) {
    if (!/^[A-Z][A-Z0-9]*-[A-Z]*\d+/.test(r.id)) continue;
    codes.add(r.id);
    const status = r.col.status >= 0 ? strip(r.cells[r.col.status] ?? "") : "";
    const state = queueStateOf(status);
    if (/^review\b/i.test(status)) review.push(r.id);
    if (state) queue.push({ code: r.id, title: rowTitle(r.col.title >= 0 ? r.cells[r.col.title] ?? r.id : r.id), state, status: status.length > 60 ? `${status.slice(0, 58)}…` : status });
  }
  for (const m of text.matchAll(ASK_CODE)) codes.add(m[1]);
  const sec = /^##\s+Done means\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const boxes = [...sec.matchAll(/^\s*-\s*\[( |x|X)\]\s*(\S+)\s*(.*)$/gm)].map((m) => {
    const words = strip(m[3]);
    return { id: m[2].replace(/[*`:]/g, ""), text: words.length > 120 ? `${words.slice(0, 118)}…` : words, done: m[1].toLowerCase() === "x" };
  });
  const parentRef = /^\s*Parent spine:\s*(.*)$/im.exec(text)?.[1];
  const parent = parentRef ? (/\]\(([^)\s#]+\.md)/.exec(parentRef)?.[1] ?? /([\w./-]+\.md)\b/.exec(parentRef)?.[1]) : undefined;
  const goal = /^\s*Goal sentence:\s*(.+)$/im.exec(text)?.[1]?.trim();
  return {
    repo,
    path: rel,
    ...head,
    ...(goal ? { goal: strip(goal) } : {}),
    doneMeans: { done: dm.done, total: dm.total },
    boxes,
    codes: [...codes],
    queue,
    ...(review.length ? { review } : {}),
    links: [...new Set([...text.matchAll(LINK)].map((m) => m[1]).filter((t) => !/^[a-z]+:/i.test(t)))],
    ...(parent ? { parent } : {}),
  };
}

export const spineKey = (repo: string, p: string) => `${repo}:${p.replace(/^\.\//, "")}`;

/** one goal set's file (docs/scorecards/<pursuit id>.json in the home repo): its Objective and its declared rows, OKR-shaped. */
export interface ScorecardFile {
  objective?: string;
  objectiveStatus?: "proposed" | "agreed";
  objectiveWas?: string;
  /** where the shape came from. */
  proposal?: string;
  /** the key results: label, the Done-means id it measures, value, note (due date, aim), colour, work codes. */
  keyResults?: { label: string; doneMeans?: string; value?: string; note?: string; target?: string; colour?: RowState; work?: string[]; live?: LiveSpec }[];
  /** "repo CODE" of the epic whose Goal sentence is the objective. */
  spine?: string;
  /** the child epics the sidebar shows, short names: { epic: "EPIC-907" or a spine path, name }. */
  sidebar?: { epic: string; name: string }[];
  /** another set's id this one is shown inside. */
  foldedInto?: string;
  rows?: { label: string; kind?: "key-result" | "health"; group?: string; source?: string; target?: string; by?: string; value?: string; colour?: RowState; state?: RowState; note?: string; line?: string; work?: string[] }[];
}
export const SCORECARD_DIR = "docs/scorecards";

const shareState = (done: number, total: number): RowState => (!total ? "unknown" : done >= total ? "green" : done === 0 ? "red" : "amber");
const ROW_STATES = new Set(["green", "amber", "red", "unknown"]);

export function parseScorecardFile(text: string): ScorecardFile | null {
  try {
    const o = JSON.parse(text) as ScorecardFile;
    if (!o || typeof o !== "object") return null;
    const rows = Array.isArray(o.rows) ? o.rows.filter((r) => r && typeof r.label === "string" && r.label.trim()) : [];
    return {
      ...(typeof o.objective === "string" ? { objective: o.objective } : {}),
      ...(o.objectiveStatus === "proposed" || o.objectiveStatus === "agreed" ? { objectiveStatus: o.objectiveStatus } : {}),
      ...(typeof o.objectiveWas === "string" ? { objectiveWas: o.objectiveWas } : {}), ...(typeof o.proposal === "string" ? { proposal: o.proposal } : {}),
      ...(Array.isArray(o.keyResults) ? { keyResults: o.keyResults.filter((r) => r && typeof r.label === "string" && r.label.trim()) } : {}),
      ...(typeof o.spine === "string" && o.spine.trim() ? { spine: o.spine.trim() } : {}),
      ...(Array.isArray(o.sidebar) ? { sidebar: o.sidebar.filter((k) => k && typeof k.epic === "string" && typeof k.name === "string") } : {}),
      ...(typeof o.foldedInto === "string" && o.foldedInto.trim() ? { foldedInto: o.foldedInto.trim() } : {}),
      rows };
  } catch {
    return null;
  }
}

type PursuitIn = PursuitsBody["pursuits"][number] & { milestones?: { id: string; teams?: ScorecardTeam[] }[] };
export function buildScorecards(
  body: Omit<PursuitsBody, "pursuits"> & { pursuits: PursuitIn[] },
  read: (repo: string, rel: string) => string | undefined,
  o: { file?: (pursuitId: string) => string | undefined; work?: (repo: string, code: string) => WorkLink; homeRepo?: string } = {},
): ScorecardsBody {
  const spineInfo: Record<string, SpineInfo> = {};
  const kids = new Map<string, string[]>();
  // view-only folds (docs/epic-folds.json): a folded epic is a scorecard inside its fold parent, not its old parent.
  const foldsByRepo = new Map<string, Map<string, string>>();
  const foldsOf = (repo: string): Map<string, string> => {
    let m = foldsByRepo.get(repo);
    if (!m) foldsByRepo.set(repo, (m = foldMap(parseFolds(read(repo, FOLDS_FILE)), (p) => read(repo, p) !== undefined)));
    return m;
  };
  const info = (repo: string, rel: string): SpineInfo | undefined => {
    const key = spineKey(repo, rel);
    if (spineInfo[key]) return spineInfo[key];
    if (Object.keys(spineInfo).length >= MAX_SPINES) return undefined;
    const text = read(repo, rel);
    if (text === undefined) return undefined;
    const { links, parent: _parent, ...facts } = readSpineInfo(repo, rel, text);
    spineInfo[key] = facts;
    // children: a linked spine whose Parent spine points back at this one.
    const children: string[] = [];
    for (const target of links) {
      const child = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
      if (child.startsWith("..") || child === rel) continue;
      const ct = read(repo, child);
      if (ct === undefined) continue;
      const pr = /^\s*Parent spine:\s*(.*)$/im.exec(ct)?.[1];
      const pt = pr ? (/\]\(([^)\s#]+\.md)/.exec(pr)?.[1] ?? /([\w./-]+\.md)\b/.exec(pr)?.[1]) : undefined;
      if (!pt || path.posix.normalize(path.posix.join(path.posix.dirname(child), pt)) !== rel) continue;
      if (!children.includes(child)) children.push(child);
    }
    const folds = foldsOf(repo);
    const own = children.filter((c) => !folds.has(c) || folds.get(c) === rel);
    for (const [c, p] of folds) if (p === rel && !own.includes(c)) own.push(c);
    kids.set(key, own);
    return facts;
  };
  /** the subtree's spines, breadth first, each once. */
  const subtree = (repo: string, rel: string): string[] => {
    const out: string[] = [];
    const todo = [rel];
    const seen = new Set<string>();
    while (todo.length) {
      const at = todo.shift()!;
      if (seen.has(at)) continue;
      seen.add(at);
      if (!info(repo, at)) continue;
      out.push(spineKey(repo, at));
      todo.push(...(kids.get(spineKey(repo, at)) ?? []));
    }
    return out;
  };
  const epicNode = (pid: string, repo: string, rel: string, depth: number, milestoneId?: string, seen = new Set<string>()): ScorecardNode | null => {
    const facts = info(repo, rel);
    if (!facts) return null;
    const key = spineKey(repo, rel);
    seen.add(key);
    const children =
      depth < NODE_DEPTH
        ? (kids.get(key) ?? [])
            .filter((c) => !seen.has(spineKey(repo, c)))
            .map((c) => epicNode(pid, repo, c, depth + 1, milestoneId, seen))
            .filter((n): n is ScorecardNode => !!n)
        : [];
    return {
      id: `${pid}~${key}`,
      kind: "epic",
      name: facts.title ?? rel,
      repo,
      path: rel,
      ...(facts.code ? { code: facts.code } : {}),
      ...(milestoneId ? { milestoneId } : {}),
      ...(facts.goal ? { objective: facts.goal } : {}),
      greens: facts.doneMeans.done,
      total: facts.doneMeans.total,
      spines: subtree(repo, rel),
      children,
      rows: [
        ...flowRows(subtree(repo, rel)),
        ...facts.boxes.map((b): ScorecardRow => ({
          label: b.text || b.id,
          state: b.done ? "green" : "amber",
          value: b.done ? "done" : "open",
          kind: "done-means",
          note: b.id,
          // the rows that name this box (its box id in the task) work on it.
          work: facts.queue.filter((q) => new RegExp(`(^|[^\\w-])${b.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(q.title)).map((q) => ({ code: q.code, repo, title: q.title, status: q.state, kind: "ticket" as const, state: workState("ticket", q.state), path: rel, ...(facts.code ? { epicCode: facts.code } : {}) })),
        })),
        ...children.map((c): ScorecardRow => ({ label: c.name, state: shareState(c.greens, c.total), value: c.total ? `${c.greens} of ${c.total} done` : "no Done means", kind: "epic", ...(c.code ? { note: c.code } : {}), work: epicWork(c) })),
      ],
      ...(teamsOf(milestoneId) ? { teams: teamsOf(milestoneId) } : {}),
      ...(facts.code ? { spineRef: { repo, code: facts.code } } : {}),
    };
  };
  const teamsByMilestone = new Map<string, ScorecardTeam[]>();
  for (const p of body.pursuits) for (const m of p.milestones ?? []) if (m.teams) teamsByMilestone.set(m.id, m.teams);
  function teamsOf(id?: string) {
    return id ? teamsByMilestone.get(id) : undefined;
  }
  /** an epic row is worked by the epic itself and its rows in the queue. */
  function epicWork(c: ScorecardNode): WorkLink[] {
    const info = c.repo && c.path ? spineInfo[spineKey(c.repo, c.path)] : undefined;
    const boxes = (info?.boxes ?? []).map((b): WorkLink => ({ code: b.id, repo: c.repo!, title: b.text, status: b.done ? "done" : "open", kind: "done-means", state: b.done ? "green" : "amber", path: c.path, ...(c.code ? { epicCode: c.code } : {}) }));
    const q = (info?.queue ?? []).map((r): WorkLink => ({ code: r.code, repo: c.repo!, title: r.title, status: r.state, kind: "ticket", state: workState("ticket", r.state), path: c.path, ...(c.code ? { epicCode: c.code } : {}) }));
    return [...boxes, ...q];
  }
  /** are we progressing, what are we stuck on: the subtree's rows running, ready and waiting, read live. */
  function flowRows(spines: string[]): ScorecardRow[] {
    const seen = new Set<string>();
    const n = { ready: 0, running: 0, waiting: 0 };
    for (const k of spines) for (const r of spineInfo[k]?.queue ?? []) if (!seen.has(`${k.split(":")[0]}:${r.code}`)) (seen.add(`${k.split(":")[0]}:${r.code}`), n[r.state]++);
    return [
      { label: "Rows being worked on now", kind: "flow", state: n.running ? "green" : n.ready ? "red" : "amber", value: String(n.running), note: n.running ? undefined : n.ready ? "ready rows wait and nobody works on them" : "nothing to work on" },
      { label: "Rows ready, waiting for a worker", kind: "flow", state: n.ready > 5 ? "red" : n.ready ? "amber" : "green", value: String(n.ready) },
      { label: "Rows stuck or waiting on something", kind: "flow", state: n.waiting > 3 ? "red" : n.waiting ? "amber" : "green", value: String(n.waiting) },
    ];
  }
  const nodes = body.pursuits.map((p): ScorecardNode => {
    const built = (p.epics ?? []).map((e) => epicNode(p.id, e.repo, e.path, 1, (e as { milestoneId?: string }).milestoneId)).filter((n): n is ScorecardNode => !!n);
    // a folded epic the pursuit also names on its own shows only inside its fold parent's scorecard.
    const inside = (n: ScorecardNode, at: ScorecardNode): boolean => at.children.some((c) => (c.repo === n.repo && c.path === n.path) || inside(n, c));
    const children = built.filter((n) => !(n.repo && n.path && foldsOf(n.repo).has(n.path) && built.some((o) => o !== n && inside(n, o))));
    const spines = [...new Set(children.flatMap((c) => c.spines))];
    return {
      id: p.id,
      kind: "pursuit",
      name: p.name,
      rank: p.rank ?? null,
      ...(p.parked ? { parked: true } : {}),
      milestoneId: children.find((c) => c.milestoneId)?.milestoneId ?? p.milestones?.[0]?.id,
      greens: p.greens,
      total: p.total,
      state: p.state,
      motion: p.motion,
      ...(p.owner ? { owner: p.owner } : {}),
      spines,
      children,
      ...withTurner(pursuitRows(p, children)),
    };
  });
  return { nodes, spineInfo };

  /** a wheel without a persona does not turn: the pursuit's milestone has no Delivery Manager on. */
  function withTurner<T extends { teams?: ScorecardTeam[] }>(r: T): T & { noPersona?: "none" | "off" } {
    const t = turnerOf(r.teams);
    return t === "on" ? r : { ...r, noPersona: t };
  }

  /** the file's rows first (a `line` row reads that pursuit line live), then every live line not used, then one row per epic. */
  function pursuitRows(p: PursuitIn, children: ScorecardNode[]): Pick<ScorecardNode, "rows" | "objective" | "file" | "teams" | "keyResults" | "spineRef" | "sidebar" | "foldedInto" | "headline" | "objectiveStatus" | "objectiveWas"> {
    const rel = `${SCORECARD_DIR}/${p.id}.json`;
    const text = o.file?.(p.id);
    const doc = text === undefined ? null : parseScorecardFile(text);
    const used = new Set<string>();
    const rows: ScorecardRow[] = [];
    for (const r of doc?.rows ?? []) {
      const live = r.line ? p.lines.find((l) => l.label === r.line) : undefined;
      if (live) used.add(live.label);
      const declared = r.colour ?? r.state;
      const repo = children[0]?.repo ?? o.homeRepo ?? "";
      rows.push({
        label: r.label,
        kind: r.kind === "health" ? "health" : "key-result",
        state: live ? live.state : declared && ROW_STATES.has(declared) ? declared : "unknown",
        value: live ? live.value : (r.value ?? "not measured yet"),
        ...(r.target ? { target: r.target } : {}),
        ...(r.group ? { group: r.group } : {}),
        ...(r.source ? { source: r.source } : {}),
        ...(r.by ? { by: r.by } : {}),
        ...(r.note || live?.note ? { note: r.note ?? live?.note } : {}),
        work: (Array.isArray(r.work) ? r.work : []).filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => {
          const m = /^([\w.-]+):(.+)$/.exec(c.trim());
          const [rr, code] = m ? [m[1], m[2]] : [repo, c.trim()];
          return o.work ? o.work(rr, code) : { code, repo: rr, kind: "unknown" as const };
        }),
      });
    }
    // a set with its own file shows the file's rows (12 to 26, the owner vn_fd4f7a7a); the older pursuit checks stand in until it has one.
    if (!doc?.rows?.length) for (const l of p.lines) if (!used.has(l.label)) rows.push({ label: l.label, kind: "check", state: l.state, value: l.value, ...(l.note ? { note: l.note } : {}) });
    rows.push({ label: "Moving, not stale", kind: "flow", state: p.motion === "moving" ? "green" : p.motion === "stalled" ? "red" : "unknown", value: p.motion === "unknown" ? "no history" : p.motion, ...(p.lastMove ? { note: `last move ${p.lastMove.at.slice(0, 10)} in ${p.lastMove.repo}: ${p.lastMove.subject.slice(0, 80)}` } : {}) });
    rows.push(...flowRows([...new Set(children.flatMap((c) => c.spines))]));
    for (const c of children) rows.push({ label: c.name, kind: "epic", state: shareState(c.greens, c.total), value: c.total ? `${c.greens} of ${c.total} done` : "no Done means", ...(c.code ? { note: c.code } : {}), work: epicWork(c) });
    const teams = teamsOf(children.find((c) => c.milestoneId)?.milestoneId ?? p.milestones?.[0]?.id);
    const home = children[0]?.repo ?? o.homeRepo ?? "";
    const workOf = (codes: unknown): WorkLink[] =>
      (Array.isArray(codes) ? codes : []).filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => {
        const m = /^([\w.-]+):(.+)$/.exec(c.trim());
        const [rr, code] = m ? [m[1], m[2]] : [home, c.trim()];
        return o.work ? o.work(rr, code) : { code, repo: rr, kind: "unknown" as const };
      });
    // the key results: the file's 4 to 6 rows; a Done-means box ticked in its spine shows green, done.
    const keyResults = (doc?.keyResults ?? []).map((k): ScorecardRow => {
      const work = workOf(k.work);
      // `doneMeans` is a box id, `repo:` first when the box lives in another repo (other:E907-1).
      const box = k.doneMeans && /^([\w.-]+:)?[A-Z][A-Z0-9]*-\d+$/.test(k.doneMeans) ? workOf([k.doneMeans])[0] : undefined;
      const ticked = box?.kind === "done-means" && box.status === "done";
      const declared = k.colour && ROW_STATES.has(k.colour) ? k.colour : "unknown";
      return {
        label: k.label,
        kind: "key-result",
        state: ticked ? "green" : declared,
        value: ticked && declared !== "green" ? "done" : (k.value ?? "no data yet"),
        ...(k.note ? { note: k.note } : {}),
        ...(k.target ? { target: k.target } : {}),
        ...(k.doneMeans ? { doneMeans: k.doneMeans.replace(/^[\w.-]+:/, "") } : {}),
        ...(!ticked && k.live && typeof k.live === "object" && typeof k.live.kind === "string" ? { live: k.live } : {}),
        work,
      };
    });
    // the sidebar's child epics, short names: matched anywhere in the set's tree by epic code or spine path.
    const find = (want: string): ScorecardNode | undefined => {
      const todo = [...children];
      while (todo.length) {
        const n = todo.shift()!;
        if (n.code === want || n.path === want || (n.repo && `${n.repo}:${n.path}` === want)) return n;
        todo.push(...n.children);
      }
      return undefined;
    };
    const sidebar = (doc?.sidebar ?? []).map((k) => ({ k, n: find(k.epic) })).filter((x): x is { k: { epic: string; name: string }; n: ScorecardNode } => !!x.n).map(({ k, n }) => ({ id: n.id, name: k.name, greens: n.greens, total: n.total }));
    const sm = doc?.spine ? /^([\w.-]+)\s+(EPIC-[\w.]+)$/.exec(doc.spine) : null;
    return {
      ...(keyResults.length ? { keyResults } : {}),
      ...(sm ? { spineRef: { repo: sm[1], code: sm[2] } } : {}),
      ...(sidebar.length ? { sidebar } : {}),
      ...(doc?.foldedInto ? { foldedInto: doc.foldedInto } : {}),
      rows,
      objective: doc?.objective ?? p.greenWhen,
      ...(doc?.objective ? { headline: p.goal ? `${doc.objective} · ${p.goal.now} of ${p.goal.target}` : doc.objective, objectiveStatus: doc.objectiveStatus ?? "proposed", objectiveWas: doc.objectiveWas ?? p.greenWhen } : {}),
      file: { path: rel, present: !!doc, ...(doc?.proposal ? { proposal: doc.proposal } : {}) },
      ...(teams ? { teams } : {}),
    };
  }
}

/** Reads spine files from the repos root (the same checkouts the pursuits read), cached by mtime. */
export function createSpineFileReader(repoDir: (name: string) => string | undefined) {
  const cache = new Map<string, { mtime: number; text: string }>();
  return (repo: string, rel: string): string | undefined => {
    const dir = repoDir(repo);
    // spines, and the repo's view-only folds file (the tree draws a folded epic inside its fold parent).
    if (!dir || rel.includes("..") || !(rel.endsWith(".md") || rel === FOLDS_FILE)) return undefined;
    const abs = path.join(dir, rel);
    try {
      const st = fs.statSync(abs);
      const hit = cache.get(abs);
      if (hit && hit.mtime === st.mtimeMs) return hit.text;
      const text = fs.readFileSync(abs, "utf8");
      cache.set(abs, { mtime: st.mtimeMs, text });
      return text;
    } catch {
      return undefined;
    }
  };
}

/** a work item's colour: done (or finished, waiting for review) green, moving amber, stuck red, unknown grey. */
export function workState(kind: WorkLink["kind"], status = ""): RowState {
  const w = status.trim().toLowerCase();
  if (kind === "unknown") return "unknown";
  if (kind === "epic") {
    const m = /^(\d+) of (\d+)/.exec(w);
    return m ? (Number(m[2]) && Number(m[1]) >= Number(m[2]) ? "green" : Number(m[1]) === 0 ? "red" : "amber") : "unknown";
  }
  if (/^(done|review|closed|superseded)\b/.test(w)) return "green";
  if (/^(blocked|waiting|pending|needs|on hold|failed|stalled)\b/.test(w)) return "red";
  if (/^(open|ready|active|running|dispatched|claimed|queued|monitoring|in progress)\b/.test(w)) return "amber";
  return "unknown";
}

/**
 * Finds a code's ticket or epic in a repo's spines (docs/spines/*.md and docs/*.md), for a row's `work` links: a row
 * row code gives its title and status, an epic code its title and Done-means count. Cached by mtime.
 */
export function createWorkFinder(repoDir: (name: string) => string | undefined, read: (repo: string, rel: string) => string | undefined) {
  const list = (repo: string): string[] => {
    const dir = repoDir(repo);
    if (!dir) return [];
    const out: string[] = [];
    for (const sub of ["docs/spines", "docs"]) {
      try {
        for (const f of fs.readdirSync(path.join(dir, sub))) if (f.endsWith(".md")) out.push(`${sub}/${f}`);
      } catch {
        /* no such folder */
      }
    }
    return out;
  };
  return (repo: string, code: string): WorkLink => {
    const epic = /^EPIC-\w+$/.test(code);
    // a Done-means id (letters, a dash, a number, no S/A/G): its box in the spine that holds it.
    const box = /^[A-Z][A-Z0-9]*-\d+$/.test(code);
    // an ask (E907-A1): work waiting on an answer, red, its words from the ask line when one is written.
    const ask = /^[A-Z][A-Z0-9]*-A\d+$/.test(code);
    for (const rel of list(repo)) {
      const text = read(repo, rel);
      if (!text) continue;
      if (ask) {
        if (!text.includes(code)) continue;
        const line = text.split("\n").find((l) => l.includes(`[ask ${code}`) || l.includes(`[${code}`));
        const words = line ? strip(line.replace(/^[-*\s]*\[[^\]]*\]\s*/, "")).split(/ — | -- /)[0].slice(0, 90) : undefined;
        const h = epicHeading(text);
        return { code, repo, kind: "ticket", ...(words ? { title: words } : {}), status: "waiting on an answer", state: "red", path: rel, ...(h.code ? { epicCode: h.code } : {}) };
      }
      if (epic) {
        const h = epicHeading(text);
        if (h.code !== code) continue;
        const dm = doneMeansOf(text, []);
        const status = `${dm.done} of ${dm.total} done`;
        return { code, repo, kind: "epic", title: h.title, status, state: workState("epic", status), path: rel, epicCode: code };
      }
      if (box) {
        if (!text.includes(code)) continue;
        const b = readSpineInfo(repo, rel, text).boxes.find((x) => x.id === code);
        if (!b) continue;
        const h = epicHeading(text);
        return { code, repo, kind: "done-means", title: b.text, status: b.done ? "done" : "open", state: b.done ? "green" : "amber", path: rel, ...(h.code ? { epicCode: h.code } : {}) };
      }
      if (!text.includes(code)) continue;
      const row = ledgerLines(text).find((r) => r.id === code);
      if (!row) continue;
      const status = row.col.status >= 0 ? strip(row.cells[row.col.status] ?? "") : "";
      const h = epicHeading(text);
      const word = status.split(/[\s(;,]/)[0] || status;
      return { code, repo, kind: "ticket", title: rowTitle(row.col.title >= 0 ? (row.cells[row.col.title] ?? code) : code), status: word, state: workState("ticket", word), path: rel, ...(h.code ? { epicCode: h.code } : {}) };
    }
    return { code, repo, kind: "unknown" };
  };
}

/**
 * Turned green today and this week (the owner vn_c15874bc: "progress means how many rows turned green today and this
 * week"): this console remembers each row's colour and when it last turned green. A row seen green the first time is
 * not counted (it was green before we watched). Kept in a small file beside the console's database.
 */
export interface GreenHistory {
  since: string;
  rows: Record<string, { state: RowState; greenAt?: string }>;
}
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
export function dayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
export function applyGreenHistory(body: ScorecardsBody, h: GreenHistory, now: number): ScorecardsBody & { progress: { since: string; today: number; week: number; sets: Record<string, { today: number; week: number }> } } {
  const iso = new Date(now).toISOString();
  const today = dayStart(now);
  const week = weekStart(now);
  const sets: Record<string, { today: number; week: number }> = {};
  const seen = new Set<string>();
  const walk = (n: ScorecardNode, top: string) => {
    const tally = { today: 0, week: 0 };
    // the key results first (what the page leads with), then the table's rows.
    for (const [r, kr] of [...(n.keyResults ?? []).map((x) => [x, true] as const), ...n.rows.map((x) => [x, false] as const)]) {
      const key = `${n.id}|${kr ? "kr" : r.kind}|${r.label}`;
      seen.add(key);
      const was = h.rows[key];
      if (r.state === "green") {
        const greenAt = was ? (was.state === "green" ? was.greenAt : iso) : undefined;
        h.rows[key] = { state: "green", ...(greenAt ? { greenAt } : {}) };
        if (greenAt) {
          r.greenSince = greenAt;
          const t = Date.parse(greenAt);
          if (t >= today) tally.today++;
          if (t >= week) tally.week++;
        }
      } else h.rows[key] = { state: r.state };
    }
    if (n.kind === "pursuit") sets[n.id] = tally;
    n.children.forEach((c) => walk(c, top));
  };
  body.nodes.forEach((n) => walk(n, n.id));
  for (const k of Object.keys(h.rows)) if (!seen.has(k) && !body.nodes.some((n) => k.startsWith(`${n.id}|`) || k.startsWith(`${n.id}~`))) delete h.rows[k];
  const all = Object.values(sets);
  return { ...body, progress: { since: h.since, today: all.reduce((a, s) => a + s.today, 0), week: all.reduce((a, s) => a + s.week, 0), sets } };
}
export function createGreenHistory(file?: string) {
  let h: GreenHistory | null = null;
  const load = (now: number): GreenHistory => {
    if (h) return h;
    try {
      if (file) h = JSON.parse(fs.readFileSync(file, "utf8")) as GreenHistory;
    } catch {
      h = null;
    }
    if (!h || typeof h !== "object" || !h.rows) h = { since: new Date(now).toISOString(), rows: {} };
    return h;
  };
  return (body: ScorecardsBody, now = Date.now()) => {
    const hist = load(now);
    const out = applyGreenHistory(body, hist, now);
    if (file)
      try {
        fs.writeFileSync(file, JSON.stringify(hist));
      } catch {
        /* read-only disk: counts still show for this run */
      }
    return out;
  };
}
