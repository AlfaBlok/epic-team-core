import { createHash } from "node:crypto";
import type { Book, BookEpic, BookEvent, BookRepo, BookState } from "../book/build.js";
import type { Deliverable } from "../book/deliverables.js";
import { milestoneBook, plain, type BookTreeNode, type MilestoneBook } from "../book/milestone.js";
import type { LinkChecker } from "../book/links.js";
import { rocksFor, type BigRock } from "./bigRocks.js";
import { homeRepo, ownerPattern } from "../identity.js";

/**
 * the epic deck, a short numbered slide deck per high-level epic that tells the owner what we do, why,
 * what we just did, how we measure it and the trend, and what waits on him; slide 1 is the big rocks it serves.
 * Built from the same cached Epic Book as /book (the repo is the source, L-45): the milestone book's narrative, plan tree
 * and "Everything made for this", plus the decisions and timelines of every spine under it. The web draws each
 * slide's diagram from this data (house paper style, L-49), never by hand. Stable URL: `/deck/<repo>/<code>`.
 */

export interface DeckRef {
  repo: string;
  /** M6, or the spine's file name when its title has no code. */
  code: string;
}

export interface DeckTrendPoint {
  date: string;
  goalsMet: number;
  goalsTotal: number;
  epicsDone: number;
  epicsTotal: number;
}

/** The material facts of a deck: a change in any of them is worth a card in the owner's inbox (deck/notify.ts). */
export interface DeckMaterial {
  state: BookState;
  status: string;
  goals: string[];
  outcome: boolean;
  asks: string[];
  epics: string[];
  rocks: string[];
}

export interface EpicDeck {
  builtAt: string;
  ref: DeckRef;
  /** The web path of this deck (`/deck/<repo>/<code>`). */
  href: string;
  title: string;
  path: string;
  state: BookState;
  status: string;
  /** The spine on GitHub. */
  spineHref?: string;
  /** The milestone that tracks this spine on the console, when one does (its Epic Book link). */
  milestoneId?: string;
  updatedAt: string | null;
  rocks: BigRock[];
  goal: string | null;
  serves: string | null;
  goals: MilestoneBook["narrative"]["goals"];
  whereWeAre: string[];
  next: MilestoneBook["narrative"]["next"];
  outcome: string | null;
  /** The newest commits and decisions across the spine and every spine under it. */
  justDid: (BookEvent & { code: string })[];
  measure: {
    goalsMet: number;
    goalsTotal: number;
    epics: Record<BookState, number>;
    /** Done means met across every spine under it (the sub-goals). */
    subGoals: { done: number; total: number };
    asksOnJordi: number;
    /** Changes (commits and decisions) per ISO week, the last 8 weeks, oldest first: from the timelines the book keeps (the newest 15 per open epic). */
    weekly: { week: string; n: number }[];
    /** The deck's own history from docs/status/deck-updates.md: goals met and epics done at each change. */
    trend: DeckTrendPoint[];
  };
  plan: BookTreeNode[];
  decisions: { date: string; code: string; outcome: string; decision: string; summary: string }[];
  waits: { code: string; who: string; question: string; epic: string }[];
  made: (Deliverable & { epic: string })[];
  material: DeckMaterial;
  fingerprint: string;
}

/** ": Lanes and radar" → "Lanes and radar". */
const titleRest = (t: string) => t.replace(/^\s*(EPIC-\d+|M\d+)\s*[:—–-]\s*/i, "").trim() || t;
const baseName = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");

/** A spine's deck code: its title's code (M6), else its file name. */
export function deckCode(e: Pick<BookEpic, "code" | "path">): string {
  return /^(EPIC-\d+|M\d+)$/i.test(e.code) ? e.code.toUpperCase() : baseName(e.path);
}

export const deckHref = (r: DeckRef) => `/deck/${encodeURIComponent(r.repo)}/${encodeURIComponent(r.code)}`;

/** The spine a deck key names: its code, else its file name. */
export function findEpic(repo: BookRepo, code: string): BookEpic | undefined {
  const c = code.toLowerCase();
  return repo.epics.find((e) => deckCode(e).toLowerCase() === c) ?? repo.epics.find((e) => baseName(e.path).toLowerCase() === c) ?? (c === "root" && repo.root ? repo.epics.find((e) => e.path === repo.root) : undefined);
}

/** an ask waits on the owner when its `who` names them (the identity's owner, any case) */
const isOwner = (who: string): boolean => new RegExp(ownerPattern(), "i").test(who);
const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
};

