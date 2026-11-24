/**
 * Every program the console starts (git log, pull, commit, push, status, ssh, python) is started by one small,
 * long-lived helper process, never by the console itself. Starting a program forks the process that starts it: the
 * console holds 1.5 GB, so each fork cost its one thread 20 to 70 ms (a live profile: 9.4 s of 92.7 s in
 * spawns). The helper is a bare node of ~40 MB started once, at boot (or the first call); the console sends it each job over
 * its IPC channel and gets the outputs back, so a git run costs the thread one message each way.
 *
 * `execFile` here is a drop-in for node's (same arguments, callback, `promisify`, `child.stdin.end(input)`,
 * `child.kill()`), and `groupRun` is the process-group runner the pull and the spine writer use (detached, the whole
 * group killed on timeout, outputs capped). The same job code (CORE below) runs inside the helper and, when the
 * helper cannot start or dies mid-job, in the console itself, so every call behaves as it did before.
 * `CONSOLE_SPAWN_HOST=off` turns the helper off (every call starts in the console again).
 */
import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess, type ExecFileException } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

/** The job runner, as plain JS source: run inside the helper and, as the fallback, inside the console. */
const CORE = String.raw`
const cp = require("node:child_process");
const children = new Map();
function errOut(e) {
  return e ? { message: e.message, code: e.code, killed: e.killed, signal: e.signal, cmd: e.cmd } : null;
}
function runJob(m, reply) {
  if (m.t === "kill") {
    const c = children.get(m.id);
    if (c) try { c.kill(m.signal || "SIGTERM"); } catch {}
    return;
  }
  if (m.t === "exec") {
    let child;
    try {
      child = cp.execFile(m.cmd, m.args, m.o || {}, (err, stdout, stderr) => {
        children.delete(m.id);
        reply({ id: m.id, err: errOut(err), stdout, stderr });
      });
    } catch (e) {
      reply({ id: m.id, err: errOut(e), stdout: "", stderr: "", threw: true });
      return;
    }
    children.set(m.id, child);
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(m.input == null ? "" : m.input);
    }
    return;
  }
  if (m.t === "group") {
    const cap = m.cap || 8 * 1024 * 1024;
    let out = "", err = "", done = false, timedOut = false, child, timer;
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      children.delete(m.id);
      reply({ id: m.id, code: code == null ? null : code, signal: signal || null, out, err, timedOut, error: error || null });
    };
    try {
      child = cp.spawn(m.cmd, m.args, { cwd: m.cwd, env: m.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reply({ id: m.id, code: null, signal: null, out: "", err: "", timedOut: false, error: e.message, threw: true });
      return;
    }
    children.set(m.id, child);
    child.stdout.on("data", (d) => void (out.length < cap && (out += d.toString())));
    child.stderr.on("data", (d) => void (err.length < cap && (err += d.toString())));
    timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      timedOut = true;
      finish(null, "SIGKILL");
    }, m.timeout);
    child.on("error", (e) => finish(null, null, e.message));
    // stdio may still be held by a grandchild: never wait for the pipes past a moment after the exit
    child.on("exit", (code, signal) => { const t = setTimeout(() => finish(code, signal), 500); t.unref && t.unref(); });
    child.on("close", (code, signal) => finish(code, signal));
  }
}
`;

/** The helper: the job runner on the IPC channel; it exits with the console (its channel closes). */
const HELPER = `${CORE}
process.on("message", (m) => runJob(m, (r) => { try { process.send(r); } catch {} }));
process.on("disconnect", () => process.exit(0));
`;

type Reply = Record<string, unknown> & { id: number };
type Job = Record<string, unknown> & { id: number; t: string };

let localRun: ((m: Job, reply: (r: Reply) => void) => void) | undefined;
/** The same runner inside the console: used only when the helper is off, cannot start, or died mid-job. */
function runLocal(job: Job, reply: (r: Reply) => void) {
  localRun ??= new Function("require", `${CORE}\nreturn runJob;`)(createRequire(import.meta.url)) as typeof localRun;
  localRun!(job, reply);
}

let host: ChildProcess | null = null;
let startFailedAt = 0;
let nextId = 1;
const pending = new Map<number, { job: Job; reply: (r: Reply) => void }>();
const stats = { viaHost: 0, local: 0, hostStarts: 0, hostDeaths: 0 };

/**
 * off by `CONSOLE_SPAWN_HOST=off`; under the test runner off unless `on`: its guard (test/realCheckoutGuard.ts) rewrites
 * a git write against a real checkout inside the test process, which a helper process would not see.
 */
const off = () => {
  const v = process.env.CONSOLE_SPAWN_HOST ?? "";
  return /^(off|0|false|no)$/i.test(v) || (!!process.env.VITEST && !/^(on|1|true|yes)$/i.test(v));
};

function holdOpen() {
  const ch = (host as unknown as { channel?: { ref?: () => void; unref?: () => void } } | null)?.channel;
  if (pending.size) ch?.ref?.();
  else ch?.unref?.();
}

function startHost(): ChildProcess | null {
  if (host?.connected) return host;
  if (off() || Date.now() - startFailedAt < 30_000) return null;
  let h: ChildProcess;
  try {
    h = nodeSpawn(process.execPath, ["--max-old-space-size=256", "-e", HELPER], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
      env: { ...process.env },
    });
  } catch {
    startFailedAt = Date.now();
    return null;
  }
  stats.hostStarts++;
  host = h;
  h.unref();
  h.on("message", (r: Reply) => {
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    holdOpen();
    p.reply(r);
  });
  const died = () => {
    if (host !== h) return;
    host = null;
    stats.hostDeaths++;
    startFailedAt = Date.now();
    // every job it held runs again in the console: a died helper never loses a call (a kill job has no answer)
    const left = [...pending.values()];
    pending.clear();
    for (const p of left) runLocal(p.job, p.reply);
  };
  h.on("exit", died);
  h.on("error", died);
  h.on("disconnect", died);
  holdOpen();
  return h;
}

