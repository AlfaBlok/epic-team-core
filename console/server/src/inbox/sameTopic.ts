/**
 * E948-S183 one card per topic. The owner, 23 Nov: a plan ask and the review card of the same work both sat in Urgent
 * asking about the same thing ("Why am I getting these duplicated objective cards even if they don't have the same
 * words"). Before a card or an ask shows, the open cards are checked against each other, and cards on one topic fold
 * into one:
 *
 *   ask ─┐   same ticket   (an ask's code, its `row` or its `unblocks` names a card's row; two asks share a code or an unblocks)
 *        ├─▶ same page     (both link the same page-host page: host:port and path)
 *   card ┘   same topic    (the same About, or nearly all of its topic words, not only the same wording)
 *                │
 *                ▼
 *   one card stays (the one shown first: an older ask keeps its card and a newer review card joins it with its
 *   evidence and decision, E948-S187; a review card stays over a newer ask), every other one is folded into it: off
 *   every list and count, its reason kept for the agents.
 *
 * Only decisions fold (approve, decide): an ask for his hands (a key box, steps, a Mac job, an answer) always shows,
 * the card alone could not take it, and so does the question on his order of work (Put X first?), which has its own place.
 *
 * Pure, no imports: the web inbox reads it too (web lib/sameTopic.ts), where asks and review cards are drawn and counted.
 */

export interface TopicCard {
  /** the card's id on its list (a waiting item id or a review card id) */
  id: string;
  kind: "ask" | "review";
  /** the code the card is known by: an ask's `E907-A2`, a review card's row `E907-S3` */
  ref?: string;
  /** the tickets the card is about (row codes and ask codes): its own code, what it unblocks */
  tickets: string[];
  /**
   * an ask's row (`row <id>` on its line): the same ticket as that row's review card, never a reason to fold two asks
   * (one row can wait on two decisions)
   */
  row?: string;
  /** the pages it opens (any URL; reduced to the page host's host and path) */
  pages: string[];
  /** the card's About line (its topic in his words) */
  about?: string;
  /** its task name or title (shown in reasons; topic words come from the About only) */
  title?: string;
  /** when it first showed (ISO) */
  since?: string;
}

export interface Fold {
  /** the card it is folded into */
  into: string;
  intoRef?: string;
  /** why, in plain words: `same ticket E907-S3`, `same page …`, `same topic: kernel` */
  reason: string;
}

/** a ticket or ask code: `E907-S3`, `E907-A2`, `TAX-S3` (never an epic, `EPIC-907`). */
const CODE = /\b(?!EPIC-)[A-Z][A-Z0-9]*-[A-Z]{0,2}\d+\b/g;
export const codesIn = (text: string | undefined): string[] => [...new Set((text ?? "").toUpperCase().match(CODE) ?? [])];

/**
 * A page-host page (its own port: one page, one row) is a topic. The console's screens, GitHub and production sites
 * (no port) are shared by many cards: never a topic.
 */
export function topicPage(url: string | undefined): string | undefined {
  try {
    const u = new URL(url ?? "");
    if (!/^https?:$/.test(u.protocol) || !u.port) return undefined;
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/(index\.html?)?$/i, "").replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}
const URLS = /https?:\/\/[^\s)\]>"'`,]+/gi;
export const urlsIn = (text: string | undefined): string[] => (text ?? "").match(URLS) ?? [];

const STOP = new Set(
  "a an the of for to on in at by and or with from about your my his our their its this that these those is are be new one all every each card cards page pages work ticket tickets ask asks review plan plans what how why where when it as".split(
    " ",
  ),
);
// "plan" and "page" are stop words: nearly every card is a plan or a page; the noun beside them carries the topic.
/** the words that carry a topic: lower case, no stop words, a plural `s` dropped. */
export function topicWords(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}

