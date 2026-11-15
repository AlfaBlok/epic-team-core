import { useSyncExternalStore } from "react";
import { api, type ReviewItem, type SnoozeChoice, type SnoozeDays, type WaitingItem } from "@/api";
import { mutate } from "@/lib/data";

// a snooze refreshes only the inbox queries (tag "inbox": waiting lists and status batches); refetching every
// list after a write queued the next tap's POST behind ~15 slow GETs (the browser's 6 connections per host).

/**
 * a snooze shows at once. The pick
 * hides the card and the list shows "Snoozing … until …" with a spinner while the server commits and pushes the spine
 * line; if the write fails the card comes back with the reason on its Snooze button. Module state, so it outlives the
 * card (the card unmounts the moment it hides) and every list that shows the ask agrees.
 */
type Entry = { until: string; label: string; done?: boolean };
let entries = new Map<string, Entry>();
let errors = new Map<string, string>();
/** Asks just unsnoozed here: open again before the server's status batch (refreshed in the background) lists them. */
let back = new Map<string, number>();
let version = 0;
const subs = new Set<() => void>();
const emit = () => {
  version++;
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const set = <V>(m: Map<string, V>, id: string, v: V | undefined) => {
  const next = new Map(m);
  if (v === undefined) next.delete(id);
  else next.set(id, v);
  return next;
};

/** an ask shown on a monitor alert acts through the alert (its own repo and world, any world). */
export const relayOf = (item: Pick<WaitingItem, "relay">) => (item.relay ? { relay: item.relay } : {});

/** How long a written snooze keeps its "Snoozed … until …" line (and its override, while the refetch lands). */
export const SNOOZED_SHOW_MS = 4_000;

/** The day the server writes for `days` (routes.ts snoozeDate: now + days, as a UTC calendar date). */
export const snoozeUntil = (days: number, now = Date.now()) => new Date(now + days * 86_400_000).toISOString().slice(0, 10);
/** the UTC minute the server writes for `hours` (asks.ts snoozeMinute: now + hours, rounded up to the minute). */
export const snoozeMinute = (hours: number, now = Date.now()) => new Date(Math.ceil((now + hours * 3_600_000) / 60_000) * 60_000).toISOString().slice(0, 16) + "Z";
const asChoice = (c: SnoozeChoice | SnoozeDays): SnoozeChoice => (typeof c === "number" ? { days: c } : c);
/** What an ask line gets for a choice: a day for days, a minute for hours. */
export const snoozeUntilFor = (c: SnoozeChoice | SnoozeDays, now = Date.now()) => {
  const x = asChoice(c);
  return x.hours ? snoozeMinute(x.hours, now) : snoozeUntil(x.days!, now);
};
/** a snooze still ahead (a day: until that UTC day starts; a minute: until then). Mirrors the server's snoozedNow. */
export const snoozeActive = (until: string | undefined, now = Date.now()) =>
  !!until && (until.length === 10 ? until > new Date(now).toISOString().slice(0, 10) : Date.parse(until) > now);

/** The hide-at-once, spinner, "Snoozed" line and error-on-failure of one snooze write (asks and, review cards). */
async function run(id: string, until: string, label: string, write: () => Promise<{ snoozedUntil?: string | null }>): Promise<void> {
  entries = set(entries, id, { until, label });
  errors = set(errors, id, undefined);
  emit();
  try {
    const r = await mutate(write, "inbox");
    entries = set(entries, id, { until: r.snoozedUntil ?? until, label, done: true });
    emit();
    setTimeout(() => {
      if (entries.get(id)?.done) {
        entries = set(entries, id, undefined);
        emit();
      }
    }, SNOOZED_SHOW_MS);
  } catch (e) {
    entries = set(entries, id, undefined);
    errors = set(errors, id, `Snooze failed, the card is back: ${e instanceof Error ? e.message : String(e)}`);
    emit();
  }
}

/** Pick a snooze: the card hides now; resolves once the spine line is pushed (or the card is back with the error). */
export function snoozeItem(item: WaitingItem, choice: SnoozeChoice | SnoozeDays, label = item.code ?? item.title, park = false): Promise<void> {
  const c = asChoice(choice);
  return run(item.id, snoozeUntilFor(c), label, () => api.snoozeWaiting(item.id, { ...c, milestoneId: item.milestoneId, ...relayOf(item), ...(park ? { park: true as const } : {}) }));
}

/** Snooze on a review card: the same instant hide, spinner line and error as an ask (the server writes its row). */
export function snoozeReview(item: ReviewItem, choice: SnoozeChoice, label = item.ref ?? item.title, park = false): Promise<void> {
  const hours = (choice.hours ?? 0) + (choice.days ?? 0) * 24;
  return run(item.id, snoozeMinute(hours), label, () => api.snoozeReviewItem(item.id, { ...choice, ...(park ? { park: true as const } : {}) }));
}

/** Unsnooze a review card: resolves once written; the card is back in the list at once (throws on failure). */
export async function unsnoozeReview(item: ReviewItem): Promise<void> {
  await mutate(() => api.snoozeReviewItem(item.id, { until: null }), "inbox");
  back = set(back, item.id, Date.now());
  entries = set(entries, item.id, undefined);
  emit();
  setTimeout(() => {
    back = set(back, item.id, undefined);
    emit();
  }, BACK_MS);
}

/** How long a just-unsnoozed ask counts as open without the status batch listing it. */
export const BACK_MS = 30_000;

/** Unsnooze: resolves once the spine line is pushed; the ask then counts as open at once (throws on failure). */
export async function unsnoozeItem(item: WaitingItem): Promise<void> {
  await mutate(() => api.snoozeWaiting(item.id, { until: null, milestoneId: item.milestoneId, ...relayOf(item) }), "inbox");
  back = set(back, item.id, Date.now());
  entries = set(entries, item.id, undefined); // a "Snoozed" line still showing must not hide the card again
  emit();
  setTimeout(() => {
    back = set(back, item.id, undefined);
    emit();
  }, BACK_MS);
}

/** The list as it is about to be: an ask being snoozed (or just snoozed) already carries its date. */
export function withSnoozes(items: WaitingItem[] | undefined, m: Map<string, Entry> = entries): WaitingItem[] | undefined {
  if (!items || !m.size) return items;
  return items.map((i) => {
    const e = m.get(i.id);
    return e && i.state === "open" && !i.snoozedUntil ? { ...i, snoozedUntil: e.until } : i;
  });
}

/** Re-render on every change; returns the snoozes in flight / just written and the errors per item id. */
export function useSnoozes() {
  useSyncExternalStore(subscribe, () => version);
  return { entries, errors, back };
}

export const clearSnoozeError = (id: string) => {
  if (!errors.has(id)) return;
  errors = set(errors, id, undefined);
  emit();
};

/** Tests only. */
export const resetSnoozes = () => {
  entries = new Map();
  errors = new Map();
  back = new Map();
  emit();
};
