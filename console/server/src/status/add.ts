import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context, Hono } from "hono";
import { promisify } from "node:util";
import type { Milestone, Store } from "../store.js";
import { appendDecision, sectionRange } from "../approvals.js";
import { proseLines } from "../adapters/markdown.js";
import { oneLine, type SpineWriter } from "../inbox/spineWrite.js";
import type { Delivery } from "../desk/delivery.js";
import { deskOnly, deskQuote, notJordi, setStatus } from "./mark.js";
import { ownerName } from "../identity.js";
import { highestRowNumber, repoRowIds } from "./rowIds.js";
import { editRowStatus } from "../review/rows.js";

const exec = promisify(execFile);

/**
 * Add on a tree node. A new item under a spine (a ledger row, a Done-means line or a child epic), written through
 * the console's one spine writer (guards, lock, commit + push on main). The format is the one the spine already
 * uses (header-driven row, the next id from the ids already there); a child epic is scaffolded by EpicSpine's own
 * `spine_new.py` and checked with `validate_spine.py --trackable`.
 * the owner's own Add is READY by default, his ask is his ready stamp,
 * cited in a Decisions row; a Done-means line also gets a ready ledger row covering it, and the milestone's Delivery
 * manager is woken. the owner's own = the console page in his browser (the same wall as Mark), or the Team desk passing his
 * words (`chat`) from his newest desk message, or a milestone chat passing his words from its thread. `draft: true` ("Just register it") keeps it a draft; any other caller (a
 * persona run, a token, a milestone chat without his words) adds drafts only: agents never ready their own ideas.
 */
export type AddKind = "row" | "done_means" | "epic";
export const ADD_KINDS: readonly AddKind[] = ["row", "done_means", "epic"];

export interface AddInput {
  kind: AddKind;
  title: string;
  /** One line of what it is (the row's title suffix, the criterion text, the epic's goal). */
  line?: string;
  /** Repo-relative spine the item goes under (default: the milestone's spine). */
  path?: string;
  /** "Just register it": a draft even when the owner asks (no row for a Done-means line, no wake). */
  draft?: boolean;
  /** the Team desk's Add: the owner's words from his newest desk message, verbatim (his ask, checked by the console). */
  chat?: string;
  /**
   * the desk's answer to "is this point new, or more context for a ticket we have?" before it files his words as a
   * new row or epic: `new: <the tickets it read (voice_passes.py match) and why none wants the same outcome>`.
   */
  matched?: string;
}

/** a new row or epic from his words needs the desk's `matched: new: …` first (one point, one ticket). */
export const MATCH_FIRST =
  "Is this point new, or more context for a ticket we have? Run `python3 scripts/voice_passes.py match \"<his words for this point>\"` " +
  "in the home repo and read every ticket it lists. When one wants the same outcome, put his words on that ticket (quoted, L-37), " +
  "never a new card. Only when none does, add again with `matched: \"new: <the tickets you read> — <why none holds it>\"`.";
const MATCH_NEW = /^new\s*:\s*\S.{11,}/i;

const TITLE_MAX = 120;
const LINE_MAX = 300;
const cell = (s: string) => oneLine(s).replace(/\|/g, "/");
/** `Title: one line` (or just the title). */
const label = (i: Pick<AddInput, "title" | "line">) => (i.line ? `${i.title.replace(/[.:]\s*$/, "")}: ${i.line}` : i.title);

