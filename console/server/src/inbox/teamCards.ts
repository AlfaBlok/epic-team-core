import { repoRowIds } from "../status/rowIds.js";
import { withRow } from "../status/personaRows.js";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { SpineWriter } from "./spineWrite.js";
import { credentialWorld, currentAuth } from "../auth/identity.js";
import { DEFAULT_TENANT } from "../db.js";
import { doorSession } from "../auth/owner.js";
import { ownerName, socialWorld } from "../identity.js";
import { acceptOnSpine, ADVISOR_BY, advisorOpen, checkAdvisor, type AdvisorItem, type AdvisorSet } from "./advisorCards.js";

/**
 * E948-S66 (the owner, vn_fe52ef4a 2026-11-12 22:19Z): the inbox carries, besides what is
 * blocked on him and finished work, three kinds of cards the team makes on its own:
 *
 *   digest  one per scorecard (pursuit) a day: its wheel's numbers against the last digest, greener or redder, and the
 *           two or three reasons with links (the Performance persona's daily-pass pattern, scripts/scorecard_digest.py);
 *   idea    a strategic idea to reach a goal faster: the idea, the gain, the team's recommendation (the Strategist);
 *   goal    a goal conversation where a goal is unset: the unset goal, two or three proposed goals with numbers
 *           (the Gap finder or the Alignment persona).
 *   advisor the Senior advisor's suggestions of one week as one marked set (E948-S59, advisorCards.ts): Accept all,
 *           accept or decline each; an accepted one becomes a ready row on its spine first (L-45).
 *
 * The record is one file in the home code repo, docs/inbox/cards.json (root L-45: the console's DB is only a cache);
 * every post and every answer is one commit. The limits are his ("never more cards than he can handle"):
 * at most one digest per scorecard per day, at most three ideas a day, one open goal conversation per scorecard.
 * The day is Mexico City's (where he reads them).
 *
 * Card worlds (cardWorlds(): the social world the home desk pairs with, the owner's own) may read and post their own
 * `idea` cards and nothing else. Such a world's cards live in its own repo (the same docs/inbox/cards.json path in one
 * of that world's own checkouts: each world's repo is its record), each names its `world`; the three ideas a day cap is one cap across the home world and these worlds. The home
 * world's list (the owner's inbox) shows the home cards plus these worlds' idea cards, and his answer is written to the
 * file the card lives in. A world reads only its own file, never the home world's or another world's.
 * The owner may also answer a card world's idea card from that world's own skin (a session in that world): the
 * answer finds the card in that world's file only and is written there; the world's agents never answer.
 */

export const TEAM_CARDS_FILE = "docs/inbox/cards.json";
export const TEAM_CARD_KINDS = ["digest", "idea", "goal", "advisor"] as const;
export type TeamCardKind = (typeof TEAM_CARD_KINDS)[number];
export const LIMITS = { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1, advisorSetsPerWeek: 1 } as const;
export const DAY_ZONE = "America/Mexico_City";
/** answered cards stay listed (in Answered) this long; the file keeps them all. */
export const ANSWERED_DAYS = 14;
/** the other worlds whose idea cards reach the owner's inbox: the social world, when it is not the home world itself. */
export const cardWorlds = (): string[] => [socialWorld()].filter((w) => w && w !== DEFAULT_TENANT);
/** which of a world's checkouts holds its cards: the one named as the world, else its first (oldest milestone's). */
export const cardRepoOf = <R extends { name: string; path: string }>(world: string, repos: R[] | undefined): string | undefined =>
  (repos?.find((r) => r.name === world) ?? repos?.[0])?.path;
/** the kinds such a world may post and read; every other kind stays the home world's. */
export const WORLD_CARD_KINDS: readonly TeamCardKind[] = ["idea"];

