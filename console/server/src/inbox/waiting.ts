import { askGateProblem, type HeldAsk } from "./askGate.js";
import { createDryRunReader, dryRunNote, dryRunOverdue, dryRunProblem } from "./askDryRun.js";
import { sameOpenProblem, sameQuestion } from "./duplicate.js";
import { createAskLogReader, repeatProblem, sizeProblem, topicsIn, type PriorAnswer } from "./askRepeat.js";
import { execFile } from "../spawnHost.js";
import { activeMark, noteMarksOf, type NoteMark } from "../review/noteMarks.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inside, readDoc } from "../adapters/doc.js";
import { proseLines, stripInline } from "../adapters/markdown.js";
import { listRepos, resolveRepo } from "../adapters/repos.js";
import { headOf } from "../adapters/gitHead.js";
import { firstStatusWord, holdState, isClosed, namesJordi, statusWordOf, type AnsweredAsk, type Tree, type TreeNode } from "../adapters/tree.js";
import type { Milestone, Store } from "../store.js";
import { isTeamMilestone, TEAM_LABEL } from "../team/teamState.js";
import type { Asker } from "./asker.js";
import { scanTree, refKey, unblockRefs, waitingOnLineRefs, waitingOnTextLine, type AskReference, type RowAt } from "./refs.js";
import { citesRows, jordiLine, laterStep, openForJordi, rowHasAsk, rowLabel, rowTitle, waitsElsewhere } from "./freeText.js";
import { DEFAULT_OWNER, ownerPatterns, type OwnerInfo } from "../tenancy/owner.js";
import { decideChoices } from "./decideChoices.js";
import { advisories, snoozedNow, citedAskCodes, isJordis, missingFields, rowMatches, stripJordi, type AskKind, type LocatedAsk, type SecretTarget } from "./asks.js";

/** an epic Status that is past the owner's ready stamp: its first word, EpicSpine vocabulary. */
const STAMPED = new Set(["ready", "active", "blocked", "deferred", "review", "done", "superseded"]);

/** one thing blocked on the owner, from a Needs the owner row or a spine (red node, `Waiting on:` line, `[ask: …]`). */
export interface WaitingItem {
  /** Stable: the Needs the owner id, a coded ask `wj_` + hash(repo, code) (E948-S182), else `wj_` + hash(repo, file, kind, node/question). */
  id: string;
  /** coded asks: the path id it had before E948-S182, so answers stored under it still find their card. */
  legacyId?: string;
  /** open asks: a long voice note of the owner's touched it (updated, or stale) and its owner has not rewritten it yet. */
  noteMark?: NoteMark;
  /** ask = skill human-ask line (`## Waiting on`); heuristic = red node / free-text `Waiting on:` / Needs column. */
  source: "needs_jordi" | "ask" | "heuristic";
  /** Heuristic items: which signal found it. */
  /** owner_row: a ledger row assigned to the owner, open, with no coded ask (a `free_text_ask` pending item). */
  /** stamp_ready: a Planning epic whose `Waiting on:` asks the owner to stamp it ready: one Mark ready item. */
  signal?: "red_node" | "waiting_on" | "needs_column" | "owner_row" | "stamp_ready";
  /** heuristic items: ask codes the spine line cites (`the code repo/` → that repo; bare → this repo). All of them asks somewhere: the item is a reference to those asks, never a card. */
  cites?: { repo: string; code: string }[];
  /** Heuristic items: "not in the human-ask format, ask the owner to restate". */
  hint?: string;
  /** owner_row: an open coded ask for this row written outside `## Waiting on` (no parser reads it): its code. */
  askOutside?: string;
  /**
   * heuristic rows only: "future" = a gate the owner cannot act on yet (see `futureGate`); the UI lists these under
   * "Coming up", the rest collapse into one "guessed" card per spine file. Never counted as waiting.
   */
  gate?: "future";
  /** Why the row is a future gate: "pending" or "after T6, T7 (not done)". */
  gateReason?: string;
  /** Heuristic items: the spine file the signal is written in (the guessed card groups by it) and its title. */
  spine?: { path: string; title: string };
  /** Checkout name of the repo (qualifies ask codes across repos: `poly-maker/`). */
  repo?: string;
  /** Asks (contract v2): `<epic code>-A<n>`, absent on v1 lines. */
  code?: string;
  /** Asks: `do` steps (commands or a runbook, host, user) and the runbook link when one is given. */
  steps?: string;
  stepsLink?: { label: string; url: string };
  /** Asks: rows that proceed once answered and the cost of waiting. */
  unblocks?: string;
  effort?: string;
  /** Asks: contract advisories (no code, duplicate code, > 3 open, stale), shown as chips; never block. */
  advisory?: string[];
  /**
   * Asks: open in the spine, or rewritten to `[answered …]` (answered, pending work: shown until the owner deletes
   * the line). `done`: the owner answered from the console, the line was written and the owner has since deleted it.
   */
  state: "open" | "answered" | "done" | "superseded";
  /** the line is `[feedback …]`: the owner asked for changes (never an approval); the work is reopened. */
  feedback?: boolean;
  /**
   * the ask was answered by a persona (`[answered … @<persona>]`), not the owner: an FYI "decided by <persona>" card
   * with Reverse. State stays `answered`, so it is never counted as waiting.
   */
  decidedBy?: string;
  /** FYI cards: the confidence rubric the persona's verdict was judged by ("score 82/75 · reversal 4 · …"). */
  rubric?: string;
  /** asks whose `[answered …]` line carries `· done <date>`: the date ("" when the marker has none). */
  doneAt?: string;
  /**
   * answered persona requests: the work it asked for has run since the answer (a run of the milestone that
   * started after the answer, or the asking run itself, has ended): consumed, listed under Answered, never pending.
   */
  consumedAt?: string;
  /** other milestones whose spines wait on this ask (`waits on <repo>/<code>`, or this ask's `unblocks:` names their rows). */
  referencedBy?: AskReference[];
  /** Needs the owner rows with state superseded: `<repo>/<code>` of the coded ask that replaced it, or `moot`. Only listed with includeSuperseded. */
  supersededBy?: string;
  /** an improvement request (`label: improvement request`): which world builds it, for which campaign, done means. */
  improvement?: { to: string; campaign?: string; doneMeans?: string };
  /** on the stored answer: where the console handed it (`<repo>:<note path>`), or why it could not. */
  improvementHanded?: string;
  improvementError?: string;
  /** a priority ask (`label: priority`): the objective his Yes puts first; pinned above everything in his inbox. */
  putFirst?: { objective: string };
  /** E948-S155: `label: urgent` on the ask: pinned first in his inbox, never held for its dry run. */
  urgent?: true;
  /** on the stored answer: the pursuits.json commit his Yes made (or why it could not). */
  priorityMoved?: string;
  priorityError?: string;
  /** Asks: the answer written back in the spine. */
  answer?: string;
  who?: string;
  /** Asks: ledger row the ask blocks (contract `row`). */
  row?: string;
  /** Asks with a `row`: compact link to that ledger row in the spine ("row T4"); the card shows it instead of the row title. */
  rowLink?: { label: string; url: string };
  /** Asks: required contract fields that are missing (advisory, like the skill's checks). */
  missing?: string[];
  milestoneId: string;
  milestoneTitle: string;
  /** other milestones whose trees hold the same spine line (a shared spine): the item counts for them too. */
  alsoIn?: string[];
  /** Tree node key the item hangs under (subtree scoping); the tree root for Needs the owner rows. */
  nodeKey?: string;
  /** Repo-relative file the item was read from (absent for Needs the owner rows). */
  path?: string;
  /** Asks: 0-based line of the ask in `path` when read. */
  line?: number;
  title: string;
  ask: AskKind;
  question: string;
  /** E948-S172: the card's topic in plain words, shown first as `About: …` (the ask's `about:`, else derived: inbox/about.ts). */
  about?: string;
  /** the ask's `browser:` prompt for Claude in Chrome; his card shows it with a Copy button. */
  browserPrompt?: string;
  /** the about was written on the ask line (not derived). */
  aboutGiven?: true;
  /** Raw status / gate / proposed-action text behind the item. */
  detail?: string;
  proposedAction?: string;
  options?: string[];
  /** E948-S69: the options were built from the question (the ask listed none): a yes or no, or its either-or. */
  optionsDerived?: true;
  recommendation?: string;
  /** plain-words sections of an ask; the card shows them labelled, technical fields under Details. */
  contextText?: string;
  impact?: string;
  risk?: string;
  /** `why the owner:`: why an agent cannot decide it. */
  whyYou?: string;
  /** E996-S58: what a fresh reader still found unclear after 3 rounds (the ask reaches the owner with it beside). */
  readerNote?: string;
  /**
   * E948-S154: the dry-run gate held this card more than 2 hours, so it reaches the owner anyway, marked by `readerNote`:
   * `not-checked` (no fresh reader has read it) or `unclear` (a fresh reader failed it). Absent on every card that passed.
   */
  heldPast2h?: "not-checked" | "unclear";
  /** `secret: <app> <NAME>` on a provide ask: the card shows a password box; the server stores it with `secret put`. */
  secret?: SecretTarget;
  /** environmentId = the T3 environment of threadId when known (link t3code://threads/<env>/<thread>). */
  contextLinks: { label: string; url: string; threadId?: string; environmentId?: string }[];
  owner: Owner;
  /** ISO time: Needs the owner createdAt, else when the line last changed (git blame), else a `since:` value. */
  since?: string;
  /** Needs the owner rows can be approved / denied in place. */
  decidable: boolean;
  needsJordiId?: string;
  /** Needs the owner rows raised by a run that ended blocked: that run, and the persona it blocks. */
  blocksRunId?: string;
  blocksPersona?: string;
  /** the persona who asked (its answer wakes or steers it); stored on the response's item snapshot too. */
  asker?: Asker;
  /** approved with Accept (one, or Accept all on a persona's set): the answer job adds a ready row for it. */
  asReadyRow?: boolean;
  /** the ready row his accept made (its code), or why it was not written. */
  readyRow?: string;
  readyRowError?: string;
  /** the display name of the world's owner when it is not the owner (absent for the home world). */
  ownerName?: string;
  /**
   * an open ask the owner snoozed (`— snoozed until: <date>` on its line), the date still ahead: it stays open but is
   * not pending (no count, no card in the list); the inbox shows it under "Snoozed" with Unsnooze.
   */
  snoozedUntil?: string;
  /**
   * an open ask labelled `needs Mac agent` (`— label: needs Mac agent` on its line): Claude on the owner's Mac does
   * it from its ticket. Not pending (no count, no card in the list); the inbox folds it under "Needs Mac agent", which
   * links the Mac list where he runs them in one sitting.
   */
  macAgent?: true;
}

