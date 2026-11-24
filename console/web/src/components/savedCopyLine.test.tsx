// @vitest-environment jsdom
// the inbox drawn from the app's saved copy shows one calm line with the copy's age; fresh data clears it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { SavedCopyLine } from "@/components/SavedCopyLine";
import { noteRead, resetSavedCopy, SAVED_CURRENT_MS, savedCopy, savedCopyLabel } from "@/lib/savedCopy";
import { createRealClient } from "@/api/real";

const at = (h: number, m: number, day = 24) => new Date(2026, 10, day, h, m).getTime();

beforeEach(() => resetSavedCopy());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("saved copy note", () => {
  it("says the copy's age in one line: the time today, the day too when older", () => {
    expect(savedCopyLabel(at(14, 2), at(14, 30))).toBe("Saved copy from 14:02, refreshing");
    expect(savedCopyLabel(at(9, 5, 23), at(14, 30))).toBe("Saved copy from 23 Nov 09:05, refreshing");
    expect(savedCopyLabel(undefined)).toBe("Saved copy, refreshing");
  });

  it("a saved read shows the line, the fresh read of the same list clears it", () => {
    render(<SavedCopyLine />);
    expect(screen.queryByTestId("saved-copy-line")).toBeNull();
    act(() => noteRead("/inbox/team-cards", new Date(at(14, 2)).toISOString()));
    expect(screen.getByTestId("saved-copy-line").textContent).toBe("Saved copy from 14:02, refreshing");
    act(() => noteRead("/inbox/team-cards", null));
    expect(screen.queryByTestId("saved-copy-line")).toBeNull();
  });

  it("several saved lists: the oldest copy is named, and the line stays until every one is fresh", () => {
    noteRead("/status", new Date(at(14, 10)).toISOString());
    noteRead("/review-items", new Date(at(13, 50)).toISOString());
    expect(savedCopy()?.keptAt).toBe(at(13, 50));
    noteRead("/review-items", null);
    expect(savedCopy()?.keptAt).toBe(at(14, 10));
    noteRead("/status", null);
    expect(savedCopy()).toBeUndefined();
  });

  it("a list no open page reads any more stops speaking for the screen", () => {
    noteRead("/other-page", "2026-11-24T14:02:00Z", 1_000);
    expect(savedCopy(1_000 + SAVED_CURRENT_MS - 1)).toBeDefined();
    expect(savedCopy(1_000 + SAVED_CURRENT_MS + 1)).toBeUndefined();
  });

  it("the app's reads note the service worker's x-saved-copy answer, and a fresh answer clears it", async () => {
    const answer = (saved?: string) =>
      vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json", ...(saved ? { "x-saved-copy": saved } : {}) } }));
    vi.stubGlobal("fetch", answer("2026-11-24T14:02:00Z"));
    await createRealClient().listStatus();
    expect(savedCopy()?.keptAt).toBe(Date.parse("2026-11-24T14:02:00Z"));
    vi.stubGlobal("fetch", answer());
    await createRealClient().listStatus();
    expect(savedCopy()).toBeUndefined();
  });
});

/** public/sw.js run as the browser runs it, with a fake cache, network and clocks. */
function loadWorker(network: (url: string) => Promise<Response>) {
  const store = new Map<string, Response>();
  const listeners: Record<string, (e: any) => void> = {};
  const posted: unknown[] = [];
  const cache = {
    match: async (q: Request | string) => store.get(typeof q === "string" ? q : q.url)?.clone(),
    put: async (q: Request | string, r: Response) => void store.set(typeof q === "string" ? q : q.url, r),
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
  };
  const self = {
    location: { origin: "https://team.example" },
    addEventListener: (t: string, f: (e: any) => void) => (listeners[t] = f),
    clients: { matchAll: async () => [{ postMessage: (m: unknown) => posted.push(m) }] },
    skipWaiting: async () => undefined,
  };
  const code = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
  vm.runInNewContext(code, { self, caches: { open: async () => cache }, fetch: (q: Request) => network(q.url), Headers, Response, Request, URL, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), Promise, Date, console });
  const read = async (url: string) => {
    let answer: Promise<Response> | undefined;
    listeners.fetch({ request: new Request(url, { headers: { accept: "application/json" } }), respondWith: (p: Promise<Response>) => (answer = p) });
    return answer!;
  };
  return { read, store, posted };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("the service worker marks a saved copy", () => {
  it("fresh: no mark; slow console: the kept copy with its kept time; the late fresh answer tells the page", async () => {
    let slow: ((r: Response) => void) | undefined;
    let mode: "fresh" | "slow" = "fresh";
    const w = loadWorker((url) => (mode === "fresh" ? Promise.resolve(json({ n: 1, url })) : new Promise((ok) => (slow = ok))));
    const first = await w.read("https://team.example/api/status");
    expect(first.headers.get("x-saved-copy")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    const keptAt = w.store.get("https://team.example/api/status")!.headers.get("x-kept-at");
    expect(Date.parse(keptAt!)).toBeGreaterThan(0);

    mode = "slow";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = w.read("https://team.example/api/status");
    await vi.advanceTimersByTimeAsync(6000);
    const saved = await p;
    expect(saved.headers.get("x-saved-copy")).toBe(keptAt);
    expect(await saved.json()).toMatchObject({ n: 1 });
    expect(w.posted).toEqual([]);
    vi.useRealTimers();
    slow!(json({ n: 2 }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.posted).toEqual([{ type: "saved-copy-fresh" }]);
  });

  it("offline: the kept copy answers marked as saved", async () => {
    let online = true;
    const w = loadWorker(() => (online ? Promise.resolve(json({ n: 1 })) : Promise.reject(new TypeError("offline"))));
    await w.read("https://team.example/api/review-items");
    await new Promise((r) => setTimeout(r, 0));
    online = false;
    const saved = await w.read("https://team.example/api/review-items");
    expect(saved.headers.get("x-saved-copy")).toMatch(/^\d{4}-/);
  });
});

describe("back online", () => {
  it("a saved copy on screen: coming back online reads again at once", async () => {
    const { onFreshFromWorker } = await import("@/lib/savedCopy");
    const sw = new EventTarget();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    const refresh = vi.fn();
    const off = onFreshFromWorker(refresh);
    window.dispatchEvent(new Event("online"));
    expect(refresh).not.toHaveBeenCalled();
    noteRead("/status", "2026-11-24T14:02:00Z");
    window.dispatchEvent(new Event("online"));
    expect(refresh).toHaveBeenCalledTimes(1);
    off();
  });
});
