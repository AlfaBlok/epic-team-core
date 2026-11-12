import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t3UrlResolver } from "./url.js";
import { repoAliases } from "../adapters/repoNames.js";
import { seatDir, sites } from "../identity.js";

/**
 * The T3 operations the console cycle needs. The real implementation talks to the local T3 server's
 * MCP endpoint the same way the ops dir/tools/mcpcall.py does; tests use a fake.
 */
export type T3Schedule =
  | { type: "interval"; everyMs: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays?: number[] };

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  repositoryIdentity?: { displayName?: string; canonicalKey?: string; name?: string } | null;
}

export interface T3ScheduledTask {
  id: string;
  title?: string;
  enabled?: boolean;
  nextRunAt?: string;
  boundThreadId?: string;
  raw: Record<string, unknown>;
}

export interface T3ModelSelection {
  instanceId: string;
  model: string;
}

/** t3_thread_send modes the console uses: auto (default), steer (in-flight update to the running turn). */
export type T3SendMode = "auto" | "steer";

export interface T3Client {
  listProjects(): Promise<T3Project[]>;
  listScheduledTasks(projectId: string): Promise<T3ScheduledTask[]>;
  updateScheduledTask(
    id: string,
    patch: { prompt?: string; title?: string; schedule?: T3Schedule; enabled?: boolean },
  ): Promise<T3ScheduledTask | undefined>;
  deleteScheduledTask(id: string): Promise<void>;
  runScheduledTaskNow(id: string): Promise<void>;
  launchThread(input: {
    projectId: string;
    title: string;
    message?: string;
    modelSelection?: T3ModelSelection;
  }): Promise<{ threadId: string }>;
  sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: T3SendMode): Promise<void>;
  readThreadStatus(threadId: string): Promise<T3ThreadState>;
  /** the text of the thread's newest error item (e.g. "Provider error: The provider could not start this turn. …"), if any. */
  readLastError?(threadId: string): Promise<string | undefined>;
  /** register an existing checkout as a T3 project (never creates the directory). Optional: a client without it cannot register. */
  createProject?(input: { title: string; workspaceRoot: string }): Promise<void>;
  /** clone `owner/name` into destinationPath (T3 never adopts or removes an existing destination). Returns the checkout path. */
  cloneProject?(input: { repository: string; destinationPath: string }): Promise<{ cwd: string }>;
  /** this T3 server's environment id (t3_environment_read), for t3code://threads/<env>/<thread> links. Optional. */
  readEnvironmentId?(): Promise<string>;
  /** threads delegated from a parent thread (optional: a client without it just skips adoption). */
  listChildThreads?(projectId: string, parentThreadId: string): Promise<T3ChildThread[]>;
  /** messages waiting in a thread's queue to start a turn (a stopped queue waits for the user: not counted). */
  queuedCount?(threadId: string): Promise<number>;
  /** interrupt the running turn of a thread (t3_thread_interrupt; no-op when it has none). Optional: a client without it cannot stop. */
  interruptThread?(threadId: string, reason?: string, clientRequestId?: string): Promise<void>;
  /**
   * settle an idle thread (t3_thread_organize settle): T3 detaches its provider sessions, which stops the
   * provider process; the next send un-settles it and resumes the same provider session. T3 refuses a running thread.
   */
  settleThread?(threadId: string): Promise<void>;
  /** one page of a thread's user + assistant messages, oldest first (optional: the Team desk chat needs it). */
  readThreadMessages?(threadId: string, opts?: { afterPosition?: number; limit?: number; maxCharsPerItem?: number }): Promise<T3MessagePage>;
}

/** a user or assistant message of a T3 thread (`t3_thread_read` view=messages items; tool and reasoning items never get here). */
export interface T3ThreadMessage {
  itemId: string;
  /** Position in the thread timeline (ascending; gaps are normal: other item types sit between messages). */
  position: number;
  role: "user" | "assistant";
  text: string;
  /** `completed` once the message is final; anything else may still change. */
  status: string;
  /** T3 reports only the last update of an item. */
  updatedAt?: string;
  /** The text was cut at maxCharsPerItem. */
  truncated: boolean;
}
export interface T3MessagePage {
  messages: T3ThreadMessage[];
  /** Position of the last item the page covered (pass as afterPosition for the next page); null when the thread has no items. */
  nextPosition: number | null;
  hasMore: boolean;
  /** `thread.archived` as T3 reported it. */
  archived: boolean;
}

