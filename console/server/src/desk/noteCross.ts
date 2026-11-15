import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { ownerName } from "../identity.js";
import { CROSS_HEAD, CROSS_PASSED_HEAD, ensureCrossTables, type DeskSide } from "../voice/cross.js";
import { wholeWords } from "../voice/spill.js";
import { TRANSCRIPT_MAX } from "./voiceNotes.js";
import { readInbox, type DeskNote } from "./inbox.js";

/**
 * (the owner, 2026-11-12): the social product's desk passed his words to EpicTeam as a desk
 * note file (desk/inbox), so it never showed in EpicTeam's chat and he could not see it landed. Now every desk note one of
 * his two paired desks' worlds drops in the other's desk inbox also shows in the receiving desk's chat, and once the
 * receiving Delivery Manager places it (the note is answered, its row named) the sending desk's chat gets a receipt line.
 *
 * The console posts both as the desk system (the same `↔` heads and delivery as the relay, cross.ts: retries, never twice),
 * never as a persona. The Chat draws them as passed bands (web lib/passed.ts). Notes of the backfill day that were already
 * there at the first sweep go as ONE backfill message per desk instead of one line each.
 *
 * Rows live in desk_crossings (msg_key `note:<to world>:<file>`), so the relay's sweep delivers and retries them:
 * `line` = the line into the receiving desk, `note` = the receipt into the sending desk (set once placed).
 */

/** Notes named before this day are never crossed; notes of this day already there at the first sweep are the backfill. */
export const NOTE_CROSS_BACKFILL_DAY = "2026-11-12";
export const NOTE_ID_PREFIX = "dn_";
const BODY_MAX = 1_200;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const stop = (s: string) => oneLine(s).replace(/[.\s]+$/, "");
const hhmm = (iso: string) => `${iso.slice(11, 16)}Z`;
/** A row code in text (a ledger row or an ask code). */
const ROW = /\b(?:EPIC-\d+-[A-Z]+\d+|[A-Z]{1,4}\d+-[A-Z]\d+|[A-Z]{2,5}-[A-Z]\d+)\b/;

export interface NoteHome {
  /** The world's home checkout (its desk inbox is `desk/inbox/` there). */
  checkout: string;
  name: string;
  /** `owner/name` on GitHub, for the note's link. */
  remote?: string;
}

export interface NoteCrossDeps {
  db: DB;
  /** The paired desks (cross.ts parsePairs). */
  pairs: Map<string, string>;
  /** The desk across from a world, when both are the owner's own and live (cross.ts across). */
  across: (world: string) => { from: DeskSide; to: DeskSide } | undefined;
  home: (world: string) => NoteHome | undefined;
  /** `YYYY-MM-DD`; default NOTE_CROSS_BACKFILL_DAY (CONSOLE_NOTE_CROSS_SINCE). */
  since?: string;
  now?: () => number;
}

export const noteLink = (h: NoteHome, file: string): string => (h.remote && /^[\w.-]+\/[\w.-]+$/.test(h.remote) ? `https://github.com/${h.remote}/blob/main/${file}` : `${h.name}/${file}`);

/** His words in a note: the quoted `His words: "…"` part, else the body (cut). */
export function noteQuote(n: Pick<DeskNote, "body">): string {
  const m = /His words:\s*"([\s\S]*?)"\s*(?:\n|$)/.exec(n.body) ?? /His words:\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(n.body);
  const q = oneLine(m ? m[1] : n.body);
  return q.length > BODY_MAX ? `${q.slice(0, BODY_MAX)}…` : q;
}

const dateOf = (file: string) => /(\d{4}-\d{2}-\d{2})-[^/]*$/.exec(file)?.[1] ?? "";

/** The note is placed once the receiver answered or closed it. */
export const placed = (n: DeskNote) => n.status !== "open";

/** Where the note landed, in a few words: its row, else the answer's row, else what the close said. */
export function landedAs(n: DeskNote, answer?: DeskNote): string {
  const row = n.row || answer?.row || ROW.exec(n.answered ?? "")?.[0] || (answer ? ROW.exec(`${answer.about} ${answer.body}`)?.[0] : undefined);
  if (row) return row;
  const said = oneLine(n.answered ?? "");
  return said && !/^[\w.-]+\/[\w.-]+:desk\/inbox\//.test(said) ? `answered (${said.slice(0, 120)})` : "answered";
}

