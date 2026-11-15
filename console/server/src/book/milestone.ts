import type { Book, BookDoneMean, BookEpic, BookEvent, BookRepo, BookState, CapabilityTable } from "./build.js";
import type { Deliverable } from "./deliverables.js";
import { withCheck, type LinkChecker } from "./links.js";

/**
 * one milestone's Epic Book, the human page for the owner (the spine is for agents). Cut from the
 * book (same sources: spines.py, Decisions, git log; same cache, so a read spawns nothing): the milestone's spine
 * and every spine under it. The narrative (goals, where we are, the plan and where we are in it, next steps) is written
 * from the spine's Goal, Done means and Current State in plain words: first sentences, no run ids or hashes; the page
 * draws the plan diagram from `tree`, never by hand.
 */

export interface BookTreeNode {
  path: string;
  code: string;
  title: string;
  parent: string | null;
  /** Depth under the milestone's spine (0 = the milestone itself). */
  depth: number;
  /** view-only fold (docs/epic-folds.json): the parent path it is drawn inside, not as its own row. */
  foldedInto?: string;
  state: BookState;
  status: string;
  dod: { done: number; total: number };
  next: string | null;
  waitingOn: string | null;
  asks: { code: string; who: string; question: string }[];
  outcome: string | null;
}

export interface MilestoneBook {
  builtAt: string;
  repo: { name: string; remote?: string };
  milestone: { id: string; title: string; path: string; code: string; state: BookState; status: string; href?: string };
  narrative: {
    /** What we are trying to do: the Goal's first paragraph, plainly. */
    goal: string | null;
    /** The Done means, each as one plain sentence: the goals the milestone is judged by, and which are met. */
    goals: BookDoneMean[];
    /** Where we are, a few plain sentences. */
    whereWeAre: string[];
    /** Next steps: the spine's Next action, then the moving and stuck epics under it. */
    next: { code?: string; text: string; stuck?: boolean }[];
    outcome: string | null;
  };
  /** The milestone's spine and every spine under it, in tree order (the plan; the page draws it). */
  tree: BookTreeNode[];
  counts: Record<BookState, number>;
  /** What happened lately on the milestone's own spine (commits and decisions, newest first). */
  timeline: BookEvent[];
  /**'s services x capabilities table, on the repo's root milestone only (agreed order: after Next steps). */
  capabilities?: CapabilityTable;
  /** when the book was last updated: the newest of a spine change, the capability probe and the daily refresh. */
  updated: BookUpdated;
  /**
   * everything made for each epic in the book (the milestone first, then the epics under it in tree order), newest
   * first, each with its last check: one section per epic, so every mockup, deck, proposal, live page and piece of
   * evidence is found here.
   */
  made: BookMade[];
}

export interface BookMade {
  path: string;
  code: string;
  title: string;
  depth: number;
  state: BookState;
  items: Deliverable[];
}

/** a book none of whose sources moved for this long shows as stale (and as stuck on /book). */
export const BOOK_STALE_MS = 2 * 86_400_000;

export interface BookUpdated {
  /** The newest of the three (ISO), null when none is known. */
  at: string | null;
  /** The newest commit touching the milestone's spine or a spine under it. */
  spineAt: string | null;
  /** The capability probe's last run (books that carry the table only). */
  probeAt: string | null;
  /** The console's last daily refresh that rebuilt the book (book/refresh.ts). */
  refreshedAt: string | null;
  stale: boolean;
}

const newest = (xs: (string | null | undefined)[]): string | null => {
  let best: string | null = null;
  for (const x of xs) if (x && !Number.isNaN(Date.parse(x)) && (!best || Date.parse(x) > Date.parse(best))) best = new Date(Date.parse(x)).toISOString();
  return best;
};

export function bookUpdated(p: { spineAt?: string | null; probeAt?: string | null; refreshedAt?: string | null }, now: number): BookUpdated {
  const at = newest([p.spineAt, p.probeAt, p.refreshedAt]);
  return {
    at,
    spineAt: newest([p.spineAt]),
    probeAt: newest([p.probeAt]),
    refreshedAt: newest([p.refreshedAt]),
    stale: !at || now - Date.parse(at) > BOOK_STALE_MS,
  };
}

const RUN_ID = /\s*\b(?:run|as|ms|tok)_[0-9a-f][0-9a-f-]{5,}/gi;
const SHA = /\s*\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/**
 * A spine field as plain words: markdown and ids out, the first sentences up to `max` characters, cut at a sentence end
 * when one is near (else at a word, with an ellipsis).
 */
export function plain(text: string | null | undefined, max = 220): string | null {
  if (!text) return null;
  let t = text
    .split(/\n\s*\n/)[0]
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(RUN_ID, "")
    .replace(SHA, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\(\s+/g, "(")
    .replace(/[,;]\s*\)/g, ")")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (end > max * 0.45) return cut.slice(0, end + 1).replace(/;$/, ".");
  t = cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max).replace(/[,;:(\s-]+$/, "");
  return `${t}…`;
}

/** ": Lanes and radar" → "Lanes and radar". */
const titleRest = (e: { title: string }) => e.title.replace(/^\s*(EPIC-\d+|M\d+)\s*[:—–-]\s*/i, "").trim() || e.title;

