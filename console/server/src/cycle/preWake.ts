import { execFile } from "node:child_process";
import path from "node:path";
import { HEAL_SCRIPT, healedLine, lockHealer, localHealRunner, type HealResult, type HealRunner } from "../gitStaleLock.js";
import { type HostId, mainHost, workerHost } from "../identity.js";
import { withRepoLock } from "../repoLock.js";
import { recoverPull } from "./syncRecover.js";

/**
 * every persona wake runs the repo's current tool code. Before the console sends a wake into a persona's home
 * thread it fast-forwards that persona's checkout ON ITS HOST (the main server here, the worker server over the console's ssh access) and
 * fingerprints the repo's tool code: `.mcp.json` plus every repo path its stdio servers start (and that path's
 * directory, for sibling imports). Stdio MCP servers start once per T3 session, so when the fingerprint differs from the
 * one the home thread started with, the wake goes to a fresh home thread (new session, new MCP processes).
 * A pull still failing after the lock retry and heal goes to `recoverPull` (fetch + merge by name, local
 * commits already on main dropped, clean-merging local edits stashed and put back; never a reset); what it cannot
 * heal is recorded on the run with its reason and told to the persona.
 */
export type Host = HostId;
/**
 * Runs `git -C dir...args` on a host; resolves with stdout, rejects with the git error lines. `healLock`, when
 * set, deletes a stale lock a pull error names on that host (gitStaleLock.ts; undefined = not a lock error).
 */
export type HostGit = ((host: Host, dir: string, args: string[]) => Promise<string>) & {
  healLock?: (host: Host, dir: string, msg: string) => Promise<HealResult | undefined>;
};

/** Tool fingerprint of a checkout without `.mcp.json` (nothing to restart). */
export const NO_TOOLS = "none";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The error lines of git's stderr (`error:` / `fatal:`), else its last line; one line, at most 300 chars. */
export function gitReason(stderr: string, fallback: string): string {
  const lines = String(stderr || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /^(error|fatal):/i.test(l));
  const files = lines.filter((l) => /^\S+\.\w+$/.test(l)).slice(0, 3); // "would be overwritten" lists files on their own lines
  const why = errs.length ? [...errs, ...files].join(" ") : lines.pop() || fallback;
  return why.length > 300 ? `${why.slice(0, 297)}...` : why;
}

