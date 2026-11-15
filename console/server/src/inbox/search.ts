/**
 * The owner 2026-11-12 21:17Z: a search box at the top of the inbox;
 * typing a word (e.g. Condesa) filters every section (blocked, review, done) at once, matching titles, the card's
 * text and his own notes on it. GET /api/inbox/search?q= answers from the lists the Inbox already reads (the asks'
 * stored view, his answers in console.db, the review cards, the status rows, the voice-note index), never from git
 * or spines.py on the request, so a query takes milliseconds. Each hit says where it matched; a done item older than
 * the Inbox's own list (up to 30 days) comes back as its one-line row (slimList.ts rowOf), so the Answered list can
 * show it too.
 */
import { rowOf } from "./slimList.js";

export const SEARCH_DONE_DAYS = 30;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
/** the stored lists are re-read at most this often while he types (a press refreshes the screen's own lists at once). */
export const SEARCH_CACHE_MS = 5_000;

export type SearchSection = "blocked" | "review" | "done";
export type SearchWhere = "title" | "card" | "note";

export interface SearchHit {
  id: string;
  section: SearchSection;
  /** where the words matched: the title, the card's own text, or his notes (answers, feedback, voice notes). */
  where: SearchWhere[];
  title: string;
}

export interface SearchResult {
  q: string;
  tookMs: number;
  total: number;
  counts: Record<SearchSection, number>;
  hits: SearchHit[];
  /** done items the Inbox's own list does not hold (older than its window), as one-line rows. */
  rows: Record<string, unknown>[];
}

type Obj = Record<string, unknown>;

/** one searchable thing, its text already folded (lower case, no accents) per kind of field. */
export interface SearchDoc {
  id: string;
  section: SearchSection;
  title: string;
  /** row or ask codes it carries (a voice note naming the row matches it). */
  codes: string[];
  text: Record<SearchWhere, string>;
  /** a done item outside the Inbox's own list: sent along as its row. */
  row?: Obj;
}

