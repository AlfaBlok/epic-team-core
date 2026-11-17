import type { ReviewItem } from "./review-types";
import type { ApiClient } from "./client";
import type { ChatRead, EgressStatus, Me } from "./types";
import { landed, UNDO_MS } from "@/lib/press";
import { workerHost } from "../lib/identity";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's error code (e.g. `exists` for a key that needs Replace). */
    public code?: string,
    /** a social write the pack refused (422): every issue line. */
    public issues?: string[],
    /** a 502/503/504 that did not come from the console itself (a proxy answering while the console restarts). */
    public transient?: boolean,
  ) {
    super(message);
  }
}

/** a call the console has not answered in this long fails (a hung server must not leave a page on "Loading…"). */
export const CALL_TIMEOUT_MS = 30_000;
/** Asset uploads (multipart) may take longer on a slow link. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
export const TIMEOUT_MESSAGE = "The console did not answer in 30 s. Try again.";

const timedOut = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** an ask's action path: its own inbox route, or through the monitor alert that shows it (another world's ask). */
const askPath = (itemId: string, relay?: { milestoneId: string; code: string }) =>
  relay ? `/milestones/${encodeURIComponent(relay.milestoneId)}/alert-asks/${encodeURIComponent(relay.code)}` : `/waiting-on-owner/${encodeURIComponent(itemId)}`;

let meInFlight: Promise<Me> | undefined;

/** `?limit=&before=` of a chat read (empty when unset). */
const chatQs = (r?: ChatRead) =>
  qs({ ...(r?.limit ? { limit: String(r.limit) } : {}), ...(r?.before !== undefined ? { before: String(r.before) } : {}) });

/** `?a=1&b=2` (empty when no params). */
const qs = (p: Record<string, string>) => {
  const q = new URLSearchParams(p).toString();
  return q ? `?${q}` : "";
};

