import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { execFile } from "../spawnHost.js";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { IndexerConfig } from "./core.js";
import { identity, sites } from "../identity.js";

/**
 * the console starts its indexer (main.ts) as its own systemd user unit, niced and CPU-capped,
 * so the scans never take CPU from the requests (the owner's buttons). `systemd-run --user` makes it a transient unit next
 * to the console's (no root, no unit file to install, gone when stopped); one name per console port, so production and
 * staging each have theirs. Without a user systemd (tests, a laptop) it is a plain child process, niced.
 */
export type IndexerLaunchMode = "unit" | "child";

export interface IndexerLimits {
  nice: number;
  /** systemd CPUQuota (share of one core), CPUWeight against the console's default 100, MemoryMax. */
  cpuQuota: string;
  cpuWeight: number;
  memoryMax: string;
}

export const INDEXER_LIMITS: IndexerLimits = { nice: 15, cpuQuota: "60%", cpuWeight: 20, memoryMax: "1500M" };

/**
 * the limits from the env, so each copy sets its own cap: CONSOLE_INDEXER_CPU_QUOTA (e.g. "20%" for a staging copy that
 * shares a CPU-capped host with production). Anything else: the defaults.
 */
export function indexerLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): IndexerLimits {
  const q = env.CONSOLE_INDEXER_CPU_QUOTA?.trim();
  return { ...INDEXER_LIMITS, ...(q && /^\d{1,3}%$/.test(q) ? { cpuQuota: q } : {}) };
}

/** The bundle next to the server bundle (dist/indexer.mjs), else (tsx) indexer-dev.mjs, which loads main.ts. */
export function indexerFile(): string | undefined {
  const here = import.meta.url;
  const cand = here.endsWith(".mjs") ? new URL("./indexer.mjs", here) : new URL("./indexer-dev.mjs", here);
  const p = fileURLToPath(cand);
  return fs.existsSync(p) ? p : undefined;
}

export const indexerUnit = (port: string | number) => `agent-team-console-indexer-${port}`;

/** The env the indexer gets: what spines.py, git and node need, never the console's secrets. */
export function indexerEnv(c: IndexerConfig, parentPid: number, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "NODE_ENV", "CONSOLE_RESCAN_GAP_MS", "CONSOLE_INDEXER_TICK_MS", "CONSOLE_SPINES_CONCURRENCY", "CONSOLE_INDEX_REPOS", "TZ"];
  const out: Record<string, string> = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]!;
  // the console's identity travels in the config (E996-S29): main.ts sets it before the indexer's modules load.
  out.CONSOLE_INDEXER_CONFIG = JSON.stringify({ ...c, identity: c.identity ?? identity(), sites: c.sites ?? sites() });
  out.CONSOLE_INDEXER_PARENT = String(parentPid);
  return out;
}

/** The systemd-run command line of the unit (exported for the tests). */
export function unitArgs(unit: string, file: string, env: Record<string, string>, cwd: string, l: IndexerLimits = INDEXER_LIMITS): string[] {
  return [
    "--user",
    `--unit=${unit}`,
    "--collect",
    "--quiet",
    `--working-directory=${cwd}`,
    `--property=Nice=${l.nice}`,
    `--property=CPUQuota=${l.cpuQuota}`,
    `--property=CPUWeight=${l.cpuWeight}`,
    `--property=MemoryMax=${l.memoryMax}`,
    "--property=IOSchedulingClass=idle",
    "--property=Restart=on-failure",
    "--property=RestartSec=10",
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
    process.execPath,
    file,
  ];
}

export interface IndexerHandle {
  how: IndexerLaunchMode;
  unit?: string;
  stop(): Promise<void>;
}

/**
 * Start the indexer (an earlier one of this console is stopped first: it ran the release before this restart).
 * Undefined when there is no indexer file; the caller then keeps scanning in process, as before.
 */
export function launchIndexer(o: {
  config: IndexerConfig;
  mode: IndexerLaunchMode;
  port: string | number;
  log?: (msg: string) => void;
  limits?: IndexerLimits;
  file?: string;
}): IndexerHandle | undefined {
  const log = o.log ?? ((m: string) => console.log(m));
  const file = o.file ?? indexerFile();
  if (!file) {
    log("indexer: no indexer bundle next to the server");
    return undefined;
  }
  const limits = o.limits ?? INDEXER_LIMITS;
  const env = indexerEnv(o.config, process.pid);
  const cwd = process.cwd();
  if (o.mode === "unit") {
    const unit = indexerUnit(o.port);
    const ctl = (args: string[]) => {
      try {
        execFileSync("systemctl", ["--user", ...args], { stdio: "ignore", timeout: 20_000 });
      } catch {
        /* not loaded: nothing to stop */
      }
    };
    ctl(["stop", unit]);
    ctl(["reset-failed", unit]);
    try {
      execFileSync("systemd-run", unitArgs(unit, file, env, cwd, limits), { stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 });
      log(`indexer: started as user unit ${unit} (nice ${limits.nice}, CPUQuota ${limits.cpuQuota}, CPUWeight ${limits.cpuWeight}); log: journalctl --user -u ${unit}`);
      return {
        how: "unit",
        unit,
        stop: () => new Promise<void>((res) => execFile("systemctl", ["--user", "stop", unit], { timeout: 20_000 }, () => res())),
      };
    } catch (e) {
      const err = (e as { stderr?: Buffer }).stderr?.toString().trim().split("\n")[0] ?? (e as Error).message;
      log(`indexer: systemd-run failed (${err}); starting it as a niced child process`);
    }
  }
  const child: ChildProcess = spawn(process.execPath, [file], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  try {
    if (child.pid) os.setPriority(child.pid, limits.nice);
  } catch {
    /* runs at the console's priority */
  }
  child.on("exit", (code, sig) => log(`indexer: child process exited (${sig ?? code})`));
  log(`indexer: started as child process ${child.pid} (nice ${limits.nice})`);
  return {
    how: "child",
    stop: () =>
      new Promise<void>((res) => {
        if (child.exitCode !== null || child.signalCode) return res();
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(res, 5_000).unref?.();
      }),
  };
}
