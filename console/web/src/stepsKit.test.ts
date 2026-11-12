// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// the steps kit answers at once ("Saved · filing to the repo"), then asks again until the change is in the repo.

const KIT = fs.readFileSync(path.join(__dirname, "../public/steps-kit.js"), "utf8");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("T87-S4 steps kit", () => {
  it("shows saved and filing at once, then in the repo when the commit lands, then a wake being tried again", async () => {
    vi.useFakeTimers();
    const views: unknown[] = [];
    const base = { page: { id: "sp_1", title: "TEST", url: "http://x/" }, notes: {}, ticks: {} };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body =
        init?.method === "POST"
          ? { spine: "saved", state: "done", done: true, step: "a", steps: { a: { state: "done", at: "2026-11-09" } }, notes: {}, ticks: {}, changes: {}, change: { id: 1, status: "saved", wake: "none", at: "x" } }
          : views.shift() ?? { ...base, steps: {}, changes: {} };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    document.body.innerHTML = '<section data-step="a" data-title="Step A"><h2>Step A</h2></section>';
    const script = document.createElement("script");
    script.setAttribute("data-steps-token", "tok");
    script.setAttribute("data-steps-api", "http://console");
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    new Function(KIT)(); // the kit as a page runs it, with this script tag as its own
    await flush();
    const state = () => document.querySelector(".sk-state")!.textContent;
    const done = [...document.querySelectorAll<HTMLButtonElement>(".sk-seg button")].find((b) => b.dataset.s === "done")!;
    done.click();
    await flush();
    expect(state()).toBe("Saved · filing to the repo…");
    views.push({ ...base, steps: { a: { state: "done", at: "2026-11-09" } }, changes: { a: { id: 1, status: "filed", sha: "abc", wake: "pending", wakeNextAt: "2026-11-09T18:16:00Z", at: "x" } } });
    await vi.advanceTimersByTimeAsync(3100);
    await flush();
    expect(state()).toMatch(/^In the repo · waking the team, next try \d\d:\d\d$/);
    views.push({ ...base, steps: { a: { state: "done", at: "2026-11-09" } }, changes: { a: { id: 1, status: "filed", sha: "abc", wake: "started", at: "x" } } });
    await vi.advanceTimersByTimeAsync(30100);
    await flush();
    expect(state()).toBe("In the repo · the team is told");
    const gets = fetchMock.mock.calls.filter((c) => !c[1] || (c[1] as RequestInit).method === "GET").length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.filter((c) => !c[1] || (c[1] as RequestInit).method === "GET").length).toBe(gets); // stops asking
  });
});
