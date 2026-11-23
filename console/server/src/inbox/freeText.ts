import { stripInline } from "../adapters/markdown.js";
import { isClosed, statusWordOf, type TreeNode } from "../adapters/tree.js";
import { rowMatches, type LocatedAsk } from "./asks.js";
import { DEFAULT_OWNER, ownerPatterns } from "../tenancy/owner.js";
import { ownerName } from "../identity.js";

/**
 * free-text asks: a ledger row assigned to the owner (owner cell `the owner`) with an open status and no coded ask on
 * it is something the owner has to do, written outside the console ask format (`[ask <CODE>: … @the owner …]`). Each such row
 * is one `free_text_ask` item (amber "ask not in console format"); a `Waiting on:` line naming those rows is covered
 * by them, so the line is never counted on top. Pure helpers; waiting.ts builds the items.
 */

/** The row's owner cell names the owner first ("the owner", "the owner (Mac)", "@the owner"); "Delivery manager → the owner" does not. */
export const ownedByJordi = (owner?: string, handle: string = DEFAULT_OWNER) => !!owner && ownerPatterns(handle).ownerCell.test(stripInline(owner));

/** Open for the owner: a ledger row (not a DoD box) owned by the owner, not done, superseded, deferred / parked or otherwise closed. */
export function openForJordi(n: Pick<TreeNode, "kind" | "owner" | "status" | "color">, handle: string = DEFAULT_OWNER): boolean {
  if (n.kind === "dod" || !ownedByJordi(n.owner, handle) || n.color === "green" || isClosed(n)) return false;
  const w = statusWordOf(n.status);
  return w !== "done" && w !== "deferred";
}

/**
 * A later step, not an ask now (human-asks v2, root L-13): the owner cell says so ("the owner (later)"), or the row's line
 * (its own title left out) names a sibling row of the same ledger that is not done yet ("Depends On: S3", "after A0").
 * Returns the reason ("later", "after S3 (not done)"); undefined when the row is the owner's to do now.
 */
export function laterStep(
  n: Pick<TreeNode, "id" | "title" | "owner">,
  line: string | undefined,
  siblings: Pick<TreeNode, "id" | "title" | "status" | "color" | "kind">[],
): string | undefined {
  if (/\blater\b/i.test(stripInline(n.owner ?? ""))) return "later";
  if (!line) return undefined;
  const own = rowLabel(n);
  const text = expandRanges(stripInline(line).replace(stripInline(n.title), " "));
  const open = siblings.filter((x) => {
    const label = rowLabel(x);
    return !!label && label !== own && x.kind !== "dod" && x.color !== "green" && !isClosed(x) && statusWordOf(x.status) !== "done" && citesRows(text, [label]);
  });
  return open.length ? `after ${[...new Set(open.map((x) => rowLabel(x)!))].join(", ")} (not done)` : undefined;
}

/** A coded ask (any state) on this row: the row is that ask, never a second, free-text item. */
export const rowHasAsk = (n: Pick<TreeNode, "id" | "title" | "asks">, asks: Pick<LocatedAsk, "row">[]) =>
  !!n.asks?.length || asks.some((a) => !!a.row && rowMatches(a.row, n));

const ROW_ID = /^[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)+/;
/**
 * The id a row is cited by: the id its Issue cell starts with (``, `ZMR-17 #1243` → ZMR-17), else the id its title starts with (ledgers
 * whose Issue cells are all `draft`: ` [Which accounts …](…)`).
 */