export interface CardLink {
  label: string;
  url: string;
}
export interface DigestLine {
  label: string;
  state: "green" | "amber" | "red" | "unknown";
  value: string;
  /** the state at the last digest, when it changed */
  was?: "green" | "amber" | "red" | "unknown";
  /** what a line not green waits on (kept so the next digest can tell a new wait from the same one, E948-S113) */
  waits?: { who: "you" | "team"; text: string; url?: string };
}
export interface TeamCard {
  id: string;
  kind: TeamCardKind;
  /** the world that made it, when not the home world (its cards live in that world's repo). */
  world?: string;
  /** the scorecard it belongs to: a pursuit id of docs/pursuits.json (the sidebar entry). */
  scorecard?: string;
  scorecardName?: string;
  /** the key result of that goal set it is about (a row label of GET /api/scorecards); absent = the objective as a whole. */
  keyResult?: string;
  /** the persona that made it, and its run */
  by: string;
  run?: string;
  /** the row its commit names: the post's own, else the maker's standing row from the catalog. */
  row?: string;
  at: string;
  /** the Mexico City day it counts against */
  day: string;
  title: string;
  /** where it came from, one line (his note, a check, a page) */
  source?: string;
  digest?: { greens: number; total: number; prevGreens?: number; prevTotal?: number; prevDay?: string; trend: "greener" | "redder" | "same" | "first"; reasons: { text: string; url?: string; keyResult?: string }[]; lines?: DigestLine[]; news?: string[] };
  idea?: { gain: string; recommend: string; links?: CardLink[] };
  goal?: { unset: string; options: { goal: string; number: string }[]; recommend?: number; links?: CardLink[] };
  advisor?: AdvisorSet;
  answer?: { at: string; text: string; pick?: number; via: "text" | "voice" | "button"; attachments?: string[] };
  /** withdrawn by the team without his answer, because his newer word overtook it or its goal is
   * already set (`why` says which, quoting him); a closed card leaves the inbox like an answered one. Written in the repo's
   * cards file (the repo is the only source), or with closeCard. */
  closed?: { at: string; by: string; why: string };
}
export interface TeamCardsDoc {
  version: 1;
  about: string;
  cards: TeamCard[];
}

const ABOUT =
  "The team's own inbox cards for the owner (E948-S66, his vn_fe52ef4a): a daily digest per scorecard, strategic ideas, goal conversations where a goal is unset. The console reads and writes this file (GET/POST /api/inbox/team-cards); every post and answer is one commit. Limits: one digest per scorecard a day, three ideas a day, one open goal conversation per scorecard (Mexico City days).";

export function emptyDoc(): TeamCardsDoc {
  return { version: 1, about: ABOUT, cards: [] };
}

export function parseDoc(text: string): TeamCardsDoc {
  if (!text.trim()) return emptyDoc();
  const j = JSON.parse(text) as Partial<TeamCardsDoc>;
  return { version: 1, about: typeof j.about === "string" ? j.about : ABOUT, cards: Array.isArray(j.cards) ? (j.cards as TeamCard[]) : [] };
}

export function dayOf(iso: string, zone = DAY_ZONE): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const url = (v: unknown): string | undefined => {
  const s = str(v, 600);
  return s && /^(https?:\/\/|\/)[^\s]*$/.test(s) ? s : undefined;
};
const links = (v: unknown): CardLink[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((l) => ({ label: str((l as CardLink)?.label, 120), url: url((l as CardLink)?.url) }))
    .filter((l): l is CardLink => !!l.label && !!l.url)
    .slice(0, 5);
  return out.length ? out : undefined;
};
const STATES = new Set(["green", "amber", "red", "unknown"]);

function waitsOf(l: DigestLine): { waits?: DigestLine["waits"] } {
  const w = l.waits as Record<string, unknown> | undefined;
  const text = str(w?.text, 200);
  if (!w || !text || (w.who !== "you" && w.who !== "team") || l.state === "green") return {};
  const u = url(w.url);
  return { waits: { who: w.who, text, ...(u ? { url: u } : {}) } };
}

export type Checked = { ok: true; card: Omit<TeamCard, "id" | "at" | "day"> } | { ok: false; code: string; message: string };

