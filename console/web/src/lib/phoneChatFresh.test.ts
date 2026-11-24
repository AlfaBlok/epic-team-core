// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pollWhileVisible } from "@/lib/data";
import { createRealClient, EARLY_WAIT_MS } from "@/api/real";
import { onShownAgain, SHOWN_AGAIN_GAP_MS } from "@/pages/Chat";

/**
 * "my phone seems to be stuck on an earlier refresh, but basically it's not showing the latest chat".
 * The installed app showed the chat from two hours before and hung loading on restart. The chat reads its newest lines on
 * open and each time it is back on screen, a hung first read never pins it, and the service worker never draws an old
 * chat while the network can still answer.
 */
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeDoc() {
  const fns = new Set<() => void>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: string, f: () => void) => void fns.add(f),
    removeEventListener: (_t: string, f: () => void) => void fns.delete(f),
    show(s: DocumentVisibilityState) {
      this.visibilityState = s;
      fns.forEach((f) => f());
    },
  };
}

describe("back on screen after the phone froze the app", () => {
  it("reads at once although no tick ran while it was in the background (iOS stops timers)", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const refresh = vi.fn();
    pollWhileVisible(refresh, 15_000, doc as unknown as Document);
    doc.show("hidden");
    // two hours pass with every timer frozen: the clock moves, no interval tick runs
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    doc.show("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("the chat reads on visibility, focus, pageshow, online and the worker's fresh answer, once per burst", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const stop = onShownAgain(load);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SHOWN_AGAIN_GAP_MS);
    vi.setSystemTime(Date.now() + SHOWN_AGAIN_GAP_MS);
    window.dispatchEvent(new Event("online"));
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    vi.setSystemTime(Date.now() + 10_000);
    window.dispatchEvent(new Event("focus"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("a hung first read never pins the chat", () => {
  it("the early read not answered in time is dropped and the chat is read from the network", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = new Promise<unknown>(() => undefined);
    vi.stubGlobal("window", { __earlyGets: { "/desk/messages?limit=20": { at: Date.now(), p: hung } }, location: { pathname: "/chat" } });
    const fresh = { available: true, messages: [{ id: "m2", text: "what he just said" }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createRealClient();
    const first = api.getDeskChat!({ limit: 20 });
    // a poll meanwhile shares the same read, it does not start a second one
    const poll = api.getDeskChat!({ limit: 20 });
    await vi.advanceTimersByTimeAsync(EARLY_WAIT_MS);
    expect(await first).toEqual(fresh);
    expect(await poll).toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("index.html's early read carries its own 8 s clock", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
    expect(html).toMatch(/AbortSignal\.timeout\(8000\)/);
  });
});

/** the service worker run in a small fake of its world: caches, fetch, timers. */
function loadWorker(net: (url: string) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: Request | string) => (typeof r === "string" ? new URL(r, "https://t.test").href : r.url);
  const caches = {
    open: async (n: string) => {
      const m = stores.get(n) ?? new Map<string, Response>();
      stores.set(n, m);
      return {
        match: async (r: Request | string) => m.get(key(r))?.clone(),
        put: async (r: Request | string, res: Response) => void m.set(key(r), res),
        keys: async () => [...m.keys()].map((u) => new Request(u)),
        delete: async (r: Request | string) => m.delete(key(r)),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const on: Record<string, (e: unknown) => void> = {};
  const self = {
    location: new URL("https://t.test/"),
    addEventListener: (t: string, f: (e: unknown) => void) => (on[t] = f),
    clients: { matchAll: async () => [], claim: async () => undefined },
    skipWaiting: async () => undefined,
    registration: {},
  };
  const src = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", src)(self, caches, (q: Request | string) => net(typeof q === "string" ? q : q.url));
  const ask = (url: string, mode: RequestMode = "cors") =>
    new Promise<Response>((ok, fail) => {
      const q = new Request(`https://t.test${url}`);
      Object.defineProperty(q, "mode", { value: mode });
      on.fetch({ request: q, respondWith: (p: Promise<Response>) => p.then(ok, fail) });
    });
  return { ask, caches };
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const html = (b: string) => new Response(b, { status: 200, headers: { "content-type": "text/html" } });

describe("the installed app's service worker", () => {
  it("never draws an old chat while the network is slow; draws it only with no connection", async () => {
    let slow = false;
    let down = false;
    const w = loadWorker(async () => {
      if (down) throw new TypeError("offline");
      if (slow) await new Promise((r) => setTimeout(r, 7_000));
      return json({ newest: slow ? "fresh after a slow read" : "kept two hours ago" });
    });
    expect(await (await w.ask("/api/desk/messages?limit=20")).json()).toEqual({ newest: "kept two hours ago" });
    vi.useFakeTimers();
    slow = true;
    const p = w.ask("/api/desk/messages?limit=20");
    await vi.advanceTimersByTimeAsync(7_000);
    const r = await p;
    expect(r.headers.get("x-saved-copy")).toBeNull();
    expect(await r.json()).toEqual({ newest: "fresh after a slow read" });
    vi.useRealTimers();
    down = true;
    const off = await w.ask("/api/desk/messages?limit=20");
    expect(off.headers.get("x-saved-copy")).toBeTruthy();
  });

  it("a page open never hangs: no answer in 8 s and the last app shell opens the app", async () => {
    let stall = false;
    const w = loadWorker(async () => (stall ? new Promise<Response>(() => undefined) : html("<html>shell</html>")));
    expect(await (await w.ask("/chat", "navigate")).text()).toContain("shell");
    vi.useFakeTimers();
    stall = true;
    const p = w.ask("/chat", "navigate");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await (await p).text()).toContain("shell");
  });
});
