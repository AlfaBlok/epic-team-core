import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import type { JobRoute } from "../plug/hooks.js";
import { DeskError, TAIL_MESSAGES, type DeskMessage, type DeskView, type EarlierPage, type ViewOpts } from "./session.js";

/**
 * the chat of a customer workspace whose jobs run on
 * its own job servers (cycle/jobRoute.ts handles it). Never a T3 thread on our seats: the console keeps the chat's lines in
 * its own table, and each turn is one short job on a job server of the workspace (box/job_dispatch.py --mode chat): its
 * vault's AI key answers, with the desk's seed and the chat so far as the prompt, and the agent's final text is the reply.
 * The server stays warm 15 minutes after a turn (the job sweep), so a conversation reuses it.
 *
 * One turn at a time per chat: messages sent during a turn are answered together by the next one. A turn that fails says so
 * on the chat (sendError) and is not retried by itself; the owner's next message starts a turn that answers everything
 * still unanswered. A console restart mid-turn loses that turn (the job is the console's child): the chat says so.
 */
export const JOB_CHAT_HISTORY = 40;
const HISTORY_CHARS = 30_000;
const REPLY_MAX = 20_000;
const WAITING_CHARS = 20_000;
const LINE_CHARS = 4_000;
/** no answer this long after his last line, nothing running: the chat says the reply was lost. */
const LOST_AFTER_MS = 90_000;

