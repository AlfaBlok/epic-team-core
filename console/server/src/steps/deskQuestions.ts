import { HIS_WORDS_MAX } from "../hisWords.js";
import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { currentAuth } from "../auth/identity.js";
import { ownerName } from "../identity.js";
import type { StepPage, WakeAnswer } from "./steps.js";

/**
 * a Mac agent asks the Team desk mid-ticket and goes on with the answer.
 *
 * A Mac ticket (scripts/laptop_ticket.py) has a steps page whose token already sends its Done or Stuck report. With the
 * same token (no new credential on the Mac) the agent posts a question:
 *   POST /api/public/steps/<token>/questions {question, row?}  → {question: {id, state: "open", …}, poll: <url>}
 * it lands as one Team desk line naming the ticket and its row and wakes the Delivery manager of the milestone that
 * holds the ticket's spine (as a stuck step does). The persona answers with one call:
 *   POST /api/steps/questions/<id>/answer {answer}            (console auth: an agent's or the owner's)
 * and the Mac agent polls GET /api/public/steps/<token>/questions/<id> (every 15 s, up to 20 min), reads the answer and
 * goes on: the ticket stays open, never marked stuck. A wake that did not start a run is tried again by the next poll
 * (at most every WAKE_RETRY_MS), and every Delivery manager wake lists the questions still open (deskQuestionsSection),
 * so an answer is never forgotten. Decisions an answer makes go into the spine by the persona that answers (L-45).
 */

export const QUESTION_MAX = 1_200;
export const ANSWER_MAX = HIS_WORDS_MAX;
/** open questions one page may hold at once (a loop that asks again and again is refused). */
export const OPEN_PER_PAGE = 3;
/** questions one page may ask in a day. */
export const PER_PAGE_DAY = 20;
/** a poll on an open question whose wake made no run tries the wake again after this long. */
export const WAKE_RETRY_MS = 3 * 60_000;
/** the poll pace the ticket asks for; the GET answers it so the agent never guesses. */
export const POLL_EVERY_S = 15;
export const POLL_FOR_MIN = 20;

const ID = /^q_[a-f0-9]{12}$/;
const ROW = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;

export type QuestionState = "open" | "answered";
export interface DeskQuestion {
  id: string;
  pageId: string;
  page: { title: string; url: string; repo: string; spine: string };
  row?: string;
  question: string;
  state: QuestionState;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
  answeredBy?: string;
  milestoneId?: string;
  wake: "none" | "woken" | "waiting";
  wakeRun?: string;
  wakeError?: string;
  wakeAt?: string;
}

export class QuestionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DeskQuestionDeps {
  db: DB;
  byToken: (token: string) => StepPage | undefined;
  /** The milestone whose tree holds the spine (its Delivery manager answers). */
  milestoneFor: (repo: string, spine: string) => Promise<string | undefined>;
  wake?: (milestoneId: string, note: string) => Promise<WakeAnswer>;
  /** One line into the world's Team desk chat. */
  tell?: (world: string, text: string, id: string) => Promise<true | string>;
  /** the console's base for the answer call the wake note names (default the local console). */
  base?: string;
  now?: () => number;
}

export function ensureDeskQuestions(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS step_questions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      row_code TEXT,
      question TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      asked_at TEXT NOT NULL,
      answer TEXT,
      answered_at TEXT,
      answered_by TEXT,
      milestone_id TEXT,
      wake TEXT NOT NULL DEFAULT 'none',
      wake_run TEXT,
      wake_error TEXT,
      wake_at TEXT
    );
    CREATE INDEX IF NOT EXISTS step_questions_page ON step_questions (page_id, state);
    CREATE INDEX IF NOT EXISTS step_questions_open ON step_questions (state, milestone_id);
  `);
}

/** one line, no double quote, at most `max` characters (the desk line and the wake note carry it whole). */
const clean = (s: string, max: number) => s.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, max);

/** the wake note: who asks, what, and the one call that answers. */
export function questionNote(q: DeskQuestion, base: string): string {
  const where = `${q.page.title} (${q.page.url}${q.row ? `, row ${q.row}` : ""}, spine ${q.page.repo} ${q.page.spine})`;
  return (
    `A Mac agent working ${where} ASKS THE TEAM DESK and is waiting for your answer (it polls for ${POLL_FOR_MIN} min, the ticket stays open): "${q.question}" ` +
    `Answer it now, in plain words it can act on (what to do next on the Mac, or that it should skip that part and say so in its report), with one call: ` +
    `\`curl -sS -X POST ${base}/api/steps/questions/${q.id}/answer -H 'content-type: application/json' -d '{"answer":"<your answer>"}'\`. ` +
    `If the answer needs ${ownerName()}, say in it what the agent should ask him on the Mac. Record any decision the answer makes in ${q.row ? `row ${q.row}` : "the spine"} (L-45).`
  );
}

