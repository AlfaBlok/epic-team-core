// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildWatch, CHECK_TIMEOUT_MS, hasUnsent } from "@/components/NewBuild";
import { CHAT_FRESH_WAIT_MS, CHAT_OUT_OF_DATE_MS, ChatView, chatFreshText, forgetChats } from "@/pages/Chat";
import type { DeskChat } from "@/api/types";

/**
 * His voice note from his phone 24 Nov 21:58Z : "on my desktop I have ... a much more recent
 * chat history ... How do we refresh the chat to be up to date? ... why is it not happening on the phone right now?"
 * Cause: the phone app painted the chat it kept at 19:00 with no sign it was old while its network (Tailscale waking up)
 * had not answered; a check for the new build could hang for good, and a typed chat draft kept the app on an old build.
 * Now the old copy says how old it is, a Refresh always reads fresh (and moves onto a newer build), the build check gives
 * up after 10 s, and the chat's own draft never holds a reload.
 */
const T0 = new Date(2026, 10, 24, 19, 2).getTime();
let pos = 0;
const msg = (id: string, text: string, at: string, position = ++pos) => ({ id, role: "assistant", text, at, status: "done", position });
const chatWith = (messages: ReturnType<typeof msg>[]) => ({ available: true, threadId: "th_desk", messages, hasEarlier: false, working: false, sending: 0 }) as unknown as DeskChat;

beforeEach(() => forgetChats());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  forgetChats();
  document.body.innerHTML = "";
});

describe("the chat says when it shows an old copy", () => {
  it("a kept copy with no fresh answer yet says from when, after a short wait", () => {
    expect(chatFreshText({ newestAt: T0, openedAt: T0 + 2 * 3600_000, now: T0 + 2 * 3600_000 + 500 })).toBeUndefined();
    expect(chatFreshText({ newestAt: T0, openedAt: T0 + 2 * 3600_000, now: T0 + 2 * 3600_000 + CHAT_FRESH_WAIT_MS })).toBe("Showing the chat up to 19:02. Getting the newest…");
    expect(chatFreshText({ newestAt: T0, openedAt: T0, failing: true, now: T0 + 10 })).toBe("Showing the chat up to 19:02. Can't reach the team, retrying.");
  });

  it("a fresh chat says nothing; one with no fresh answer for a minute says it is out of date", () => {
    expect(chatFreshText({ freshAt: T0, openedAt: T0, now: T0 + 1000 })).toBeUndefined();
    expect(chatFreshText({ freshAt: T0, newestAt: T0, openedAt: T0, now: T0 + CHAT_OUT_OF_DATE_MS })).toBe("Showing the chat up to 19:02. Can't reach the team, retrying.");
  });

  it("the phone opens on the 19:02 copy while the network hangs: the line shows; Refresh reads the newest and the line goes", async () => {
    localStorage.setItem("console.chat:team", JSON.stringify({ ...chatWith([msg("m1", "The old answer from 19:02", new Date(T0).toISOString())]), keptAt: T0 }));
    let answer: ((c: DeskChat) => void) | undefined;
    const load = vi
      .fn<() => Promise<DeskChat>>()
      .mockImplementationOnce(() => new Promise<DeskChat>(() => undefined)) // Tailscale still waking: no answer
      .mockImplementation(() => new Promise<DeskChat>((ok) => (answer = ok)));
    render(<ChatView who="Team desk" load={load} sendMessage={async () => ({ threadId: "th_desk", pending: false })} placeholder="…" cacheKey="team" />);
    expect(screen.getByText("The old answer from 19:02")).toBeTruthy();
    await act(async () => void (await new Promise((r) => setTimeout(r, CHAT_FRESH_WAIT_MS + 1100))));
    expect(screen.getByTestId("chat-fresh-text").textContent).toBe("Showing the chat up to 19:02. Getting the newest…");
    fireEvent.click(screen.getByTestId("chat-refresh"));
    await act(async () => void (await Promise.resolve()));
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => answer?.(chatWith([msg("m1", "The old answer from 19:02", "2026-11-24T19:02:00Z"), msg("m2", "The desk's answer at 21:58", "2026-11-24T21:58:53Z")])));
    expect(screen.getByText("The desk's answer at 21:58")).toBeTruthy();
    expect(screen.getByTestId("chat-fresh-text").textContent).toBe("");
    expect(screen.getByTestId("chat-refresh")).toBeTruthy(); // Refresh stays, always there
  });
});