/** ask codes a spine line cites, with their repo (`the code repo/`; a bare code is `self`'s). */
export function citesOf(text: string | undefined, self: string): { repo: string; code: string }[] {
  if (!text) return [];
  return [...stripInline(text).matchAll(/(?:^|[^\w-])(?:([\w.-]+)\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[Aa]\d+)(?![\w-])/g)].map((m) => ({ repo: m[1] ?? self, code: m[2].toUpperCase() }));
}

/** one line of at most `max` chars, cut at a word boundary. */
export function shorten(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

/** inbox order: what blocks a persona run now, then structured asks (and other Needs the owner rows), then guesses. */
export const itemRank = (it: Pick<WaitingItem, "source" | "blocksRunId">) =>
  it.blocksRunId ? 0 : it.source === "heuristic" ? 2 : 1;

export interface Owner {
  /** thread = no persona attached; the epic's Current State `Owner:` names a T3 thread (human-asks.md §Answering it). */
  kind: "assignment" | "delivery-manager" | "thread" | "none";
  assignmentId?: string;
  personaId?: string;
  personaName?: string;
  threadId?: string;
  /** T3 environment of threadId, when the console knows it. */
  environmentId?: string;
  label: string;
}

export interface WaitingDeps {
  store: Store;
  reposRoot: string;
  treeFor: (m: Milestone) => Promise<Tree>;
  /** Home thread of an assignment (cycle link), if it has one. */
  homeThread?: (assignmentId: string) => string | undefined;
  /** T3 environment id of a thread the console knows (its runs, or a home thread's host). */
  threadEnvironment?: (threadId: string) => string | undefined;
  /** Blame times per line of a repo file; injectable for tests. */
  /** also list superseded Needs the owner rows (state `superseded`); default hides them. */
  includeSuperseded?: boolean;
  blame?: (repoDir: string, rel: string) => Promise<(string | undefined)[] | undefined>;
  /** commit time (ISO) of the first commit that added `needle` to a repo file; injectable for tests. */
  firstAdded?: (repoDir: string, rel: string, needle: string) => Promise<string | undefined>;
  /** checkout name of the owner's team repo (CONSOLE_TEAM_REPO; default `team`): its root spine's asks are labelled "Team". */
  teamRepo?: string;
}

const hash = (...parts: string[]) => "wj_" + createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
/** the id an ask had before E948-S182 (repo, spine path, row, question): a moved or reworded line got a new one. */
export const askLegacyId = (repo: string, rel: string, row: string | null | undefined, question: string) => hash(repo, rel, "ask", row ?? "", question);
/**
 * the id of a human ask's waiting item, as the inbox gives it. E948-S182 (the owner 22 Nov 23:5xZ: E906-A16 showed twice in
 * Urgent after its line moved from EPIC-906 to EPIC-9105): a coded ask is one card per repo and code, wherever its line
 * sits, so a moved or reworded line keeps its card. An ask with no code keeps the path id.
 */
export const askItemId = (repo: string, rel: string, row: string | null | undefined, question: string, code?: string | null) =>
  code ? hash(repo, "ask-code", code.toUpperCase()) : askLegacyId(repo, rel, row, question);
/** a spine file holds a line for this ask code (`[ask CODE`, `[answered CODE`, `[feedback CODE` …), read fresh from disk. */
export const ASK_LINE_OF = (code: string) => new RegExp(`\\[[a-z]+\\s+${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
export function askLineIn(repoDir: string, rel: string, code: string): boolean {
  const abs = inside(repoDir, rel);
  if (!abs) return false;
  try {
    return ASK_LINE_OF(code).test(fs.readFileSync(abs, "utf8"));
  } catch {
    return false;
  }
}
/**
 * E948-S182: two records of one coded ask (one repo, one code) at different paths: the one whose file no longer holds the
 * line is the old record (a tree read before the move) and closes; both live is a real duplicate in the spines and both
 * stay (the inbox census names it). `live` reads the file. Returns which to keep: "a", "b" or "both".
 */
export function samePairKeep(a: Pick<WaitingItem, "path">, b: Pick<WaitingItem, "path">, live: (path: string) => boolean): "a" | "b" | "both" {
  if (!a.path || !b.path || a.path === b.path) return "both";
  const la = live(a.path), lb = live(b.path);
  if (la && !lb) return "a";
  if (lb && !la) return "b";
  return la ? "both" : "a";
}
export const isDm = (name?: string) => !!name && /delivery[\s-]*manager/i.test(name);
const NONE = /^(none|nothing|nobody|no one|n\/a|-|—)(?![\w-])/i;
/** `Waiting on: nobody (the owner: none open). Workers: …`: the line says outright the owner is not waited on (`ownerPatterns.none`). */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * future gate (human-asks v2: "a human named on a later step is a plan, not an ask"). A guessed row is a
 * future gate, listed under "Coming up" instead of the guessed card, when:
 *  1. its Status has not started: the status word is draft (pending / planned / proposed / draft / not started), or
 *  2. its Needs or Status cell names a sibling row of the same ledger that is not done yet (e.g. "the owner go; T6 + T7
 *     green"). Only ids with a letter and a digit (T6, XL-3, S2) are matched, so bare numbers in prose never count.
 * Everything else that names the owner (blocked/waiting on him, or ready/active with him in Needs) stays guessed.
 */
export function futureGate(node: Pick<TreeNode, "id" | "status" | "needs">, siblings: Pick<TreeNode, "id" | "status" | "color" | "kind">[]): string | undefined {
  if (statusWordOf(node.status) === "draft") return stripInline(node.status).split(/\s+[—–-]\s+|[;(]/)[0].trim() || "not started";
  const text = `${node.needs ?? ""} ${node.status}`;
  const open = siblings.filter(
    (x) =>
      x.id !== node.id &&
      /[a-z]/i.test(x.id) &&
      /\d/.test(x.id) &&
      x.color !== "green" &&
      !isClosed(x) &&
      new RegExp(`(?<![\\w.-])${esc(x.id)}(?![\\w-]|\\.\\d)`, "i").test(stripInline(text)),
  );
  return open.length ? `after ${[...new Set(open.map((x) => x.id))].join(", ")} (not done)` : undefined;
}

export type { AskReference } from "./refs.js";

export const githubUrl = (remote: string | undefined, rel: string, line?: number) =>
  remote ? `https://github.com/${remote}/blob/HEAD/${rel.split("/").map(encodeURIComponent).join("/")}${line !== undefined ? `?plain=1#L${line + 1}` : ""}` : undefined;
/**
 * link to a T3 thread. With its environment: the T3 desktop deep link `t3code://threads/<env>/<thread>`, both
 * segments URL-encoded (T3 copies the path into its `/$environmentId/$threadId` route, whose param decodes once: a
 * `thread:delegated-task:command%3A…` id opens only as `…%253A…`; checked in T3's web client 2026-10-24). Without:
 * `t3-thread://v1/<id>` (id as T3 returned it), which only T3's own chat understands.
 */
export const threadUrl = (threadId: string, environmentId?: string) =>
  environmentId ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}` : `t3-thread://v1/${threadId}`;

/** an item with the environment of its owner thread and run-thread links filled in (when known). */
export function withThreadEnvironments<T extends Pick<WaitingItem, "owner" | "contextLinks">>(it: T, env?: (threadId: string) => string | undefined): T {
  if (!env) return it;
  const ownerEnv = it.owner?.threadId ? env(it.owner.threadId) : undefined;
  return {
    ...it,
    ...(ownerEnv ? { owner: { ...it.owner, environmentId: ownerEnv } } : {}),
    contextLinks: (it.contextLinks ?? []).map((l) => {
      const e = l.threadId ? env(l.threadId) : undefined;
      return e ? { ...l, environmentId: e, url: threadUrl(l.threadId!, e) } : l;
    }),
  };
}

/**
 * Who answers for a milestone: an assignment of a persona other than the Delivery Manager, else the Delivery
 * Manager assignment, else the thread named in the spine's Current State `Owner:` (`ownerText`), else nobody. Among several: enabled first, then one with a home thread, then latest run.
 */
export const NO_OWNER: Owner = { kind: "none", label: "no one to deliver to, attach a persona or name an owner thread" };

/** `thread mcp:…` (or another T3 thread id) in a T3 thread id shape: letters/digits plus `:` `_` `-`, with a digit. */
const OWNER_THREAD = /\bthread[\s:]+`?((?:mcp:)?[A-Za-z0-9][A-Za-z0-9_:-]{5,})`?/i;

/**
 * Owner thread from a Current State `Owner:` value, e.g. ` delivery manager (thread mcp:61d2…)` →
 * { kind: "thread", threadId: "mcp:61d2…", label: " delivery manager" }; undefined when it names no thread.
 */
export function threadOwner(ownerText?: string): Owner | undefined {
  const text = stripInline(ownerText ?? "");
  const m = OWNER_THREAD.exec(text);
  if (!m || !/\d/.test(m[1])) return undefined;
  const label = text
    .replace(/\(\s*thread[^)]*\)/i, "")
    .replace(m[0], "")
    .replace(/[\s,;:·—-]+$/, "")
    .trim();
  return { kind: "thread", threadId: m[1], label: label || "owner" };
}

