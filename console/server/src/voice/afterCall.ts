import type { DB } from "../db.js";
import { isOwnerWho, memoryName, ownerName } from "../identity.js";
import { saidYes, type InboxCard } from "./inbox.js";
import { answerIn, type DeskPort } from "./voice.js";

/**
 * The check after a call (the owner asked that a call be kept and checked like a voice note: "so that we can check whether
 * actions actually taken, line up"). Every call is kept whole in the memory service (the hosted forward) and, once it has
 * settled, one check sets what he asked beside what the call did:
 * - asked: each yes he gave on a card of the walk, and each line where he asked the call to do something;
 * - did: each press with its landing (the press log's commit), each question or feedback sent to the desk with its answer;
 * - gaps: a yes with no press (and his own press after, when he did it himself), a press that did not land, a question the
 *   desk never got or never answered, a transcript not in the memory service.
 * The check is kept on the call (voice_calls.after_check) and posted once to the call's desk as one line, with the link to
 * the transcript: a gap is never silent, the desk turns each one into a row or an ask.
 */

export const AFTER_CHECK_HEAD = "📞 After the call";
/** a call is checked once it has been over this long (its last press has landed by then). */
export const AFTER_CHECK_SETTLE_MS = 90_000;
/** the desk line waits this long for the transcript to land in the memory service, then goes with that gap. */
export const AFTER_CHECK_MEMORY_WAIT_MS = 15 * 60_000;
/** calls ended before this were never checked (the check's first real case is the first one checked). */
export const AFTER_CHECK_SINCE = "2026-11-18T03:30:00.000Z";
/** a press his own button made after the call is still his answer to that card for this long. */
const OWN_PRESS_AFTER_MS = 30 * 60_000;
/** a desk answer that comes after the check still lands on its call question for this long after the call. */
export const LATE_ANSWER_MS = 6 * 60 * 60_000;

/** One transcript line as the page stores it. */
export interface CallLine {
  who: string;
  text: string;
  at?: string;
  feedback?: string;
}

export interface CallCheck {
  callId: string;
  checkedAt: string;
  asked: string[];
  did: string[];
  gaps: string[];
  /** the memory service's note for the whole transcript, once it landed. */
  memory?: { state: string; ref?: string; url?: string };
}

/** Where a call's transcript is in the memory service (the hosted forward), when it knows. */
export type MemoryKept = (callId: string) => { state: string; ref?: string; url?: string; error?: string } | undefined;