export function rowLabel(n: Pick<TreeNode, "id" | "title">): string | undefined {
  const id = /^[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*/.exec(stripInline(n.id).trim())?.[0];
  if (id && /\d/.test(id)) return id;
  const lead = ROW_ID.exec(stripInline(n.title).trim())?.[0];
  return lead && /\d/.test(lead) ? lead : undefined;
}

/** Row title without the leading id (it is shown once, from `rowLabel`). */
export function rowTitle(n: Pick<TreeNode, "id" | "title">): string {
  const label = rowLabel(n);
  const t = stripInline(n.title).trim();
  const rest = label && t.startsWith(label) ? t.slice(label.length).trim() : t;
  return label ? `${label} ${rest}`.trim() : rest;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A `Waiting on:` line that cites at least one of these row labels (``): the rows are its items. */
export function citesRows(text: string, labels: string[]): boolean {
  const t = stripInline(text);
  return labels.some((l) => new RegExp(`(?<![\\w-])${esc(l)}(?![\\w-]|\\.\\d)`, "i").test(t));
}

/**
 * what a free-text `Waiting on:` line asks of the owner. The line is cut
 * at `;` into parts; a part counts only when it names the owner as the one acting (`the owner-approved texts` the manager sends
 * do not) and is not a later step (root L-13: "asked at T3, not before", "when pinged", "only after is live",
 * "before Wave 2", "later"). `stamp`: every part left asks the owner to stamp the epic ready (a Mark ready item, not a question).
 */
export interface JordiLine {
  /** The parts the owner can act on now (codes and the `the owner` prefix kept as written). */
  now: string[];
  /** Parts that name the owner for a later step: not counted (Coming up). */
  later: string[];
  /** Every part in `now` is the owner's ready stamp. */
  stamp: boolean;
}

const LATER_STEP = /\bnot\s+before\b|\basked\s+at\b|\bwhen\s+(?:pinged|asked|it\s+is\s+next)\b|\bonly\s+(?:after|once|when)\b|\bbefore\s+wave\b|\b(?:at|after)\s+T\d+\b|\blater\b|\bnot\s+yet\s+(?:an\s+)?ask\b/i;
const STAMP = /\b(?:stamps?|stamped|marks?)\b[^;]*\bready\b|\bready\s+stamp\b/i;
/** `the owner-approved`, `the owner-written`: an adjective, not the owner acting; `approved` alone is not the owner either. */
const NOT_ACTING = (handle: string) => new RegExp(`\\b${esc(handle)}-[A-Za-z]+\\b`, "gi");

export function jordiLine(text: string, handle: string = DEFAULT_OWNER): JordiLine {
  const named = new RegExp(`\\b${esc(handle)}\\b`, "i");
  const parts = stripInline(text)
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const now: string[] = [];
  const later: string[] = [];
  for (const p of parts) {
    const acting = p.replace(NOT_ACTING(handle), " ");
    if (!named.test(acting)) continue;
    (LATER_STEP.test(p) ? later : now).push(p);
  }
  return { now, later, stamp: now.length > 0 && now.every((p) => STAMP.test(p)) };
}

/**
 * row ranges written in a Depends On cell, `T0–T6` or `..S12`, spelled out (`T0 T1 … T6`), so the owner
 * row after a range of open sibling rows is a later step (found on production: the memory service T7).
 */
export function expandRanges(text: string): string {
  return text.replace(/(?<![\w-])([A-Za-z][A-Za-z0-9-]*?)(\d+)\s*(?:–|—|\.\.)\s*[A-Za-z]*(\d+)(?![\w-])/g, (all, prefix: string, a: string, b: string) => {
    const from = Number(a);
    const to = Number(b);
    if (!(to > from) || to - from > 50) return all;
    return Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`).join(" ");
  });
}

/**
 * the Delivery Manager, 23 Nov: the ask gate held ledger rows blocked on another world as if they were asks to the
 * owner, asking for an About line and an action for him. A row that waits on another world
 * or another team is never his item. Either its file has a reference line `- [waits on <repo>/<code> row <id>]` for it
 * (whatever that ask's state), or its status says so (`blocked (another world: …)`, `blocked (waits on infra-repo …)`).
 * Only `[ask …]` lines are asks; such a row is its Delivery Manager's to chase.
 */
/** `waits on <someone>` in a status, where the someone is not the owner ("waits on the owner", "waits on him"). */
function waitsOnOther(status: string): boolean {
  const m = /\bwaits?\s+on\s+(.+)$/i.exec(status);
  if (!m) return false;
  const who = m[1]!.trim().toLowerCase();
  const owner = ownerName().toLowerCase();
  return !(who.startsWith(owner) || /^(the owner|him|you|his)\b/.test(who) || ownerPatterns().ownerCell.test(m[1]!.trim()));
}
const WAITS_ROW_LINE = /^\s*[-*]\s+\[waits?\s+on\s+[^\]]*?\brow\s+([^\s\]]+)\s*\]/i;
export function waitsElsewhere(n: Pick<TreeNode, "id" | "status">, lines: string[] | undefined): boolean {
  const status = stripInline(n.status ?? "");
  if (/\banother (world|team|repo)\b/i.test(status) || waitsOnOther(status)) return true;
  const id = (n.id ?? "").toLowerCase();
  if (!id) return false;
  return (lines ?? []).some((l) => WAITS_ROW_LINE.exec(l)?.[1]?.replace(/[.,;:)]+$/, "").toLowerCase() === id);
}
