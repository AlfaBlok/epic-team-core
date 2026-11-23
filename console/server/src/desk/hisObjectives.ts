import fs from "node:fs";
import path from "node:path";
import { ownerName } from "../identity.js";
import { objectiveLines, type ObjectivesInput } from "../objectives.js";
import { priorityAskRule } from "../inbox/priorityAsk.js";

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
  /** on an older word: `replaced` (his newer word speaks to the same point or overrules it) or `stands` (another point, still his). */
  state?: "replaced" | "stands" | "in force";
  /** when it is replaced: the date of the word that replaced it. */
  by?: string;
}
/** what the objectives list lacks, per objective id (or other world). */
export interface HisWordsEntry {
  id: string;
  name?: string;
  /** groups of terms (regex source, case-insensitive) that all appear when a message is about it. */
  match?: string[][];
  /** his newest words naming it. */
  after?: HisWords;
  /** an aim he confirmed (it holds only while it is newer than his newest words). */
  aim?: HisWords;
  /** his older words on it, newest first, each marked replaced or stands (scripts/his_words.py refresh). */
  earlier?: HisWords[];
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

/**
 * His newest word wins: on each objective the words in
 * force are his newest; an aim he confirmed holds only while it is newer than them. Every older word is shown marked,
 * never mixed in: replaced (the newest speaks to the same point or overrules it) or stands (another point, still his).
 */
export const NEWEST_WORD_RULE =
  "His newest word wins: on each objective the words marked in force are his newest and hold; an older word marked replaced no longer holds " +
  "(never act on it or mix it in), one marked stands is another point that is still his.";
export const NEWEST_HEAD = "His newest words first";

/** the words in force on an objective: an aim he confirmed only while it is newer than his newest words, else those. */
export function inForceWords(e: HisWordsEntry | undefined): HisWords | undefined {
  const a = e?.after?.words ? e.after : undefined;
  const m = e?.aim?.words ? e.aim : undefined;
  if (m && (!a || (m.said ?? "") >= (a.said ?? ""))) return m;
  return a;
}

/** the older words an objective's words in force replace (an aim they overtook first), newest first. */
export function replacedWords(e: HisWordsEntry | undefined): HisWords[] {
  const f = inForceWords(e);
  const out: HisWords[] = [];
  if (e?.aim?.words && f !== e.aim) out.push({ ...e.aim, state: "replaced", by: f?.said });
  if (e?.after?.words && f !== e.after) out.push({ ...e.after, state: "replaced", by: f?.said });
  for (const w of e?.earlier ?? []) if (w.state === "replaced" && w.words) out.push(w);
  return out;
}

/** " · replaces 11-20: "…"" for the newest word it replaced, or "" (one short marker: the block rides on every message). */
export function replacesMarker(e: HisWordsEntry | undefined, max = 70): string {
  const r = replacedWords(e)[0];
  return r ? ` · replaces ${r.said ? r.said.slice(5, 10) + " " : ""}"${cut(r.words, max)}"` : "";
}

/**
 * A worker brief's section of his newest words on the objectives its brief names, newest first: the words in force, then
 * each older one marked replaced or stands. Empty when the brief names none.
 */
export function newestWordsSection(f: HisWordsFile | undefined, text: string): string {
  const named = (f?.objectives ?? []).filter((e) => touches(e, text) || names(e, text) || (e.name && text.includes(e.name)));
  if (!named.length) return "";
  const out = [`## ${NEWEST_HEAD} (${WORDS_FILE})`, NEWEST_WORD_RULE];
  for (const e of named.slice(0, 4)) {
    const w = inForceWords(e);
    if (!w?.words) continue;
    out.push(`- ${e.name ?? e.id}: in force ${w.said?.slice(0, 16) ?? ""}${w.via ? ` (${w.via})` : ""}: "${cut(w.words, 220)}"${w.link ? ` [source](${w.link})` : ""}`);
    for (const r of [...replacedWords(e), ...(e.earlier ?? []).filter((x) => x.state === "stands")].slice(0, 4))
      out.push(`  - ${r.state === "replaced" ? `replaced${r.by ? ` by his words of ${r.by.slice(0, 10)}` : ""}` : "stands"}: ${r.said?.slice(0, 16) ?? ""} "${cut(r.words, 140)}"`);
  }
  return out.length > 2 ? out.join("\n") + "\n" : "";
}

/**
 * A wake's Chat section (campaign personas read the owner's words in 2 of 528 runs): his newest words on the objectives
 * named in `text`, read before the wake plans, with the command that prints his notes on a row. Empty when he has none.
 */
export function chatSection(f: HisWordsFile | undefined, text: string, home: string): string {
  const body = newestWordsSection(f, text).trim();
  if (!body) return "";
  return [
    body.replace(`## ${NEWEST_HEAD}`, `## His words, the Chat tab (read before you plan): ${NEWEST_HEAD}`),
    `Before you plan, also read his notes on each row you touch: \`python3 ~/github/${home}/scripts/card_notes.py words <row>\` (whole, newest first). Your result answers his newest word.`,
  ].join("\n");
}

function wordsOf(e: HisWordsEntry | undefined, now: number): string {
  const parts: string[] = [];
  const a = inForceWords(e);
  if (a?.words) {
    const at = a.said ? Date.parse(a.said) : NaN;
    const day = a.said ? a.said.slice(5, 10) : "";
    const what = a === e?.aim ? "aim" : "his words";
    parts.push(
      Number.isFinite(at) && now - at > WORDS_QUIET_MS
        ? `quiet: his last words ${day}: "${cut(a.words, 90)}"`
        : `${what} ${day}${a.via ? ` (${a.via})` : ""}, in force: "${cut(a.words, 150)}"${replacesMarker(e)}`,
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
    NEWEST_WORD_RULE,
    priorityAskRule(ownerName()),
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
  if (out.length > CONTEXT_MAX_CHARS) out = [...head, ...body.map((l) => cut(l, Math.floor((CONTEXT_MAX_CHARS - 1000) / body.length))), CONTEXT_END].join("\n");
  return out;
}

/** The owner's words with the objectives block taken off (the block is console context, never his). */
export function splitObjectivesContext(text: string): { text: string; context?: string } {
  const b = CONTEXT_BLOCK.exec(text);
  return b ? { text: text.slice(b[0].length), context: b[0] } : { text };
}
