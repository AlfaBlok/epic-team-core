import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";

/**
 * `repos`: checkouts under `<dir>/repos` (the console's repos root), each `{ "<name>": { "<rel>": "<text>" } }`;
 * asks live in spines now, so a test that needs an open ask writes it there.
 */
export function tempApp(opts: { staticDir?: string; browser?: NonNullable<Parameters<typeof createApp>[1]>["browser"]; repos?: Record<string, Record<string, string>> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-test-"));
  const db: DB = openDb(path.join(dir, "nested", "console.db"));
  const { repos, ...rest } = opts;
  const reposRoot = path.join(dir, "repos");
  for (const [name, files] of Object.entries(repos ?? {}))
    for (const [rel, text] of Object.entries({ ".git/config": `[remote "origin"]\n\turl = https://github.com/Acme/${name}.git\n`, ...files })) {
      fs.mkdirSync(path.dirname(path.join(reposRoot, name, rel)), { recursive: true });
      fs.writeFileSync(path.join(reposRoot, name, rel), text);
    }
  // Never the live browser service: default to a closed port.
  const app = createApp(db, {
    ...rest,
    browser: opts.browser ?? { browserUrl: "http://127.0.0.1:9" },
    ...(repos ? { read: { reposRoot, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } } : {}),
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
  };
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, dir, call, cleanup };
}

/**
 * env for a broker home that never reads the test host. broker.py refuses a local pick at load5 >= 2 x CPUs
 * and at the live T3 session cap; without these a busy the worker server (load5 27 on 8 CPUs) made the gateway
 * tests' picks answer `id: null, high load` and fail only in loaded full-suite runs.
 */
export function quietBrokerHost(home: string): NodeJS.ProcessEnv {
  fs.writeFileSync(path.join(home, "loadavg"), "0.50 0.50 0.50 1/500 1\n");
  fs.writeFileSync(path.join(home, "sessions.json"), JSON.stringify({ live: 0, threads: [], at: "2099-01-01T00:00:00Z" }));
  return {
    DISPATCH_LOADAVG: path.join(home, "loadavg"),
    DISPATCH_NPROC: "8",
    DISPATCH_SESSIONS: path.join(home, "sessions.json"),
    DISPATCH_PROCS: "0", // never the test host's real provider processes
    BROKER_CONSOLE_DB: path.join(home, "no-console.db"),
  };
}

/** Host settings a broker test must not inherit from the shell it runs in. */
export const BROKER_HOST_ENV = ["DISPATCH_LOAD_PER_CPU", "BROKER_MAX_VPS1_SESSIONS", "BROKER_MAX_PER_SEAT", "T3_MCP_URL"];
