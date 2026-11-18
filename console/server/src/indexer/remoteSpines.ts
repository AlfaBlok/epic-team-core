import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { headSha } from "../gitRefs.js";
import { limiter, parseSpinesJson, type Limiter, type SpinesJson, type SpinesRunner } from "../adapters/spines.js";

/**
 * the indexer's spines.py scans run on another host. Every commit that reached a checkout here was read again by
 * spines.py on this host (20 CPU-s for the code repo on the main server, 1.5-4 min under the indexer's CPU cap, about
 * 170 runs a day for that repo alone). A scan host (`CONSOLE_SPINES_REMOTE`, its own clones of the same repos) reads the
 * same commit instead and answers the same JSON; this host only reads its answer.
 *
 * It is asked only for a checkout it can reproduce: a clean tree (no tracked change; a dirty one is read here) at a commit
 * the scan host can fetch from the same origin. Any other answer (not found, a timeout, the host down, a bad shape)
 * falls back to the local runner, so a scan is never lost; the counts say how often each path ran.
 */
export interface RemoteSpinesStats {
  remote: number;
  local: number;
  /** why the last few fell back here (newest last). */
  why: string[];
}

export interface RemoteSpinesOpts {
  url: string;
  local: SpinesRunner;
  timeoutMs?: number;
  limit?: Limiter;
  fetch?: typeof fetch;
  /** the checkout's commit (tests); default: read from .git. */
  head?: (dir: string) => string | undefined;
  /** true when the checkout has a tracked change (tests); default: `git status --porcelain --untracked-files=no`. */
  dirty?: (dir: string) => Promise<boolean>;
  origin?: (dir: string) => string | undefined;
  log?: (m: string) => void;
}

/** `remote.origin.url` from the checkout's config file, no git child (a worktree's `.git` file: undefined). */
export function originUrl(dir: string): string | undefined {
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    const sec = cfg.split(/^\[/m).find((s) => /^remote "origin"\]/.test(s));
    const m = sec?.match(/^\s*url\s*=\s*(.+?)\s*$/m);
    // never send a credential written into the url
    return m ? m[1].replace(/^(https?:\/\/)[^@/]*@/, "$1") : undefined;
  } catch {
    return undefined;
  }
}

export function gitDirty(dir: string, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) =>
    execFile("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { timeout: timeoutMs }, (err, out) =>
      resolve(err ? true : out.trim() !== ""),
    ),
  );
}

export function remoteSpinesRunner(o: RemoteSpinesOpts): SpinesRunner & { stats: () => RemoteSpinesStats } {
  const st: RemoteSpinesStats = { remote: 0, local: 0, why: [] };
  const limit = o.limit ?? limiter(2);
  const http = o.fetch ?? fetch;
  const timeout = o.timeoutMs ?? 170_000;
  const head = o.head ?? headSha;
  const dirty = o.dirty ?? ((d: string) => gitDirty(d));
  const origin = o.origin ?? originUrl;
  const base = o.url.replace(/\/+$/, "");
  const last = new Map<string, { text: string; value: SpinesJson }>();
  const fallBack = (dir: string, why: string) => {
    st.local++;
    st.why = [...st.why, `${path.basename(dir)}: ${why}`].slice(-5);
    return o.local(dir);
  };
  const run = async (dir: string): Promise<SpinesJson> => {
    const sha = head(dir);
    const url = origin(dir);
    if (!sha || !url) return fallBack(dir, "no commit or origin to name");
    if (await dirty(dir)) return fallBack(dir, "checkout has a tracked change");
    let text: string;
    try {
      const r = await limit(() =>
        http(`${base}/scan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: path.basename(dir), sha, origin: url }),
          signal: AbortSignal.timeout(timeout),
        }),
      );
      text = await r.text();
      if (!r.ok) return fallBack(dir, `scan host ${r.status}: ${text.slice(0, 120)}`);
    } catch (e) {
      return fallBack(dir, `scan host: ${(e as Error).message.split("\n")[0]}`);
    }
    try {
      const prev = last.get(dir);
      if (prev && prev.text === text) {
        st.remote++;
        return prev.value;
      }
      const value = parseSpinesJson(text);
      last.set(dir, { text, value });
      st.remote++;
      return value;
    } catch (e) {
      return fallBack(dir, `scan host answer: ${(e as Error).message}`);
    }
  };
  return Object.assign(run, { stats: () => ({ ...st, why: [...st.why] }) });
}