const REQUEST = /\b(?:can you|could you|would you|will you|please|pass (?:this|that|it|on)|give (?:the |that |this )?feedback|tell (?:the|them|him)|send (?:it|this|that)|i want|i'd like|i would like)\b/i;
const PLACE = /\bcard (\d+) of (\d+)\b/;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const offset = (at: string | undefined, start: string) => {
  if (!at) return "";
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(start)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} `;
};

/** The whole call as it reads in the memory service: each line with its minute, who said it, and what the call did. */
export function fullTranscript(lines: CallLine[], startedAt: string): string[] {
  return lines
    .filter((l) => l && typeof l.text === "string" && l.text.trim())
    .map((l) => `${offset(l.at, startedAt)}${isOwnerWho(l.who) ? `${ownerName()}:` : l.who === "tool" ? "Call did:" : "Voice:"} ${clip(l.text, 2000)}`);
}

/** a card as the check names it: its code and title. */
const cardName = (c: InboxCard | undefined, n: number) => (c ? `card ${n} ${c.code ? `${c.code} ` : ""}"${clip(c.title, 80)}"` : `card ${n}`);

interface PressRow {
  at: string;
  target: string;
  route: string | null;
  action: string;
  state: string;
  sha: string | null;
  result: string | null;
}

/**
 * The check of one ended call: pure over the console's own tables (voice_calls, voice_asks, the press log), plus what the
 * desk answered (`answerOf`, a question's head) and where the memory has the transcript (`kept`).
 */
export function checkCall(db: DB, callId: string, o: { now?: () => number; answerOf?: (head: string) => string | undefined; kept?: MemoryKept } = {}): CallCheck | undefined {
  const c = db.prepare("SELECT id, started_at, ended_at, transcript, inbox FROM voice_calls WHERE id = ?").get(callId) as
    | { id: string; started_at: string; ended_at: string | null; transcript: string | null; inbox: string | null }
    | undefined;
  if (!c?.ended_at) return undefined;
  let lines: CallLine[] = [];
  let cards: InboxCard[] = [];
  try {
    lines = (JSON.parse(c.transcript ?? "[]") as CallLine[]).filter((l) => l && typeof l.text === "string");
  } catch {
    /* an unreadable transcript: checked as empty */
  }
  try {
    cards = c.inbox ? (JSON.parse(c.inbox) as InboxCard[]) : [];
  } catch {
    /* no cards */
  }
  const asked: string[] = [];
  const did: string[] = [];
  const gaps: string[] = [];
  let presses: PressRow[] = [];
  try {
    presses = db
      .prepare("SELECT at, target, route, action, state, sha, result FROM presses WHERE at >= ? AND at <= ? ORDER BY at")
      .all(c.started_at, new Date(Date.parse(c.ended_at) + OWN_PRESS_AFTER_MS).toISOString()) as PressRow[];
  } catch {
    /* no press log on this console */
  }
  const pressesOf = (card: InboxCard | undefined) => (card ? presses.filter((p) => p.target === card.id || (p.route ?? "").includes(`/${card.id}/`)) : []);
  const landing = (p: PressRow | undefined) => (!p ? "no press in the press log" : p.sha ? `landed ${p.sha}` : p.state === "landed" ? "landed" : `${p.state}${p.result ? ` (${clip(p.result, 80)})` : ""}`);

  // walk the lines: the card he is on, his yes on it, and the call's press on it
  let pos = 0;
  const onCard = new Map<number, { yes?: string; pressedAt?: string; button?: string; done?: string }>();
  for (const l of lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    if (l.who === "tool") {
      const m = PLACE.exec(text);
      if (m) pos = Number(m[1]);
      const press = /^pressed (.+?) on (?:card \d+ of \d+|the card): (.*)$/.exec(text);
      if (press && pos) onCard.set(pos, { ...onCard.get(pos), pressedAt: l.at, button: press[1], done: press[2] });
      continue;
    }
    if (!isOwnerWho(l.who)) continue;
    if (pos && saidYes(text)) {
      const k = onCard.get(pos) ?? {};
      if (!k.yes) onCard.set(pos, { ...k, yes: text });
    }
    if (REQUEST.test(text)) asked.push(`"${clip(text, 220)}"`);
  }
  const yeses: string[] = [];
  for (const [n, k] of [...onCard.entries()].sort((a, b) => a[0] - b[0])) {
    const card = cards[n - 1];
    const name = cardName(card, n);
    if (k.yes) yeses.push(`yes on ${name}: "${clip(k.yes, 120)}"`);
    const own = pressesOf(card);
    if (k.button) {
      const p = own.find((x) => !k.pressedAt || Math.abs(Date.parse(x.at) - Date.parse(k.pressedAt)) < 120_000) ?? own[0];
      const failed = /^not pressed/.test(k.done ?? "");
      did.push(`pressed ${k.button} on ${name}: ${failed ? k.done : landing(p)}`);
      if (failed) gaps.push(`${name}: the press did not go through (${clip(k.done ?? "", 100)})`);
      else if (!p?.sha && p?.state !== "landed") gaps.push(`${name}: pressed ${k.button} but it has not landed (${landing(p)})`);
    } else if (k.yes) {
      const after = own.find((x) => Date.parse(x.at) >= Date.parse(c.ended_at!) - 5_000);
      gaps.push(
        after
          ? `${name}: he said yes on the call, the call pressed nothing; he pressed it himself after the call (${after.action}, ${landing(after)})`
          : `${name}: he said yes on the call, nothing was pressed`,
      );
    }
  }

  asked.unshift(...yeses);

  // questions and feedback sent to the desk, each with its answer
  const asks = db.prepare("SELECT id, head, request, kind, send_error, answer FROM voice_asks WHERE call_id = ? ORDER BY n").all(callId) as {
    id: string;
    head: string;
    request: string;
    kind: string | null;
    send_error: string | null;
    answer: string | null;
  }[];
  for (const a of asks) {
    const what = `${a.kind === "feedback" ? "feedback" : "question"} ${a.id} to the desk: "${clip(a.request, 160)}"`;
    if (a.send_error) {
      did.push(`${what}: not delivered`);
      gaps.push(`${a.id}: the desk never got it (${clip(a.send_error, 100)})`);
      continue;
    }
    const answer = a.answer ?? o.answerOf?.(a.head);
    // the desk's answer lands on the call question it answers, even when it came after the call ended.
    if (answer && !a.answer) db.prepare("UPDATE voice_asks SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(answer, new Date(o.now?.() ?? Date.now()).toISOString(), a.id);
    did.push(`${what}: ${answer ? `answered "${clip(answer, 160)}"` : "no answer yet"}`);
    if (!answer) gaps.push(`${a.id}: the desk has not answered it`);
  }

  // the transcript in the memory service
  const k = o.kept?.(callId);
  const memory = k ? { state: k.state, ...(k.ref ? { ref: k.ref } : {}), ...(k.ref && k.url ? { url: k.url } : {}) } : undefined;
  if (k && !k.ref && ["failed", "skipped", "waiting"].includes(k.state)) gaps.push(`the transcript is not in ${memoryName()} (${k.state}${k.error ? `: ${clip(k.error, 100)}` : ""})`);
  const now = o.now?.() ?? Date.now();
  if (k && !k.ref && !["failed", "skipped", "waiting"].includes(k.state) && now - Date.parse(c.ended_at) >= AFTER_CHECK_MEMORY_WAIT_MS) gaps.push(`the transcript has not landed in ${memoryName()} yet (${k.state})`);
  return { callId, checkedAt: new Date(now).toISOString(), asked, did, gaps, ...(memory ? { memory } : {}) };
}

/** The one desk line: what he asked, what the call did, the gaps, and where the transcript is. */
export function checkText(ch: CallCheck): string {
  const list = (xs: string[], none: string) => (xs.length ? xs.map((x) => `- ${x}`) : [`- ${none}`]);
  return [
    `${AFTER_CHECK_HEAD} (${ch.callId}): ${ch.gaps.length ? `${ch.gaps.length} gap${ch.gaps.length === 1 ? "" : "s"}` : "no gap"}`,
    ch.gaps.length
      ? `${ownerName()}'s call is checked against what it did. Turn each gap into a row, a fix or one inbox ask now (his words are in the transcript), never a question in this chat; reply in one line naming where each went.`
      : "Record only: nothing to act on.",
    `Transcript in ${memoryName()}: ${ch.memory?.ref ? `${ch.memory.url ?? ch.memory.ref}${ch.memory.url ? ` (${ch.memory.ref})` : ""}` : ch.memory ? `not landed yet (${ch.memory.state})` : "not sent (forward off)"}`,
    "He asked:",
    ...list(ch.asked, "nothing beyond talking"),
    "The call did:",
    ...list(ch.did, "nothing"),
    ...(ch.gaps.length ? ["Gaps:", ...ch.gaps.map((g) => `- ${g}`)] : []),
  ].join("\n");
}

