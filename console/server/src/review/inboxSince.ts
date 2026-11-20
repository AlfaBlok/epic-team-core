import { execFile } from "node:child_process";
import fs from "node:fs";
import { inside } from "../adapters/doc.js";
import { stripInline } from "../adapters/markdown.js";

/**
 * The owner (2026-11-16 04:21Z, vn_7c5aa36e: "how long has this been waiting for me? ... I just wanna know how
 * old is the card in minutes, hours, days, weeks"): when a review card reached his inbox, to the minute. It is the
 * committer time of the newest commit that turned the row's status cell into the word it has now (`review`, or `done`
 * for a card he never marked); a later edit of the row that keeps that word (a restamp of Last verified, a new evidence
 * link, a snooze) does not move it, and a row that left review and came back counts from its return.
 *
 * Found once per row line (`git log -G` on the row, about half a second), kept in memory and in the console's database
 * (so a restart does not look again); a changed row line looks again. Never blocks a list for long: `inboxSinceOf` waits at most `budgetMs` and answers what it has.
 */

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => stripInline(c.trim()));

const word = (cell: string | undefined) => (/^[a-z]+/i.exec(cell ?? "")?.[0] ?? "").toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The status word of an older version of the row: its cell at `col`; only when the table had another number of columns
 * then (`width` is today's), the nearest cell (up to three away) that starts with `want`.
 */
function statusWord(c: string[], col: number, want: string, width?: number): string {
  const at = word(c[col]);
  if (at === want || width === undefined || c.length === width) return at;
  for (let d = 1; d <= 3; d++) for (const i of [col - d, col + d]) if (i > 0 && word(c[i]) === want && /^[a-z]+(\b|$)/i.test(c[i] ?? "")) return want;
  return at;
}

/**
 * The newest commit in `log` (`git log --format=C %ct -p -U0` output, newest first) that added the row's line with
 * the status word `want` while the line it replaced (if any) had another word. ISO time, or undefined.
 */
export function entryFromLog(log: string, rowId: string, statusCol: number, want: string, width?: number): string | undefined {
  const rowStart = new RegExp(`^[-+]\\|\\s*${escapeRe(rowId)}\\s*\\|`);
  let at: string | undefined;
  let added = false;
  let removedHad = false;
  const close = () => (at && added && !removedHad ? at : undefined);
  for (const line of log.split("\n")) {
    if (line.startsWith("C ")) {
      const hit = close();
      if (hit) return hit;
      const t = Number(line.slice(2).trim());
      at = t ? new Date(t * 1000).toISOString() : undefined;
      added = removedHad = false;
      continue;
    }
    if (!rowStart.test(line)) continue;
    const w = statusWord(cells(line.slice(1)), statusCol, want, width);
    if (line[0] === "+" && w === want) added = true;
    if (line[0] === "-" && w === want) removedHad = true;
  }
  return close();
}

type Hit = { line: string; at: Promise<string | undefined> };
const cache = new Map<string, Hit>();

/**
 * Where found times outlive a restart: the console's database (review/review.ts `review_inbox_since`).
 * The memory above is empty after each start, and every list then waited its whole budget while ~54 `git log -G` runs
 * (about half a second each, more on a loaded host) found again what was known before: the phone's first inbox draw
 * after a release took 2.4 to 4.6 s. A stored time is used while the row's line is the same; `at` null = git found none.
 */
export interface InboxSinceStore {
  get(key: string): { line: string; at: string | null } | undefined;
  put(key: string, line: string, at: string | null): void;
}
let kept: InboxSinceStore | undefined;
export const keepInboxSinceIn = (s: InboxSinceStore | undefined) => {
  kept = s;
};

/** git's answer: `ok` false when git itself failed (timeout, no repo), so nothing is stored. */
function lookup(repoDir: string, rel: string, rowId: string, statusCol: number, want: string, width: number): Promise<{ ok: boolean; at?: string }> {
  return new Promise((resolve) => {
    // extended regex: `\|` is the pipe itself (a bare `|` matched every commit)
    const re = `^\\|[[:space:]]*${escapeRe(rowId)}[[:space:]]*\\|`;
    execFile("git", ["-C", repoDir, "log", "--no-merges", "-E", "--format=C %ct", "-p", "-U0", "-G", re, "--", rel], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? { ok: false } : { ok: true, at: entryFromLog(stdout, rowId, statusCol, want, width) });
    });
  });
}

