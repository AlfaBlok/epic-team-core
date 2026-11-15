import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, CALL_TIMEOUT_MS, RETRY_DELAYS_MS, TIMEOUT_MESSAGE, createRealClient, isReconnecting, onReconnecting, retryRandom } from "./real";

const reply = (status: number, body: unknown) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => vi.unstubAllGlobals());
// the retry waits are spread at random; 0.5 is the plain delay, so these timings stay exact.
retryRandom.next = () => 0.5;

describe("real client", () => {
  it("T34-S6: socialWrite posts to /tenants/:id/social/<action>; a 422 carries the pack's issue lines", async () => {
    const fetch = reply(200, {});
    vi.stubGlobal("fetch", fetch);
    const api = createRealClient();
    await api.socialWrite("social", { action: "posts/P-0001/feedback", body: { feedback: "shorter" } });
    await api.socialWrite("social", { action: "posts/P-0001/pull" }, "social");
    expect(fetch.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method, (c[1] as RequestInit).body])).toEqual([
      ["/api/tenants/social/social/posts/P-0001/feedback", "POST", '{"feedback":"shorter"}'],
      ["/api/tenants/social/social/posts/P-0001/pull?repo=social", "POST", "{}"],
    ]);
    vi.stubGlobal("fetch", reply(422, { error: { code: "invalid", message: "the pack refuses this change: x", issues: ["x", "y"] } }));
    const err = await createRealClient().socialWrite("social", { action: "ideas/I-1/drop" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code, err.issues]).toEqual([422, "invalid", ["x", "y"]]);
  });

  it("T34-S7: socialUpload posts multipart (file, kind, source) to /tenants/:id/social/assets, no JSON content type", async () => {
    const fetch = reply(200, {});
    vi.stubGlobal("fetch", fetch);
    const file = new File(["x"], "demo.mp4", { type: "video/mp4" });
    await createRealClient().socialUpload("social", { file, kind: "clip", source: " demo ", cuts: "" }, "social");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect([url, init.method, init.headers]).toEqual(["/api/tenants/social/social/assets?repo=social", "POST", undefined]);
    const form = init.body as FormData;
    expect([(form.get("file") as File).name, form.get("kind"), form.get("source"), form.get("cuts")]).toEqual(["demo.mp4", "clip", "demo", null]);
  });

  it("calls the M2-3 read endpoints", async () => {
    const fetch = reply(200, []);
    vi.stubGlobal("fetch", fetch);
    const api = createRealClient();
    await api.listRepos();
    await api.listRepoDocs("ops");
    await api.getBacklog("ms_1");
    await api.getTree("ms_1");
    await api.listThreads();
    await api.listTickets();
    await api.listSeats();
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "/api/repos",
      "/api/repos/ops/docs",
      "/api/milestones/ms_1/backlog",
      "/api/milestones/ms_1/tree",
      "/api/threads",
      "/api/tickets",
      "/api/seats",
    ]);
  });

  it("calls the T6-S12 hosts endpoints", async () => {
    const fetch = reply(200, {});
    vi.stubGlobal("fetch", fetch);
    const api = createRealClient();
    await api.getHosts();
    await api.wakeVps3();
    expect(fetch.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method])).toEqual([
      ["/api/hosts", "GET"],
      ["/api/hosts/worker/wake", "POST"],
    ]);
  });

  it("calls the M2-21 settle endpoints and passes includeSettled", async () => {
    const fetch = reply(200, []);
    vi.stubGlobal("fetch", fetch);
    const api = createRealClient();
    await api.listMilestones();
    await api.listMilestones({ includeSettled: true });
    await api.listWaitingOnOwner({ includeSettled: true });
    await api.settleMilestone("ms_1");
    await api.unsettleMilestone("ms_1");
    expect(fetch.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ["GET", "/api/milestones"],
      ["GET", "/api/milestones?includeSettled=true"],
      ["GET", "/api/waiting-on-owner?includeSettled=true&view=list"],
      ["POST", "/api/milestones/ms_1/settle"],
      ["POST", "/api/milestones/ms_1/unsettle"],
    ]);
  });

  it("calls the M4 browser auth endpoints", async () => {
    const fetch = reply(200, []);
    vi.stubGlobal("fetch", fetch);
    const api = createRealClient();
    await api.listAuthSites();
    await api.startAuthSync({ patterns: ["*.reddit.com"], browser: "chrome" });
    await api.getAuthSync("as1");
    await api.clearAuthSite("site_1");
    expect(fetch.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ["GET", "/api/auth/sites"],
      ["POST", "/api/auth-sync"],
      ["GET", "/api/auth-sync/as1"],
      ["DELETE", "/api/auth/sites/site_1"],
    ]);
  });

  it("surfaces a 503 from T3 as an ApiError with the server's message", async () => {
    vi.stubGlobal("fetch", reply(503, { error: { code: "t3_unavailable", message: "T3 threads unavailable: timeout" } }));
    const err = await createRealClient().listThreads().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("T3 threads unavailable: timeout");
  });

  it("keeps real errors as ApiError with the server's message", async () => {
    vi.stubGlobal("fetch", reply(400, { error: { code: "validation_error", message: "title required" } }));
    const err = await createRealClient().createMilestone({} as never).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("title required");
  });
});