export function addIn(raw: unknown): AddInput | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.kind !== "string" || !ADD_KINDS.includes(b.kind as AddKind)) return `kind must be one of ${ADD_KINDS.join(", ")}`;
  const text = (v: unknown, max: number, what: string): string | undefined | { error: string } => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return { error: `${what} must be text` };
    const t = oneLine(v).replace(/\s+/g, " ");
    return t.length > max ? { error: `keep ${what} under ${max} characters` } : t;
  };
  const title = text(b.title, TITLE_MAX, "the title");
  const line = text(b.line, LINE_MAX, "the line");
  if (typeof title === "object") return title.error;
  if (typeof line === "object") return line.error;
  if (!title) return "title is required";
  if (b.path !== undefined && typeof b.path !== "string") return "path must be a repo-relative spine path";
  if (b.draft !== undefined && typeof b.draft !== "boolean") return "draft must be true or false";
  if (b.chat !== undefined && typeof b.chat !== "string") return `chat must be ${ownerName()}'s words, as text`;
  if (b.matched !== undefined && (typeof b.matched !== "string" || b.matched.length > 600)) return "matched must be text under 600 characters";
  return {
    kind: b.kind as AddKind,
    title,
    ...(line ? { line } : {}),
    ...(typeof b.path === "string" && b.path.trim() ? { path: b.path.trim() } : {}),
    ...(b.draft === true ? { draft: true } : {}),
    ...(typeof b.chat === "string" && b.chat.trim() ? { chat: b.chat.trim().slice(0, 2000) } : {}),
    ...(typeof b.matched === "string" && b.matched.trim() ? { matched: oneLine(b.matched) } : {}),
  };
}

type Edited = { text: string; id: string } | { skip: string };

const splitCells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const ROW_ID = /^([A-Za-z]+\d+)-S(\d+)$/;
const DM_LINE = /^(\s*[-*]\s+\[[ xX]\]\s+)([A-Za-z]+\d+)-(\d+)\b/;

/** The criterion-id prefix of the `## Done means` lines (`E18`), the fallback prefix for a first row id. */
function doneMeansPrefix(text: string): string | undefined {
  const r = sectionRange(text, /^done means\b/i);
  if (!r) return undefined;
  for (const l of proseLines(text).slice(r.head + 1, r.end)) {
    const m = DM_LINE.exec(l.replace(/\r$/, ""));
    if (m) return m[2];
  }
  return undefined;
}

/**
 * A new row at the end of the `## Issue Ledger` table, columns filled by header, id = next `<prefix>-S<n>`: a draft, or
 * ready (the owner's ask, next action dispatch). `covers` = the Done-means id it builds, first in its title. `prefix`:
 * the id prefix when the spine names none (a campaign's `E<n>` from its `EPIC-<n>` title).
 */
export function addLedgerRow(text: string, i: Pick<AddInput, "title" | "line">, date: string, o: { ready?: boolean; covers?: string; prefix?: string; taken?: string[] } = {}): Edited {
  const cr = text.includes("\r\n") ? "\r" : "";
  const raw = text.split("\n");
  const lines = proseLines(text);
  const r = sectionRange(text, /^(issue ledger|ledger)\b/i);
  if (!r) return { skip: "the spine has no Issue Ledger section" };
  let header = -1;
  let last = -1;
  for (let k = r.head + 1; k < r.end; k++) {
    if (!/^\s*\|/.test(lines[k])) continue;
    if (header < 0) header = k;
    last = k;
  }
  if (header < 0) return { skip: "the Issue Ledger has no table to add a row to" };
  const heads = splitCells(lines[header]);
  const ids = lines.slice(header + 1, last + 1).filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l)).map((l) => splitCells(l)[0] ?? "");
  const nums = ids.map((x) => ROW_ID.exec(x)).filter((m): m is RegExpExecArray => !!m);
  const prefix = nums[0]?.[1] ?? doneMeansPrefix(text) ?? o.prefix;
  if (!prefix) return { skip: "cannot tell the row id prefix (no S-numbered rows and no Done means ids to take it from)" };
  // numbered across the repo: an id any other spine already names (`taken`) is never reused
  const id = `${prefix}-S${Math.max(nums.reduce((n, m) => Math.max(n, Number(m[2])), 0), highestRowNumber(`${prefix}-S`, o.taken ?? [])) + 1}`;
  const title = cell((o.covers ? `${o.covers}: ` : "") + label(i));
  if (lines.slice(header + 1, last + 1).some((l) => splitCells(l).some((c) => c.toLowerCase() === title.toLowerCase()))) return { skip: `the ledger already has a row titled “${title}”` };
  const value = (h: string) =>
    /^(issue|id)\b/i.test(h) ? id
    : /\brole\b/i.test(h) ? "Ticket worker"
    : /owner|assign/i.test(h) ? "unassigned"
    : /title/i.test(h) ? title
    : /^status/i.test(h) ? (o.ready ? "ready" : "draft")
    : /^base/i.test(h) ? "main"
    : /verified/i.test(h) ? date
    : /next action/i.test(h) ? (o.ready ? `dispatch (${ownerName()}'s ask, L-37)` : "wait for ready")
    : "none";
  raw.splice(last + 1, 0, `| ${heads.map(value).join(" | ")} |${cr}`);
  return { text: raw.join("\n"), id };
}

