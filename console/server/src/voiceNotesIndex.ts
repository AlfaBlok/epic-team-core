import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";

/**
 * The owner's voice notes in one place: every note he spoke in the last two days, from every source (a chat, a card
 * answer, a message app), each with the rows and epics made from it. A persona writes `docs/voice-notes/index.json` of
 * the home repo every pass (from his memory's log); this only reads it for the Voice notes page (GET /api/voice-notes),
 * where a product filter shows one product's notes alone. The file names its products (`productNames`, in filter
 * order), so the console names none. The repo is the record.
 */
export const VOICE_NOTES_FILE = "docs/voice-notes/index.json";

export interface VoiceNoteRow {
  code: string;
  repo: string;
  spine: string;
  epic: string;
  epicTitle?: string;
  status: string;
  title: string;
  /** "row": a ledger row quotes the note; "decision": a Decisions line does. */
  via: string;
}
export interface VoiceNoteItem {
  ref: string;
  key: string;
  vn?: string;
  source: string;
  app: string;
  at: string;
  words: string;
  chars: number;
  url?: string;
  products: string[];
  state: string;
  rows: VoiceNoteRow[];
}
export interface VoiceNotesBody {
  generatedAt: string | null;
  windowHours: number;
  counts: Record<string, number>;
  products: Record<string, number>;
  /** product id → the name the filter shows, in filter order (the first is where the page opens). */
  productNames: Record<string, string>;
  notes: VoiceNoteItem[];
  rule?: string;
}

const EMPTY: VoiceNotesBody = { generatedAt: null, windowHours: 48, counts: {}, products: {}, productNames: {}, notes: [] };
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseVoiceNotes(text: string): VoiceNotesBody {
  const d = JSON.parse(text) as Partial<VoiceNotesBody>;
  const notes = (Array.isArray(d.notes) ? d.notes : [])
    .filter((n): n is VoiceNoteItem => !!n && typeof n === "object" && typeof n.ref === "string" && typeof n.at === "string")
    .map((n) => ({
      ...n,
      words: str(n.words),
      products: Array.isArray(n.products) ? n.products.filter((p) => typeof p === "string") : ["other"],
      rows: Array.isArray(n.rows) ? n.rows.filter((r) => r && typeof r.code === "string") : [],
    }));
  return {
    generatedAt: str(d.generatedAt) || null,
    windowHours: typeof d.windowHours === "number" ? d.windowHours : 48,
    counts: d.counts && typeof d.counts === "object" ? d.counts : {},
    products: d.products && typeof d.products === "object" ? d.products : {},
    productNames: Object.fromEntries(Object.entries(d.productNames && typeof d.productNames === "object" ? d.productNames : {}).filter(([, v]) => typeof v === "string")),
    notes,
    ...(d.rule ? { rule: str(d.rule) } : {}),
  };
}

/** Only the notes about one product (`all` or none = every note). */
export function filterVoiceNotes(body: VoiceNotesBody, product?: string): VoiceNotesBody {
  if (!product || product === "all") return body;
  return { ...body, notes: body.notes.filter((n) => n.products.includes(product)) };
}

/** The home repo's voice-note index, read again when the file changes. */
export function createVoiceNotesReader(o: { reposRoot: string; home?: string }) {
  let cached: { file: string; mtime: number; body: VoiceNotesBody } | null = null;
  return {
    get(product?: string): VoiceNotesBody {
      const dir = resolveRepo(o.reposRoot, o.home ?? homeRepo())?.path;
      if (!dir) return EMPTY;
      const file = path.join(dir, VOICE_NOTES_FILE);
      let mtime: number;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        return EMPTY;
      }
      if (!cached || cached.file !== file || cached.mtime !== mtime) {
        try {
          cached = { file, mtime, body: parseVoiceNotes(fs.readFileSync(file, "utf8")) };
        } catch {
          return EMPTY;
        }
      }
      return filterVoiceNotes(cached.body, product);
    },
  };
}
