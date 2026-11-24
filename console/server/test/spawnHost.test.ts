// programs the console starts run in one small helper process; the answers match node's execFile.
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, groupRun, spawnHostStats, startSpawnHost, stopSpawnHost } from "../src/spawnHost.js";

const both = (f: typeof nodeExecFile, cmd: string, args: string[], o: Record<string, unknown> = {}, input?: string) =>
  new Promise<{ err: { code?: unknown; killed?: boolean; signal?: unknown } | null; stdout: unknown; stderr: unknown }>((resolve) => {
    const c = f(cmd, args, o as never, (err, stdout, stderr) => resolve({ err: err ? { code: err.code, killed: err.killed, signal: err.signal } : null, stdout, stderr }));
    if (input !== undefined) c.stdin?.end(input);
  });

describe("spawn host", () => {
  // the test runner keeps it off by default (its checkout guard lives in this process): on for these tests
  beforeAll(() => void (process.env.CONSOLE_SPAWN_HOST = "on"));
  afterAll(() => {
    stopSpawnHost();
    delete process.env.CONSOLE_SPAWN_HOST;
  });

  it("starts one helper process, not the console, for each call", async () => {
    expect(startSpawnHost()).toBe(true);
    const s0 = spawnHostStats();
    expect(s0.up).toBe(true);
    expect(s0.pid).not.toBe(process.pid);
    const r = await both(execFile, "sh", ["-c", "echo $PPID"]);
    expect(Number(String(r.stdout).trim())).toBe(s0.pid);
    expect(spawnHostStats().viaHost).toBeGreaterThan(s0.viaHost);
  });

  it("answers like node's execFile: output, stdin, exit codes, timeouts, buffers, cwd and env", async () => {
    const cases: [string, string[], Record<string, unknown>, string?][] = [
      ["git", ["--version"], {}],
      ["cat", [], { encoding: "utf8" }, "hello\nworld"],
      ["sh", ["-c", "echo out; echo err >&2; exit 3"], {}],
      ["sleep", ["5"], { timeout: 200 }],
      ["printf", ["\\x01\\x02"], { encoding: "buffer" }],
      ["sh", ["-c", "pwd; echo $SPAWNHOSTVAR"], { cwd: "/tmp", env: { ...process.env, SPAWNHOSTVAR: "yes" } }],
      ["no-such-program-spawnhost", [], {}],
      ["sh", ["-c", "head -c 3000 /dev/zero"], { maxBuffer: 100 }],
    ];
    for (const [cmd, args, o, input] of cases) {
      const [a, b] = await Promise.all([both(execFile, cmd, args, o, input), both(nodeExecFile, cmd, args, o, input)]);
      expect(a, cmd).toEqual(b);
    }
  });

  it("keeps util.promisify's { stdout, stderr } and its rejection", async () => {
    const run = promisify(execFile);
    expect(await run("sh", ["-c", "echo a; echo b >&2"])).toEqual({ stdout: "a\n", stderr: "b\n" });
    await expect(run("sh", ["-c", "exit 2"])).rejects.toMatchObject({ code: 2 });
  });

  it("kills a running call", async () => {
    const t = Date.now();
    const r = await new Promise<{ killed?: boolean }>((resolve) => {
      const c = execFile("sleep", ["5"], (err) => resolve({ killed: err?.killed }));
      setTimeout(() => c.kill(), 200);
    });
    expect(r.killed).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("runs a process group, kills the whole group on timeout", async () => {
    const ok = await groupRun("sh", ["-c", "echo hi; echo oops >&2"], { timeout: 5000 });
    expect(ok).toMatchObject({ code: 0, out: "hi\n", err: "oops\n", timedOut: false, error: null });
    const t = Date.now();
    const slow = await groupRun("sh", ["-c", "sleep 30 & sleep 30; echo never"], { timeout: 300 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
    const missing = await groupRun("no-such-program-spawnhost", [], { timeout: 1000 });
    expect(missing.error).toMatch(/ENOENT/);
  });

  it("a helper that dies mid-call loses nothing: the call runs in the console", async () => {
    startSpawnHost();
    const p = both(execFile, "sh", ["-c", "sleep 0.3; echo done"]);
    await new Promise((r) => setTimeout(r, 50));
    process.kill(spawnHostStats().pid!, "SIGKILL");
    expect(String((await p).stdout)).toBe("done\n");
  });

  it("under the test runner it is off unless asked for", async () => {
    stopSpawnHost();
    delete process.env.CONSOLE_SPAWN_HOST;
    try {
      expect(startSpawnHost()).toBe(false);
      expect(spawnHostStats().off).toBe(true);
    } finally {
      process.env.CONSOLE_SPAWN_HOST = "on";
    }
  });

  it("CONSOLE_SPAWN_HOST=off starts every call in the console", async () => {
    stopSpawnHost();
    process.env.CONSOLE_SPAWN_HOST = "off";
    try {
      const before = spawnHostStats().local;
      const r = await both(execFile, "sh", ["-c", "echo $PPID"]);
      expect(Number(String(r.stdout).trim())).toBe(process.pid);
      expect(spawnHostStats().local).toBe(before + 1);
    } finally {
      process.env.CONSOLE_SPAWN_HOST = "on";
    }
  });
});
