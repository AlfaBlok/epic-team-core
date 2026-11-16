import { DEFAULT_TENANT } from "../db.js";
import { sites } from "../identity.js";
import { TEST_REPO, TEST_ROW } from "../review/rows.js";
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
  /**
   * True when the item is our own test, marked at its source (a TEST sign-up, a TEST repo, a T9xx row), so the owner
   * never reads a test as a real application.
   */
  test?: boolean;
  /**
   * a review card for something the owner is waiting on: he is told once per ready event (`event`), loudly,
   * outside the batch's caps (hosted notify/readyNotice.ts).
   */
  ready?: ReadyNotice;
}

export interface ReadyNotice {
  /** `ready:<repo>:<row>:<iteration>`: one notice per row per ready event. */
  event: string;
  why: string;
  where: string;
  /** where he opens it ("" when the card names no link). */
  url: string;
  repo: string;
  /** the row's spine, repo-relative. */
  path: string;
  row: string;
}

/**
 * The one place a notice to the owner is marked. Only a test says so: `TEST ·` leads a test message (or the test part
 * of a mixed one). Real is the default and says nothing (the owner's ask: "only say test when it's a test"), so a
 * `REAL` lead is taken off.
 */
export const TEST_WORD = "TEST";
/** `TEST · ` for a test, nothing for a real one: put it before any heading. */
export const markPrefix = (test?: boolean) => (test ? `${TEST_WORD} · ` : "");
export const MARKED = /^TEST\b/;
/** a `REAL ·` (or `REAL:`, `REAL -`) at the start of any line, taken off: real says nothing. */
const REAL_LEAD = /^([ \t]*)REAL[ \t]*[·:—–-][ \t]*/gm;
export const unmarkReal = (text: string): string => text.replace(REAL_LEAD, "$1");
export function markText(text: string, test?: boolean): string {
  const t = unmarkReal(text);
  return !test || MARKED.test(t.trimStart()) ? t : `${markPrefix(true)}${t}`;
}
/** A test item at its source: a TEST repo (`app-test`), a T9xx row, or a code or title that says TEST. */
export function isTestItem(o: { repo?: string; code?: string; title?: string }): boolean {
  return (!!o.repo && TEST_REPO.test(o.repo)) || (!!o.code && TEST_ROW.test(o.code)) || (!!o.title && /^\s*TEST\b/.test(o.title));
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
export function asksFrom(items: OpenItem[], worldOf: (milestoneId: string) => string, titleOf: (milestoneId: string) => string | undefined, repoOf?: (milestoneId: string) => string | undefined): Notifiable[] {
  const seen = new Set<string>();
  const out: Notifiable[] = [];
  for (const i of items) {
    if (i.state !== "open" || seen.has(i.id) || worldOf(i.milestoneId) !== DEFAULT_TENANT) continue;
    seen.add(i.id);
    const epic = titleOf(i.milestoneId);
    const test = isTestItem({ repo: repoOf?.(i.milestoneId), code: i.code, title: i.title });
    out.push({ key: `ask:${i.id}`, kind: "ask", title: epic && !i.title.includes(epic) ? `${i.title} · ${epic}` : i.title, ...(i.code ? { code: i.code } : {}), teamUrl: teamItemUrl(i.milestoneId, i.nodeKey), milestoneId: i.milestoneId, ...(test ? { test } : {}) });
  }
  return out;
}

/** the review list's cards (spine rows in review, live, not snoozed) of the owner's world, as notices. */
export function reviewNotices(
  items: { id: string; title: string; ref?: string; repo?: string; path?: string; liveUrl: string; milestoneId?: string; iteration?: number; face?: { title?: string; ready?: { whyText: string; where: string; url: string } } }[],
): Notifiable[] {
  return items.map((r) => {
    const test = isTestItem({ repo: r.repo, code: r.ref, title: r.title });
    const rd = r.face?.ready;
    const ready: ReadyNotice | undefined =
      rd && r.ref && r.repo && r.path
        ? { event: `ready:${r.repo}:${r.ref}:${r.iteration ?? 1}`, why: rd.whyText, where: rd.where, url: rd.url, repo: r.repo, path: r.path, row: r.ref }
        : undefined;
    return {
      key: `review:${r.id}`,
      kind: "review",
      title: r.title,
      ...(r.ref ? { code: r.ref } : {}),
      teamUrl: `${teamLink()}/`,
      liveUrl: r.liveUrl,
      ...(r.milestoneId ? { milestoneId: r.milestoneId } : {}),
      ...(test ? { test } : {}),
      ...(ready ? { ready } : {}),
    };
  });
}

// moved unchanged from notify/whatsapp.ts (createApp's `whatsapp.sender` option names them).
export interface SendResult {
  ok: boolean;
  /** `whatsapp:<message id>:<status>` per delivery receipt (no phone number). */
  receipt?: string;
  error?: string;
}
/** a picture sent with the text as its caption, where the channel takes one. */
export interface SendImage {
  png: Buffer;
  /** where the owner opens the same picture (behind the console login). */
  url?: string;
}
export type Sender = (text: string, o?: { image?: SendImage }) => Promise<SendResult>;
