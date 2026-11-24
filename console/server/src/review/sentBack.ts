import path from "node:path";
import type { Hono } from "hono";
import type { Store } from "../store.js";
import { resolveRepo } from "../adapters/repos.js";
import { CLOSED_STATUS, PARKED_STATUS, TEST_REPO, awaitsReview, claimOf, reviewId, rowIn, type ReviewGoal } from "./rows.js";
import type { ClosedCard } from "./afterClose.js";
import { readCardFile } from "./face.js";

/**
 * (the owner 2026-11-22 23:07Z, Team desk: "Why is it not on my inbox if it doesn't come back to me, then it
 * gets lost ... Why are these things not popping up on my inbox so that I can keep giving input until it gets built?").
 *
 * A card he sent back (Change it, a relaunch with his words) left his inbox the moment he pressed and was on no list
 * until its next round came back to review. In the 48 hours before he asked, he sent 36 cards back 50 times; while each
 * was out he could not see it, could not add to it, and asked the desk where it was. One of them (the kernel page) was
 * closed by the team after his fifth round and never came back at all.
 *
 * `GET /sent-back-cards` lists every card he sent back that is not back in review, from the spine first (L-45: a row
 * whose status says `relaunched by` or `iteration <n>` and is being worked on) and from his landed Change it presses
 * (a row whose status lost that marker, or that the team closed without bringing it back):
 *
 *   in_progress     a worker is on it now (a live run that names the row, or an unexpired claim)
 *   waiting         sent back, nobody on it now (queued for a worker)
 *   closed_by_team  the team closed it (folded, no confirm, parked) after he sent it back: shown 7 days, with why
 *
 * A row back in review is his card again and leaves this list; a row he closed himself afterwards leaves too. His notes
 * on a listed card go through `POST /closed-cards/comment` with `stage: "in_work"` (a Decisions row, the owner woken).
 */
export type SentBackState = "in_progress" | "waiting" | "closed_by_team";

export interface SentBackCard {
  /** the review card's id (the same card when it returns). */
  id: string;
  ref: string;
  repo: string;
  path: string;
  milestoneId?: string;
  /** the card's own title when he pressed (a plain sentence), else the row's. */
  title: string;
  state: SentBackState;
  /** the round being built (2 = the first round after he sent it back). */
  iteration: number;
  /** his words when he sent it back, as the row keeps them (one line). */
  words?: string;
  /** when he sent it back: the press (ISO), else the row's date (YYYY-MM-DD). */
  since?: string;
  /** who is on it now. `live`: a run that is running; else the row's claim. */
  worker?: { run: string; persona?: string; host?: string; startedAt?: string; leaseUntil?: string; live: boolean };
  /** closed_by_team: the row's status, as written. */
  why?: string;
  /** it was folded into this row, which is being worked on: the card comes back as that one. */
  continuesIn?: string;
  /** waiting on a timed check until then (no worker needed meanwhile). */
  checkAt?: string;
  /** the row's status now, as its spine has it (the fallback reads it: blocked on an ask is a round that came back). */
  status?: string;
}

/** a row being worked on (as rows.ts RUNNING, plus `waiting`: a row monitoring a timed check). */
const WORKED = /^(active|ready|running|dispatched|in[ -]progress|blocked|monitoring|testing|queued|waiting|claimed)\b/i;
/** he closed it himself after sending it back (Approve, Deny, a row he dropped or parked by his own word): his decision. */
const HIS_CLOSE = /\b(approved|denied|declined|dropped|parked|closed|cancell?ed) by\b/i;
/** the row was folded into another one: that row carries his words on. */
const FOLDED_INTO = /\bfolded into ([A-Za-z][\w.]*-[A-Za-z]?\d+)\b/i;
/** how far back a card the team closed without bringing it back is still found, so the fallback reopens it. A new close is seen within minutes; this only bounds how much history is reopened (older closes include moves and misroutes he settled by word). */
const CLOSED_SHOWN_MS = 3 * 86_400_000;

export interface SentBackRun {
  id: string;
  outcome?: string;
  summary?: string;
  clientRequestId?: string | null;
  milestoneId?: string | null;
  personaId?: string | null;
  parentRunId?: string | null;
  host?: string | null;
  startedAt?: string;
}

