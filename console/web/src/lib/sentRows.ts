import { useRef, useSyncExternalStore } from "react";
import type { ClosedCardRef } from "@/api/review-types";
import type { BackResult } from "@/lib/afterClose";
import { holdAfterAnswer } from "@/lib/keepPlace";

/**
 * (the owner 2026-11-15 06:09Z, vn_e00f1134: "I pasted a key and then I think
 * eventually it saved and then the card disappeared ... I was left in some random place and I didn't notice ... maybe
 * the card shrinks into a row that says sent ... collapse it and mark it as in green ... it's one row ... add comment
 * or something, it stays there"):
 *
 *   [ the card: buttons, key box, note ]  ──press saved──▶  [ ✓ Sent · Approved · its title   Add comment ]
 *                                                              stays in the same place, the page does not move
 *
 * Every answer kind (a key saved, Yes/No/an option, Done, Park, Snooze, a note sent, a review press) marks its card
 * here by its slot (`ask:<id>`, `review:<id>`, the same id as `data-inbox-card`). The card shows the Sent row instead
 * of itself, and the list keeps that row where the card was after the refetch drops the card (keepSent). Module
 * state, so it outlives the card and every list that shows it agrees. Kept for the page's life (SENT_KEEP_MS at most).
 */
export const SENT_KEEP_MS = 2 * 60 * 60_000;

export interface SentEntry {
  id: number;
  /** what he did, in a few words ("Approved", "Key saved", "Parked for a month") */
  said: string;
  title: string;
  /** one quiet line under it, when the press has more to say (where a saved key went) */
  detail?: string;
  /** a link under the detail line that opens what was saved (a saved key's item in his own vault) */
  link?: { href: string; text: string };
  /** the row or ask Add comment files to; absent = nowhere to file (a persona's request) */
  card?: ClosedCardRef;
  back?: () => Promise<BackResult>;
  at: number;
  /**
   * E948-S140 (the owner 17 Nov 21:39Z: "I just want to see the last one that was done. I don't want to see 20 cards
   * parked."): the card stays answered (it never comes back as a card) but its green row is off the page: an older
   * answer once a newer one was sent, or a row he swiped away or closed with its x (E948-S145).
   */
  gone?: boolean;
  /** E948-S141 iteration 2: answered on another device (the server's press log), never pressed in this browser */
  server?: boolean;
  /**
   * E948-S174 (the owner 22 Nov 18:56Z, vn_3b3cf02e: "the moment I press Send, it compacts into this row. It's just that
   * instead of saying Sent, it stays spinning until it fully has been sent"): a voice note on its way from this card, by
   * its note's key. The row spins until the card's press has it, then a plain Sent entry replaces this one. Never kept
   * across a reload (the note itself is safe on the phone and sends by itself).
   */
  voice?: string;
  /** E948-S174: the voice note did not reach the card: why, said on the row with Send again. */
  failed?: string;
  /** E948-S174: an empty recording (0 s, no audio): nothing was sent, the row says so in `said`; Bring it back shows the card */
  dropped?: boolean;
}

/**
 * E948-S130 (the owner 17 Nov 17:28Z, vn_4f13161d: "after a text is sent, it ... collapses and remains there for you to add
 * things ... basically all cards should have the same behavior"): the Sent rows outlive a reload. Every entry (without its
 * Bring it back, a function) and each list's last order are kept in this browser's localStorage for SENT_KEEP_MS, so a
 * reload draws the same green rows where the cards were, never the answered card again.
 */
const STORE = "inbox.sent.v1";
const PLACES = "inbox.sentPlaces.v1";
const storage = (): Storage | undefined => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
};
/** the newer of two answers: the later press, then the higher id (two tabs can number alike) */
const newer = (a: SentEntry, b: SentEntry) => a.at > b.at || (a.at === b.at && a.id > b.id);
const same = (a: SentEntry, b: SentEntry) => a.at === b.at && a.id === b.id;
/**
 * the one answer whose green row may show in the whole inbox: the newest one not swiped away. The owner 17 Nov 23:22Z
 * (E948-S140 iteration 2, four rows on his phone an hour after the release): "Can we only have the last one and then the
 * other ones vanish? ... I've asked you five times." Answers stored before the rule shipped (an older build in his open
 * app, or another tab) carried no `gone`, so every one of them showed; now only this one can.
 */