/** A new unticked `- [ ] <prefix>-<n+1> text` line after the last criterion of `## Done means`. */
export function addDoneMeans(text: string, i: Pick<AddInput, "title" | "line">): Edited {
  const cr = text.includes("\r\n") ? "\r" : "";
  const raw = text.split("\n");
  const lines = proseLines(text);
  const r = sectionRange(text, /^done means\b/i);
  if (!r) return { skip: "the spine has no Done means section" };
  let last = -1;
  let prefix: string | undefined;
  let max = 0;
  for (let k = r.head + 1; k < r.end; k++) {
    const m = DM_LINE.exec(lines[k].replace(/\r$/, ""));
    if (!m) continue;
    last = k;
    prefix ??= m[2];
    max = Math.max(max, Number(m[3]));
  }
  if (!prefix || last < 0) return { skip: "the Done means section has no numbered criterion to follow (E<n>-<k>)" };
  const body = cell(label(i));
  if (lines.slice(r.head + 1, r.end).some((l) => DM_LINE.test(l.replace(/\r$/, "")) && l.toLowerCase().includes(body.toLowerCase()))) return { skip: `Done means already has “${body}”` };
  const id = `${prefix}-${max + 1}`;
  raw.splice(last + 1, 0, `- [ ] ${id} ${body}${cr}`);
  return { text: raw.join("\n"), id };
}

