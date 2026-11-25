import { HIS_WORDS_MAX } from "../hisWords.js";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { memoReadOn, type Store } from "../store.js";
import { isDm } from "../inbox/waiting.js";
import { resolveRepo } from "../adapters/repos.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import { addDecisionRow } from "./followups.js";
import { editRowStatus, reopenCell, TEST_REPO } from "./rows.js";
import { wakeSoon, type RelaunchCycle } from "./review.js";
import { AttachError } from "../desk/attachLimits.js";
import type { Attachments } from "../desk/attachments.js";
import type { DB } from "../db.js";
import { whoPressed } from "../press/mount.js";
import { ownerName } from "../identity.js";
import { readArchiveOf } from "../adapters/spineArchive.js";

/**
 * after a card closes he often wants to add something, or take the
 * press back. Two routes behind the Team home's floating "Saved" note and its Recently closed list:
 *
 * - `POST /closed-cards/comment` (Add a last thought, Add comment): his words on a row or ask he already answered. The
 *   spine first (L-45): one Decisions row in the spine that holds the row or ask, quoting him; the answered line itself
 *   is never rewritten. Then the milestone's Delivery manager is woken with his words, like a new round of feedback:
 *   the comment may change his decision, and the owner decides what it means (a new round, a follow-up, nothing). A
 *   TEST repo's comment wakes nobody. Saved first and written in the background like every card press (press outbox).
 * - `POST /review-items/reopen` (Bring it back after the press landed): a row his press closed (approved, denied, sent
 *   back with feedback) is set back to `review` and the Delivery manager is told to hold what the press started. Inside
 *   the undo window the press itself is taken back instead (`POST /presses/:id/undo`, `/owner-responses/:id/undo`).
 */
export const COMMENT_MAX = HIS_WORDS_MAX;
const SPINE = /^(?!\/)[\w.-]+(?:\/[\w.-]+)*\.md$/;
const REF = /^[A-Za-z][\w.-]{0,60}$/;

const cardIn = z.object({
  kind: z.enum(["review", "ask"]),
  repo: z.string().min(1).max(120),
  path: z.string().min(1).max(300),
  ref: z.string().min(1).max(64),
  title: z.string().max(400).optional(),
  milestoneId: z.string().max(80).optional(),
});
const commentIn = cardIn.extend({ text: z.string().max(COMMENT_MAX), attachments: z.array(z.string()).max(10).optional(), via: z.enum(["text", "voice"]).optional(),
  /** `in_work` = a note on a card he sent back, while its next round is being built (never "after he closed it"). */
  stage: z.enum(["closed", "in_work"]).optional(),
});
const reopenIn = cardIn.extend({ kind: z.literal("review").default("review"), /** the card's id (orders it after the close it undoes) */ id: z.string().max(80).optional() });

export interface AfterCloseOptions {
  /** The press log and the stored answers: what Recently closed lists (operational data; the spine stays the record). */
  db?: DB;
  /** Staging lists TEST repos' cards too (REVIEW_SHOW_TEST_CARDS=1). */
  showTest?: boolean;
  store: Store;
  reposRoot: string;
  writer?: SpineWriter;
  cycle?: RelaunchCycle;
  wrote?: (dir: string) => void;
  who?: () => string;
  attachments?: Pick<Attachments, "cardText">;
}

type Fail = { error: 400 | 404 | 409 | 502 | 503; code: string; message: string };
type Card = z.infer<typeof cardIn>;

/** A milestone's repo (`the code repo` or `the team's code repo`) and a card's checkout name. */
const sameRepo = (a: string, b: string) => a === b || a.split("/").pop() === b.split("/").pop();