export function ensureAfterCallColumns(db: DB): void {
  const cols = new Set((db.prepare("PRAGMA table_info(voice_calls)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("after_check")) db.exec("ALTER TABLE voice_calls ADD COLUMN after_check TEXT");
  if (!cols.has("after_check_at")) db.exec("ALTER TABLE voice_calls ADD COLUMN after_check_at TEXT");
}

/**
 * The runner: every tick, each call ended since AFTER_CHECK_SINCE that is settled (90 s) and not yet checked is checked; its
 * desk line goes once the transcript landed in the memory service (with its link) or after 15 min (with that gap). `deskOf` is the
 * desk of the call's scope (the Team desk, a world desk or a campaign chat), the one its transcript was posted to.
 */
export function createAfterCall(o: { db: DB; deskOf: (call: { tenant_id: string | null; milestone_id: string | null }) => DeskPort | undefined; kept?: MemoryKept; now?: () => number; page?: string }) {
  const { db } = o;
  ensureAfterCallColumns(db);
  const now = () => o.now?.() ?? Date.now();
  let running = false;
  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let n = 0;
    try {
      const due = db
        .prepare(
          `SELECT id, tenant_id, milestone_id, ended_at, transcript_posted_at FROM voice_calls WHERE ended_at IS NOT NULL AND after_check_at IS NULL
             AND ended_at >= ? AND ended_at <= ? AND (transcript IS NOT NULL OR transcript_posted_at IS NOT NULL) ORDER BY ended_at LIMIT 10`,
        )
        .all(AFTER_CHECK_SINCE, new Date(now() - AFTER_CHECK_SETTLE_MS).toISOString()) as { id: string; tenant_id: string | null; milestone_id: string | null; ended_at: string }[];
      for (const r of due) {
        const desk = o.deskOf(r);
        let view: Awaited<ReturnType<DeskPort["view"]>> | undefined;
        try {
          view = await desk?.view();
        } catch {
          /* the desk is not readable now: answers count as not seen */
        }
        const ch = checkCall(db, r.id, { now, kept: o.kept, answerOf: (head) => (view ? answerIn(view, head).answer : undefined) });
        if (!ch) continue;
        db.prepare("UPDATE voice_calls SET after_check = ? WHERE id = ?").run(JSON.stringify(ch), r.id);
        // the desk line waits for the memory's link, at most 15 min
        const waiting = ch.memory && !ch.memory.ref && !["failed", "skipped", "waiting"].includes(ch.memory.state) && now() - Date.parse(r.ended_at) < AFTER_CHECK_MEMORY_WAIT_MS;
        if (waiting) continue;
        if (desk) {
          try {
            await desk.send(checkText(ch), o.page ?? "voice call", `voice-check-${r.id}`);
          } catch (e) {
            console.error(`[voice] after-call check of ${r.id}: the desk did not take it (${(e as Error).message.slice(0, 120)})`);
            continue;
          }
        }
        db.prepare("UPDATE voice_calls SET after_check_at = ? WHERE id = ?").run(new Date(now()).toISOString(), r.id);
        console.log(`[voice] ${r.id} checked after the call: ${ch.gaps.length} gap(s)`);
        n++;
      }
      // a question the desk answered after the check ran: its answer lands on the question and the kept check is
      // refreshed (no second desk line), for calls ended in the last LATE_ANSWER_MS.
      const late = db
        .prepare(
          `SELECT DISTINCT c.id, c.tenant_id, c.milestone_id FROM voice_calls c JOIN voice_asks a ON a.call_id = c.id
             WHERE c.after_check_at IS NOT NULL AND c.ended_at >= ? AND a.answer IS NULL AND a.send_error IS NULL LIMIT 5`,
        )
        .all(new Date(now() - LATE_ANSWER_MS).toISOString()) as { id: string; tenant_id: string | null; milestone_id: string | null }[];
      for (const r of late) {
        let view: Awaited<ReturnType<DeskPort["view"]>> | undefined;
        try {
          view = await o.deskOf(r)?.view();
        } catch {
          continue;
        }
        if (!view) continue;
        const ch = checkCall(db, r.id, { now, kept: o.kept, answerOf: (head) => answerIn(view!, head).answer });
        if (ch) db.prepare("UPDATE voice_calls SET after_check = ? WHERE id = ?").run(JSON.stringify(ch), r.id);
      }
    } finally {
      running = false;
    }
    return n;
  }
  /** the check kept on a call (for the API), when it ran. */
  const get = (callId: string): CallCheck | undefined => {
    const r = db.prepare("SELECT after_check FROM voice_calls WHERE id = ?").get(callId) as { after_check: string | null } | undefined;
    try {
      return r?.after_check ? (JSON.parse(r.after_check) as CallCheck) : undefined;
    } catch {
      return undefined;
    }
  };
  return { tick, get };
}
export type AfterCall = ReturnType<typeof createAfterCall>;
