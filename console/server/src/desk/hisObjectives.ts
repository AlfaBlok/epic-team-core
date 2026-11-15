import fs from "node:fs";
import path from "node:path";
import { ownerName } from "../identity.js";
import { objectiveLines, type ObjectivesInput } from "../objectives.js";

/**
 * His objectives, read against each message he sends the Team desk. Nothing here is a list of its
 * own (the owner: "why is this 3? Why not 4? Why not 5? ... I'm looking for ... the system to be
 * self-maintaining"): the objectives are his live objectives in his order (the objectives screen, docs/pursuits.json) plus
 * the other worlds he names there, where each stands and what is next come from its live key results, and only his words
 * per objective come from `docs/his-words.json` (kept by `scripts/his_words.py refresh` from his voice notes, on a timer and each
 * Delivery Manager wake).
 *
 * Every message the owner sends the Team desk carries a short `[his objectives]` block before his words: one line per objective, the
 * ones his message names first with his words, the rest in one short line each. The chat view and every reader of his
 * words strip the block again (`splitSince` in since.ts), like the since block.
 */
export const CONTEXT_MARKER = "[his objectives]";
export const CONTEXT_END = "[/his objectives]";
export const WORDS_FILE = "docs/his-words.json";
/** its name before the rename, read while a checkout still has it. */
const OLD_WORDS_FILE = "docs/plot.json";
/** the whole block stays short: it rides on every message. */
export const CONTEXT_MAX_CHARS = 2_000;
/** a refresh older than this shows as stale in the block (the refresh timer runs every 6 h). */
export const WORDS_STALE_MS = 13 * 3_600_000;
/** no words of his on a pursuit for this long: the block says it is quiet. */
export const WORDS_QUIET_MS = 7 * 86_400_000;

/** the block, and the older name it had (messages sent before the rename still carry it). */
export const CONTEXT_BLOCK = /^\[(?:his objectives|plot)\]\n[\s\S]*?\n\[\/(?:his objectives|plot)\]\n/;

export interface HisWords {
  words?: string;
  said?: string;
  source?: string;
  via?: string;
  link?: string;
}
/** what the objectives list lacks, per objective id (or other world). */
export interface HisWordsEntry {
  id: string;
  name?: string;
  /** groups of terms (regex source, case-insensitive) that all appear when a message is about it. */
  match?: string[][];
  /** his newest words naming it. */
  after?: HisWords;
  /** an aim he confirmed. */
  aim?: HisWords;
  /** another world's own state (its spine's Status and Next action). */
  world?: { repo?: string; status?: string; next?: string; note?: string };
}
export interface HisWordsFile {
  version?: number;
  refreshedAt?: string;
  objectives?: HisWordsEntry[];
}

const DOT: Record<string, string> = { green: "🟢", amber: "🟡", red: "🔴" };
export const dot = (s?: string) => DOT[s ?? ""] ?? "⚪";

const cut = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** does `text` name this pursuit: every term of one group in it. */
export function touches(e: HisWordsEntry | undefined, text: string): boolean {
  return (e?.match ?? []).some(
    (g) =>
      g.length > 0 &&
      g.every((t) => {
        try {
          return new RegExp(`\\b${t}`, "i").test(text);
        } catch {
          return false;
        }
      }),
  );
}

/**
 * does `text` at least name this pursuit's subject: the first term of one of its groups (the product or thing it is
 * about), when the rest of the group is missing. Such a pursuit is listed after the ones the message fully names,
 * with his words, so a message about a product raises every objective about it without anyone adding match words.
 */
export function names(e: HisWordsEntry | undefined, text: string): boolean {
  return touches(e, text) || (e?.match ?? []).some((g) => g.length > 1 && touches({ id: e!.id, match: [[g[0]!]] }, text));
}

/** Read his words file of a checkout (the older docs/plot.json until it is renamed there); undefined when it is missing or broken (the block then has no words of his). */
export function readHisWords(reposRoot: string, repo: string): HisWordsFile | undefined {
  for (const [file, key] of [[WORDS_FILE, "objectives"], [OLD_WORDS_FILE, "plots"]] as const) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(reposRoot, repo, file), "utf8")) as Record<string, unknown>;
      if (Array.isArray(f[key])) return { ...(f as HisWordsFile), objectives: f[key] as HisWordsEntry[] };
    } catch {
      /* next */
    }
  }
  return undefined;
}