/** The line into the receiving desk: one note passed to it, his words, where it is filed. */
export function noteFromLine(id: string, from: DeskSide, to: DeskSide, n: DeskNote, link: string): string {
  const quote = noteQuote(n);
  return [
    `${CROSS_HEAD} ${from.product} desk (${id}): ${stop(n.about)}, filed as desk note ${link}.`,
    `${ownerName()}'s ${from.product} desk (${from.url}) passed this to you, the ${to.product} desk, as a desk note in this world's desk inbox (${n.file}). This line is so he sees it landed here.`,
    `This world's Delivery Manager places the note on its next wake (his ask is ready): do not place it again from this chat. Reply in one line: "From the ${from.product} desk: ${stop(n.about)}, filed as ${link}".`,
    ...(quote ? ["", `His words: "${wholeWords(quote, id)}"`] : []),
  ].join("\n");
}

/** The receipt into the sending desk once the receiver placed the note. */
export function noteReceiptLine(id: string, to: DeskSide, n: DeskNote, where: string, at: string, link: string): string {
  return [
    `${CROSS_PASSED_HEAD} ${to.product} desk (${id}): landed as ${where}, ${hhmm(at)}, ${stop(n.about)}.`,
    `The desk note this desk passed to his ${to.product} desk (${link}) was placed there by its Delivery Manager: landed as ${where}. Do nothing else. Reply in one line: "Passed to the ${to.product} desk: landed as ${where}, ${hhmm(at)}".`,
  ].join("\n");
}

interface Item {
  n: DeskNote;
  link: string;
  answer?: DeskNote;
}

/** One message into the receiving desk for the backfill day's notes that were there before this existed. */
export function backfillFromLine(day: string, from: DeskSide, to: DeskSide, items: Item[]): string {
  return [
    `${CROSS_HEAD} ${from.product} desk (backfill ${day}): ${items.length} desk note${items.length > 1 ? "s" : ""} it passed to this desk on ${day}, shown here late.`,
    `Backfill: until now a desk note from his ${from.product} desk reached only this world's desk inbox, never this chat, so ${ownerName()} could not see it landed. Each is listed once. Do not act on them from this chat: the Delivery Manager places each from the desk inbox (most already are). Reply in one line: "Backfill: ${items.length} note${items.length > 1 ? "s" : ""} from the ${from.product} desk listed".`,
    "",
    ...items.map((x, i) => `${i + 1}. ${stop(x.n.about)}, filed as ${x.link}: ${placed(x.n) ? `landed as ${landedAs(x.n, x.answer)}` : "waiting for the Delivery Manager"}`),
  ].join("\n");
}

/** One receipt message into the sending desk for the backfill day's notes already placed. */
export function backfillReceiptLine(day: string, to: DeskSide, items: Item[]): string {
  return [
    `${CROSS_PASSED_HEAD} ${to.product} desk (backfill ${day}): ${items.length} of the desk notes this desk passed on ${day} landed.`,
    `Backfill: these notes went to his ${to.product} desk before its chat showed them; each was placed there. Do nothing else. Reply in one line: "Backfill: ${items.length} note${items.length > 1 ? "s" : ""} landed at the ${to.product} desk".`,
    "",
    ...items.map((x, i) => `${i + 1}. ${stop(x.n.about)}: landed as ${landedAs(x.n, x.answer)} (${x.link})`),
  ].join("\n");
}