/** the body a persona posts, checked and trimmed (no free fields kept). */
export function checkPost(b: Record<string, unknown>, day = dayOf(new Date().toISOString())): Checked {
  const kind = b.kind as TeamCardKind;
  if (!TEAM_CARD_KINDS.includes(kind)) return { ok: false, code: "bad_kind", message: "kind is digest, idea, goal or advisor" };
  const by = str(b.by, 80);
  if (!by) return { ok: false, code: "no_by", message: "by names the persona that makes the card" };
  const title = str(b.title, 200);
  if (!title) return { ok: false, code: "no_title", message: "title is one plain sentence" };
  const scorecard = typeof b.scorecard === "string" && /^[\w-]{1,80}$/.test(b.scorecard) ? b.scorecard : undefined;
  const keyResult = str(b.keyResult, 160);
  const row = typeof b.row === "string" && /^(?:[\w-]+:)?[A-Z]{1,4}\d*-[A-Z]{0,3}\d+[a-z]?$/.test(b.row.trim()) ? b.row.trim() : undefined;
  const base = { kind, by, title, scorecard, scorecardName: str(b.scorecardName, 120), ...(keyResult ? { keyResult } : {}), run: str(b.run, 80), ...(row ? { row } : {}), source: str(b.source, 400) };
  if (kind === "digest") {
    const d = (b.digest ?? {}) as Record<string, unknown>;
    if (!scorecard) return { ok: false, code: "no_scorecard", message: "a digest belongs to one scorecard (a pursuit id)" };
    const greens = Number(d.greens);
    const total = Number(d.total);
    if (!Number.isInteger(greens) || !Number.isInteger(total) || total < 1 || greens < 0 || greens > total) return { ok: false, code: "bad_numbers", message: "digest.greens and digest.total are whole numbers, greens up to total" };
    const reasons = (Array.isArray(d.reasons) ? d.reasons : [])
      .map((r) => ({ text: str((r as { text?: unknown })?.text, 300), url: url((r as { url?: unknown })?.url), keyResult: str((r as { keyResult?: unknown })?.keyResult, 160) }))
      .filter((r): r is { text: string; url: string | undefined; keyResult: string | undefined } => !!r.text)
      .map((r) => ({ text: r.text, ...(r.url ? { url: r.url } : {}), ...(r.keyResult ? { keyResult: r.keyResult } : {}) }))
      .slice(0, 3);
    if (!reasons.length) return { ok: false, code: "no_reasons", message: "a digest says why: one to three reasons" };
    const trend = ["greener", "redder", "same", "first"].includes(d.trend as string) ? (d.trend as "greener") : undefined;
    if (!trend) return { ok: false, code: "bad_trend", message: "digest.trend is greener, redder, same or first" };
    const lines = (Array.isArray(d.lines) ? d.lines : [])
      .map((l) => l as DigestLine)
      .filter((l) => typeof l?.label === "string" && STATES.has(l.state))
      .map((l) => ({ label: l.label.slice(0, 160), state: l.state, value: String(l.value ?? "").slice(0, 80), ...(l.was && STATES.has(l.was) && l.was !== l.state ? { was: l.was } : {}), ...waitsOf(l) }))
      .slice(0, 30);
    const prev = Number.isInteger(d.prevGreens) && Number.isInteger(d.prevTotal) ? { prevGreens: d.prevGreens as number, prevTotal: d.prevTotal as number, ...(str(d.prevDay, 10) ? { prevDay: str(d.prevDay, 10) } : {}) } : {};
    const news = (Array.isArray(d.news) ? d.news : []).map((n) => str(n, 200)).filter((n): n is string => !!n).slice(0, 5);
    // E948-S113 (the owner, vn_88b47f31 2026-11-15: "If there is no change here, then I don't want this digest article"):
    // a digest with the same count as the last one, no line that changed light and no news named is no card at all.
    if (d.prevGreens === greens && d.prevTotal === total && !lines.some((l) => "was" in l) && !news.length)
      return { ok: false, code: "no_news", message: "nothing moved since the last digest (same count, same lights, no news named): no card" };
    return { ok: true, card: { ...base, digest: { greens, total, ...prev, trend, reasons, ...(lines.length ? { lines } : {}), ...(news.length ? { news } : {}) } } };
  }
  if (kind === "advisor") {
    if (by !== ADVISOR_BY) return { ok: false, code: "not_advisor", message: `an advisor set is made by the ${ADVISOR_BY}` };
    const a = checkAdvisor((b.advisor ?? {}) as Record<string, unknown>, day);
    if (!a.ok) return a;
    return { ok: true, card: { ...base, advisor: a.set } };
  }
  if (kind === "idea") {
    const i = (b.idea ?? {}) as Record<string, unknown>;
    const gain = str(i.gain, 400);
    const recommend = str(i.recommend, 400);
    if (!gain || !recommend) return { ok: false, code: "bad_idea", message: "an idea says its gain and the team's recommendation" };
    return { ok: true, card: { ...base, idea: { gain, recommend, ...(links(i.links) ? { links: links(i.links) } : {}) } } };
  }
  const g = (b.goal ?? {}) as Record<string, unknown>;
  const unset = str(g.unset, 300);
  const options = (Array.isArray(g.options) ? g.options : [])
    .map((o) => ({ goal: str((o as { goal?: unknown })?.goal, 300), number: str((o as { number?: unknown })?.number, 120) }))
    .filter((o): o is { goal: string; number: string } => !!o.goal && !!o.number);
  if (!unset) return { ok: false, code: "bad_goal", message: "goal.unset names the goal that is not set" };
  if (options.length < 2 || options.length > 3) return { ok: false, code: "bad_options", message: "two or three proposed goals, each with its number" };
  if (!scorecard) return { ok: false, code: "no_scorecard", message: "a goal conversation belongs to one scorecard (a pursuit id)" };
  const recommend = Number.isInteger(g.recommend) && (g.recommend as number) >= 0 && (g.recommend as number) < options.length ? (g.recommend as number) : undefined;
  return { ok: true, card: { ...base, goal: { unset, options, ...(recommend !== undefined ? { recommend } : {}), ...(links(g.links) ? { links: links(g.links) } : {}) } } };
}