// a hung console must not leave a page on "Loading…": every call gives up after 30 s with an ApiError.
describe("call() timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** fetch that never answers until its signal aborts (a hung server). */
  const hungFetch = () =>
    vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));

  /** AbortSignal.timeout firing at once (records the asked delay). */
  const fastTimeout = (asked: number[]) =>
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("signal timed out", "TimeoutError")), 1);
      return c.signal;
    });

  it("a call the server never answers fails after 30 s with an ApiError and a plain message", async () => {
    const asked: number[] = [];
    fastTimeout(asked);
    const fetchMock = hungFetch();
    vi.stubGlobal("fetch", fetchMock);
    const err = await createRealClient().listMilestones().catch((e) => e);
    expect(asked).toEqual([CALL_TIMEOUT_MS]);
    expect(CALL_TIMEOUT_MS).toBe(30_000);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(TIMEOUT_MESSAGE);
    expect(err.message).toBe("The console did not answer in 30 s. Try again.");
    expect(err.code).toBe("timeout");
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a timely answer is unaffected, and a non-ok answer keeps its own error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "m1" }]), { status: 200 })));
    expect(await createRealClient().listMilestones()).toEqual([{ id: "m1" }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "milestone x not found" } }), { status: 404 })));
    const err = await createRealClient().getMilestone("x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("milestone x not found");
  });

  it("a network failure on a write is passed on at once (writes are never retried)", async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchMock);
    const err = await createRealClient().createMilestone({} as never).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("T44-S5: a GET during a console restart retries quietly", () => {
  afterEach(() => vi.useRealTimers());
  const proxy502 = () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("502, 503, refused connection, then 200: the caller gets the data, never the error; reconnecting is on only meanwhile", async () => {
    vi.useFakeTimers();
    const answers = [() => proxy502(), () => new Response("", { status: 503 }), () => Promise.reject(new TypeError("Failed to fetch")), () => ok([{ id: "w1" }])];
    const fetchMock = vi.fn(async (_url: string) => answers.shift()!());
    vi.stubGlobal("fetch", fetchMock);
    const seen: boolean[] = [];
    const off = onReconnecting((on) => seen.push(on));
    const p = createRealClient().listWaitingOnOwner({ includeSuperseded: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(isReconnecting()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(await p).toEqual([{ id: "w1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/waiting-on-owner?includeSuperseded=true&view=list");
    expect(seen).toEqual([true, false]);
    expect(isReconnecting()).toBe(false);
    off();
  });

  it("the error reaches the page only after the ~60 s budget is spent", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => proxy502());
    vi.stubGlobal("fetch", fetchMock);
    let settled: unknown;
    const p = createRealClient()
      .listMilestones()
      .catch((e) => e)
      .then((e) => (settled = e));
    const budget = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(budget).toBeGreaterThanOrEqual(55_000);
    expect(budget).toBeLessThanOrEqual(65_000);
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(ApiError);
    expect((settled as ApiError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(isReconnecting()).toBe(false);
  });

  it("a 502 the console itself sends (JSON error body) and other errors are not retried", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "spines_failed", message: "spines.py failed for x" } }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await createRealClient().listRepoSpines("x").catch((e) => e);
    expect([err.status, err.code, err.transient]).toEqual([502, "spines_failed", false]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const f2 = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", f2);
    await createRealClient().listMilestones().catch((e) => e);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("a write meeting a proxy 502 fails at once (it may have landed)", async () => {
    const fetchMock = vi.fn(async () => proxy502());
    vi.stubGlobal("fetch", fetchMock);
    const err = await createRealClient().settleMilestone("m1").catch((e) => e);
    expect([err.status, err.transient]).toEqual([502, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("T33-S9: an answer survives a dropped request (same key, retried ~60 s)", () => {
  afterEach(() => vi.useRealTimers());

  it("Failed to fetch, a proxy 502, then the stored answer: every try carries the same clientKey; reconnecting meanwhile", async () => {
    vi.useFakeTimers();
    const stored = { id: "jr_1", job: { state: "pending", attempts: 0 } };
    const answers = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
      () => new Response(JSON.stringify(stored), { status: 200 }),
    ];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answers.shift()!());
    vi.stubGlobal("fetch", fetchMock);
    const seen: boolean[] = [];
    const off = onReconnecting((on) => seen.push(on));
    const p = createRealClient().respondToWaiting("w1", { kind: "answer", text: "I just added $10", milestoneId: "m1", wake: true });
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(await p).toEqual(stored);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies).toHaveLength(3);
    expect(bodies[0].clientKey).toMatch(/.{16,}/);
    expect(new Set(bodies.map((b) => b.clientKey)).size).toBe(1);
    expect(bodies[0]).toMatchObject({ kind: "answer", text: "I just added $10", milestoneId: "m1", wake: true });
    expect(seen).toEqual([true, false]);
    off();
  });

  it("our own 30 s timeout is retried for an answer too (the console stores it once); a new answer gets a new key", async () => {
    // The first try's AbortSignal.timeout fires at once (a hung console); the retry is answered.
    let n = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      if (n === 0) setTimeout(() => c.abort(new DOMException("signal timed out", "TimeoutError")), 1);
      return c.signal;
    });
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (n++ === 0) init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          else resolve(new Response(JSON.stringify({ id: "jr_1" }), { status: 201 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createRealClient();
    expect(await api.respondToWaiting("w1", { kind: "answer", text: "yes" })).toEqual({ id: "jr_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).clientKey);
    expect(keys[0]).toBe(keys[1]);
    await api.respondToWaiting("w2", { kind: "answer", text: "no" });
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)).clientKey).not.toBe(keys[0]);
    vi.restoreAllMocks();
  });

  it("a console error (validation, 404) is not retried", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "waiting item w1 not found" } }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await createRealClient().respondToWaiting("w1", { kind: "answer", text: "x" }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, "not_found"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the Inbox's list is one request, the slim view", () => {
  it("two readers asking for the same list at once make one request; a later ask makes a new one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async (_url: string) => (await gate, new Response(JSON.stringify([{ id: "w1" }]), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const api = createRealClient();
    const a = api.listWaitingOnOwner({ includeSuperseded: true });
    const b = api.listWaitingOnOwner({ includeSuperseded: true });
    release();
    expect(await a).toEqual([{ id: "w1" }]);
    expect(await b).toEqual([{ id: "w1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/waiting-on-owner?includeSuperseded=true&view=list");
    await api.listWaitingOnOwner({ includeSuperseded: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an opened Answered row fetches its whole card by id", async () => {
    const fetchMock = reply(200, { id: "wj_1" });
    vi.stubGlobal("fetch", fetchMock);
    await createRealClient().getWaitingItem!("wj_1", "ms_1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/waiting-on-owner/wj_1?milestoneId=ms_1");
  });
});

describe("the lists index.html started early", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("are taken once while fresh; a failed one is asked again the normal way; a stale one is dropped", async () => {
    const early: Record<string, { at: number; p: Promise<unknown> }> = {
      "/status": { at: Date.now(), p: Promise.resolve({ items: ["early"] }) },
      "/laptop": { at: Date.now(), p: Promise.resolve(null) },
      "/review-items": { at: Date.now() - 60_000, p: Promise.resolve(["stale"]) },
    };
    vi.stubGlobal("window", { __earlyGets: early, location: { pathname: "/" } });
    const fetchMock = reply(200, { from: "network" });
    vi.stubGlobal("fetch", fetchMock);
    const api = createRealClient();
    expect(await api.listStatus()).toEqual({ items: ["early"] });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    // taken once: the next ask goes to the network
    expect(await api.listStatus()).toEqual({ from: "network" });
    expect(await api.laptop!()).toEqual({ from: "network" });
    expect(await api.listReviewItems()).toEqual({ from: "network" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/status", "/api/laptop", "/api/review-items"]);
  });
});
