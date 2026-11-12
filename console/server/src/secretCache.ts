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
 */
const MISS_MS = 5 * 60_000;
const cache = new Map<string, { v: string | undefined; at: number }>();
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

function sudoCat(file: string): Promise<string | undefined> {
  secretReads.n++;
  return new Promise((resolve) =>
    execFile("sudo", ["-n", "cat", file], { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined)),
  );
}

/** A root-only file's value (cached as above); mcp/services.ts sudoRead is this. */
export const sudoRead = (file: string): Promise<string | undefined> => cachedSudoRead(file);

export function cachedSudoRead(file: string, o: { read?: (file: string) => Promise<string | undefined>; now?: () => number } = {}): Promise<string | undefined> {
  if (process.env.CONSOLE_NO_SUDO === "1") return Promise.resolve(undefined);
  const now = o.now ?? Date.now;
  const stamp = storeStamp();
  if (stamp !== indexStamp) {
    if (indexStamp !== undefined) cache.clear();
    indexStamp = stamp;
  }
  const hit = cache.get(file);
  if (hit && (hit.v !== undefined || now() - hit.at < MISS_MS)) return Promise.resolve(hit.v);
  const going = inflight.get(file);
  if (going) return going;
  const p = (o.read ?? sudoCat)(file)
    .catch(() => undefined)
    .then((v) => {
      cache.set(file, { v, at: now() });
      return v;
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
