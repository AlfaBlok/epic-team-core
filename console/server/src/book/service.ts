import fs from "node:fs";
import path from "node:path";
import type { Repo } from "../adapters/repos.js";
import type { DB } from "../db.js";
import type { SpinesRunner } from "../adapters/spines.js";
import type { GitOut } from "../freshness.js";
import { assembleBook, buildRepoBook, parseGitLog, type Book, type BookCommit, type BookRepo } from "./build.js";
import { readPreviews } from "./deliverables.js";

/**
 * the Epic Book, built in the background and served from memory. A request never spawns git or spines.py and
 * never waits on a build except the very first one (bounded by `softMs`): a stale book (older than `ttlMs`, or
 * invalidated by a pull of a checkout) is answered at once and starts one rebuild (git spawns on the request
 * path stalled the server). The git log of a repo is read again only when its HEAD moved, and HEAD is read from the
 *.git files, so a rebuild with no new commits spawns no git at all. Rework: the last book is stored (bookStore) and
 * served at once after a restart, and a timer (start) rebuilds on a moved HEAD, an old book or a failed build, read or not.
 */
export const BOOK_TTL_MS = 60_000;
/** A stale book whose repos' HEADs have not moved is kept (no spines.py, no git) until it is this old. */
export const BOOK_MAX_AGE_MS = 10 * 60_000;
export const BOOK_SINCE_DAYS = 120;
/** With no reader, the timer rebuilds an unchanged book (no HEAD moved) only this often: uncommitted spine edits. */
export const BOOK_IDLE_MAX_AGE_MS = 30 * 60_000;
const LOG_MAX = 4000;
const LOG_ARGS = (days: number) => ["log", `--since=${days}.days`, "--no-color", "-n", String(LOG_MAX), "--format=%x1e%h%x1f%cI%x1f%s", "--name-only"];

/** HEAD commit of a checkout from its.git files (loose ref, else packed-refs); undefined when it cannot be read. */
export function headOf(repoDir: string): string | undefined {
  const git = path.join(repoDir, ".git");
  try {
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(\S+)/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
    try {
      return fs.readFileSync(path.join(git, ref), "utf8").trim() || undefined;
    } catch {
      const packed = fs.readFileSync(path.join(git, "packed-refs"), "utf8");
      return packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0];
    }
  } catch {
    return undefined;
  }
}

/**
 * rework (the owner 2026-11-02, "got this not the book"): the last built book, kept in console.db so a restart serves it
 * at once (the cold build takes 20 s+ under load) and the rebuild runs behind it.
 */
export interface BookStore {
  load(): Book | null;
  save(b: Book): void;
  /** when the stored book was built (cheap: no JSON), to tell whether it moved. */
  stamp?(): string | undefined;
}

export function bookStore(db: DB, log: (msg: string) => void = (m) => console.warn(m)): BookStore {
  db.exec(`CREATE TABLE IF NOT EXISTS book_cache (id INTEGER PRIMARY KEY CHECK (id = 1), built_at TEXT NOT NULL, data TEXT NOT NULL);`);
  return {
    load() {
      try {
        const r = db.prepare("SELECT data FROM book_cache WHERE id = 1").get() as { data: string } | undefined;
        return r ? (JSON.parse(r.data) as Book) : null;
      } catch (e) {
        log(`book: stored book unreadable: ${(e as Error).message}`);
        return null;
      }
    },
    save(b) {
      db.prepare("INSERT OR REPLACE INTO book_cache (id, built_at, data) VALUES (1, ?, ?)").run(b.builtAt, JSON.stringify(b));
    },
    stamp() {
      try {
        return (db.prepare("SELECT built_at FROM book_cache WHERE id = 1").get() as { built_at: string } | undefined)?.built_at;
      } catch {
        return undefined;
      }
    },
  };
}

/** each repo's book commits as of its HEAD, kept across restarts (the indexer stores them in console.db). */
export interface BookCommitsStore {
  get(dir: string): { head: string; commits: BookCommit[] } | undefined;
  set(dir: string, v: { head: string; commits: BookCommit[] }): void;
}

export interface BookView {
  book: Book | null;
  /** A rebuild is running: the next read may differ. */
  building: boolean;
  error?: string;
}