/** One turn of a T3 thread (`recentRuns` of t3_thread_read, newest first). */
export interface T3ThreadRun {
  runId?: string;
  status: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string | null;
}
export interface T3ThreadState {
  status: string;
  activeRunId?: string | null;
  runs?: T3ThreadRun[];
  raw: Record<string, unknown>;
}
export interface T3ChildThread {
  threadId: string;
  title?: string;
  status: string;
  createdAt?: string;
}

export class T3Error extends Error {}

/** socket-level failures worth retrying (the request died before T3 answered). */
export const TRANSIENT_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET", "ECONNREFUSED"]);
/** Backoff before retry 1 and 2 (3 attempts in all). */
export const RETRY_DELAYS_MS = [500, 1500];

const causeOf = (e: unknown): { code?: string; message?: string } | undefined => {
  const c = (e as { cause?: unknown } | undefined)?.cause;
  return c && typeof c === "object" ? (c as { code?: string; message?: string }) : undefined;
};

/**
 * T3 itself is down (refused / socket errors outlasted the retries: a restart, a planned stop). Callers that can wait
 * (desk reads, chat sends) show the last good state and queue instead of surfacing the raw error.
 */
export class T3UnavailableError extends T3Error {}

/** a T3UnavailableError, or a bare transient socket error (a fake or a call made without withT3Retry). */
export function isT3Unavailable(e: unknown): boolean {
  return e instanceof T3UnavailableError || isTransient(e);
}

/** files whose presence on the console host means T3 is stopped on purpose (service stop, watchdog paused). */
export const t3MaintenanceMarkers = (): string[] => [".t3/runtime/.service-stopping", `${sites().seatDir}/PAUSE_WATCHDOG`];

/** why T3 is down, as the chat says it: `maintenance` when a marker exists under `home`, else `restarting`. */
export function t3DownReason(home: string = os.homedir()): "maintenance" | "restarting" {
  return t3MaintenanceMarkers().some((m) => fs.existsSync(path.join(home, m))) ? "maintenance" : "restarting";
}

export function isTransient(e: unknown): boolean {
  const code = causeOf(e)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/** `message (cause.code: cause.message)`, so a run summary says more than "fetch failed". */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const c = causeOf(e);
  if (!c || (!c.code && !c.message) || msg.includes(`(${c.code ?? ""}`)) return msg;
  return `${msg} (${[c.code, c.message].filter(Boolean).join(": ")})`;
}

/**
 * Run `attempt` up to 1 + delays.length times while it fails with a transient socket error. The last error is
 * rethrown as a T3Error whose message carries the cause (and `cause` kept), and logged once.
 */
export async function withT3Retry<T>(
  label: string,
  attempt: () => Promise<T>,
  delays: number[] = RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (!isTransient(e)) throw e;
      if (i >= delays.length) {
        const err = new T3UnavailableError(`${label}: ${errorText(e)} after ${i + 1} attempts`, { cause: causeOf(e) });
        console.error(`T3 ${err.message}`);
        throw err;
      }
      console.error(`T3 ${label}: ${errorText(e)}; retry ${i + 1}/${delays.length} in ${delays[i]} ms`);
      await sleep(delays[i]);
    }
  }
}

/**
 * T3 refuses a send while the thread compacts its context (or is otherwise busy). That is not a fault: retry the
 * send later with a longer backoff than sockets (15 s, 30 s, 60 s, 120 s; ~3.5 min in all).
 */
export const BUSY_PATTERNS = [/Wait for context compaction to finish/i, /is still running/i];
export const BUSY_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];
/**
 * Round 2: the console never receives T3's compaction text. The MCP error carries only the wrapper
 * (`OrchestratorMcpFailure … Failed to dispatch orchestration command message.dispatch (command:…)`); the cause is only in
 * T3's own trace. So for an auto send that exact dispatch refusal counts as "possibly busy". Deliberately narrow (the
 * `message.dispatch` command, not any orchestration error): unknown/archived thread, auth etc. fail differently and stay
 * fatal. A wrong guess costs only the retries (a few minutes, then a failed run with the full text).
 */
