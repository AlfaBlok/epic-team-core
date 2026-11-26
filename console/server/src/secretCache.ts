import { execFile } from "./spawnHost.js";
import fs from "node:fs";
import path from "node:path";
import { keyIndexFile } from "./identity.js";

/**
 * the console's root-only secrets (/etc/the home world-secrets/<app>/<NAME>) read once and kept in memory. Every read
 * used to fork `sudo -n cat <file>` (about 6 a minute on the main server: the Gmail poll, OpenAI calls), each fork of the 300+ MB
 * console holding its event loop. A value is re-read only when:
 *  - the store changed: `secret put/rm` rewrites the names-only index (/var/lib/the home world-secrets/index.json), whose
 *    mtime/size is checked (a stat, no sudo) on every read; the console's own put/remove also forgets the file;
 *  - its user said it failed (`forgetSecret(file)`, e.g. Gmail refused the password);
 *  - it was missing: a miss is kept 5 minutes, then read again;
 *  - the console restarts.
 * CONSOLE_NO_SUDO=1 (staging) never reads the store.
 *
 * A first source may be set (`setSecretSource`; the hosted layer sets the owner's vault). Every read asks it first; the root-only
 * copy is read only when it has no such key or does not answer in time, and each such read is counted by name
 * (`secretSourceHealth`, /api/health `keys`), so the copy can be deleted once nothing falls back to it.
 *
 * Fetch on use: with a first source set, its answers are never kept here (it fetches at each use and holds only what it
 * lists by name), and a copy answer is kept at most COPY_HOLD_MS. Without one (a host with no vault), the copy is read once and kept as above.
 */
const MISS_MS = 5 * 60_000;
export const COPY_HOLD_MS = 5 * 60_000;
const cache = new Map<string, { v: string | undefined; at: number; until?: number }>();
const inflight = new Map<string, Promise<Got>>();
let indexStamp: string | undefined;

const indexFile = () => keyIndexFile();
function storeStamp(): string {
  try {
    const s = fs.statSync(indexFile());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "none";
  }
}

/** For tests: how many times the store was actually read. */
export const secretReads = { n: 0 };

/** a first source for a store file's value (app = its folder, name = the file); undefined = it has none. */
export type SecretSource = {
  name: string;
  read(app: string, name: string): Promise<string | undefined>;
  /** the answer, or undefined when the source could not answer (killed, timed out, backing off). `{ v: undefined }`
   * = it answered and has no such key. `again`: the one retry after a miss, which may skip a backoff. */
  lookup?(app: string, name: string, o?: { again?: boolean }): Promise<{ v: string | undefined } | undefined>;
  stats?(): Record<string, unknown>;
};
/** the key exists as far as anyone knows, but its source did not answer twice: "try again", never "no key". */
export class KeyNotReady extends Error {
  constructor(readonly label: string) {
    super(`${label}: the key store did not answer in time`);
  }
}
let source: SecretSource | undefined;
const SOURCE_WAIT_MS = 90_000;
const tally = { source: 0, store: 0, storeNames: new Set<string>(), since: new Date().toISOString() };
export function setSecretSource(s: SecretSource | undefined): void {
  source = s;
  cache.clear();
  tally.source = 0;
  tally.store = 0;
  tally.storeNames.clear();
  tally.since = new Date().toISOString();
}
/** one journal line per read that fell back to the store's copy, the name only, never a value, so a "clean day" with no
 * fallback can be read across restarts, where the /api/health counters start again at every deploy. */
export const COPY_FALLBACK_LOG = "keys: copy fallback";
function logCopyFallback(label: string): void {
  if (!process.env.VITEST) console.warn(`${COPY_FALLBACK_LOG} ${label}`);
}
/** where the console's keys came from since it started: names only, never a value. */
/** a linked workspace's keys at use (the hosted layer counts them): from the first source, or its stored copy. */
const worldTally = { source: 0, store: 0, storeNames: new Set<string>() };
export function countWorldKeyRead(from: "source" | "copy", label: string): void {
  if (from === "source") worldTally.source++;
  else {
    worldTally.store++;
    worldTally.storeNames.add(label);
    logCopyFallback(label);
  }
}
/** stored copies per workspace store (the hosted layer counts them; names only). */
let worldStored: (() => Record<string, number>) | undefined;
export function setWorldStoredCounter(f: (() => Record<string, number>) | undefined): void {
  worldStored = f;
}
export function secretSourceHealth(): {
  from: string;
  fromSource: number;
  fromCopy: number;
  copyNames: string[];
  since: string;
  memory?: Record<string, unknown>;
  worlds: { fromSource: number; fromCopy: number; copyNames: string[]; stored?: Record<string, number> };
} {
  return {
    from: source?.name ?? "copy",
    fromSource: tally.source,
    fromCopy: tally.store,
    copyNames: [...tally.storeNames].sort(),
    since: tally.since,
    ...(source?.stats ? { memory: source.stats() } : {}),
    worlds: { fromSource: worldTally.source, fromCopy: worldTally.store, copyNames: [...worldTally.storeNames].sort(), ...(worldStored ? { stored: worldStored() } : {}) },
  };
}
const storeKey = (file: string): { app: string; name: string } | undefined => {
  const m = /^\/etc\/[^/]+-secrets\/([^/]+)\/([A-Za-z0-9_.-]+)$/.exec(file);
  return m ? { app: m[1], name: m[2] } : undefined;
};
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then((v) => resolve(v), () => resolve(undefined)).finally(() => clearTimeout(t));
  });