export function ownerFor(
  store: Store,
  milestoneId: string,
  homeThread?: (id: string) => string | undefined,
  preferAssignmentId?: string,
  ownerText?: string,
): Owner {
  const personas = new Map(store.listPersonas().map((p) => [p.id, p]));
  const all = store.listAssignments({ milestoneId });
  const preferred = preferAssignmentId ? all.find((a) => a.id === preferAssignmentId) : undefined;
  const rank = (list: typeof all) =>
    [...list].sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        Number(!!homeThread?.(b.id)) - Number(!!homeThread?.(a.id)) ||
        (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""),
    )[0];
  const pick = preferred ?? rank(all.filter((a) => !isDm(personas.get(a.personaId)?.name))) ?? rank(all);
  if (!pick) return threadOwner(ownerText) ?? { ...NO_OWNER };
  const p = personas.get(pick.personaId);
  const threadId = homeThread?.(pick.id);
  return {
    kind: isDm(p?.name) ? "delivery-manager" : "assignment",
    assignmentId: pick.id,
    personaId: pick.personaId,
    personaName: p?.name,
    ...(threadId ? { threadId } : {}),
    label: p?.name ?? pick.id,
  };
}

// ---------- git blame (since) ----------

/**
 * where blame and first-added answers outlive the process. The indexer keeps them in
 * console.db (indexer_kv), so after a restart the waiting views ask git only about files that moved, not every spine
 * with an ask (a burst of git children on the main server after each deploy). Unset elsewhere: memory only, as before.
 */
export interface GitMemo {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
}
let gitMemo: GitMemo | undefined;
export function useGitMemo(m: GitMemo | undefined) {
  gitMemo = m;
}
const memoGet = (k: string): unknown => {
  try {
    return gitMemo?.get(k);
  } catch {
    return undefined;
  }
};
const memoSet = (k: string, v: unknown) => {
  try {
    gitMemo?.set(k, v);
  } catch {
    /* memory only */
  }
};

const firstMemoKey = (key: string) => `first:${createHash("sha1").update(key).digest("hex")}`;

const blameCache = new Map<string, { key: string; times: Promise<(string | undefined)[] | undefined>; failedAt?: number }>();

/**
 * blob sha of `rel` at HEAD, per (HEAD, file). The files asked for in one turn of the loop are read with one
 * `git ls-tree` per (checkout, HEAD), not one `git rev-parse` each: every HEAD move asked again for every spine with an
 * ask, a git start per spine on the console's thread.
 */
const blobMemo = new Map<string, Promise<string | undefined>>();
const blobBatch = new Map<string, { repoDir: string; head: string; rels: Map<string, (v: string) => void> }>();
function blobAtHead(repoDir: string, rel: string, head: string): Promise<string | undefined> {
  const k = `${repoDir}\0${head}\0${rel}`;
  let p = blobMemo.get(k);
  if (!p) {
    if (blobMemo.size > 4000) blobMemo.clear();
    p = new Promise<string>((resolve) => {
      const bk = `${repoDir}\0${head}`;
      let b = blobBatch.get(bk);
      if (!b) {
        const batch = (b = { repoDir, head, rels: new Map<string, (v: string) => void>() });
        blobBatch.set(bk, batch);
        setImmediate(() => {
          blobBatch.delete(bk);
          const rels = [...batch.rels.keys()];
          execFile("git", ["-C", repoDir, "ls-tree", "-z", "--full-tree", head, "--", ...rels], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
            const found = new Map<string, string>();
            if (!err)
              for (const rec of String(out).split("\0")) {
                const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(rec);
                if (m) found.set(m[2], m[1]);
              }
            for (const [r, done] of batch.rels) done(found.get(r) ?? "none");
          });
        });
      }
      b.rels.set(rel, resolve);
    });
    blobMemo.set(k, p);
  }
  return p;
}

/**
 * what a file's blame and history answers depend on: its mtime + size (uncommitted edits) and its blob at HEAD
 * (the commits that touched it). A commit to another file no longer counts: the code repo takes one every 1-5 min on the main server
 * and each made every spine with an ask blame again (was keyed by HEAD). HEAD unreadable: a one-minute expiry.
 */
async function fileVersion(repoDir: string, abs: string, rel: string): Promise<string | undefined> {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return undefined;
  }
  const head = headOf(repoDir);
  return `${st.mtimeMs}:${st.size}:${head ? await blobAtHead(repoDir, rel, head) : Math.floor(Date.now() / 60_000)}`;
}

/**
 * Committer time per line (ISO), cached by fileVersion (was mtime + size + HEAD); undefined on any git
 * failure, cached for a minute too, so a file git cannot blame (untracked) is not re-spawned on every request.
 * Concurrent calls for one file share one spawn.
 */
export async function gitBlame(repoDir: string, rel: string): Promise<(string | undefined)[] | undefined> {
  const abs = inside(repoDir, rel);
  if (!abs) return undefined;
  const key = await fileVersion(repoDir, abs, rel);
  if (key === undefined) return undefined;
  const hit = blameCache.get(abs);
  if (hit && hit.key === key && !(hit.failedAt && Date.now() - hit.failedAt > 60_000)) return hit.times;
  if (!hit) {
    const kept = memoGet(`blame:${abs}`) as { key?: string; times?: (string | null)[] } | undefined;
    if (kept?.key === key && Array.isArray(kept.times)) {
      const times = Promise.resolve(kept.times.map((t) => t ?? undefined));
      blameCache.set(abs, { key, times });
      return times;
    }
  }
  const times = new Promise<(string | undefined)[] | undefined>((resolve) => {
    execFile("git", ["-C", repoDir, "blame", "--line-porcelain", "--", rel], { timeout: 5_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const e = blameCache.get(abs);
        if (e?.times === times) e.failedAt = Date.now();
        return resolve(undefined);
      }
      const out: (string | undefined)[] = [];
      let t: string | undefined;
      let uncommitted = false;
      for (const line of stdout.split("\n")) {
        if (/^[0-9a-f]{40} /.test(line)) uncommitted = line.startsWith("0000000000000000000000000000000000000000");
        else if (line.startsWith("committer-time ")) t = new Date(Number(line.slice(15)) * 1000).toISOString();
        else if (line.startsWith("\t")) out.push(uncommitted ? undefined : t);
      }
      if (blameCache.get(abs)?.times === times) memoSet(`blame:${abs}`, { key, times: out });
      resolve(out);
    });
  });
  blameCache.set(abs, { key, times });
  return times;
}

const firstAddedCache = new Map<string, { at: Promise<string | undefined>; failedAt?: number; ver?: string }>();

/**
 * committer time (ISO) of the oldest commit that added `needle` to `rel` (`git log -S`: a snooze or an edit
 * of the line does not move it). Found once per repo + file + needle and kept (history below it never changes);
 * a miss or a git failure is retried after a minute,: only once the file's version moved (the needle can only
 * show up in a commit that touched the file; before, each miss walked the whole history every minute).
 */
export async function gitFirstAdded(repoDir: string, rel: string, needle: string): Promise<string | undefined> {
  const abs = inside(repoDir, rel);
  if (!abs) return undefined;
  const key = `${repoDir}\0${rel}\0${needle}`;
  const hit = firstAddedCache.get(key);
  if (hit && !hit.failedAt) return hit.at;
  if (!hit) {
    const kept = memoGet(firstMemoKey(key));
    if (typeof kept === "string") {
      const at = Promise.resolve<string | undefined>(kept);
      firstAddedCache.set(key, { at });
      return at;
    }
  }
  const ver = hit?.failedAt ? await fileVersion(repoDir, abs, rel) : undefined;
  if (hit && hit.failedAt && (Date.now() - hit.failedAt <= 60_000 || (ver !== undefined && ver === hit.ver))) return hit.at;
  const at = new Promise<string | undefined>((resolve) => {
    execFile("git", ["-C", repoDir, "log", "--reverse", "--format=%ct", "-S", needle, "--", rel], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const t = err ? NaN : Number(stdout.split("\n")[0]);
      if (!t) {
        const e = firstAddedCache.get(key);
        if (e?.at === at) {
          e.failedAt = Date.now();
          void fileVersion(repoDir, abs, rel).then((v) => (e.ver = v));
        }
        return resolve(undefined);
      }
      const iso = new Date(t * 1000).toISOString();
      memoSet(firstMemoKey(key), iso);
      resolve(iso);
    });
  });
  firstAddedCache.set(key, { at });
  return at;
}

/**
 * when an ask was issued, to the minute where git knows it. A line's `since <date>` is the authority: a git
 * time is used only when it falls on that day (±14 h for the writer's time zone), so an ask moved or re-written later
 * keeps its day ("3 days ago"). With no `since`, the git time as before.
 */
export function issuedAt(sinceDay: string | null | undefined, ...times: (string | undefined)[]): string | undefined {
  if (!sinceDay || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDay)) return sinceDay ?? times.find(Boolean);
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const slack = 14 * 3_600_000;
  return times.find((t) => t && Date.parse(t) >= start - slack && Date.parse(t) < start + 86_400_000 + slack) ?? sinceDay;
}

// ---------- line lookup ----------

function fileLines(repoDir: string, rel: string): string[] | undefined {
  const abs = inside(repoDir, rel);
  if (!abs) return undefined;
  try {
    return proseLines(fs.readFileSync(abs, "utf8"));
  } catch {
    return undefined;
  }
}

/** Line of the `nth` (0-based) table row whose first cell is `id`. */
function rowLine(lines: string[], id: string, nth = 0): number | undefined {
  const want = stripInline(id).toLowerCase();
  let seen = 0;
  const i = lines.findIndex((l) => {
    if (!l.trim().startsWith("|")) return false;
    const first = l.trim().replace(/^\|/, "").split(/(?<!\\)\|/)[0] ?? "";
    return stripInline(first).toLowerCase() === want && seen++ === nth;
  });
  return i >= 0 ? i : undefined;
}

/** Ledger row of a tree node: by id when ids are unique, else (e.g. every Issue cell is "draft") by its title text. */
function rowLineOf(lines: string[], node: Pick<TreeNode, "id" | "title">): number | undefined {
  const title = stripInline(node.title).trim();
  const byTitle = title ? lines.findIndex((l) => l.trim().startsWith("|") && stripInline(l).includes(title)) : -1;
  return byTitle >= 0 ? byTitle : rowLine(lines, node.id);
}

// ---------- aggregation ----------