export const DISPATCH_REFUSED = /Failed to dispatch orchestration command message\.dispatch/i;

/** A send T3 kept refusing (busy, or a dispatch refusal with no cause), after every busy retry. */
export class T3BusyError extends T3Error {
  constructor(message: string, opts?: { kind?: string; state?: string }) {
    super(message);
    this.kind = opts?.kind;
    this.state = opts?.state;
  }
  kind: string | undefined;
  /** What `t3_thread_read` said about the thread while it was refusing (best effort). */
  state: string | undefined;
}

const fullText = (e: unknown): string => {
  const c = causeOf(e);
  return [e instanceof Error ? e.message : String(e), c?.message].filter(Boolean).join(" ");
};

export function isThreadBusy(e: unknown): boolean {
  if (e instanceof T3BusyError) return true;
  const t = fullText(e);
  return BUSY_PATTERNS.some((r) => r.test(t)) || DISPATCH_REFUSED.test(t);
}

/** "compacting" / "busy" when T3 said so, else "refused, cause unknown" (the wrapper-only dispatch refusal). */
export function busyKind(e: unknown): string {
  if (e instanceof T3BusyError && e.kind) return e.kind;
  const t = fullText(e);
  if (/compaction/i.test(t)) return "compacting";
  if (BUSY_PATTERNS.some((r) => r.test(t))) return "busy";
  return "refused, cause unknown";
}

/**
 * Retry `attempt` while T3 refuses as busy; after the last delay throw a T3BusyError carrying T3's text. `attempt(i)` gets
 * the busy-attempt index (0 first). `readState` (best effort, never throws) reports what T3 says the thread is doing, for
 * the log and the final error.
 */
export async function withBusyRetry<T>(
  label: string,
  attempt: (i: number) => Promise<T>,
  delays: number[] = BUSY_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  readState?: () => Promise<string | undefined>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt(i);
    } catch (e) {
      if (!isThreadBusy(e)) throw e;
      let state: string | undefined;
      try {
        state = await readState?.();
      } catch {
        /* best effort */
      }
      const st = state ? ` (T3 thread state: ${state})` : "";
      if (i >= delays.length) {
        const kind = /compact/i.test(state ?? "") ? "compacting" : busyKind(e);
        const err = new T3BusyError(`${label}: thread ${kind} after ${i + 1} attempts${st}: ${errorText(e)}`, { kind, state });
        console.error(`T3 ${err.message}`);
        throw err;
      }
      console.error(`T3 ${label}: thread ${busyKind(e)}${st}; retry ${i + 1}/${delays.length} in ${delays[i]} ms`);
      await sleep(delays[i]);
    }
  }
}

/**
 * what a run summary says when a send failed. T3's MCP error often carries only the wrapper ("Failed to dispatch
 * orchestration command …"); then say what the console knows and where the real cause is. A `[cause]` T3 gave is kept as is.
 */
export function sendFailureText(e: unknown, threadId: string | undefined, host: string): string {
  const text = errorText(e);
  if (!/Failed to dispatch orchestration command/i.test(text) || /\[cause\]/.test(text)) return text;
  return `${text} (thread ${threadId ?? "?"} on ${host}; T3 gave no cause; see T3 trace on ${host})`;
}

type Json = Record<string, any>;

export function defaultTokenFile(): string {
  return process.env.T3_TOKEN_FILE || path.join(seatDir(), ".t3token");
}

/** Pull a scheduled-task record out of whatever envelope a tool returns. */
export function toTask(raw: Json | undefined): T3ScheduledTask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t: Json = raw.task ?? raw.scheduledTask ?? raw;
  const id = t.scheduledTaskId ?? t.id ?? t.taskId;
  if (typeof id !== "string") return undefined;
  return {
    id,
    title: t.title ?? undefined,
    enabled: typeof t.enabled === "boolean" ? t.enabled : undefined,
    nextRunAt: t.nextRunAt ?? undefined,
    boundThreadId: t.boundThreadId ?? t.threadId ?? t.bindThreadId ?? undefined,
    raw: t,
  };
}