export function weeklyActivity(dates: string[], now: number, weeks = 8): { week: string; n: number }[] {
  const out: { week: string; n: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push({ week: isoWeek(new Date(now - i * 7 * 86_400_000)), n: 0 });
  const at = new Map(out.map((w, i) => [w.week, i]));
  for (const d of dates) {
    const t = Date.parse(d);
    if (Number.isNaN(t)) continue;
    const i = at.get(isoWeek(new Date(t)));
    if (i !== undefined) out[i].n++;
  }
  return out;
}

export function fingerprintOf(m: DeckMaterial): string {
  return createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 10);
}

/** What changed between two materials, in plain words for the inbox card (empty when nothing material did). */
export function materialChange(was: DeckMaterial | undefined, now: DeckMaterial): string[] {
  if (!was) return ["The deck changed."];
  const out: string[] = [];
  const met = (m: DeckMaterial) => new Set(m.goals.filter((g) => g.endsWith(":1")).map((g) => g.slice(0, -2)));
  const newly = [...met(now)].filter((g) => !met(was).has(g));
  if (newly.length) out.push(`${newly.length === 1 ? "A goal is" : `${newly.length} goals are`} met: ${newly.join(", ")}.`);
  const reopened = [...met(was)].filter((g) => !met(now).has(g) && now.goals.some((x) => x.startsWith(`${g}:`)));
  if (reopened.length) out.push(`${reopened.join(", ")} ${reopened.length === 1 ? "is" : "are"} open again.`);
  const goalsAdded = now.goals.length - was.goals.length;
  if (goalsAdded > 0) out.push(`${goalsAdded} new ${goalsAdded === 1 ? "goal" : "goals"}.`);
  if (was.state !== now.state) out.push(`It is ${now.state === "stuck" ? "waiting on someone" : now.state} now.`);
  if (!was.outcome && now.outcome) out.push("Its outcome is written.");
  const asks = now.asks.filter((a) => !was.asks.includes(a));
  if (asks.length) out.push(`${asks.length === 1 ? "A new question waits" : `${asks.length} new questions wait`} on you: ${asks.join(", ")}.`);
  const st = (xs: string[]) => new Map(xs.map((x) => [x.split(":")[0], x.split(":")[1]]));
  const before = st(was.epics);
  const done = [...st(now.epics)].filter(([c, s]) => s === "done" && before.get(c) && before.get(c) !== "done").map(([c]) => c);
  if (done.length) out.push(`${done.length === 1 ? "One epic" : `${done.length} epics`} under it finished: ${done.slice(0, 4).join(", ")}${done.length > 4 ? "…" : ""}.`);
  const added = [...st(now.epics).keys()].filter((c) => !before.has(c));
  if (added.length) out.push(`${added.length === 1 ? "A new epic" : `${added.length} new epics`} under it: ${added.slice(0, 4).join(", ")}${added.length > 4 ? "…" : ""}.`);
  const rocks = now.rocks.filter((r) => !was.rocks.includes(r));
  if (rocks.length) out.push(`It now serves ${rocks.length === 1 ? "a big rock" : `${rocks.length} big rocks`}: ${rocks.join(", ")}.`);
  if (!out.length && fingerprintOf(was) !== fingerprintOf(now)) out.push("Its plan changed.");
  return out;
}

