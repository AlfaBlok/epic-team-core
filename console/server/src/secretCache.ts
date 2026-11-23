import { execFile } from "node:child_process";
import fs from "node:fs";
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
 */
const MISS_MS = 5 * 60_000;
/**
 * A first source that is still cold (its one listing runs
 * about 30 s after every start) is waited for at most COLD_WAIT_MS; the copy answers meanwhile, kept only until the
 * source is warm, then the key is read from the source.
 */
export const COLD_WAIT_MS = 1500;
const cache = new Map<string, { v: string | undefined; at: number; provisional?: boolean }>();
const inflight = new Map<string, Promise<string | undefined>>();
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
export type SecretSource = { name: string; read(app: string, name: string): Promise<string | undefined>; warm?(): boolean; stats?(): Record<string, number> };
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
/** where the console's keys came from since it started: names only, never a value. */
/** a linked workspace's keys at use (the hosted layer counts them): from the first source, or its stored copy. */
const worldTally = { source: 0, store: 0, storeNames: new Set<string>() };
export function countWorldKeyRead(from: "source" | "copy", label: string): void {
  if (from === "source") worldTally.source++;
  else {
    worldTally.store++;
    worldTally.storeNames.add(label);
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
  memory?: Record<string, number>;
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
/** the first source, then the copy; counted. */
async function sourceThenCopy(file: string, copy: (file: string) => Promise<string | undefined>): Promise<{ v: string | undefined; provisional?: boolean }> {
  const k = source ? storeKey(file) : undefined;
  let cold = false;
  if (source && k) {
    cold = !!source.warm && !source.warm();
    const v = await within(source.read(k.app, k.name), cold ? COLD_WAIT_MS : SOURCE_WAIT_MS);
    if (v) {
      tally.source++;
      return { v };
    }
    cold = !!source.warm && !source.warm();
  }
  const v = await copy(file);
  if (v && k) {
    tally.store++;
    tally.storeNames.add(`${k.app}/${k.name}`);
  }
  return cold ? { v, provisional: true } : { v };
}

function sudoCat(file: string): Promise<string | undefined> {
  secretReads.n++;
  return new Promise((resolve) =>
    execFile("sudo", ["-n", "cat", file], { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined)),
  );
}

/** A root-only file's value (cached as above); mcp/services.ts sudoRead is this. */
export const sudoRead = (file: string): Promise<string | undefined> => cachedSudoRead(file);

export function cachedSudoRead(file: string, o: { read?: (file: string) => Promise<string | undefined>; copy?: (file: string) => Promise<string | undefined>; now?: () => number } = {}): Promise<string | undefined> {
  if (process.env.CONSOLE_NO_SUDO === "1") return Promise.resolve(undefined);
  const now = o.now ?? Date.now;
  const stamp = storeStamp();
  if (stamp !== indexStamp) {
    if (indexStamp !== undefined) cache.clear();
    indexStamp = stamp;
  }
  const hit = cache.get(file);
  // a provisional answer (the source was cold) holds until the source is warm, then the key is read from it
  const provisionalOver = !!hit?.provisional && !!source?.warm?.();
  if (hit && !provisionalOver && (hit.v !== undefined || now() - hit.at < MISS_MS)) return Promise.resolve(hit.v);
  const going = inflight.get(file);
  if (going) return going;
  type Got = { v: string | undefined; provisional?: boolean };
  const p = (o.read ? o.read(file).then((v): Got => ({ v })) : sourceThenCopy(file, o.copy ?? sudoCat))
    .catch((): Got => ({ v: undefined }))
    .then((r) => {
      cache.set(file, r.provisional ? { v: r.v, at: now(), provisional: true } : { v: r.v, at: now() });
      return r.v;
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
