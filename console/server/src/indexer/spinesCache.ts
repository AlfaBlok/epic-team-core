import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import { checkoutVersion, parseSpinesJson, type InvalidatableRunner, type SpinesJson, type SpinesRunner } from "../adapters/spines.js";
import { sendToIndexer } from "./queue.js";

/**
 * spines.py output kept in console.db (`spines_cache`, queue.ts). The indexer is the only writer: every run it
 * makes is stored with when it started and the checkout key it read (adapters/spines.ts checkoutVersion). The console
 * reads it (persistedSpinesRunner) and never runs spines.py itself while the indexer is alive.
 */

/**
 * which scanner read an output: a hash of the skill's scripts/*.py (spines.py and the modules it imports), hashed
 * again only when one of them changed size or mtime. Undefined without a skill dir (a fixture): never compared then.
 */
export function scannerVersion(skillDir: string | undefined): () => string | undefined {
  if (!skillDir) return () => undefined;
  const dir = path.join(skillDir, "scripts");
  let memo: { sig: string; ver: string } | undefined;
  return () => {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
      const sig = files.map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.mtimeMs}:${st.size}`;
      }).join("|");
      if (memo?.sig === sig) return memo.ver;
      const h = createHash("sha1");
      for (const f of files) h.update(f).update("\0").update(fs.readFileSync(path.join(dir, f))).update("\0");
      memo = { sig, ver: h.digest("hex").slice(0, 16) };
      return memo.ver;
    } catch {
      return undefined;
    }
  };
}

/** Indexer side: wrap the raw spines.py runner so every run is stored; a failed run keeps the last output, stamped. */
export function persistingRunner(
  run: SpinesRunner,
  db: DB,
  o: { version?: (dir: string, last?: SpinesJson) => string | undefined; now?: () => number; scanner?: () => string | undefined } = {},
): SpinesRunner {
  const version = o.version ?? checkoutVersion;
  const now = o.now ?? Date.now;
  const scanner = o.scanner ?? (() => undefined);
  const last = new Map<string, SpinesJson>();
  const put = db.prepare(
    `INSERT INTO spines_cache (dir, json, ver, started_at, ran_at, scanner) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dir) DO UPDATE SET json = excluded.json, ver = excluded.ver, started_at = excluded.started_at, ran_at = excluded.ran_at, scanner = excluded.scanner`,
  );
  const touch = db.prepare("UPDATE spines_cache SET started_at = ?, ran_at = ? WHERE dir = ?");
  return async (dir) => {
    const from = now();
    const prev = last.get(dir);
    let ver = version(dir, prev);
    const by = scanner();
    try {
      const value = await run(dir);
      // A first run knows no spine files yet, so its key covers only HEAD and the index: take the key over the files it
      // listed when HEAD and the index did not move during the run (else the next start would re-read it for nothing).
      if (!prev && ver !== undefined) {
        const post = version(dir, value);
        const head = (v: string) => v.split("|").slice(0, 2).join("|");
        if (post !== undefined && head(post) === head(ver)) ver = post;
      }
      last.set(dir, value);
      put.run(dir, JSON.stringify(value), ver ?? null, from, now(), by ?? null);
      return value;
    } catch (e) {
      // The readers waiting for a run after their write get the last output now, not after their wait runs out.
      touch.run(from, now(), dir);
      throw e;
    }
  };
}

/**
 * Indexer side: the stored output of a checkout, for cachedRunner's `seed` (a restart re-reads only moved checkouts).
 * an output another scanner read is still served, without its key, so it is read again (within the rescan gap).
 */
export function seedFrom(db: DB, scanner: () => string | undefined = () => undefined): (dir: string) => { value: SpinesJson; ver?: string; from: number } | undefined {
  const get = db.prepare("SELECT json, ver, started_at, scanner FROM spines_cache WHERE dir = ?");
  return (dir) => {
    const r = get.get(dir) as { json: string; ver: string | null; started_at: number; scanner: string | null } | undefined;
    if (!r) return undefined;
    const now = scanner();
    const same = now === undefined || r.scanner === null || r.scanner === now; // a row from before names none
    try {
      return { value: parseSpinesJson(r.json), ...(r.ver && same ? { ver: r.ver } : {}), from: r.started_at };
    } catch {
      return undefined;
    }
  };
}

export interface PersistedRunnerOptions {
  /** The indexer answers (heartbeat recent); when false and a checkout has no stored output, `fallback` runs it here. */
  alive: () => boolean;
  fallback?: SpinesRunner;
  /** How often a waiting read looks at the row again (default 400 ms), and how long it waits at most (default 120 s). */
  pollMs?: number;
  waitMs?: number;
  now?: () => number;
}

/**
 * Console side: a SpinesRunner over `spines_cache`. A read answers from the stored output (parsed once per run, and the
 * same object when the output did not change, so trees memoized on it stay valid). The console's own write
 * (`invalidate` without `stale`) makes the next read wait for a run that started after it, as cachedRunner did; a pull
 * (`stale`) keeps the last output while the indexer re-reads. A checkout never read is asked for and waited on.
 */
export function persistedSpinesRunner(db: DB, o: PersistedRunnerOptions): InvalidatableRunner {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 400;
  const waitMs = o.waitMs ?? 120_000;
  const stamp = db.prepare("SELECT started_at, ran_at FROM spines_cache WHERE dir = ?");
  const body = db.prepare("SELECT json, started_at, ran_at FROM spines_cache WHERE dir = ?");
  const memo = new Map<string, { startedAt: number; ranAt: number; text: string; value: SpinesJson }>();
  /** A run that started at or after this time is what the next read of the dir waits for (the console's own write). */
  const after = new Map<string, number>();
  const waits = new Map<string, { t: number; p: Promise<SpinesJson> }>();
  const fresh = new Map<string, Promise<SpinesJson>>();

  const stored = (dir: string): { startedAt: number; value: SpinesJson } | undefined => {
    const st = stamp.get(dir) as { started_at: number; ran_at: number } | undefined;
    if (!st) return undefined;
    const hit = memo.get(dir);
    if (hit && hit.startedAt === st.started_at && hit.ranAt === st.ran_at) return hit;
    const r = body.get(dir) as { json: string; started_at: number; ran_at: number } | undefined;
    if (!r) return undefined;
    const value = hit && hit.text === r.json ? hit.value : parseSpinesJson(r.json);
    const next = { startedAt: r.started_at, ranAt: r.ran_at, text: r.json, value };
    memo.set(dir, next);
    return next;
  };

  /** The stored output of a run that started at or after `t`; after `waitMs` the last output (or a rejection when none). */
  const waitFor = (dir: string, t: number): Promise<SpinesJson> => {
    const w = waits.get(dir);
    if (w && w.t >= t) return w.p;
    const t0 = now();
    const p = new Promise<SpinesJson>((resolve, reject) => {
      const look = () => {
        let s: ReturnType<typeof stored>;
        try {
          s = stored(dir);
        } catch (e) {
          return reject(e);
        }
        if (s && s.startedAt >= t) return resolve(s.value);
        if (now() - t0 >= waitMs) return s ? resolve(s.value) : reject(new Error(`spines.py: the indexer has not read ${dir} yet`));
        const timer = setTimeout(look, pollMs);
        timer.unref?.();
      };
      look();
    }).finally(() => {
      if (waits.get(dir)?.p === p) waits.delete(dir);
    });
    p.catch(() => {});
    waits.set(dir, { t, p });
    return p;
  };

  const run = (async (dir: string) => {
    const t = after.get(dir);
    if (t !== undefined) {
      const v = await waitFor(dir, t);
      if (after.get(dir) === t) after.delete(dir);
      return v;
    }
    const s = stored(dir);
    if (s) return s.value;
    if (!o.alive() && o.fallback) return o.fallback(dir);
    sendToIndexer(db, { type: "spines", dir });
    return waitFor(dir, 0);
  }) as InvalidatableRunner;
  run.invalidate = (dir, opt) => {
    sendToIndexer(db, { type: "spines", dir, ...(opt?.stale ? { stale: true } : {}) });
    if (opt?.stale && memo.has(dir)) return;
    const t = now();
    after.set(dir, t);
    const p = waitFor(dir, t);
    fresh.set(dir, p);
    void p.finally(() => fresh.get(dir) === p && fresh.delete(dir)).catch(() => {});
  };
  run.since = (dir, t) => {
    const s = stored(dir);
    if (s && s.startedAt >= t) return Promise.resolve(s.value);
    sendToIndexer(db, { type: "spines", dir });
    return waitFor(dir, t);
  };
  run.settled = (dir) => fresh.get(dir);
  return run;
}