/** the first source, then the copy; counted. `kept: false` = the source answered: not kept here. */
/** the wait for the source, settable by tests. */
let sourceWaitMs = SOURCE_WAIT_MS;
export function setSourceWaitMs(ms?: number): void {
  sourceWaitMs = ms ?? SOURCE_WAIT_MS;
}
type Got = { v: string | undefined; kept: boolean; holdMs?: number; unanswered?: boolean };
/**
 * the first source, then the copy; counted. `kept: false` = the source answered: not kept here.
 * A release that stops the console mid-fetch kills the source's run: a source that did not answer is asked once more (a
 * use joins a fetch still running); when it still has not answered and the copy has nothing, the read is `unanswered`:
 * never kept as a miss, and `sudoReadOrWait` turns it into KeyNotReady, so a caller says "connecting" and tries again,
 * never "no key".
 */
async function sourceThenCopy(file: string, copy: (file: string) => Promise<string | undefined>): Promise<Got> {
  const k = source ? storeKey(file) : undefined;
  let unanswered = false;
  if (source && k) {
    const lookup = source.lookup?.bind(source);
    if (lookup) {
      let a = await within(lookup(k.app, k.name), sourceWaitMs);
      if (!a) a = await within(lookup(k.app, k.name, { again: true }), sourceWaitMs);
      if (a?.v) {
        tally.source++;
        return { v: a.v, kept: false };
      }
      unanswered = !a;
    } else {
      const v = await within(source.read(k.app, k.name), sourceWaitMs);
      if (v) {
        tally.source++;
        return { v, kept: false };
      }
    }
  }
  const v = await copy(file);
  if (v && k) {
    tally.store++;
    tally.storeNames.add(`${k.app}/${k.name}`);
    logCopyFallback(`${k.app}/${k.name}`);
  }
  if (!v && unanswered) return { v: undefined, kept: false, unanswered: true };
  return source && k ? { v, kept: true, holdMs: COPY_HOLD_MS } : { v, kept: true };
}

function sudoCat(file: string): Promise<string | undefined> {
  secretReads.n++;
  return new Promise((resolve) =>
    execFile("sudo", ["-n", "cat", file], { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined)),
  );
}

/** A root-only file's value (cached as above); mcp/services.ts sudoRead is this. */
export const sudoRead = (file: string): Promise<string | undefined> => cachedSudoRead(file);

type ReadOpts = { read?: (file: string) => Promise<string | undefined>; copy?: (file: string) => Promise<string | undefined>; now?: () => number };
export function cachedSudoRead(file: string, o: ReadOpts = {}): Promise<string | undefined> {
  return cachedGot(file, o).then((r) => r.v);
}
/** like sudoRead, but a key its source did not answer for (twice) throws KeyNotReady instead of reading as missing. */
export function sudoReadOrWait(file: string, o: ReadOpts = {}): Promise<string | undefined> {
  return cachedGot(file, o).then((r) => {
    if (r.unanswered) throw new KeyNotReady(storeKey(file) ? `${storeKey(file)!.app}/${storeKey(file)!.name}` : path.basename(file));
    return r.v;
  });
}
function cachedGot(file: string, o: ReadOpts): Promise<Got> {
  if (process.env.CONSOLE_NO_SUDO === "1") return Promise.resolve({ v: undefined, kept: false });
  const now = o.now ?? Date.now;
  const stamp = storeStamp();
  if (stamp !== indexStamp) {
    if (indexStamp !== undefined) cache.clear();
    indexStamp = stamp;
  }
  const hit = cache.get(file);
  if (hit && (hit.v !== undefined ? hit.until === undefined || now() < hit.until : now() - hit.at < MISS_MS)) return Promise.resolve({ v: hit.v, kept: true });
  const going = inflight.get(file);
  if (going) return going;
  const p = (o.read ? o.read(file).then((v): Got => ({ v, kept: true })) : sourceThenCopy(file, o.copy ?? sudoCat))
    .catch((): Got => ({ v: undefined, kept: false }))
    .then((r) => {
      if (r.kept) cache.set(file, r.holdMs !== undefined ? { v: r.v, at: now(), until: now() + r.holdMs } : { v: r.v, at: now() });
      else cache.delete(file);
      return r;
    })
    .finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

/** Drop a kept value (it failed, or the console just wrote or removed it); no argument drops them all. */
export function forgetSecret(file?: string): void {
  if (file === undefined) cache.clear();
  else cache.delete(file);
}