interface Visit {
  node: TreeNode;
  /** File the node's row is written in (the parent's path). */
  rowFile?: string;
}

function walk(root: TreeNode): Visit[] {
  const out: Visit[] = [];
  const go = (n: TreeNode, parentPath?: string) => {
    if (n.flags.includes("cycle") || n.flags.includes("repeat")) return;
    out.push({ node: n, rowFile: parentPath });
    for (const c of n.children) go(c, n.path ?? parentPath);
  };
  go(root);
  return out;
}

/** spine items of a built tree per (milestone, owner, HEAD); dropped with the tree object. */
// E948-S154: `expiresAt`: the first moment a dry-run hold in it turns 2 hours old (it then reaches the owner, marked).
const spineItemsMemo = new WeakMap<Tree, Map<string, { blame: NonNullable<WaitingDeps["blame"]>; firstAdded: NonNullable<WaitingDeps["firstAdded"]>; items: WaitingItem[]; settled: SettledAsk[]; held: HeldAsk[]; expiresAt?: number }>>();

/** Items for one milestone (spine items + its open Needs the owner rows). */
export async function waitingForMilestone(d: WaitingDeps, m: Milestone): Promise<WaitingItem[]> {
  return (await waitingAndHeld(d, m)).items;
}

/** E948-S154: a date-only `since` read as the end of that day (UTC), so a hold is never timed from before its words. */
const endOfDay = (since: string | null | undefined) => (since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T23:59:59Z` : undefined);

/** E996-S43: the dry-run verdicts of the home repo per repos root (inbox/askDryRun.ts), read again when they change. */
const dryRunReaders = new Map<string, ReturnType<typeof createDryRunReader>>();
function dryRunReader(reposRoot: string) {
  if (!dryRunReaders.has(reposRoot)) dryRunReaders.set(reposRoot, createDryRunReader({ reposRoot }));
  return dryRunReaders.get(reposRoot)!;
}
const dryRunsOf = (reposRoot: string) => dryRunReader(reposRoot)();
/** E996-S48: the home repo's asks log folded to the asks the owner answered (inbox/askRepeat.ts), read again when it changes. */
const askLogReaders = new Map<string, ReturnType<typeof createAskLogReader>>();
function askLogReader(reposRoot: string) {
  if (!askLogReaders.has(reposRoot)) askLogReaders.set(reposRoot, createAskLogReader({ reposRoot }));
  return askLogReaders.get(reposRoot)!;
}

/** the milestone's items for the owner, and the open asks the ask gate held back from him (inbox/askGate.ts). */
export async function waitingAndHeld(d: WaitingDeps, m: Milestone): Promise<{ items: WaitingItem[]; held: HeldAsk[] }> {
  const out: WaitingItem[] = [];
  const held: HeldAsk[] = [];
  const owner = ownerFor(d.store, m.id, d.homeThread);
  const repo = m.path ? resolveRepo(d.reposRoot, m.repo) : undefined;
  // No persona attached: the owner thread named in the item's spine (Current State `Owner:`), else the milestone spine's.
  let owners: Record<string, string> = {};
  const ownerAt = (rel?: string): Owner => {
    if (owner.kind !== "none") return owner;
    const rootAbs = repo && m.path ? inside(repo.path, m.path) : undefined;
    return threadOwner(rel ? owners[rel] : undefined) ?? threadOwner(owners[m.path] ?? (rootAbs ? readDoc(rootAbs)?.owner : undefined)) ?? owner;
  };
  const blame = d.blame ?? gitBlame;
  const firstAdded = d.firstAdded ?? gitFirstAdded;
  // codes spines.py reports in a non-open state (answered / done / superseded), whoever answered, in any file of the tree.
  // with their question and settle date (done date, else answered date; "" unknown).
  const settledCodes: SettledAsk[] = [];
  let worldOwner: OwnerInfo | undefined;

  if (repo && m.path) {
    let tree: Tree | undefined;
    try {
      tree = await d.treeFor(m);
    } catch {
      tree = undefined;
    }
    // the spine items (steps 1-3) depend only on the tree (its files), the owner, the blame and HEAD: reused
    // while the memoized tree object is the same, so a 30 s poll does not rescan and re-blame every spine.
    const memoKey = tree ? JSON.stringify([m.id, m.title, m.path, owner, headOf(repo.path) ?? null, dryRunReader(d.reposRoot).stamp(), askLogReader(d.reposRoot).stamp()]) : "";
    const hit = tree ? spineItemsMemo.get(tree)?.get(memoKey) : undefined;
    if (tree && hit && hit.blame === blame && hit.firstAdded === firstAdded && !(hit.expiresAt !== undefined && Date.now() >= hit.expiresAt)) {
      worldOwner = tree.owner;
      owners = tree.owners ?? {};
      settledCodes.push(...hit.settled);
      held.push(...hit.held.map((h) => ({ ...h })));
      out.push(...hit.items.map((it) => ({ ...it })));
    } else if (tree) {
      worldOwner = tree.owner;
      const who = tree.owner?.handle ?? DEFAULT_OWNER;
      owners = tree.owners ?? {};
      for (const a of Object.values(tree.asks ?? {}).flat()) if (a.code && (a.state !== "open" || a.doneAt !== undefined)) settledCodes.push({ code: a.code, repo: repo.name, question: a.question, settledOn: a.doneAt || a.since || "" });
      const visits = walk(tree.root);
      const blames = new Map<string, Promise<(string | undefined)[] | undefined>>();
      const sinceAt = async (rel: string, line?: number) => {
        if (line === undefined) return undefined;
        if (!blames.has(rel)) blames.set(rel, blame(repo.path, rel));
        return (await blames.get(rel))?.[line];
      };
      let expiresAt: number | undefined;
      const linesCache = new Map<string, string[] | undefined>();
      const linesOf = (rel: string) => {
        if (!linesCache.has(rel)) linesCache.set(rel, fileLines(repo.path, rel));
        return linesCache.get(rel);
      };
      // each spine's voice-note marks (its `## Decisions` table), read once per file
      const marksCache = new Map<string, NoteMark[]>();
      const marksOf = (rel: string) => {
        if (!marksCache.has(rel)) marksCache.set(rel, noteMarksOf((linesOf(rel) ?? []).join("\n")));
        return marksCache.get(rel)!;
      };
      const link = (rel: string, line?: number, label?: string) => {
        const url = githubUrl(repo.remote, rel, line);
        return url ? [{ label: label ?? `${rel}${line !== undefined ? `:${line + 1}` : ""}`, url }] : [];
      };
      const contextLink = (a: LocatedAsk) => {
        if (!a.context) return [];
        if (/^[a-z][a-z0-9+.-]*:/i.test(a.context)) return [{ label: a.contextLabel ?? "context", url: a.context }];
        const [file, anchor] = a.context.split("#");
        const url = githubUrl(repo.remote, file);
        return url ? [{ label: a.contextLabel ?? a.context, url: anchor ? `${url}#${anchor}` : url }] : [];
      };

      // Files in the tree: first node per path.
      const nodeByPath = new Map<string, Visit>();
      for (const v of visits) if (v.node.path && v.node.kind !== "dod" && !nodeByPath.has(v.node.path)) nodeByPath.set(v.node.path, v);

      // 1. Human asks (skill contract): spines.py `waiting_on` or the `## Waiting on` lines, collected by buildTree.
      const askFiles = new Set<string>();
      const askRows = new Set<TreeNode>();
      // E996-S48: what the owner already answered (this tree's `[answered …]` lines, his own, and the asks log), for rule 9.
      const answered: PriorAnswer[] = [
        ...Object.entries(tree.asks ?? {}).flatMap(([rel, asks]) =>
          asks
            .filter((a) => a.state === "answered" && !a.feedback && !a.supersededBy && isJordis(a, who) && a.since)
            .map((a) => {
              // E907-S8: what it unblocked and its topics, so an FYI on the same row or topic is held (rule 9b).
              const topics = topicsIn(...[...(a.aboutAll ?? []), ...(a.about ? [a.about] : [])].map((t) => `about: ${t}`), a.question, a.why, a.recommend, a.contextText, a.impact, a.risk, a.unblocks);
              return { code: a.code, repo: repo.name, row: a.row, question: a.question, answer: a.answer, on: a.since!, at: `${repo.name}:${rel}:${a.line ?? ""}`, unblocks: a.unblocks, ...(topics.length ? { topics } : {}) };
            }),
        ),
        ...askLogReader(d.reposRoot)(),
      ];
      // E948-S139: every open ask of his in this tree, for one question, one card (a newer ask in nearly the same words waits).
      const openOfHis = Object.entries(tree.asks ?? {}).flatMap(([rel, asks]) =>
        asks.filter((x) => x.state === "open" && x.doneAt === undefined && isJordis(x, who)).map((x) => ({ a: x, rel })),
      );
      const olderSame = (a: (typeof openOfHis)[number]["a"], rel: string) =>
        openOfHis.find(
          (o) =>
            o.a !== a &&
            !!o.a.code &&
            ((o.a.since ?? "") < (a.since ?? "") || ((o.a.since ?? "") === (a.since ?? "") && `${o.rel}:${o.a.line ?? 0}` < `${rel}:${a.line ?? 0}`)) &&
            sameQuestion(o.a.question, a.question),
        )?.a;
      for (const [rel, asks] of Object.entries(tree.asks ?? {})) {
        const v = nodeByPath.get(rel);
        if (!v || isClosed(v.node)) continue;
        for (const a of asks) {
          // an answered line signed by a persona is an FYI (decided for the owner, reversible); other non-the owner asks stay hidden.
          // an answer still waiting on another person's approval is theirs to judge first (their inbox, the board).
          const fyi = !isJordis(a, who) && a.state === "answered" && a.doneAt === undefined && !a.awaits;
          if (!isJordis(a, who) && !fyi) continue;
          const adv = advisories(a, asks);
          if (a.state === "open") askFiles.add(rel);
          const row = a.row ? visits.find((x) => x.rowFile === rel && rowMatches(a.row, x.node)) : undefined;
          if (row && a.state === "open") askRows.add(row.node);
          // an ask that fails the gate never reaches the owner; the Delivery Manager's wake lists it.
          // E996-S43: and one a fresh agent could not do from the card alone (or a new one not yet dry-run) waits too.
          const gated = !fyi && a.state === "open" && a.doneAt === undefined;
          let gate = gated
            ? (askGateProblem(a) ??
              repeatProblem({ ...a, repo: repo.name, at: `${repo.name}:${rel}:${a.line ?? ""}` }, answered) ??
              (() => {
                const o = olderSame(a, rel);
                return o ? sameOpenProblem(o.code!, o.since) : undefined;
              })() ??
              sizeProblem(a))
            : undefined;
          // E948-S154: a dry-run hold lasts 2 hours at most: then the ask reaches him, its card marked by one line.
          let overdueNote: string | undefined;
          let overdueKind: "not-checked" | "unclear" | undefined;
          if (gated && !gate) {
            const raw = a.line !== undefined ? linesOf(rel)?.[a.line] : undefined;
            gate = dryRunProblem(raw, a.since, dryRunsOf(d.reposRoot));
            if (gate) {
              const o = dryRunOverdue(raw, a.since, dryRunsOf(d.reposRoot), (await sinceAt(rel, a.line)) ?? endOfDay(a.since), Date.now(), !!a.urgent);
              if (o.note) [overdueNote, overdueKind, gate] = [o.note, o.kind, undefined];
              else if (o.releaseAt !== undefined) expiresAt = Math.min(expiresAt ?? Infinity, o.releaseAt);
            }
          }
          if (gate) {
            const heldSince = await sinceAt(rel, a.line);
            held.push({ ...(a.code ? { code: a.code } : {}), repo: repo.name, path: rel, ...(a.line !== undefined ? { line: a.line } : {}), question: a.question, reason: gate, ...(heldSince ? { since: heldSince } : {}) });
            continue;
          }
          const missing = missingFields(a);
          const rowLinkAt = a.row ? link(rel, (row ? rowLineOf(linesOf(rel) ?? [], row.node) : rowLine(linesOf(rel) ?? [], a.row)), `row ${a.row}`)[0] : undefined;
          const stepsLink = a.stepsLink ? contextLink({ ...a, context: a.stepsLink, contextLabel: "runbook" })[0] : undefined;
          const choices = decideChoices(a);
          const readerNote = overdueNote ?? (!fyi && a.state === "open" && a.line !== undefined ? dryRunNote(linesOf(rel)?.[a.line], dryRunsOf(d.reposRoot)) : undefined);
          const noteMark = a.state === "open" && a.code ? activeMark(marksOf(rel), a.code, a.question) : undefined;
          // E948-S182: one card per repo and code. A second record of the code at another path keeps the live line's;
          // two live lines of one code (a real duplicate) or a code twice in one file keep their path ids.
          let id = askItemId(repo.name, rel, a.row, a.question, a.code);
          const legacyId = askLegacyId(repo.name, rel, a.row, a.question);
          const twin = a.code ? out.findIndex((x) => x.id === id) : -1;
          if (twin >= 0) {
            const keep = samePairKeep(out[twin]!, { path: rel }, (p) => askLineIn(repo.path, p, a.code!));
            if (keep === "a") continue;
            if (keep === "b") out.splice(twin, 1);
            else id = legacyId;
          }
          out.push({
            id,
            ...(id !== legacyId ? { legacyId } : {}),
            ...(noteMark ? { noteMark } : {}),
            source: "ask",
            state: a.doneAt !== undefined ? "done" : a.state,
            ...(a.doneAt !== undefined ? { doneAt: a.doneAt } : {}),
            ...(a.state === "open" && a.doneAt === undefined && snoozedNow(a.snoozedUntil) ? { snoozedUntil: a.snoozedUntil } : {}),
            // E996-S29: a key ask is answered by pasting into its card's box in the inbox, so it is never moved off the list to the
            // Mac list (T9-A10, labelled needs Mac agent, sat folded under Needs Mac agent and the owner never saw its box).
            ...(a.state === "open" && a.doneAt === undefined && a.macAgent && !a.secret ? { macAgent: true as const } : {}),
            ...(a.improvement ? { improvement: a.improvement } : {}),
            ...(a.putFirst ? { putFirst: a.putFirst } : {}),
            ...(a.urgent && a.state === "open" ? { urgent: true as const } : {}),
            repo: repo.name,
            ...(a.code ? { code: a.code } : {}),
            ...(a.steps ? { steps: a.steps } : {}),
            ...(stepsLink ? { stepsLink } : {}),
            ...(a.unblocks ? { unblocks: a.unblocks } : {}),
            ...(a.effort ? { effort: a.effort } : {}),
            ...(adv.length ? { advisory: adv } : {}),
            ...(fyi ? { decidedBy: a.who } : {}),
            ...(a.answer ? { answer: a.answer } : {}),
            ...(a.feedback ? { feedback: true } : {}),
            ...(a.who ? { who: a.who } : {}),
            ...(a.row ? { row: a.row } : {}),
            ...(rowLinkAt ? { rowLink: rowLinkAt } : {}),
            ...(missing.length ? { missing } : {}),
            milestoneId: m.id,
            milestoneTitle: m.title,
            nodeKey: (row ?? v).node.key,
            path: rel,
            ...(a.line !== undefined ? { line: a.line } : {}),
            title: row ? `${row.node.id === "draft" ? "" : `${row.node.id} `}${stripInline(row.node.title)}`.trim() : stripInline(v.node.title),
            ask: a.ask,
            question: a.question,
            ...(a.about ? { about: a.about, aboutGiven: true as const } : {}),
            ...(a.browser ? { browserPrompt: a.browser } : {}),
            // E948-S69: a Decide card always has its choices: the listed options, else buttons built from the question.
            ...(choices.options.length ? { options: choices.options } : {}),
            ...(choices.derived && choices.options.length ? { optionsDerived: true as const } : {}),
            ...(choices.recommend ?? a.recommend ? { recommendation: choices.recommend ?? a.recommend! } : {}),
            ...(a.contextText ? { contextText: a.contextText } : {}),
            ...(a.impact ? { impact: a.impact } : {}),
            ...(a.risk ? { risk: a.risk } : {}),
            ...(a.why ? { whyYou: a.why } : {}),
            ...(readerNote ? { readerNote } : {}),
            ...(overdueKind ? { heldPast2h: overdueKind } : {}),
            // a provide ask naming where the key goes gets a private paste box on its card.
            ...(a.secret ? { secret: a.secret } : {}),
            contextLinks: [...contextLink(a), ...link(rel, a.line, `${rel}${a.line !== undefined ? `:${a.line + 1}` : ""} · Waiting on`)],
            owner: ownerAt(rel),
            // an open ask's date-only `since` gets its hour from git (the commit that added the coded line,
            // else the line's last change) when that falls on the same day.
            since:
              a.state === "open" && a.since
                ? issuedAt(a.since, a.code ? await firstAdded(repo.path, rel, `[ask ${a.code}:`) : undefined, await sinceAt(rel, a.line))
                : (a.since ?? (await sinceAt(rel, a.line))),
            decidable: false,
          });
        }
      }

      const HINT = "not in the human-ask format, ask the owner to restate";
      const treeCodes = new Set(Object.values(tree.asks ?? {}).flat().flatMap((a) => (a.code ? [a.code.toUpperCase()] : [])));
      const siblingsOf = (v: Visit) => visits.filter((x) => x.rowFile === v.rowFile && x.node.kind !== "dod").map((x) => x.node);
      // 1b. Ledger rows assigned to the owner, open, with no coded ask: one free-text item per row (its spine line).
      // A `Waiting on:` line citing such rows is covered by them (step 2); step 3 never lists them again.
      const ownerRows = new Set<TreeNode>();
      const ownerLabels = new Map<string, string[]>();
      for (const v of visits) {
        const n = v.node;
        const rowFile = v.rowFile;
        if (!rowFile || !openForJordi(n, who) || rowHasAsk(n, tree.asks?.[rowFile] ?? [])) continue;
        ownerRows.add(n);
        const label = rowLabel(n);
        if (label) ownerLabels.set(rowFile, [...(ownerLabels.get(rowFile) ?? []), label]);
        const line = rowLineOf(linesOf(rowFile) ?? [], n);
        // A later step (depends on an open sibling row, or `the owner (later)`): Coming up, never counted.
        const later = laterStep(n, line !== undefined ? linesOf(rowFile)?.[line] : undefined, siblingsOf(v));
        const cites = citesOf(line !== undefined ? linesOf(rowFile)?.[line] : undefined, repo.name);
        const outside = label ? askOutsideFor(linesOf(rowFile) ?? [], label) : undefined;
        out.push({
          id: hash(repo.name, rowFile, "owner", label ?? n.key),
          ...(cites.length ? { cites } : {}),
          ...(outside ? { askOutside: outside } : {}),
          source: "heuristic",
          signal: "owner_row",
          hint: HINT,
          ...(later ? { gate: "future" as const, gateReason: later } : {}),
          spine: { path: rowFile, title: stripInline((nodeByPath.get(rowFile)?.node ?? n).title) },
          repo: repo.name,
          state: "open",
          milestoneId: m.id,
          milestoneTitle: m.title,
          nodeKey: n.key,
          path: rowFile,
          ...(line !== undefined ? { line } : {}),
          title: rowTitle(n),
          ask: "unknown",
          question: rowTitle(n),
          detail: `Owner: ${n.owner} · Status: ${n.status}`,
          contextLinks: link(rowFile, line, `${rowFile} · row ${label ?? n.id}`),
          owner: ownerAt(rowFile),
          since: await sinceAt(rowFile, line),
          decidable: false,
        });
      }

      // 2. Free-text `Waiting on:` naming the owner (non-green, open nodes; a file with open asks is covered by them).
      const waitingPaths = new Set<string>();
      for (const [rel, v] of nodeByPath) {
        if (v.node.color === "green" || isClosed(v.node)) continue;
        if (askFiles.has(rel)) {
          waitingPaths.add(rel);
          continue;
        }
        // a line spines.py resolved into `waits_on[]` references is those references, never a guessed card.
        // unless none of them resolves to an ask: the codes are then just labels of the line (` the owner
        // stamps this epic ready`), read as free text below; the unresolved codes are a defect for the owner, never an item.
        const lineRefs = waitingOnLineRefs(tree.waits?.[rel] ?? [], linesOf(rel) ?? []);
        if (lineRefs.some((r) => r.state !== "unresolved")) {
          waitingPaths.add(rel);
          continue;
        }
        const abs = inside(repo.path, rel);
        const doc = abs ? readDoc(abs) : undefined;
        const w = doc?.waitingOn;
        if (!w || NONE.test(stripInline(w)) || ownerPatterns(who).none.test(stripInline(w)) || !namesJordi(w, who)) continue;
        waitingPaths.add(rel);
        // the rows it names are the items; a line citing only asks of this tree refers to them (open: counted
        // there; answered: the line is stale, flagged on the tree), never a free-text ask of its own.
        const cited = citedAskCodes(w);
        if (citesRows(w, ownerLabels.get(rel) ?? []) || (cited.length && cited.every((c) => treeCodes.has(c)))) continue;
        // only the parts the owner acts on now count; a later step (L-13) is Coming up; the owner's ready stamp on a
        // Planning epic is one Mark ready item (on an epic that is not Planning the stamp is done: nothing to do).
        const jl = jordiLine(w, who);
        if (!jl.now.length && !jl.later.length) continue;
        // the spine's own `Status:` line wins over a missing run_state. An epic whose Status says ready, active,
        // blocked, deferred or finished was stamped already: its stamp card is stale (its button could only fail).
        // A spine with two Status lines (Current State and an Execution Cursor) leaves spines.py with none: "planning".
        const own = firstStatusWord(doc?.statusLine);
        const planning = holdState({ ...v.node, kind: "spine" }) === "planning" && !(own && STAMPED.has(own));
        if (jl.stamp && !planning && !jl.later.length) continue;
        const line = waitingOnTextLine(linesOf(rel) ?? []);
        const epic = /^\s*([A-Za-z][\w]*-\d+)\b/.exec(stripInline(doc?.title ?? v.node.title))?.[1] ?? (v.node.code && v.node.code !== m.id ? v.node.code : stripInline(doc?.title ?? v.node.title));
        const stamp = jl.stamp && planning;
        const later = !jl.now.length || (jl.stamp && !planning);
        const cites = citesOf(w, repo.name);
        out.push({
          id: hash(repo.name, rel, "waiting"),
          ...(cites.length ? { cites } : {}),
          source: "heuristic",
          signal: stamp ? "stamp_ready" : "waiting_on",
          ...(stamp ? {} : { hint: HINT }),
          ...(later ? { gate: "future" as const, gateReason: jl.later.join("; ") || "later" } : {}),
          spine: { path: rel, title: stripInline(v.node.title) },
          repo: repo.name,
          state: "open",
          milestoneId: m.id,
          milestoneTitle: m.title,
          nodeKey: v.node.key,
          path: rel,
          ...(line !== undefined ? { line } : {}),
          title: stamp ? `Mark ${epic} ready` : stripInline(v.node.title),
          ask: stamp ? "approve" : "unknown",
          question: stamp ? `Mark ${epic} ready: ${stripInline(v.node.title)}` : stripJordi((later ? jl.later : jl.now).join("; "), who) || stripInline(w),
          detail: `Waiting on: ${stripInline(w)}`,
          contextLinks: link(rel, line, `${rel} · Waiting on`),
          owner: ownerAt(rel),
          since: await sinceAt(rel, line),
          decidable: false,
        });
      }

      // 3. Rows naming the owner with no ask on them (the skill validator's advisories): red nodes (blocked/waiting on him,
      // or not started with him in Needs), plus ready/active rows whose Needs names him. Not covered by an ask on the
      // row or by their own file's Waiting on. Each is a future gate ("Coming up") or a guessed item (`futureGate`).
      // Rows sharing an id in one file (all-`draft` Issue cells): told apart by their position among them.
      const sameId = (v: Visit) => visits.filter((x) => x.rowFile === v.rowFile && x.node.kind !== "dod" && x.node.id === v.node.id);
      const gate0 = (n: TreeNode) => !!n.needs && namesJordi(n.needs, who);
      const nextWithJordi = (n: TreeNode) => {
        const w = statusWordOf(n.status);
        return (w === "ready" || w === "active") && namesJordi(n.needs, who);
      };
      for (const v of visits) {
        const n = v.node;
        if (n.kind === "dod" || askRows.has(n) || ownerRows.has(n) || isClosed(n) || n.color === "green") continue;
        if (n.color !== "red" && !nextWithJordi(n)) continue;
        if (n.path && waitingPaths.has(n.path)) continue;
        const rowFile = v.rowFile ?? n.path;
        // a row blocked on another world (its `[waits on <repo>/<code> row <id>]` line, or its status) is not his.
        if (v.rowFile && !(gate0(n)) && waitsElsewhere(n, linesOf(v.rowFile))) continue;
        const twins = sameId(v);
        const nth = twins.length > 1 ? twins.indexOf(v) : 0;
        const line = rowFile && v.rowFile ? rowLine(linesOf(rowFile) ?? [], n.id, nth) : undefined;
        const gate = n.needs && namesJordi(n.needs, who) ? n.needs : undefined;
        // also a row waiting on an open sibling (its Depends On cell, "after A0"): it is counted otherwise.
        const future = v.rowFile ? (futureGate(n, siblingsOf(v)) ?? laterStep(n, line !== undefined ? linesOf(rowFile!)?.[line] : undefined, siblingsOf(v))) : undefined;
        const spineRel = rowFile ?? n.path;
        out.push({
          id: nth ? hash(repo.name, rowFile ?? "", "node", n.id, String(nth)) : hash(repo.name, rowFile ?? "", "node", n.id),
          source: "heuristic",
          signal: gate ? "needs_column" : "red_node",
          hint: HINT,
          ...(future ? { gate: "future" as const, gateReason: future } : {}),
          ...(spineRel ? { spine: { path: spineRel, title: stripInline((nodeByPath.get(spineRel)?.node ?? n).title) } } : {}),
          repo: repo.name,
          state: "open",
          milestoneId: m.id,
          milestoneTitle: m.title,
          nodeKey: n.key,
          path: n.path ?? rowFile,
          ...(line !== undefined && rowFile === (n.path ?? rowFile) ? { line } : {}),
          title: `${n.kind === "spine" ? "" : `${n.id} `}${stripInline(n.title)}`.trim(),
          ask: "unknown",
          question: stripInline(n.title),
          detail: gate ? `Needs: ${gate} · Status: ${n.status}` : `Status: ${n.status}`,
          contextLinks: [
            ...(rowFile && v.rowFile ? link(rowFile, line, `${rowFile} · row ${n.id}`) : []),
            ...(n.path && n.path !== v.rowFile ? link(n.path) : []),
          ],
          owner: ownerAt(rowFile),
          since: rowFile && v.rowFile ? await sinceAt(rowFile, line) : undefined,
          decidable: false,
        });
      }
      // E996-S43: a free-text item (a Waiting on line, a row on the owner) is a card he sees too: one a fresh agent could
      // not do from the card alone is held like an ask (only on a failed dry run: these lines change every wake).
      const verdicts = dryRunsOf(d.reposRoot);
      for (let i = out.length - 1; i >= 0; i--) {
        const it = out[i]!;
        if (it.source !== "heuristic" || it.gate === "future" || it.line === undefined || !it.path) continue;
        const why = dryRunProblem(linesOf(it.path)?.[it.line], null, verdicts);
        if (!why) continue;
        // E948-S154: past 2 hours it reaches him, marked (its line's words committed that long ago)
        const o = dryRunOverdue(linesOf(it.path)?.[it.line], null, verdicts, await sinceAt(it.path, it.line));
        if (o.note) {
          it.readerNote = o.note;
          it.heldPast2h = o.kind;
          continue;
        }
        if (o.releaseAt !== undefined) expiresAt = Math.min(expiresAt ?? Infinity, o.releaseAt);
        const heldSince = await sinceAt(it.path, it.line);
        held.push({ repo: repo.name, path: it.path, line: it.line, question: it.question, reason: why, ...(heldSince ? { since: heldSince } : {}) });
        out.splice(i, 1);
      }
      const byKey = spineItemsMemo.get(tree) ?? new Map();
      byKey.set(memoKey, { blame, firstAdded, items: out.map((it) => ({ ...it })), settled: [...settledCodes], held: held.map((h) => ({ ...h })), ...(expiresAt !== undefined ? { expiresAt } : {}) });
      spineItemsMemo.set(tree, byKey);
    }
  }

  // 4. No Needs the owner rows: an ask raised through the API is a coded line in the asker's spine (inbox/raise.ts),
  // read above like every other ask; the needs_jordi table is only the log of what was raised and is never read here.
  // the world's owner when it is not the owner, for display (the home world's items are unchanged).
  if (worldOwner) for (const it of out) it.ownerName = worldOwner.name;
  // a card with no ask line he snoozed: the console keeps the date (inbox/consoleSnooze.ts)
  const kept = d.store.consoleSnoozes?.();
  if (kept?.size) for (const it of out) if (it.source === "heuristic" && !it.snoozedUntil && kept.has(it.id)) it.snoozedUntil = kept.get(it.id)!;
  return { items: out, held };
}