function wordsOf(e: HisWordsEntry | undefined, now: number): string {
  const parts: string[] = [];
  if (e?.aim?.words) parts.push(`aim: "${cut(e.aim.words, 110)}"`);
  const a = e?.after;
  if (a?.words) {
    const at = a.said ? Date.parse(a.said) : NaN;
    const day = a.said ? a.said.slice(5, 10) : "";
    parts.push(
      Number.isFinite(at) && now - at > WORDS_QUIET_MS
        ? `quiet: his last words ${day}: "${cut(a.words, 90)}"`
        : `his words ${day}${a.via ? ` (${a.via})` : ""}: "${cut(a.words, 150)}"`,
    );
  } else parts.push("no words of his on it yet");
  return parts.join(" · ");
}

/** next = the first key result still red (else amber): the one to turn green next. */
function nextOf(krs: { label?: string; state?: string; value?: string }[] | undefined): string {
  const k = (krs ?? []).find((x) => x.state === "red") ?? (krs ?? []).find((x) => x.state === "amber");
  return k?.label ? `next: ${cut(k.label, 60)}${k.value ? ` (${cut(k.value, 30)})` : ""}` : "";
}

/**
 * The block put before the owner's words: every live objective (his order) and other world, the ones `message` names
 * first with his words, the rest one short line each; and the rule that goes with it. Empty when nothing is known.
 */
export function objectivesContext(f: HisWordsFile | undefined, input: ObjectivesInput | undefined, now = Date.now(), message = ""): string {
  const entries = new Map((f?.objectives ?? []).map((e) => [e.id, e]));
  const lines = objectiveLines(input, f);
  const nodes = new Map((input?.nodes ?? []).map((n) => [n.id, n]));
  const worlds = (f?.objectives ?? []).filter((e) => e.world);
  if (!lines.length && !worlds.length) return "";
  const at = f?.refreshedAt ? Date.parse(f.refreshedAt) : NaN;
  const stale = !Number.isFinite(at) || now - at > WORDS_STALE_MS;
  const head = [
    CONTEXT_MARKER,
    `His ${lines.length} objectives live from the objectives screen (his order) and ${worlds.length ? `the other world${worlds.length > 1 ? "s" : ""} he names` : "no other world"}; his words from ${WORDS_FILE} (his voice notes${stale ? ", STALE: run scripts/his_words.py refresh" : ""}). Console context, not ${ownerName()}'s words.`,
    "Read his message against his objectives first, keep to them not the details; unsure which pursuit or what it changes: ask him one open question.",
  ];
  // 2 = the message fully names it, 1 = it names its subject only, 0 = not named
  type Row = { touched: number; order: number; full: string; short: string };
  const score = (e: HisWordsEntry | undefined) => (touches(e, message) ? 2 : names(e, message) ? 1 : 0);
  const rows: Row[] = lines.map((l, i) => {
    const e = entries.get(l.id);
    const base = [`${l.rank}. ${dot(l.light)} ${l.name}`, l.krs, l.today.replace(/ \(.*\)$/, ""), nextOf(nodes.get(l.id)?.keyResults)].filter(Boolean).join(" · ");
    return { touched: score(e), order: i, full: `${base} · ${wordsOf(e, now)}`, short: base };
  });
  worlds.forEach((e, i) => {
    const w = e.world!;
    const base = [`· ${e.name ?? e.id} (its own world ${w.repo ?? "?"}: notes only)`, w.status, w.next ? `next: ${cut(w.next, 110)}` : ""].filter(Boolean).join(" · ");
    rows.push({ touched: score(e), order: lines.length + i, full: `${base} · ${wordsOf(e, now)}`, short: base });
  });
  const sorted = [...rows].sort((a, b) => b.touched - a.touched || a.order - b.order);
  const body = sorted.map((r) => (r.touched ? r.full : r.short));
  if (sorted.some((r) => r.touched)) head.push(`His message names the first ${sorted.filter((r) => r.touched).length} (with his words); the rest follow in his order.`);
  let out = [...head, ...body, CONTEXT_END].join("\n");
  if (out.length > CONTEXT_MAX_CHARS) out = [...head, ...body.map((l) => cut(l, Math.floor((CONTEXT_MAX_CHARS - 600) / body.length))), CONTEXT_END].join("\n");
  return out;
}

/** The owner's words with the objectives block taken off (the block is console context, never his). */
export function splitObjectivesContext(text: string): { text: string; context?: string } {
  const b = CONTEXT_BLOCK.exec(text);
  return b ? { text: text.slice(b[0].length), context: b[0] } : { text };
}