/** MCP-over-HTTP client (JSON-RPC, one short session per call, like mcpcall.py). */
export class McpT3Client implements T3Client {
  constructor(
    /** A fixed URL, or a resolver called per request (default: T3_MCP_URL → server-runtime.json →:3773). */
    private readonly url: string | (() => string) = t3UrlResolver(),
    private readonly tokenFile = defaultTokenFile(),
    /** backoff between attempts on a transient socket error (tests pass [0, 0]). */
    private readonly retryDelaysMs: number[] = RETRY_DELAYS_MS,
    /** backoff between sends T3 refused because the thread was busy (tests pass zeros). */
    private readonly busyDelaysMs: number[] = BUSY_RETRY_DELAYS_MS,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    // Read per call so a rotated token (mcp_login.py, every <30 days) is picked up without a restart.
    const token = fs.readFileSync(this.tokenFile, "utf8").trim();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...extra,
    };
  }

  private async post(obj: Json, extra?: Record<string, string>): Promise<{ sid?: string; body?: Json }> {
    const res = await fetch(typeof this.url === "function" ? this.url() : this.url, {
      method: "POST",
      headers: this.headers(extra),
      body: JSON.stringify(obj),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new T3Error(`T3 MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    let payload = text;
    for (const line of text.split("\n")) if (line.startsWith("data:")) payload = line.slice(5).trim();
    return { sid: res.headers.get("mcp-session-id") ?? undefined, body: payload.trim() ? JSON.parse(payload) : undefined };
  }

  /** One fresh session per attempt; transient socket errors retry the whole handshake + call. */
  async call(tool: string, args: Json): Promise<Json> {
    return withT3Retry(`tools/call ${tool}`, () => this.callOnce(tool, args), this.retryDelaysMs);
  }

  private async callOnce(tool: string, args: Json): Promise<Json> {
    const { sid } = await this.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-team-console", version: "0" } },
    });
    const ex = sid ? { "mcp-session-id": sid } : undefined;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, ex);
    const { body } = await this.post(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
      ex,
    );
    if (body?.error) throw new T3Error(`${tool}: ${JSON.stringify(body.error).slice(0, 300)}`);
    const res = body?.result ?? {};
    const text: string | undefined = res.content?.find?.((c: Json) => c.type === "text")?.text;
    if (res.isError) throw new T3Error(`${tool}: ${(text ?? JSON.stringify(res)).slice(0, 400)}`);
    if (res.structuredContent) return res.structuredContent;
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { text };
    }
  }

  async listProjects() {
    const out: T3Project[] = [];
    for (let cursor: number | undefined = 0; cursor !== undefined; ) {
      const r = await this.call("t3_project_list", { cursor, limit: 100 });
      out.push(...((r.projects ?? []) as T3Project[]));
      cursor = typeof r.nextCursor === "number" ? r.nextCursor : undefined;
    }
    return out;
  }
  async createProject(input: { title: string; workspaceRoot: string }) {
    await this.call("t3_project_create", { title: input.title, workspaceRoot: input.workspaceRoot });
  }
  async cloneProject(input: { repository: string; destinationPath: string }) {
    // T3 resolves an owner/name only with a provider ("Enter a repository path or clone URL" without one), and its
    // "auto" protocol picks ssh, which hosts without a GitHub host key refuse: GitHub over https, like the checkouts.
    const r = await this.call("t3_project_clone", { repository: input.repository, destinationPath: input.destinationPath, provider: "github", protocol: "https" });
    return { cwd: typeof r.cwd === "string" ? r.cwd : input.destinationPath };
  }
  async listScheduledTasks(projectId: string) {
    const r = await this.call("list_scheduled_tasks", { projectId });
    return ((r.tasks ?? []) as Json[]).map(toTask).filter((t): t is T3ScheduledTask => !!t);
  }
  async updateScheduledTask(id: string, patch: Json) {
    return toTask(await this.call("update_scheduled_task", { scheduledTaskId: id, ...patch }));
  }
  async deleteScheduledTask(id: string) {
    await this.call("delete_scheduled_task", { scheduledTaskId: id });
  }
  async runScheduledTaskNow(id: string) {
    await this.call("run_scheduled_task_now", { taskId: id });
  }
  async launchThread(input: { projectId: string; title: string; message?: string; modelSelection?: T3ModelSelection }) {
    const r = await this.call("t3_thread_launch", {
      projectId: input.projectId,
      title: input.title,
      runtimeMode: "full-access",
      workspaceStrategy: { type: "root" },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.message ? { message: input.message } : {}),
    });
    const threadId = r.threadId ?? r.thread?.id ?? r.id;
    if (typeof threadId !== "string") throw new T3Error(`t3_thread_launch: no threadId in ${JSON.stringify(r).slice(0, 300)}`);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode: T3SendMode = "auto") {
    // One id across the socket retries of an attempt (call re-sends the same args), so T3 drops a duplicate if a reset hid a
    // delivered request. A busy retry gets a FRESH id: the refused attempt was not delivered, and T3's dispatch receipt may
    // replay the cached refusal for the same command id.
    const base = clientRequestId ?? `console-send-${randomUUID()}`;
    // only auto sends wait out a busy thread; a refused steer fails fast (the caller falls back to auto, which waits).
    await withBusyRetry(
      `t3_thread_send ${threadId}`,
      (i) => this.call("t3_thread_send", { threadId, message, mode, clientRequestId: i === 0 ? base : `${base}-busy${i}` }),
      mode === "auto" ? this.busyDelaysMs : [],
      undefined,
      async () => {
        const s = await this.readThreadStatus(threadId);
        return s.activeRunId ? `${s.status}, active run ${s.activeRunId}` : s.status;
      },
    );
  }
  async readThreadStatus(threadId: string) {
    // several recent turns, so the reconciler sees a worker's later turn, not only the first.
    const r = await this.call("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 200, runLimit: 10 });
    const th: Json = r.thread ?? r;
    const status = th.runStatus ?? th.status ?? th.latestRun?.status ?? "unknown";
    const runs: T3ThreadRun[] | undefined = Array.isArray(r.recentRuns)
      ? r.recentRuns.map((x: Json) => ({ ...(typeof x.runId === "string" ? { runId: x.runId } : {}), status: String(x.status), requestedAt: x.requestedAt, startedAt: x.startedAt, completedAt: x.completedAt }))
      : undefined;
    return { status: String(status), activeRunId: th.activeRunId ?? null, runs, raw: th };
  }
  async readLastError(threadId: string) {
    // the newest 20 items (a page starts at the oldest; a long home thread's latest error was never read)
    const head = await this.call("t3_thread_read", { threadId, view: "activity", limit: 1, maxCharsPerItem: 1, runLimit: 1 });
    const count = Number((head.thread ?? head).itemCount);
    const r = await this.call("t3_thread_read", {
      threadId,
      view: "activity",
      limit: 20,
      maxCharsPerItem: 400,
      ...(Number.isFinite(count) && count > 20 ? { afterPosition: count - 21 } : {}),
    });
    return lastErrorOf((r.items ?? []) as Json[]);
  }
  async readEnvironmentId() {
    const r = await this.call("t3_environment_read", {});
    if (typeof r.environmentId !== "string" || !r.environmentId) throw new T3Error(`t3_environment_read: no environmentId in ${JSON.stringify(r).slice(0, 200)}`);
    return r.environmentId;
  }
  async interruptThread(threadId: string, reason?: string, clientRequestId?: string) {
    // The same id across the socket retries of this call, so T3 drops a duplicate if a reset hid a delivered request.
    await this.call("t3_thread_interrupt", {
      threadId,
      ...(reason ? { reason: reason.slice(0, 2000) } : {}),
      clientRequestId: clientRequestId ?? `console-stop-${randomUUID()}`,
    });
  }

  async settleThread(threadId: string) {
    await this.call("t3_thread_organize", { threadId, action: "settle" });
  }

  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number; maxCharsPerItem?: number } = {}): Promise<T3MessagePage> {
    const r = await this.call("t3_thread_read", {
      threadId,
      view: "messages",
      limit: opts.limit ?? 100,
      maxCharsPerItem: opts.maxCharsPerItem ?? 50_000,
      ...(opts.afterPosition !== undefined ? { afterPosition: opts.afterPosition } : {}),
    });
    const messages = ((r.items ?? []) as Json[])
      .filter((i) => (i.type === "user_message" || i.type === "assistant_message") && typeof i.text === "string")
      .map((i) => ({
        itemId: String(i.itemId),
        position: Number(i.position),
        role: (i.type === "user_message" ? "user" : "assistant") as "user" | "assistant",
        text: String(i.text),
        status: String(i.status ?? "completed"),
        updatedAt: typeof i.updatedAt === "string" ? i.updatedAt : undefined,
        truncated: i.textTruncated === true,
      }));
    return {
      messages,
      nextPosition: typeof r.nextPosition === "number" ? r.nextPosition : null,
      hasMore: r.hasMore === true,
      archived: (r.thread as Json | undefined)?.archived === true,
    };
  }
  async queuedCount(threadId: string) {
    const r = await this.call("t3_queue_list", { threadId, limit: 100 });
    const held = new Set(["stopped", "paused", "held", "cancelled", "failed", "delivered"]);
    return ((r.items ?? []) as Json[]).filter((i) => !held.has(String(i.status ?? i.state ?? "").toLowerCase())).length;
  }
  async listChildThreads(projectId: string, parentThreadId: string) {
    const r = await this.call("t3_thread_list", { projectId, includeSubagents: true, limit: 100 });
    return ((r.threads ?? []) as Json[])
      .filter((t) => t.parentThreadId === parentThreadId)
      .map((t) => ({ threadId: String(t.threadId), title: t.title, status: String(t.status), createdAt: t.createdAt }));
  }
}

/** Find the registered T3 project for a milestone repo (local path, `owner/name`, or bare name). */
export function matchProject(projects: T3Project[], repo: string): T3Project | undefined {
  // a renamed repo's T3 project may carry either name (its remote changes, its folder keeps the old one).
  for (const name of repoAliases(repo)) {
    const hit = matchProjectName(projects, name);
    if (hit) return hit;
  }
  return undefined;
}

function matchProjectName(projects: T3Project[], repo: string): T3Project | undefined {
  const r = repo.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const lower = r.toLowerCase();
  const expanded = r.startsWith("~/") ? path.join(os.homedir(), r.slice(2)) : r;
  return (
    projects.find((p) => p.workspaceRoot === expanded) ??
    projects.find((p) => p.repositoryIdentity?.displayName?.toLowerCase() === lower) ??
    projects.find((p) => p.repositoryIdentity?.canonicalKey?.toLowerCase().endsWith("/" + lower)) ??
    projects.find((p) => !lower.includes("/") && path.basename(p.workspaceRoot).toLowerCase() === lower)
  );
}

/**
 * the newest error item of an activity page (`<title>: <text>`), with the usage-limit reset when T3 noted one
 * after it ("… until the 5-hour limit resets in 1h 5m" → ` (limited until 2026-11-01T19:50:16Z)`): the broker sets
 * maxed_until from that ISO time, else +1 h.
 */
export function lastErrorOf(items: Json[]): string | undefined {
  const errs = items.filter((i) => i.type === "error" && typeof i.text === "string");
  const e = errs[errs.length - 1];
  if (!e) return undefined;
  const text = `${e.title ? `${e.title}: ` : ""}${e.text}`.trim();
  const notice = items.filter((i) => i.type === "system_notice" && typeof i.text === "string" && /resets in/i.test(i.text) && i.runId === e.runId).pop();
  const m = notice && /resets in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(notice.text);
  const at = notice ? Date.parse(notice.updatedAt ?? "") : NaN;
  if (!m || (!m[1] && !m[2]) || !Number.isFinite(at)) return text;
  const until = new Date(at + ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000)).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${text} (limited until ${until})`;
}