/** the owner's words choosing a draft ("just register it", "draft", "don't do it yet"); "don't put it in draft" is not. */
const DONT_DRAFT = /\b(?:don'?t|do not|never)\s+(?:put|leave|keep|make)\s+(?:(?:it|them|this|these|that|those)\s+)?(?:in|as|a)\s+(?:a\s+)?drafts?\b/i;
const JUST_REGISTER = /\bjust (?:register|note|log|park)\b|\b(?:as|in|into|just) (?:a )?drafts?\b|\b(?:don'?t|do not) (?:do|start|build|work on) (?:it|this|that|them) yet\b/i;
export const choosesDraft = (said: string) => !DONT_DRAFT.test(said) && JUST_REGISTER.test(said);

/** whose Add this is. `owner` = his own ask (page or desk with his words); `why` = why it stays a draft. */
export type Asker = { owner: true; via: string; quote?: string; request?: string } | { owner: false; why: string };

/** The Decisions row of a ready Add (L-37: ready comes from the owner's words, cited in Decisions). */
/** one request, one row: the Decisions row of an Add names the request it came from, so that request sits on this one row. */
export function readyDecision(ids: string, a: { via: string; quote?: string; request?: string }, date: string) {
  return {
    date,
    decision: `${ids} ready on ${ownerName()}'s ask (L-37, ${a.via}${a.quote ? `: "${a.quote}"` : ""}${a.request ? `; request ${a.request}` : ""})`,
    summary: `${ownerName()}'s ask is his ready stamp: the Delivery manager's next wake works it`,
  };
}

export const slugOf = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "new-epic";

export interface AddOptions {
  store: Store;
  spine: SpineWriter;
  /** The milestone's checkout and spine path. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string }>;
  /** Repo-relative spine paths in the milestone's tree (an Add on a child epic's node names its path). */
  treePaths: (m: Milestone) => Promise<Set<string>>;
  invalidate: (repoDir: string) => void;
  /** called after a successful Add with the new item (the app records it as a desk placement when the caller is the desk). */
  onAdded?: (a: { repoDir: string; path: string; kind: AddKind; id?: string; newPath?: string; title: string }, header: (name: string) => string | undefined) => void;
  /** whether the milestone's work will be delivered (its Delivery Manager on); the answer carries it as `delivery`. */
  delivery?: (milestoneId: string) => Delivery;
  /** the owner's newest desk message containing `chat` (or why not): the Team desk's Add on his ask. */
  deskAsk?: (chat: string) => Promise<{ text: string; at: string; request?: string } | string>;
  /** a milestone chat's Add (its X-Console-Run header) passing the owner's words from ITS thread: true (or his message's request id) when they are his. */
  chatSaid?: (header: string | undefined, chat: string) => Promise<boolean | string>;
  /** wake the milestone's Delivery manager after a ready Add (approvals.ts wakeDeliveryManager). */
  wake?: (m: Milestone, instructions: string) => Promise<{ runId: string } | { error: string } | undefined>;
  /** how long the Add's answer waits for that wake (default 3 s): past it the wake goes on in the background and the
   *  answer leaves `wake` out. A wake waits on the agent host (a slow or failing thread call): an Add once took 136 s. */
  wakeWaitMs?: number;
  /** EpicSpine skill dir (scripts/spine_new.py, validate_spine.py); without it a child epic cannot be added. */
  skillDir?: string;
  python?: string;
  /** the filing match (default: `voice_passes.py held` in the milestone's checkout); null switches it off. */
  held?: ((repoDir: string, words: string) => Promise<Held | undefined>) | null;
}

/**
 * The filing step's own match (the owner's card answer of 18 Nov: "the first time around is already gonna
 * be pretty good ... 80 to 90% there, and then we're gonna do the final twist once a day"). Before a row of his words
 * is written, `voice_passes.py held` asks the judges (the call the score measures, 29 of 32 of his real points on
 * 23 Nov) whether an open ticket already wants the same outcome. `held`: his words go on that ticket, no new row.
 * `after`: the ticket it repeats is closed, so the new row names it as its follow-up. undefined: the match could not
 * run, and the desk's own `matched: new: …` is required as before.
 */
export interface Held {
  held?: string | null;
  after?: string | null;
  judged?: string;
  why?: string;
  status?: string;
  file?: string;
  agree?: string;
  top?: string[];
}

export async function heldBy(repoDir: string, words: string, python = "python3"): Promise<Held | undefined> {
  const script = path.join(repoDir, "scripts", "voice_passes.py");
  if (!fs.existsSync(script)) return undefined;
  try {
    const { stdout } = await exec(python, [script, "held", "--repo", repoDir, "--", oneLine(words).slice(0, 3000)], {
      timeout: 90_000,
      maxBuffer: 4 << 20,
      // the judges are this console's own text model: its own address (production binds its tailnet host, not 127.0.0.1)
      env: { ...process.env, JUDGE_URL: process.env.JUDGE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 8750}` },
    });
    const last = stdout.trim().split("\n").pop() ?? "";
    return JSON.parse(last) as Held;
  } catch (e) {
    console.warn(`tree add: the filing match could not run: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return undefined;
  }
}

/** His words placed on the ticket that already holds them: a Decisions line quoting him; a draft or parked ticket is
 *  ready again when it is his ask (his ask is his ready stamp, L-37). */
export function placeWords(text: string, ref: string, d: { quote: string; why: string; agree?: string; date: string; ready: boolean; via: string; request?: string }): { text: string; readied: boolean } {
  let next = appendDecision(text, {
    date: d.date,
    decision: `${ref}: ${ownerName()}'s words placed here at filing, no new row (the same outcome, judges ${d.agree ?? "?"}, ${d.via}): "${d.quote}"${d.request ? `; request ${d.request}` : ""}`,
    summary: d.why || "more context for this ticket",
    evidence: "voice_passes.py held",
  });
  let readied = false;
  if (d.ready) {
    const e = editRowStatus(next, ref, (s) => (/^(draft|deferred|parked)\b/i.test(s.trim()) ? "ready" : { skip: "already open" }));
    if ("text" in e) {
      next = e.text;
      readied = true;
    }
  }
  return { text: next, readied };
}

/** `validate_spine.py --trackable` on a text (a temp file): true/false, undefined when it cannot run. */
function trackable(o: AddOptions, text: string): boolean | undefined {
  if (!o.skillDir) return undefined;
  const script = path.join(o.skillDir, "scripts", "validate_spine.py");
  if (!fs.existsSync(script)) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-add-"));
  const file = path.join(dir, "spine.md");
  try {
    fs.writeFileSync(file, text);
    execFileSync(o.python ?? "python3", [script, "--trackable", file], { timeout: 15_000, stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? false : undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function mountTreeAdd(api: Hono, o: AddOptions) {
  /** the owner's page (the Mark wall), or the Team desk with his words from his newest desk message; else an agent's draft. */
  const askerOf = async (header: (name: string) => string | undefined, input: AddInput): Promise<Asker> => {
    if (!notJordi(header)) return { owner: true, via: "console page" };
    if (deskOnly(header)) {
      // A milestone chat passes his words from its own thread (the same check as an answer it registers).
      const said = input.chat && !header("authorization") && !header("x-run-id") && o.chatSaid ? await o.chatSaid(header("x-console-run"), input.chat) : false;
      if (said)
        return choosesDraft(input.chat!)
          ? { owner: false, why: `${ownerName()} said to just register it` }
          : { owner: true, via: "milestone chat", quote: deskQuote(input.chat!), ...(typeof said === "string" ? { request: said } : {}) };
      return { owner: false, why: `an agent's Add: only ${ownerName()}'s own ask is ready (L-37)` };
    }
    if (!input.chat || !o.deskAsk) return { owner: false, why: `the Team desk passed no words of ${ownerName()}'s (chat): a draft until he asks` };
    const ask = await o.deskAsk(input.chat);
    if (typeof ask === "string") return { owner: false, why: `not ${ownerName()}'s ask (${ask})` };
    if (choosesDraft(ask.text)) return { owner: false, why: `${ownerName()} said to just register it` };
    return { owner: true, via: "Team desk", quote: deskQuote(ask.text), ...(ask.request ? { request: ask.request } : {}) };
  };
  const err = (c: Context, status: 400 | 404 | 409 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);
  const delivery = (id: string) => {
    const d = o.delivery?.(id);
    return d ? { delivery: d, ...(d.notice ? { notice: d.notice } : {}) } : {};
  };
  api.post("/milestones/:id/tree/add", async (c) => {
    const m = o.store.getMilestone(c.req.param("id"));
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const input = addIn(body);
    if (typeof input === "string") return err(c, 400, "validation_error", input);
    // the Team desk filing his words as a new row or epic says first that no ticket we have holds them.
    const header = (n: string) => c.req.header(n);
    const needsMatch = !!input.chat && input.kind !== "done_means" && notJordi(header) && !deskOnly(header);
    const asker = await askerOf(header, input);
    const ready = asker.owner && !input.draft;
    const draftWhy = !asker.owner ? asker.why : input.draft ? `${ownerName()} chose “just register it”` : undefined;
    const after = async (ids: string, where: string) => {
      if (!ready) return {};
      const started = o.wake?.(m, `${ownerName()} added ${ids} under ${where} from the console, ready on his ask (L-37): plan and dispatch it in this wake.`);
      if (!started) return {};
      // the spine is written: answer now and let a slow wake finish in the background (its outcome is logged)
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), o.wakeWaitMs ?? 3000)));
      const wake = await Promise.race([
        started.catch((e: unknown) => ({ error: String((e as Error)?.message ?? e) })),
        late,
      ]).finally(() => clearTimeout(timer));
      if (!wake) void started.then((w) => w && "error" in w && console.warn(`tree add: the wake after ${ids} failed: ${w.error}`), (e: unknown) => console.warn(`tree add: the wake after ${ids} failed: ${String(e)}`));
      return wake ? { wake } : {};
    };
    const { repoDir, rel } = await o.locate(m);
    if (!repoDir || !rel) return err(c, 409, "conflict", "the milestone has no spine file in a checkout: nothing written");
    const target = input.path ?? rel;
    if (target !== rel && !(await o.treePaths(m)).has(target)) return err(c, 400, "validation_error", `${target} is not a spine in this milestone's tree`);
    const date = new Date().toISOString().slice(0, 10);

    const fail = (w: { status: string; reason?: string }) => err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing written: ${w.reason ?? w.status}`);

    // the filing step matches every row of his words itself: an open ticket that holds them gets them, no new row
    let judged: Held | undefined;
    if (input.chat && input.kind === "row" && notJordi(header) && !input.draft && o.held !== null)
      judged = await (o.held ?? ((dir, words) => heldBy(dir, words, o.python)))(repoDir, `${input.title}: ${input.line ?? ""}\n${input.chat}`);
    if (needsMatch && !judged && !MATCH_NEW.test(input.matched ?? "")) return err(c, 409, "match_first", MATCH_FIRST);
    const repoName = path.basename(repoDir);
    if (judged?.held && judged.file?.startsWith(`${repoName}/`)) {
      const ref = judged.held;
      const heldRel = judged.file.slice(repoName.length + 1);
      let readied = false;
      const w = await o.spine.edit({
        repoDir,
        path: heldRel,
        label: "add-placed",
        edit: (text, d) => {
          const p = placeWords(text, ref, { quote: deskQuote(input.chat!), why: judged!.why ?? "", agree: judged!.agree, date: d || date, ready, via: asker.owner ? (asker as { via: string }).via : "the Team desk", ...(asker.owner && (asker as { request?: string }).request ? { request: (asker as { request?: string }).request } : {}) });
          readied = p.readied;
          return {
            text: p.text,
            msg: `Place ${ownerName()}'s words on ${ref}: it already holds them, no new row (via console)`,
            body: `${ref} already wants the same outcome (judges ${judged!.agree ?? "?"}): ${judged!.why ?? ""}\n\nRead at filing: ${(judged!.top ?? []).join(", ")}. ${readied ? `${ref} is ready again on his ask (L-37).` : ""}`,
          };
        },
      });
      if (w.status !== "written") return fail(w);
      o.invalidate(repoDir);
      o.onAdded?.({ repoDir, path: heldRel, kind: "row", id: ref, title: input.title }, (n) => c.req.header(n));
      return c.json({ kind: input.kind, placed: ref, path: heldRel, why: judged.why, ready: readied, ...(w.sha ? { sha: w.sha } : {}), ...(readied ? await after(ref, heldRel) : {}), ...delivery(m.id) }, 200);
    }
    if (judged?.after) input.line = `${input.line ? `${input.line} ` : ""}(follow-up of ${judged.after}, closed)`.slice(0, LINE_MAX);

    if (input.kind === "epic") {
      if (!o.skillDir) return err(c, 409, "conflict", "the EpicSpine skill is not installed here: a child epic cannot be scaffolded");
      const dir = path.posix.dirname(target);
      let created = "";
      const w = await o.spine.scaffold({
        repoDir,
        path: target,
        label: "add-epic",
        msg: `Add ${ready ? "ready" : "draft"} epic “${input.title.slice(0, 80)}” under ${path.posix.basename(target)} (${ready ? `${ownerName()}'s ask, ` : ""}via console)`,
        body: ready
          ? `${label(input)}\n\nAdded from the agent-team console tree: spine_new.py scaffolded a child epic, ready on ${ownerName()}'s ask (L-37, ${(asker as { via: string }).via}), with a Decisions row citing it, and registered it in the Spine Map of ${target}.`
          : `${label(input)}\n\nAdded from the agent-team console tree: spine_new.py scaffolded a draft child epic (Status: draft; ${draftWhy}) and registered it in the Spine Map of ${target}.`,
        scaffold: async (dirAbs) => {
          const slug = slugOf(input.title);
          let n = 1;
          let newRel = path.posix.join(dir, `${slug}.md`);
          while (fs.existsSync(path.join(dirAbs, newRel))) newRel = path.posix.join(dir, `${slug}-${++n}.md`);
          const py = o.python ?? "python3";
          try {
            await exec(py, [path.join(o.skillDir!, "scripts", "spine_new.py"), "--repo", dirAbs, "--parent", target, "--path", newRel, "--title", input.title, "--purpose", input.line || input.title], { timeout: 30_000 });
          } catch (e) {
            const x = e as { stderr?: string; stdout?: string; message: string };
            return { ok: false, error: `spine_new.py failed: ${(x.stderr || x.stdout || x.message).trim().split("\n").slice(-2).join(" ").slice(0, 300)}` };
          }
          if (ready) {
            // the owner's ask is the new epic's ready stamp (Status ready + a Decisions row quoting it).
            const file = path.join(dirAbs, newRel);
            const text = fs.readFileSync(file, "utf8");
            fs.writeFileSync(file, appendDecision(setStatus(text, "ready"), readyDecision(`epic “${cell(input.title)}”`, asker as { via: string; quote?: string; request?: string }, date)));
          }
          try {
            await exec(py, [path.join(o.skillDir!, "scripts", "validate_spine.py"), "--trackable", path.join(dirAbs, newRel)], { timeout: 30_000 });
          } catch (e) {
            const x = e as { stdout?: string; stderr?: string; message: string };
            return { ok: false, error: `the new spine is not trackable: ${(x.stdout || x.stderr || x.message).trim().split("\n").slice(-2).join(" ").slice(0, 300)}` };
          }
          created = newRel;
          return { ok: true, files: [newRel, target] };
        },
      });
      if (w.status !== "written") return fail(w);
      o.invalidate(repoDir);
      o.onAdded?.({ repoDir, path: target, kind: input.kind, newPath: created, title: input.title }, (n) => c.req.header(n));
      return c.json({ kind: input.kind, path: target, newPath: created, ready, ...(draftWhy ? { draftWhy } : {}), ...(w.sha ? { sha: w.sha } : {}), ...(await after(created, target)), ...delivery(m.id) }, 201);
    }

    let id = "";
    let rowId = "";
    const w = await o.spine.edit({
      repoDir,
      path: target,
      label: "add",
      edit: (text, d) => {
        const day = d || date;
        const taken = repoRowIds(repoDir);
        const out = input.kind === "row" ? addLedgerRow(text, input, day, { ready, taken }) : addDoneMeans(text, input);
        if ("skip" in out) return out;
        let next = out.text;
        let row = "";
        if (ready && input.kind === "done_means") {
          // a criterion the owner asks for gets a ready row building it, so the next wake has something to dispatch.
          const r = addLedgerRow(next, input, day, { ready, covers: out.id, taken });
          if ("skip" in r) return { skip: `${out.id} needs a ready row and ${r.skip}` };
          next = r.text;
          row = r.id;
        }
        if (ready) next = appendDecision(next, readyDecision(row ? `${out.id} (row ${row})` : out.id, asker as { via: string; quote?: string; request?: string }, day));
        // A new line must not break the machine-read contract the spine already met.
        if (trackable(o, text) === true && trackable(o, next) === false) return { skip: `the new ${input.kind === "row" ? "row" : "criterion"} would make ${target} fail validate_spine.py --trackable` };
        id = out.id;
        rowId = row;
        const what = input.kind === "row" ? "row" : "Done-means line";
        return {
          text: next,
          msg: ready
            ? `Add ready ${what} ${out.id}${row ? ` + row ${row}` : ""} to ${path.posix.basename(target)} (${ownerName()}'s ask, via console)`
            : `Add draft ${what} ${out.id} to ${path.posix.basename(target)} (via console)`,
          body: ready
            ? `${out.id}: ${label(input)}\n\n${judged ? `Matched at filing: ${judged.after ? `follow-up of closed ${judged.after}` : "new"} (read ${(judged.top ?? []).join(", ") || "none close"}): ${judged.why ?? ""}\n\n` : ""}${input.matched ? `New or existing: ${input.matched}\n\n` : ""}Added from the agent-team console tree, ready on ${ownerName()}'s ask (L-37, ${(asker as { via: string }).via})${row ? `, with ready row ${row} building it` : ""}; a Decisions row cites it; written in the existing format of ${target}.`
            : `${out.id}: ${label(input)}\n\nAdded from the agent-team console tree as a draft (${draftWhy}); written in the existing format of ${target}.`,
        };
      },
    });
    if (w.status !== "written") return fail(w);
    o.invalidate(repoDir);
    o.onAdded?.({ repoDir, path: target, kind: input.kind, ...(id ? { id } : {}), title: input.title }, (n) => c.req.header(n));
    return c.json(
      { kind: input.kind, path: target, ...(id ? { id } : {}), ...(rowId ? { rowId } : {}), ready, ...(draftWhy ? { draftWhy } : {}), ...(w.sha ? { sha: w.sha } : {}), ...(await after(rowId ? `${id} (row ${rowId})` : id, target)), ...delivery(m.id) },
      201,
    );
  });
}