const STATE_WORD: Record<BookState, string> = { moving: "moving", stuck: "waiting on someone", parked: "parked", done: "done" };

function whereWeAre(root: BookEpic, under: BookEpic[], counts: Record<BookState, number>): string[] {
  const out: string[] = [];
  const g = root.doneMeans ?? [];
  if (g.length) {
    const met = g.filter((i) => i.done).length;
    out.push(met === g.length ? `All ${g.length} goals are met.` : `${met} of ${g.length} goals met${met ? "" : " so far"}.`);
  }
  if (under.length) {
    const parts = (["moving", "stuck", "parked", "done"] as BookState[]).filter((s) => counts[s]).map((s) => `${counts[s]} ${STATE_WORD[s]}`);
    out.push(`${under.length} ${under.length === 1 ? "epic" : "epics"} under it: ${parts.join(", ")}.`);
  }
  if (root.state === "stuck") {
    const asks = root.asks.map((a) => `${a.who || "someone"} (${a.code})`);
    out.push(asks.length ? `Waiting on ${[...new Set(asks)].join(", ")}.` : `Waiting on: ${plain(root.waitingOn, 160)}`);
  }
  const phase = plain(root.phase, 200);
  if (phase) out.push(phase);
  const last = plain(root.lastAttempted, 200);
  if (last) out.push(`Last step: ${last}`);
  const result = plain(root.result, 200);
  // The Result line restates the goals in agent words; it speaks only when there are no Done means to count.
  if (result && !phase && !g.length) out.push(result);
  return out;
}

/** The milestone's book from the built Epic Book; null when its repo or spine is not in it. */
export function milestoneBook(
  book: Book,
  m: { id: string; title?: string; repoName: string; path: string },
  fresh: { refreshedAt?: string | null; now?: number; links?: Pick<LinkChecker, "get"> } = {},
): MilestoneBook | null {
  const repo: BookRepo | undefined = book.repos.find((r) => r.name === m.repoName);
  const root = repo?.epics.find((e) => e.path === m.path);
  if (!repo || !root) return null;
  // The subtree in tree order: the book's epics come parents first.
  const inTree = new Set([root.path]);
  const nodes: BookEpic[] = [root];
  for (const e of repo.epics) if (e !== root && e.parent && inTree.has(e.parent)) (inTree.add(e.path), nodes.push(e));
  const under = nodes.slice(1);
  const counts: Record<BookState, number> = { moving: 0, stuck: 0, parked: 0, done: 0 };
  for (const e of under) counts[e.state]++;
  const next: MilestoneBook["narrative"]["next"] = [];
  const own = plain(root.next, 260);
  if (own) next.push({ text: own });
  for (const e of under.filter((x) => x.state === "stuck" && x.depth === root.depth + 1))
    next.push({ code: e.code, stuck: true, text: `${titleRest(e)}: waiting on ${e.asks.length ? e.asks.map((a) => `${a.who || "someone"} (${a.code})`).join(", ") : plain(e.waitingOn, 140)}` });
  for (const e of under.filter((x) => x.state === "moving" && x.depth === root.depth + 1 && x.next).slice(0, 8))
    next.push({ code: e.code, text: `${titleRest(e)}: ${plain(e.next, 160)}` });
  const capabilities = repo.capabilities && root.path === repo.root ? repo.capabilities : undefined;
  const updated = bookUpdated(
    { spineAt: newest(nodes.map((e) => e.spineChangedAt)), probeAt: capabilities?.checkedAt || null, refreshedAt: fresh.refreshedAt },
    fresh.now ?? Date.now(),
  );
  return {
    builtAt: book.builtAt,
    repo: { name: repo.name, ...(repo.remote ? { remote: repo.remote } : {}) },
    milestone: {
      id: m.id,
      title: m.title || root.title,
      path: root.path,
      code: root.code,
      state: root.state,
      status: root.status,
      ...(root.href ? { href: root.href } : {}),
    },
    narrative: {
      goal: plain(root.goal, 420),
      goals: (root.doneMeans ?? []).map((i) => ({ id: i.id, done: i.done, text: plain(i.text, 180) ?? i.id })),
      whereWeAre: whereWeAre(root, under, counts),
      next,
      outcome: plain(root.outcome, 300),
    },
    tree: nodes.map((e) => ({
      path: e.path,
      code: e.code,
      title: titleRest(e),
      parent: e === root ? null : e.parent,
      ...(e !== root && e.foldedInto ? { foldedInto: e.foldedInto } : {}),
      depth: e.depth - root.depth,
      state: e.state,
      status: e.status,
      dod: e.dod,
      next: plain(e.next, 160),
      waitingOn: plain(e.waitingOn, 160),
      asks: e.asks,
      outcome: plain(e.outcome, 160),
    })),
    counts,
    timeline: root.timeline.map((t) => ({ ...t, text: plain(t.text, 200) ?? t.text })),
    ...(capabilities ? { capabilities } : {}),
    updated,
    made: nodes.map((e) => ({ path: e.path, code: e.code, title: titleRest(e), depth: e.depth - root.depth, state: e.state, items: (e.made ?? []).map((d) => withCheck(d, fresh.links)) })),
  };
}
