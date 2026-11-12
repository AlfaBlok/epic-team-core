import { DEFAULT_TENANT } from "../db.js";
import { sites } from "../identity.js";
/**
 * What a notice to the owner is and when it may go: core's web push and the hosted WhatsApp notifier share these;
 * moved unchanged from notify/whatsapp.ts.
 */
export const teamLink = (): string => sites().teamUrl;

/** `application` = a tester application the owner has not opened on /testers yet. */
export type NoticeKind = "ask" | "review" | "application";
export interface Notifiable {
  /** `ask:<waiting item id>`, `review:<review item id>` or `application:<tester signup id>`. */
  key: string;
  kind: NoticeKind;
  title: string;
  /** Epic or row code when known. */
  code?: string;
  /** Where the item sits on the production site. */
  teamUrl: string;
  /** the item's milestone (asks, reviews); none for world-wide items (tester applications). */
  milestoneId?: string;
  /** Reviews: where the owner opens the live result. */
  liveUrl?: string;
}

/** Hour (0-23) and date (YYYY-MM-DD) of `d` in `timeZone`. */
export function localParts(d: Date, timeZone: string): { hour: number; day: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, day: `${p.year}-${p.month}-${p.day}` };
}

export const inQuiet = (hour: number, [from, to]: [number, number]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to);

// moved unchanged from notify/whatsapp.ts (the voice call's quick status reads them too).
export interface OpenItem {
  id: string;
  state: string;
  milestoneId: string;
  title: string;
  code?: string;
  nodeKey?: string;
}

export const teamItemUrl = (milestoneId: string, nodeKey?: string) =>
  `${teamLink()}/milestones/${encodeURIComponent(milestoneId)}${nodeKey ? `/node/${encodeURIComponent(nodeKey)}` : ""}`;

/** Open items of the owner's own world (the Team home badge's items) as notifiables. */
export function asksFrom(items: OpenItem[], worldOf: (milestoneId: string) => string, titleOf: (milestoneId: string) => string | undefined): Notifiable[] {
  const seen = new Set<string>();
  const out: Notifiable[] = [];
  for (const i of items) {
    if (i.state !== "open" || seen.has(i.id) || worldOf(i.milestoneId) !== DEFAULT_TENANT) continue;
    seen.add(i.id);
    const epic = titleOf(i.milestoneId);
    out.push({ key: `ask:${i.id}`, kind: "ask", title: epic && !i.title.includes(epic) ? `${i.title} · ${epic}` : i.title, ...(i.code ? { code: i.code } : {}), teamUrl: teamItemUrl(i.milestoneId, i.nodeKey), milestoneId: i.milestoneId });
  }
  return out;
}

/** the review list's cards (spine rows in review, live, not snoozed) of the owner's world, as notices. */
export function reviewNotices(items: { id: string; title: string; ref?: string; liveUrl: string; milestoneId?: string }[]): Notifiable[] {
  return items.map((r) => ({ key: `review:${r.id}`, kind: "review", title: r.title, ...(r.ref ? { code: r.ref } : {}), teamUrl: `${teamLink()}/`, liveUrl: r.liveUrl, ...(r.milestoneId ? { milestoneId: r.milestoneId } : {}) }));
}

// moved unchanged from notify/whatsapp.ts (createApp's `whatsapp.sender` option names them).
export interface SendResult {
  ok: boolean;
  /** `whatsapp:<message id>:<status>` per delivery receipt (no phone number). */
  receipt?: string;
  error?: string;
}
export type Sender = (text: string) => Promise<SendResult>;
