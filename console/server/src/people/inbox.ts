import fs from "node:fs";
import path from "node:path";
import { firstH1, stripInline } from "../adapters/markdown.js";
import { parseAsks, snoozedNow, type LocatedAsk } from "../inbox/asks.js";
import { areaCovers, find, parsePeople, type Goal, type Person, type Roster } from "./roster.js";

/**
 * every human's own lists, read straight from the world's spines (the repo is
 * the source, L-45): Answer (open asks naming them), Approve (answers waiting on their yes), Know (outcomes they are
 * made aware of); the owner's board of who is blocked on whom; and the asks past their person's time limit.
 */
export interface WorldRepo {
  name: string;
  path: string;
}
export interface SpineAsk {
  repo: string;
  /** Repo-relative spine path. */
  path: string;
  goal: Goal;
  ask: LocatedAsk;
}
export interface World {
  roster: Roster;
  /** The repo whose root spine holds the People list. */
  rosterRepo?: string;
  asks: SpineAsk[];
  goals: (Goal & { repo: string })[];
}

const SPINES = "docs/spines";
const codeOf = (title: string) => /^(EPIC-\d+|E\d+|[A-Z][A-Z0-9]*-\d+)\s*:/.exec(title)?.[1];

/** Read the world: the first `## People` among its repos' root spines, and every ask of every spine under docs/spines. */
export function readWorld(repos: WorldRepo[]): World {
  const w: World = { roster: { people: [], problems: [] }, asks: [], goals: [] };
  for (const r of repos) {
    const dir = path.join(r.path, SPINES);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const rel = `${SPINES}/${f}`;
      let text = "";
      try {
        text = fs.readFileSync(path.join(dir, f), "utf8");
      } catch {
        continue;
      }
      if (f === "root.md" && !w.rosterRepo) {
        const roster = parsePeople(text);
        if (roster.people.length || roster.problems.length) {
          w.roster = roster;
          w.rosterRepo = r.name;
        }
      }
      const title = stripInline(firstH1(text) ?? f);
      const code = codeOf(title);
      const goal: Goal = { ...(code ? { code } : {}), path: rel, title };
      w.goals.push({ ...goal, repo: r.name });
      for (const a of parseAsks(text, rel)) w.asks.push({ repo: r.name, path: rel, goal, ask: a });
    }
  }
  return w;
}

const is = (a: string | undefined, h: string) => !!a && a.replace(/^@/, "").toLowerCase() === h.toLowerCase();
const named = (x: SpineAsk, h: string) => is(x.ask.who, h) || is(x.ask.approveBy, h) || is(x.ask.awaits, h) || is(x.ask.escalatedBy, h) || is(x.ask.approvedBy, h) || (x.ask.aware ?? []).some((a) => is(a, h));

/** The goals a person sees (rule 2 of): their area, plus any goal where an ask names them. The owner sees all. */
export function goalsOf(w: World, p: Person): World["goals"] {
  if (p.role === "owner") return w.goals;
  const withAsk = new Set(w.asks.filter((x) => named(x, p.handle)).map((x) => `${x.repo}/${x.path}`));
  return w.goals.filter((g) => areaCovers(p.area, g) || withAsk.has(`${g.repo}/${g.path}`));
}

export interface Card {
  /** `repo/CODE`, the id every button sends. */
  id: string;
  repo: string;
  code: string;
  path: string;
  line?: number;
  goal: string;
  goalCode?: string;
  kind: string;
  question: string;
  who: string;
  since?: string;
  answer?: string;
  approveBy?: string;
  awaits?: string;
  approvedBy?: string;
  aware?: string[];
  escalatedBy?: string;
  escalatedNote?: string;
  context?: string;
  recommend?: string;
  options?: string[];
  row?: string;
  snoozedUntil?: string;
}
const cardOf = (x: SpineAsk): Card => {
  const a = x.ask;
  return {
    id: `${x.repo}/${a.code}`,
    repo: x.repo,
    code: a.code ?? "",
    path: x.path,
    ...(a.line !== undefined ? { line: a.line } : {}),
    goal: x.goal.title,
    ...(x.goal.code ? { goalCode: x.goal.code } : {}),
    kind: a.ask,
    question: a.question,
    who: a.who,
    ...(a.since ? { since: a.since } : {}),
    ...(a.answer ? { answer: a.answer } : {}),
    ...(a.approveBy ? { approveBy: a.approveBy } : {}),
    ...(a.awaits ? { awaits: a.awaits } : {}),
    ...(a.approvedBy ? { approvedBy: a.approvedBy } : {}),
    ...(a.aware?.length ? { aware: a.aware } : {}),
    ...(a.escalatedBy ? { escalatedBy: a.escalatedBy } : {}),
    ...(a.escalatedNote ? { escalatedNote: a.escalatedNote } : {}),
    ...(a.contextText ? { context: a.contextText } : {}),
    ...(a.recommend ? { recommend: a.recommend } : {}),
    ...(a.options.length ? { options: a.options } : {}),
    ...(a.row ? { row: a.row } : {}),
    ...(a.snoozedUntil ? { snoozedUntil: a.snoozedUntil } : {}),
  };
};