export function createBook(o: {
  repos: () => Repo[];
  spines: SpinesRunner;
  git: GitOut;
  ttlMs?: number;
  maxAgeMs?: number;
  idleMaxAgeMs?: number;
  softMs?: number;
  sinceDays?: number;
  now?: () => number;
  head?: (dir: string) => string | undefined;
  log?: (msg: string) => void;
  /** The last built book survives a restart (bookStore); absent = memory only. */
  store?: BookStore;
  /** the git log of a repo whose HEAD did not move is not read again after a restart. */
  commits?: BookCommitsStore;
}) {
  const ttlMs = o.ttlMs ?? BOOK_TTL_MS;
  const maxAgeMs = o.maxAgeMs ?? BOOK_MAX_AGE_MS;
  const idleMaxAgeMs = o.idleMaxAgeMs ?? BOOK_IDLE_MAX_AGE_MS;
  const softMs = o.softMs ?? 5_000;
  const now = o.now ?? Date.now;
  const head = o.head ?? headOf;
  const log = o.log ?? ((m: string) => console.warn(m));
  const commitsCache = new Map<string, { head: string; commits: BookCommit[] }>();
  let book: Book | null = o.store?.load() ?? null;
  let builtAt = book ? Date.parse(book.builtAt) || 0 : 0;
  /** the last build that found the book current, a new one or the same (no new book when nothing moved). */
  let freshAt = builtAt;
  let checkedAt = 0;
  let heads = "";
  /** HEADs of every repo the book reads, from the.git files: unchanged = nothing was pushed or pulled. */
  const headsNow = () =>
    o
      .repos()
      .filter((r) => r.hasEpicSpine)
      .map((r) => `${r.path}=${head(r.path) ?? "?"}`)
      .join("\n");
  /** A stored book is served at once but rebuilt on the first read or tick (its sources may have moved while down). */
  let dirty = !!book;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<Book> | undefined;
  let lastError: string | undefined;

  const sinceDays = o.sinceDays ?? BOOK_SINCE_DAYS;
  /**
   * the commits since the last HEAD only: the whole 120-day log (4,000 commits with their files, about 2 s of git
   * for a busy repo) was read again at every moved HEAD, about every 2 min. A HEAD that is not a
   * descendant of the last one (a rewritten history) or any git error reads the whole log as before.
   */
  const newerCommits = async (dir: string, from: string, to: string, old: BookCommit[]): Promise<BookCommit[] | undefined> => {
    try {
      await o.git(dir, ["merge-base", "--is-ancestor", from, to]);
      const fresh = parseGitLog(await o.git(dir, [...LOG_ARGS(sinceDays), `${from}..${to}`]));
      const seen = new Set(fresh.map((c) => c.sha));
      const cutoff = now() - sinceDays * 86_400_000;
      return [...fresh, ...old.filter((c) => !seen.has(c.sha))].filter((c) => !(Date.parse(c.date) < cutoff)).slice(0, LOG_MAX);
    } catch {
      return undefined;
    }
  };
  let incremental = 0;

  const commitsOf = async (dir: string): Promise<BookCommit[]> => {
    const h = head(dir);
    const hit = commitsCache.get(dir) ?? (h ? o.commits?.get(dir) : undefined);
    if (hit && h && hit.head === h) return (commitsCache.set(dir, hit), hit.commits);
    const more = hit && h ? await newerCommits(dir, hit.head, h, hit.commits) : undefined;
    if (more) incremental++;
    const commits = more ?? parseGitLog(await o.git(dir, LOG_ARGS(sinceDays)));
    if (h) {
      commitsCache.set(dir, { head: h, commits });
      try {
        o.commits?.set(dir, { head: h, commits });
      } catch (e) {
        log(`book: could not store the commits of ${path.basename(dir)}: ${(e as Error).message}`);
      }
    }
    return commits;
  };

  /**
   * each repo's part of the book as last built, with what it was built from: a repo whose HEAD, spines.py
   * output and the previews did not move keeps its part, so a commit rebuilds one repo's part, not all of them. A build
   * with every part kept makes no new book at all. `full` (an old book, the daily rebuild) builds every part again, so an
   * edit no HEAD shows (an uncommitted card) is in within BOOK_IDLE_MAX_AGE_MS.
   */
  const parts = new Map<string, { head: string; spines: unknown; previews: string; part: BookRepo }>();
  let reused = 0;
  let built = 0;

  // One repo at a time: the host is loaded, and spines.py is already cached per repo (adapters/spines.ts cachedRunner).
  const build = async (full: boolean): Promise<Book | null> => {
    heads = headsNow();
    const out: BookRepo[] = [];
    let changed = full || !book;
    // the tailnet previews any repo has recorded (docs/status/previews.json), so a stopped one names its folder.
    const previews = o.repos().filter((r) => r.hasEpicSpine).flatMap((r) => readPreviews(r.path));
    const previewsKey = JSON.stringify(previews);
    const seen = new Set<string>();
    for (const repo of o.repos().filter((r) => r.hasEpicSpine)) {
      let spines;
      try {
        spines = await o.spines(repo.path);
      } catch (e) {
        log(`book: spines.py failed for ${repo.name}: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      if (!spines.root && !spines.nodes.length) continue;
      seen.add(repo.path);
      const h = head(repo.path);
      const kept = parts.get(repo.path);
      if (!full && kept && h && kept.head === h && kept.spines === spines && kept.previews === previewsKey) {
        out.push(kept.part);
        reused++;
        continue;
      }
      let commits: BookCommit[] = [];
      let error: string | undefined;
      try {
        commits = await commitsOf(repo.path);
      } catch (e) {
        error = `git log failed: ${(e as Error).message.split("\n")[0]}`;
        commits = commitsCache.get(repo.path)?.commits ?? [];
      }
      const part = buildRepoBook(repo, spines, commits, error, { previews });
      built++;
      changed = true;
      if (h && !error) parts.set(repo.path, { head: h, spines, previews: previewsKey, part });
      else parts.delete(repo.path);
      out.push(part);
    }
    for (const dir of [...parts.keys()]) if (!seen.has(dir)) (parts.delete(dir), (changed = true));
    if (!changed && book && out.length === book.repos.length) return null;
    return assembleBook(out, new Date(now()));
  };

  /** when every part was last built from scratch (a full build), for the idle heal. */
  let fullAt = 0;
  const refresh = (full = false): Promise<Book> => {
    if (!pending) {
      const whole = full || !book || now() - fullAt >= idleMaxAgeMs;
      pending = build(whole)
        .then((b) => {
          dirty = false;
          checkedAt = freshAt = now();
          lastError = undefined;
          if (whole) fullAt = now();
          // nothing moved: the book as it was is current (no new book, no 7 MB write).
          if (!b) return book!;
          book = b;
          builtAt = now();
          try {
            o.store?.save(b);
          } catch (e) {
            log(`book: could not store the book: ${(e as Error).message}`);
          }
          return b;
        })
        .catch((e) => {
          lastError = (e as Error).message;
          dirty = true; // retried on the next read or tick
          log(`book: build failed: ${lastError}`);
          throw e;
        })
        .finally(() => {
          pending = undefined;
        });
      pending.catch(() => {});
    }
    return pending;
  };

  /**
   * rework: the book is kept fresh without a reader. No book, a dirty or failed one (dirty stays set after a failed
   * build, so it is retried), one older than idleMaxAgeMs, or a HEAD that moved: rebuild in the background.
   */
  const tick = (): boolean => {
    if (pending) return false;
    if (!book || dirty || now() - fullAt >= idleMaxAgeMs) return (refresh().catch(() => undefined), true);
    checkedAt = now();
    if (headsNow() !== heads) return (refresh().catch(() => undefined), true);
    return false;
  };

  return {
    async get(): Promise<BookView> {
      if (!book) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<void>((r) => {
          timer = setTimeout(r, softMs);
        });
        await Promise.race([refresh().catch(() => {}), late]).finally(() => clearTimeout(timer));
      } else if (dirty || now() - freshAt >= maxAgeMs) refresh();
      else if (!pending && now() - checkedAt >= ttlMs) {
        checkedAt = now();
        if (headsNow() !== heads) refresh();
      }
      return { book, building: !!pending, ...(lastError ? { error: lastError } : {}) };
    },
    /** A checkout was written or pulled: the next read starts a rebuild. */
    invalidate() {
      dirty = true;
    },
    /** daily refresh: a fresh build that starts after now (a build already running is waited out first). */
    async rebuild(): Promise<Book> {
      if (pending) await pending.catch(() => undefined);
      return refresh(true);
    },
    /** How the builds went since the start: repo parts kept or built, and git logs read as only the new commits. */
    stats: () => ({ reused, built, incremental }),
    tick,
    /** Check every `everyMs` (tick) so the book is rebuilt on a spine/git change or when old, read or not. */
    start(everyMs: number) {
      if (timer || everyMs <= 0) return;
      timer = setInterval(tick, everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    /** When the served book was built (ms), 0 = none yet. */
    builtAt: () => (book ? builtAt : 0),
    /** Build once in the background (server start). */
    prewarm: () => refresh().then(
      () => undefined,
      () => undefined,
    ),
  };
}

export type BookService = ReturnType<typeof createBook>;

/**
 * the console's book when the indexer (indexer/main.ts) builds it. The console never runs git or
 * spines.py for it: it serves the stored book (bookStore), parsed again only when the indexer stored a new one, and asks
 * the indexer for a rebuild through the queue. Same face as createBook.
 */
export function followBook(o: { store: BookStore; ask: (rebuild: boolean) => void; pollMs?: number; waitMs?: number; softMs?: number; now?: () => number }): BookService {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 1_000;
  const waitMs = o.waitMs ?? 10 * 60_000;
  const softMs = o.softMs ?? 5_000;
  let book: Book | null = null;
  let seen: string | undefined;
  const load = () => {
    const s = o.store.stamp?.();
    if (s === undefined || s === seen) return;
    const b = o.store.load();
    if (b) {
      book = b;
      seen = s;
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());
  const until = async (moved: () => boolean, ms: number) => {
    const t0 = now();
    while (!moved() && now() - t0 < ms) await sleep(pollMs);
  };
  return {
    async get(): Promise<BookView> {
      load();
      if (!book) await until(() => (load(), !!book), softMs);
      return { book, building: false };
    },
    invalidate() {
      o.ask(false);
    },
    async rebuild(): Promise<Book> {
      load();
      const before = seen;
      o.ask(true);
      await until(() => (load(), seen !== before), waitMs);
      if (!book || seen === before) throw new Error("the indexer did not rebuild the book in time");
      return book;
    },
    stats: () => ({ reused: 0, built: 0, incremental: 0 }),
    tick: () => false,
    start() {},
    stop() {},
    builtAt: () => (book ? Date.parse(book.builtAt) || 0 : 0),
    prewarm: async () => undefined,
  };
}