/** the one Team desk line per question. */
export function questionDeskLine(q: DeskQuestion, woke: string): string {
  return `❓ Mac ticket question on ${q.page.title}${q.row ? ` (row ${q.row})` : ""}: "${q.question}" — ${woke}. Answer: POST /api/steps/questions/${q.id}/answer (question ${q.id}).`;
}

/** every Delivery manager wake lists the questions still open in its tree, like stuck steps. */
export function deskQuestionsSection(open: DeskQuestion[], base: string, now = Date.now()): string | undefined {
  if (!open.length) return undefined;
  const age = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return [
    `## Mac ticket questions waiting for an answer (${open.length})`,
    "A Mac agent asked the Team desk mid-ticket and is waiting (it polls the answer; its ticket stays open). Answer each one first in this wake, " +
      `with one call each: \`curl -sS -X POST ${base}/api/steps/questions/<id>/answer -H 'content-type: application/json' -d '{"answer":"<plain words it can act on>"}'\`.`,
    ...open.map((q) => `- ${q.id} · ${q.page.title}${q.row ? ` · row ${q.row}` : ""} · asked ${age(q.askedAt)} min ago: "${q.question}"`),
  ].join("\n");
}

export function createDeskQuestions(d: DeskQuestionDeps) {
  ensureDeskQuestions(d.db);
  const now = d.now ?? Date.now;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const base = d.base ?? "http://127.0.0.1:18750";
  const pageOf = (id: string) => d.db.prepare("SELECT * FROM step_pages WHERE id = ?").get(id) as Record<string, string> | undefined;

  const of = (r: Record<string, string | null>): DeskQuestion => {
    const p = pageOf(r.page_id!) ?? ({} as Record<string, string>);
    return {
      id: r.id!,
      pageId: r.page_id!,
      page: { title: p.title ?? "", url: p.url ?? "", repo: p.repo ?? "", spine: p.spine ?? "" },
      ...(r.row_code ? { row: r.row_code } : {}),
      question: r.question!,
      state: r.state as QuestionState,
      askedAt: r.asked_at!,
      ...(r.answer ? { answer: r.answer } : {}),
      ...(r.answered_at ? { answeredAt: r.answered_at } : {}),
      ...(r.answered_by ? { answeredBy: r.answered_by } : {}),
      ...(r.milestone_id ? { milestoneId: r.milestone_id } : {}),
      wake: r.wake as DeskQuestion["wake"],
      ...(r.wake_run ? { wakeRun: r.wake_run } : {}),
      ...(r.wake_error ? { wakeError: r.wake_error } : {}),
      ...(r.wake_at ? { wakeAt: r.wake_at } : {}),
    };
  };
  const get = (id: string) => {
    const r = d.db.prepare("SELECT * FROM step_questions WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    return r && of(r);
  };
  const set = (id: string, f: Record<string, string | null>) => {
    if (!d.db.open) return;
    const keys = Object.keys(f);
    d.db.prepare(`UPDATE step_questions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
  };

  /** one wake try: a run that started, or the reason none did (the next poll and the next wake carry it). */
  async function wakeFor(q: DeskQuestion): Promise<string> {
    if (!q.milestoneId) return "nobody to wake: no milestone holds this spine; the desk answers";
    if (!d.wake) return "wakes are off on this console; the desk answers";
    const a = await d.wake(q.milestoneId, questionNote(q, base)).catch((e: Error) => ({ error: e.message }));
    if (a && "runId" in a) {
      set(q.id, { wake: "woken", wake_run: a.runId, wake_error: null, wake_at: iso() });
      return `the Delivery manager was woken (run ${a.runId})`;
    }
    const why = a ? a.error : "no Delivery manager is switched on";
    set(q.id, { wake: "waiting", wake_error: why, wake_at: iso() });
    return `the wake is waiting (${why}): the next poll tries again and the next Delivery manager wake lists it`;
  }

  async function ask(p: StepPage, body: unknown): Promise<{ question: DeskQuestion; poll: string; pollEverySeconds: number; pollForMinutes: number; woke: string }> {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const words = typeof b.question === "string" ? clean(b.question, QUESTION_MAX) : "";
    if (words.length < 3) throw new QuestionError(400, "validation_error", "question must say what you need to know (plain words)");
    const row = typeof b.row === "string" && b.row.trim() ? b.row.trim() : undefined;
    if (row && !ROW.test(row)) throw new QuestionError(400, "validation_error", "row must be a row code like E907-S3");
    const open = (d.db.prepare("SELECT COUNT(*) AS n FROM step_questions WHERE page_id = ? AND state = 'open'").get(p.id) as { n: number }).n;
    if (open >= OPEN_PER_PAGE) throw new QuestionError(429, "too_many_open", `this ticket already has ${open} questions waiting: poll them for their answers first`);
    const day = (d.db.prepare("SELECT COUNT(*) AS n FROM step_questions WHERE page_id = ? AND asked_at >= ?").get(p.id, iso(now() - 86_400_000)) as { n: number }).n;
    if (day >= PER_PAGE_DAY) throw new QuestionError(429, "too_many_today", `this ticket asked ${day} questions today: report what is left instead`);
    // the same open question twice (a retried POST) answers the first one
    const same = d.db.prepare("SELECT id FROM step_questions WHERE page_id = ? AND state = 'open' AND question = ?").get(p.id, words) as { id: string } | undefined;
    if (same) {
      const q = get(same.id)!;
      return { question: q, poll: pollPath(p, q.id), pollEverySeconds: POLL_EVERY_S, pollForMinutes: POLL_FOR_MIN, woke: "asked already: poll for the answer" };
    }
    const mid = await d.milestoneFor(p.repo, p.spine).catch(() => undefined);
    const id = `q_${crypto.randomBytes(6).toString("hex")}`;
    d.db
      .prepare("INSERT INTO step_questions (id, page_id, row_code, question, asked_at, milestone_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, p.id, row ?? null, words, iso(), mid ?? null);
    const woke = await wakeFor(get(id)!);
    const q = get(id)!;
    if (d.tell) await d.tell(p.world || DEFAULT_TENANT, questionDeskLine(q, woke), `question-${id}`).catch(() => undefined);
    return { question: q, poll: pollPath(p, id), pollEverySeconds: POLL_EVERY_S, pollForMinutes: POLL_FOR_MIN, woke };
  }

  const pollPath = (p: StepPage, id: string) => `/api/public/steps/${p.token}/questions/${id}`;

  /** the Mac agent's poll: the answer when there is one; an open question whose wake made no run is woken again. */
  async function poll(p: StepPage, id: string): Promise<DeskQuestion> {
    const q = ID.test(id) ? get(id) : undefined;
    if (!q || q.pageId !== p.id) throw new QuestionError(404, "not_found", "this ticket has no such question");
    if (q.state === "open" && q.wake === "waiting" && (!q.wakeAt || now() - Date.parse(q.wakeAt) >= WAKE_RETRY_MS)) {
      set(q.id, { wake_at: iso() }); // claim the retry before the await: two polls never wake twice
      await wakeFor(q);
      return get(id)!;
    }
    return q;
  }

  function answer(id: string, body: unknown, by: string): DeskQuestion {
    const q = ID.test(id) ? get(id) : undefined;
    if (!q) throw new QuestionError(404, "not_found", "no such question");
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const words = typeof b.answer === "string" ? b.answer.trim().slice(0, ANSWER_MAX) : "";
    if (words.length < 2) throw new QuestionError(400, "validation_error", "answer must say what the Mac agent should do (plain words)");
    if (q.state === "answered" && q.answer !== words) throw new QuestionError(409, "answered", `already answered at ${q.answeredAt}: ask a new question for a new answer`);
    if (q.state !== "answered") set(id, { state: "answered", answer: words, answered_at: iso(), answered_by: by });
    const out = get(id)!;
    const p = pageOf(q.pageId);
    if (d.tell && q.state !== "answered")
      void d.tell(p?.world || DEFAULT_TENANT, `✅ Answered ${q.id} on ${q.page.title}${q.row ? ` (row ${q.row})` : ""}: "${clean(words, 300)}" (by ${by}; the Mac agent reads it on its next poll).`, `answer-${id}`).catch(() => undefined);
    return out;
  }

  const listOpen = (milestoneIds?: string[]) => {
    const rows = d.db.prepare("SELECT * FROM step_questions WHERE state = 'open' ORDER BY asked_at").all() as Record<string, string | null>[];
    const all = rows.map(of);
    return milestoneIds ? all.filter((q) => q.milestoneId && milestoneIds.includes(q.milestoneId)) : all;
  };
  const recent = (limit = 50) => (d.db.prepare("SELECT * FROM step_questions ORDER BY asked_at DESC LIMIT ?").all(limit) as Record<string, string | null>[]).map(of);

  return { ask, poll, answer, get, listOpen, recent, byToken: d.byToken, base };
}

export type DeskQuestions = ReturnType<typeof createDeskQuestions>;

const cors = (c: Context) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Vary", "Origin");
};
async function bodyOf(c: Context): Promise<unknown> {
  try {
    return JSON.parse(await c.req.text());
  } catch {
    return undefined;
  }
}

export function mountDeskQuestions(api: Hono, q: DeskQuestions) {
  const fail = (c: Context, e: unknown) => {
    if (e instanceof QuestionError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    throw e;
  };
  const page = (c: Context) => {
    const p = q.byToken(c.req.param("token") ?? "");
    if (!p) throw new QuestionError(404, "not_found", "no ticket page has this token");
    return p;
  };
  const view = (x: DeskQuestion) => ({
    id: x.id,
    state: x.state,
    question: x.question,
    ...(x.row ? { row: x.row } : {}),
    askedAt: x.askedAt,
    ...(x.answer ? { answer: x.answer, answeredAt: x.answeredAt } : {}),
    wake: x.wake,
    ...(x.state === "open" ? { next: `poll again in ${POLL_EVERY_S} s (up to ${POLL_FOR_MIN} min); keep doing the parts that do not depend on this answer` } : { next: "go on with the ticket using this answer" }),
  });

  // the Mac agent, by the ticket page's token (the same credential as its Done or Stuck report): ask, then poll.
  api.post("/public/steps/:token/questions", async (c) => {
    cors(c);
    try {
      const r = await q.ask(page(c), await bodyOf(c));
      return c.json({ question: view(r.question), poll: r.poll, pollEverySeconds: r.pollEverySeconds, pollForMinutes: r.pollForMinutes, woke: r.woke }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });
  api.get("/public/steps/:token/questions/:id", async (c) => {
    cors(c);
    c.header("Cache-Control", "no-store");
    try {
      return c.json({ question: view(await q.poll(page(c), c.req.param("id") ?? "")) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // the team: the questions (open first), and the one answer call.
  api.get("/steps/questions", (c) => c.json({ open: q.listOpen(), recent: q.recent(c.req.query("all") ? 200 : 30) }));
  api.post("/steps/questions/:id/answer", async (c) => {
    try {
      const i = currentAuth()?.identity;
      const by = i?.kind === "session" ? ownerName() : i?.kind === "token" ? "an agent" : "the team";
      return c.json({ question: q.answer(c.req.param("id") ?? "", await bodyOf(c), by) });
    } catch (e) {
      return fail(c, e);
    }
  });
}
