import { peopleOfTag } from "../inbox/asks.js";
import { oneLine } from "../inbox/spineWrite.js";

/**
 * the ask line edits of many humans, pure. Each takes one raw spine line and returns the
 * new line, or a reason it cannot (not the ask, not open, not theirs). The spine writer commits and pushes them.
 *
 *   open      [ask: decide @Leo approve by @Marta aware @the owner since 2026-11-09 row] Is the car lease …?
 *   answered  [answered 2026-11-10 @Leo · awaits @Marta · aware @the owner] … — answer: yes, 50 percent
 *   approved  [answered 2026-11-10 @Leo · approved @Marta 2026-11-11 · aware @the owner] … — answer: yes, 50 percent
 *   escalated [ask: decide @Marta aware @the owner escalated by @Leo since 2026-11-09 row] … — escalated: depends on …
 *   sent back [ask: decide @Leo approve by @Marta aware @the owner since 2026-11-11] … — sent back: @Marta: … (was: yes, 50 percent)
 */
export type LineEdit = { line: string } | { refused: string };

const OPEN = /^(\s*[-*]\s+)\[ask\s+([^\s:\]]+)\s*:\s*(\w+)\s+@([^\s\]]+)([^\]]*)\](.*)$/i;
const ANSWERED = /^(\s*[-*]\s+)\[answered\s+([^\s\]]+)\s+(\d{4}-\d{2}-\d{2})\s+@([^\s\]·]+)([^\]]*)\](.*)$/i;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase();
const awareTail = (aware?: string[]) => (aware?.length ? ` · aware ${aware.map((h) => `@${h}`).join(", ")}` : "");
/** `since <date>` and `row <id>` of an open tag's tail. */
const tailOf = (rest: string) => ({ since: /\bsince\s+(\d{4}-\d{2}-\d{2})/i.exec(rest)?.[1], row: /\brow\s+([^\s\]]+)/i.exec(rest)?.[1] });
/** Drop one ` — <key>: …` segment (up to the next ` — ` or the end). */
const dropSeg = (body: string, key: string) => body.replace(new RegExp(`\\s+(?:—|--)\\s+${key}\\s*:.*?(?=\\s+(?:—|--)\\s+|$)`, "i"), "");
const segOf = (body: string, key: string) => new RegExp(`\\s+(?:—|--)\\s+${key}\\s*:\\s*(.*?)(?=\\s+(?:—|--)\\s+|$)`, "i").exec(body)?.[1];

function openTag(o: { code: string; kind: string; who: string; approveBy?: string; aware?: string[]; escalatedBy?: string; since?: string; row?: string }): string {
  return (
    `[ask ${o.code}: ${o.kind} @${o.who}` +
    (o.approveBy && !same(o.approveBy, o.who) ? ` approve by @${o.approveBy}` : "") +
    (o.aware?.length ? ` aware ${o.aware.map((h) => `@${h}`).join(", ")}` : "") +
    (o.escalatedBy ? ` escalated by @${o.escalatedBy}` : "") +
    (o.since ? ` since ${o.since}` : "") +
    (o.row ? ` row ${o.row}` : "") +
    "]"
  );
}

/** `by` answers their open ask: answered, and awaiting the approver when it names one. */
export function answerLine(raw: string, by: string, answer: string, date: string): LineEdit {
  const m = OPEN.exec(raw);
  if (!m) return { refused: "the ask is not open" };
  const [, lead, code, , who, rest, body] = m;
  if (!same(who, by)) return { refused: `the ask names @${who}, not @${by}` };
  const p = peopleOfTag(rest);
  const awaits = p.approveBy && !same(p.approveBy, by) ? ` · awaits @${p.approveBy}` : "";
  const clean = dropSeg(dropSeg(body, "answer"), "snoozed(?:\\s+until)?").replace(/\s+$/, "");
  return { line: `${lead}[answered ${code} ${date} @${by}${awaits}${awareTail(p.aware)}]${clean} — answer: ${oneLine(answer)}` };
}

/** The approver says yes: `· awaits @X` becomes `· approved @X <date>`. */
export function approveLine(raw: string, by: string, date: string): LineEdit {
  const m = ANSWERED.exec(raw);
  if (!m) return { refused: "the ask is not answered" };
  const p = peopleOfTag(m[5]);
  if (!p.awaits) return { refused: p.approvedBy ? "already approved" : "the answer waits on no approval" };
  if (!same(p.awaits, by)) return { refused: `the answer waits on @${p.awaits}, not @${by}` };
  return { line: `${m[1]}[answered ${m[2]} ${m[3]} @${m[4]} · approved @${p.awaits} ${date}${awareTail(p.aware)}]${m[6]}` };
}

/** The approver sends the answer back with a note (free text from them is feedback): the ask opens again for whoever answered. */
export function sendBackLine(raw: string, by: string, note: string, date: string, kind = "decide"): LineEdit {
  const m = ANSWERED.exec(raw);
  if (!m) return { refused: "the ask is not answered" };
  const p = peopleOfTag(m[5]);
  if (!p.awaits) return { refused: "the answer waits on no approval" };
  if (!same(p.awaits, by)) return { refused: `the answer waits on @${p.awaits}, not @${by}` };
  const was = segOf(m[6], "answer");
  const body = dropSeg(dropSeg(m[6], "answer"), "sent back").replace(/\s+$/, "");
  const tag = openTag({ code: m[2], kind, who: m[4], approveBy: p.awaits, aware: p.aware, since: date });
  return { line: `${m[1]}${tag}${body} — sent back: @${by}: ${oneLine(note)}${was ? ` (was: ${oneLine(was)})` : ""}` };
}

/**
 * `from` passes their open ask up to `to` (Not sure, or the time limit with from = the person who was too slow): the
 * ask keeps its code and history, names `to`, says `escalated by @from` and carries the note. An approver who is now
 * the one answering approves nothing more. `date` restarts its clock (the new person's time limit counts from it).
 */
export function escalateLine(raw: string, from: string, to: string, note: string, date?: string): LineEdit {
  const m = OPEN.exec(raw);
  if (!m) return { refused: "the ask is not open" };
  const [, lead, code, kind, who, rest, body] = m;
  if (!same(who, from)) return { refused: `the ask names @${who}, not @${from}` };
  if (same(to, from)) return { refused: "escalates to themselves" };
  const p = peopleOfTag(rest);
  const t = tailOf(rest);
  const tag = openTag({ code, kind, who: to, approveBy: p.approveBy && !same(p.approveBy, to) ? p.approveBy : undefined, aware: p.aware, escalatedBy: from, since: date ?? t.since, row: t.row });
  const clean = dropSeg(dropSeg(body, "escalated"), "snoozed(?:\\s+until)?").replace(/\s+$/, "");
  return { line: `${lead}${tag}${clean} — escalated: @${from}: ${oneLine(note)}` };
}

/** The 0-based line of ask `code` (open or answered) in `text`, or -1. */
export function lineOfCode(text: string, code: string): number {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*[-*]\\s+\\[(?:ask\\s+${esc}\\s*:|answered\\s+${esc}\\s)`, "i");
  return text.split("\n").findIndex((l) => re.test(l));
}