/** why two open cards are one topic, or undefined. */
export function sameTopic(a: TopicCard, b: TopicCard): string | undefined {
  if (a.kind === "ask" && b.kind === "ask") {
    // two asks: the same code (one ask in two places) or both unblocking one row
    const ta = new Set(a.tickets.map((t) => t.toUpperCase()));
    const ticket = b.tickets.map((t) => t.toUpperCase()).find((t) => ta.has(t));
    if (ticket) return `same ticket ${ticket}`;
  } else if (a.kind !== b.kind) {
    // an ask and a review card: the ask names the card's row (its code, what it unblocks, the row it was raised on)
    const [ask, card] = a.kind === "ask" ? [a, b] : [b, a];
    const ref = card.ref?.toUpperCase();
    if (ref && [...ask.tickets, ...(ask.row ? [ask.row] : [])].some((t) => t.toUpperCase() === ref)) return `same ticket ${ref}`;
  }
  // two review cards are two rows (one row code in two epics is another check's, E948-S182): only a page or a topic joins them
  const pa = new Set(a.pages.map(topicPage).filter(Boolean));
  const page = b.pages.map(topicPage).find((p) => p && pa.has(p));
  if (page) return `same page ${page}`;
  // the About line only (his topic line, E948-S172): a title is a sentence about the work, not its topic
  const wa = topicWords(a.about);
  const wb = topicWords(b.about);
  if (!wa.size || !wb.size) return undefined;
  const shared = [...wa].filter((w) => wb.has(w));
  const same = shared.length === wa.size && shared.length === wb.size;
  // at least two topic words and nearly all of them shared (or all of the shorter About), whatever the wording around
  // them: "Acme testers invite" and "Acme testers feedback" stay two cards
  const most = shared.length >= 2 && (shared.length / Math.max(wa.size, wb.size) >= 3 / 4 || shared.length === Math.min(wa.size, wb.size));
  if (same || most) return `same topic: ${shared.join(" ")}`;
  return undefined;
}

/**
 * the card that stays: the one shown first. E948-S187: an ask he saw first keeps its card when the review card of the
 * same work arrives later (the review's evidence and decision join it, web lib/sameTopic.ts); a review card stays over a
 * newer ask, on a tie, or when either has no time.
 */
const before = (a: TopicCard, b: TopicCard) => {
  const s = (a.since ?? "￿").localeCompare(b.since ?? "￿");
  if (a.kind !== b.kind && (!a.since || !b.since || !s)) return a.kind === "review" ? -1 : 1;
  return s || a.id.localeCompare(b.id);
};

/**
 * Every open card checked against every other: each group of one topic keeps one card, and every other card of the
 * group maps to the one it folds into. Groups are joined through any pair (A and B one ticket, B and C one page: one card).
 */
export function foldSameTopic(cards: TopicCard[]): Map<string, Fold> {
  const parent = cards.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const why = new Map<number, string>();
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      if (cards[i].id === cards[j].id) continue;
      const r = sameTopic(cards[i], cards[j]);
      if (!r) continue;
      const [x, y] = [find(i), find(j)];
      if (x !== y) parent[y] = x;
      if (!why.has(i)) why.set(i, r);
      if (!why.has(j)) why.set(j, r);
    }
  const groups = new Map<number, number[]>();
  cards.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out = new Map<string, Fold>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = g.map((i) => cards[i]).sort(before)[0];
    for (const i of g) {
      const c = cards[i];
      if (c.id === keep.id) continue;
      out.set(c.id, { into: keep.id, ...(keep.ref ? { intoRef: keep.ref } : {}), reason: why.get(i) ?? "same topic" });
    }
  }
  return out;
}

/** asks that are a decision, the only ones a card on the same topic can stand for. */
export const foldableAsk = (it: { ask?: string; secret?: unknown; macAgent?: unknown; putFirst?: unknown }) =>
  !it.secret && !it.macAgent && !it.putFirst && (it.ask === "approve" || it.ask === "decide");