export function ensureJobChat(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS job_chat_messages (
    id TEXT PRIMARY KEY,
    chat_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    page TEXT,
    crid TEXT,
    answers INTEGER,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS job_chat_messages_key ON job_chat_messages (chat_key, seq);`);
}

interface Row {
  id: string;
  chat_key: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  page: string | null;
  crid: string | null;
  /** a reply: the seq of the owner's last line it answered. */
  answers: number | null;
  at: string;
}

/** turns in flight and the last failure, per chat key (one console process). */
const running = new Map<string, { since: string; turnId: string }>();
const failed = new Map<string, { text: string; at: string; clientRequestId?: string }>();

export interface JobChatProfile {
  /** the chat's key (`world-desk:<world>`, `milestone:<id>`): its lines in job_chat_messages. */
  key: string;
  world: string;
  /** the persona whose token the turn's agent carries (the desk persona). */
  personaId: () => string;
  /** the desk's seed as its agent reads it on the job server (API calls through the job's gateway). */
  seed: () => string | Promise<string>;
  /** tests: the clock. */
  now?: () => Date;
}

export function createJobChat(db: DB, route: JobRoute, p: JobChatProfile) {
  ensureJobChat(db);
  const now = () => (p.now ? p.now() : new Date());
  const rows = (limit: number, before?: number): Row[] =>
    (before === undefined
      ? (db.prepare("SELECT * FROM job_chat_messages WHERE chat_key = ? ORDER BY seq DESC LIMIT ?").all(p.key, limit) as Row[])
      : (db.prepare("SELECT * FROM job_chat_messages WHERE chat_key = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(p.key, before, limit) as Row[])
    ).reverse();
  const nextSeq = () => ((db.prepare("SELECT MAX(seq) AS s FROM job_chat_messages WHERE chat_key = ?").get(p.key) as { s: number | null }).s ?? 0) + 1;
  const insert = (role: Row["role"], text: string, o: { page?: string; crid?: string; answers?: number } = {}) =>
    db
      .prepare("INSERT INTO job_chat_messages (id, chat_key, seq, role, text, page, crid, answers, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`jc_${randomUUID().slice(0, 12)}`, p.key, nextSeq(), role, text, o.page ?? null, o.crid ?? null, o.answers ?? null, now().toISOString());
  const present = (r: Row): DeskMessage => ({ id: r.id, role: r.role, kind: "message", text: r.text, ...(r.page ? { page: r.page } : {}), status: "completed", at: r.at, position: r.seq });
  /** his lines after the last reply (what the next turn answers). */
  const unanswered = (): Row[] => {
    const last = db.prepare("SELECT MAX(answers) AS s FROM job_chat_messages WHERE chat_key = ? AND role = 'assistant'").get(p.key) as { s: number | null };
    return db.prepare("SELECT * FROM job_chat_messages WHERE chat_key = ? AND role = 'user' AND seq > ? ORDER BY seq").all(p.key, last.s ?? 0) as Row[];
  };

  async function prompt(upto: number, waiting: Row[]): Promise<string> {
    const seed = String(await p.seed())
      .replace(/\n*Reply to this message with one line: `[^`]*`\.?\s*$/, "")
      .trim();
    const hist: string[] = [];
    let size = 0;
    for (const r of rows(JOB_CHAT_HISTORY, upto + 1).reverse()) {
      const line = `[${r.role === "user" ? "owner" : "you"} · ${r.at.slice(0, 16).replace("T", " ")}Z${r.page ? ` · page: ${r.page}` : ""}]\n${r.text.length > LINE_CHARS ? `${r.text.slice(0, LINE_CHARS)}…` : r.text}`;
      if (size + line.length > HISTORY_CHARS && hist.length) break;
      hist.unshift(line);
      size += line.length;
    }
    return [
      seed,
      "",
      "## How this chat runs",
      "This chat runs on the workspace's own server with its own AI. Each turn you get the chat so far, below, and answer the owner's newest message (or messages, when several wait). " +
        "Act with the console calls above when they ask for it. Your final text is exactly what the owner reads in the chat: short, plain words, no tool logs, no preamble.",
      "",
      "## The chat so far (oldest first)",
      hist.join("\n\n"),
      "",
      `## Waiting for your answer now (${waiting.length === 1 ? "the owner's newest line" : `the owner's ${waiting.length} newest lines`})`,
      // the newest of what waits, capped (lines left by failed turns pile up here)
      (() => {
        const all = waiting.map((r) => r.text).join("\n\n");
        return all.length > WAITING_CHARS ? `…${all.slice(-WAITING_CHARS)}` : all;
      })(),
    ].join("\n");
  }

  function kick(): void {
    if (running.has(p.key) || !route.chat) return;
    const waiting = unanswered();
    if (!waiting.length) return;
    const turnId = `chat-${now().getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    running.set(p.key, { since: now().toISOString(), turnId });
    failed.delete(p.key);
    const crid = waiting.at(-1)!.crid ?? undefined;
    const upto = waiting.at(-1)!.seq;
    const shown = nextSeq() - 1;
    void (async () => {
      let again = false;
      try {
        const end = await route.chat!({ turnId, world: p.world, personaId: p.personaId(), prompt: await prompt(shown, waiting) });
        const reply = (end.reply ?? "").trim();
        if (end.ok && reply) {
          insert("assistant", reply.length > REPLY_MAX ? `${reply.slice(0, REPLY_MAX)}…` : reply, { answers: upto });
          again = true;
        } else {
          const why = end.ok ? "the team gave no answer" : `the workspace's server said ${end.result}${end.detail ? `: ${end.detail}` : ""}`;
          failed.set(p.key, { text: `No reply: ${why}. Send your message again.`.slice(0, 400), at: now().toISOString(), ...(crid ? { clientRequestId: crid } : {}) });
        }
      } catch (e) {
        failed.set(p.key, { text: `No reply: ${(e as Error)?.message ?? String(e)}. Send your message again.`.slice(0, 400), at: now().toISOString(), ...(crid ? { clientRequestId: crid } : {}) });
      } finally {
        running.delete(p.key);
      }
      // what he wrote during this turn gets the next one
      if (again) kick();
    })().catch((e) => console.warn(`job chat ${p.key}: ${(e as Error)?.message ?? e}`));
  }

  function lost(): DeskView["sendError"] | undefined {
    if (running.has(p.key)) return undefined;
    const f = failed.get(p.key);
    if (f) return f;
    const last = rows(1)[0];
    if (last?.role === "user" && unanswered().length && now().getTime() - Date.parse(last.at) > LOST_AFTER_MS)
      return { text: "No reply came (the console restarted during the turn). Send your message again.", at: last.at, ...(last.crid ? { clientRequestId: last.crid } : {}) };
    return undefined;
  }

  return {
    ownServer: true as const,
    async view(o: ViewOpts = {}): Promise<DeskView & { customer: true; ownServer: true }> {
      const limit = Math.max(1, Math.min(TAIL_MESSAGES, Math.floor(o.limit ?? TAIL_MESSAGES)));
      const list = rows(limit + 1);
      const more = list.length > limit;
      const turn = running.get(p.key);
      const err = lost();
      return {
        available: true,
        working: !!turn,
        ...(turn ? { workingSince: turn.since } : {}),
        sending: 0,
        ...(err ? { sendError: err } : {}),
        messages: (more ? list.slice(1) : list).map(present),
        hasEarlier: more,
        customer: true,
        ownServer: true,
      };
    },
    async earlier(before: number, limit = 30): Promise<EarlierPage> {
      const n = Math.max(1, Math.min(TAIL_MESSAGES, Math.floor(limit)));
      const list = rows(n + 1, before);
      const more = list.length > n;
      return { messages: (more ? list.slice(1) : list).map(present), hasEarlier: more };
    },
    async send(text: string, page?: string, clientRequestId?: string): Promise<{ threadId: string; pending: boolean }> {
      const body = text.trim();
      if (!body) throw new DeskError(400, "empty_message", "message is required");
      if (!route.chat) throw new DeskError(409, "world_needs_box", "Your team's chat is not open on this console yet.");
      const dup = clientRequestId ? db.prepare("SELECT 1 FROM job_chat_messages WHERE chat_key = ? AND crid = ?").get(p.key, clientRequestId) : undefined;
      if (!dup) insert("user", body, { page, crid: clientRequestId });
      kick();
      return { threadId: p.key, pending: true };
    },
    async jordiMessages(): Promise<{ text: string; at?: string; position: number }[]> {
      return (db.prepare("SELECT * FROM job_chat_messages WHERE chat_key = ? AND role = 'user' ORDER BY seq").all(p.key) as Row[]).map((r) => ({ text: r.text, at: r.at, position: r.seq }));
    },
  };
}
export type JobChat = ReturnType<typeof createJobChat>;

/** tests: forget turns in flight. */
export const resetJobChatState = () => {
  running.clear();
  failed.clear();
};