function newestShown(m: Map<string, SentEntry>, now = Date.now()): SentEntry | undefined {
  let best: SentEntry | undefined;
  for (const e of m.values()) if (!e.gone && now - e.at < SENT_KEEP_MS && (!best || newer(e, best))) best = e;
  return best;
}
/** every answer but the newest is marked gone (its card stays answered, its row off the page) */
function onlyNewest(m: Map<string, SentEntry>): Map<string, SentEntry> {
  const keep = newestShown(m);
  return new Map([...m].map(([k, v]) => [k, v.gone || (keep && same(v, keep)) ? v : { ...v, gone: true }]));
}
function loadSent(): Map<string, SentEntry> {
  try {
    const raw = storage()?.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as [string, SentEntry][]) : [];
    const now = Date.now();
    return onlyNewest(new Map(list.filter(([k, e]) => typeof k === "string" && e && typeof e.at === "number" && now - e.at < SENT_KEEP_MS)));
  } catch {
    return new Map();
  }
}
function saveSent(m: Map<string, SentEntry>) {
  try {
    const now = Date.now();
    storage()?.setItem(STORE, JSON.stringify([...m].filter(([, e]) => now - e.at < SENT_KEEP_MS && !e.voice && !e.dropped).map(([k, { back: _b, ...e }]) => [k, e])));
  } catch {
    /* a full or private store: the rows still show until the page closes */
  }
}
let sent = loadSent();
let seq = Math.max(0, ...[...sent.values()].map((e) => e.id));
/** Sent rows on the page now (a slot drawn by a list or a card), so the floating note stays away when one shows. */
const mounted = new Map<string, number>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
// another tab or window of the inbox answered a card: its newer answer is the one row here too
if (typeof window !== "undefined")
  window.addEventListener("storage", (ev) => {
    if (ev.key !== STORE) return;
    const theirs = loadSent();
    const next = new Map(sent);
    for (const [k, v] of theirs) {
      const mine = next.get(k);
      if (!mine || newer(v, mine) || (same(v, mine) && v.gone)) next.set(k, v);
    }
    sent = onlyNewest(next);
    seq = Math.max(seq, ...[...sent.values()].map((e) => e.id));
    emit();
  });

/** Mark one card (or several cards closed by one press: a set) as sent; returns the entry. */
export function markSent(slots: string | string[], e: Omit<SentEntry, "id" | "at" | "gone">): SentEntry {
  const entry: SentEntry = { ...e, id: ++seq, at: Date.now() };
  lastAnswer = entry.at;
  // E948-S208: his place holds (or moves on to the next card still waiting), measured before the card turns into its row
  holdAfterAnswer([slots].flat());
  // E948-S140: only the newest answer keeps its green row; every earlier one leaves the page (still answered)
  const next = new Map([...sent].map(([k, v]) => [k, v.gone ? v : { ...v, gone: true }]));
  for (const s of [slots].flat()) next.set(s, entry);
  sent = next;
  saveSent(sent);
  emit();
  return entry;
}

/** E948-S208: when he last answered a card in this page (markSent), so a section that just emptied knows it was him. */
let lastAnswer = 0;
export const answeredWithin = (ms: number, now = Date.now()) => lastAnswer > 0 && now - lastAnswer < ms;

/** The card is back (Bring it back, or the press failed): it shows as a card again. */
export function unmarkSent(slots: string | string[]) {
  const list = [slots].flat().filter((s) => sent.has(s));
  if (!list.length) return;
  const next = new Map(sent);
  list.forEach((s) => next.delete(s));
  sent = next;
  saveSent(sent);
  emit();
}

/**
 * E948-S141 iteration 2 (the owner 18 Nov 18:30Z, his phone and his laptop side by side: "See counters on phone vs desktop.
 * It's broken nasty."): his laptop showed "Decisions waiting on you 0" and no red pill, his phone "2" and a red 2 over the
 * same inbox. A Sent mark lived only in the browser that pressed (its localStorage), and the server keeps listing some
 * answered cards for a while (a review card he sent words on stays listed until it is relaunched), so the device that
 * answered left the card out of every count and the other device still counted it. Now his answers from every device
 * come from the server (GET /api/presses/answered, the newest press per card in the last two hours) and one rule reads
 * them on both:
 *
 *   pressed here or on any device, still landing or landed   →  answered: out of every list and count (no green row)
 *   its newest press failed or was brought back             →  open again: this browser's mark goes too
 */