/**
 * Each spine's table rows by id (the first line whose first cell is the id), read once per file change (mtime and size).
 * Every list call asks for every card's row: reading and splitting each 100 to 430 KB spine once per card made one
 * list ~0.2 s of solid CPU, and the inbox's first draw makes four or five lists at once.
 */
const fileRows = new Map<string, { mtimeMs: number; size: number; rows: Map<string, string> }>();

function rowsOf(abs: string): Map<string, string> | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    fileRows.delete(abs);
    return undefined;
  }
  const kept = fileRows.get(abs);
  if (kept && kept.mtimeMs === st.mtimeMs && kept.size === st.size) return kept.rows;
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const rows = new Map<string, string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const first = (/^\|([^|]*)/.exec(t)?.[1] ?? "").trim();
    if (!first || first.startsWith("-")) continue;
    const id = stripInline(first).toLowerCase();
    if (!rows.has(id)) rows.set(id, line);
  }
  fileRows.set(abs, { mtimeMs: st.mtimeMs, size: st.size, rows });
  return rows;
}

/** The row's line in the spine now and its status column (the cell that reads `status`). */
function rowNow(abs: string, rowId: string, status: string): { line: string; col: number } | undefined {
  const line = rowsOf(abs)?.get(stripInline(rowId).toLowerCase());
  if (!line) return undefined;
  const s = stripInline(status).trim();
  const c = cells(line);
  const col = c.findIndex((x, i) => i > 0 && x.trim() === s);
  const loose = col >= 0 ? col : c.findIndex((x, i) => i > 0 && word(x) === word(s) && /^(review|done)\b/i.test(x));
  return loose >= 0 ? { line, col: loose } : undefined;
}

/** When the row `rowId` in `rel` reached the owner's inbox (ISO), as far as git knows; one lookup per row line. */
export function inboxSince(repoDir: string, rel: string, rowId: string, status: string): Promise<string | undefined> {
  const abs = inside(repoDir, rel);
  const want = word(status);
  if (!abs || !want) return Promise.resolve(undefined);
  const now = rowNow(abs, rowId, status);
  if (!now) return Promise.resolve(undefined);
  const key = `${repoDir}\0${rel}\0${rowId}`;
  const hit = cache.get(key);
  if (hit && hit.line === now.line) return hit.at;
  let stored: ReturnType<InboxSinceStore["get"]>;
  try {
    stored = kept?.get(key);
  } catch {
    stored = undefined;
  }
  if (stored && stored.line === now.line) {
    const at = Promise.resolve(stored.at ?? undefined);
    cache.set(key, { line: now.line, at });
    return at;
  }
  const line = now.line;
  const at = lookup(repoDir, rel, rowId, now.col, want, cells(line).length).then((r) => {
    // git failed (a timeout on a loaded host): kept in memory as none until the next start, never stored, so the next
    // start asks again and no list spawns git again meanwhile
    if (r.ok) {
      try {
        kept?.put(key, line, r.at ?? null);
      } catch {
        /* a store that cannot write only costs the lookup again after the next start */
      }
    }
    return r.at;
  });
  cache.set(key, { line, at });
  return at;
}

/**
 * Each row's inbox time, by id, waiting at most `budgetMs` in all (four lookups at a time); a row still being looked up
 * is left out this time and is ready on the next list.
 */
export async function inboxSinceOf(
  rows: { id: string; repoDir?: string; path: string; ref: string; status: string }[],
  budgetMs = 1_500,
  find: typeof inboxSince = inboxSince,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let i = 0;
  const next = async (): Promise<void> => {
    const r = rows[i++];
    if (!r) return;
    if (r.repoDir) {
      const at = await find(r.repoDir, r.path, r.ref, r.status).catch(() => undefined);
      if (at) out.set(r.id, at);
    }
    return next();
  };
  const all = Promise.all(Array.from({ length: Math.min(4, rows.length) }, next));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((res) => (timer = setTimeout(res, budgetMs)))]);
  if (timer) clearTimeout(timer);
  return new Map(out);
}

/** Tests only. */
export const resetInboxSince = () => {
  cache.clear();
  fileRows.clear();
};