export function hostGit(o: { worker?: { ssh: string; sshKey?: string; knownHosts: string }; timeoutMs?: number } = {}): HostGit {
  const timeout = o.timeoutMs ?? 30_000;
  const sshArgs = (v: { ssh: string; sshKey?: string; knownHosts: string }, cmd: string) => [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${v.knownHosts}`,
    ...(v.sshKey ? ["-i", v.sshKey] : []),
    v.ssh,
    cmd,
  ];
  const vps3Heal: HealRunner = (d, f, min) =>
    new Promise((resolve, reject) => {
      if (!o.worker) return reject(new Error(`${workerHost()} ssh not configured (CONSOLE_VPS3_SSH unset)`));
      execFile("ssh", sshArgs(o.worker, ["sh", "-c", HEAL_SCRIPT, "heal", d, f, String(min)].map(shq).join(" ")), { timeout: 20_000, encoding: "utf8" }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      );
    });
  const healers: Record<HostId, ReturnType<typeof lockHealer>> = { [mainHost()]: lockHealer(localHealRunner), [workerHost()]: lockHealer(vps3Heal) };
  const run: HostGit = (host, dir, args) =>
    new Promise((resolve, reject) => {
      const done = (err: (Error & { killed?: boolean; code?: unknown }) | null, stdout: string, stderr: string) => {
        if (!err) return resolve(String(stdout));
        if (host === workerHost() && err.code === 255) return reject(new Error(`ssh to ${workerHost()} failed: ${gitReason(stderr, "unreachable")}`));
        reject(new Error(gitReason(stderr, err.killed ? `timed out after ${timeout} ms` : err.message)));
      };
      if (host === mainHost()) {
        execFile("git", ["-C", dir, ...args], { timeout, maxBuffer: 4 << 20, encoding: "utf8" }, done);
        return;
      }
      if (!o.worker) return reject(new Error(`${workerHost()} ssh not configured (CONSOLE_VPS3_SSH unset)`));
      execFile("ssh", sshArgs(o.worker, ["git", "-C", dir, ...args].map(shq).join(" ")), { timeout, maxBuffer: 4 << 20, encoding: "utf8" }, done);
    });
  run.healLock = (host, dir, msg) => healers[host](dir, msg);
  return run;
}

/**
 * Repo-relative paths a `.mcp.json` starts: each stdio server's command and args that look like a relative path
 * (`scripts/x.py`, `./bin/tool`), plus each one's directory. Flags, URLs and absolute paths are left out.
 */
export function mcpToolPaths(mcpJson: string): string[] {
  let cfg: unknown;
  try {
    cfg = JSON.parse(mcpJson);
  } catch {
    return [];
  }
  const servers = (cfg as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const out = new Set<string>();
  for (const s of Object.values(servers)) {
    if (!s || typeof s !== "object") continue;
    const { type, command, args } = s as { type?: unknown; command?: unknown; args?: unknown };
    if (type !== undefined && type !== "stdio") continue;
    for (const v of [command, ...(Array.isArray(args) ? args : [])]) {
      if (typeof v !== "string" || !v || v.startsWith("-") || v.startsWith("/") || v.startsWith("~") || v.includes("://")) continue;
      const rel = path.posix.normalize(v.replace(/^\.\//, ""));
      if (rel.startsWith("..") || !/[/.]/.test(rel)) continue; // `python3`, `npx`: not a repo path
      out.add(rel);
      const d = path.posix.dirname(rel);
      if (d !== ".") out.add(d);
    }
  }
  return [...out].sort();
}

export interface PreWake {
  /** HEAD before / after the pull (short). */
  from?: string;
  to?: string;
  pull: { ok: true } | { ok: false; reason: string };
  /** `none` (no.mcp.json) or the blob/tree ids of `.mcp.json` and the paths it starts, at HEAD. */
  toolFp: string;
  /** Paths the fingerprint covers (for the run note). */
  toolPaths: string[];
  /** a stale lock was removed before the (re)tried pull. */
  healed?: string;
  /** what the self-heal did after the plain pull was refused. */
  recovered?: string;
}

/** Fast-forward `dir` on `host` and fingerprint its tool code. Never throws: an unreadable checkout gives toolFp undefined. */
export async function prepareCheckout(git: HostGit, host: Host, dir: string, retryMs = 2_000, recover = true): Promise<PreWake | { error: string }> {
  const head = async () => (await git(host, dir, ["rev-parse", "--short", "HEAD"])).trim();
  let from: string;
  try {
    from = await head();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const once = () =>
    git(host, dir, ["pull", "-q", "--ff-only"]).then(
      () => ({ ok: true }) as const,
      (e) => ({ ok: false, reason: (e as Error).message }) as const,
    );
  let pull: PreWake["pull"] = await once();
  // the run-end pull of the same checkout may hold the lock for a moment: one retry
  if (!pull.ok && /index\.lock|another git process/i.test(pull.reason)) pull = await new Promise((r) => setTimeout(r, retryMs)).then(once);
  // still refused on a stale lock (> 10 min, no git running there): delete it and try once more
  let healed: string | undefined;
  if (!pull.ok && git.healLock) {
    const h = await git.healLock(host, dir, pull.reason).catch(() => undefined);
    if (h?.removed) {
      healed = healedLine(dir, h);
      console.warn(`pre-wake ${dir} on ${host}: ${healed}`);
      pull = await once();
    }
  }
  let recovered: string | undefined;
  if (!pull.ok && recover) {
    const first = pull.reason;
    const heal = () => recoverPull((args) => git(host, dir, args), { retryMs });
    // the console's own git in this checkout (main server) waits its turn; the worker server has none
    const r = await (host === mainHost() ? withRepoLock(dir, heal) : heal()).catch((e) => ({ ok: false as const, reason: (e as Error).message, tried: true }));
    if (r.ok) {
      pull = { ok: true };
      recovered = `self-healed (${first}): ${r.did}`;
      console.warn(`pre-wake ${dir} on ${host}: ${recovered}`);
    } else if (r.tried) pull = { ok: false, reason: `${first} (self-heal: ${r.reason})` };
  }
  const to = pull.ok ? await head().catch(() => from) : from;
  let mcp: string | undefined;
  try {
    mcp = await git(host, dir, ["show", "HEAD:.mcp.json"]);
  } catch {
    mcp = undefined; // no.mcp.json at HEAD
  }
  const extra = { ...(healed ? { healed } : {}), ...(recovered ? { recovered } : {}) };
  if (mcp === undefined) return { from, to, pull, toolFp: NO_TOOLS, toolPaths: [], ...extra };
  const toolPaths = [".mcp.json", ...mcpToolPaths(mcp)];
  // ls-tree -r lists every blob under those paths (missing ones are skipped): "<mode> blob <id>\t<path>" per file.
  const tree = await git(host, dir, ["ls-tree", "-r", "HEAD", "--", ...toolPaths]).catch(() => "");
  const fp = tree
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [meta, p] = l.split("\t");
      return `${p}@${meta.split(" ")[2]?.slice(0, 12)}`;
    })
    .sort()
    .join(",");
  return { from, to, pull, toolFp: fp || NO_TOOLS, toolPaths, ...extra };
}

/** Why a home thread must not take this wake (undefined = reuse it). `known` = the fingerprint the thread started with. */
export function staleSessionReason(known: string | undefined, now: string): string | undefined {
  if (known === now) return undefined;
  if (known === undefined) return now === NO_TOOLS ? undefined : "repo tools (.mcp.json) present, home thread started before tool tracking";
  return `repo tool code changed since the home thread started (${changedPaths(known, now).join(", ") || ".mcp.json"})`;
}

const entries = (fp: string) => new Map(fp === NO_TOOLS ? [] : fp.split(",").map((e) => e.split("@") as [string, string]));
export function changedPaths(a: string, b: string): string[] {
  const x = entries(a);
  const y = entries(b);
  return [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)).sort();
}

/** One line for the run (`preWake`): what the pre-wake step did. */
export function preWakeLine(host: Host, pw: PreWake | { error: string }, fresh?: string): string {
  if ("error" in pw) return `pre-wake: ${host} checkout unreadable: ${pw.error}`;
  const pulled = pw.pull.ok ? (pw.from === pw.to ? `pulled ${host} (at ${pw.to})` : `pulled ${host} ${pw.from}→${pw.to}`) : `pull failed on ${host} (at ${pw.from}): ${pw.pull.reason}`;
  return `pre-wake: ${pw.healed ? `${pw.healed} · ` : ""}${pw.recovered ? `${pw.recovered} · ` : ""}${pulled}${fresh ? ` · fresh session: ${fresh}` : ""}`;
}
