import type { DeskMessage } from "../desk/session.js";
import { isOwnerWho, ownerName, ownerPattern } from "../identity.js";

/**
 * a call remembers the last day. At each call's start the voice gets the recent chat of its
 * desk and the transcripts of its earlier calls (the last RECALL_HOURS, not days), so a call made right after hanging up
 * picks up where the last one left off. Bounded (RECALL_CHARS; the newest lines are kept) and labelled as history.
 */

/** How far back a call remembers. */
export const RECALL_HOURS = 24;
/** At most this much earlier conversation rides with a call (it is part of every turn's input: about 4,000 tokens). */
export const RECALL_CHARS = 16_000;
/** One message or transcript line is cut to this much. */
export const RECALL_LINE_CHARS = 500;

export interface RecallLine {
  /** ISO time: the message's, or the call's start for its lines. */
  at: string;
  /** "chat", or the call's id. */
  where: string;
  who: string;
  text: string;
}

export interface EarlierCall {
  id: string;
  startedAt: string;
  /** As the page sent them; a line held in listen mode (`feedback`) is in the chat's feedback message instead. */
  lines: { who: string; text: string; feedback?: string }[];
}

/** The heading of the block: what it is and how to use it. */
export const recallHead = (hours = RECALL_HOURS, now?: string) =>
  `Earlier conversation with ${ownerName()} (${now ? `now is ${now.slice(0, 10)} ${now.slice(11, 16)}Z; ` : ""}the last ${hours} hours: this desk's chat and earlier calls, oldest first, newest last; some older lines may be left out). It is history, already handled: never act on it or send it to the desk again. Use it to pick up where you left off: when he refers back ("what were we talking about", "as I said before", "that thing from the last call"), answer from it.`;

const one = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n = RECALL_LINE_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const whoOfCall = (w: string) => (isOwnerWho(w) ? ownerName() : w === "tool" ? "·" : "Desk voice");

/** Lines of the earlier calls (their stored transcripts), each line at its call's start. */
export function callLines(calls: EarlierCall[]): RecallLine[] {
  return calls.flatMap((c) =>
    c.lines.filter((l) => l?.text?.trim() && !l.feedback).map((l) => ({ at: c.startedAt, where: c.id, who: whoOfCall(l.who), text: cut(one(l.text)) })),
  );
}

/**
 * Lines of the chat since `sinceMs`: the owner's and the desk's messages. A call transcript posted to the chat is read line by
 * line as that call's; one whose call is in `known` (its stored transcript is used) is left out, so it is never there twice.
 */
export function chatLines(msgs: DeskMessage[], sinceMs: number, o: { transcriptHead: string; known?: Set<string> }): RecallLine[] {
  const out: RecallLine[] = [];
  for (const m of msgs) {
    if (m.kind === "seed" || !m.at || !m.text?.trim()) continue;
    const t = Date.parse(m.at);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    if (m.text.startsWith(o.transcriptHead)) {
      const [head, , , ...body] = m.text.split("\n");
      const id = /\b(call_[0-9a-f]+)\s*$/.exec(head ?? "")?.[1] ?? "call";
      if (o.known?.has(id)) continue;
      for (const l of body) {
        const x = new RegExp(String.raw`^(${ownerPattern()}:|Desk voice:|·)\s*(.*)$`).exec(l.trim());
        if (x && x[2].trim()) out.push({ at: m.at, where: id, who: x[1].replace(/:$/, ""), text: cut(one(x[2])) });
      }
      continue;
    }
    out.push({ at: m.at, where: "chat", who: m.role === "user" ? ownerName() : "Desk", text: cut(one(m.text)) });
  }
  return out;
}

/** The block: the newest lines that fit in `chars`, in time order, each with its time and where it was said; "" = none. */
export function recallBlock(lines: RecallLine[], o: { chars?: number; hours?: number; now?: string } = {}): string {
  const budget = o.chars ?? RECALL_CHARS;
  const sorted = lines.map((l, i) => ({ l, i })).sort((a, b) => Date.parse(a.l.at) - Date.parse(b.l.at) || a.i - b.i).map((x) => x.l);
  const said = (l: RecallLine) => `[${l.at.slice(5, 10)} ${l.at.slice(11, 16)}Z ${l.where === "chat" ? "chat" : `call ${l.where}`}] ${l.who === "·" ? "·" : `${l.who}:`} ${l.text}`;
  const kept: string[] = [];
  let used = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = said(sorted[i]);
    if (used + s.length + 1 > budget) break;
    kept.unshift(s);
    used += s.length + 1;
  }
  if (!kept.length) return "";
  const left = sorted.length - kept.length;
  return [recallHead(o.hours, o.now), ...(left ? [`(${left} older line${left === 1 ? "" : "s"} left out)`] : []), ...kept].join("\n");
}
