import type { Post } from "./social";
import { ownerName } from "./identity";

/**
 * what the post page says first, read from the ledger row. A new thread's Title cell is the
 * thread title plus a trailing note of codes ("(r/X discussion; topic T-1101-5, idea I-10)"); a reply's Title cell describes
 * the reply ("Reply to u/who on \"their title\" (they: …) … (re: [their comment](url))"). Text paragraphs are " · "-joined.
 */

export interface PostBasics {
  reply: boolean;
  /** "New thread in r/ContextEngineering", "Reply to u/who", "X post", "X reply to @who". */
  what: string;
  /** Replies: who we answer (u/name, @name), the title of their thread, a link to what we answer, what they said. */
  to?: string;
  onTitle?: string;
  url?: string;
  said?: string;
  /** New threads and posts: the title as it goes out, with the codes taken off; the codes, for a small line. */
  title?: string;
  codes?: string;
}

const CODE = /\b(topics?|ideas?|messages?|discussion|EPIC-\d|E\d+-S\d|[A-Z]{1,2}-\d{3,4}(-\d+)?|I-\d+)\b/i;

/** The title without a trailing "(…codes…)" note, and that note. */
export function splitTitle(title: string): { title: string; codes?: string } {
  const m = /^([\s\S]*?)\s*\(([^()]*)\)\s*$/.exec(title.trim());
  if (!m || !m[1] || !CODE.test(m[2])) return { title: title.trim() };
  return { title: m[1].trim(), codes: m[2].trim() };
}

const REDDIT_THREAD = /(?:https?:\/\/)?(?:www\.)?reddit\.com\/r\/\w+\/comments\/[\w/]+/;

export function postBasics(p: Pick<Post, "kind" | "platform" | "community" | "title" | "checks">): PostBasics {
  const platform = p.platform || "Social";
  const isX = /^x$/i.test(platform);
  const reply = /reply|outreach|comment/i.test(p.kind ?? "") || /^Reply to\b/.test(p.title);
  if (!reply) {
    const { title, codes } = splitTitle(p.title);
    const what = isX ? "X post" : p.community && /^r\//.test(p.community) ? `New thread in ${p.community}` : `${platform} post`;
    return { reply, what, title, ...(codes ? { codes } : {}) };
  }
  const to = /^Reply to\s+(u\/[\w-]+|@\w+)/.exec(p.title)?.[1];
  const onTitle = /\bon\s+"([^"]+)"/.exec(p.title)?.[1];
  const re = /\(re:\s*\[[^\]]*\]\(([^)\s]+)\)\)/.exec(p.title)?.[1];
  const thread = re ? undefined : REDDIT_THREAD.exec(p.checks ?? "")?.[0];
  const url = re ?? (thread ? (thread.startsWith("http") ? thread : `https://www.${thread.replace(/^www\./, "")}`) : undefined);
  const said = theySaid(p.title);
  const what = `${isX ? "X reply" : "Reply"}${to ? ` to ${to}` : ""}`;
  return { reply, what, ...(to ? { to } : {}), ...(onTitle ? { onTitle } : {}), ...(url ? { url } : {}), ...(said ? { said } : {}) };
}

/** "(they: wants to test and send feedback)" or, on X rows, "…): they keep the exact error because …." */
function theySaid(title: string): string | undefined {
  const at = title.indexOf("(they:");
  if (at >= 0) {
    let depth = 0;
    for (let i = at; i < title.length; i++) {
      if (title[i] === "(") depth++;
      else if (title[i] === ")" && --depth === 0) return title.slice(at + 6, i).trim();
    }
  }
  return /\):\s*(they\b[^]*?\.)(?:\s|$)/.exec(title)?.[1];
}

/**
 * The text as paragraphs: the ledger joins them with " · " (older rows, and P-0062's workaround, use `<br>`), a typed text
 * may use blank lines. A `<br>` was shown as is, inside one paragraph.
 */
export const paragraphs = (text: string): string[] =>
  text
    .split(/\s+·\s+|\n\s*\n|(?:\s*<br\s*\/?>\s*)+/i)
    .map((s) => s.trim())
    .filter(Boolean);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue 3 Nov 14:00 UTC", the slot on a Schedule button. */
export function slotShort(slot: string): string {
  const d = new Date(`${slot.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return slot;
  const time = /^\d{2}:\d{2}$/.test(slot.slice(11, 16)) ? ` ${slot.slice(11, 16)} UTC` : "";
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${time}`;
}

/** "Thursday 5 Nov, 14:00 UTC" for a slot (`2026-11-05 14:00` or ISO), "Thursday 5 Nov" for a day. */
export function slotWords(slot: string): string {
  const d = new Date(`${slot.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return slot;
  const time = /^\d{2}:\d{2}$/.test(slot.slice(11, 16)) ? `, ${slot.slice(11, 16)} UTC` : "";
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${time}`;
}

const strip = (s: string) => s.replace(/\s*\([^()]*\)/g, "").replace(/\s+/g, " ").trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Split on `sep` outside parentheses and quotes. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0,
    quote = false,
    from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quote = !quote;
    else if (!quote && c === "(") depth++;
    else if (!quote && c === ")") depth = Math.max(0, depth - 1);
    else if (!quote && depth === 0 && c === sep) out.push(s.slice(from, i)), (from = i + 1);
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

const IRREGULAR: Record<string, string> = { has: "have", is: "are", was: "were", does: "do", goes: "go" };
/** "the owner approves every post" reads "you approve every post": the name becomes you and its verb loses the third-person s. */
export const toYou = (t: string) => {
  const o = ownerName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t
    .replace(new RegExp(`\\b${o}'s\\b`, "g"), "your")
    .replace(new RegExp(`\\b${o} ([a-z]+)\\b`, "g"), (_m, v: string) => `you ${IRREGULAR[v] ?? (/(ch|sh|x|ss|z)es$/.test(v) ? v.slice(0, -2) : /[^aeiou]ies$/.test(v) ? `${v.slice(0, -3)}y` : /[^s]s$/.test(v) ? v.slice(0, -1) : v)}`)
    .replace(new RegExp(`\\b${o}\\b`, "g"), "you");
};

/**
 * The check line as a short list: what waits on the owner ("Waiting for your approval. Why: every post is held.") and what
 * passed, brackets and codes taken off; the raw line stays under All checks.
 */
export function readChecks(checks: string): { waits: string[]; passed: string[] } {
  const waits: string[] = [];
  const passed: string[] = [];
  // Before "pass:" a line may carry context (where a reply goes, what the thread says): not a check.
  let pass = !/\bpass:/i.test(checks);
  for (const seg of splitTop(checks.replace(/\.\s+pass:/g, "; pass:"), ";")) {
    if (/^(waiting for|waits (for|on)|held\b)/i.test(seg)) {
      const why = /\(hold rule[^:()]*:\s*([^()]*)\)/i.exec(seg)?.[1];
      const head = toYou(strip(seg));
      waits.push(`${cap(head)}.${why ? ` Why: ${why.trim()}.` : ""}`);
    } else if (/^pass:/i.test(seg)) {
      pass = true;
      for (const item of splitTop(seg.replace(/^pass:\s*/i, ""), ",")) if (strip(item)) passed.push(cap(strip(item)));
    } else if (pass) {
      const head = /^([^:]{12,}):/.exec(seg)?.[1];
      const line = strip(head ?? seg);
      if (line && !/^[A-Z]{1,2}\d+$/.test(line)) passed.push(cap(line));
    }
  }
  return { waits, passed };
}