/** One line for a table cell: no pipes, no line breaks. */
const cell = (s: string) => s.replace(/\r?\n+/g, " ").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export function createAfterClose(o: AfterCloseOptions) {
  const who = () => o.who?.() ?? ownerName();

  /** The checkout and spine file the card names, checked: inside the repo, a file that holds the ref. */
  function locate(c: Card): { dir: string; abs: string; text: string } | Fail {
    if (!SPINE.test(c.path) || c.path.split("/").includes("..")) return { error: 400, code: "validation_error", message: "path must be a repo-relative .md file" };
    if (!REF.test(c.ref)) return { error: 400, code: "validation_error", message: "ref must be a row or ask code" };
    // the caller's world only: a repo none of its milestones read is not there (the store is the request's world)
    if (!o.store.listMilestones({ includeSettled: true }).some((m) => sameRepo(m.repo, c.repo)))
      return { error: 404, code: "not_found", message: `repo ${c.repo} is not in this world` };
    const dir = resolveRepo(o.reposRoot, c.repo)?.path;
    if (!dir) return { error: 503, code: "repo_missing", message: `repo ${c.repo} is not checked out on the console host; nothing changed` };
    const abs = path.resolve(dir, c.path);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return { error: 400, code: "validation_error", message: "path must stay inside the repo" };
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return { error: 404, code: "not_found", message: `${c.path} is not in ${c.repo}` };
    }
    const bare = c.ref.replace(/^.*\//, "");
    const holds = (t: string | undefined) => !!t && new RegExp(`(^|[^\\w-])${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(t);
    // a finished row moved to the epic's archive is still his card: his comment goes to the epic's Decisions
    if (!holds(text) && !holds(readArchiveOf(abs))) return { error: 404, code: "not_found", message: `${bare} is not in ${c.path} any more` };
    return { dir, abs, text };
  }

  /** The milestone whose Delivery manager owns the card: the one named (same repo), else the spine's, else the repo's. */
  function owner(c: Card): string | undefined {
    const ms = o.store.listMilestones({ includeSettled: true });
    const named = c.milestoneId ? ms.find((m) => m.id === c.milestoneId && sameRepo(m.repo, c.repo)) : undefined;
    const mine = ms.filter((x) => sameRepo(x.repo, c.repo));
    const m = named ?? mine.find((x) => x.path === c.path) ?? mine.find((x) => /root\.md$/.test(x.path ?? "")) ?? mine[0];
    if (!m) return undefined;
    const as = o.store.listAssignments({ milestoneId: m.id });
    return (as.find((a) => isDm(o.store.getPersona(a.personaId)?.name)) ?? as[0])?.id;
  }

  async function wake(c: Card, instructions: string, key: string): Promise<{ woke?: string; wakeError?: string }> {
    if (TEST_REPO.test(c.repo)) return {};
    const target = owner(c);
    if (!target) return { wakeError: "no persona to wake: the milestone has no assignment; the next Delivery manager wake reads the spine" };
    if (!o.cycle) return { wakeError: "the console cycle is off; the next Delivery manager wake reads the spine" };
    try {
      await wakeSoon(o.cycle.runNowRequest(target, { instructions: instructions.slice(0, HIS_WORDS_MAX + 2000), instructionsBy: who() }, key), `comment ${c.ref}`);
      return { woke: target };
    } catch (e) {
      return { wakeError: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }
  }

  async function comment(input: unknown): Promise<Fail | { sha?: string; woke?: string; wakeError?: string }> {
    const p = commentIn.safeParse(input);
    if (!p.success) return { error: 400, code: "validation_error", message: `send kind (review or ask), repo, path, ref and text: ${p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` };
    const c = p.data;
    let words = c.text.trim();
    if (c.attachments?.length) {
      if (!o.attachments) return { error: 400, code: "no_attachments", message: "this console takes no attachments" };
      try {
        words = o.attachments.cardText(words, c.attachments);
      } catch (e) {
        if (e instanceof AttachError) return { error: 400, code: e.code, message: e.message };
        throw e;
      }
    }
    if (!words) return { error: 400, code: "validation_error", message: "a comment needs your words" };
    if (!o.writer) return { error: 503, code: "no_spine_writer", message: "the console cannot write spines here; nothing changed" };
    const at = locate(c);
    if ("error" in at) return at;
    const by = who();
    const ref = c.ref.replace(/^.*\//, "");
    const what = c.kind === "ask" ? `ask ${ref}` : `row ${ref}`;
    // a card he sent back stays on his inbox while it is reworked, and his notes on it reach the round in work
    const inWork = c.stage === "in_work";
    const when = inWork ? "while its next round is in work" : "after he closed it";
    const w = await o.writer.edit({
      repoDir: at.dir,
      path: c.path,
      label: ref,
      group: true,
      fetchFreshMs: 30_000,
      edit: (text, date) => {
        const t = addDecisionRow(text, {
          date,
          outcome: "comment",
          decision: `${by}'s ${inWork ? "note" : "comment"} on ${what} ${when}${c.via === "voice" ? " (voice)" : ""}: "${cell(words).slice(0, 1500)}"`,
          summary: inWork
            ? "more input for the round in work: the worker on the row gets his words now and the round answers them; the card comes back to his review with it"
            : "it may change his decision: the owner reads it and acts on it (a new round, a follow-up row, or a reply); the answered line stays as he left it",
          evidence: inWork ? "console note on a sent-back card" : "console Add comment",
          revisit: "when the owner has acted on it",
        });
        return t === undefined
          ? { skip: `${c.path} has no Decisions table to hold the comment; nothing written` }
          : { text: t, msg: `${ref}: ${by}'s ${inWork ? "note while it is in work" : "comment after closing it"} (via console)`, body: `${by} added a ${inWork ? "note" : "comment"} on ${what} ("${cell(c.title ?? "")}") from the console ${when}:\n\n${words}` };
      },
    });
    if (w.status !== "written") return { error: w.status === "skipped" ? 409 : 502, code: w.status === "skipped" ? "spine_write_skipped" : "spine_write_failed", message: `${w.status === "skipped" ? "not written" : "spine write failed"}: ${w.reason ?? "unknown"}; nothing changed` };
    o.wrote?.(at.dir);
    const woke = await wake(
      c,
      [
        `${by} added a ${inWork ? "note" : "comment"} on ${what}${c.title ? ` ("${cell(c.title)}")` : ""} in ${c.repo} ${c.path} ${when} (written as a Decisions row${w.sha ? ` in commit ${w.sha}` : ""}).`,
        `His words: ${words}`,
        ...(inWork
          ? [`He sent this card back and it is still on his inbox, marked in progress: this is more input for the round being built. Hand his words to the worker on ${ref} now (a running worker: send them to its thread; none running: start the round with them), never open a second row for them, and bring the card back to his review answering every point.`]
          : []),
        ...(inWork ? [] : [`It may change his decision. Read it as a new round of feedback on that ${c.kind === "ask" ? "ask" : "row"}: if he changes his mind, reopen it the EpicSpine way (a new round, a new row, or a corrected answer with a Decisions row); if it adds a follow-up, file it; hand it to the owner persona when it is not you. Never rewrite his answered line silently. Record what you did in the spine.`]),
      ].join("\n\n"),
      `comment:${c.repo}:${ref}:${w.sha ?? Date.now()}`,
    );
    return { ...(w.sha ? { sha: w.sha } : {}), ...woke };
  }

  async function reopen(input: unknown): Promise<Fail | { sha?: string; status: "review"; woke?: string; wakeError?: string }> {
    const p = reopenIn.safeParse(input);
    if (!p.success) return { error: 400, code: "validation_error", message: "send repo, path and ref of the row to bring back" };
    const c = p.data;
    if (!o.writer) return { error: 503, code: "no_spine_writer", message: "the console cannot write spines here; nothing changed" };
    const at = locate(c);
    if ("error" in at) return at;
    const by = who();
    let was = "";
    const w = await o.writer.edit({
      repoDir: at.dir,
      path: c.path,
      label: c.ref,
      group: true,
      fetchFreshMs: 30_000,
      edit: (text) => {
        const e = editRowStatus(text, c.ref, reopenCell(c.ref, by));
        if ("skip" in e) return e;
        was = e.status;
        return { text: e.text, msg: `Review ${c.ref}: brought back to review (${by}, via console)`, body: `${by} pressed Bring it back on "${cell(c.title ?? c.ref)}": row ${c.ref} in ${c.path} is in review again (it read "${cell(e.status)}").` };
      },
    });
    if (w.status !== "written") return { error: w.status === "skipped" ? 409 : 502, code: w.status === "skipped" ? "spine_write_skipped" : "spine_write_failed", message: `${w.status === "skipped" ? "not written" : "spine write failed"}: ${w.reason ?? "unknown"}; nothing changed` };
    o.wrote?.(at.dir);
    const woke = await wake(
      c,
      `${by} pressed Bring it back on ${c.ref}${c.title ? ` ("${cell(c.title)}")` : ""} in ${c.repo} ${c.path} just after closing it: the row is \`review\` again (it read "${cell(was)}"${w.sha ? `, commit ${w.sha}` : ""}). Hold anything his close started for it (a run on its feedback, follow-up rows it made ready): leave them as they are, never start them, and tell the Team desk what is held. His card is back in his inbox; he decides again there.`,
      `reopen:${c.repo}:${c.ref}:${w.sha ?? Date.now()}`,
    );
    return { status: "review", ...(w.sha ? { sha: w.sha } : {}), ...woke };
  }

  /**
   * Recently closed (Team home): the cards the owner closed in the last `days` (30 by default: he can always find a card he closed), newest first, one line each, from the press
   * log (a press that landed: its route's answer names the row) and the answers it carried (the ask). Undone and failed
   * presses are not closed cards; the daily press test's and TEST repos' are left out (staging shows TEST ones).
   */
  function recent(o2: { days?: number; limit?: number; world?: string; /** only TEST repos' cards (proofs; never on a list) */ test?: boolean } = {}): ClosedCard[] {
    if (!o.db) return [];
    // the deck and the inbox poll this; it is kept until a press or an answer changes (store.ts memoReadOn) instead of
    // re-read and re-parsed each poll
    return memoReadOn(o.db, ["presses", "jordi_responses"], `closed-cards\0${JSON.stringify([o2.days, o2.limit, o2.world, o2.test])}`, () => readRecent(o.db!, o2));
  }
  function readRecent(db: DB, o2: { days?: number; limit?: number; world?: string; test?: boolean }): ClosedCard[] {
    const since = new Date(Date.now() - Math.min(Math.max(o2.days ?? 30, 1), 90) * 86_400_000).toISOString();
    type P = { id: string; at: string; action: string; target: string; who: string; via: string | null; ref: string | null; response: string | null; request: string | null; tenant_id: string | null; landed_at: string | null };
    const rows = db
      .prepare(
        "SELECT id, at, action, target, who, via, ref, response, request, tenant_id, landed_at FROM presses WHERE state = 'landed' AND at >= ? AND (action IN ('review approve', 'review complete', 'review deny', 'review feedback') OR action LIKE 'ask %' OR action LIKE '% comment') ORDER BY at DESC LIMIT 3000",
      )
      .all(since) as P[];
    const mine = rows.filter((r) => (!o2.world || !r.tenant_id || r.tenant_id === o2.world) && r.via !== "press-test" && !/press test/i.test(r.who));
    const comments = new Map<string, number>();
    for (const r of mine) if (r.action.endsWith(" comment")) comments.set(r.target, (comments.get(r.target) ?? 0) + 1);
    const answer = db.prepare("SELECT kind, text, item FROM jordi_responses WHERE id = ?");
    const out = new Map<string, ClosedCard>();
    const json = (s: string | null): Record<string, unknown> | undefined => {
      try {
        const v = s ? (JSON.parse(s) as unknown) : undefined;
        return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    for (const r of mine) {
      if (r.action.endsWith(" comment") || r.action === "ask key" || r.action === "ask snooze" || r.action === "ask unsnooze" || r.action === "ask undo") continue;
      let card: ClosedCard | undefined;
      if (r.action.startsWith("review ")) {
        const it = json(r.response);
        const repo = str(it?.repo), p = str(it?.path), ref = str(it?.ref);
        if (!repo || !p || !ref) continue;
        const face = it?.face as { title?: string } | undefined;
        const what = r.action.slice(7);
        card = { key: `review:${repo}:${p}#${ref}`, kind: "review", repo, path: p, ref, title: str(face?.title) ?? str(it?.title) ?? ref, outcome: what === "deny" ? "declined" : what === "feedback" ? "changes" : "approved", at: r.landed_at ?? r.at, ...(str(it?.milestoneId) ? { milestoneId: str(it?.milestoneId) } : {}), ...(what === "feedback" && pressWords(r.request) ? { words: pressWords(r.request) } : {}), comments: comments.get(`${repo}:${ref}`) ?? 0 };
      } else if (r.ref) {
        const a = answer.get(r.ref) as { kind: string; text: string; item: string } | undefined;
        const it = json(a?.item ?? null);
        const repo = str(it?.repo), p = str(it?.path), ref = str(it?.code);
        if (!a || !repo || !p || !ref) continue;
        card = {
          key: `ask:${repo}:${p}#${ref}`,
          kind: "ask",
          repo,
          path: p,
          ref,
          title: str(it?.question) ?? str(it?.title) ?? ref,
          outcome: a.kind === "approve" ? "approved" : a.kind === "deny" ? "declined" : a.kind === "feedback" ? "changes" : "answered",
          ...(a.kind === "answer" && a.text ? { answer: a.text.slice(0, 300) } : {}),
          at: r.landed_at ?? r.at,
          ...(str(it?.milestoneId) ? { milestoneId: str(it?.milestoneId) } : {}),
          responseId: r.ref,
          comments: comments.get(`${repo}:${ref}`) ?? 0,
        };
      }
      if (!card || out.has(card.key)) continue;
      if (o2.test ? !TEST_REPO.test(card.repo) : !o.showTest && TEST_REPO.test(card.repo)) continue;
      out.set(card.key, card);
      if (out.size >= Math.min(o2.limit ?? 200, 500)) break;
    }
    return [...out.values()];
  }

  /**
   * flag a row to its owner now (the milestone's Delivery manager is woken with `text`), the same way a
   * comment wakes it. Who was woken, or why nobody was.
   */
  async function flagRow(c: Card, text: string, key: string): Promise<string> {
    const r = await wake(c, text, key);
    return r.woke ?? `nobody (${r.wakeError ?? "no wake"})`;
  }

  return { comment, reopen, recent, flagRow };
}

/** one closed card on Team home's Recently closed list (Add comment files to its row or ask). */
/** his words in a press's stored request (`{ body: { feedback } }`, the body as an object or as JSON text). */
export function pressWords(request: string | null | undefined): string | undefined {
  try {
    const q = request ? (JSON.parse(request) as { body?: unknown }) : undefined;
    const b = typeof q?.body === "string" ? (JSON.parse(q.body) as unknown) : q?.body;
    const f = b && typeof b === "object" ? (b as { feedback?: unknown }).feedback : undefined;
    return typeof f === "string" && f.trim() ? f.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface ClosedCard {
  key: string;
  kind: "review" | "ask";
  repo: string;
  path: string;
  ref: string;
  title: string;
  outcome: "approved" | "declined" | "changes" | "answered";
  answer?: string;
  at: string;
  milestoneId?: string;
  responseId?: string;
  /** his own words on a Change it press, whole (the press's request body): what a reopened or picked-up round is briefed with. */
  words?: string;
  /** Comments he added since (Add comment presses that landed). */
  comments: number;
}

export type AfterClose = ReturnType<typeof createAfterClose>;

export function mountAfterClose(api: Hono, a: AfterClose) {
  const send = async (c: import("hono").Context, r: Promise<Fail | object>) => {
    const out = await r;
    if ("error" in out && typeof (out as Fail).error === "number") {
      const f = out as Fail;
      return c.json({ error: { code: f.code, message: f.message } }, f.error);
    }
    return c.json(out);
  };
  api.get("/closed-cards", (c) => {
    const days = Number(c.req.query("days") ?? 30) || 30;
    const limit = Number(c.req.query("limit") ?? 200) || 200;
    // ?state=test: only TEST repos' closed cards (a proof reads them; the Team home never asks for them)
    return c.json(a.recent({ days, limit, world: whoPressed().tenant, test: c.req.query("state") === "test" }));
  });
  api.post("/closed-cards/comment", async (c) => send(c, a.comment(await c.req.json().catch(() => undefined))));
  api.post("/review-items/reopen", async (c) => send(c, a.reopen(await c.req.json().catch(() => undefined))));
}