/** one-off markers of the note crossing (the backfill day ran), its own table so the registry scan creates it too. */
export function ensureNoteCrossMeta(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS desk_note_cross_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

export function createNoteCross(d: NoteCrossDeps) {
  const { db } = d;
  ensureCrossTables(db);
  ensureNoteCrossMeta(db);
  const now = () => (d.now ? d.now() : Date.now());
  const iso = (t = now()) => new Date(t).toISOString();
  const since = d.since || process.env.CONSOLE_NOTE_CROSS_SINCE || NOTE_CROSS_BACKFILL_DAY;
  const idOf = (key: string) => `${NOTE_ID_PREFIX}${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
  let sweeping: Promise<{ crossed: number; receipts: number; backfill: number }> | undefined;

  /** The answer note in the sender's inbox (`answered: <repo>:<path>`). */
  const answerOf = (n: DeskNote, senderInbox: DeskNote[]): DeskNote | undefined => {
    const rel = /:(desk\/inbox\/[^\s]+\.md)$/.exec(n.answered ?? "")?.[1];
    return (rel && senderInbox.find((a) => a.file === rel)) || senderInbox.find((a) => a.inReplyTo === n.file);
  };

  const insert = (key: string, from: string, to: string, state: "pending" | "passed", line: string, o: { about?: string; quote?: string; note?: string; noted?: boolean } = {}) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO desk_crossings (id, msg_key, from_world, to_world, at, state, about, quote, line, note, next_at, passed_at, noted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(idOf(key), key, from, to, iso(), state, (o.about ?? "").slice(0, 300), (o.quote ?? "").slice(0, TRANSCRIPT_MAX), line, o.note ?? null, state === "pending" ? iso() : null, state === "passed" ? iso() : null, o.noted ? iso() : null).changes;

  async function pass(): Promise<{ crossed: number; receipts: number; backfill: number }> {
    const out = { crossed: 0, receipts: 0, backfill: 0 };
    const backfilled = !!db.prepare("SELECT 1 FROM desk_note_cross_meta WHERE key = 'backfill'").get();
    for (const [receiver, sender] of d.pairs) {
      const pair = d.across(sender);
      if (!pair || pair.to.world !== receiver) continue;
      const rh = d.home(receiver);
      const sh = d.home(sender);
      if (!rh) continue;
      const senderInbox = sh ? readInbox(sh.checkout) : [];
      const notes = readInbox(rh.checkout).filter((n) => n.from === sender && !n.inReplyTo && dateOf(n.file) >= since);
      const fresh: Item[] = [];
      for (const n of notes) {
        const key = `note:${receiver}:${n.file}`;
        const link = noteLink(rh, n.file);
        const row = db.prepare("SELECT id, state, note, noted_at FROM desk_crossings WHERE msg_key = ?").get(key) as { id: string; state: string; note: string | null; noted_at: string | null } | undefined;
        if (!row) {
          if (!backfilled) {
            fresh.push({ n, link, answer: answerOf(n, senderInbox) });
            continue;
          }
          const id = idOf(key);
          if (insert(key, sender, receiver, "pending", noteFromLine(id, pair.from, pair.to, n, link), { about: n.about, quote: noteQuote(n) })) out.crossed++;
          continue;
        }
        // placed since: the receipt goes to the sending desk once its line is in (the relay's sweep sends `note`)
        if (!row.note && !row.noted_at && placed(n)) {
          const at = iso();
          db.prepare("UPDATE desk_crossings SET note = ?, note_at = ? WHERE id = ?").run(noteReceiptLine(row.id, pair.to, n, landedAs(n, answerOf(n, senderInbox)), at, link), at, row.id);
          out.receipts++;
        }
      }
      if (!backfilled && fresh.length) {
        // each note recorded as passed (no line of its own); one message per desk, delivered and retried like any line
        for (const x of fresh) {
          const key = `note:${receiver}:${x.n.file}`;
          insert(key, sender, receiver, "passed", noteFromLine(idOf(key), pair.from, pair.to, x.n, x.link), { about: x.n.about, quote: noteQuote(x.n), noted: placed(x.n) });
        }
        insert(`notes-backfill:${receiver}:${since}`, sender, receiver, "pending", backfillFromLine(since, pair.from, pair.to, fresh), { about: `backfill ${since}: ${fresh.length} desk notes` });
        const landed = fresh.filter((x) => placed(x.n));
        if (landed.length) insert(`notes-backfill-receipts:${sender}:${since}`, receiver, sender, "pending", backfillReceiptLine(since, pair.to, landed), { about: `backfill ${since}: ${landed.length} receipts` });
        out.backfill += fresh.length;
      }
    }
    if (!backfilled) db.prepare("INSERT OR IGNORE INTO desk_note_cross_meta (key, value) VALUES ('backfill', ?)").run(iso());
    return out;
  }

  return {
    /** One pass over the paired worlds' desk inboxes: new notes get their line, placed ones their receipt. */
    sweep(): Promise<{ crossed: number; receipts: number; backfill: number }> {
      sweeping ??= pass().finally(() => {
        sweeping = undefined;
      });
      return sweeping;
    },
    since,
  };
}
export type NoteCross = ReturnType<typeof createNoteCross>;
