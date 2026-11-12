import { z } from "zod";
import type { DB } from "../db.js";
import type { HostId } from "../identity.js";
import { hostIdSchema } from "../schemas.js";

/**
 * host handover. An agent on the main server (or the worker server) has written a `Handover:` note into its bound epic's Current State
 * and pushed; `POST /api/handover` launches a top-level T3 thread on the other host, in the repo's T3 project (root
 * checkout), whose first message tells it to pull, read the note and continue. One thread per clientRequestId: a retry
 * after a client timeout answers the first launch (idiom), never a second thread.
 */
export const handoverIn = z
  .object({
    repo: z.string().trim().min(1).max(200),
    epic: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((s) => s.endsWith(".md") && !s.startsWith("/") && !s.split("/").includes(".."), "epic must be a repo-relative .md path"),
    target: hostIdSchema(),
    note: z.string().trim().max(2000).optional(),
    fromHost: z.string().trim().max(40).optional(),
    fromThread: z.string().trim().max(120).optional(),
    clientRequestId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type HandoverInput = z.infer<typeof handoverIn>;

export interface Handover {
  host: HostId;
  threadId: string;
  projectId: string;
  title: string;
  /** t3code://threads/<env>/<thread> when the host's environment id is known. */
  url: string | null;
  createdAt: string;
}

/** `docs/spines/epic-52-host-handover.md` → ``; other spines by their file name. */
export function epicShort(epic: string): string {
  const base = epic.split("/").pop()!.replace(/\.md$/, "");
  const n = /^epic-(\d+)\b/i.exec(base);
  return n ? `EPIC-${n[1]}` : base;
}

export const handoverTitle = (epic: string) => `Handover: ${epicShort(epic)}`;

export function handoverMessage(i: HandoverInput): string {
  const lines = [
    `Handover from ${i.fromHost || "another host"} thread ${i.fromThread || "(unknown)"}. Bound epic: ${i.epic}. git pull, read the \`Handover:\` line in that epic's Current State, then continue the work from its Next action.`,
  ];
  if (i.note) lines.push(`Note from the handing-over agent: ${i.note}`);
  return lines.join("\n");
}

export const threadUrl = (env: string | undefined, threadId: string) =>
  env ? `t3code://threads/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}` : null;

export function migrateHandover(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_handover (
      client_request_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      repo TEXT NOT NULL,
      epic TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

type Row = Record<string, string>;
export const getHandover = (db: DB, key: string) =>
  db.prepare("SELECT * FROM cycle_handover WHERE client_request_id = ?").get(key) as Row | undefined;
export const saveHandover = (db: DB, key: string, h: Omit<Handover, "url">, i: HandoverInput) =>
  db
    .prepare("INSERT OR IGNORE INTO cycle_handover (client_request_id, host, thread_id, project_id, title, repo, epic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(key, h.host, h.threadId, h.projectId, h.title, i.repo, i.epic, h.createdAt);
