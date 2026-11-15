import { HIS_WORDS_MAX } from "../hisWords.js";
import { execFile } from "node:child_process";
import { secureDeep } from "../steps/secureLinks.js";
import { TEXT_WALL_PREFIX, isPlan, planShapeProblem, textWallProblem } from "./pageShape.js";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import type { Store } from "../store.js";
import { isDm } from "../inbox/waiting.js";
import { SNOOZE_UNTIL, snoozedNow, snoozeMinute } from "../inbox/asks.js";
import { byMilestonePriority, storeRanks } from "../inbox/priority.js";
import type { PriorityLookup } from "../inbox/jordiPriority.js";
import { resolveRepo } from "../adapters/repos.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { serverTimingOf, timeWrites } from "../inbox/spineWrite.js";
import type { ReadModelHost } from "../readModel/host.js";
import { hooks } from "../plug/hooks.js";
import { approveCell, computeReviewRows, denyCell, editRowStatus, relaunchCell, snoozeCell, TEST_REPO, type DoneMeansLine, type ReviewCloses, type ClosedGoal, type ReviewGoal, type ReviewPayload, type ReviewRow, type ReviewStarted, type ReviewTag, type ReviewVerdict } from "./rows.js";
import type { CardFace } from "./face.js";
import type { NoteMark } from "./noteMarks.js";
import { CARD_FIELDS_RULE, FEATURE_LIST_RULE } from "./cardRule.js";
import { parsePostCardId, type PostCard, type PostCardInfo, type PostReview, type PostWriteResult } from "./postCards.js";
export { CARD_FIELDS_RULE, FEATURE_LIST_RULE };
import { addDecisionRow, addSwitchedOnRow, closeGoalStatus, parkProposedGoal, readyProposedGoal, reopenGoalStatus, setSwitchedCell, tickDoneMeans, writeFollowups, type FollowupPick, type FollowupRow, type Suggestion } from "./followups.js";
import { targetGoals } from "./face.js";
import { AttachError, ATTACH_MAX_PER_MESSAGE } from "../desk/attachLimits.js";
import type { Attachments } from "../desk/attachments.js";
import { hostOf, ownerName, ownerPattern, sites } from "../identity.js";

/**
 * "Done, waiting for your review" on the Team home, rebuilt by (root L-45: the repo is the only
 * source; console.db only a cache of it).
 *
 * A card is a spine ledger row whose status cell reads `review` (rows.ts `computeReviewRows`, kept by the read model as
 * the `review` view of each world). Its title and summary come from the row, its live links from the row's Latest
 * Evidence cell. A card is in review once every link answers where the owner opens it (2xx/3xx, and, when the
 * row names `live <sha>` and the URL is this console's, the deployed REVISION contains that commit); until then it is
 * pending. Those checks are a cache (`review_live`, keyed by URL and commit): dropped, they are simply made again.
 *
 * the owner's buttons write the row first, through the one spine writer (inbox/spineWrite.ts: same guards, lock, commit and
 * push on main): Approve `done (approved by the owner <date>)`, Relaunch `active (relaunched by the owner <date>: <his words>)`
 * then a wake of the milestone's Delivery manager with his words, Snooze ` — snoozed until: <until>` on the status cell
 * (Unsnooze takes it off). A refused or failed write changes nothing anywhere and the API returns why (the card shows it
 * with Retry). After a write the view is patched at once and the repo's view is rebuilt from the spine.
 */
export type ReviewState = "pending_live" | "review" | "approved" | "relaunched" | "denied";

export interface ReviewLink {
  url: string;
  title: string;
  checkedAt?: string;
  liveStatus?: number;
  liveError?: string;
}

/**
 * how long a press waits for the wake it starts after its spine write. The write is the press; the wake (a
 * pre-wake pull, a seat, T3) can take minutes on a loaded host and held the press "landing" all that time. Past this
 * the wake goes on by itself and a failure is logged (the next Delivery manager wake reads the spine either way).
 */
export const WAKE_WAIT_MS = Number(process.env.CONSOLE_PRESS_WAKE_WAIT_MS ?? 2_000);
export async function wakeSoon<T>(p: Promise<T>, what: string, ms = WAKE_WAIT_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((res) => {
    timer = setTimeout(() => res("late"), ms);
    timer.unref?.();
  });
  try {
    const r = await Promise.race([p, late]);
    if (r !== "late") return r as T;
    void p.catch((e) => console.warn(`press wake (${what}): failed after the press landed: ${(e as Error).message ?? e}; the next Delivery manager wake reads the spine`));
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface ReviewItem {
  id: string;
  title: string;
  /** The first live link ("" when the row's evidence has none). */
  liveUrl: string;
  summary?: string;
  /** The row code. */
  ref: string;
  repo: string;
  path: string;
  milestoneId?: string;
  /** The row's status cell as the spine has it. */
  status: string;
  commit?: string;
  state: ReviewState;
  /** The latest live check of the card (the first failing link's, else the first link's). */
  checkedAt?: string;
  liveStatus?: number;
  liveError?: string;
  /** The row's Last Verified date (sort key "most recent"); "" when the row has none. */
  createdAt: string;
  links: ReviewLink[];
  snoozedUntil?: string;
  /** the row was in review before the list read the spine and never reached the owner: the folded backlog list only. */
  backlogSince?: string;
  /** its row says `done` but the owner never reviewed it: a card until he marks it. */
  doneUnreviewed?: boolean;
  closes: ReviewCloses;
  /** its goal (GET /review-goals), Done-means line, what it closes, follow-ups, iteration. */
  goalKey?: string;
  line?: DoneMeansLine;
  tag?: ReviewTag;
  started?: ReviewStarted[];
  suggested?: Suggestion[];
  confirmWhy?: string;
  iteration?: number;
  /** Other open cards that complete the same Done-means line (all but the last read as a step). */
  lineWith?: string[];
  /** After a write: the commit that carries it. */
  sha?: string;
  /** After Complete: the follow-up rows written (ready = started, draft = parked). */
  followupRows?: FollowupRow[];
  /** after Complete of a card with switches, what was switched on (rows in their goals) and off (dismissed). */
  switched?: { on: { ref: string; goal: string; title: string }[]; off: { title: string; goal: string; why: string }[] };
  /**
   * `card` = on the owner's list (and in every count); anything else stays with the agents (GET
   * /review-items?state=agents): closes itself, needs evidence (incl. a dead link), card needs rewriting. `test` rows show
   * on no production list.
   */
  verdict: ReviewVerdict;
  /** the card face (the approved mockup): top line, title, goal, delivered, evidence, tree, buttons. */
  face?: CardFace;
  /** The card file in the repo, and the repo on GitHub (Details links). */
  cardPath?: string;
  github?: string;
  /** A test goal's row (on no production list; its buttons work by id). */
  test?: boolean;
  /** a held post's card (the post's own words) instead of a spine row's. */
  kind?: "post";
  post?: PostCardInfo;
  /** after a post card's Schedule or New iteration, the social write (commit, wake, the fresh export). */
  social?: PostWriteResult;
  /** a long voice note of the owner's touched this card (updated, or stale) and its owner has not acted yet. */
  noteMark?: NoteMark;
}

/** What a run PATCH may still carry (workers): only a hint that the row changed; nothing is stored. */
export const runReview = z
  .object({
    url: z.string().trim().max(500).optional(),
    title: z.string().trim().max(200).optional(),
    ref: z.string().trim().max(80).optional(),
    commit: z.string().trim().max(40).optional(),
  })
  .passthrough();
export type RunReview = z.infer<typeof runReview>;

/** his feedback, Not yet and Decline words are never cut or refused below this (HIS_WORDS_MAX). */
export const RELAUNCH_MAX = HIS_WORDS_MAX;

/** Wake prompt line: how finished work reaches the owner's review list. */
export const REVIEW_RULE =
  `Review is only for a finished outcome (root L-43) ${ownerName()} can open and judge himself: a page, a post, a feature on his phone. A step that only prepares an ask or the next build (proposal, mockup, guide, checklist page, prepared script) never goes to review: its ask is ${ownerName()}'s one card; once that ask is posted, close the row \`done (fed <ask code>)\` in the spine. ` +
  `When a step put a finished outcome live where ${ownerName()} uses it, set its ledger row's Status cell to \`review\`, with \`live <sha>\` in Latest Evidence when that commit must be deployed first. His review list is read from the spine (root L-45): the card appears once its evidence link answers (merged but not deployed never counts), and only his press closes it. Send no \`review\` on the run PATCH and never POST /api/review-items: nothing is stored there. ` +
  CARD_FIELDS_RULE +
  " Nothing a card found may be lost: in the row's Next Action write `followups: started <code> (<what it covers>), …; start <title> — <why>; park <title> — <why>; confirm: yes — <why he must confirm it>` (items split by `;`, no `|`; `followups: none` when there are none). His Start press starts or parks each next step (ready or draft rows), never drops one. " +
  "After his New iteration with feedback the row reads `active (iteration <n>, …)`: keep `iteration <n>` in Latest Evidence when you set it back to review. " +
  `A row he denied reads \`superseded (denied by ${ownerName()} <date>: …)\`: it is closed, never reopen or redo it. ` +
  FEATURE_LIST_RULE;

export interface LiveCheck {
  ok: boolean;
  status: number;
  error?: string;
  /** a page on the page host: why it fails as a plan page ("" = it opens with a drawn diagram and keeps to few words). */
  plan?: string;
}

export interface LiveCheckDeps {
  fetch?: typeof fetch;
  /** Hostnames that are this console (checked on loopback, so no shadow `agent` line): team/the social site + CONSOLE_PUBLIC_HOSTS. */
  consoleHosts?: string[];
  /** This console on loopback, e.g. http://127.0.0.1:8750. */
  localOrigin?: string;
  /** The deployed REVISION (sha), or undefined when unknown. */
  revision?: () => string | undefined;
  /** Whether `commit` is contained in `revision` (git merge-base --is-ancestor). */
  contains?: (commit: string, revision: string) => Promise<boolean>;
  timeoutMs?: number;
  /**
   * a private GitHub page answers 404 to the anonymous check, so a finished report linked there never reached
   * the list. On a github.com 404 the console asks the GitHub API as itself (`gh api <path>`): true = it exists.
   */
  githubApi?: (apiPath: string) => Promise<boolean>;
  /**
   * root L-59: the hosts one-off pages are served on (docs/pages/registry.json `hosts`). A page there must open
   * with a diagram or boxed summary; one that opens with text fails the check ("needs evidence").
   */
  pageHosts?: () => string[];
}

/** the GitHub API path that proves a github.com page exists (repo, file or folder, issue, PR), or undefined. */
export function githubApiPath(u: URL): string | undefined {
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return undefined;
  const [owner, repo, kind, ...rest] = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!owner || !repo) return undefined;
  const base = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.replace(/\.git$/, ""))}`;
  if ((kind === "blob" || kind === "tree") && rest.length >= 2) {
    const [ref, ...file] = rest;
    return `${base}/contents/${file.map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  }
  if (kind === "issues" && /^\d+$/.test(rest[0] ?? "")) return `${base}/issues/${rest[0]}`;
  if (kind === "pull" && /^\d+$/.test(rest[0] ?? "")) return `${base}/pulls/${rest[0]}`;
  if (kind === "commit" && rest[0]) return `${base}/commits/${encodeURIComponent(rest[0])}`;
  return kind ? undefined : base;
}