/**
 * carry-over (inbox/carry.ts): was this open Needs the owner row hidden from the inbox as a restatement of a spine ask
 * (the old read path's rules)? The `<repo>/<code>` (or `moot`) it is superseded by, else
 * undefined (it was shown, and is carried into the spine as an ask).
 */
export function legacyDuplicateOf(
  nj: { question: string; proposedAction: string; createdAt: string },
  items: WaitingItem[],
  run?: { outcome: string; summary: string },
  /** The milestone's tree with its repo name: its asks spines.py reports settled (persona-done ones too, which no card shows). */
  tree?: { asks?: Tree["asks"]; repo: string },
): string | undefined {
  if (isParkNote(run)) return "moot";
  const coded = items.filter((i) => i.source === "ask" && i.code);
  const q = (i: WaitingItem) => `${i.repo ? `${i.repo}/` : ""}${i.code}`;
  const open = coded.filter((i) => i.state === "open");
  const dupOpen = open.find((a) => duplicatesAsk(nj, [a]));
  if (dupOpen) return q(dupOpen);
  const named = coded.find((a) => namesCodedAsk(nj.question, [a]));
  if (named) return q(named);
  const settled: SettledAsk[] = [
    ...coded.filter((i) => i.state !== "open").map((i) => ({ code: i.code, repo: i.repo, question: i.question, settledOn: i.doneAt || i.since?.slice(0, 10) || "" })),
    ...Object.values(tree?.asks ?? {})
      .flat()
      .filter((a) => a.code && (a.state !== "open" || a.doneAt !== undefined))
      .map((a) => ({ code: a.code!, repo: tree!.repo, question: a.question, settledOn: a.doneAt || a.since || "" })),
  ];
  const s = settled.find((a) => namesSettledAsk(nj.question, [a]) || restatesSettledAsk(nj, [a]));
  return s ? `${s.repo ? `${s.repo}/` : ""}${s.code}` : undefined;
}

