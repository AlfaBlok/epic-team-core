// @vitest-environment jsdom
// a phone's first visit (Slow 4G) shows its screen sooner: Chat's last messages asked for at once and no hidden
// desktop sidebar (the build side: firstVisitBuild.test.ts).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWide } from "@/components/Layout";

describe("the early reads in index.html", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  const early = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("__earlyGets"))!;
  const run = (pathname: string, hostname = "team.example.com") => {
    const fetch = vi.fn(() => new Promise(() => {}));
    const win: Record<string, unknown> = {};
    new Function("location", "fetch", "window", early)({ pathname, hostname }, fetch, win);
    return Object.keys(win.__earlyGets as object);
  };

  it("asks Chat's last 20 messages the moment /chat opens, as the Chat screen asks them", () => {
    expect(run("/chat")).toEqual(["/desk/messages?limit=20"]);
    expect(fs.readFileSync(path.resolve(__dirname, "pages/Chat.tsx"), "utf8")).toMatch(/export const CHAT_PAGE = 20;/); // the same page size, or the early answer is never taken
  });

  it("keeps Home and the Inbox as they were and asks nothing elsewhere or on a social site's chat", () => {
    expect(run("/")).toEqual(["/scorecards", "/status", "/laptop"]);
    expect(run("/inbox")).toContain("/review-items");
    // the open asks only, never the whole list the Inbox reads after it
    expect(run("/inbox")).toContain("/waiting-on-owner?scope=open&includeSuperseded=true&view=list");
    expect(run("/inbox")).not.toContain("/waiting-on-owner?includeSuperseded=true&view=list");
    expect(run("/chat", "social.example.com")).toEqual([]);
    expect(run("/runs")).toEqual([]);
  });
});

describe("the Inbox's early reads are the very reads the app makes", () => {
  it("each /inbox early path is the path the app asks, or the early answer is never taken", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (asked.push(String(u).replace(/^\/api/, "")), new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))));
    const { createRealClient } = await import("@/api/real");
    const api = createRealClient();
    await api.listWaitingOnOwner({ includeSuperseded: true, scope: "open" });
    await api.getCounts();
    await api.listAnsweredPresses?.();
    await api.listSentBackCards?.();
    await api.listConnects();
    await api.listThreads();
    await api.listCompanyWorlds?.();
    vi.unstubAllGlobals();
    const early = ["/waiting-on-owner?scope=open&includeSuperseded=true&view=list", "/counts", "/presses/answered", "/sent-back-cards", "/connects", "/threads", "/worlds"];
    for (const p of early) expect(asked).toContain(p);
  });
});

describe("useWide (the desktop sidebar mounts only where it shows)", () => {
  const fakeWin = (matches: boolean) => {
    let on: (() => void) | undefined;
    const mq = { matches, addEventListener: (_: string, f: () => void) => (on = f), removeEventListener: () => (on = undefined) };
    return { win: { matchMedia: () => mq } as unknown as Window, mq, fire: () => on?.() };
  };

  it("is false on a phone and follows a turn to a wide screen", () => {
    const f = fakeWin(false);
    const { result } = renderHook(() => useWide(f.win));
    expect(result.current).toBe(false);
    act(() => {
      f.mq.matches = true;
      f.fire();
    });
    expect(result.current).toBe(true);
  });

  it("is true where the browser cannot tell (tests, old browsers)", () => {
    const { result } = renderHook(() => useWide({} as Window));
    expect(result.current).toBe(true);
  });
});
