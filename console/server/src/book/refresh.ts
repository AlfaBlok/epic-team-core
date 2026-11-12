import { execFile } from "node:child_process";
import fs from "node:fs";
import type { DB } from "../db.js";
import { inside } from "../adapters/doc.js";
import type { PullResult } from "../cycle/repoPull.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { CAPABILITIES_FILE, type Book } from "./build.js";

/**
 * the daily refresh of the epic decks (the deck replaced the Epic Book; the decks are cut
 * from this same book, so this run refreshes them), a timer the console owns (no persona, no seat). Once a day,
 * from `REFRESH_HOUR_UTC` (and at start when today's has not run yet), for every checkout the book reads:
 *  1. pull it (`git pull --ff-only`), so the book is rebuilt from what is on origin;
 *  2. where the repo keeps a capabilities table and its probe (the code repo:), re-run the probe (reads for real,
 *     writes as dry runs only, nothing published) and commit + push the refreshed table through the spine writer's
 *     guarded scaffold mode (clean checkout on main, Integration policy main-direct, fast-forwardable);
 *  3. drop the spines.py cache and rebuild the book (awaited).
 * Each run is recorded (`book_refresh`), so a book's "last updated" survives a restart; a book whose spine, probe and
 * refresh are all older than 2 days shows as stale (book/milestone.ts BOOK_STALE_MS) and as stuck on /book.
 */

export const REFRESH_HOUR_UTC = 5;
/** A failed or incomplete run is tried again after this long (still the same day's slot). */
export const RETRY_MS = 60 * 60_000;
/** Runs per daily slot at most (the first and its retries). */
export const MAX_TRIES = 4;
export const PROBE_SCRIPT = "browser/scripts/probe-service-capabilities.py";
/** the product's capability catalog, redrawn from the refreshed table in the same commit so it stays true. */
export const CATALOG_SCRIPT = "scripts/capability_catalog.py";
export const CATALOG_FILES = ["docs/catalog/capabilities.md", "docs/catalog/index.html"];
const KEEP = 60;

export interface RefreshRepo {
  name: string;
  pull: "ok" | "failed" | "skipped";
  pullError?: string;
  /** The capability probe, for a repo that keeps the table. */
  probe?: { status: SpineWrite["status"]; sha?: string; reason?: string };
}

export interface BookRefreshRun {
  at: string;
  endedAt: string;
  /** The book was rebuilt (the probe's own outcome is per repo). */
  ok: boolean;
  /** daily | start | manual */
  reason: string;
  repos: RefreshRepo[];
  builtAt?: string;
  error?: string;
}

export type ProbeRunner = (repoDir: string) => Promise<void>;

/** The repo's own probe script, against the Team Browser API (127.0.0.1:8751 on the console host). */
export function realProbe(o: { base?: string; python?: string; timeoutMs?: number } = {}): ProbeRunner {
  return (repoDir) =>
    new Promise((resolve, reject) => {
      const args = [inside(repoDir, PROBE_SCRIPT)!, "--file", inside(repoDir, CAPABILITIES_FILE)!, ...(o.base ? ["--base", o.base] : [])];
      const run = (file: string, a: string[], done: () => void) =>
        execFile(o.python ?? "python3", [file, ...a], { timeout: o.timeoutMs ?? 30 * 60_000, maxBuffer: 4 << 20 }, (err, _out, stderr) => {
          if (!err) return done();
          const why = String(stderr || "").trim().split("\n").filter(Boolean).pop() || (err.killed ? "timed out" : err.message);
          reject(new Error(why.slice(0, 300)));
        });
      const catalog = inside(repoDir, CATALOG_SCRIPT);
      run(args[0], args.slice(1), () => (catalog && fs.existsSync(catalog) ? run(catalog, [], resolve) : resolve()));
    });
}

