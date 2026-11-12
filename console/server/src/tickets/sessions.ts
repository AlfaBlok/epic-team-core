import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import type { Milestone, Store } from "../store.js";
import { backlogFor, type Ticket } from "../adapters/milestone.js";
import { stripInline } from "../adapters/markdown.js";
import { statusWordOf } from "../adapters/tree.js";

/**
 * ticket sessions. Detail about one ledger row moves out of the Team desk chat into that row's own T3 thread, run by
 * the row's assignee persona in chat mode (a discussion with the owner, not a wake). One thread per (repo, spine path, row id),
 * launched on demand, stored here, reused on return, archived (no longer offered) once the row closes. The transcript is the
 * T3 thread; the console only records which thread belongs to which row (like `desk_session`).
 * no new session is launched; Discuss opens the milestone's Chat tab about the row. Stored sessions stay readable.
 */

export class TicketSessionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function migrateTicketSessions(db: DB) {
  // Side table (like desk_session): the live session of a row has archived_at NULL; at most one per row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_session (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      spine_path TEXT NOT NULL,
      row_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT,
      persona_id TEXT NOT NULL,
      persona_name TEXT NOT NULL,
      fell_back INTEGER NOT NULL DEFAULT 0,
      seat TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      archive_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_session_live ON ticket_session (repo, spine_path, row_key) WHERE archived_at IS NULL;
  `);
}

export interface TicketSession {
  seq: number;
  milestoneId: string;
  repo: string;
  /** Repo-relative spine whose ledger holds the row. */
  path: string;
  rowId: string;
  threadId: string;
  projectId?: string;
  personaId: string;
  personaName: string;
  /** The row names no persona of its own: the epic's Delivery manager runs it. */
  fellBack: boolean;
  seat?: string;
  createdAt: string;
  archivedAt?: string;
  archiveReason?: string;
}

/** What POST /api/tickets/session and GET /api/tickets/sessions return per row. */
export interface TicketSessionView {
  milestoneId: string;
  rowId: string;
  title?: string;
  path: string;
  threadId: string;
  environmentId?: string;
  /** t3code://threads/<environment>/<thread> when the environment is known, else null (the id alone then opens in T3). */
  link: string | null;
  persona: { id: string; name: string };
  fellBack: boolean;
  /** Always false since (no launch); true on sessions launched before, when they were first opened. */
  launched: boolean;
}

/** POST /api/tickets/session since: the milestone chat about the row, plus the row's earlier session if it has one. */
export type TicketOpenView = (TicketSessionView | (Pick<TicketSessionView, "milestoneId" | "rowId" | "title" | "path"> & { launched: false; link: string })) & {
  /** This milestone's Chat tab about the row. */
  chat: string;
  /** The page hint that chat sends: `<milestone> · <row id>`. */
  page: string;
};

export interface TicketSessionDeps {
  db: DB;
  store: Store;
  /** Console base URL (CONSOLE_PUBLIC_URL): the milestone chat links point here. */
  publicUrl: string;
  reposRoot: string;
  /** The milestone's checkout and its spine's repo-relative path. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string }>;
  /** Repo-relative spine paths in the milestone's tree (a row may live in a child epic). */
  treePaths: (m: Milestone) => Promise<Set<string>>;
  environmentId?: () => string | undefined;
  now?: () => number;
}

const rowTo = (r: any): TicketSession => ({
  seq: r.seq,
  milestoneId: r.milestone_id,
  repo: r.repo,
  path: r.spine_path,
  rowId: r.row_id,
  threadId: r.thread_id,
  projectId: r.project_id ?? undefined,
  personaId: r.persona_id,
  personaName: r.persona_name,
  fellBack: !!r.fell_back,
  seat: r.seat ?? undefined,
  createdAt: r.created_at,
  archivedAt: r.archived_at ?? undefined,
  archiveReason: r.archive_reason ?? undefined,
});

const keyOf = (id: string) => stripInline(id).trim().toLowerCase();
const raw = (t: Pick<Ticket, "status" | "statusDetail">) => stripInline(t.statusDetail ?? t.status);

/** A row that is finished (done/merged/superseded/cancelled, or `deployed`): no ticket session is offered for it. */
export function rowClosed(t: Pick<Ticket, "status" | "statusDetail">): boolean {
  const text = raw(t);
  if (/^\W*deployed\b/i.test(text)) return true;
  const w = statusWordOf(text);
  return w === "done" || w === "superseded";
}

/**
 * this milestone's Chat tab about one item (the web's `milestoneChatHref`): `about` = the row id, `title` its title. The
 * page shows the chip "About <id> · <title>" and sends the hint `[page: <milestone> · <id>]` with the owner's next message.
 */
export function milestoneChatUrl(publicUrl: string, milestoneId: string, about: string, title?: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/milestones/${encodeURIComponent(milestoneId)}?${new URLSearchParams({ tab: "chat", about, ...(title ? { title } : {}) })}`;
}