/** The epic deck for one spine of the built book; null when the repo or the spine is not in it. */
export function epicDeck(
  book: Book,
  ref: DeckRef,
  o: { rocks?: BigRock[]; trend?: DeckTrendPoint[]; milestoneId?: string; refreshedAt?: string | null; now?: number; links?: Pick<LinkChecker, "get"> } = {},
): EpicDeck | null {
  const repo = book.repos.find((r) => r.name === ref.repo);
  const root = repo && findEpic(repo, ref.code);
  if (!repo || !root) return null;
  const now = o.now ?? Date.now();
  const mb = milestoneBook(book, { id: o.milestoneId ?? "", repoName: repo.name, path: root.path }, { refreshedAt: o.refreshedAt, now, links: o.links });
  if (!mb) return null;
  const inTree = new Set(mb.tree.map((n) => n.path));
  const nodes = repo.epics.filter((e) => inTree.has(e.path));
  const codeOf = new Map(nodes.map((e) => [e.path, deckCode(e)]));
  const under = mb.tree.slice(1);
  const rocks = rocksFor(o.rocks ?? [], repo.name, nodes.map(deckCode));
  const justDid = nodes
    .flatMap((e) => e.timeline.map((t) => ({ ...t, code: codeOf.get(e.path)!, text: plain(t.text, 160) ?? t.text })))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);
  const decisions = nodes
    .flatMap((e) => e.decisions.map((d) => ({ date: d.date, code: codeOf.get(e.path)!, outcome: d.outcome, decision: plain(d.decision, 180) ?? d.decision, summary: plain(d.summary, 180) ?? d.summary })))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);
  const waits = mb.tree.flatMap((n) => n.asks.filter((a) => isOwner(a.who)).map((a) => ({ code: a.code, who: a.who, question: plain(a.question, 200) ?? a.question, epic: n.code })));
  // the deck replaces the Epic Book, so it keeps's whole list (each link once, newest first); the slide shows 8, then all.
  const seenUrl = new Set<string>();
  const made = mb.made
    .flatMap((m) => m.items.map((d) => ({ ...d, epic: m.code })))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .filter((d) => !seenUrl.has(d.url) && !!seenUrl.add(d.url));
  const subGoals = under.reduce((a, n) => ({ done: a.done + n.dod.done, total: a.total + n.dod.total }), { done: 0, total: 0 });
  const material: DeckMaterial = {
    state: root.state,
    status: root.status,
    goals: mb.narrative.goals.map((g) => `${g.id}:${g.done ? 1 : 0}`),
    outcome: !!mb.narrative.outcome,
    asks: waits.map((w) => w.code).sort(),
    epics: under.map((n) => `${n.code}:${n.state}`).sort(),
    rocks: rocks.map((r) => r.id),
  };
  return {
    builtAt: book.builtAt,
    ref: { repo: repo.name, code: deckCode(root) },
    href: deckHref({ repo: repo.name, code: deckCode(root) }),
    title: titleRest(root.title),
    path: root.path,
    state: root.state,
    status: root.status,
    ...(root.href ? { spineHref: root.href } : {}),
    ...(o.milestoneId ? { milestoneId: o.milestoneId } : {}),
    updatedAt: mb.updated.at,
    rocks,
    goal: mb.narrative.goal,
    serves: plain(root.serves, 300),
    goals: mb.narrative.goals,
    whereWeAre: mb.narrative.whereWeAre,
    next: mb.narrative.next.slice(0, 6),
    outcome: mb.narrative.outcome,
    justDid,
    measure: {
      goalsMet: mb.narrative.goals.filter((g) => g.done).length,
      goalsTotal: mb.narrative.goals.length,
      epics: mb.counts,
      subGoals,
      asksOnJordi: waits.length,
      weekly: weeklyActivity(nodes.flatMap((e) => e.timeline.map((t) => t.date)), now),
      trend: o.trend ?? [],
    },
    plan: mb.tree,
    decisions,
    waits,
    made,
    material,
    fingerprint: fingerprintOf(material),
  };
}

export interface DeckListItem {
  ref: DeckRef;
  href: string;
  title: string;
  state: BookState;
  /** big = one of the owner's focus milestones; lane = a direct child of a repo's root spine. */
  kind: "big" | "lane";
  milestoneId?: string;
  goalsMet: number;
  goalsTotal: number;
  rocks: string[];
}

/**
 * The high-level epics that get a deck on the index (and a card when one changes): the owner's focus milestones in his order,
 * then the open direct children of the code repo's root spine (the big lanes).
 */
export function deckList(
  book: Book,
  bigRoots: { id: string; repoName: string; path: string; title?: string }[],
  o: { rocks?: BigRock[]; lanesOf?: string[] } = {},
): DeckListItem[] {
  const out: DeckListItem[] = [];
  const seen = new Set<string>();
  const add = (repo: BookRepo, e: BookEpic, kind: DeckListItem["kind"], milestoneId?: string, title?: string) => {
    const ref = { repo: repo.name, code: deckCode(e) };
    const k = `${ref.repo}/${ref.code}`;
    if (seen.has(k)) return;
    seen.add(k);
    const goals = e.doneMeans ?? [];
    const sub = new Set([e.path]);
    for (const x of repo.epics) if (x.parent && sub.has(x.parent)) sub.add(x.path);
    out.push({
      ref,
      href: deckHref(ref),
      title: title || titleRest(e.title),
      state: e.state,
      kind,
      ...(milestoneId ? { milestoneId } : {}),
      goalsMet: goals.filter((g) => g.done).length,
      goalsTotal: goals.length,
      rocks: rocksFor(o.rocks ?? [], repo.name, repo.epics.filter((x) => sub.has(x.path)).map(deckCode)).map((r) => r.id),
    });
  };
  for (const m of bigRoots) {
    const repo = book.repos.find((r) => r.name === m.repoName);
    const e = repo?.epics.find((x) => x.path === m.path);
    if (repo && e) add(repo, e, "big", m.id, m.title);
  }
  for (const name of o.lanesOf ?? [homeRepo()]) {
    const repo = book.repos.find((r) => r.name === name);
    if (!repo?.root) continue;
    for (const e of repo.epics.filter((x) => x.parent === repo.root && (x.state === "moving" || x.state === "stuck"))) add(repo, e, "lane");
  }
  return out;
}