export function migrateBookRefresh(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS book_refresh (at TEXT PRIMARY KEY, ok INTEGER NOT NULL, data TEXT NOT NULL);`);
}

/** The start of the daily slot `now` falls in: today's REFRESH_HOUR_UTC, or yesterday's before that hour. */
export function slotOf(now: number, hourUtc = REFRESH_HOUR_UTC): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  return now >= today ? today : today - 86_400_000;
}

const hasProbe = (dir: string) => [CAPABILITIES_FILE, PROBE_SCRIPT].every((f) => {
  const abs = inside(dir, f);
  return !!abs && fs.existsSync(abs);
});

export function createBookRefresh(d: {
  db: DB;
  repos: () => { name: string; path: string; hasEpicSpine: boolean }[];
  book: { rebuild(): Promise<Book> };
  /** Drop the spines.py output and trees of a checkout (app.ts dropSpines). */
  invalidate: (dir: string) => void;
  pull?: (dir: string) => Promise<PullResult>;
  probe?: ProbeRunner;
  writer?: SpineWriter;
  now?: () => number;
  log?: (msg: string) => void;
  hourUtc?: number;
}) {
  migrateBookRefresh(d.db);
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.log(m));
  let running: Promise<BookRefreshRun> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const list = (limit = 10): BookRefreshRun[] =>
    (d.db.prepare("SELECT data FROM book_refresh ORDER BY at DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  const lastOk = (): BookRefreshRun | undefined => {
    const r = d.db.prepare("SELECT data FROM book_refresh WHERE ok = 1 ORDER BY at DESC LIMIT 1").get() as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  };

  async function probeRepo(dir: string): Promise<RefreshRepo["probe"]> {
    if (!d.probe || !d.writer) return { status: "skipped", reason: "no probe runner or spine writer on this console" };
    const probe = d.probe;
    const w = await d.writer.scaffold({
      repoDir: dir,
      path: CAPABILITIES_FILE,
      label: "daily capability probe",
      scaffold: async (repoDir) => {
        try {
          await probe(repoDir);
          return { ok: true, files: [CAPABILITIES_FILE, ...CATALOG_FILES] };
        } catch (e) {
          return { ok: false, error: `the probe failed: ${(e as Error).message}` };
        }
      },
      msg: "daily capability probe (console)",
      body: `The agent-team console's daily refresh of the epic decks re-ran ${PROBE_SCRIPT} (reads for real, writes as dry runs only, nothing published) and committed the refreshed ${CAPABILITIES_FILE}.`,
    });
    return { status: w.status, ...(w.status === "written" ? { sha: w.sha } : { reason: w.reason }) };
  }

  async function runOnce(reason: string): Promise<BookRefreshRun> {
    const at = new Date(now()).toISOString();
    const repos: RefreshRepo[] = [];
    for (const r of d.repos().filter((x) => x.hasEpicSpine)) {
      const out: RefreshRepo = { name: r.name, pull: "skipped" };
      if (d.pull) {
        const p = await d.pull(r.path);
        out.pull = p.ok ? "ok" : "failed";
        if (!p.ok) out.pullError = p.reason.slice(0, 200);
      }
      if (hasProbe(r.path)) out.probe = await probeRepo(r.path);
      d.invalidate(r.path);
      repos.push(out);
    }
    let run: BookRefreshRun;
    try {
      const b = await d.book.rebuild();
      run = { at, endedAt: new Date(now()).toISOString(), ok: true, reason, repos, builtAt: b.builtAt };
    } catch (e) {
      run = { at, endedAt: new Date(now()).toISOString(), ok: false, reason, repos, error: (e as Error).message.slice(0, 300) };
    }
    d.db.prepare("INSERT OR REPLACE INTO book_refresh (at, ok, data) VALUES (?, ?, ?)").run(run.at, run.ok ? 1 : 0, JSON.stringify(run));
    d.db.prepare("DELETE FROM book_refresh WHERE at NOT IN (SELECT at FROM book_refresh ORDER BY at DESC LIMIT ?)").run(KEEP);
    const probes = repos.filter((x) => x.probe).map((x) => `${x.name} probe ${x.probe!.status}${x.probe!.sha ? ` ${x.probe!.sha}` : x.probe!.reason ? ` (${x.probe!.reason})` : ""}`);
    log(`book refresh (${reason}): ${run.ok ? "rebuilt" : `failed: ${run.error}`}; ${repos.length} repos, ${repos.filter((x) => x.pull === "failed").length} pulls failed${probes.length ? `; ${probes.join("; ")}` : ""}`);
    return run;
  }

  /** One run at a time; a caller during a run gets that run. */
  const run = (reason = "manual") => (running ??= runOnce(reason).finally(() => (running = undefined)));

  /**
   * Today's slot has no complete run: none yet, or the last one in it failed to rebuild, or a probe in it did not commit
   * (a shared checkout with someone's uncommitted files, the Team Browser down). Retried RETRY_MS after the last attempt,
   * at most MAX_TRIES runs per slot.
   */
  function due(): boolean {
    const slot = slotOf(now(), d.hourUtc);
    const inSlot = list(MAX_TRIES).filter((r) => Date.parse(r.at) >= slot);
    const last = inSlot[0];
    if (!last) return true;
    const complete = last.ok && last.repos.every((r) => !r.probe || r.probe.status === "written");
    return !complete && inSlot.length < MAX_TRIES && now() - Date.parse(last.at) >= RETRY_MS;
  }

  async function tick(reason = "daily"): Promise<BookRefreshRun | undefined> {
    if (running || !due()) return undefined;
    return run(reason);
  }

  return {
    run,
    tick,
    due,
    list,
    /** The last refresh that rebuilt the book (its time is a book's `refreshedAt`). */
    lastOkAt: () => lastOk()?.at,
    running: () => !!running,
    start(everyMs: number, firstAfterMs = 60_000) {
      if (timer || everyMs <= 0) return;
      setTimeout(() => void tick("start").catch((e) => log(`book refresh: ${(e as Error).message}`)), firstAfterMs).unref?.();
      timer = setInterval(() => void tick().catch((e) => log(`book refresh: ${(e as Error).message}`)), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type BookRefresh = ReturnType<typeof createBookRefresh>;