/** null when the card fits his limits, else why not. */
export function overLimit(doc: TeamCardsDoc, card: Pick<TeamCard, "kind" | "scorecard" | "advisor">, day: string, others: TeamCard[] = []): { code: string; message: string } | null {
  if (card.kind === "advisor" && doc.cards.some((c) => c.kind === "advisor" && c.advisor?.week === card.advisor?.week))
    return { code: "limit_advisor", message: `one ${ADVISOR_BY} set a week: ${card.advisor?.week} has its set` };
  if (card.kind === "digest" && doc.cards.some((c) => c.kind === "digest" && c.scorecard === card.scorecard && c.day === day))
    return { code: "limit_digest", message: `one digest per scorecard a day: ${card.scorecard} has today's (${day})` };
  // one cap across worlds: `others` are the other files' cards (the home world's and the card worlds')
  if (card.kind === "idea" && [...doc.cards, ...others].filter((c) => c.kind === "idea" && c.day === day).length >= LIMITS.ideasPerDay)
    return { code: "limit_ideas", message: `at most ${LIMITS.ideasPerDay} ideas a day: today's (${day}) are in` };
  if (card.kind === "goal" && doc.cards.some((c) => c.kind === "goal" && c.scorecard === card.scorecard && isOpen(c)))
    return { code: "limit_goal", message: `one open goal conversation per scorecard: ${card.scorecard} has one waiting for his answer` };
  return null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "card";

export function addCard(doc: TeamCardsDoc, card: Omit<TeamCard, "id" | "at" | "day">, at: string, others: TeamCard[] = []): { doc: TeamCardsDoc; card: TeamCard } | { error: { code: string; message: string } } {
  const day = dayOf(at);
  const over = overLimit(doc, card, day, others);
  if (over) return { error: over };
  let id = `tc_${day.replace(/-/g, "")}_${card.kind}_${card.world ? `${slug(card.world)}_` : ""}${slug(card.advisor ? card.advisor.week : (card.scorecard ?? card.title))}`;
  for (let n = 2; doc.cards.some((c) => c.id === id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
  const full: TeamCard = { id, ...card, at, day };
  return { doc: { ...doc, cards: [...doc.cards, full] }, card: full };
}

export function answerCard(doc: TeamCardsDoc, id: string, answer: NonNullable<TeamCard["answer"]>): { doc: TeamCardsDoc; card: TeamCard } | { error: { code: string; message: string } } {
  const card = doc.cards.find((c) => c.id === id);
  if (!card) return { error: { code: "not_found", message: "no such card" } };
  if (answer.pick !== undefined && (card.kind !== "goal" || !card.goal || answer.pick < 0 || answer.pick >= card.goal.options.length)) return { error: { code: "bad_pick", message: "pick is one of the card's proposed goals" } };
  // a second answer (more words later) adds to the first; a pick replaces it
  const text = card.answer && card.answer.text && answer.text && card.answer.text !== answer.text ? `${card.answer.text}\n\n${answer.text}` : answer.text || card.answer?.text || "";
  const pick = answer.pick ?? card.answer?.pick;
  const next: TeamCard = { ...card, answer: { ...card.answer, ...answer, text, ...(pick !== undefined ? { pick } : {}) } };
  return { doc: { ...doc, cards: doc.cards.map((c) => (c.id === id ? next : c)) }, card: next };
}

export const KIND_ORDER: Record<TeamCardKind, number> = { advisor: -1, digest: 0, idea: 1, goal: 2 };

/** open: no answer yet and not withdrawn; an advisor set while one suggestion still waits for his verdict. */
export const isOpen = (c: TeamCard) => !c.closed && (c.kind === "advisor" ? advisorOpen(c.advisor) : !c.answer);

/** the team withdraws a card he has not answered (overtaken by his newer word, or its goal already set). */
export function closeCard(doc: TeamCardsDoc, id: string, closed: NonNullable<TeamCard["closed"]>): { doc: TeamCardsDoc; card: TeamCard } | { error: { code: string; message: string } } {
  const card = doc.cards.find((c) => c.id === id);
  if (!card) return { error: { code: "not_found", message: `no team card ${id}` } };
  if (!isOpen(card)) return { error: { code: "not_open", message: `${id} is already answered or closed` } };
  if (!closed.why.trim()) return { error: { code: "bad_why", message: "say why it is withdrawn: his newer word or where its goal is set" } };
  const next: TeamCard = { ...card, closed };
  return { doc: { ...doc, cards: doc.cards.map((c) => (c.id === id ? next : c)) }, card: next };
}

/**
 * What the inbox lists: open cards (digests: only each scorecard's newest, an older one is replaced by it), then
 * answered ones of the last ANSWERED_DAYS; digests first, then ideas, then goal conversations, newest first in each.
 */
/**
 * his objectives as the inbox counts them (docs/pursuits.json): `live` the active ones, `off` the ones he
 * switched inactive. A card of an inactive objective leaves the inbox; a goal card whose objective is not live (inactive,
 * retired, renamed) is not a goal to set, so Goals to set counts one card per active objective still needing its goal.
 */
export interface CardObjectives {
  live: string[];
  off: string[];
}

/** the part of Goals to set that is his objectives: how many active ones he has, how many still need a goal. */
export interface GoalObjectives {
  active: number;
  needGoal: number;
}

export function listCards(doc: TeamCardsDoc, o: { now: string; scorecard?: string; kind?: TeamCardKind; objectives?: CardObjectives }): { open: TeamCard[]; answered: TeamCard[]; counts: Record<TeamCardKind, number>; limits: typeof LIMITS; today: string; goalObjectives?: GoalObjectives } {
  const cutoff = Date.parse(o.now) - ANSWERED_DAYS * 86_400_000;
  const newestDigest = new Map<string, string>();
  for (const c of doc.cards) if (c.kind === "digest" && c.scorecard && (newestDigest.get(c.scorecard) ?? "") < c.at) newestDigest.set(c.scorecard, c.at);
  const live = o.objectives ? new Set(o.objectives.live) : undefined;
  const off = new Set(o.objectives?.off ?? []);
  const counted = (c: TeamCard) => !(c.scorecard && off.has(c.scorecard)) && !(live && c.kind === "goal" && !c.world && !(c.scorecard && live.has(c.scorecard)));
  const keep = doc.cards.filter((c) => (!o.scorecard || c.scorecard === o.scorecard) && (!o.kind || c.kind === o.kind) && counted(c));
  const order = (a: TeamCard, b: TeamCard) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.at.localeCompare(a.at);
  const open = keep.filter((c) => isOpen(c) && (c.kind !== "digest" || newestDigest.get(c.scorecard!) === c.at)).sort(order);
  const answered = keep.filter((c) => !isOpen(c) && !!c.answer && Date.parse(c.answer.at) >= cutoff).sort((a, b) => b.answer!.at.localeCompare(a.answer!.at));
  const counts = { digest: 0, idea: 0, goal: 0, advisor: 0 } as Record<TeamCardKind, number>;
  for (const c of open) counts[c.kind]++;
  const goalObjectives = live && !o.scorecard ? { active: live.size, needGoal: new Set(open.filter((c) => c.kind === "goal" && !c.world).map((c) => c.scorecard)).size } : undefined;
  return { open, answered, counts, limits: LIMITS, today: dayOf(o.now), ...(goalObjectives ? { goalObjectives } : {}) };
}

export type AdvisorVerdict = "accept" | "decline" | "note";
/**
 * his verdict on some suggestions of an advisor set (none named: every open one, his Accept all), written to the card:
 * `rows` maps each accepted suggestion to the row its spine edit made (accepts with no row are not recorded). When no
 * suggestion is left open the card gets its answer and moves to Answered.
 */
export function applyAdvisorVerdict(
  doc: TeamCardsDoc,
  id: string,
  v: { verdict: AdvisorVerdict; items: string[]; at: string; via: "text" | "voice" | "button"; text?: string; attachments?: string[]; rows?: Record<string, string> },
): { doc: TeamCardsDoc; card: TeamCard } | { error: { code: string; message: string } } {
  const card = doc.cards.find((c) => c.id === id);
  if (!card) return { error: { code: "not_found", message: "no such card" } };
  if (card.kind !== "advisor" || !card.advisor) return { error: { code: "not_advisor", message: "only an advisor set takes accept or decline" } };
  const pick = new Set(v.items);
  let changed = 0;
  const items: AdvisorItem[] = card.advisor.items.map((i) => {
    if (!pick.has(i.id)) return i;
    if (v.verdict === "note") {
      if (!v.text) return i;
      changed++;
      return { ...i, notes: [...(i.notes ?? []), { at: v.at, text: v.text, via: v.via, ...(v.attachments?.length ? { attachments: v.attachments } : {}) }] };
    }
    if (i.verdict) return i;
    if (v.verdict === "accept" && !v.rows?.[i.id]) return i;
    changed++;
    return { ...i, verdict: { state: v.verdict === "accept" ? "accepted" : "declined", at: v.at, via: v.via, ...(v.text ? { text: v.text } : {}), ...(v.rows?.[i.id] ? { row: v.rows[i.id] } : {}) } };
  });
  if (!changed) return { error: { code: "nothing_open", message: "those suggestions already have your answer" } };
  const advisor = { ...card.advisor, items };
  const left = items.filter((i) => !i.verdict).length;
  const acc = items.filter((i) => i.verdict?.state === "accepted").length;
  const dec = items.filter((i) => i.verdict?.state === "declined").length;
  const next: TeamCard = { ...card, advisor, ...(left ? {} : { answer: { at: v.at, text: `Accepted ${acc}, declined ${dec}`, via: v.via } }) };
  return { doc: { ...doc, cards: doc.cards.map((c) => (c.id === id ? next : c)) }, card: next };
}

export function mountTeamCards(
  api: Hono,
  o: {
    writer?: SpineWriter;
    repo: () => string | undefined;
    now?: () => string;
    wrote?: (dir: string) => void;
    /** a card world's checkout that holds its cards (one of its own repos); undefined = none here. */
    worldRepo?: (world: string) => string | undefined;
    /** the card worlds (default cardWorlds()); tests pass their own. */
    worlds?: () => string[];
    /** his active and inactive objectives (docs/pursuits.json); absent = every card counts. */
    objectives?: () => CardObjectives | undefined;
    /** a persona's standing row (docs/functions/catalog.json): named in the commits of its cards. */
    rowOf?: (persona: string) => string | undefined;
  },
): void {
  const now = o.now ?? (() => new Date().toISOString());
  const worldList = o.worlds ?? cardWorlds;
  /** the caller's world: "" = the home world (or legacy trust); a card world's id; undefined = any other world (refused). */
  const callerWorld = (): string | undefined => {
    const world = credentialWorld();
    if (!world || world === DEFAULT_TENANT) return "";
    return worldList().includes(world) ? world : undefined;
  };
  const homeOnly = () => callerWorld() === "";
  const dirOf = (world: string): string | undefined => (world ? o.worldRepo?.(world) : o.repo());
  const readDir = (dir: string | undefined): TeamCardsDoc => {
    if (!dir) return emptyDoc();
    try {
      return parseDoc(fs.readFileSync(path.join(dir, TEAM_CARDS_FILE), "utf8"));
    } catch {
      return emptyDoc();
    }
  };
  /** one world's own cards; a card world's carry its name, whatever the file says, and only its kinds. */
  const readWorld = (world: string): TeamCardsDoc => {
    const doc = readDir(dirOf(world));
    if (!world) return doc;
    return { ...doc, cards: doc.cards.filter((c) => WORLD_CARD_KINDS.includes(c.kind)).map((c) => ({ ...c, world })) };
  };
  const read = (): TeamCardsDoc => readDir(o.repo());
  /** the door's view: the home file's idea cards only. */
  const doorDoc = (): TeamCardsDoc => {
    const home = read();
    return { ...home, cards: home.cards.filter((c) => WORLD_CARD_KINDS.includes(c.kind) && !c.world) };
  };
  /** the other files' cards, for the shared idea cap (every world's but `world`'s own). */
  const othersThan = (world: string): TeamCard[] => ["", ...worldList()].filter((w) => w !== world).flatMap((w) => readWorld(w).cards);
  type Result = { status: number; body: unknown };
  const write = async (
    label: string,
    change: (doc: TeamCardsDoc) => { doc: TeamCardsDoc; card: TeamCard } | { error: { code: string; message: string } },
    msg: (c: TeamCard) => string,
    why: (c: TeamCard) => string,
    dir = o.repo(),
  ): Promise<Result> => {
    if (!dir || !o.writer) return { status: 503, body: { error: { code: "no_spine_writer", message: "the console cannot write the repo here; nothing saved" } } };
    let refused: { code: string; message: string } | undefined;
    let made: TeamCard | undefined;
    const w = await o.writer.edit({
      repoDir: dir,
      path: TEAM_CARDS_FILE,
      label,
      verify: false,
      fetchFreshMs: 30_000,
      edit: (text) => {
        let doc: TeamCardsDoc;
        try {
          doc = parseDoc(text);
        } catch {
          refused = { code: "bad_file", message: `${TEAM_CARDS_FILE} is not JSON; nothing saved` };
          return { skip: "bad file" };
        }
        const r = change(doc);
        if ("error" in r) {
          refused = r.error;
          return { skip: r.error.code };
        }
        made = r.card;
        return { text: JSON.stringify(r.doc, null, 2) + "\n", msg: msg(r.card), body: why(r.card) };
      },
    });
    if (refused) return { status: refused.code === "not_found" ? 404 : refused.code.startsWith("limit_") ? 429 : 400, body: { error: refused } };
    if (w.status !== "written") return { status: w.status === "skipped" ? 409 : 502, body: { error: { code: w.status === "skipped" ? "write_skipped" : "write_failed", message: `not saved: ${w.reason ?? "unknown"}` } } };
    o.wrote?.(dir);
    return { status: 200, body: { ok: true, card: made, ...(w.sha ? { sha: w.sha } : {}) } };
  };
  const notHere = { error: { code: "world_scope", message: "team cards are not open to this world" } };
  const kindRefused = (kind: string) => ({ error: { code: "world_kind", message: `this world posts ${WORLD_CARD_KINDS.join(", ")} cards only; a ${kind} card is the home world's` } });

  api.get("/inbox/team-cards", (c) => {
    const world = callerWorld();
    // any other world: refused, as the route judge did before; never the home world's cards
    if (world === undefined) return c.json(notHere, 403);
    const asked = c.req.query("kind") as TeamCardKind | undefined;
    const kind = asked && TEAM_CARD_KINDS.includes(asked) ? asked : undefined;
    const scorecard = c.req.query("scorecard") || undefined;
    // a card world sees its own file only; the home world (the owner's inbox) its own cards plus every card world's ideas.
    // through the door (the owner on a customer site) the home world reads its own idea cards only, as a card
    // world reads its own: never a card world's, never a digest, goal or advisor card (those are the private console's).
    const doc = doorSession() ? doorDoc() : world ? readWorld(world) : (() => {
      const home = read();
      return { ...home, cards: [...home.cards, ...worldList().flatMap((w) => readWorld(w).cards)] };
    })();
    // the home inbox counts only his active objectives' cards; a card world's file has no objectives of his.
    const objectives = world || doorSession() ? undefined : o.objectives?.();
    return c.json(listCards(doc, { now: now(), scorecard, kind, ...(objectives ? { objectives } : {}) }));
  });

  api.post("/inbox/team-cards", async (c) => {
    const world = callerWorld();
    if (world === undefined) return c.json(notHere, 403);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (world && !WORLD_CARD_KINDS.includes(body.kind as TeamCardKind)) return c.json(kindRefused(String(body.kind)), 403);
    const ch = checkPost(body, dayOf(now()));
    if (!ch.ok) return c.json({ error: { code: ch.code, message: ch.message } }, 400);
    const row = ch.card.row ?? o.rowOf?.(ch.card.by);
    const card = { ...ch.card, ...(row ? { row } : {}), ...(world ? { world } : {}) };
    const dir = dirOf(world);
    if (world && !dir) return c.json({ error: { code: "no_world_repo", message: `no checkout of ${world}'s repo on this console; nothing saved` } }, 503);
    // a dry run checks the body and the limits against the files as they are (a persona tries before it writes the words)
    if (body.dryRun === true) {
      const over = overLimit(readWorld(world), card, dayOf(now()), othersThan(world));
      return over ? c.json({ error: over }, 429) : c.json({ ok: true, dryRun: true });
    }
    const at = now();
    const others = othersThan(world);
    const r = await write(
      `team card ${card.kind}`,
      (doc) => addCard(doc, card, at, others),
      (made) => withRow(`${made.by}: ${made.kind} card for the owner's inbox: ${made.title.slice(0, 80)}`, made.row),
      (made) => `${made.by}${made.world ? ` (${made.world})` : ""} posted a ${made.kind} card (${made.id}) to the owner's inbox through the console${made.run ? ` (run ${made.run})` : ""}.`,
      dir,
    );
    return c.json(r.body, r.status as 200);
  });

  api.post("/inbox/team-cards/:id/answer", async (c) => {
    // the owner answers a card world's idea cards from that world's own skin too, not only from
    // the home inbox. A card world's caller answers only its own idea cards, and only as a person logged in (a session):
    // its agents never answer the cards they post. Any other world: 403 world_scope.
    const world = callerWorld();
    if (world === undefined) return c.json(notHere, 403);
    if (world && currentAuth()?.identity.kind !== "session")
      return c.json({ error: { code: "world_scope", message: "a world's idea cards are answered by a person logged in, never by its agents" } }, 403);
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => ({}))) as { text?: unknown; pick?: unknown; via?: unknown; attachments?: unknown };
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 8000) : "";
    const pick = Number.isInteger(b.pick) ? (b.pick as number) : undefined;
    if (!text && pick === undefined) return c.json({ error: { code: "empty", message: "say something or pick a goal" } }, 400);
    const via = b.via === "voice" || b.via === "button" ? b.via : "text";
    const attachments = Array.isArray(b.attachments) ? b.attachments.filter((a): a is string => typeof a === "string").slice(0, 10) : [];
    const at = now();
    // a card world's idea card is answered in that world's file. The home world (the owner's inbox) finds it in any
    // card world's file; a card world looks in its own file only (another world's id, or a home card, is a 404).
    const where = doorSession()
      ? doorDoc().cards.some((x) => x.id === id) ? "" : undefined
      : world
      ? readWorld(world).cards.some((x) => x.id === id) ? world : undefined
      : (["", ...worldList()].find((w) => readWorld(w).cards.some((x) => x.id === id)) ?? "");
    if (where === undefined) return c.json({ error: { code: "not_found", message: "no such card" } }, 404);
    const r = await write(
      `team card answer ${id}`,
      (doc) => answerCard(doc, id, { at, text, via, ...(pick !== undefined ? { pick } : {}), ...(attachments.length ? { attachments } : {}) }),
      (card) => withRow(`The owner answered the ${card.kind} card ${card.id}`, card.row ?? o.rowOf?.(card.by)),
      (card) => `The owner's answer on the console (${via}): ${text.slice(0, 300)}${pick !== undefined && card.goal ? `\nPicked: ${card.goal.options[pick]?.goal}` : ""}\nThe card's maker (${card.by}) reads it on its next wake.`,
      dirOf(where),
    );
    return c.json(r.body, r.status as 200);
  });
  // E948-S59: his verdict on the Senior advisor's suggestions. Accept writes each suggestion's spine first (a ready row and a
  // Decisions row naming him, root L-45); a spine that refuses leaves that suggestion open. Then the set records it.
  api.post("/inbox/team-cards/:id/advisor", async (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found", message: "no team cards here" } }, 404);
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => ({}))) as { verdict?: unknown; items?: unknown; text?: unknown; via?: unknown; attachments?: unknown };
    const verdict = b.verdict === "accept" || b.verdict === "decline" || b.verdict === "note" ? b.verdict : undefined;
    if (!verdict) return c.json({ error: { code: "bad_verdict", message: "verdict is accept, decline or note" } }, 400);
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 8000) : "";
    if (verdict === "note" && !text) return c.json({ error: { code: "empty", message: "say something" } }, 400);
    const via = b.via === "voice" || b.via === "text" ? b.via : "button";
    const attachments = Array.isArray(b.attachments) ? b.attachments.filter((a): a is string => typeof a === "string").slice(0, 10) : [];
    const card = read().cards.find((x) => x.id === id);
    if (!card) return c.json({ error: { code: "not_found", message: "no such card" } }, 404);
    if (card.kind !== "advisor" || !card.advisor) return c.json({ error: { code: "not_advisor", message: "only an advisor set takes accept or decline" } }, 400);
    const named = Array.isArray(b.items) ? new Set(b.items.filter((x): x is string => typeof x === "string")) : undefined;
    const targets = card.advisor.items.filter((i) => (named ? named.has(i.id) : true) && (verdict === "note" || !i.verdict));
    if (!targets.length) return c.json({ error: { code: "nothing_open", message: "those suggestions already have your answer" } }, 409);
    const at = now();
    const rows: Record<string, string> = {};
    const failed: { item: string; reason: string }[] = [];
    if (verdict === "accept") {
      const dir = o.repo();
      if (!dir || !o.writer) return c.json({ error: { code: "no_spine_writer", message: "the console cannot write the repo here; nothing saved" } }, 503);
      const who = ownerName();
      const source = card.advisor.page ?? `${TEAM_CARDS_FILE} ${card.id}`;
      // one spine at a time, in the advisor's order (two suggestions on one spine get consecutive codes)
      for (const item of targets) {
        let made: string | undefined;
        let skip: string | undefined;
        const w = await o.writer.edit({
          repoDir: dir,
          path: item.spine,
          label: `advisor accept ${card.id} ${item.id}`,
          fetchFreshMs: 30_000,
          edit: (t, date) => {
            if (!t.trim()) return { skip: (skip = `${item.spine} is not in the repo`) };
            const r = acceptOnSpine(t, item, card.advisor!, { date, who, source, taken: repoRowIds(dir), ...(text ? { words: text } : {}) });
            if ("skip" in r) return { skip: (skip = r.skip) };
            made = r.ref;
            return { text: r.text, msg: `${made}: ${who} accepted the ${ADVISOR_BY}'s suggestion: ${item.title.slice(0, 80)}`, body: `${who} accepted it in his inbox (${card.id} ${item.id}, ${card.advisor!.week}); ${made} is ready for the Delivery manager.` };
          },
        });
        if (w.status === "written" && made) rows[item.id] = made;
        else failed.push({ item: item.id, reason: skip ?? w.reason ?? w.status });
      }
      if (!Object.keys(rows).length) return c.json({ error: { code: "spine_write_failed", message: `nothing accepted: ${failed.map((f) => `${f.item} ${f.reason}`).join("; ")}` }, failed }, 502);
    }
    const ids = targets.map((i) => i.id).filter((i) => verdict !== "accept" || rows[i]);
    const r = await write(
      `team card advisor ${id}`,
      (doc) => applyAdvisorVerdict(doc, id, { verdict, items: ids, at, via, ...(text ? { text } : {}), ...(attachments.length ? { attachments } : {}), rows }),
      (card) => withRow(`The owner ${verdict === "accept" ? "accepted" : verdict === "decline" ? "declined" : "answered"} ${ids.length} of the ${ADVISOR_BY}'s suggestions (${card.advisor?.week})`, card.row ?? o.rowOf?.(card.by)),
      () => `${verdict === "accept" ? `Ready rows: ${Object.entries(rows).map(([k, v]) => `${k} ${v}`).join(", ")}. ` : ""}${text ? `His words (${via}): ${text.slice(0, 300)}` : ""}`.trim() || "From his inbox.",
    );
    if (r.status === 200 && failed.length) return c.json({ ...(r.body as object), rows, failed }, 200);
    return c.json(r.status === 200 ? { ...(r.body as object), rows } : r.body, r.status as 200);
  });
}
