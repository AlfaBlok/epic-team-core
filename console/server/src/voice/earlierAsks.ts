import type { DB } from "../db.js";
import { requestIdOf, type RequestRow } from "../desk/requests.js";
import { ownerName } from "../identity.js";

/**
 * What the team did with what he asked on earlier calls (his briefer call call_784648a0, 28 Nov: "if next time we speak,
 * you can have ... all of this context ... Even though you don't produce the answers, once the answers manifest, that you
 * become aware of them in your context so that you can pick up, like, answer these questions if I come back to them").
 *
 *   his words on a call ──▶ the call's desk (a relay, a call question, the whole-call post) ──▶ the desk's reply + the ticket row
 *        └──────────────── the next call's instructions carry each one: his words → ticket (status) · the desk said …
 *
 * Read from what the console already holds: each chat's last view (desk_view_cache: his call-born lines and the desk's reply
 * after each) and the request index (desk/requests.ts rowsOf: the ticket rows holding the request id, read from the spines).
 */
export const EARLIER_DAYS = 7;
/** At most this many of his call asks ride with a call (the newest kept). */
export const EARLIER_MAX = 12;
/** The block is part of every turn's input: about 1,500 tokens at most. */
export const EARLIER_CHARS = 6_000;

export const earlierHead = (days = EARLIER_DAYS) =>
  `What the team did with what ${ownerName()} asked on earlier calls (the last ${days} days, oldest first; each: his words → the ticket it landed on and where it stands, then the desk's reply). This is the team's answer, already handled: never send it to the desk again. When he asks what happened to something he raised on a call, answer from it at once, plainly, without ids: what was done or where it stands. A ticket that is ready or active is being worked; review waits for his look; done is finished.`;

export type EarlierAsk = { at: string; where: string; words: string; rows: RequestRow[]; reply?: string };

const one = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);
/** a desk reply as the voice reads it: links to their words, no bold, one line. */
const plainReply = (s: string) => one(s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, ""));

/** which call a call-born line came from, and his words in it (a relay quotes them; a call question says them). */
function parse(text: string): { where: string; words: string } | undefined {
  const t = text.trim();
  if (!t.startsWith("📞")) return undefined;
  if (/^📞 After the call/.test(t)) return undefined;
  const head = t.split("\n")[0];
  const call = /\b(call_[0-9a-f]{8})/.exec(head)?.[1] ?? "a call";
  const from = /^📞 From the (.+?) \(call_/.exec(head)?.[1];
  const where = from ? `${from} (${call})` : call;
  if (/^📞 Call with the desk/.test(t)) {
    // the whole-call post: his own turns are the request
    const his = t
      .split("\n")
      .filter((l) => new RegExp(`^\\s*(?:\\*\\*)?(?:${ownerName()}|owner)(?:\\*\\*)?\\s*:`, "i").test(l))
      .map((l) => l.replace(/^[^:]+:\s*/, ""));
    if (!his.length) return undefined;
    return { where: `the whole call ${call}`, words: his.join(" ") };
  }
  const quoted = /words:\s*"([\s\S]+?)"\s*(?:\n|$)/.exec(t)?.[1] ?? /live on a voice call:\s*([\s\S]+)/.exec(t)?.[1];
  return { where, words: quoted ?? t.split("\n").slice(1).join(" ") };
}

/** his call-born asks of the last `days` in the given chats' views, each with the ticket rows and the desk's reply after it. */
export function earlierAsks(db: DB, rowsOf: ((id: string) => RequestRow[] | undefined) | undefined, o: { days?: number; now?: number; chats?: (key: string) => boolean } = {}): EarlierAsk[] {
  const since = (o.now ?? Date.now()) - (o.days ?? EARLIER_DAYS) * 86_400_000;
  let views: { desk_key: string; view: string }[] = [];
  try {
    views = db.prepare("SELECT desk_key, view FROM desk_view_cache").all() as typeof views;
  } catch {
    return [];
  }
  const out: EarlierAsk[] = [];
  const seen = new Set<string>();
  for (const v of views) {
    if (o.chats && !o.chats(v.desk_key)) continue;
    let msgs: { id?: string; role?: string; kind?: string; text?: string; at?: string; request?: string }[] = [];
    try {
      msgs = (JSON.parse(v.view) as { messages?: typeof msgs }).messages ?? [];
    } catch {
      continue;
    }
    msgs.forEach((m, i) => {
      if (m.role !== "user" || m.kind === "seed") return;
      const at = Date.parse(m.at ?? "");
      if (!Number.isFinite(at) || at < since) return;
      const p = parse(m.text ?? "");
      if (!p) return;
      const request = m.request ?? requestIdOf(m.id, m.text ?? "");
      const key = request ?? `${v.desk_key}|${m.at}`;
      if (seen.has(key)) return;
      seen.add(key);
      const reply = msgs.slice(i + 1).find((x) => x.role && x.role !== "user" && x.text?.trim());
      out.push({ at: new Date(at).toISOString(), where: p.where, words: p.words, rows: (request && rowsOf?.(request)) || [], ...(reply?.text ? { reply: reply.text } : {}) });
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** the block for a call's instructions ("" = nothing he asked on a call in the window). */
export function earlierAsksBlock(asks: EarlierAsk[], o: { chars?: number; max?: number; days?: number } = {}): string {
  const kept = asks.slice(-(o.max ?? EARLIER_MAX));
  if (!kept.length) return "";
  const lines: string[] = [];
  let lastReply: string | undefined;
  for (const a of kept) {
    const day = new Date(a.at).toUTCString().slice(5, 11);
    const rows = a.rows.length ? a.rows.map((r) => `${cut(one(r.title ?? r.code), 90)} (${(r.status ?? "open").toLowerCase()})`).join("; ") : "no ticket found yet (the desk is placing it)";
    const reply = a.reply ? plainReply(a.reply) : undefined;
    const said = !reply ? "" : reply === lastReply ? " · the desk: the same reply as above." : ` · the desk said: "${cut(reply, 420)}"`;
    if (reply) lastReply = reply;
    lines.push(`- ${day}, ${a.where}: "${cut(one(a.words), 240)}" → ticket: ${rows}${said}`);
  }
  const head = earlierHead(o.days);
  const max = o.chars ?? EARLIER_CHARS;
  // the newest lines are kept when the block is too long
  while (lines.length > 1 && head.length + lines.join("\n").length > max) lines.shift();
  return [head, ...lines].join("\n");
}