export interface SentBackInput {
  goals: ReviewGoal[];
  /** `repo:ref` of every row in review now (his cards). */
  inReview: Set<string>;
  /** Recently closed (afterClose.recent), newest first: his Change it presses are the `changes` ones. */
  presses: ClosedCard[];
  /** the row as its spine has it now. */
  row: (repo: string, path: string, ref: string) => { status: string; owner: string; title: string; iteration: number } | undefined;
  runs: SentBackRun[];
  personaName?: (id: string) => string | undefined;
  /** the card file's title for a row (a plain sentence), when it has one. */
  cardTitle?: (repo: string, ref: string) => string | undefined;
  now: Date;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The run working row `ref` now: its request id opens with the row (`<row>-run_…`), or its summary does. */
export function liveRunFor(runs: SentBackRun[], ref: string, milestoneId?: string): SentBackRun | undefined {
  const opens = new RegExp(`^${esc(ref)}(?![\\w-])`);
  return runs.find(
    (r) =>
      r.outcome === "running" &&
      (!milestoneId || !r.milestoneId || r.milestoneId === milestoneId) &&
      (!!r.clientRequestId?.startsWith(`${ref}-`) || opens.test(r.summary ?? "")),
  );
}

/** A running run the row's owner cell names by id (`run_<uuid>`), whatever row its request id opens with. */
export function namedRun(runs: SentBackRun[], owner: string): SentBackRun | undefined {
  const ids = new Set(owner.match(/\brun_[0-9a-f-]{8,}/gi) ?? []);
  if (!ids.size) return undefined;
  return runs.find((r) => r.outcome === "running" && [...ids].some((id) => r.id === id || r.id.startsWith(id)));
}

export function sentBackCards(d: SentBackInput): SentBackCard[] {
  const key = (repo: string, ref: string) => `${repo}:${ref}`;
  const out = new Map<string, SentBackCard>();
  const place = (c: Omit<SentBackCard, "state" | "worker" | "id">, owner: string, status = "", runRef?: string): SentBackCard => {
    // a worker named in the row's owner cell counts too: one run can carry two rows, and its request id names only one
    const run = liveRunFor(d.runs, runRef ?? c.ref, c.milestoneId) ?? namedRun(d.runs, owner);
    const claim = run ? undefined : claimOf(owner);
    const held = claim && Date.parse(claim.until.replace(/Z$/, ":00Z")) > d.now.getTime() ? claim : undefined;
    // a child run is a worker a persona started: only a persona's own run carries the persona's name
    const persona = run?.personaId && !run.parentRunId ? d.personaName?.(run.personaId) : undefined;
    const timed = run || held ? undefined : /^(?:waiting|monitoring)\b.*?\buntil (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)/i.exec(status)?.[1];
    return {
      id: reviewId(c.repo, c.path, c.ref),
      ...c,
      state: run || held ? "in_progress" : "waiting",
      ...(status ? { status: status.slice(0, 300) } : {}),
      ...(timed ? { checkAt: timed } : {}),
      ...(run
        ? { worker: { run: run.id, ...(persona ? { persona } : {}), ...(run.host ? { host: run.host } : {}), ...(run.startedAt ? { startedAt: run.startedAt } : {}), live: true } }
        : held
          ? { worker: { run: held.by, leaseUntil: held.until, live: false } }
          : {}),
    };
  };
  const pressed = new Set(d.presses.filter((p) => p.kind === "review" && p.outcome === "changes").map((p) => key(p.repo, p.ref)));
  // 1. the spine: rows whose status says he sent them back and that are still being worked on
  for (const g of d.goals) {
    if (TEST_REPO.test(g.repo)) continue;
    for (const w of g.inWork) {
      const k = key(g.repo, w.ref);
      if (out.has(k) || d.inReview.has(k)) continue;
      // a bare `iteration <n>` an agent wrote is not his send-back: the row must keep his `relaunched by` (its date or
      // his words), or one of his Change it presses must name it
      if (!w.since && !w.words && !pressed.has(k)) continue;
      const row = d.row(g.repo, g.path, w.ref);
      out.set(
        k,
        place(
          { ref: w.ref, repo: g.repo, path: g.path, ...(g.milestoneId ? { milestoneId: g.milestoneId } : {}), title: d.cardTitle?.(g.repo, w.ref) || w.title, iteration: w.iteration, ...(w.words ? { words: w.words } : {}), ...(w.since ? { since: w.since } : {}) },
          row?.owner ?? "",
          row?.status,
        ),
      );
    }
  }
  // 2. his Change it presses, the newest per row: the card's own title and minute; a row whose status lost the marker;
  //    a row the team closed without bringing it back
  const seen = new Set<string>();
  for (const p of d.presses) {
    if (p.kind !== "review" || p.outcome !== "changes" || TEST_REPO.test(p.repo)) continue;
    const k = key(p.repo, p.ref);
    if (seen.has(k)) continue;
    seen.add(k);
    const known = out.get(k);
    if (known) {
      out.set(k, { ...known, title: p.title || known.title, since: p.at, ...(p.words ? { words: p.words } : {}) });
      continue;
    }
    if (d.inReview.has(k)) continue;
    const row = d.row(p.repo, p.path, p.ref);
    if (!row || awaitsReview(row.status) || HIS_CLOSE.test(row.status)) continue;
    const base = { ref: p.ref, repo: p.repo, path: p.path, ...(p.milestoneId ? { milestoneId: p.milestoneId } : {}), title: p.title || row.title, iteration: Math.max(2, row.iteration), since: p.at, ...(p.words ? { words: p.words } : {}) };
    if (WORKED.test(row.status)) {
      out.set(k, place(base, row.owner, row.status));
      continue;
    }
    if (!(CLOSED_STATUS.test(row.status) || PARKED_STATUS.test(row.status)) || d.now.getTime() - Date.parse(p.at) > CLOSED_SHOWN_MS) continue;
    // moved to another list (`moved (to …)`): the ticket lives on there under its own status, it was not closed
    if (/^moved\b/i.test(row.status)) continue;
    // folded into another row: that row carries it. Back in review or closed by him there: nothing is lost, not listed.
    // Still being worked on: in progress, as that row. Closed by the team too (or not found): it never came back.
    let into = FOLDED_INTO.exec(row.status)?.[1];
    let target: ReturnType<SentBackInput["row"]>;
    for (let hop = 0; into && hop < 4; hop++) {
      target = d.row(p.repo, p.path, into);
      const next = target && FOLDED_INTO.exec(target.status)?.[1];
      if (!next || next === into) break;
      into = next;
    }
    if (into && target && (awaitsReview(target.status) || HIS_CLOSE.test(target.status) || d.inReview.has(key(p.repo, into)))) continue;
    // folded into a row that is not in this spine (another spine or another repo): where it went cannot be read here,
    // so it is not called closed by the team (never reopened on a guess)
    if (/\bfolded into\b/i.test(row.status) && !(into && target)) continue;
    if (into && target && WORKED.test(target.status)) out.set(k, { ...place(base, target.owner, target.status, into), continuesIn: into });
    else out.set(k, { id: reviewId(p.repo, p.path, p.ref), ...base, state: "closed_by_team", why: row.status.slice(0, 240), status: row.status.slice(0, 300) });
  }
  // the newest send-back first (a row's bare date sorts as that day's start)
  return [...out.values()].sort((a, b) => (b.since ?? "").localeCompare(a.since ?? "") || a.ref.localeCompare(b.ref));
}

export interface SentBackDeps {
  store: Pick<Store, "listMilestones" | "listRuns" | "getPersona">;
  reposRoot: string;
  goals: () => Promise<ReviewGoal[]>;
  rows: () => Promise<{ repo: string; ref: string }[]>;
  recent: (o: { days: number; limit: number; world?: string }) => ClosedCard[];
  world?: () => string | undefined;
  now?: () => Date;
}

/** The list itself, for the route and for the fallback that picks up what nobody is working (review/pickup.ts). */
export function createSentBack(d: SentBackDeps) {
  return {
    async list(): Promise<SentBackCard[]> {
      const now = d.now?.() ?? new Date();
      const [goals, rows] = await Promise.all([d.goals(), d.rows()]);
      const dirs = new Map<string, string | undefined>();
      const dirOf = (repo: string) => {
        if (!dirs.has(repo)) dirs.set(repo, resolveRepo(d.reposRoot, repo)?.path);
        return dirs.get(repo);
      };
      // the caller's world only: a repo none of its milestones read is not looked up
      const mine = new Set(d.store.listMilestones({ includeSettled: true }).map((m) => m.repo.split("/").pop()!));
      return sentBackCards({
        goals,
        inReview: new Set(rows.map((r) => `${r.repo}:${r.ref}`)),
        presses: d.recent({ days: 14, limit: 500, world: d.world?.() }),
        row: (repo, p, ref) => {
          const dir = mine.has(repo.split("/").pop()!) ? dirOf(repo) : undefined;
          return dir ? rowIn(dir, p, ref) : undefined;
        },
        // a worker's run is at most hours old; two days covers a long one
        runs: d.store.listRuns({ since: new Date(now.getTime() - 2 * 86_400_000).toISOString() }).filter((r) => r.outcome === "running"),
        personaName: (id) => d.store.getPersona(id)?.name,
        cardTitle: (repo, ref) => {
          const dir = /^[\w.-]+$/.test(ref) && mine.has(repo.split("/").pop()!) ? dirOf(repo) : undefined;
          return dir ? readCardFile(path.join(dir, "docs", "cards", `${ref}.md`))?.title : undefined;
        },
        now,
      });
    },
  };
}

export function mountSentBack(api: Hono, d: SentBackDeps) {
  const sb = createSentBack(d);
  api.get("/sent-back-cards", async (c) => c.json(await sb.list()));
}
