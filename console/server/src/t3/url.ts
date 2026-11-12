import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the local T3 server's MCP endpoint lives. T3 may listen on a random port after a restart (seen
 * 2026-10-19: 37397 instead of 3773), and it writes the real one to ~/.t3/userdata/server-runtime.json
 * (`origin`, `port`, `pid`). Order: explicit T3_MCP_URL → that file's `origin` + "/mcp" → 127.0.0.1:3773.
 * The file is re-read at most every CACHE_MS, so a later T3 restart is picked up without restarting us.
 */
export const DEFAULT_T3_MCP_URL = "http://127.0.0.1:3773/mcp";
const CACHE_MS = 2_000;

export function defaultRuntimeFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.T3_RUNTIME_FILE || path.join(os.homedir(), ".t3", "userdata", "server-runtime.json");
}

/** `origin` from the runtime file as an MCP URL, or undefined if the file is missing/unreadable/odd. */
export function mcpUrlFromRuntimeFile(file: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    let origin: unknown = j?.origin;
    if (typeof origin !== "string" && Number.isInteger(j?.port)) origin = `http://127.0.0.1:${j.port}`;
    if (typeof origin !== "string") return undefined;
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.origin}/mcp`;
  } catch {
    return undefined;
  }
}

/** A resolver function: call it per request; cheap (cached for CACHE_MS). */
export function t3UrlResolver(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): () => string {
  const explicit = env.T3_MCP_URL;
  if (explicit) return () => explicit;
  const file = defaultRuntimeFile(env);
  let cache: { at: number; url: string } | undefined;
  return () => {
    const t = now();
    if (!cache || t - cache.at >= CACHE_MS) cache = { at: t, url: mcpUrlFromRuntimeFile(file) ?? DEFAULT_T3_MCP_URL };
    return cache.url;
  };
}
