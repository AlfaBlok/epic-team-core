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
 * Found once per row line (`git log -G` on the row, about half a second) and kept in memory; a changed row line looks
 * again. Never blocks a list for long: `inboxSinceOf` waits at most `budgetMs` and answers what it has.
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
 * The newest commit in `log` (`git log --format=C %ct -p -U0` output, newest first) that added the row's line with
 * the status word `want` while the line it replaced (if any) had another word. ISO time, or undefined.
 */
export function entryFromLog(log: string, rowId: string, statusCol: number, want: string): string | undefined {
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
    const w = word(cells(line.slice(1))[statusCol]);
    if (line[0] === "+" && w === want) added = true;
    if (line[0] === "-" && w === want) removedHad = true;
  }
  return close();
}

type Hit = { line: string; at: Promise<string | undefined> };
const cache = new Map<string, Hit>();

function lookup(repoDir: string, rel: string, rowId: string, statusCol: number, want: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // extended regex: `\|` is the pipe itself (a bare `|` matched every commit)
    const re = `^\\|[[:space:]]*${escapeRe(rowId)}[[:space:]]*\\|`;
    execFile("git", ["-C", repoDir, "log", "--no-merges", "-E", "--format=C %ct", "-p", "-U0", "-G", re, "--", rel], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : entryFromLog(stdout, rowId, statusCol, want));
    });
  });
}

/** The row's line in the spine now and its status column (the cell that reads `status`). */
function rowNow(abs: string, rowId: string, status: string): { line: string; col: number } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const want = stripInline(rowId).toLowerCase();
  const s = stripInline(status).trim();
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    if ((c[0] ?? "").toLowerCase() !== want) continue;
    const col = c.findIndex((x, i) => i > 0 && x.trim() === s);
    const loose = col >= 0 ? col : c.findIndex((x, i) => i > 0 && word(x) === word(s) && /^(review|done)\b/i.test(x));
    return loose >= 0 ? { line, col: loose } : undefined;
  }
  return undefined;
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
  const at = lookup(repoDir, rel, rowId, now.col, want);
  cache.set(key, { line: now.line, at });
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
export const resetInboxSince = () => cache.clear();