/** Start the helper now (at boot, while the console is still small, so its one fork is cheap). */
export function startSpawnHost(): boolean {
  return !!startHost();
}

/** Send a job to the helper, or run it here when there is none. */
function submit(job: Job, reply: (r: Reply) => void) {
  const h = startHost();
  if (h) {
    pending.set(job.id, { job, reply });
    holdOpen();
    try {
      h.send(job);
      stats.viaHost++;
      return;
    } catch {
      pending.delete(job.id);
      holdOpen();
    }
  }
  stats.local++;
  runLocal(job, reply);
}

function kill(id: number, signal?: string) {
  if (host?.connected && pending.has(id)) {
    try {
      host.send({ id, t: "kill", signal });
    } catch {
      /* the helper is gone: its jobs run here and are killed with it */
    }
  } else runLocal({ id, t: "kill", signal }, () => {});
}

/** How many calls went through the helper, how many ran here (GET /api/health shows it). */
export const spawnHostStats = () => ({ ...stats, up: !!host?.connected, pid: host?.pid, pending: pending.size, off: off() });

const asBuffer = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);

function toError(e: Record<string, unknown>, cmd: string, args: readonly string[]): ExecFileException {
  const err = new Error(String(e.message ?? `${cmd} failed`)) as ExecFileException;
  if (e.code !== undefined) (err as { code?: unknown }).code = e.code;
  if (e.killed !== undefined) err.killed = e.killed as boolean;
  if (e.signal !== undefined) err.signal = e.signal as NodeJS.Signals;
  err.cmd = (e.cmd as string | undefined) ?? [cmd, ...args].join(" ");
  return err;
}

type Cb = (err: ExecFileException | null, stdout: any, stderr: any) => void;

/** What the caller holds: stdin to hand input (ended at once, as every caller does) and kill. */
class HostedChild {
  readonly pid = undefined;
  input: string[] = [];
  stdin = {
    write: (d: string | Buffer) => (this.input.push(String(d)), true),
    end: (d?: string | Buffer) => {
      if (d != null) this.input.push(String(d));
    },
    on: () => this.stdin,
    once: () => this.stdin,
  };
  constructor(private readonly id: number) {}
  kill(signal?: NodeJS.Signals | number) {
    kill(this.id, typeof signal === "string" ? signal : undefined);
    return true;
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
}

function hostedExecFile(cmd: string, ...rest: unknown[]) {
  let args: readonly string[] = [];
  let opts: Record<string, unknown> = {};
  let cb: Cb | undefined;
  for (const a of rest) {
    if (typeof a === "function") cb = a as Cb;
    else if (Array.isArray(a)) args = a;
    else if (a && typeof a === "object") opts = a as Record<string, unknown>;
  }
  const id = nextId++;
  const child = new HostedChild(id);
  // the job leaves after the caller's synchronous stdin.end(input) (collector, repoIndex hand a script on stdin)
  queueMicrotask(() => {
    const o: Record<string, unknown> = { ...opts };
    delete o.signal; // an AbortSignal does not cross the channel (no caller passes one)
    o.env = { ...((o.env as NodeJS.ProcessEnv | undefined) ?? process.env) };
    o.cwd ??= process.cwd();
    const job: Job = { id, t: "exec", cmd, args: [...args], o, input: child.input.length ? child.input.join("") : undefined };
    submit(job, (r) => {
      const stdout = asBuffer(r.stdout ?? "");
      const stderr = asBuffer(r.stderr ?? "");
      const err = r.err ? Object.assign(toError(r.err as Record<string, unknown>, cmd, args), { stdout, stderr }) : null;
      cb?.(err, stdout, stderr);
    });
  });
  return child;
}
(hostedExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (cmd: string, args?: readonly string[], opts?: Record<string, unknown>) =>
  new Promise((resolve, reject) =>
    hostedExecFile(cmd, args ?? [], opts ?? {}, ((err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))) as Cb),
  );

/** node's execFile, started by the helper: same arguments, callback and promisify; the child offers stdin.end and kill. */
export const execFile = hostedExecFile as unknown as typeof nodeExecFile;

export interface GroupResult {
  /** exit code; null when killed, timed out or never started */
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
  timedOut: boolean;
  /** why it did not start or failed to run (spawn error) */
  error: string | null;
}

/** A program in its own process group, the whole group killed at `timeout`, outputs capped (default 8 MB). */
export function groupRun(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number; cap?: number }): Promise<GroupResult> {
  return new Promise((resolve) => {
    const id = nextId++;
    submit({ id, t: "group", cmd, args, cwd: o.cwd ?? process.cwd(), env: { ...(o.env ?? process.env) }, timeout: o.timeout, cap: o.cap }, (r) =>
      resolve({ code: (r.code as number | null) ?? null, signal: (r.signal as string | null) ?? null, out: String(r.out ?? ""), err: String(r.err ?? ""), timedOut: !!r.timedOut, error: (r.error as string | null) ?? null }),
    );
  });
}

/** For tests: drop the helper; jobs it still held run here (the next call starts a new one). */
export function stopSpawnHost() {
  const h = host;
  host = null;
  startFailedAt = 0;
  h?.removeAllListeners();
  const left = [...pending.values()];
  pending.clear();
  for (const p of left) runLocal(p.job, p.reply);
  try {
    h?.kill();
  } catch {
    /* gone */
  }
}