/** lower case, accents dropped ("Condesa" finds "condesa", "Cancún" finds "cancun"). */
export const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** the query's words (each must match somewhere in the item); quotes are dropped. */
export function queryWords(q: string): string[] {
  return fold(q.slice(0, SEARCH_MAX_CHARS))
    .replace(/["“”]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** every string inside a value (options, delivered lines, a quality check's words…). */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || v == null) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (typeof v === "object") for (const x of Object.values(v as Obj)) strings(x, out, depth + 1);
  return out;
}
const join = (parts: unknown[]) => fold(parts.flatMap((p) => strings(p)).join("\n"));

/** the inputs: the lists the Inbox reads, already in memory. */
export interface SearchSources {
  /** every ask of the world, settled and superseded too (the stored view). */
  waiting: Obj[];
  /** his answers (console.db jordi_responses), newest first. */
  responses: Obj[];
  /** the review cards waiting for him, snoozed ones too. */
  review: Obj[];
  /** the status rows the Blocked section shows (a ready stamp, a stalled run…). */
  status: Obj[];
  /** his voice notes of the last days, each with the rows made from it. */
  voice: { words?: string; rows?: { code?: string }[] }[];
  now?: number;
}

const ASK_CARD_FIELDS = ["question", "detail", "proposedAction", "options", "recommendation", "contextText", "impact", "risk", "whyYou", "steps", "unblocks", "milestoneTitle", "who", "ownerName"];
const REVIEW_CARD_FIELDS = ["summary", "milestoneTitle", "confirmWhy", "status"];

const sectionOfAsk = (it: Obj): SearchSection => (it.state === "open" && !it.decidedBy ? "blocked" : "done");

/** the searchable documents of the whole inbox. */
export function buildDocs(s: SearchSources): SearchDoc[] {
  const now = s.now ?? Date.now();
  const since = now - SEARCH_DONE_DAYS * 86_400_000;
  const docs: SearchDoc[] = [];
  // his answers by item, and by file + question (the answered line's id differs from the open ask's).
  const byItem = new Map<string, Obj[]>();
  const byQuestion = new Map<string, Obj[]>();
  const qkey = (path: unknown, question: unknown) => `${str(path)}\u0000${str(question)}`;
  for (const r of s.responses) {
    const item = (r.item as Obj) ?? {};
    const id = str(r.itemId);
    byItem.set(id, [...(byItem.get(id) ?? []), r]);
    const k = qkey(item.path, item.question);
    byQuestion.set(k, [...(byQuestion.get(k) ?? []), r]);
  }
  const seen = new Set<string>();
  for (const it of s.waiting) {
    const id = str(it.id);
    if (!id || seen.has(id)) continue;
    const done = it.state === "done" || it.state === "superseded";
    const at = Date.parse(str(it.doneAt) || str(it.since));
    if (done && Number.isFinite(at) && at < since) continue;
    seen.add(id);
    const answers = byItem.get(id) ?? byQuestion.get(qkey(it.path, it.question)) ?? [];
    docs.push({
      id,
      section: sectionOfAsk(it),
      title: str(it.title) || str(it.question),
      codes: [str(it.code), str(it.row), str(it.readyRow)].filter(Boolean),
      text: {
        title: join([it.title, it.code, it.row]),
        card: join(ASK_CARD_FIELDS.map((f) => it[f])),
        note: join([it.answer, ...answers.map((r) => r.text)]),
      },
    });
  }
  // a written answer whose line is gone from the spine (the Inbox shows these for 3 days): up to 30 days here.
  for (const r of s.responses) {
    const item = (r.item as Obj) ?? {};
    const id = str(r.itemId);
    const spine = r.spine as Obj | undefined;
    if (!id || seen.has(id) || spine?.status !== "written" || item.source === "needs_jordi") continue;
    const at = Date.parse(str(spine.at) || str(r.createdAt));
    if (!Number.isFinite(at) || at < since) continue;
    seen.add(id);
    const it: Obj = { ...item, id, state: "done", answer: str(r.text).slice(0, 200), response: r };
    docs.push({
      id,
      section: "done",
      title: str(item.title) || str(item.question),
      codes: [str(item.code), str(item.row)].filter(Boolean),
      text: { title: join([item.title, item.code, item.row]), card: join(ASK_CARD_FIELDS.map((f) => item[f])), note: join([r.text]) },
      row: rowOf(it),
    });
  }
  for (const c of s.review) {
    const id = str(c.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const face = (c.face as Obj) ?? {};
    const qc = (face.qc as Obj) ?? {};
    docs.push({
      id,
      section: "review",
      title: str(face.title) || str(c.title),
      codes: [str(c.ref)].filter(Boolean),
      text: {
        title: join([c.title, face.title, c.ref]),
        card: join([...REVIEW_CARD_FIELDS.map((f) => c[f]), face.taskGoal, face.delivered, face.decision, face.after, face.goal, face.next, c.followupRows]),
        // his words on it: where it came from (his note quoted), his feedback, the words the quality check lists.
        note: join([face.source, face.from, c.feedback, qc.words]),
      },
    });
  }
  for (const st of s.status) {
    const id = str(st.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    docs.push({
      id,
      section: st.kind === "answered" ? "done" : "blocked",
      title: str(st.title),
      codes: [str(st.code)].filter(Boolean),
      text: { title: join([st.title, st.code]), card: join([st.sentence, st.why, st.detail, st.next]), note: "" },
    });
  }
  // his voice notes: a note's words count as his note on every item whose row or ask it names.
  const voiceByCode = new Map<string, string[]>();
  for (const n of s.voice) {
    const words = fold(str(n.words));
    if (!words) continue;
    for (const r of n.rows ?? []) if (r.code) voiceByCode.set(r.code, [...(voiceByCode.get(r.code) ?? []), words]);
  }
  if (voiceByCode.size)
    for (const d of docs) {
      const extra = d.codes.flatMap((c) => voiceByCode.get(c) ?? []);
      if (extra.length) d.text.note = [d.text.note, ...extra].filter(Boolean).join("\n");
    }
  return docs;
}

/** the documents matching every word of the query, each with where it matched. */
export function searchDocs(docs: SearchDoc[], q: string, started = Date.now()): SearchResult {
  const words = queryWords(q);
  const counts: Record<SearchSection, number> = { blocked: 0, review: 0, done: 0 };
  const hits: SearchHit[] = [];
  const rows: Obj[] = [];
  if (words.join("").length >= SEARCH_MIN_CHARS)
    for (const d of docs) {
      const where = new Set<SearchWhere>();
      let all = true;
      for (const w of words) {
        let found = false;
        for (const k of ["title", "card", "note"] as const)
          if (d.text[k].includes(w)) {
            where.add(k);
            found = true;
          }
        if (!found) {
          all = false;
          break;
        }
      }
      if (!all) continue;
      counts[d.section]++;
      hits.push({ id: d.id, section: d.section, where: [...where], title: d.title });
      if (d.row) rows.push(d.row);
    }
  return { q, tookMs: Date.now() - started, total: hits.length, counts, hits, rows };
}

/** the search with its documents kept a few seconds (he types a word letter by letter). */
export function createInboxSearch(load: () => Promise<SearchSources>, o: { cacheMs?: number; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  let cached: { at: number; docs: Promise<SearchDoc[]> } | undefined;
  const docs = () => {
    if (!cached || now() - cached.at > (o.cacheMs ?? SEARCH_CACHE_MS)) {
      const p = load().then(buildDocs);
      cached = { at: now(), docs: p };
      p.catch(() => (cached = undefined));
    }
    return cached.docs;
  };
  return {
    async search(q: string): Promise<SearchResult> {
      const started = now();
      return searchDocs(await docs(), q, started);
    },
    /** a press changed the lists: the next query reads them again. */
    drop() {
      cached = undefined;
    },
  };
}