export const consoleHostsFromEnv = () => [hostOf(sites().teamUrl), hostOf(sites().socialUrl), ...(process.env.CONSOLE_PUBLIC_HOSTS ?? "").split(/\s+/).filter(Boolean)];

/** L-34 gate: the URL answers where the owner opens it; a console URL with `commit` must also run a release that contains it. */
export async function checkLive(url: string, commit: string | undefined, d: LiveCheckDeps = {}): Promise<LiveCheck> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, status: 0, error: "not a URL" };
  }
  const own = (d.consoleHosts ?? consoleHostsFromEnv()).includes(u.hostname);
  const target = own && d.localOrigin ? `${d.localOrigin}${u.pathname}${u.search}` : url;
  let status = 0;
  let wall: string | undefined;
  let plan: string | undefined;
  try {
    const res = await (d.fetch ?? fetch)(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(d.timeoutMs ?? 10_000) });
    status = res.status;
    const page = status >= 200 && status < 400 && (d.pageHosts?.() ?? []).includes(u.hostname) && /html/i.test(res.headers?.get?.("content-type") ?? "html");
    if (page) {
      const html = await res.text();
      wall = textWallProblem(html);
      plan = planShapeProblem(html);
    }
    else await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    return { ok: false, status: 0, error: `no answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  if (status === 404 && d.githubApi) {
    const api = githubApiPath(u);
    if (api && (await d.githubApi(api).catch(() => false))) return { ok: true, status: 200 };
  }
  if (status < 200 || status >= 400) return { ok: false, status, error: `answered ${status}` };
  const d1 = plan === undefined ? {} : { plan };
  if (wall) return { ok: false, status, error: wall, ...d1 };
  if (commit && own) {
    const rev = d.revision?.();
    if (!rev) return { ok: false, status, error: `deployed revision unknown; cannot tell whether ${commit.slice(0, 7)} is live` };
    const inIt = rev.startsWith(commit) || (await (d.contains?.(commit, rev) ?? Promise.resolve(false)).catch(() => false));
    if (!inIt) return { ok: false, status, error: `merged but not deployed: live release ${rev.slice(0, 7)} does not contain ${commit.slice(0, 7)}` };
  }
  return { ok: true, status, ...d1 };
}

/** Default deps on the console host: its own listen address for its own names, app/REVISION, git in the code repo checkout. */
export function liveCheckDepsFromEnv(o: { port: number; host?: string; repoDir?: string }): LiveCheckDeps {
  const revFile = process.env.CONSOLE_REVISION_FILE || path.resolve(process.cwd(), "..", "REVISION");
  return {
    // The address the console listens on (HOST; on the main server the tailnet IP, legacy trust = the home world, so no shadow agent line).
    localOrigin: `http://${o.host || "127.0.0.1"}:${o.port}`,
    revision: () => {
      try {
        return fs.readFileSync(revFile, "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    // the page hosts, read from the home repo's page list (no list = no page check)
    pageHosts: () => {
      if (!o.repoDir) return [];
      try {
        const reg = JSON.parse(fs.readFileSync(path.join(o.repoDir, "docs", "pages", "registry.json"), "utf8")) as { hosts?: unknown };
        return Array.isArray(reg.hosts) ? reg.hosts.filter((h): h is string => typeof h === "string") : [];
      } catch {
        return [];
      }
    },
    // private GitHub pages, as the console host's signed-in gh (the owner on the main server).
    githubApi: (apiPath) =>
      new Promise((resolve) => execFile("gh", ["api", "--silent", apiPath], { timeout: 15_000 }, (err) => resolve(!err))),
    contains: (commit, rev) =>
      new Promise((resolve) => {
        if (!o.repoDir) return resolve(false);
        execFile("git", ["-C", o.repoDir, "merge-base", "--is-ancestor", commit, rev], { timeout: 10_000 }, (err) => resolve(!err));
      }),
  };
}

/** Every link of the item for the brief: one URL as before; several as `url ("title"); …`. */
const liveList = (item: Pick<ReviewItem, "links" | "liveUrl" | "title">) => {
  const links = item.links?.length ? item.links : [{ url: item.liveUrl, title: item.title }];
  return links.length === 1 ? links[0].url : links.map((l) => `${l.url} ("${l.title}")`).join("; ");
};

/** What Relaunch sends the persona: his words are the brief (every link of the card). */
export function relaunchBrief(item: Pick<ReviewItem, "links" | "liveUrl" | "title" | "ref" | "path">, feedback: string, sha?: string): string {
  return [
    `${ownerName()} reviewed "${item.title}" (${item.ref}) (live: ${liveList(item) || "no link"}) and relaunched it with feedback.`,
    `His words, the brief: ${feedback}`,
    `The console already reopened row ${item.ref} in ${item.path} (status active, his words in it${sha ? `, commit ${sha}` : ""}): start a new worker run for it with this feedback as its brief.`,
    `Done = live where ${ownerName()} uses it (L-34); then set the row back to review with the live link in its Latest Evidence cell, so it comes back to his review list.`,
  ].join(" ");
}

export interface RelaunchCycle {
  runNowRequest(id: string, opts: { instructions?: string; instructionsBy?: string }, clientRequestId?: string): Promise<{ run: { id: string } }>;
}

/** the live check cache. Keyed by URL and commit; dropping it only costs one check per link. */
export function ensureReviewLive(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_live (
      url TEXT NOT NULL,
      commit_sha TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL,
      status INTEGER,
      error TEXT,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (url, commit_sha)
    );
  `);
  // a page's plan shape: why it fails as a plan page, "" = it passes, NULL = not a page on the page host or not checked since
  const cols = db.prepare("PRAGMA table_info(review_live)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "plan")) db.exec("ALTER TABLE review_live ADD COLUMN plan TEXT");
}

type LiveRow = { ok: number; status: number | null; error: string | null; checked_at: string; plan: string | null };

export interface ReviewOptions {
  /** The request-scoped store: its world's milestones are the repos read. */
  store: Store;
  reposRoot: string;
  writer?: SpineWriter;
  readModel?: ReadModelHost;
  /** The read model's world for this request (app.ts viewWorld). */
  world?: () => string;
  cycle?: RelaunchCycle;
  live?: LiveCheckDeps;
  /** A checkout the console just wrote: drop what was read from it (app.ts dropSpines). */
  wrote?: (dir: string) => void;
  now?: () => Date;
  recheckMs?: number;
  /** The signature on approve / relaunch (the world owner, the owner by default). */
  who?: () => string;
  /**
   * a held one-pager draft was drafted in its campaign's chat, so New iteration sends his words there (the
   * milestone chat's Repo desk), not to a persona's wake.
   */
  chatRelaunch?: (milestoneId: string, text: string) => Promise<unknown>;
  /** list test goals' rows as cards (staging only, REVIEW_SHOW_TEST_CARDS=1); production never does. */
  showTest?: boolean;
  /** held posts as cards (late-bound: the social writer mounts after the review API). */
  posts?: () => PostReview | undefined;
  /** a card he approved (row done): one answer closes many looks for open asks his approval settles (late-bound). */
  onApproved?: () => ((r: { ref: string; repo: string; path: string; title: string; by: string; sha?: string }) => void) | undefined;
}

/** a press write skips `git fetch` when its checkout fetched or pushed this recently (as an ask's Snooze). */
const FRESH_MS = 30_000;

export type ReviewListState = "review" | "snoozed" | "pending" | "backlog" | "feed" | "agents" | "test" | "all";

export type ActionResult = { item: ReviewItem } | { error: 404 | 409 | 422 | 502 | 503; code: string; message: string; item?: ReviewItem; write?: SpineWrite };

export function createReview(db: DB, o: ReviewOptions) {
  ensureReviewLive(db);
  const { store } = o;
  const now = () => o.now?.() ?? new Date();
  const iso = () => now().toISOString();
  const recheckMs = o.recheckMs ?? 60_000;
  const checking = new Map<string, Promise<void>>();
  const who = () => o.who?.() ?? ownerName();

  /** The rows in review and their goals: the read model's stored view, else (no read model) read from the spines now. */
  async function payload(): Promise<ReviewPayload> {
    if (!o.readModel) return computeReviewRows(store, o.reposRoot);
    const k = { kind: "review" as const, world: o.world?.() ?? store.tenant ?? "" };
    return (await o.readModel.view(k, async () => computeReviewRows(store, o.reposRoot))).payload as ReviewPayload;
  }
  const rows = async (): Promise<ReviewRow[]> => (await payload()).rows;
  /** the goals of the feed (headers), each with the rows it holds now. */
  /** a TEST repo's goal (the daily press test arms one, closed by it, for Reopen) is on no production list either. */
  const shownGoal = (g: { repo: string }) => !!o.showTest || !TEST_REPO.test(g.repo);
  async function goals(): Promise<ReviewGoal[]> {
    return ((await payload()).goals ?? []).filter(shownGoal);
  }
  /** Q3: the goals the owner closed (each with what it hides). */
  async function closedGoals(): Promise<ClosedGoal[]> {
    return ((await payload()).closedGoals ?? []).filter(shownGoal);
  }
  /** Q3: Reopen a goal he closed: its Status back to active, and what it hid shows again. One spine commit. */
  async function reopen(key: string): Promise<{ goal: ClosedGoal; sha?: string } | { error: 404 | 409 | 502 | 503; code: string; message: string }> {
    const g = computeReviewRows(store, o.reposRoot).closedGoals?.find((x) => x.key === key);
    if (!g) return { error: 404, code: "not_found", message: `no goal closed by ${ownerName()} with that key (it was reopened, or the spine moved on)` };
    if (!o.writer) return { error: 503, code: "no_spine_writer", message: "the console cannot write spines here; nothing changed" };
    const dir = resolveRepo(o.reposRoot, g.repo)?.path;
    if (!dir) return { error: 503, code: "repo_missing", message: `repo ${g.repo} is not checked out on the console host; nothing changed` };
    const by = who();
    const w = await o.writer.edit({
      repoDir: dir,
      path: g.path,
      label: g.code,
      group: true,
      fetchFreshMs: FRESH_MS,
      edit: (text, date) => {
        const t = reopenGoalStatus(text, date, by);
        return t === undefined
          ? { skip: `${g.code} is not closed by ${ownerName()} any more; nothing changed` }
          : { text: t, msg: `Goal ${g.code}: reopened (${by}, via console)`, body: `${by} reopened ${g.code} from the console: what it hid shows again (${g.hidden.join(", ") || "nothing open"}); Q3.` };
      },
    });
    if (w.status !== "written") return { error: w.status === "skipped" ? 409 : 502, code: w.status === "skipped" ? "spine_write_skipped" : "spine_write_failed", message: `${w.status === "skipped" ? "not written" : "spine write failed"}: ${w.reason ?? "unknown"}; nothing changed` };
    o.wrote?.(dir);
    return { goal: g, ...(w.sha ? { sha: w.sha } : {}) };
  }
  /** One row as the spine has it now (an action never acts on a stale view). */
  // only the row's own repo is read again (its repo from the stored view), not every repo's spines: a press
  // spent ~1 s of the console's main thread here on the main server. A row the stored view does not have reads every repo.
  const fresh = (id: string) => {
    const k = { kind: "review" as const, world: o.world?.() ?? store.tenant ?? "" };
    const known = (o.readModel?.peek(k)?.payload as ReviewPayload | undefined)?.rows.find((r) => r.id === id);
    const repoDir = known ? resolveRepo(o.reposRoot, known.repo)?.path : undefined;
    const hit = repoDir ? computeReviewRows(store, o.reposRoot, { repoDir }).rows.find((r) => r.id === id) : undefined;
    return hit ?? computeReviewRows(store, o.reposRoot).rows.find((r) => r.id === id);
  };
  /** no gate bypass: a button acts only on a row that passes the gate (a card), whatever calls it. */
  const notACard = (r: ReviewRow): ActionResult | undefined =>
    r.verdict.kind === "card" ? undefined : { error: 409, code: "not_a_card", message: `${r.ref} is not a card for ${ownerName()} (${r.verdict.reason ?? r.verdict.kind}${r.verdict.problems?.length ? `: ${r.verdict.problems.join("; ")}` : ""}); nothing changed` };

  const liveRow = (url: string, commit?: string) => db.prepare("SELECT ok, status, error, checked_at, plan FROM review_live WHERE url = ? AND commit_sha = ?").get(url, commit ?? "") as LiveRow | undefined;

  /** a card about a plan (its title, task goal or short name says so): its evidence page must open with a diagram. */
  const isPlanRow = (r: ReviewRow) => isPlan(r.face?.title, r.face?.taskGoal, r.face?.tree?.find((t) => t.mark === "this")?.text);

  function toItem(r: ReviewRow): ReviewItem {
    // only a card's link is checked (list, L-47), so only a card reads the check cache: a row the gate stops
    // never shows what another row's check of the same URL left there (it differed after a rebuild of the cache)
    const liveOf = (url: string, commit?: string) => (r.verdict.kind === "card" ? liveRow(url, commit) : undefined);
    const links: ReviewLink[] = r.links.map((l) => {
      const c = liveOf(l.url, r.commit);
      return { url: l.url, title: l.title, ...(c ? { checkedAt: c.checked_at, liveStatus: c.status ?? 0, ...(c.error ? { liveError: c.error } : {}) } : {}) };
    });
    const ok = links.length > 0 && r.links.every((l) => liveOf(l.url, r.commit)?.ok === 1);
    const shown = links.find((l, i) => liveOf(r.links[i].url, r.commit)?.ok !== 1) ?? links[0];
    const err = !links.length ? "no http(s) link in the row's Latest Evidence cell yet" : shown && !ok ? (shown.liveError ? (links.length > 1 ? `${shown.url}: ${shown.liveError}` : shown.liveError) : shown.checkedAt ? undefined : "not checked yet") : undefined;
    return {
      id: r.id,
      title: r.title,
      liveUrl: links[0]?.url ?? "",
      ...(r.summary ? { summary: r.summary } : {}),
      ref: r.ref,
      repo: r.repo,
      path: r.path,
      ...(r.milestoneId ? { milestoneId: r.milestoneId } : {}),
      status: r.status,
      ...(r.commit ? { commit: r.commit } : {}),
      state: ok ? "review" : "pending_live",
      ...(shown?.checkedAt ? { checkedAt: shown.checkedAt, liveStatus: shown.liveStatus } : {}),
      ...(err ? { liveError: err } : {}),
      createdAt: r.verifiedAt ?? "",
      links,
      ...(r.snoozedUntil && snoozedNow(r.snoozedUntil, now().getTime()) ? { snoozedUntil: r.snoozedUntil } : {}),
      ...(r.backlogSince ? { backlogSince: r.backlogSince } : {}),
      ...(r.doneUnreviewed ? { doneUnreviewed: true } : {}),
      closes: r.closes,
      ...(r.goalKey ? { goalKey: r.goalKey } : {}),
      ...(r.line ? { line: r.line } : {}),
      ...(r.tag ? { tag: r.tag } : {}),
      ...(r.started ? { started: r.started } : {}),
      ...(r.suggested ? { suggested: r.suggested } : {}),
      ...(r.confirmWhy ? { confirmWhy: r.confirmWhy } : {}),
      ...(r.iteration ? { iteration: r.iteration } : {}),
      ...(r.lineWith?.length ? { lineWith: r.lineWith } : {}),
      verdict: r.test && !o.showTest ? { kind: "test", reason: "a test row: on no production list" } : liveVerdict(r, ok, links, err),
      ...(r.test ? { test: true } : {}),
      ...(r.face ? { face: r.face } : {}),
      ...(r.cardPath ? { cardPath: r.cardPath } : {}),
      ...(r.github ? { github: r.github } : {}),
      ...(r.noteMark ? { noteMark: r.noteMark } : {}),
    };
  }

  /** a card whose evidence link was checked and does not open goes back to the agents (needs evidence). */
  function liveVerdict(r: ReviewRow, ok: boolean, links: ReviewLink[], err: string | undefined): ReviewVerdict {
    if (r.verdict.kind !== "card") return r.verdict;
    // a plan card whose evidence page opens without a drawn diagram goes back too (vn_c23abab6)
    const plan = ok && isPlanRow(r) ? r.links.map((l) => liveRow(l.url, r.commit)?.plan).find((p) => !!p) : undefined;
    if (plan) return { kind: "needs-evidence", reason: plan };
    if (ok) return r.verdict;
    const wall = links.find((l) => l.checkedAt && l.liveError?.startsWith(TEXT_WALL_PREFIX));
    if (wall) return { kind: "needs-evidence", reason: wall.liveError! };
    if (links.some((l) => l.checkedAt && l.liveError)) return { kind: "needs-evidence", reason: `the evidence link does not open: ${err ?? "no answer"}` };
    return r.verdict;
  }

  async function checkLink(url: string, commit: string | undefined, force = false, plan = false): Promise<void> {
    const key = `${url}\0${commit ?? ""}`;
    const c = liveRow(url, commit);
    // a plan's page checked before the diagram test is checked once more for it
    const known = c?.ok === 1 && !(plan && c.plan === null && (o.live?.pageHosts?.() ?? []).includes(hostOf(url)));
    if (!force && c && (known || Date.parse(c.checked_at) > now().getTime() - recheckMs)) return;
    let p = checking.get(key);
    if (!p) {
      p = checkLive(url, commit, o.live)
        .then((r) => {
          db.prepare(
            `INSERT INTO review_live (url, commit_sha, ok, status, error, checked_at, plan) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(url, commit_sha) DO UPDATE SET ok = excluded.ok, status = excluded.status, error = excluded.error, checked_at = excluded.checked_at, plan = excluded.plan`,
          ).run(url, commit ?? "", r.ok ? 1 : 0, r.status, r.error ?? null, iso(), r.plan ?? null);
        })
        .finally(() => checking.delete(key));
      checking.set(key, p);
    }
    return p;
  }
  /** Check every link of these rows not known to answer (and not checked in the last minute). */
  // At most 4 checks at once: a private GitHub page answers 404 and costs a `gh api` spawn on the console host.
  const checkRows = async (rs: ReviewRow[], force = false) => {
    const todo = rs.flatMap((r) => r.links.map((l) => () => checkLink(l.url, r.commit, force, isPlanRow(r)).catch(() => undefined)));
    const next = async (): Promise<void> => {
      const t = todo.shift();
      if (!t) return;
      await t();
      return next();
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, next));
  };

  /**
   * The cards: `review` (default) = live, not snoozed, not backlog (what the counts show); `snoozed`; `pending` = not live
   * yet; `backlog` = live rows marked ` — backlog since:`, folded apart; `all`. Pending links are checked in the
   * background (`wait`: before answering, tests and the recheck route).
   */
  async function list(f: { state?: ReviewListState; wait?: boolean } = {}): Promise<ReviewItem[]> {
    const rs = await rows();
    // only a card's evidence link is checked (L-47); rows the gate stops need no check
    const check = checkRows(rs.filter((r) => r.verdict.kind === "card"));
    if (f.wait) await check;
    else void check;
    const items = rs.map(toItem);
    const q = f.state ?? "review";
    if (q === "all") return [...items, ...(await postCards())];
    if (q === "test") return items.filter((i) => i.test);
    const shown = items.filter((i) => i.verdict.kind !== "test");
    // what the agents must fix (the owner never sees these): closes itself, needs evidence, card needs rewriting, and
    // cards whose evidence link is not checked yet
    if (q === "agents") return shown.filter((i) => i.verdict.kind !== "card" || i.state !== "review");
    const cards = shown.filter((i) => i.verdict.kind === "card");
    if (q === "pending") return cards.filter((i) => i.state === "pending_live");
    if (q === "snoozed") return cards.filter((i) => i.state === "review" && !!i.snoozedUntil);
    if (q === "backlog") return cards.filter((i) => i.state === "review" && !i.snoozedUntil && !!i.backlogSince);
    // every card waiting on him, its evidence link checked or not yet
    if (q === "feed") return [...cards.filter((i) => !i.snoozedUntil), ...(await postCards())];
    // one flat list; the badge, the sidebar and the header all count exactly these cards. Held posts too.
    return [...cards.filter((i) => i.state === "review" && !i.snoozedUntil), ...(await postCards())];
  }

  /** the caller's world's held posts the Writer is done with, as cards (never snoozed, never a gate verdict). */
  async function postCards(): Promise<ReviewItem[]> {
    const p = o.posts?.();
    if (!p) return [];
    return (await p.list().catch(() => [] as PostCard[])).map((c) => c as unknown as ReviewItem);
  }

  /**
   * the row a card id names, from the stored view (no spine read; every repo only when there is no stored view):
   * a press keeps it, so his words still land when the row has moved on by the time the press is written.
   */
  function card(id: string): { repo: string; path: string; ref: string; title: string; milestoneId?: string } | undefined {
    const k = { kind: "review" as const, world: o.world?.() ?? store.tenant ?? "" };
    const stored = o.readModel?.peek(k)?.payload as ReviewPayload | undefined;
    const r = (stored?.rows ?? (o.readModel ? [] : computeReviewRows(store, o.reposRoot).rows)).find((x) => x.id === id);
    return r ? { repo: r.repo, path: r.path, ref: r.ref, title: r.title, ...(r.milestoneId ? { milestoneId: r.milestoneId } : {}) } : undefined;
  }

  async function get(id: string): Promise<ReviewItem | undefined> {
    const r = fresh(id);
    return r && toItem(r);
  }

  async function recheck(id: string): Promise<ReviewItem | undefined> {
    const r = fresh(id);
    if (!r) return undefined;
    await checkRows([r], true);
    return toItem(r);
  }

  const repoDir = (r: ReviewRow) => resolveRepo(o.reposRoot, r.repo)?.path;

  /** Write the row's status cell; nothing else happens unless it is written. */
  async function writeRow(
    r: ReviewRow,
    cell: (date: string) => (status: string) => string | { skip: string },
    msg: string,
    body: string,
    verify = true,
    more?: (text: string, date: string) => string | { skip: string },
  ): Promise<{ ok: true; write: SpineWrite } | { ok: false; result: ActionResult }> {
    const item = toItem(r);
    if (!o.writer) return { ok: false, result: { error: 503, code: "no_spine_writer", message: "the console cannot write spines here; nothing changed", item } };
    const dir = repoDir(r);
    if (!dir) return { ok: false, result: { error: 503, code: "repo_missing", message: `repo ${r.repo} is not checked out on the console host; nothing changed`, item } };
    const w = await o.writer.edit({
      repoDir: dir,
      path: r.path,
      label: r.ref,
      verify,
      // a press's write shares a commit and push with presses landing close together, and skips the fetch when
      // the checkout synced in the last 30 s (a push race still fetches and rebases, up to PUSH_RACE_TRIES times)
      group: true,
      fetchFreshMs: FRESH_MS,
      edit: (text, date) => {
        const e = editRowStatus(text, r.ref, cell(date));
        if ("skip" in e) return e;
        const t = more ? more(e.text, date) : e.text;
        return typeof t === "string" ? { text: t, msg, body } : t;
      },
    });
    if (w.status !== "written" || !w.sha) {
      const message = w.status === "written" ? "the spine already had this change" : `${w.status === "skipped" ? "not written" : "spine write failed"}: ${w.reason ?? "unknown"}; nothing changed`;
      if (w.status === "written") return { ok: true, write: w };
      return { ok: false, result: { error: w.status === "skipped" ? 409 : 502, code: w.status === "skipped" ? "spine_write_skipped" : "spine_write_failed", message, item, write: w } };
    }
    o.wrote?.(dir);
    return { ok: true, write: w };
  }

  /**
   * the owner closes the card. One spine commit: the row `done (approved by the owner <date>)`; every suggested
   * follow-up becomes a row, `ready` (Start now) or `draft` (Park), never dropped; a card that completes its Done-means
   * line ticks it; one that completes the goal (or his standalone ask) also closes the goal's Status. Started rows wake
   * the Delivery manager. `start` / `park` are suggestion indices; together they must name every suggestion (default:
   * park all, which is what the old Approve does).
   */
  async function complete(id: string, pick: { start?: number[]; park?: number[]; why?: string[]; slot?: string; feedback?: string; now?: boolean; release?: boolean; choice?: string; plan?: string } = {}): Promise<ActionResult> {
    if (parsePostCardId(id)) return postAction(o.posts?.(), (p) => p.schedule(id, pick));
    const row = fresh(id);
    const res = await completeRow(id, pick);
    return row ? approved(row, res) : res;
  }
  async function completeRow(id: string, pick: { start?: number[]; park?: number[]; why?: string[]; slot?: string; feedback?: string; now?: boolean; release?: boolean; choice?: string; plan?: string } = {}): Promise<ActionResult> {
    const r = fresh(id);
    if (!r) return { error: 404, code: "not_found", message: "no row in review with that id (the spine moved on)" };
    const gate = notACard(r);
    if (gate) return gate;
    const item = toItem(r);
    if (item.state !== "review") return { error: 409, code: "not_in_review", message: `${r.ref} is not live yet: ${item.liveError ?? "its links do not answer"}`, item };
    const sug = r.suggested ?? [];
    const start = new Set(pick.start ?? []);
    const park = new Set(pick.park ?? (pick.start ? [] : sug.map((_, i) => i)));
    const all = [...start, ...park];
    if (all.some((i) => !Number.isInteger(i) || i < 0 || i >= sug.length) || [...start].some((i) => park.has(i)) || new Set(all).size !== sug.length)
      return { error: 422, code: "followups_incomplete", message: `every suggested follow-up must be started or parked, none dropped (${sug.length} suggested); nothing changed`, item };
    if (sug.some((s) => s.target)) return completeSwitches(id, r, item, sug, start, pick.why ?? []);
    // E948-S69: a decision card's button carries his pick (`Yes: plan it`): the started steps are planned first, and a
    // decision with no next step starts its plan as a new row; the pick is written on the row's status.
    const chose = pick.choice ? decisionWords(pick.choice) : undefined;
    const planFirst = !!chose && /^[^:]*:\s*plan\b/i.test(chose);
    const picks: FollowupPick[] = sug.map((s, i) => ({ title: planFirst && start.has(i) && !/^plan\b/i.test(s.title) ? `Plan: ${s.title}` : s.title, ...(s.why ? { why: s.why } : {}), start: start.has(i) }));
    if (chose && pick.plan && !sug.length) picks.push({ title: decisionWords(pick.plan), why: `you chose ${chose}`, start: true });
    const by = who();
    let made: FollowupRow[] = [];
    const closesGoal = r.tag === "goal" || r.tag === "ask";
    const what = closesGoal ? (r.tag === "ask" ? "ask complete" : `goal ${r.closes.epic} closed`) : r.tag === "line" && r.line ? `${r.line.id} met` : "step complete";
    const w = await writeRow(
      r,
      (date) => (chose ? choseCell(approveCell(r.ref, date, by), chose) : approveCell(r.ref, date, by)),
      `Review ${r.ref}: ${chose ? `${by} chose "${chose}", ` : ""}${what}${picks.length ? `, ${picks.filter((p) => p.start).length} started, ${picks.filter((p) => !p.start).length} parked` : ""} (${by}, via console)`,
      `${by} marked "${r.title}" complete on the console's review list: row ${r.ref} in ${r.path} is done (the repo is the source).` +
        (picks.length ? `\n\nSuggested follow-ups (never dropped): ${picks.map((p) => `${p.start ? "started" : "parked"}: ${p.title}`).join("; ")}.` : "") +
        (r.tag === "line" && r.line ? `\n\nDone-means ${r.line.id} is met.` : "") +
        (closesGoal ? `\n\nThe goal ${r.closes.epic} is closed by ${by}; what is still open in it stops showing until he reopens it (E48-8 Q3).` : ""),
      true,
      (text, date) => {
        let t = text;
        const f = writeFollowups(t, r.ref, picks, date, by);
        if ("skip" in f) return f;
        t = f.text;
        made = f.rows;
        if ((r.tag === "line" || closesGoal) && r.line) t = tickDoneMeans(t, r.line.id) ?? t;
        // approving a held one-pager draft makes it the owner's one-pager, in the same commit as the row.
        t = hooks.heldDraft.approve(t, r.ref, date, by) ?? t;
        if (closesGoal) t = closeGoalStatus(t, date, by) ?? t;
        return t;
      },
    );
    if (!w.ok) return w.result;
    o.readModel?.patch({ kind: "review", id, op: "closed" });
    const done: ReviewItem = { ...item, state: "approved", status: `done (approved by ${by} ${new Date().toISOString().slice(0, 10)})`, ...(w.write.sha ? { sha: w.write.sha } : {}), followupRows: made };
    const started = made.filter((m) => m.status === "ready");
    const target = relaunchTarget(r);
    if (started.length && target && o.cycle) {
      try {
        await wakeSoon(o.cycle.runNowRequest(
          target,
          {
            instructions: `${by} closed ${r.ref} ("${r.title}") and started its follow-ups: ${started.map((m) => `${m.ref} ${m.title}`).join("; ")}. The console wrote them as ready rows in ${r.path}${w.write.sha ? ` (commit ${w.write.sha})` : ""}: dispatch them.`.slice(0, RELAUNCH_MAX),
            instructionsBy: by,
          },
          `review-start:${id}:${w.write.sha ?? ""}`,
        ), `approve ${r.ref}`);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
        return { error: 502, code: "wake_failed", message: `${r.ref} is done and ${started.map((m) => m.ref).join(", ")} are ready rows in the spine (${w.write.sha ?? "written"}), but the wake failed: ${msg}. The next Delivery manager wake starts them.`, item: done, write: w.write };
      }
    }
    return { item: done };
  }
  const approve = (id: string) => complete(id);
  /** after a card is closed done by his press, the asks it settles (never blocks or fails the press). */
  const approved = (r: ReviewRow, res: ActionResult): ActionResult => {
    if ("item" in res && !("error" in res)) {
      try {
        o.onApproved?.()?.({ ref: r.ref, repo: r.repo, path: r.path, title: r.title, by: who(), ...(res.item.sha ? { sha: res.item.sha } : {}) });
      } catch {
        /* a press never fails on this */
      }
    }
    return res;
  };

  /**
   * a card whose follow-ups
   * name other goals (`in:`). One commit over every file it touches: the card's row done; each one switched on a
   * `ready` row in its goal's ledger quoting his words, with a Decisions row there (his switch is his ready stamp, L-37);
   * each one switched off a `dismissed` Decisions row in the card's own spine with his one-line reason, which the persona
   * reads so it never proposes it again. Follow-ups without a goal start or park in the card's spine as before. Started
   * rows wake the Delivery manager. Saved first and logged as a press like every review button.
   */
  async function completeSwitches(id: string, r: ReviewRow, item: ReviewItem, sug: Suggestion[], start: Set<number>, why: string[]): Promise<ActionResult> {
    if (!o.writer) return { error: 503, code: "no_spine_writer", message: "the console cannot write spines here; nothing changed", item };
    const dir = repoDir(r);
    if (!dir) return { error: 503, code: "repo_missing", message: `repo ${r.repo} is not checked out on the console host; nothing changed`, item };
    const goals = targetGoals(dir);
    const lost = sug.filter((s) => s.target && !goals.get(s.target));
    if (lost.length) return { error: 422, code: "followup_goal_missing", message: `${lost.map((s) => s.target).join(", ")} is not a goal in ${r.repo}; nothing changed`, item };
    const by = who();
    const own = r.closes.epic;
    const started: { ref: string; goal: string; rel: string; title: string }[] = [];
    const offs: { title: string; goal: string; why: string }[] = [];
    const newGoals: { goal: string; rel: string; title: string }[] = [];
    let made: FollowupRow[] = [];
    const plain = sug.map((s, i) => ({ s, i })).filter((x) => !x.s.target);
    const picks: FollowupPick[] = plain.map(({ s, i }) => ({ title: s.title, ...(s.why ? { why: s.why } : {}), start: start.has(i) }));
    const closesGoal = r.tag === "goal" || r.tag === "ask";
    const date = new Date().toISOString().slice(0, 10);
    const reason = (i: number) => (why[i] ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || `${by} switched it off`;
    const w = await o.writer.scaffold({
      repoDir: dir,
      path: r.path,
      label: r.ref,
      msg: `Review ${r.ref}: ${closesGoal ? "goal closed" : "step complete"}, ${[...start].length} switched on, ${sug.length - [...start].length} off (${by}, via console)`,
      body:
        `${by} marked "${r.title}" complete on the console's review list: row ${r.ref} in ${r.path} is done (the repo is the source).\n\n` +
        `Follow-ups (each switched on or off, none dropped): ${sug.map((s, i) => `${start.has(i) ? "on" : "off"}: ${s.title}${s.target ? ` (${s.kind === "new" ? "new goal " : ""}${s.target})` : ""}${!start.has(i) && s.target ? `, why: ${reason(i)}` : ""}`).join("; ")}.`,
      scaffold: async (root) => {
        const files = new Map<string, string>();
        const read = (rel: string) => files.get(rel) ?? fs.readFileSync(path.join(root, rel), "utf8");
        let t: string;
        try {
          t = read(r.path);
        } catch {
          return { ok: false, error: `${r.path} is not in the checkout any more` };
        }
        const e = editRowStatus(t, r.ref, approveCell(r.ref, date, by));
        if ("skip" in e) return { ok: false, error: e.skip };
        t = e.text;
        if (picks.length) {
          const f = writeFollowups(t, r.ref, picks, date, by);
          if ("skip" in f) return { ok: false, error: f.skip };
          t = f.text;
          made = f.rows;
        }
        files.set(r.path, t);
        for (const [i, s] of sug.entries()) {
          if (!s.target) continue;
          const g = goals.get(s.target)!;
          // a drafted new goal (`new:`): on readies that goal, off parks it there (plus the dismissed row below)
          if (s.kind === "new") {
            let gt: string;
            try {
              gt = read(g.rel);
            } catch {
              return { ok: false, error: `${g.rel} is not in the checkout` };
            }
            const sw = { title: s.title, from: { ref: r.ref, rel: r.path }, ...(start.has(i) ? {} : { why: reason(i) }) };
            const a = start.has(i) ? readyProposedGoal(gt, g.code, sw, date, by) : parkProposedGoal(gt, g.code, sw, date, by);
            if ("skip" in a) return { ok: false, error: a.skip };
            if (!a.already) files.set(g.rel, a.text);
            if (start.has(i)) {
              if (!a.already) newGoals.push({ goal: g.code, rel: g.rel, title: s.title });
              continue;
            }
          }
          if (start.has(i)) {
            let gt: string;
            try {
              gt = read(g.rel);
            } catch {
              return { ok: false, error: `${g.rel} is not in the checkout` };
            }
            const a = addSwitchedOnRow(gt, g.code, { title: s.title, ...(s.why ? { why: s.why } : {}), ...(s.quote ? { quote: s.quote } : {}), from: { ref: r.ref, rel: r.path } }, date, by);
            if ("skip" in a) return { ok: false, error: a.skip };
            files.set(g.rel, a.text);
            started.push({ ref: a.ref, goal: g.code, rel: g.rel, title: s.title });
          } else {
            const d = addDecisionRow(read(r.path), {
              date,
              outcome: "dismissed",
              decision: s.kind === "new" ? `Proposed goal ${g.code} switched off by ${by} in ${r.ref}, never proposed again: ${s.title}` : `Follow-up for ${g.code} switched off by ${by} in ${r.ref}, never proposed again: ${s.title}`,
              summary: reason(i),
              evidence: r.path,
              revisit: "never",
            });
            if (d === undefined) return { ok: false, error: `${r.path} has no Decisions table for the dismissed follow-up` };
            files.set(r.path, d);
            offs.push({ title: s.title, goal: g.code, why: reason(i) });
          }
        }
        let src = setSwitchedCell(read(r.path), r.ref, [...made.map((m) => ({ ref: m.ref, goal: own })), ...started.map((x) => ({ ref: x.ref, goal: x.goal }))], offs.length);
        if ((r.tag === "line" || closesGoal) && r.line) src = tickDoneMeans(src, r.line.id) ?? src;
        if (closesGoal) src = closeGoalStatus(src, date, by) ?? src;
        files.set(r.path, src);
        for (const [rel, text] of files) fs.writeFileSync(path.join(root, rel), text);
        return { ok: true, files: [...files.keys()] };
      },
    });
    if (w.status !== "written" || !w.sha) {
      if (w.status === "written") return { item };
      return { error: w.status === "skipped" ? 409 : 502, code: w.status === "skipped" ? "spine_write_skipped" : "spine_write_failed", message: `${w.status === "skipped" ? "not written" : "spine write failed"}: ${w.reason ?? "unknown"}; nothing changed`, item, write: w };
    }
    o.wrote?.(dir);
    o.readModel?.patch({ kind: "review", id, op: "closed" });
    const rows: FollowupRow[] = [...made, ...started.map((x) => ({ ref: x.ref, title: x.title, status: "ready" as const }))];
    const done: ReviewItem = {
      ...item,
      state: "approved",
      status: `done (approved by ${by} ${date})`,
      sha: w.sha,
      followupRows: rows,
      switched: { on: [...started.map((x) => ({ ref: x.ref, goal: x.goal, title: x.title })), ...newGoals.map((x) => ({ ref: x.goal, goal: x.goal, title: x.title }))], off: offs },
    };
    const wake = [
      ...made.filter((m) => m.status === "ready").map((m) => `${m.ref} ${m.title} (in ${r.path})`),
      ...started.map((x) => `${x.ref} ${x.title} (in ${x.rel})`),
      ...newGoals.map((x) => `the new goal ${x.goal} ${x.title} (${x.rel}, now ready: dispatch a Delivery Manager on it)`),
    ];
    const target = relaunchTarget(r);
    if (wake.length && target && o.cycle) {
      try {
        await wakeSoon(o.cycle.runNowRequest(
          target,
          { instructions: `${by} closed ${r.ref} ("${r.title}") and switched on: ${wake.join("; ")}. The console wrote them as ready rows (commit ${w.sha}): dispatch them.`.slice(0, RELAUNCH_MAX), instructionsBy: by },
          `review-start:${id}:${w.sha}`,
        ), `complete ${r.ref}`);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
        return { error: 502, code: "wake_failed", message: `${r.ref} is done and ${started.map((x) => x.ref).join(", ")} are ready rows (${w.sha}), but the wake failed: ${msg}. The next Delivery manager wake starts them.`, item: done, write: w };
      }
    }
    return { item: done };
  }

  /** The persona that gets the owner's words: the milestone's Delivery manager, else its first assignment. */
  function relaunchTarget(r: ReviewRow): string | undefined {
    if (!r.milestoneId) return undefined;
    const as = store.listAssignments({ milestoneId: r.milestoneId });
    return (as.find((a) => isDm(store.getPersona(a.personaId)?.name)) ?? as[0])?.id;
  }

  async function relaunch(id: string, feedback: string): Promise<ActionResult> {
    if (parsePostCardId(id)) return postAction(o.posts?.(), (p) => p.relaunch(id, feedback));
    const r = fresh(id);
    if (!r) return { error: 404, code: "not_found", message: "no row in review with that id (the spine moved on)" };
    const gate = notACard(r);
    if (gate) return gate;
    const item = toItem(r);
    if (o.chatRelaunch && r.milestoneId && heldDraftRow(r)) return relaunchInChat(r, item, feedback);
    // a TEST row (the daily press test's) takes the feedback write like any card, but nobody is woken for it
    const target = r.test ? undefined : relaunchTarget(r);
    if (r.test) {
      const by = who();
      const w = await writeRow(
        r,
        (date) => relaunchCell(r.ref, date, feedback, by, (r.iteration ?? 1) + 1),
        `Review ${r.ref}: relaunched (${by}, via console)`,
        `${by} relaunched the TEST row "${r.title}" from the console: row ${r.ref} in ${r.path} is active again. A TEST row wakes nobody.\n\nHis words: ${feedback}`,
      );
      if (!w.ok) return w.result;
      o.readModel?.patch({ kind: "review", id, op: "closed" });
      return { item: { ...item, state: "relaunched", ...(w.write.sha ? { sha: w.write.sha } : {}) } };
    }
    if (!target) return { error: 422, code: "relaunch_failed", message: "no persona to relaunch: the row's milestone has no assignment; nothing changed", item };
    if (!o.cycle) return { error: 503, code: "relaunch_failed", message: "the console cycle is off; nothing can be woken, nothing changed", item };
    const by = who();
    const w = await writeRow(
      r,
      (date) => relaunchCell(r.ref, date, feedback, by, (r.iteration ?? 1) + 1),
      `Review ${r.ref}: relaunched (${by}, via console)`,
      `${by} relaunched "${r.title}" from the console's review list: row ${r.ref} in ${r.path} is active again.\n\nHis words: ${feedback}`,
    );
    if (!w.ok) return w.result;
    o.readModel?.patch({ kind: "review", id, op: "closed" });
    const done: ReviewItem = { ...item, state: "relaunched", ...(w.write.sha ? { sha: w.write.sha } : {}) };
    try {
      await wakeSoon(o.cycle.runNowRequest(target, { instructions: relaunchBrief(item, feedback, w.write.sha).slice(0, RELAUNCH_MAX), instructionsBy: by }, `review:${id}:${w.write.sha ?? ""}`), `relaunch ${r.ref}`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      return { error: 502, code: "wake_failed", message: `row ${r.ref} is active again in the spine (${w.write.sha ?? "written"}), but the wake failed: ${msg}. The next Delivery manager wake picks the row up.`, item: done, write: w.write };
    }
    return { item: done };
  }

  /**
   * Deny: the third outcome next to Approve and Feedback. The row closes as `superseded (denied by the owner <date>: <why>)`
   * (closed, never done); a held post is not posted (Don't post). Nobody is woken: there is no next round.
   */
  async function deny(id: string, reason: string): Promise<ActionResult> {
    if (parsePostCardId(id)) return postAction(o.posts?.(), (p) => p.deny(id));
    const r = fresh(id);
    if (!r) return { error: 404, code: "not_found", message: "no row in review with that id (the spine moved on)" };
    const gate = notACard(r);
    if (gate) return gate;
    const item = toItem(r);
    const by = who();
    const w = await writeRow(
      r,
      (date) => denyCell(r.ref, date, reason, by),
      `Review ${r.ref}: denied (${by}, via console)`,
      `${by} denied "${r.title}" from the console's review list: row ${r.ref} in ${r.path} is closed as superseded, not done.${reason.trim() ? `\n\nHis words: ${reason.trim()}` : ""}`,
    );
    if (!w.ok) return w.result;
    o.readModel?.patch({ kind: "review", id, op: "closed" });
    return { item: { ...item, state: "denied", status: `superseded (denied by ${by} ${new Date().toISOString().slice(0, 10)})`, ...(w.write.sha ? { sha: w.write.sha } : {}) } };
  }

  /** a post card's Schedule or New iteration, through the social writer; the card leaves the list at once. */
  async function postAction(p: PostReview | undefined, fn: (p: PostReview) => Promise<import("./postCards.js").PostActionResult>): Promise<ActionResult> {
    if (!p) return { error: 503, code: "no_pack_skill", message: "held posts are not readable on this console; nothing changed" };
    const r = await fn(p);
    if ("error" in r) return { error: r.error === 404 || r.error === 409 || r.error === 422 || r.error === 502 || r.error === 503 ? r.error : 502, code: r.code, message: r.message, ...(r.item ? { item: r.item as unknown as ReviewItem } : {}) };
    return { item: { ...(r.item as unknown as ReviewItem), social: r.write } };
  }

  /** is this row the one a campaign's one-pager draft is held under? */
  function heldDraftRow(r: ReviewRow): boolean {
    const dir = repoDir(r);
    if (!dir) return false;
    try {
      return hooks.heldDraft.isHeld(fs.readFileSync(path.join(dir, r.path), "utf8"), r.ref);
    } catch {
      return false;
    }
  }

  /** New iteration on a held one-pager draft: the row goes back to active and his words go to the campaign chat. */
  async function relaunchInChat(r: ReviewRow, item: ReviewItem, feedback: string): Promise<ActionResult> {
    const by = who();
    const w = await writeRow(
      r,
      (date) => relaunchCell(r.ref, date, feedback, by, (r.iteration ?? 1) + 1),
      `Review ${r.ref}: one-pager draft sent back to the campaign chat (${by}, via console)`,
      `${by} asked for a new version of the one-pager draft held as ${r.ref} in ${r.path}.\n\nHis words: ${feedback}`,
    );
    if (!w.ok) return w.result;
    o.readModel?.patch({ kind: "review", id: item.id, op: "closed" });
    const done: ReviewItem = { ...item, state: "relaunched", ...(w.write.sha ? { sha: w.write.sha } : {}) };
    try {
      await o.chatRelaunch!(
        r.milestoneId!,
        `About the one-pager draft (${r.ref}) from my review list: ${feedback}\n\nRedraft it with me, then hold the new version for me again with the onepager/draft call (same row).`,
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      return { error: 502, code: "wake_failed", message: `row ${r.ref} is active again (${w.write.sha ?? "written"}), but the campaign chat did not take the message: ${msg}. Say it in the campaign's Chat tab.`, item: done, write: w.write };
    }
    return { item: done };
  }

  async function snooze(id: string, until: string | undefined, park = false): Promise<ActionResult> {
    if (parsePostCardId(id)) return { error: 409, code: "not_snoozable", message: "a held post is not snoozed: it waits at its slot; nothing changed" };
    const r = fresh(id);
    if (!r) return { error: 404, code: "not_found", message: "no row in review with that id (the spine moved on)" };
    const gate = notACard(r);
    if (gate) return gate;
    const w = await writeRow(
      r,
      () => snoozeCell(r.ref, until),
      // E948-S83 iteration 2: Park is the card's own button (a month's snooze); the commit and Decisions say parked.
      until ? `Review ${r.ref}: ${park ? "parked" : "snoozed"} until ${until} (${who()}, via console)` : `Review ${r.ref}: ${park ? "brought back" : "unsnoozed"} (${who()}, via console)`,
      until
        ? park
          ? `${who()} parked "${r.title}" with the card's Park button: it left the inbox until ${until} and comes back by itself; the row stays in review, nothing was decided. Bring it back from Parked in the inbox.`
          : `${who()} snoozed "${r.title}" on the console's review list until ${until}: the card is hidden until then; the row stays in review.`
        : `${who()} ${park ? "brought back" : "unsnoozed"} "${r.title}": the card is back on the review list.`,
      false,
    );
    if (!w.ok) return w.result;
    o.readModel?.patch({ kind: "review", id, op: "snoozed", until: until ?? null });
    const item = toItem(r);
    const { snoozedUntil: _s, ...rest } = item;
    return { item: { ...rest, ...(until ? { snoozedUntil: until } : {}), ...(w.write.sha ? { sha: w.write.sha } : {}) } };
  }

  /** the card's screenshot file (an image in the row's repo), for GET /review-items/:id/screenshot. */
  // E948-S62: `width` picks one of the quality check's live screens (390 = the phone one, 1280 = the laptop one)
  async function screenshot(id: string, width?: number): Promise<{ abs: string; type: string } | undefined> {
    const r = (await rows()).find((x) => x.id === id) ?? fresh(id);
    const rel = width ? r?.face?.qc?.shots.find((s) => s.width === width)?.path : r?.face?.screenshot;
    const dir = r ? repoDir(r) : undefined;
    if (!rel || !dir) return undefined;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) return undefined;
    const ext = path.extname(abs).slice(1).toLowerCase();
    const type = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext];
    return type && fs.existsSync(abs) ? { abs, type } : undefined;
  }

  /** A worker said its row changed (the old run PATCH `review` / POST /review-items): re-read the spines. */
  function hint(milestoneId?: string) {
    const m = milestoneId ? store.getMilestone(milestoneId) : undefined;
    const dir = m ? resolveRepo(o.reposRoot, m.repo)?.path : undefined;
    if (dir) o.readModel?.dirty(dir);
    else o.readModel?.dirtyAll();
  }

  /**
   * a row in review that the console reads as closing itself (no `confirm: yes`, its ask answered, an example for
   * another card, its next steps already run) is no card for the owner, so it must not read `review` in the spine either: the
   * one spine writer sets it `done (no confirm: <why>)` at once, so spine and feed agree. A refused or failed write is
   * tried again after `retryMs`; until then the Delivery manager's review-gate wake still names it.
   */
  const closeTried = new Map<string, number>();
  async function closeSelf(retryMs = 10 * 60_000): Promise<{ ref: string; path: string; status: "written" | "skipped" | "failed"; sha?: string; reason?: string }[]> {
    const out: { ref: string; path: string; status: "written" | "skipped" | "failed"; sha?: string; reason?: string }[] = [];
    if (!o.writer) return out;
    // the candidates come from the stored review view (the indexer keeps it), not a fresh read of every spine on
    // this thread each minute (~1 s on the main server, logged as a blocked event loop). The write itself re-reads the row's status.
    for (const r of (await payload()).rows) {
      if (r.verdict.kind !== "closes-itself") continue;
      const k = `${r.repo}\0${r.path}\0${r.ref}`;
      if ((closeTried.get(k) ?? 0) > now().getTime()) continue;
      const why = selfCloseWhy(r.verdict.reason);
      const w = await writeRow(
        r,
        () => (st) => (/^review\b/i.test(st.trim()) ? `done (no confirm: ${why})` : { skip: `${r.ref} is not in review any more` }),
        `Close ${r.ref}: done (no confirm), nothing for ${ownerName()} to judge (console)`,
        `The agent-team console closed row ${r.ref} in ${r.path}: it was in review but is no card for ${ownerName()} (${why}), so the spine now says what the review feed shows.`,
        false,
      );
      if (w.ok) {
        closeTried.delete(k);
        out.push({ ref: r.ref, path: r.path, status: "written", ...(w.write.sha ? { sha: w.write.sha } : {}) });
      } else {
        closeTried.set(k, now().getTime() + retryMs);
        const e = "error" in w.result ? w.result : undefined;
        out.push({ ref: r.ref, path: r.path, status: e?.error === 409 ? "skipped" : "failed", reason: e?.message ?? "not written" });
      }
    }
    return out;
  }

  return { list, get, card, recheck, approve, complete, relaunch, deny, snooze, hint, rows, goals, closedGoals, reopen, toItem, screenshot, closeSelf };
}

/** the verdict's reason as status words: no backticks, brackets or pipes (the status cell ends at `)`). */
export function selfCloseWhy(reason: string | undefined): string {
  const r = (reason ?? "").replace(new RegExp(`^nothing for ${ownerPattern()} to open and judge: the row has no \`confirm: yes\`$`), `nothing for ${ownerName()} to open and judge`);
  return r.replace(/[`()|\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160) || `nothing for ${ownerName()} to open and judge`;
}
export type Review = ReturnType<typeof createReview>;

/** The cards of one store's world as WhatsApp notices see them (in review, not snoozed). */
export function reviewItemsOf(db: DB, store: Store, reposRoot: string): ReviewItem[] {
  const r = createReview(db, { store, reposRoot });
  return computeReviewRows(store, reposRoot)
    .rows.map(r.toItem)
    .filter((i) => i.verdict.kind === "card" && i.state === "review" && !i.snoozedUntil);
}

const reviewSnoozeIn = z
  .object({
    hours: z.literal(3).optional(),
    days: z.union([z.literal(3), z.literal(7), z.literal(30)]).optional(),
    until: z.string().regex(new RegExp(`^${SNOOZE_UNTIL}$`)).nullable().optional(),
    /** E948-S83 iteration 2: pressed as Park (the card's own button), so the spine says parked. */
    park: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => [b.hours, b.days, b.until].filter((v) => v !== undefined).length === 1, { message: "one of hours, days or until" });
// a held post's card also takes `slot` (a new time, UTC), `feedback` (schedule after this change), `now` (Post now)
/** E948-S69: his pick in words a status cell holds (no brackets, pipes or semicolons, one line, at most 120). */
export const decisionWords = (s: string) => s.replace(/[()|;\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
/** `done (approved by Sam 2026-11-13)` + his pick: `done (approved by Sam 2026-11-13, chose No: park it)`. */
export const choseCell =
  <T,>(cell: (status: string) => string | T, chose: string) =>
  (status: string): string | T => {
    const c = cell(status);
    return typeof c === "string" && /^done \(approved by [^)]*\)$/.test(c) ? `${c.slice(0, -1)}, chose ${chose})` : c;
  };
const completeIn = z
  .object({
    start: z.array(z.number().int()).max(50).optional(),
    park: z.array(z.number().int()).max(50).optional(),
    // per follow-up index, the one-line reason of a switch turned off
    why: z.array(z.string().max(300)).max(50).optional(),
    slot: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/, "a UTC time like 2026-11-03T09:00Z").optional(),
    feedback: z.string().trim().max(HIS_WORDS_MAX).optional(),
    now: z.boolean().optional(),
    release: z.boolean().optional(),
    // E948-S69: the decision button he pressed, and a plan row to start when the decision has no next step
    choice: z.string().trim().min(1).max(120).optional(),
    plan: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
/** `attachments` = ids of files he uploaded first (POST /api/chat/attachments); their links follow his words. */
const cardFiles = z.array(z.string().trim().max(40)).max(ATTACH_MAX_PER_MESSAGE).optional();
const relaunchIn = z.object({ feedback: z.string().trim().max(RELAUNCH_MAX).default(""), attachments: cardFiles }).strict().refine((b) => !!b.feedback || !!b.attachments?.length);
const denyIn = z.object({ reason: z.string().trim().max(RELAUNCH_MAX).default(""), attachments: cardFiles }).strict();

export const HINT_MESSAGE =
  "nothing is stored here any more: the review list is read from the spine. Set the row's Status to `review` and put the live link in its Latest Evidence cell; the console re-read the spines.";

/** `priorities` = the owner's levels from the repo (the Prioritizer's docs/priorities.json); the list sorts by them first. */
export function mountReview(
  api: Hono,
  review: Review,
  store: Pick<Store, "listMilestones">,
  attachments?: Pick<Attachments, "cardText">,
  priorities?: () => PriorityLookup | undefined,
) {
  /** his words with the links of the files he sent along (a world's file only; another world's id is a 404). */
  const withFiles = (text: string, ids: string[] | undefined) => {
    if (!ids?.length) return text;
    if (!attachments) throw new AttachError(400, "no_attachments", "this console takes no attachments");
    return attachments.cardText(text, ids);
  };
  const filesFailed = (e: unknown) => (e instanceof AttachError ? { error: { code: e.code, message: e.message }, status: e.status } : undefined);
  // a button's spine write sends its steps (lock wait, fetch, commit, push) as Server-Timing; the press log keeps them.
  for (const route of ["/review-items/:id/*", "/review-goals/*"])
    api.use(route, async (c, next) => {
      if (c.req.method !== "POST") return next();
      const { steps } = await timeWrites(() => next());
      if (!Object.keys(steps).length) return;
      // c.header, not c.res.headers.set (@hono/node-server's response drops a header set that way when it is rebuilt)
      try {
        c.header("Server-Timing", serverTimingOf(steps));
      } catch {
        /* immutable headers: the press worker's own tally still has the steps */
      }
    });
  const fail = (r: Extract<ActionResult, { error: number }>) => ({ error: { code: r.code, message: r.message, ...(r.item ? { item: r.item } : {}) } });
  // ?state=review (default: what waits on the owner, not snoozed, not backlog) | snoozed | pending (not live yet) | backlog | all
  api.get("/review-items", async (c) => {
    const q = c.req.query("state");
    const state = q === "snoozed" || q === "pending" || q === "backlog" || q === "feed" || q === "agents" || q === "test" || q === "all" ? q : "review";
    // by milestone priority (sidebar order); within one milestone the most recently verified first.
    const ms = store.listMilestones({ includeSettled: true });
    const titles = new Map(ms.map((m) => [m.id, m.title]));
    const items = (await review.list({ state })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.ref.localeCompare(b.ref));
    // the owner's level (high, normal, low) first, each card with its why.
    // a card's links to a steps page (or a page beside it on its host) open its secure copy: Voice records at once
    return c.json(
      byMilestonePriority(items, storeRanks(store), priorities?.()).map((i) => {
        const j = { ...i, links: secureDeep(i.links), ...(i.face ? { face: secureDeep(i.face) } : {}) };
        return i.milestoneId && titles.has(i.milestoneId) ? { ...j, milestoneTitle: titles.get(i.milestoneId) } : j;
      }),
    );
  });
  // Snooze on a review card, as on an ask: `hours` (3), `days` (3, 7, 30) or `until`; `until: null` unsnoozes.
  api.post("/review-items/:id/snooze", async (c) => {
    const p = reviewSnoozeIn.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: { code: "validation_error", message: "send hours (3), days (3, 7 or 30), until (YYYY-MM-DD or YYYY-MM-DDTHH:MMZ) or until: null to unsnooze" } }, 400);
    const until = p.data.until === null ? undefined : (p.data.until ?? snoozeMinute((p.data.hours ?? 0) + (p.data.days ?? 0) * 24));
    if (until && !snoozedNow(until)) return c.json({ error: { code: "validation_error", message: "until must be later than now" } }, 400);
    const r = await review.snooze(c.req.param("id"), until, p.data.park === true);
    if ("error" in r) return c.json(fail(r), r.error);
    return c.json({ ...r.item, snoozedUntil: r.item.snoozedUntil ?? null });
  });
  // no longer a store. A worker's report is only a hint: the spines are re-read.
  api.post("/review-items", async (c) => {
    const b = (await c.req.json().catch(() => undefined)) as { milestoneId?: unknown } | undefined;
    review.hint(typeof b?.milestoneId === "string" ? b.milestoneId : undefined);
    return c.json({ hint: true, message: HINT_MESSAGE }, 202);
  });
  // the card's screenshot (it links to the live thing; the image itself is served from the repo)
  api.get("/review-items/:id/screenshot", async (c) => {
    const f = await review.screenshot(c.req.param("id"), Number(c.req.query("width")) || undefined);
    if (!f) return c.json({ error: { code: "not_found", message: "no screenshot for that card" } }, 404);
    return new Response(fs.readFileSync(f.abs), { headers: { "content-type": f.type, "cache-control": "private, max-age=300" } });
  });
  api.post("/review-items/:id/recheck", async (c) => {
    const item = await review.recheck(c.req.param("id"));
    if (!item) return c.json({ error: { code: "not_found", message: "no row in review with that id" } }, 404);
    return c.json(item);
  });
  // the goals of the feed (headers: Done-means bar, running / parked / in work, steps closed by themselves).
  api.get("/review-goals", async (c) => {
    const ms = store.listMilestones({ includeSettled: true });
    const titles = new Map(ms.map((m) => [m.id, m.title]));
    return c.json((await review.goals()).map((g) => (g.milestoneId && titles.has(g.milestoneId) ? { ...g, milestoneTitle: titles.get(g.milestoneId) } : g)));
  });
  // Q3: goals the owner closed (what each hides) and Reopen
  api.get("/review-goals/closed", async (c) => c.json(await review.closedGoals()));
  api.post("/review-goals/reopen", async (c) => {
    const b = (await c.req.json().catch(() => undefined)) as { key?: unknown } | undefined;
    if (typeof b?.key !== "string" || !b.key) return c.json({ error: { code: "validation_error", message: "send key: the goal's key" } }, 400);
    const r = await review.reopen(b.key);
    if ("error" in r) return c.json({ error: { code: r.code, message: r.message } }, r.error);
    return c.json(r);
  });
  // Complete (Mark step complete / Mark <line> met / Close goal / Mark ask complete): `start` and `park` are the
  // suggestion indices, together every suggestion (none dropped); no body = park all.
  api.post("/review-items/:id/complete", async (c) => {
    const p = completeIn.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!p.success) return c.json({ error: { code: "validation_error", message: `send start and park (arrays of next-step indices), or for a held post slot, feedback or now: ${p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` } }, 400);
    const r = await review.complete(c.req.param("id"), p.data);
    if ("error" in r) return c.json(fail(r), r.error);
    return c.json(r.item);
  });
  api.post("/review-items/:id/approve", async (c) => {
    const r = await review.approve(c.req.param("id"));
    if ("error" in r) return c.json(fail(r), r.error);
    return c.json(r.item);
  });
  // Deny, the third outcome (Approve, Feedback = relaunch, Deny): closes the row as denied; `reason` optional.
  api.post("/review-items/:id/deny", async (c) => {
    const p = denyIn.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!p.success) return c.json({ error: { code: "validation_error", message: `send reason (optional, at most ${RELAUNCH_MAX} characters)` } }, 400);
    let reason: string;
    try {
      reason = withFiles(p.data.reason, p.data.attachments);
    } catch (e) {
      const f = filesFailed(e);
      if (!f) throw e;
      return c.json({ error: f.error }, f.status);
    }
    const r = await review.deny(c.req.param("id"), reason);
    if ("error" in r) return c.json(fail(r), r.error);
    return c.json(r.item);
  });
  api.post("/review-items/:id/relaunch", async (c) => {
    const p = relaunchIn.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: { code: "validation_error", message: `feedback is required, or a file in attachments (at most ${RELAUNCH_MAX} characters)` } }, 400);
    let feedback: string;
    try {
      feedback = withFiles(p.data.feedback, p.data.attachments);
    } catch (e) {
      const f = filesFailed(e);
      if (!f) throw e;
      return c.json({ error: f.error }, f.status);
    }
    const r = await review.relaunch(c.req.param("id"), feedback);
    if ("error" in r) return c.json(fail(r), r.error);
    return c.json(r.item);
  });
}
