/**
 * The memory plug's contract (: "a memory plug for any MCP memory, with the memory service as one option").
 * Core reads voice notes and stamps answers with entries of this shape; the hosted services layer (mcp/services.ts,
 * a hosted services module) speaks to the memory service. Moved unchanged from those two files.
 */
/** One the memory service memory entry as `get_memory` returns it for an evidenceRef (structuredContent.entry). */
export interface MemoryEntry {
  evidenceRef?: string;
  content?: string;
  source?: string;
  contentType?: string;
  capturedAt?: string;
  verbatim?: boolean;
  /** the note on GitHub (obsidian-brain, pinned revision). */
  githubUrl?: string;
  url?: string;
}
/** The entry, or why not (`unreachable`: the memory service or the token failed, as opposed to the memory service answering that there is no such entry). */
export type MemoryLookup = (evidenceRef: string) => Promise<{ entry: MemoryEntry } | { error: string; unreachable: boolean }>;

/** one voice note as `search_memory` lists it (structuredContent.entries; the content is read with get_memory). */
export interface MemoryListed {
  evidenceRef: string;
  capturedAt?: string;
  source?: string;
  contentType?: string;
  url?: string;
  githubUrl?: string;
}
/** the owner's WhatsApp voice notes captured at or after `after` (ISO), newest first; or why not. */
export type VoiceNoteList = (after: string) => Promise<{ entries: MemoryListed[] } | { error: string }>;

/** one world's live connection as the relay's status shows it. */
export interface ConnSummary {
  world: string;
  team: string;
  id: string;
  connectedAt?: string;
  desk: string;
  safety: { everyMs: number; at?: string; result?: string };
  /** Per UTC day: signed deliveries received, safety-check searches, note reads. */
  calls: Record<string, { hooks: number; safety: number; reads: number }>;
  lastNote?: { at: string; ref: string; via?: string; ms?: number; test?: boolean };
}

// the memory helper's ask context (a hosted services module reads it; core builds it), moved unchanged.
export interface AskContext {
  /** The world's quick status in words (milestones in order, what waits, what is stuck, what is moving). */
  status: string;
  milestones: { title: string; word?: string }[];
  epics: AskEpic[];
}
export interface AskEpic {
  code: string;
  title: string;
  goal?: string | null;
  status?: string | null;
  next?: string | null;
  waitingOn?: string | null;
  /** Its ready and review rows, `<code>: <words>` (read on demand for the epics a question is closest to). */
  rows?: () => string[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);
/** A spine's ready and review rows (`| | owner | … | ready | …`), `<code>: <words>`, read only. */
export function readyAndReviewRows(markdown: string): string[] {
  const out: string[] = [];
  let titleAt = 3;
  let statusAt = 4;
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (/^\|\s*(Issue|Row|Step)\s*\|/i.test(line)) {
      // The ledger's header names its columns (Issue | Role | Owner | Title | Status | …).
      const t = cells.findIndex((c) => /^title$/i.test(c));
      const s = cells.findIndex((c) => /^status$/i.test(c));
      if (t > 0) titleAt = t;
      if (s > 0) statusAt = s;
      continue;
    }
    if (!/^\|\s*[A-Z][A-Za-z0-9]*-[A-Z]?\d+\s*\|/.test(line)) continue;
    const status = (cells[statusAt] ?? "").match(/^(ready|review)\b/i)?.[1];
    if (!status) continue;
    out.push(`${cells[0]} (${status.toLowerCase()}): ${clip(oneLine(cells[titleAt] ?? ""), 180)}`);
  }
  return out;
}
