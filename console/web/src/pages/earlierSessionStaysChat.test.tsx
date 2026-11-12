// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat, type DeskMessage } from "@/api";
import { ChatPage, CHAT_EMPTY, CHAT_RETRY_MS, forgetChats, unreachableLine } from "@/pages/Chat";

/**
 * the Team desk chat keeps its earlier
 * session above a new one with the reason on the divider, and never shows a blank panel: loading, can't reach <host>, retrying,
 * or the console itself retrying.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => {
  forgetChats();
  forgetWorld();
  Element.prototype.scrollIntoView = vi.fn();
});

const msg = (over: Partial<DeskMessage> & Pick<DeskMessage, "id" | "role" | "text">): DeskMessage => ({ kind: "message", status: "completed", at: new Date().toISOString(), ...over });
const chat = (over: Partial<DeskChat> = {}): DeskChat => ({ available: true, threadId: "th_new", environmentId: "env", session: 17, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [], ...over });
const renderChat = () =>
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("T68-S1 the earlier session stays in the chat", () => {
  it("shows the earlier session's messages above the new one, the divider giving the reason", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({
        hasEarlier: true,
        messages: [
          msg({ id: "o1", role: "user", text: "ship the logos", position: -999_999_990 }),
          msg({ id: "o2", role: "assistant", text: "on it", position: -999_999_989 }),
          { id: "s2", role: "user", kind: "seed", text: "", status: "completed", session: 2, position: 0, note: "New session: the desk moved from host1 to host3. The earlier chat is above." },
          msg({ id: "n1", role: "user", text: "why is it gone?", position: 5 }),
        ],
      }),
    );
    renderChat();
    const t = await screen.findByTestId("chat-transcript");
    expect(within(t).getByText("ship the logos")).toBeTruthy();
    expect(within(t).getByTestId("chat-divider").textContent).toBe("New session: the desk moved from host1 to host3. The earlier chat is above.");
    expect(within(t).queryByText(/the earlier chat was gone/)).toBeNull();
    // older pages ask with the oldest (negative) position
    expect(screen.getByTestId("chat-older")).toBeTruthy();
  });

  it("scrolling up asks for the page before an earlier session's (negative) position", async () => {
    const read = vi.spyOn(api, "getDeskChat").mockImplementation(async (r) =>
      r?.before !== undefined
        ? chat({ messages: [msg({ id: "o0", role: "user", text: "the very first thing", position: -1_000_000_000 })], hasEarlier: false })
        : chat({ hasEarlier: true, messages: [msg({ id: "o1", role: "user", text: "ship the logos", position: -999_999_990 }), msg({ id: "n1", role: "user", text: "now", position: 3 })] }),
    );
    renderChat();
    (await screen.findByTestId("chat-older")).click();
    await screen.findByText("the very first thing");
    expect(read.mock.calls.some(([r]) => r?.before === -999_999_990)).toBe(true);
  });
});

describe("T68-S1 a chat never shows blank", () => {
  it("the desk's host cannot be reached: one quiet line, the last messages stay", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ unreachable: "host3", host: "host3", messages: [msg({ id: "a1", role: "assistant", text: "last good reply" })] }));
    renderChat();
    expect((await screen.findByTestId("chat-unreachable")).textContent).toBe(unreachableLine("host3"));
    expect(screen.getByText("last good reply")).toBeTruthy();
    expect(screen.queryByTestId("chat-t3-down")).toBeNull();
  });

  it("nothing to show yet says loading (or that the chat is empty), never an empty panel", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValueOnce(chat({ stale: true })).mockResolvedValue(chat());
    renderChat();
    expect((await screen.findByTestId("chat-empty")).textContent).toBe(CHAT_EMPTY.loading);
    await waitFor(() => expect(screen.getByTestId("chat-empty").textContent).toBe(CHAT_EMPTY.empty), { timeout: 3_000 });
  });

  it("an unreachable host with nothing read yet says loading next to the can't-reach line", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ unreachable: "host3" }));
    renderChat();
    expect((await screen.findByTestId("chat-empty")).textContent).toBe(CHAT_EMPTY.loading);
    expect(screen.getByTestId("chat-unreachable")).toBeTruthy();
  });

  it("the first read failing says the console is being retried, and the chat appears once it answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi
      .spyOn(api, "getDeskChat")
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(chat({ messages: [msg({ id: "a1", role: "assistant", text: "back again" })] }));
    renderChat();
    expect(await screen.findByTestId("chat-retrying")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS + 100);
    expect(await screen.findByText("back again")).toBeTruthy();
    expect(screen.queryByTestId("chat-retrying")).toBeNull();
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