/** one console API call (the hosted pages' own clients use it too, web/src/hosted/api). */
export async function apiCall<T>(method: string, path: string, body?: unknown, o: { idempotent?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  return call<T>(method, path, body, o);
}

/**
 * one request for the same GET while it is on its way. The Inbox's two sections and the page around them asked
 * for the same list at the same moment (on a throttled phone: two 1.8 MB downloads sharing one slow link, every 30 s).
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * a list index.html started downloading before the app's code arrived (window.__earlyGets), taken once and
 * only while fresh; a failed one (null) is asked again the normal way.
 */
export const EARLY_FRESH_MS = 15_000;
export function takeEarly(path: string): Promise<unknown> | undefined {
  const all = typeof window === "undefined" ? undefined : (window as { __earlyGets?: Record<string, { at: number; p: Promise<unknown> }> }).__earlyGets;
  const e = all?.[path];
  if (!e) return undefined;
  delete all![path];
  return Date.now() - e.at < EARLY_FRESH_MS ? e.p : undefined;
}

function call<T>(method: string, path: string, body?: unknown, o: { idempotent?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  if (method !== "GET" || o.headers) return callOnce<T>(method, path, body, o);
  const found = inFlight.get(path);
  if (found) return found as Promise<T>;
  const early = takeEarly(path);
  const p = (early ? early.then((d) => (d == null ? callOnce<T>(method, path, body, o) : (d as T))) : callOnce<T>(method, path, body, o)).finally(() => inFlight.delete(path));
  inFlight.set(path, p);
  return p;
}

async function callOnce<T>(method: string, path: string, body?: unknown, o: { idempotent?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  if (method !== "GET" && !o.idempotent) return attempt<T>(method, path, body, o.headers);
  // a GET that meets a restarting console (proxy 502/503/504, connection refused) waits and tries again with
  // backoff for ~60 s; the page keeps its last good data and the layout shows one quiet "reconnecting" line meanwhile.
  // Only after the budget is spent does the error reach the page. Writes are never retried (they may have landed), except
  // an idempotent one (an answer carries its clientKey: the console returns the stored answer to a repeat), which
  // is also retried after our own 30 s timeout.
  let reconnectingOn = false;
  try {
    for (let i = 0; ; i++) {
      try {
        return await attempt<T>(method, path, body, o.headers);
      } catch (e) {
        const retry = isTransient(e) || (!!o.idempotent && e instanceof ApiError && e.code === "timeout");
        if (!retry || i >= RETRY_DELAYS_MS.length) throw e;
        if (!reconnectingOn) (reconnectingOn = true), setReconnecting(+1);
        await sleep(retryDelay(i));
      }
    }
  } finally {
    if (reconnectingOn) setReconnecting(-1);
  }
}

/**
 * a button press the console may save first and land later (202 "landing"): resolves once it has landed.
 * the console answers a press once it is saved (well under 1 s) and writes it in the background. The press
 * carries an Idempotency-Key, so a restart's proxy 502 or a dropped connection is sent again (same key: the console
 * returns the press it saved, never a second write).
 */
async function press<T>(method: string, path: string, body?: unknown, o: { undo?: boolean } = {}): Promise<T> {
  // a card press that closes it waits out the floating note's Bring it back window on the console
  const first = await call<unknown>(method, path, body, { idempotent: true, headers: { "idempotency-key": newClientKey(), ...(o.undo ? { "x-undo-ms": String(UNDO_MS) } : {}) } });
  return landed<T>(first, path, (id) => call("GET", `/presses/${encodeURIComponent(id)}`), (msg) => new ApiError(502, msg, "press_failed"));
}

async function attempt<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  // a FormData body (asset upload) goes as multipart; the browser sets its content type.
  // a Blob body (a chat attachment) goes as its raw bytes; the caller sets its content type.
  const form = (typeof FormData !== "undefined" && body instanceof FormData) || (typeof Blob !== "undefined" && body instanceof Blob);
  const signal = AbortSignal.timeout(form ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS);
  try {
    return await send<T>(method, path, body, form, signal, headers);
  } catch (e) {
    // Same shape as a failed answer (ApiError), with a plain message; the page shows it with its retry.
    if (signal.aborted && timedOut(e)) throw new ApiError(504, form ? "The console did not answer in 5 min. Try again." : TIMEOUT_MESSAGE, "timeout");
    throw e;
  }
}

/** backoff between GET retries while the console restarts (sum ~61 s). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 6000];
/**
 * each wait is spread ±30% at random, so the GETs of every open tab do not hit the console in the same second
 * after its restart (one wave every few seconds of ~200 cold reads). `retryRandom.next` returning 0.5 = the plain delay.
 */
export const retryRandom = { next: Math.random };
const retryDelay = (i: number) => Math.round(RETRY_DELAYS_MS[i] * (0.7 + 0.6 * retryRandom.next()));
const TRANSIENT_STATUS = new Set([502, 503, 504]);

/** A proxy's 502/503/504 (no console error body) or a network failure (fetch rejects with TypeError). Our own 30 s timeout is not retried. */
export const isTransient = (e: unknown) => (e instanceof ApiError ? !!e.transient : e instanceof TypeError);

/** an idempotency key (crypto.randomUUID needs a secure context; the tailnet URL is plain http). */
export const newClientKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** how many GETs are waiting out a restart; the layout shows a quiet line while > 0. */
let reconnectingCount = 0;
const reconnectingListeners = new Set<(on: boolean) => void>();
function setReconnecting(delta: number) {
  const was = reconnectingCount > 0;
  reconnectingCount = Math.max(0, reconnectingCount + delta);
  const on = reconnectingCount > 0;
  if (on !== was) reconnectingListeners.forEach((l) => l(on));
}
export const isReconnecting = () => reconnectingCount > 0;
export function onReconnecting(l: (on: boolean) => void): () => void {
  reconnectingListeners.add(l);
  return () => reconnectingListeners.delete(l);
}
export const RECONNECTING_MESSAGE = "Console restarting, reconnecting…";

async function send<T>(method: string, path: string, body: unknown, form: boolean, signal: AbortSignal, extra?: Record<string, string>): Promise<T> {
  const base = body === undefined || form ? undefined : { "content-type": "application/json" };
  const res = await fetch(`/api${path}`, {
    method,
    headers: extra ? { ...base, ...extra } : base,
    body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `${method} /api${path} → ${res.status}`;
    let code: string | undefined;
    let issues: string[] | undefined;
    let fromConsole = false;
    try {
      const j = await res.json();
      fromConsole = !!j?.error;
      if (j?.error) msg = typeof j.error === "string" ? j.error : String(j.error.message ?? j.error.code ?? msg);
      if (typeof j?.error?.code === "string") code = j.error.code;
      if (Array.isArray(j?.error?.issues)) issues = j.error.issues.map(String);
    } catch {
      /* not json */
    }
    // with CONSOLE_AUTH=on a lapsed session answers 401 login_required: back to the login page, then here again.
    if (res.status === 401 && code === "login_required" && typeof window !== "undefined" && window.location.pathname !== "/login")
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError(res.status, msg, code, issues, TRANSIENT_STATUS.has(res.status) && !fromConsole);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * a raw upload that reports how many bytes have left (fetch cannot). On his phone a 402 KB photo took 54 s
 * to leave over a slow link while the console wrote it in milliseconds: the bubble shows the percent instead of a bare spinner.
 * Same errors as send(): the console's message, a 401 back to login, the 5 min limit.
 */
export function uploadWithProgress<T>(path: string, body: Blob, headers: Record<string, string>, onProgress: (sent: number, total: number) => void): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api${path}`);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.timeout = UPLOAD_TIMEOUT_MS;
    x.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : body.size);
    x.onload = () => {
      let j: any;
      try {
        j = x.responseText ? JSON.parse(x.responseText) : undefined;
      } catch {
        /* not json */
      }
      if (x.status >= 200 && x.status < 300) return ok(j as T);
      const code = typeof j?.error?.code === "string" ? j.error.code : undefined;
      const msg = j?.error ? (typeof j.error === "string" ? j.error : String(j.error.message ?? j.error.code)) : `POST /api${path} → ${x.status}`;
      if (x.status === 401 && code === "login_required" && typeof window !== "undefined" && window.location.pathname !== "/login")
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      fail(new ApiError(x.status, msg, code, undefined, TRANSIENT_STATUS.has(x.status) && !j?.error));
    };
    x.onerror = () => fail(new TypeError("the upload did not reach the console (network)"));
    x.ontimeout = () => fail(new ApiError(504, "The console did not answer in 5 min. Try again.", "timeout"));
    x.send(body);
  });
}

/** POST /messages answers 502 with the stored (failed) message when delivery fails: return it, the UI shows why. */
async function sendMessage(input: unknown, url = "/api/messages") {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const j = await res.json().catch(() => undefined);
  if (res.status === 201 || (res.status === 502 && j?.delivery)) return j;
  throw new ApiError(res.status, j?.error?.message ?? `POST ${url} → ${res.status}`);
}

const query = (f: object) => new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1])).toString();

/** Fetch-based client against the console server (`/api`). */
export function createRealClient(): ApiClient {
  return {
    listMilestones: (opts) => call("GET", `/milestones${opts?.includeSettled ? "?includeSettled=true" : ""}`),
    settleMilestone: (id) => call("POST", `/milestones/${id}/settle`),
    unsettleMilestone: (id) => call("POST", `/milestones/${id}/unsettle`),
    getMilestone: (id) => call("GET", `/milestones/${id}`),
    createMilestone: (input) => call("POST", "/milestones", input),
    updateMilestone: (id, patch) => call("PATCH", `/milestones/${id}`, patch),
    deleteMilestone: (id) => call("DELETE", `/milestones/${id}`),
    bootstrapMilestone: (input) => call("POST", "/milestones/bootstrap", input),

    listPersonas: () => call("GET", "/personas"),
    listPersonaTemplates: () => call("GET", "/persona-templates"),
    createPersona: (input) => call("POST", "/personas", input),
    updatePersona: (id, patch) => call("PATCH", `/personas/${id}`, patch),
    deletePersona: (id) => call("DELETE", `/personas/${id}`),

    listAssignments: () => call("GET", "/assignments"),
    createAssignment: (input) => call("POST", "/assignments", input),
    updateAssignment: (id, patch) => call("PATCH", `/assignments/${id}`, patch),
    deleteAssignment: (id) => call("DELETE", `/assignments/${id}`),
    runAssignmentNow: (id, note, clientRequestId) =>
      call("POST", `/assignments/${id}/run-now`, { ...(note?.trim() ? { note: note.trim() } : {}), ...(clientRequestId ? { clientRequestId } : {}) }),
    steerAssignment: (id, message, clientRequestId) => call("POST", `/assignments/${id}/steer`, { message, clientRequestId }),
    listTicketSessions: (milestoneId) => call("GET", `/tickets/sessions?milestoneId=${encodeURIComponent(milestoneId)}`),
    getDeskChat: (read) => call("GET", `/desk/messages${chatQs(read)}`),
    sendDeskMessage: (text, page, clientRequestId, attachments) => call("POST", "/desk/messages", { text, page, clientRequestId, ...(attachments?.length ? { attachments } : {}) }),
    uploadChatAttachment: (file, name, onProgress) => {
      const headers = { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(name) };
      return onProgress && typeof XMLHttpRequest !== "undefined" ? uploadWithProgress("/chat/attachments", file, headers, onProgress) : call("POST", "/chat/attachments", file, { headers });
    },
    attachmentLine: (ids) => call("POST", "/chat/attachments/line", { ids }),
    readSpokenAnswers: (words, asks) => call("POST", "/spoken-answers", { words, asks }),
    getMilestoneChat: (id, read) => call("GET", `/milestones/${encodeURIComponent(id)}/chat/messages${chatQs(read)}`),
    getWorldDeskChat: (t, read) => call("GET", `/tenants/${encodeURIComponent(t)}/desk/messages${chatQs(read)}`),
    getFirstObjective: (t) => call("GET", `/tenants/${encodeURIComponent(t)}/first-objective`),
    newWorkspace: (t, name) => call("POST", `/tenants/${encodeURIComponent(t)}/workspaces`, { name }),
    getWorldRepo: (t) => call("GET", `/tenants/${encodeURIComponent(t)}/repo`),
    connectWorldRepo: (t, repo, code) => call("POST", `/tenants/${encodeURIComponent(t)}/repo/connect`, { repo, code }),
    sendWorldDeskMessage: (t, text, page, clientRequestId, attachments) =>
      call("POST", `/tenants/${encodeURIComponent(t)}/desk/messages`, { text, page, clientRequestId, ...(attachments?.length ? { attachments } : {}) }),
    sendMilestoneChatMessage: (id, text, page, clientRequestId, attachments) =>
      call("POST", `/milestones/${encodeURIComponent(id)}/chat/messages`, { text, page, clientRequestId, ...(attachments?.length ? { attachments } : {}) }),

    steerRun: (id, message, clientRequestId) => call("POST", `/runs/${id}/steer`, { message, clientRequestId }),
    stopRun: (id, input) => call("POST", `/runs/${id}/stop`, input),
    getPriorityMode: () => call("GET", "/priority-mode"),
    startPriorityMode: (input) => call("POST", "/priority-mode", input),
    resumePriorityMode: (why) => call("POST", "/priority-mode/resume", why ? { why } : {}),
    addToTree: (mid, input) => call("POST", `/milestones/${mid}/tree/add`, input),
    listAskedNoRow: (limit) => call("GET", `/asked-no-row${limit ? qs({ limit: String(limit) }) : ""}`),
    listOrphanCommits: (limit) => call("GET", `/orphan-commits${limit ? qs({ limit: String(limit) }) : ""}`),
    getLaunchBoard: (product) => call("GET", `/launch-board${product ? qs({ product }) : ""}`),
    listCompanies: () => call("GET", "/companies"),
    addCompany: (input) => call("POST", "/companies", input),
    setCompany: (id, input) => call("PUT", `/companies/${encodeURIComponent(id)}`, input),
    listCompanyWorlds: () => call("GET", "/worlds"),
    listExperiments: () => call("GET", "/experiments"),
    listGoals: () => call("GET", "/goals"),
    getCompanyOps: (id) => call("GET", `/companies/${encodeURIComponent(id)}/ops`),
    getCompanyBuild: (id) => call("GET", `/companies/${encodeURIComponent(id)}/build`),
    listWheelNotes: () => call("GET", "/companies/notes"),
    dropWheelNote: (company, wheel, input) => call("POST", `/companies/${encodeURIComponent(company)}/wheels/${wheel}/notes`, input),
    markWheelNoteHandled: (id) => call("POST", `/companies/notes/${encodeURIComponent(id)}/handled`, {}),
    getCompanyPromo: (id) => call("GET", `/companies/${encodeURIComponent(id)}/promo`),
    listBuilding: () => call("GET", "/building"),
    listPursuits: () => call("GET", "/pursuits"),
    listScorecards: () => call("GET", "/scorecards"),
    personaGaps: () => call("GET", "/persona-gaps"),
    reorderPursuits: (ids) => call("POST", "/pursuits/order", { ids }),
    parkPursuit: (id, parked) => call("POST", `/pursuits/${encodeURIComponent(id)}/park`, { parked }),
    listOneOffs: () => call("GET", "/one-offs"),
    listOutcomes: (f) => {
      const q = new URLSearchParams(Object.entries(f ?? {}).filter((e): e is [string, string] => !!e[1])).toString();
      return call("GET", `/outcomes${q ? `?${q}` : ""}`);
    },
    listTeamCards: (q = {}) => {
      const p = new URLSearchParams();
      if (q.scorecard) p.set("scorecard", q.scorecard);
      if (q.kind) p.set("kind", q.kind);
      const s = p.toString();
      return call("GET", `/inbox/team-cards${s ? `?${s}` : ""}`);
    },
    answerTeamCard: (id, a) => call("POST", `/inbox/team-cards/${encodeURIComponent(id)}/answer`, a),
    advisorVerdict: (id, v) => call("POST", `/inbox/team-cards/${encodeURIComponent(id)}/advisor`, v),
    listPages: () => call("GET", "/pages"),
    listPinnedPages: () => call("GET", "/pages/pinned"),
    pinnedPageStatus: (port) => call("GET", `/pages/pinned/${port}/status`),
    refreshPinnedPage: (port) => call("POST", `/pages/pinned/${port}/refresh`),
    pinPage: (b) => call("POST", "/pages/pin", b),
    askLogSummary: () => call("GET", "/asks/log?summary=1"),
    askVerdict: (id, verdict) => call("POST", `/asks/${encodeURIComponent(id)}/verdict`, { verdict }),
    listVoiceNotes: (product) => call("GET", `/voice-notes${product && product !== "all" ? qs({ product }) : ""}`),
    getXStats: (date) => call("GET", `/x-stats${date ? qs({ date }) : ""}`),
    getPursuitKit: (id) => call("GET", `/pursuits/${encodeURIComponent(id)}/kit`),
    listProducts: () => call("GET", "/products"),
    getProduct: (id) => call("GET", `/products/${encodeURIComponent(id)}`),
    getProductKit: (id) => call("GET", `/products/${encodeURIComponent(id)}/kit`),

    listRuns: (q) => call("GET", `/runs${qs({ ...(q?.since ? { since: q.since } : {}), ...(q?.milestoneId ? { milestoneId: q.milestoneId } : {}) })}`),
    getRunStats: (milestones) => call("GET", `/runs/stats${milestones ? qs({ milestones: milestones.join(",") }) : ""}`),
    getActiveAgents: ({ day, tz, bucket }) => call("GET", `/runs/active${qs({ tz, ...(day ? { day } : {}), ...(bucket ? { bucket: String(bucket) } : {}) })}`),
    getRunHosts: ({ range }) => call("GET", `/runs/hosts${qs({ range })}`),
    getCounts: () => call("GET", "/counts"),
    markChatSeen: (target) => call("POST", "/chat/seen", target),
    getPush: () => call("GET", "/push"),
    subscribePush: (subscription, device) => call("POST", "/push/subscribe", { subscription, ...(device ? { device } : {}) }),
    unsubscribePush: (endpoint) => call("POST", "/push/unsubscribe", { endpoint }),
    testPush: (endpoint) => call("POST", "/push/test", endpoint ? { endpoint } : {}),
    listRunsTop: ({ top, milestoneId }) => call("GET", `/runs${qs({ top: top ? String(top) : "all", ...(milestoneId ? { milestoneId } : {}) })}`),
    getUsage: ({ from, to, groupBy }) =>
      call("GET", `/usage?${new URLSearchParams({ groupBy, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
    getUnblockerStats: ({ window, milestoneId }) =>
      call("GET", `/unblocker-stats?${new URLSearchParams({ window, ...(milestoneId ? { milestoneId } : {}) })}`),
    getCycle: () => call("GET", "/cycle"),
    createRun: (input) => call("POST", "/runs", input),

    listNeedsOwner: () => call("GET", "/needs-owner"),
    updateNeedsOwner: (id, status) => call("PATCH", `/needs-owner/${id}`, { status }),

    supersedeNeedsOwner: (id, by) => call("POST", `/needs-owner/${id}/supersede`, by ? { by } : {}),

    listWaitingOnOwner: (f = {}) => {
      const { includeSettled, includeSuperseded, ...rest } = f;
      // the screen's view: done and superseded items as one-line rows (their card loads when opened).
      const q = query({ ...rest, ...(includeSettled ? { includeSettled: "true" } : {}), ...(includeSuperseded ? { includeSuperseded: "true" } : {}), view: "list" });
      return call("GET", `/waiting-on-owner${q ? `?${q}` : ""}`);
    },
    searchInbox: (q) => callOnce("GET", `/inbox/search?${query({ q })}`),
    getWaitingItem: (id, milestoneId) => call("GET", `/waiting-on-owner/${encodeURIComponent(id)}${milestoneId ? `?${query({ milestoneId })}` : ""}`),
    // one key per answer: a request the network or a restart dropped is sent again with it (stored once).
    respondToWaiting: (itemId, { relay, ...input }) =>
      call("POST", `${askPath(itemId, relay)}/respond`, { ...input, clientKey: input.clientKey ?? newClientKey() }, { idempotent: true, headers: { "x-undo-ms": String(UNDO_MS) } }),
    saveKey: (itemId, { relay, ...input }) => call("POST", `${askPath(itemId, relay)}/secret`, input),
    snoozeWaiting: (itemId, { relay, ...input }) => press("POST", `${askPath(itemId, relay)}/snooze`, input),
    redeliverResponse: (id) => call("POST", `/owner-responses/${encodeURIComponent(id)}/deliver`, undefined, { idempotent: true }), // a repeat joins the running job
    changeResponse: (id, input) => call("POST", `/owner-responses/${encodeURIComponent(id)}/change`, input),
    sendMessage: (input) => sendMessage(input),
    requestAsks: (input) => sendMessage(input, "/api/waiting-on-owner/request-asks"),
    listOwnerActivity: (milestoneId) => call("GET", `/owner-activity${milestoneId ? `?milestoneId=${encodeURIComponent(milestoneId)}` : ""}`),

    getBacklog: (id) => call("GET", `/milestones/${id}/backlog`),
    getTree: (id) => call("GET", `/milestones/${id}/tree`),
    getMilestoneStatus: (id) => call("GET", `/milestones/${id}/status`),
    markMilestone: (id, input) => call("POST", `/milestones/${id}/mark`, input),
    stampMilestone: (id, input) => call("POST", `/milestones/${id}/stamp`, input),
    nextWake: (id) => call("GET", `/next-wake${id ? `?milestoneId=${encodeURIComponent(id)}` : ""}`),
    listStatus: () => call("GET", "/status"),
    movingNow: (limit) => call("GET", `/moving-now${limit ? qs({ limit: String(limit) }) : ""}`),
    getRunCommits: (id) => call("GET", `/milestones/${id}/run-commits`),
    getFreshness: (id) => call("GET", `/milestones/${id}/freshness`),
    // 429 (refreshed < 5 s ago) still carries the current freshness: return it, the button says so.
    async refreshMilestone(id) {
      const res = await fetch(`/api/milestones/${id}/refresh`, { method: "POST" });
      if (res.status === 429) return res.json();
      if (!res.ok) return call("POST", `/milestones/${id}/refresh`);
      return res.json();
    },
    getFreshnessSummary: () => call("GET", "/freshness"),
    getNodeTree: (id, nodeKey) => call("GET", `/milestones/${id}/tree${nodeKey ? `?nodeKey=${encodeURIComponent(nodeKey)}` : ""}`),
    getSpineTree: (ref) => call("GET", `/spine-tree?${query(ref)}`),
    listRepoSpines: (name) => call("GET", `/repos/${encodeURIComponent(name)}/spines`),
    listRepos: () => call("GET", "/repos"),
    listRepoDocs: (name) => call("GET", `/repos/${encodeURIComponent(name)}/docs`),

    listThreads: () => call("GET", "/threads"),
    listTickets: () => call("GET", "/tickets"),
    listTicketsTop: (limit) => call("GET", `/tickets${qs({ limit: limit ? String(limit) : "all" })}`),
    listSeats: () => call("GET", "/seats"),
    // the app start asked /api/me five times at once; concurrent callers now share one request
    getWhatsAppHolder: () => call("GET", "/notify/whatsapp/holder"),
    setWhatsAppHolder: (personaId) => call("PUT", "/notify/whatsapp/holder", { personaId }),
    getMe: () => (meInFlight ??= call<Me>("GET", "/me").finally(() => (meInFlight = undefined))),
    logout: () => call("POST", "/access/logout"),
    switchWorld: (tenant) => call("POST", "/access/switch", { tenant }),
    getWorldCounts: () => call("GET", "/counts/worlds"),
    getHosts: () => call("GET", "/hosts"),
    listTesters: () => call("GET", "/testers"),
    redLine: () => call("GET", "/red-line"),
    editRedLine: (input) => call("POST", "/red-line/edit", input),
    briefingAnswer: (input) => call("POST", "/briefing/answer", input),
    deleteRedLine: (input) => call("POST", "/red-line/delete", input),
    undoRedLine: (input) => call("POST", "/red-line/undo", input),
    laptop: () => call("GET", "/laptop"),
    setLaptop: (f) => call("POST", "/laptop", { for: f }),
    laptopOff: () => call("DELETE", "/laptop"),
    stepTick: (pageId, body) => call("POST", `/steps/pages/${encodeURIComponent(pageId)}/ticks`, body),
    listFeedback: () => call("GET", "/feedback"),
    createFeedbackLink: (input) => call("POST", "/feedback/links", input),
    revokeFeedbackLink: (id) => call("POST", `/feedback/links/${encodeURIComponent(id)}/revoke`),
    markTestersSeen: () => call("POST", "/testers/seen"),
    makeTesterWorld: (id, payment) => call("POST", `/testers/${encodeURIComponent(id)}/world`, payment ? { payment } : {}),
    removeTesterWorld: (id, confirm) => call("DELETE", `/testers/${encodeURIComponent(id)}/world`, { confirm }),
    listTeamServices: (refresh, world) => call("GET", `/mcp/services${qs({ ...(refresh ? { refresh: "1" } : {}), ...(world ? { world } : {}) })}`),
    addTeamService: (input, world) => call("POST", `/mcp/services${qs(world ? { world } : {})}`, input),
    removeTeamService: (id, world) => call("DELETE", `/mcp/services/${encodeURIComponent(id)}${qs(world ? { world } : {})}`),
    setServiceSecret: (id, field, value, world) => call("PUT", `/mcp/services/${encodeURIComponent(id)}/secret/${encodeURIComponent(field)}${qs(world ? { world } : {})}`, { value }),
    removeServiceSecret: (id, field, world) => call("DELETE", `/mcp/services/${encodeURIComponent(id)}/secret/${encodeURIComponent(field)}${qs(world ? { world } : {})}`),
    testTeamService: (id, world) => call("POST", `/mcp/services/${encodeURIComponent(id)}/test${qs(world ? { world } : {})}`),
    listTeamSkills: () => call("GET", "/team-skills"),
    previewTeamSkill: (input) => call("POST", "/team-skills/preview", input),
    addTeamSkill: (input) => call("POST", "/team-skills", input),
    removeTeamSkill: (name, confirm) => call("DELETE", `/team-skills/${encodeURIComponent(name)}${confirm ? "?confirm=yes" : ""}`),
    setServiceAccess: (serviceId, personaId, allowed, capability, world) =>
      call("PUT", `/mcp/services/${encodeURIComponent(serviceId)}/access${qs(world ? { world } : {})}`, { personaId, allowed, ...(capability && capability !== "read" ? { capability } : {}) }),
    setMailSettings: (input) => call("PUT", "/mcp/mail/settings", input),
    pollTeamMailbox: () => call("POST", "/mcp/mail/poll"),
    listConnects: () => call("GET", "/connects"),
    getMemoryCard: (world) => call("GET", `/connections/memory${qs(world ? { world } : {})}`),
    listStepKeyPastes: () => call("GET", "/steps/secret-log"),
    getTeamLogins: () => call("GET", "/mcp/team-logins"),
    connectMemory: (world) => call("POST", `/connections/memory/connect${qs(world ? { world } : {})}`),
    setMemorySettings: (input, world) => call("PUT", `/connections/memory/settings${qs(world ? { world } : {})}`, input),
    testMemory: (world) => call("POST", `/connections/memory/test${qs(world ? { world } : {})}`),
    disconnectMemory: (world) => call("POST", `/connections/memory/disconnect${qs(world ? { world } : {})}`),
    socialWrite: async (tenantId, w, repo) => {
      // a held post's Schedule (approve, release) and New iteration (revise) are the one review API's, on its card
      const m = /^posts\/([^/]+)\/(approve|release|revise)$/.exec(w.action);
      if (m) {
        const id = `post~${repo ?? ""}~${m[1]}`;
        const body = (w.body ?? {}) as { feedback?: string; slot?: string };
        const r = (await (m[2] === "revise"
          ? press("POST", `/review-items/${encodeURIComponent(id)}/relaunch`, { feedback: body.feedback ?? "" })
          : press("POST", `/review-items/${encodeURIComponent(id)}/complete`, m[2] === "release" ? { release: true } : body))) as ReviewItem;
        if (!r.social) throw new Error("the review list answered without the post's write");
        return r.social;
      }
      return call("POST", `/tenants/${encodeURIComponent(tenantId)}/social/${w.action}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, w.body ?? {});
    },
    listCampaigns: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/campaigns`),
    listCampaignRepos: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/campaigns/repos`),
    previewCampaign: (tenantId, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/preview`, input),
    createCampaign: (tenantId, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns`, input),
    addJob: (tenantId, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/jobs`, input),
    createNamedCampaign: (tenantId, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/named`, input),
    campaignTemplate: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/campaigns/template`),
    renameCampaign: (tenantId, id, name) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/rename`, { name }),
    setCampaignPlan: (tenantId, id, plan) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/plan`, { plan }),
    saveOnePager: (tenantId, id, fields) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/onepager`, { fields }),
    getCampaignTotems: (tenantId, id) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/totems`),
    getCampaignPlan: (tenantId, id) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/plan`),
    saveCampaignPlan: (tenantId, id, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/plan/sections`, input),
    getObjectivePlan: (id) => call("GET", `/pursuits/${encodeURIComponent(id)}/plan`),
    getTotems: () => call("GET", "/totems"),
    getTotem: (product, id) => call("GET", `/totems/${encodeURIComponent(product)}/${encodeURIComponent(id)}`),
    getOnboarding: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/onboarding`),
    fileProductNote: (tenantId, id, note) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/product-note`, note),
    keepSlide: (tenantId, id, slide) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/slide/keep`, slide),
    undoSlide: (tenantId, id, slide) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/slide/undo`, slide),
    decideProposal: (tenantId, id, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/observation`, input),
    retireCampaign: (tenantId, id) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/retire`),
    restoreCampaign: (tenantId, id) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/campaigns/${encodeURIComponent(id)}/restore`),
    socialUpload: (tenantId, up, repo) => {
      const form = new FormData();
      form.append("file", up.file, up.file.name);
      for (const k of ["kind", "source", "cuts"] as const) if (up[k]?.trim()) form.append(k, up[k]!.trim());
      return call("POST", `/tenants/${encodeURIComponent(tenantId)}/social/assets${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, form);
    },

    getSocialDigest: (tenantId, date, repo) => {
      const q = new URLSearchParams({ ...(date ? { date } : {}), ...(repo ? { repo } : {}) }).toString();
      return call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/digest${q ? `?${q}` : ""}`);
    },
    getSocial: (tenantId, repo, campaign) => {
      const q = new URLSearchParams({ ...(repo ? { repo } : {}), ...(campaign ? { campaign } : {}) }).toString();
      return call("GET", `/tenants/${encodeURIComponent(tenantId)}/social${q ? `?${q}` : ""}`);
    },
    getSocialPostHistory: (tenantId, repo, id) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/posts/${encodeURIComponent(id)}/history?repo=${encodeURIComponent(repo)}`),
    getMessages: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/messages`),
    getChatHistory: (tenantId, repo, id) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/chats/${encodeURIComponent(id)}/history?repo=${encodeURIComponent(repo)}`),
    getSiteKpis: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/site-kpis`),
    getSocialMotion: (tenantId, repo, campaign) => {
      const q = new URLSearchParams({ ...(repo ? { repo } : {}), ...(campaign ? { campaign } : {}) }).toString();
      return call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/motion${q ? `?${q}` : ""}`);
    },
    getSocialKpis: (tenantId, repo) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/kpis${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
    getSocialMetrics: (tenantId, repo) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/social/metrics${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
    getBook: () => call("GET", "/book"),
    listReviewItems: (q) => call("GET", `/review-items${q?.state ? qs({ state: q.state }) : ""}`),
    snoozeReviewItem: (id, input) => press("POST", `/review-items/${encodeURIComponent(id)}/snooze`, input),
    approveReviewItem: (id) => press("POST", `/review-items/${encodeURIComponent(id)}/approve`, undefined, { undo: true }),
    listReviewGoals: () => call("GET", "/review-goals"),
    listClosedGoals: () => call("GET", "/review-goals/closed"),
    reopenGoal: (key) => press("POST", "/review-goals/reopen", { key }),
    // a held post's slot press posts on time (no undo window); every other close waits out Bring it back
    completeReviewItem: (id, pick) => press("POST", `/review-items/${encodeURIComponent(id)}/complete`, pick, { undo: !id.startsWith("post~") }),
    relaunchReviewItem: (id, feedback, attachments) => press("POST", `/review-items/${encodeURIComponent(id)}/relaunch`, { feedback, ...(attachments?.length ? { attachments } : {}) }, { undo: !id.startsWith("post~") }),
    denyReviewItem: (id, reason, attachments) => press("POST", `/review-items/${encodeURIComponent(id)}/deny`, { reason, ...(attachments?.length ? { attachments } : {}) }, { undo: !id.startsWith("post~") }),
    undoPress: (id) => call("POST", `/presses/${encodeURIComponent(id)}/undo`),
    undoAnswer: (id) => call("POST", `/owner-responses/${encodeURIComponent(id)}/undo`),
    reopenReviewRow: (card) => press("POST", "/review-items/reopen", card),
    commentClosedCard: (input) => press("POST", "/closed-cards/comment", input),
    listClosedCards: () => call("GET", "/closed-cards"),
    getMilestoneBook: (key) => call("GET", `/book/${encodeURIComponent(key)}`),
    getBigRocks: () => call("GET", "/rocks"),
    getMilestoneArc: (id: string) => call("GET", `/milestones/${encodeURIComponent(id)}/arc`),
    listDecks: () => call("GET", "/decks"),
    getEpicDeck: (repo, code) => call("GET", `/deck/${encodeURIComponent(repo)}/${encodeURIComponent(code)}`),
    deckOf: (key) => call("GET", `/deck-of/${encodeURIComponent(key)}`),
    listDeckCards: () => call("GET", "/deck-cards"),
    deckCardSeen: (ref) => call("POST", "/deck-cards/seen", ref),
    getCredits: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/credits`),
    startPlanCheckout: (tenantId) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/plan/checkout`, {}),
    getPlan: (tenantId) => call("GET", `/tenants/${encodeURIComponent(tenantId)}/plan`),
    grantCredits: (tenantId, input) => call("POST", `/tenants/${encodeURIComponent(tenantId)}/credits/grant`, input),
    setCreditsGate: (tenantId, on) => call("PUT", `/tenants/${encodeURIComponent(tenantId)}/credits/gate`, { on }),
    listTenants: () => call("GET", "/tenants"),
    wakeVps3: () => call("POST", `/hosts/${workerHost()}/wake`),
    getApprovals: (id) => call("GET", `/milestones/${encodeURIComponent(id)}/approvals`),
    addApproval: (id, input) => call("POST", `/milestones/${encodeURIComponent(id)}/approvals`, input),
    editApproval: (id, code, input) => call("PUT", `/milestones/${encodeURIComponent(id)}/approvals/${encodeURIComponent(code)}`, input),
    revokeApproval: (id, code, why) => call("POST", `/milestones/${encodeURIComponent(id)}/approvals/${encodeURIComponent(code)}/revoke`, { why }),

    listAuthSites: () => call("GET", "/auth/sites"),
    authReach: () => call("GET", "/auth/reach"),
    clearAuthSite: (id) => call("DELETE", `/auth/sites/${encodeURIComponent(id)}`),
    startAuthSync: (input) => call("POST", "/auth-sync", input),
    getAuthSync: (token) => call("GET", `/auth-sync/${encodeURIComponent(token)}`),
    listSignedInCheck: () => call("GET", "/auth/check"),
    listEgress: (posting) => call<{ egresses: EgressStatus[] }>("GET", `/auth/egress${posting ? "?posting=1" : ""}`).then((r) => r.egresses),
  };
}