describe("a read still catching up after a release never replaces the newer chat on screen", () => {
  it("an older answer is not drawn and does not count as fresh; the full one is", async () => {
    const newer = chatWith([msg("m1", "Earlier", "2026-11-24T21:28:00Z", 5000), msg("m2", "The newest line", "2026-11-24T21:58:53Z", 5600)]);
    const older = { ...chatWith([msg("o1", "A line from two days back", "2026-11-22T07:43:00Z", 4296)]), stale: true } as DeskChat;
    const answers = [newer, older, { ...newer, stale: undefined } as DeskChat];
    const load = vi.fn(async () => answers.shift() ?? newer);
    render(<ChatView who="Team desk" load={load} sendMessage={async () => ({ threadId: "th_desk", pending: false })} placeholder="…" cacheKey="team2" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(screen.getByText("The newest line")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-refresh"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(screen.queryByText("A line from two days back")).toBeNull();
    expect(screen.getByText("The newest line")).toBeTruthy();
  });
});

describe("the app moves onto a new build after the phone was off its network", () => {
  const OLD = "/assets/index-OLD111.js";
  const NEW = "/assets/index-NEW222.js";
  const page = (e: string) => `<!doctype html><html><head><script type="module" src="${e}"></script></head><body></body></html>`;
  beforeEach(() => {
    document.head.innerHTML = `<script type="module" src="${OLD}"></script>`;
  });

  it("the build check carries a 10 s clock, and a failed check never pins the next one", async () => {
    expect(CHECK_TIMEOUT_MS).toBe(10_000);
    const calls: RequestInit[] = [];
    let first = true;
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(init);
      if (first) {
        first = false;
        throw new DOMException("The operation timed out.", "TimeoutError"); // what the 10 s clock does to a hung check
      }
      return new Response(page(NEW), { status: 200, headers: { "content-type": "text/html" } });
    });
    const reload = vi.fn();
    const w = new BuildWatch({ fetch: fetchFn as unknown as typeof fetch, doc: document, win: window, reload, busy: () => false });
    await w.check();
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(w.pending).toBeUndefined();
    await w.back("visible"); // network back: the next check is a new one, it finds the new build and reloads
    expect(w.pending).toBe(NEW);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("an unsent chat draft (kept across reloads) no longer holds the reload; other typed boxes still do", () => {
    document.body.innerHTML = '<div data-draft-kept><textarea>half a chat line</textarea></div>';
    expect(hasUnsent(document)).toBe(false);
    document.body.innerHTML = "<textarea>my answer on a card</textarea>";
    expect(hasUnsent(document)).toBe(true);
  });

  it("Refresh by hand moves onto a newer build even when this tab reloaded for it once", async () => {
    const m = new Map<string, string>([["console-build-reloaded", NEW]]);
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const fetchFn = vi.fn(async () => new Response(page(NEW), { status: 200, headers: { "content-type": "text/html" } }));
    const reload = vi.fn();
    const w = new BuildWatch({ fetch: fetchFn as unknown as typeof fetch, doc: document, win: window, storage, reload, busy: () => false });
    expect(await w.refreshNow()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    const busy = new BuildWatch({ fetch: fetchFn as unknown as typeof fetch, doc: document, win: window, storage, reload, busy: () => true });
    expect(await busy.refreshNow()).toBe(false); // never under a voice note or call
  });
});
