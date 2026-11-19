import fs from "node:fs";
import type { DB } from "../db.js";
import { cachedRunner, fixtureRunner, rescanGapMs, spinesPyRunner, type SpinesRunner } from "../adapters/spines.js";
import { listRepos } from "../adapters/repos.js";
import { gitOut, type GitOut } from "../freshness.js";
import { bookStore, createBook, type BookCommitsStore } from "../book/service.js";
import { createRefresher } from "../readModel/refresher.js";
import { answerSpinesAsk, workerSpinesRunner } from "../readModel/spinesBridge.js";
import type { ViewKey } from "../readModel/views.js";
import { BEAT_KEY, DRIFT_KEY, T3_KEY, ensureIndexerTables, kvGet, kvSet, takeIndexerMsgs, type IndexerBeat, type IndexerMsg } from "./queue.js";
import { persistingRunner, scannerVersion, seedFrom } from "./spinesCache.js";
import { useGitMemo } from "../inbox/waiting.js";
import { remoteSpinesRunner } from "./remoteSpines.js";

/**
 * the console's scans, out of
 * the HTTP process. One process (main.ts; a niced, CPU-capped systemd unit the console starts, launch.ts) does every
 * spines.py run, the read model's refresher (was a worker thread inside the console) and the Epic Book's build (git log
 * over every repo, was on the console's main thread every 2 min). It writes only console.db: spines_cache, the read
 * model's views, book_cache, and its heartbeat. The console reads those and asks for work through indexer_queue.
 */
import type { Identity } from "../identity.js";

/**
 * How often the read model's pass looks at every repo: 30 s (was 5 s, the biggest single CPU cost on the main
 * server, 60% of a core). A console write, a pull and a new view still start a pass at once (refresher.dirty / register);
 * only an edit nobody told the console about waits up to this long. CONSOLE_INDEXER_TICK_MS overrides.
 */
export function indexerTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.CONSOLE_INDEXER_TICK_MS);
  return Number.isFinite(v) && v >= 1_000 ? v : 30_000;
}

export interface IndexerConfig {
  dbPath: string;
  reposRoot: string;
  skillDir?: string;
  spinesFixture?: string;
  /** The console's own scope (CONSOLE_TENANT), and whether logins scope the store (every world is kept warm then). */
  tenant?: string;
  authOn?: boolean;
  teamRepo?: string;
  /**
   * Read model refresher tick (default 30 s, indexerTickMs), queue poll (1 s), heartbeat (5 s), book check (2 min; 0 = no
   * book: a check reads only each repo's HEAD, and a moved one rebuilds that repo's part from its new commits).
   */
  tickMs?: number;
  pollMs?: number;
  beatMs?: number;
  bookTickMs?: number;
  /** First book build this long after the start (default 20 s, after the read model's first pass has had its turn). */
  bookFirstMs?: number;
  /** Every repo the cache holds is looked at this often (a moved checkout is re-read, default 60 s). */
  keepFreshMs?: number;
  /** log how many repos came from the cache this long after the start (default 2 min; 0 = no log). */
  startReportMs?: number;
  /** rescan gap (default CONSOLE_RESCAN_GAP_MS or 5 min; tests set it). */
  rescanGapMs?: number;
  revision?: string;
  /** a scan host that runs spines.py for this one (CONSOLE_SPINES_REMOTE); undefined = every scan runs here. */
  spinesRemote?: string;
  /** the console's identity (owner, home world …), set by main.ts before anything loads (E996-S29). */
  identity?: Partial<Identity>;
}

export interface IndexerDeps {
  /** The raw spines.py runner (tests: a fake); default from skillDir / spinesFixture. */
  spines?: SpinesRunner;
  git?: GitOut;
  log?: (msg: string) => void;
  now?: () => number;
}