/** D19: a Needs the owner item whose question starts with a spine code (`: …`, `poly-maker/: …`) is that ask, not a second one. */
export const QUESTION_CODE = /^\s*[`*_(]*(?:([A-Za-z0-9][\w.-]*)\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+)\b/i;
export function leadingCode(question: string): { repo?: string; code: string } | undefined {
  const m = QUESTION_CODE.exec(question);
  return m ? { ...(m[1] ? { repo: m[1] } : {}), code: m[2] } : undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/**
 * the note an auto-park used to raise (before it was a Needs the owner row on the park run: an `idle` run whose
 * summary is `parked: <reason>`). It asks nothing; the park lives in Activity, so such rows are never inbox items.
 */
export const isParkNote = (run?: { outcome: string; summary: string }) => !!run && run.outcome === "idle" && run.summary.startsWith("parked: ");

/** D19 same ask: the question starts with the code of an ask of this milestone, whatever its state (answered and done asks too). */
function namesCodedAsk(question: string, asks: Pick<WaitingItem, "code" | "repo">[]): boolean {
  const lead = leadingCode(question);
  return !!lead && asks.some((a) => a.code!.toLowerCase() === lead.code.toLowerCase() && (!lead.repo || a.repo?.toLowerCase() === lead.repo.toLowerCase()));
}

/**
 * a Needs the owner question about asks spines.py reports answered / done / superseded: it starts with one of their
 * codes, or (no leading code) every ask code it names is one of them. A question citing a settled ask beside an open one stays.
 */
function namesSettledAsk(question: string, settled: Pick<WaitingItem, "code" | "repo">[]): boolean {
  if (!settled.length) return false;
  if (leadingCode(question)) return namesCodedAsk(question, settled);
  const named = citedAskCodes(question);
  const codes = new Set(settled.map((a) => a.code!.toUpperCase()));
  return named.length > 0 && named.every((c) => codes.has(c));
}

type SettledAsk = Pick<WaitingItem, "code" | "repo"> & { question: string; settledOn: string };

/** the row restates (text rule) a settled ask whose settle date is on or after the row's own date. */
function restatesSettledAsk(nj: { question: string; proposedAction: string; createdAt: string }, settled: SettledAsk[]): boolean {
  const after = settled.filter((a) => a.settledOn && a.settledOn >= nj.createdAt.slice(0, 10));
  return after.length > 0 && duplicatesAsk(nj, after.map((a) => ({ question: a.question })));
}

/** a Needs the owner row restating an open coded ask (or a settled one, given without its code): it names the ask's code (``, `poly-maker/`), or its text and the ask's question contain one another. */
function duplicatesAsk(nj: { question: string; proposedAction: string }, asks: Pick<WaitingItem, "question" | "code" | "steps">[]): boolean {
  const text = `${nj.question}\n${nj.proposedAction}`;
  const nq = norm(nj.question);
  return asks.some((a) => {
    if (a.code && new RegExp(`(^|[^A-Za-z0-9-])${esc(a.code)}($|[^A-Za-z0-9])`, "i").test(text)) return true;
    const aq = norm(a.question);
    if (nq.length >= 20 && aq.length >= 20 && (nq.includes(aq) || aq.includes(nq))) return true;
    // Reworded restatement: most of the content words (4+ letters) of the shorter text are in the other (Jaccard >= 0.6).
    const words = (x: string) => new Set(norm(x).split(" ").filter((w) => w.length >= 4));
    const w1 = words(`${nj.question} ${nj.proposedAction}`);
    const w2 = words(`${a.question} ${a.steps ?? ""}`);
    if (w1.size < 4 || w2.size < 4) return false;
    const common = [...w1].filter((w) => w2.has(w)).length;
    return common / (w1.size + w2.size - common) >= 0.6;
  });
}

/**
 * Items across milestones (or one), deduplicated by id (a spine shared by two milestones counts once), oldest first.
 * one card per canonical ask. A spine reference line `[waits on <code> row <id>]` (D19; interim `waits on <repo>/<CODE>` still read, or the canonical ask's `unblocks:` naming
 * `<repo>/<row>`) makes the referencing milestone a reference on that ask's card (`referencedBy`) and shows the card
 * in that milestone's own view; the guessed item the same row would have produced is dropped. A reference whose code
 * matches no ask stays visible as a guessed item with the reason.
 */
export async function waitingOnJordi(
  d: WaitingDeps,
  f: { milestoneId?: string; nodeKey?: string; includeSettled?: boolean; includeSuperseded?: boolean } = {},
): Promise<WaitingItem[]> {
  return (await waitingAndDefects(d, f)).items;
}

/**
 * a code in a spine that names no ask (`Waiting on: …` with no `## Waiting on` line behind it, or
 * `waits on memory/` matching nothing): never an item for the owner, a defect its owner (the Delivery Manager) fixes.
 */