export interface ServerAnswer {
  target: string;
  at: string;
  action: string;
  state: string;
}
/** the slots one pressed card id can stand for (an ask, a red node, a review card, a team card): data-inbox-card */
export const SERVER_SLOT_KINDS = ["ask", "status", "review", "team"] as const;
const LANDS = new Set(["landing", "landed"]);
/** Pure: the Sent marks with the server's answers in (every device's), and this browser's marks its failed press undid. */
export function withServerAnswers(m: Map<string, SentEntry>, answers: ServerAnswer[], now = Date.now()): Map<string, SentEntry> {
  const next = new Map(m);
  // the count check, 25 Nov 13:04Z: the top bar showed red 10 on the phone, 9 on the laptop. The log can list
  // two presses on one card (a landed answer and a later failed one). Read in list order, the laptop (no mark of its own)
  // took the landed one as a server mark that the later failure never removed, while the phone's own mark was removed
  // by it: one card answered on the laptop, open on the phone. Now only each card's newest press counts, on every device.
  const newest = new Map<string, { at: number; lands: boolean }>();
  for (const a of answers) {
    const at = Date.parse(a.at);
    if (!Number.isFinite(at) || now - at >= SENT_KEEP_MS) continue;
    const had = newest.get(a.target);
    if (!had || at > had.at) newest.set(a.target, { at, lands: LANDS.has(a.state) });
  }
  // the server's earlier answers whose card's newest press no longer lands (failed, brought back, or no longer listed) leave
  for (const [k, v] of next) if (v.server && !newest.get(k.slice(k.indexOf(":") + 1))?.lands) next.delete(k);
  let n = 0;
  for (const [target, { at, lands }] of newest) {
    for (const kind of SERVER_SLOT_KINDS) {
      const slot = `${kind}:${target}`;
      const mine = next.get(slot);
      if (lands) {
        if (!mine) next.set(slot, { id: -++n, said: "Answered", title: "", at, gone: true, server: true });
      } else if (mine && !mine.server && mine.at <= at + 60_000) {
        // failed or brought back after this mark: the card is his to answer again, here as on every other device
        next.delete(slot);
      }
    }
  }
  return next;
}
let serverKey = "";
/** Fold the server's answers in (lib/inbox reads them with the status batch and the review list). */
export function applyServerAnswers(answers: ServerAnswer[] | undefined) {
  if (!answers) return;
  const key = answers.map((a) => `${a.target}|${a.at}|${a.state}`).join(" ");
  if (key === serverKey) return;
  serverKey = key;
  const next = withServerAnswers(sent, answers);
  const same = next.size === sent.size && [...next].every(([k, v]) => sent.get(k) === v);
  if (same) return;
  sent = next;
  saveSent(sent);
  emit();
}

const live = (e: SentEntry | undefined, now = Date.now()) => (e && now - e.at < SENT_KEEP_MS ? e : undefined);
/** E948-S140: an answered card whose green row still shows (the newest answer, not swiped away). */
export const shownSent = (e: SentEntry | undefined) => {
  const top = newestShown(sent);
  return live(e) && !e!.gone && top && same(e!, top) ? e : undefined;
};

/** E948-S145: he swiped the Sent row away (phone) or closed it with its x (desktop): the card stays answered, the row goes. */
export function dismissSent(slot: string) {
  const e = sent.get(slot);
  if (!e || e.gone) return;
  const next = new Map(sent);
  for (const [k, v] of sent) if (v.id === e.id) next.set(k, { ...v, gone: true });
  sent = next;
  saveSent(sent);
  emit();
}

export const sentOf = (slot: string) => live(sent.get(slot));
/**
 * (the owner 16 Nov, "why showing one, none left???"): an item he answered here (its card or status row is a green
 * Sent row now) is no longer open for him, so no red count holds it, even while the server's status batch still lists it.
 */
export const answeredHere = (id: string) => answeredSlot(`ask:${id}`) || answeredSlot(`status:${id}`);
/**
 * E948-S141 (the owner 18 Nov, "Must have given this feedback more than 20 times"): a card he answered here, by its slot
 * (`review:<id>`, `team:<id>`, `ask:<id>`, `status:<id>`), whether its green row shows or not. Every inbox count leaves
 * it out (lib/inbox `openCards`), so no pill counts a card the section no longer draws.
 */
export const answeredSlot = (slot: string) => !!live(sent.get(slot));
/** Re-render on every Sent mark (the counts read `answeredHere`). */
export const useSentVersion = () => useSyncExternalStore(subscribe, () => sent);
export function useSent(slot: string | undefined): SentEntry | undefined {
  const e = useSyncExternalStore(subscribe, () => (slot ? sent.get(slot) : undefined));
  return live(e);
}
const useSentMap = () => useSyncExternalStore(subscribe, () => sent);