export function createIndexer(db: DB, c: IndexerConfig, d: IndexerDeps = {}) {
  ensureIndexerTables(db);
  const log = d.log ?? ((m: string) => console.log(m));
  const now = d.now ?? Date.now;
  const startedAt = now();
  let runs = 0;
  const here = d.spines ?? (c.spinesFixture ? fixtureRunner(c.spinesFixture) : c.skillDir ? spinesPyRunner(c.skillDir) : undefined);
  // with a scan host, a clean checkout's scan runs there; anything it cannot read falls back to `here`.
  const remote = here && c.spinesRemote && !c.spinesFixture ? remoteSpinesRunner({ url: c.spinesRemote, local: here, log }) : undefined;
  const raw: SpinesRunner | undefined = remote ?? here;
  const counted: SpinesRunner | undefined = raw && ((dir) => (runs++, raw(dir)));
  // the scanner each stored output was read with (another one re-reads it), and git's blame and first-added
  // answers kept in console.db, so a restart (a deploy, a crash) asks git nothing it already answered.
  const scanner = d.spines ? () => undefined : scannerVersion(c.skillDir);
  const seed = seedFrom(db, scanner);
  useGitMemo({ get: (k) => kvGet(db, k)?.v, set: (k, v) => kvSet(db, k, v) });
  let seeded = 0;
  let afterSeed: ((dir: string) => void) | undefined;
  const spines = counted
    ? cachedRunner(persistingRunner(counted, db, { scanner }), 60_000, now, log, {
        minGapMs: c.spinesFixture ? 0 : (c.rescanGapMs ?? rescanGapMs()),
        seed: (dir) => {
          const s = seed(dir);
          if (s) seeded++;
          return s;
        },
        onSeedRefreshed: (dir) => afterSeed?.(dir),
      })
    : undefined;

  // The refresher asks for spines.py output as it did from its worker thread (one cache, one run per repo in flight).
  const bridge = spines
    ? workerSpinesRunner((ask) => answerSpinesAsk(spines, ask, (r) => bridge!.onReply(r)), startedAt, now)
    : undefined;

  let t3: { at: number; v: Record<string, { status: string; checkedAt: string }> } = { at: 0, v: {} };
  const t3State = (runId: string) => {
    if (now() - t3.at > 5_000) t3 = { at: now(), v: kvGet<Record<string, { status: string; checkedAt: string }>>(db, T3_KEY)?.v ?? {} };
    return t3.v[runId];
  };
  const worlds = (): string[] => {
    if (!c.authOn) return [c.tenant ?? ""];
    try {
      return (db.prepare("SELECT DISTINCT tenant_id AS t FROM milestones").all() as { t: string }[]).map((r) => r.t);
    } catch {
      return [c.tenant ?? ""];
    }
  };
  const homeThread = (assignmentId: string): string | undefined => {
    try {
      return (db.prepare("SELECT thread_id FROM cycle_assignment_link WHERE assignment_id = ?").get(assignmentId) as { thread_id: string | null } | undefined)?.thread_id ?? undefined;
    } catch {
      return undefined;
    }
  };
  const refresher = createRefresher({
    db,
    reposRoot: c.reposRoot,
    ...(bridge ? { spines: bridge.run } : {}),
    ...(c.tenant ? { tenant: c.tenant } : {}),
    ...(c.teamRepo ? { teamRepo: c.teamRepo } : {}),
    worlds: worlds(),
    homeThread,
    t3State,
    rescanGapMs: c.spinesFixture ? 0 : (c.rescanGapMs ?? rescanGapMs()),
    log,
  });
  afterSeed = (dir) => refresher.dirty(dir); // a repo kept on its seed through the gap was read again

  const commits: BookCommitsStore = {
    get: (dir) => kvGet<{ head: string; commits: never[] }>(db, `book-commits:${dir}`)?.v,
    set: (dir, v) => kvSet(db, `book-commits:${dir}`, v),
  };
  const book =
    spines && c.bookTickMs !== 0
      ? createBook({ repos: () => listRepos(c.reposRoot), spines, git: d.git ?? gitOut(30_000), store: bookStore(db, log), commits, log })
      : undefined;

  let drifting = false;
  const handle = (m: IndexerMsg) => {
    switch (m.type) {
      case "dirty":
        refresher.dirty(m.dir, m.stale ? { stale: true } : undefined);
        return;
      case "dirtyAll":
        refresher.dirtyAll();
        return;
      case "register":
        refresher.register(m.key as ViewKey);
        return;
      case "spines":
        if (!spines) return;
        spines.invalidate(m.dir, m.stale ? { stale: true } : undefined);
        void spines(m.dir).catch(() => undefined); // stored when done (persistingRunner)
        return;
      case "drift":
        if (drifting) return;
        drifting = true;
        void refresher
          .driftCheck(m.confirmAfterMs !== undefined ? { confirmAfterMs: m.confirmAfterMs } : {})
          .then((r) => kvSet(db, DRIFT_KEY, r))
          .catch((e) => log(`indexer: drift check failed: ${(e as Error).message}`))
          .finally(() => (drifting = false));
        return;
      case "book":
        if (!book) return;
        if (m.rebuild) void book.rebuild().catch(() => undefined);
        else {
          book.invalidate();
          book.tick();
        }
        return;
    }
  };
  const poll = () => {
    let msgs: IndexerMsg[] = [];
    try {
      msgs = takeIndexerMsgs(db);
    } catch (e) {
      log(`indexer: queue: ${(e as Error).message}`);
    }
    for (const m of msgs) {
      try {
        handle(m);
      } catch (e) {
        log(`indexer: ${m.type}: ${(e as Error).message}`);
      }
    }
  };
  const beat = () => {
    let repos = 0;
    try {
      repos = (db.prepare("SELECT COUNT(*) AS n FROM spines_cache").get() as { n: number }).n;
    } catch {
      /* next beat */
    }
    const b: IndexerBeat = {
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      ...(c.revision ? { revision: c.revision } : {}),
      repos,
      runs,
      seeded,
      ...(book?.builtAt() ? { book: new Date(book.builtAt()).toISOString() } : {}),
      ...(remote ? { scans: remote.stats() } : {}),
      saved: { skippedCommits: refresher.skippedCommits(), bookReused: book?.stats().reused ?? 0, bookBuilt: book?.stats().built ?? 0, bookIncremental: book?.stats().incremental ?? 0 },
    };
    try {
      kvSet(db, BEAT_KEY, b, new Date(now()).toISOString());
    } catch (e) {
      log(`indexer: heartbeat: ${(e as Error).message}`);
    }
  };
  /** Every checkout the cache holds (the console may read one no view reads): a moved one is re-read, one at a time. */
  const keepFresh = () => {
    if (!spines) return;
    let dirs: string[] = [];
    try {
      dirs = (db.prepare("SELECT dir FROM spines_cache").all() as { dir: string }[]).map((r) => r.dir);
    } catch {
      return;
    }
    for (const dir of dirs) {
      // a checkout that is gone (a removed tester world, moved aside) leaves the cache, with its book commits.
      if (!fs.existsSync(dir)) {
        try {
          db.prepare("DELETE FROM spines_cache WHERE dir = ?").run(dir);
          db.prepare("DELETE FROM indexer_kv WHERE k = ?").run(`book-commits:${dir}`);
          log(`indexer: ${dir} is gone; its cached scan dropped`);
        } catch (e) {
          log(`indexer: drop ${dir}: ${(e as Error).message}`);
        }
        continue;
      }
      void spines(dir).catch(() => undefined);
    }
  };

  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, f: () => void) => {
    if (ms > 0) timers.push(setInterval(f, ms));
  };
  return {
    start() {
      beat();
      poll();
      void refresher.tick();
      every(c.tickMs ?? indexerTickMs(), () => void refresher.tick());
      every(c.pollMs ?? 1_000, poll);
      every(c.beatMs ?? 5_000, beat);
      every(c.keepFreshMs ?? 60_000, keepFresh);
      if (book) {
        const first = setTimeout(() => {
          void book.prewarm();
          book.start(c.bookTickMs ?? 2 * 60_000);
        }, c.bookFirstMs ?? 20_000);
        timers.push(first as unknown as ReturnType<typeof setInterval>);
      }
      // how warm the start was (the proof a restart did no cold rescan), once, a while after it.
      if ((c.startReportMs ?? 120_000) > 0) {
        const report = setTimeout(() => {
          const total = (() => {
            try {
              return (db.prepare("SELECT COUNT(*) AS n FROM spines_cache").get() as { n: number }).n;
            } catch {
              return 0;
            }
          })();
          log(`indexer: after start: ${seeded} of ${total} repos from the cache, ${runs} spines.py runs in the first ${Math.round((c.startReportMs ?? 120_000) / 1000)} s`);
        }, c.startReportMs ?? 120_000);
        report.unref?.();
        timers.push(report as unknown as ReturnType<typeof setInterval>);
      }
      log(`indexer: started (pid ${process.pid}, repos root ${c.reposRoot}${c.revision ? `, release ${c.revision.slice(0, 7)}` : ""})`);
    },
    stop() {
      useGitMemo(undefined);
      for (const t of timers) clearInterval(t);
      refresher.stop();
      book?.stop();
    },
    poll,
    beat,
    refresher,
    book,
    spines,
    stats: () => ({ runs, seeded }),
  };
}

export type Indexer = ReturnType<typeof createIndexer>;