/**
 * the code of an open `[ask <CODE>: … row <label>]` line for this row that sits outside `## Waiting on` (a
 * bullet under the Current State `Waiting on:` field: on 2026-11-01): the parser reads only the section.
 */
export function askOutsideFor(lines: string[], label: string): string | undefined {
  let inSection = false;
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) inSection = /^##\s+Waiting on\b/i.test(l);
    if (inSection) continue;
    const m = /\[ask\s+([A-Za-z][\w.-]*-A\d+)\s*:[^\]]*\brow\s+([^\s\]]+)/i.exec(l);
    if (m && m[2].replace(/[.:,)]+$/, "").toLowerCase() === label.toLowerCase()) return m[1];
  }
  return undefined;
}

export interface RefDefect {
  /** ref (default): a code naming no ask; free_text: the owner named in a spine line with no coded ask. */
  kind?: "ref" | "free_text";
  milestoneId: string;
  repo: string;
  code?: string;
  path: string;
  line: number;
  nodeKey?: string;
  url?: string;
  text: string;
  /** What the header shows after the `path:line` link (free_text defects). */
  note?: string;
}

/** waitingOnJordi, plus the unresolved references of the scoped milestones (defects, never items). */
export async function waitingAndDefects(
  d: WaitingDeps,
  f: { milestoneId?: string; nodeKey?: string; includeSettled?: boolean; includeSuperseded?: boolean; world?: string } = {},
): Promise<{ items: WaitingItem[]; defects: RefDefect[] }> {
  // the global list hides settled milestones unless includeSettled; asking for one milestone always answers.
  // one milestone's list (its wake, its Unblocker's open asks, its chat) resolves references inside its own world only.
  // `world` = every milestone of one world, resolved as each one's own list is (the sidebar and the page agree).
  const world = f.milestoneId ? d.store.worldOfMilestone(f.milestoneId) : f.world;
  // the team repo's root spine holds the team-level asks (no single epic's): listed next to each epic's, labelled "Team".
  const everyone = d.store
    .listMilestones({ includeSettled: true })
    .filter((m) => !world || d.store.worldOfMilestone(m.id) === world)
    .map((m) => (isTeamMilestone(m, d.teamRepo) ? { ...m, title: TEAM_LABEL } : m));
  const scoped = everyone.filter((m) => (f.milestoneId ? m.id === f.milestoneId : f.includeSettled || !m.settledAt));
  // References resolve against every active milestone, whichever one is being viewed.
  const scopedIds = new Set(scoped.map((m) => m.id));
  const universe = [...scoped, ...everyone.filter((m) => !scopedIds.has(m.id) && (f.includeSettled || !m.settledAt))];
  const trees = new Map<string, Promise<Tree>>();
  const memo = (m: Milestone) => {
    if (!trees.has(m.id)) trees.set(m.id, d.treeFor(m));
    return trees.get(m.id)!;
  };
  const dd: WaitingDeps = { ...d, treeFor: memo, ...(f.includeSuperseded ? { includeSuperseded: true } : {}) };
  const lists = await Promise.all(universe.map((m) => waitingForMilestone(dd, m).catch(() => [] as WaitingItem[])));
  const seen = new Map<string, WaitingItem>();
  const items: WaitingItem[] = [];
  for (const it of lists.flat()) {
    const first = seen.get(it.id);
    // E948-S182: two milestones of one repo can read the tree at different moments: the old path's record of a moved
    // ask gives way to the record whose file holds the line now (one card, the live one).
    if (first && first.source === "ask" && it.source === "ask" && first.code && it.repo && first.path !== it.path) {
      const dir = resolveRepo(d.reposRoot, it.repo)?.path;
      const keep = dir ? samePairKeep(first, it, (p) => askLineIn(dir, p, it.code ?? first.code!)) : "a";
      // both lines live: a real duplicate in the spines, listed apart by its path id (the census names it)
      if (keep === "both" && it.legacyId && !seen.has(it.legacyId)) {
        const apart = { ...it, id: it.legacyId };
        delete apart.legacyId;
        seen.set(apart.id, apart);
        items.push(apart);
        continue;
      }
      if (keep === "b") {
        const at = items.indexOf(first);
        const also = [...new Set([first.milestoneId, ...(first.alsoIn ?? []), ...(it.alsoIn ?? [])].filter((x) => x && x !== it.milestoneId))];
        const next = { ...it, ...(also.length ? { alsoIn: also } : {}) };
        items[at] = next;
        seen.set(it.id, next);
        continue;
      }
    }
    if (first) {
      // a spine shared by two milestones lists the item once, but it is in both milestones' counts.
      if (it.milestoneId !== first.milestoneId && !first.alsoIn?.includes(it.milestoneId)) first.alsoIn = [...(first.alsoIn ?? []), it.milestoneId];
      continue;
    }
    seen.set(it.id, it);
    items.push(it);
  }

  // ---- references ----
  const known = listRepos(d.reposRoot).map((r) => r.name);
  // a code qualified with a checkout that only another world's milestones track (`the code repo/` seen
  // from a social world repo) is that world's ask: never a defect here, and the owner row waiting on it is that ask's, not a card
  // of its own. Its card and answer stay in its own world (other worlds' spines are never read from here).
  const local = new Set(universe.flatMap((m) => { const r = m.path ? resolveRepo(d.reposRoot, m.repo) : undefined; return r ? [r.name.toLowerCase()] : []; }));
  const knownLower = new Set(known.map((r) => r.toLowerCase()));
  const elsewhere = (repo: string) => !!world && !local.has(repo.toLowerCase()) && knownLower.has(repo.toLowerCase());
  const scans = await Promise.all(
    universe.map(async (m) => {
      const repo = m.path ? resolveRepo(d.reposRoot, m.repo) : undefined;
      if (!repo) return undefined;
      try {
        return { m, repo, ...scanTree(await memo(m), repo.path, repo.name) };
      } catch {
        return undefined;
      }
    }),
  );
  const canon = new Map<string, WaitingItem>();
  for (const it of items) if (it.source === "ask" && it.code && it.repo && !canon.has(refKey(it.repo, it.code))) canon.set(refKey(it.repo, it.code), it);
  const refsOf = new Map<string, AskReference[]>();
  const addRef = (c: WaitingItem, r: AskReference) => {
    const list = refsOf.get(c.id) ?? [];
    if (!list.some((x) => x.milestoneId === r.milestoneId && x.path === r.path && x.line === r.line && x.row === r.row)) list.push(r);
    refsOf.set(c.id, list);
  };
  const covered = new Set<string>(); // heuristic item ids that a reference replaces
  const defects: RefDefect[] = [];
  const defectKeys = new Set<string>();
  const mkRef = (sc: NonNullable<(typeof scans)[number]>, at: { path: string; line?: number; row?: string; nodeKey?: string; gloss?: string }, via: AskReference["via"]): AskReference => ({
    milestoneId: sc.m.id,
    milestoneTitle: sc.m.title,
    ...at,
    via,
    ...(githubUrl(sc.repo.remote, at.path, at.line) ? { url: githubUrl(sc.repo.remote, at.path, at.line)! } : {}),
  });
  const coverRow = (m: Milestone, nodeKey?: string, row?: string) => {
    if (!row || !nodeKey) return;
    for (const it of items) if (it.source === "heuristic" && it.milestoneId === m.id && it.nodeKey === nodeKey) covered.add(it.id);
  };
  for (const sc of scans) {
    if (!sc) continue;
    for (const w of sc.waits) {
      const c = canon.get(refKey(w.repo, w.code));
      if (c) {
        if (c.milestoneId === sc.m.id && c.path === w.path) continue; // an ask referring to itself is just the ask
        addRef(c, mkRef(sc, { path: w.path, line: w.line, ...(w.row ? { row: w.row } : {}), ...(w.nodeKey ? { nodeKey: w.nodeKey } : {}), ...(w.gloss ? { gloss: w.gloss } : {}) }, "waits_on"));
        coverRow(sc.m, w.nodeKey, w.rowUnmatched ? undefined : w.row);
      } else if (!w.closed && w.state !== "done" && w.state !== "superseded" && w.state !== "answered" && scopedIds.has(sc.m.id) && !elsewhere(w.repo)) {
        const k = `${sc.m.id}\0${w.path}\0${w.line}\0${refKey(w.repo, w.code)}`;
        if (defectKeys.has(k)) continue;
        defectKeys.add(k);
        const url = githubUrl(sc.repo.remote, w.path, w.line);
        defects.push({
          milestoneId: sc.m.id,
          repo: w.repo,
          code: w.code,
          path: w.path,
          line: w.line,
          ...(w.nodeKey ? { nodeKey: w.nodeKey } : {}),
          ...(url ? { url } : {}),
          text: `${w.path}:${w.line + 1} names ${w.repo}/${w.code}, but no ask has that code: write it as a \`## Waiting on\` ask when it blocks now, or drop the code`,
        });
      }
    }
  }
  // The canonical ask's `unblocks:` naming rows of other epics (`<repo>/<row>`).
  for (const c of canon.values()) {
    for (const u of unblockRefs(c.unblocks, known, c.repo)) {
      for (const sc of scans) {
        if (!sc || sc.repo.name.toLowerCase() !== u.repo.toLowerCase() || sc.m.id === c.milestoneId) continue;
        const at: RowAt | undefined = sc.rows.get(u.row.toLowerCase());
        if (!at) continue;
        addRef(c, mkRef(sc, { path: at.path, ...(at.line !== undefined ? { line: at.line } : {}), row: u.row, nodeKey: at.nodeKey }, "unblocks"));
        coverRow(sc.m, at.nodeKey, u.row);
      }
    }
  }

  // D19: a Needs the owner item that starts with the code of a canonical ask (any milestone, any state) is that ask.
  for (const it of items) {
    if (it.source !== "needs_jordi" || it.state !== "open") continue;
    const lead = leadingCode(it.question);
    if (!lead) continue;
    const same = [...canon.values()].filter((x) => x.code!.toLowerCase() === lead.code.toLowerCase());
    const c = lead.repo ? canon.get(refKey(lead.repo, lead.code)) : same.find((x) => x.milestoneId === it.milestoneId) ?? same[0];
    if (c) covered.add(it.id);
  }

  // the owner row or free-text `Waiting on:` line whose codes are all asks somewhere (`the code repo/
  // (the owner; …)`) waits on those asks: a reference on the ask's card (its row gets the ring in the tree), never a second item.
  for (const it of items) {
    if (it.source !== "heuristic" || !it.cites?.length || it.gate) continue;
    const asks = it.cites.map((c) => canon.get(refKey(c.repo, c.code)) ?? [...canon.values()].find((x) => x.code!.toUpperCase() === c.code.toUpperCase()));
    if (asks.some((a, n) => !a && !elsewhere(it.cites![n].repo))) continue;
    covered.add(it.id);
    const sc = scans.find((x) => x?.m.id === it.milestoneId);
    for (const a of asks)
      if (a && sc && a.id !== it.id && !(a.milestoneId === it.milestoneId && a.nodeKey === it.nodeKey))
        addRef(a, mkRef(sc, { path: it.path ?? "", ...(it.line !== undefined ? { line: it.line } : {}), ...(it.nodeKey ? { nodeKey: it.nodeKey } : {}), gloss: it.title }, "waits_on"));
  }

  const out: WaitingItem[] = [];
  for (const it of items) {
    if (covered.has(it.id)) continue;
    const refs = refsOf.get(it.id);
    const mine = scopedIds.has(it.milestoneId) || !!it.alsoIn?.some((x) => scopedIds.has(x));
    const refsInScope = (refs ?? []).filter((r) => scopedIds.has(r.milestoneId));
    if (!mine && !refsInScope.length) continue;
    const nodeOk = (key?: string) => !f.nodeKey || key === f.nodeKey || !!key?.startsWith(f.nodeKey + "/");
    if (f.nodeKey && !((mine && nodeOk(it.nodeKey)) || refsInScope.some((r) => nodeOk(r.nodeKey)))) continue;
    out.push(refs?.length ? { ...it, referencedBy: refs } : it);
  }
  const scopedDefects = defects.filter((x) => !f.nodeKey || x.nodeKey === f.nodeKey || !!x.nodeKey?.startsWith(f.nodeKey + "/"));
  return { items: out.sort((a, b) => itemRank(a) - itemRank(b) || (a.since ?? "9").localeCompare(b.since ?? "9")), defects: scopedDefects };
}