export interface Inbox {
  person: Pick<Person, "handle" | "role" | "area" | "escalatesTo" | "escalateAfterHours">;
  /** Open asks naming them, oldest first (snoozed ones last). */
  answer: Card[];
  /** Answers waiting on their yes. */
  approve: Card[];
  /** Outcomes they are made aware of (answered, approved where approval was needed), newest first; `seen` once pressed. */
  know: (Card & { seen?: boolean })[];
}

const older = (a: Card, b: Card) => (a.since ?? "9999").localeCompare(b.since ?? "9999") || a.id.localeCompare(b.id);

/** One person's lists. `seen` holds the Know ids they pressed Seen on. Only coded asks: a button needs a code to write. */
export function inboxFor(w: World, p: Person, seen: ReadonlySet<string> = new Set(), now = Date.now()): Inbox {
  const coded = w.asks.filter((x) => x.ask.code);
  const answer = coded
    .filter((x) => x.ask.state === "open" && x.ask.doneAt === undefined && is(x.ask.who, p.handle))
    .map(cardOf)
    .sort((a, b) => Number(snoozedNow(a.snoozedUntil, now)) - Number(snoozedNow(b.snoozedUntil, now)) || older(a, b));
  const approve = coded.filter((x) => x.ask.state === "answered" && is(x.ask.awaits, p.handle)).map(cardOf).sort(older);
  const know = coded
    .filter((x) => x.ask.state === "answered" && !x.ask.awaits && !x.ask.feedback && (x.ask.aware ?? []).some((a) => is(a, p.handle)))
    .map((x) => ({ ...cardOf(x), ...(seen.has(`${x.repo}/${x.ask.code}`) ? { seen: true } : {}) }))
    .sort((a, b) => Number(!!a.seen) - Number(!!b.seen) || (b.since ?? "").localeCompare(a.since ?? ""));
  return { person: { handle: p.handle, role: p.role, area: p.area, ...(p.escalatesTo ? { escalatesTo: p.escalatesTo } : {}), ...(p.escalateAfterHours ? { escalateAfterHours: p.escalateAfterHours } : {}) }, answer, approve, know };
}

export interface BoardLine {
  handle: string;
  role: Person["role"];
  asks: number;
  approvals: number;
  /** The oldest card waiting on them (its since), and its question. */
  oldestSince?: string;
  stuck?: string;
  /** Asks that came to them by escalation. */
  escalated: number;
}
/** The owner's board: who is blocked on whom. Unknown names (an ask naming someone off the list) come last, flagged. */
export function board(w: World): { people: BoardLine[]; unknown: { who: string; cards: string[] }[]; problems: string[] } {
  const people = w.roster.people.map((p): BoardLine => {
    const ib = inboxFor(w, p);
    const all = [...ib.answer, ...ib.approve].sort(older);
    return {
      handle: p.handle,
      role: p.role,
      asks: ib.answer.length,
      approvals: ib.approve.length,
      ...(all[0]?.since ? { oldestSince: all[0].since } : {}),
      ...(all[0] ? { stuck: all[0].question.slice(0, 140) } : {}),
      escalated: ib.answer.filter((c) => c.escalatedBy).length,
    };
  });
  const unknown = new Map<string, string[]>();
  if (w.roster.people.length)
    for (const x of w.asks)
      if (x.ask.code && x.ask.state === "open" && x.ask.who && !find(w.roster, x.ask.who)) unknown.set(x.ask.who, [...(unknown.get(x.ask.who) ?? []), `${x.repo}/${x.ask.code}`]);
  return { people, unknown: [...unknown].map(([who, cards]) => ({ who, cards })), problems: w.roster.problems };
}

/** Open asks past their person's time limit (`escalates to: @X after <n> h`), from `since` (a date: its start, UTC). */
export function dueEscalations(w: World, now = Date.now()): { card: Card; from: string; to: string; hours: number }[] {
  const out: { card: Card; from: string; to: string; hours: number }[] = [];
  for (const x of w.asks) {
    const a = x.ask;
    if (!a.code || a.state !== "open" || a.doneAt !== undefined || !a.since || a.macAgent || snoozedNow(a.snoozedUntil, now)) continue;
    const p = find(w.roster, a.who);
    if (!p?.escalatesTo || !p.escalateAfterHours || !find(w.roster, p.escalatesTo)) continue;
    const at = Date.parse(`${a.since}T00:00:00Z`);
    if (Number.isFinite(at) && now - at >= p.escalateAfterHours * 3_600_000) out.push({ card: cardOf(x), from: p.handle, to: p.escalatesTo, hours: p.escalateAfterHours });
  }
  return out;
}
