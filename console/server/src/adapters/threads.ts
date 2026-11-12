import fs from "node:fs";
import { RETRY_DELAYS_MS, withT3Retry } from "../t3/client.js";

/** Same shape as the web `Thread` (contract: read-only views). */
export interface Thread {
  id: string;
  title: string;
  project: string;
  /** Project workspace root (used to map the thread to a repo). */
  workspaceRoot?: string;
  milestoneId?: string;
  status: string;
  updatedAt: string;
  parentThreadId?: string;
  seat?: string;
  model?: string;
}

export interface T3Config {
  /** Fixed MCP URL, or a resolver called per request (T3 can move ports on restart; see t3/url.ts). */
  url: string | (() => string);
  tokenFile: string;
  timeoutMs?: number;
  /** backoff between attempts on a transient socket error (default 0.5 s, 1.5 s). */
  retryDelaysMs?: number[];
}

/** Minimal MCP streamable-HTTP client (same calls as the ops dir/tools/mcpcall.py). */
export function createMcpClient(cfg: T3Config) {
  // Per request. 10 s was too short under host load (2026-10-19: ~19 parallel calls, 26 s total); T3_TIMEOUT_MS overrides.
  const timeoutMs = cfg.timeoutMs ?? (Number(process.env.T3_TIMEOUT_MS) || 45_000);
  let token: string | undefined;
  const headers = (sid?: string) => {
    token ??= fs.readFileSync(cfg.tokenFile, "utf8").trim();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(sid ? { "mcp-session-id": sid } : {}),
    };
  };
  const resolveUrl = () => (typeof cfg.url === "function" ? cfg.url() : cfg.url);
  const post = async (url: string, body: unknown, sid?: string) => {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(sid),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`T3 MCP HTTP ${res.status}`);
    let text = await res.text();
    for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) text = line.slice(5).trim();
    return { sid: res.headers.get("mcp-session-id") ?? sid, json: text.trim() ? JSON.parse(text) : undefined };
  };

  // One MCP session per server URL: if T3 moved (new port), the old session id is meaningless there.
  let session: Promise<string | undefined> | undefined;
  let sessionUrl: string | undefined;
  const init = (url: string) => {
    if (sessionUrl !== url) session = undefined;
    sessionUrl = url;
    return (session ??= (async () => {
      const { sid } = await post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-team-console", version: "0" } },
      });
      await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      return sid;
    })().catch((e) => {
      session = undefined;
      throw e;
    }));
  };

  let seq = 2;
  /** a transient socket error (ECONNRESET,...) retries with a fresh session; the final error keeps its cause. */
  function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    return withT3Retry(`tools/call ${name}`, () => callOnce<T>(name, args), cfg.retryDelaysMs ?? RETRY_DELAYS_MS);
  }
  async function callOnce<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    const url = resolveUrl();
    const sid = await init(url);
    let json: any;
    try {
      ({ json } = await post(url, { jsonrpc: "2.0", id: seq++, method: "tools/call", params: { name, arguments: args } }, sid));
    } catch (e) {
      session = undefined; // network error / HTTP 4xx-5xx (e.g. T3 restarted): fresh session next time
      throw e;
    }
    if (json?.error) {
      session = undefined; // e.g. expired session: start fresh next time
      throw new Error(`T3 MCP ${name}: ${json.error.message ?? "error"}`);
    }
    const res = json?.result ?? {};
    if (res.isError) throw new Error(`T3 MCP ${name}: ${res.content?.[0]?.text ?? "tool error"}`);
    return (res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? "null")) as T;
  }
  return { call };
}

/** run `fn` over `items` with at most `limit` in flight (results in input order). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Parallel t3_thread_list calls per refresh; 14 at once fed the socket resets on a loaded host. */
export const THREAD_LIST_CONCURRENCY = 4;

export type ThreadLister = () => Promise<Thread[]>;

const ACTIVE = ["running", "starting", "queued", "preparing", "waiting"];
const rank = (s: string) => {
  const i = ACTIVE.indexOf(s);
  return i < 0 ? ACTIVE.length : i;
};

/** Active threads first, then newest first. */
export function sortThreads(list: Thread[]): Thread[] {
  return [...list].sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Unsettled threads across all T3 projects (t3_project_list → t3_thread_list per project). */
export function t3ThreadLister(cfg: T3Config): ThreadLister {
  const mcp = createMcpClient(cfg);
  return async () => {
    const { projects = [] } = await mcp.call<{ projects: any[] }>("t3_project_list", {});
    const lists = await mapLimit(
      projects.filter((p) => !p.deletedAt),
      THREAD_LIST_CONCURRENCY,
      async (p) => {
        const r = await mcp.call<{ threads: any[] }>("t3_thread_list", { projectId: p.id, settled: false, limit: 100 });
        return (r?.threads ?? []).map(
          (t): Thread => ({
            id: t.threadId,
            title: t.title,
            project: p.title,
            workspaceRoot: t.worktreePath ?? p.workspaceRoot ?? undefined,
            status: t.status,
            updatedAt: t.updatedAt,
            parentThreadId: t.parentThreadId ?? undefined,
            seat: t.providerInstanceId?.replace(/^claudeAgent_/, "") ?? undefined,
            model: t.model ?? undefined,
          }),
        );
      },
    );
    return sortThreads(lists.flat());
  };
}