/**
 * answers the owner gave at a canonical ask of another epic that this milestone's spines reference
 * (`waits on <repo>/<code>`, or the ask's `unblocks:` naming this milestone's rows): the wake prompt lists them under
 * "Answered by the owner" with the canonical file:line. Consumed (`· done`) lines are not listed.
 */
export async function answeredReferences(d: WaitingDeps, m: Milestone, given?: WaitingItem[]): Promise<AnsweredAsk[]> {
  const items = given ?? (await waitingOnJordi(d, { milestoneId: m.id }));
  const out: AnsweredAsk[] = [];
  const myRepo = m.path ? resolveRepo(d.reposRoot, m.repo)?.name : undefined;
  for (const it of items) {
    const ref = it.referencedBy?.find((r) => r.milestoneId === m.id);
    if (!ref || it.milestoneId === m.id || it.source !== "ask" || it.state !== "answered" || !it.path) continue;
    out.push({
      path: `${it.repo && it.repo !== myRepo ? `${it.repo}:` : ""}${it.path}`,
      ...(it.line !== undefined ? { line: it.line } : {}),
      question: it.question,
      ...(it.answer ? { answer: it.answer } : {}),
      ...(ref.row ? { row: ref.row } : {}),
      reference: { code: qualifiedCode(it) ?? it.code ?? "", at: `${ref.path}${ref.line !== undefined ? `:${ref.line + 1}` : ""}` },
    });
  }
  return out;
}

export const VERB: Record<AskKind, string> = { decide: "Decide", approve: "Approve", provide: "Provide", do: "Action", unknown: "Respond" };
/** `<repo>/<code>` (human-asks v2: codes are qualified across repos); undefined without a code. */
export const qualifiedCode = (i: Pick<WaitingItem, "code" | "repo">) => (i.code ? (i.repo ? `${i.repo}/${i.code}` : i.code) : undefined);