export function createTicketSessions(d: TicketSessionDeps) {
  const now = d.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  const live = (repo: string, p: string, id: string): TicketSession | undefined => {
    const r = d.db.prepare("SELECT * FROM ticket_session WHERE repo = ? AND spine_path = ? AND row_key = ? AND archived_at IS NULL").get(repo, p, keyOf(id));
    return r ? rowTo(r) : undefined;
  };
  const archive = (s: TicketSession, reason: string) => {
    d.db.prepare("UPDATE ticket_session SET archived_at = ?, archive_reason = ? WHERE seq = ? AND archived_at IS NULL").run(iso(), reason, s.seq);
  };

  /** The ledger row `rowId` of a spine in the milestone's tree (`hint` names the spine; else the one whose ledger has it). */
  async function findRow(m: Milestone, rowId: string, hint?: string): Promise<{ row: Ticket; path: string; repoDir: string }> {
    const { repoDir, rel } = await d.locate(m);
    if (!repoDir || !rel) throw new TicketSessionError(409, "conflict", "the milestone has no spine file in a checkout");
    let paths: string[];
    if (hint) {
      if (hint !== rel && !(await d.treePaths(m)).has(hint)) throw new TicketSessionError(400, "validation_error", `${hint} is not a spine in this milestone's tree`);
      paths = [hint];
    } else paths = [rel, ...[...(await d.treePaths(m))].filter((p) => p !== rel)];
    const hits: { row: Ticket; path: string }[] = [];
    for (const p of paths) {
      const rows = backlogFor(d.reposRoot, { id: m.id, repo: m.repo, path: p, paused: false });
      const row = rows.find((t) => keyOf(t.id) === keyOf(rowId));
      if (row) hits.push({ row, path: p });
    }
    if (!hits.length) throw new TicketSessionError(404, "not_found", `no ledger row ${rowId} in ${m.title}'s spines`);
    if (hits.length > 1) throw new TicketSessionError(409, "ambiguous_row", `row ${rowId} is in several spines (${hits.map((h) => h.path).join(", ")}): send path`);
    return { ...hits[0], repoDir };
  }

  const view = (s: TicketSession, row: Ticket | undefined, launched: boolean): TicketSessionView => {
    const environmentId = d.environmentId?.();
    return {
      milestoneId: s.milestoneId,
      rowId: s.rowId,
      ...(row?.title ? { title: row.title } : {}),
      path: s.path,
      threadId: s.threadId,
      ...(environmentId ? { environmentId } : {}),
      link: environmentId ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(s.threadId)}` : null,
      persona: { id: s.personaId, name: s.personaName },
      fellBack: s.fellBack,
      launched,
    };
  };

  /**
   * Discuss no longer launches a thread. The row is checked as before (404 / 409 ambiguous / 409 closed); the answer
   * names this milestone's Chat tab about the row (`chat`, with the page hint `page`) and, when the row already has a live
   * session from before, that session too (still readable). `link` = the session's T3 link, else the chat link.
   */
  async function open(milestoneId: string, rowId: string, hint?: string): Promise<TicketOpenView> {
    const m = d.store.getMilestone(milestoneId);
    if (!m) throw new TicketSessionError(404, "not_found", `milestone ${milestoneId} not found`);
    const { row, path: spinePath, repoDir } = await findRow(m, rowId, hint);
    const stored = live(path.basename(repoDir), spinePath, row.id);
    if (rowClosed(row)) {
      if (stored) archive(stored, "row closed");
      throw new TicketSessionError(409, "row_closed", `${row.id} is closed (${raw(row)}): discuss it in the milestone chat`);
    }
    const id = stripInline(row.id).trim();
    const page = `${m.title} · ${id}`;
    const chat = milestoneChatUrl(d.publicUrl, m.id, id, row.title ? stripInline(row.title) : undefined);
    if (stored) {
      const v = view(stored, row, false);
      return { ...v, link: v.link ?? chat, chat, page };
    }
    return { milestoneId: m.id, rowId: id, ...(row.title ? { title: row.title } : {}), path: spinePath, launched: false, link: chat, chat, page };
  }

  /** Live sessions of a milestone for the Tree tab; one whose row has closed meanwhile is archived and left out. */
  async function list(milestoneId: string): Promise<TicketSessionView[]> {
    const m = d.store.getMilestone(milestoneId);
    if (!m) throw new TicketSessionError(404, "not_found", `milestone ${milestoneId} not found`);
    const rows = (d.db.prepare("SELECT * FROM ticket_session WHERE milestone_id = ? AND archived_at IS NULL ORDER BY seq").all(milestoneId) as any[]).map(rowTo);
    const out: TicketSessionView[] = [];
    const ledgers = new Map<string, Ticket[]>();
    for (const s of rows) {
      if (!ledgers.has(s.path)) ledgers.set(s.path, backlogFor(d.reposRoot, { id: m.id, repo: m.repo, path: s.path, paused: false }));
      const row = ledgers.get(s.path)!.find((t) => keyOf(t.id) === keyOf(s.rowId));
      if (row && rowClosed(row)) {
        archive(s, "row closed");
        continue;
      }
      out.push(view(s, row, false));
    }
    return out;
  }

  return { open, list, live };
}

export type TicketSessions = ReturnType<typeof createTicketSessions>;

const openIn = z.object({
  milestoneId: z.string().trim().min(1),
  /** The ledger row's id (""). */
  row: z.string().trim().min(1).max(120),
  /** Repo-relative spine whose ledger holds the row, when the id alone is ambiguous. */
  path: z.string().trim().min(1).max(300).optional(),
});

/** open (launch or reuse) a ticket session; list a milestone's live ones. The desk calls the same endpoint. */
export function mountTicketSessions(api: Hono, s: TicketSessions) {
  const guard = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof TicketSessionError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  };
  api.post(
    "/tickets/session",
    guard(async (c) => {
      const p = openIn.safeParse(await c.req.json().catch(() => undefined));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "milestoneId and row (string) are required" } }, 400);
      const r = await s.open(p.data.milestoneId, p.data.row, p.data.path);
      return c.json(r, 200);
    }),
  );
  api.get(
    "/tickets/sessions",
    guard(async (c) => {
      const id = c.req.query("milestoneId");
      if (!id) return c.json({ error: { code: "validation_error", message: "milestoneId is required" } }, 400);
      return c.json(await s.list(id));
    }),
  );
}