/** An open ask as a topic card: its code and what it unblocks are its tickets, its row the row it was raised on; every link in it is a page. */
export function askTopicCard(it: {
  id: string;
  ask?: string;
  code?: string;
  row?: string;
  unblocks?: string;
  about?: string;
  title?: string;
  question?: string;
  detail?: string;
  contextText?: string;
  contextLinks?: { url: string }[];
  stepsLink?: { url: string };
  since?: string;
}): TopicCard {
  return {
    id: it.id,
    kind: "ask",
    ...(it.code ? { ref: it.code } : {}),
    tickets: [...new Set([...(it.code ? [it.code] : []), ...codesIn(it.unblocks)])],
    ...(codesIn(it.row)[0] ? { row: codesIn(it.row)[0] } : {}),
    pages: [...urlsIn(it.question), ...urlsIn(it.detail), ...urlsIn(it.contextText), ...(it.contextLinks ?? []).map((l) => l.url), ...(it.stepsLink ? [it.stepsLink.url] : [])],
    ...(it.about ? { about: it.about } : {}),
    ...(it.title ? { title: it.title } : {}),
    ...(it.since ? { since: it.since } : {}),
  };
}

/** A review card as a topic card: its row (`ref`) is what an ask names, its evidence and delivered links its pages. */
export function reviewTopicCard(r: {
  id: string;
  ref: string;
  title?: string;
  links?: { url: string }[];
  face?: { about?: string; name?: string; delivered?: { text?: string; url?: string }[] };
  verifiedAt?: string;
}): TopicCard {
  return {
    id: r.id,
    kind: "review",
    ref: r.ref,
    tickets: [],
    pages: [...(r.links ?? []).map((l) => l.url), ...(r.face?.delivered ?? []).flatMap((d) => [...(d.url ? [d.url] : []), ...urlsIn(d.text)])],
    ...(r.face?.about ? { about: r.face.about } : {}),
    ...((r.face?.name ?? r.title) ? { title: r.face?.name ?? r.title } : {}),
    ...(r.verifiedAt ? { since: r.verifiedAt } : {}),
  };
}

/** an open ask as the inbox lists it (GET /api/waiting-on-owner): only the fields the rule reads. */
export type InboxAsk = Parameters<typeof askTopicCard>[0] & {
  state?: string;
  snoozedUntil?: string | null;
  secret?: unknown;
  macAgent?: unknown;
  putFirst?: unknown;
};
/** a review card as the inbox lists it (GET /api/review-items): only the fields the rule reads. */
export interface InboxReview {
  id: string;
  ref?: string;
  state?: string;
  snoozedUntil?: string | null;
  title?: string;
  liveUrl?: string;
  links?: { url: string }[];
  face?: { about?: string; title?: string; evidence?: { url?: string }; delivered?: { text?: string; url?: string }[] };
  inboxSince?: string;
  createdAt?: string;
}

/**
 * The open cards his inbox draws, as topic cards: open decision asks (not snoozed) and review cards (not snoozed).
 * One selection for the web inbox (web lib/sameTopic.ts) and the census (scripts/inbox_census.py, E948-S186).
 */
export function inboxTopicCards(asks: InboxAsk[] | undefined, reviews: InboxReview[] | undefined): TopicCard[] {
  const out: TopicCard[] = [];
  for (const i of asks ?? []) if (i.state === "open" && !i.snoozedUntil && foldableAsk(i)) out.push(askTopicCard(i));
  for (const r of reviews ?? []) {
    if (!r.ref || r.state !== "review" || r.snoozedUntil) continue;
    out.push(
      reviewTopicCard({
        id: r.id,
        ref: r.ref,
        title: r.title,
        links: [...(r.liveUrl ? [{ url: r.liveUrl }] : []), ...(r.face?.evidence?.url ? [{ url: r.face.evidence.url }] : []), ...(r.links ?? [])],
        ...(r.face ? { face: { about: r.face.about, name: r.face.title, delivered: r.face.delivered } } : {}),
        verifiedAt: r.inboxSince ?? r.createdAt,
      }),
    );
  }
  return out;
}

/** every open card of his inbox checked against every other: the card each folded one goes into. */
export function inboxFolds(asks: InboxAsk[] | undefined, reviews: InboxReview[] | undefined): Map<string, Fold> {
  const cards = inboxTopicCards(asks, reviews);
  return cards.length < 2 ? new Map() : foldSameTopic(cards);
}