/** A Sent row for this slot is on the page (the floating note need not show). */
export const sentShown = (slot: string) => (mounted.get(slot) ?? 0) > 0;
export function sentMounted(slot: string): () => void {
  mounted.set(slot, (mounted.get(slot) ?? 0) + 1);
  emit();
  return () => {
    const n = (mounted.get(slot) ?? 1) - 1;
    if (n > 0) mounted.set(slot, n);
    else mounted.delete(slot);
    emit();
  };
}
export const useSentShown = (slot: string | undefined) => useSyncExternalStore(subscribe, () => !!slot && sentShown(slot));

/** Pure: the new list, with each sent card that left it kept at its old place (after the card that was before it). */
export function keepPlaces<T>(prev: { slot: string; item?: T }[], items: T[], slotOf: (t: T) => string, isSent: (slot: string) => boolean): { slot: string; item?: T }[] {
  const out: { slot: string; item?: T }[] = items.map((item) => ({ slot: slotOf(item), item }));
  const here = new Set(out.map((r) => r.slot));
  prev.forEach((p, n) => {
    if (here.has(p.slot) || !isSent(p.slot)) return;
    // after the nearest earlier place still in the list, else first
    let at = 0;
    for (let k = n - 1; k >= 0; k--) {
      const i = out.findIndex((r) => r.slot === prev[k].slot);
      if (i >= 0) {
        at = i + 1;
        break;
      }
    }
    out.splice(at, 0, { slot: p.slot });
    here.add(p.slot);
  });
  return out;
}

/**
 * A list keeps its sent cards in place: each row is `{slot, item}` (a card still listed) or `{slot}` (it left the
 * list after he answered it: draw its Sent row there). One press that closed several cards (a set) keeps one row.
 */
export function useKeepSent<T>(items: T[], slotOf: (t: T) => string, list?: string): { slot: string; item?: T; sent?: SentEntry }[] {
  const map = useSentMap();
  // E948-S130: a named list starts from its order before the reload, so a sent card that left keeps its place
  const prev = useRef<{ slot: string; item?: T }[] | undefined>(undefined);
  if (prev.current === undefined) prev.current = list ? loadPlaces(list) : [];
  const kept = keepPlaces(prev.current, items, slotOf, (s) => !!live(map.get(s)));
  // an empty list (still loading after a reload) keeps the order it had, so the cards around a Sent row are not lost
  const saved = useRef("");
  if (list) {
    // written when the order or which of them are sent changed (a press marks one without changing the order). An empty
    // list (loading after a reload, or he just answered its last card) writes the order it had, never a shorter one.
    const order = items.length ? kept : prev.current;
    const now = order.map((r) => `${r.slot}${live(map.get(r.slot)) ? "*" : ""}`).join(" ");
    if (now !== saved.current) {
      savePlaces(list, order);
      saved.current = now;
    }
  }
  if (items.length || !list) prev.current = kept;
  const seen = new Set<number>();
  const out: { slot: string; item?: T; sent?: SentEntry }[] = [];
  for (const r of kept) {
    const e = live(map.get(r.slot));
    if (e && seen.has(e.id)) continue;
    if (e) seen.add(e.id);
    if (!r.item && !e) continue;
    if (e && !shownSent(e)) continue; // E948-S140: answered earlier, or swiped away: neither the card nor its row shows
    out.push(e ? { ...r, sent: e } : r);
  }
  return out;
}

/** a list's last order (its slots), kept while it holds a Sent row; read once when the list first draws after a reload. */
function loadPlaces(list: string): { slot: string }[] {
  try {
    const all = JSON.parse(storage()?.getItem(PLACES) ?? "{}") as Record<string, string[]>;
    return (all[list] ?? []).filter((s) => typeof s === "string").map((slot) => ({ slot }));
  } catch {
    return [];
  }
}
function savePlaces(list: string, rows: { slot: string }[]) {
  try {
    const st = storage();
    if (!st) return;
    const all = JSON.parse(st.getItem(PLACES) ?? "{}") as Record<string, string[]>;
    if (rows.some((r) => live(sent.get(r.slot)))) all[list] = rows.map((r) => r.slot);
    else delete all[list];
    st.setItem(PLACES, JSON.stringify(all));
  } catch {
    /* as above */
  }
}

/** Tests only. */
export const resetSent = () => {
  sent = new Map();
  lastAnswer = 0;
  serverKey = "";
  try {
    storage()?.removeItem(STORE);
    storage()?.removeItem(PLACES);
  } catch {
    /* none */
  }
  mounted.clear();
  emit();
};
