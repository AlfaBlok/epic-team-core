// @vitest-environment jsdom
import { forgetWorld as forgetWorldE33 } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api, type DeskChat, type DeskMessage } from "@/api";
import { ChatPage, chatHref, forgetChats, chatScroll, CHAT_POLL_FAST_MS, CHAT_POLL_IDLE_MS, CHAT_POLL_STALE_MS, formatElapsed, sendsOnKey, OLDER_RETRY_MS, OLDER_SLOW } from "@/pages/Chat";
import { blocks, chatLinkHref } from "@/lib/chatMarkdown";
import { SidebarNav } from "@/components/Layout";

// jsdom has no ResizeObserver (Radix) nor matchMedia.
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
  Element.prototype.scrollIntoView = vi.fn();
});

const msg = (over: Partial<DeskMessage> & Pick<DeskMessage, "id" | "role" | "text">): DeskMessage => ({ kind: "message", status: "completed", at: new Date().toISOString(), ...over });
const chat = (over: Partial<DeskChat> = {}): DeskChat => ({
  available: true,
  threadId: "th_desk",
  environmentId: "env_1",
  session: 1,
  status: "idle",
  working: false,
  sending: 0,
  hasEarlier: false,
  messages: [
    { id: "s1", role: "user", kind: "seed", text: "", status: "completed", session: 1 },
    msg({ id: "a1", role: "assistant", text: "Team desk ready." }),
  ],
  ...over,
});

const renderChat = (entry = "/chat") => {
  const loc = { search: "" };
  const Spy = () => {
    loc.search = useLocation().search;
    return null;
  };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/chat" element={<><ChatPage /><Spy /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return loc;
};

// each test is its own tab (a tab remembers its world)
beforeEach(() => forgetWorldE33());

describe("T18-S2 Chat page", () => {
  it("shows the transcript read from the desk thread: user text with its page chip, assistant Markdown, a divider for the seed", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({
        messages: [
          { id: "s1", role: "user", kind: "seed", text: "", status: "completed", session: 1 },
          msg({ id: "u1", role: "user", text: "what is open?", page: "M5 · Milestone page" }),
          msg({ id: "a1", role: "assistant", text: "Two things:\n\n- **T18-S1** is running\n- see [the epic](https://github.com/x/y/blob/main/e.md) and `spines.py`" }),
        ],
      }),
    );
    renderChat();
    const t = await screen.findByTestId("chat-transcript");
    expect(within(t).getByTestId("chat-divider").textContent).toContain("Chat started");
    expect(within(t).getByTestId("chat-page-chip").textContent).toBe("M5 · Milestone page"); // a chip, no "about:"
    expect(within(t).getByTestId("chat-user").textContent).toContain("what is open?");
    const a = within(t).getByTestId("chat-assistant");
    expect(a.querySelectorAll("li")).toHaveLength(2);
    expect(a.querySelector("strong")?.textContent).toBe("T18-S1");
    const link = within(a).getByRole("link", { name: "the epic" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/x/y/blob/main/e.md");
    expect(link.rel).toContain("noopener");
    expect(a.querySelector("code")?.textContent).toBe("spines.py");
  });

  it("T19-S2: the since-your-last-message block shows folded as an updates chip, never as Sam's text", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ messages: [msg({ id: "u1", role: "user", text: "what's new?", since: "Since 2026-10-25 20:00Z:\nCommits (1):\n- abc T19-S1 done" })] }));
    renderChat();
    const u = await screen.findByTestId("chat-user");
    const chip = within(u).getByTestId("chat-since-chip");
    expect(chip.tagName).toBe("DETAILS");
    expect((chip as HTMLDetailsElement).open).toBe(false);
    expect(chip.querySelector("summary")?.textContent).toBe("updates sent along");
    expect(chip.textContent).toContain("abc T19-S1 done");
    expect(u.querySelector("p.whitespace-pre-wrap:not(details p)")?.textContent).toBe("what's new?");
  });

  it("a later session's divider says the earlier chat was gone", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ session: 2, messages: [{ id: "s2", role: "user", kind: "seed", text: "", status: "completed", session: 2 }] }));
    renderChat();
    expect((await screen.findByTestId("chat-divider")).textContent).toContain("New session");
  });

  it("a customer's workspace chat shows no Open in T3 and never names T3", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({ customer: true, environmentId: undefined, hasEarlier: true, sending: 1, messages: [msg({ id: "a1", role: "assistant", text: "Hello Dana", truncated: true })] }),
    );
    renderChat();
    const t = await screen.findByTestId("chat-transcript");
    expect(within(t).getByText(/cut short/).textContent).not.toContain("T3");
    expect(screen.queryByRole("link", { name: /Open in T3/ })).toBeNull();
    expect(screen.getByTestId("chat-page").textContent).not.toMatch(/\bT3\b/);
  });

  it("links to the desk thread (t3code:// with the environment) and opens t3code / t3-thread links from replies", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({ messages: [msg({ id: "a1", role: "assistant", text: "Ticket: [S3](t3-thread://v1/thread:abc) and [run](t3code://threads/env_1/th_9)" })] }),
    );
    renderChat();
    const t = await screen.findByTestId("chat-transcript");
    expect((within(t).getByRole("link", { name: "S3" }) as HTMLAnchorElement).href).toBe("t3code://threads/env_1/thread%3Aabc");
    expect((within(t).getByRole("link", { name: "run" }) as HTMLAnchorElement).href).toBe("t3code://threads/env_1/th_9");
    expect((screen.getByRole("link", { name: /Open in T3/ }) as HTMLAnchorElement).href).toBe("t3code://threads/env_1/th_desk");
  });

  it("never turns an unsafe link or markup into a link or element", async () => {
    expect(chatLinkHref("javascript:alert(1)")).toBeUndefined();
    expect(chatLinkHref("data:text/html,x")).toBeUndefined();
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ messages: [msg({ id: "a1", role: "assistant", text: "[x](javascript:alert(1)) <img src=x onerror=alert(1)> <b>hi</b>" })] }));
    renderChat();
    const a = await screen.findByTestId("chat-assistant");
    expect(a.querySelector("a")).toBeNull();
    expect(a.querySelector("img, b")).toBeNull();
    expect(a.textContent).toContain("<b>hi</b>");
  });

  it("splits Markdown into blocks (code fences keep their lines)", () => {
    expect(blocks("# T\n\ntext a\ntext b\n\n```\nx = 1\n\ny = 2\n```\n1. one\n2. two")).toEqual([
      { kind: "h", text: "T", level: 1 },
      { kind: "p", text: "text a\ntext b" },
      { kind: "code", text: "x = 1\n\ny = 2" },
      { kind: "ol", items: [{ text: "one" }, { text: "two" }] },
    ]);
  });

  it("says working… while the desk's turn runs and polls fast; idle polls slowly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ working: true, status: "running" }));
    renderChat();
    expect((await screen.findByTestId("chat-working")).textContent).toContain("working");
    const n = get.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_FAST_MS * 2 + 10)));
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(n + 2);
    get.mockResolvedValue(chat({ working: false }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_FAST_MS + 10)));
    await waitFor(() => expect(screen.queryByTestId("chat-working")).toBeNull());
    const m = get.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_FAST_MS * 3)));
    expect(get.mock.calls.length).toBe(m); // idle: no fast polling
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_IDLE_MS)));
    expect(get.mock.calls.length).toBeGreaterThan(m);
  });

  it("sends the typed text; the page hint from 'Chat about this' goes along once, then is gone", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th_desk", pending: false });
    const loc = renderChat(chatHref("M5 · Milestone page"));
    expect((await screen.findByTestId("chat-hint")).textContent).toContain("About: M5 · Milestone page");
    const box = screen.getByLabelText("Message to the Team desk") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  add dark mode idea  " } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("add dark mode idea", "M5 · Milestone page", expect.stringMatching(/^chat-/)));
    await waitFor(() => expect(box.value).toBe(""));
    expect(screen.queryByTestId("chat-hint")).toBeNull();
    expect(loc.search).toBe("");
    fireEvent.change(box, { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith("second", undefined, expect.any(String)));
  });

  it("the hint can be dropped; an empty message cannot be sent", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "t", pending: false });
    renderChat(chatHref("Runs"));
    fireEvent.click(await screen.findByLabelText("Drop the page hint"));
    expect(screen.queryByTestId("chat-hint")).toBeNull();
    expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed send stays on its own bubble with why and Retry; messages T3 still holds show as waiting", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ sending: 1 }));
    const send = vi.spyOn(api, "sendDeskMessage").mockRejectedValueOnce(new Error("no seat available: all seats busy")).mockResolvedValue({ threadId: "th_desk", pending: true });
    renderChat();
    expect((await screen.findByTestId("chat-sending")).textContent).toContain("1 message waiting for T3");
    const box = screen.getByLabelText("Message to the Team desk") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(box.value).toBe(""); // the box is free at once
    const failed = await screen.findByTestId("chat-failed");
    expect(failed.textContent).toContain("hello");
    expect(within(failed).getByTestId("chat-failed-error").textContent).toContain("no seat available");
    fireEvent.click(within(failed).getByTestId("chat-retry"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][2]).toBe(send.mock.calls[0][2]); // the same request id: T3 drops a copy it already took
    await waitFor(() => expect(screen.queryByTestId("chat-failed")).toBeNull());
    expect(screen.getByTestId("chat-posting").textContent).toContain("hello");
  });

  it("shows why the chat is unavailable instead of a broken page", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue({ available: false, reason: "The Team desk needs T3.", working: false, sending: 0, messages: [], hasEarlier: false });
    renderChat();
    expect(await screen.findByText("The Team desk needs T3.")).toBeTruthy();
    expect(screen.queryByLabelText("Message to the Team desk")).toBeNull();
  });

  it("surfaces a server error (e.g. no seat for the first launch)", async () => {
    vi.spyOn(api, "getDeskChat").mockRejectedValue(new Error("no seat available: busy"));
    renderChat();
    expect(await screen.findByText("no seat available: busy")).toBeTruthy();
  });
});

describe("T18-S2 Chat at 412 px", () => {
  it("composer: 16 px text and a 44 px Send below sm (the E917 answer-box pattern); transcript cannot widen the page", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({ messages: [msg({ id: "a1", role: "assistant", text: "https://example.com/" + "a".repeat(200) + "\n\n```\n" + "x".repeat(300) + "\n```" })] }),
    );
    renderChat();
    const box = await screen.findByLabelText("Message to the Team desk");
    expect(box.className).toMatch(/max-sm:text-base/);
    expect(box.className).toContain("min-w-0");
    const send = screen.getByRole("button", { name: /Send/ });
    expect(send.className).toMatch(/max-sm:min-h-11/);
    // on the Team desk page Send sits beside the box, so the bottom dock (call bar + box) stays short on a phone.
    expect(send.className).not.toMatch(/max-sm:w-full/);
    const a = screen.getByTestId("chat-assistant");
    expect(a.firstElementChild!.className).toMatch(/min-w-0/);
    expect(screen.getByTestId("chat-md").className).toContain("[overflow-wrap:anywhere]");
    expect(a.querySelector("pre")!.className).toContain("overflow-x-auto");
    expect(screen.getByTestId("chat-page").className).toContain("min-w-0");
  });
});

describe("T18-S2 entry points", () => {
  it("the sidebar has a global Chat entry (one chat for every repo)", async () => {
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const link = (await screen.findByRole("link", { name: "Chat" })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/chat");
  });

  it("a goal's Chat desk tab is that milestone's Chat (the tab replaced the Chat about this button)", async () => {
    const { MilestonePage } = await import("@/pages/Milestone");
    const m = await api.createMilestone({ title: "Treeish", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    render(
      <MemoryRouter initialEntries={[`/milestones/${m.id}`]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
        </Routes>
      </MemoryRouter>,
    );
    const link = (await within(await screen.findByTestId("set-tabs")).findByRole("link", { name: "Chat desk" })) as HTMLAnchorElement;
    expect(new URL(link.getAttribute("href")!, `http://x/milestones/${m.id}`).searchParams.get("tab")).toBe("chat");
  });
});

describe("T49-S1 composer keys", () => {
  const setup = async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th_desk", pending: false });
    renderChat();
    const box = (await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hello desk" } });
    return { box, send };
  };

  it("Enter sends and clears the box", async () => {
    const { box, send } = await setup();
    const ev = fireEvent.keyDown(box, { key: "Enter" });
    expect(ev).toBe(false); // default (newline) prevented
    await waitFor(() => expect(send).toHaveBeenCalledWith("hello desk", undefined, expect.stringMatching(/^chat-/)));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("Shift+Enter is a newline, never a send", async () => {
    const { box, send } = await setup();
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true); // default kept: the browser inserts the newline
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(send).not.toHaveBeenCalled();
  });

  it("Cmd+Enter and Ctrl+Enter still send", async () => {
    const { box, send } = await setup();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: "again" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(send).toHaveBeenLastCalledWith("again", undefined, expect.any(String)));
  });

  it("never sends while an IME is composing (isComposing or keyCode 229)", async () => {
    const { box, send } = await setup();
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(send).not.toHaveBeenCalled();
    expect(box.value).toBe("hello desk");
  });

  it("the rule: touch keyboards keep Enter as a newline (Send button sends), Cmd/Ctrl+Enter sends there too", () => {
    expect(sendsOnKey({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }, false)).toBe(true);
    expect(sendsOnKey({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }, true)).toBe(false);
    expect(sendsOnKey({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: true, altKey: false }, true)).toBe(true);
    expect(sendsOnKey({ key: "a", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }, false)).toBe(false);
  });

  it("on a phone (touch keyboard) Enter does not send and the Send button does", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("coarse"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList);
    const { box, send } = await setup();
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("hello desk", undefined, expect.any(String)));
  });
});

describe("T49-S1 follows the latest line", () => {
  it("scrolls to the bottom on open, on a new message and when working… appears, while Sam is at the bottom", async () => {
    const bottom = vi.spyOn(chatScroll, "toBottom").mockImplementation(() => {});
    vi.spyOn(chatScroll, "atBottom").mockReturnValue(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    renderChat();
    await screen.findByTestId("chat-transcript");
    await waitFor(() => expect(bottom).toHaveBeenCalled());
    const n = bottom.mock.calls.length;
    get.mockResolvedValue(chat({ working: true, status: "running" }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_IDLE_MS + 10)));
    await screen.findByTestId("chat-working");
    expect(bottom.mock.calls.length).toBeGreaterThan(n);
    const k = bottom.mock.calls.length;
    get.mockResolvedValue(chat({ working: true, status: "running", messages: [...chat().messages, msg({ id: "a2", role: "assistant", text: "on it" })] }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_FAST_MS + 10)));
    await screen.findByText("on it");
    expect(bottom.mock.calls.length).toBeGreaterThan(k);
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();
  });

  it("T18-S18: the history has no frame of its own, and the latest pill is small on its bottom edge", async () => {
    vi.spyOn(chatScroll, "toBottom").mockImplementation(() => {});
    const at = vi.spyOn(chatScroll, "atBottom").mockReturnValue(true);
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    renderChat();
    await screen.findByTestId("chat-transcript");
    const sc = screen.getByTestId("chat-scroll");
    expect(sc.className).toMatch(/\bflex-1\b/);
    expect(sc.className).not.toMatch(/\bborder\b|rounded-lg|bg-muted/);
    at.mockReturnValue(false);
    act(() => void sc.dispatchEvent(new Event("scroll")));
    const pill = await screen.findByTestId("chat-jump-latest");
    expect(pill.className).toMatch(/\bh-7\b/);
    expect(pill.className).toMatch(/-top-3\.5/);
    expect(pill.className).not.toMatch(/min-h-11/);
  });

  it("scrolled up: a new message does not yank him down; Jump to latest shows and brings him back", async () => {
    const bottom = vi.spyOn(chatScroll, "toBottom").mockImplementation(() => {});
    const at = vi.spyOn(chatScroll, "atBottom").mockReturnValue(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    renderChat();
    await screen.findByTestId("chat-transcript");
    at.mockReturnValue(false);
    act(() => void screen.getByTestId("chat-scroll").dispatchEvent(new Event("scroll")));
    expect((await screen.findByTestId("chat-jump-latest")).textContent).toContain("Latest");
    const n = bottom.mock.calls.length;
    get.mockResolvedValue(chat({ messages: [...chat().messages, msg({ id: "a2", role: "assistant", text: "news" })] }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_IDLE_MS + 10)));
    await screen.findByText("news");
    expect(bottom.mock.calls.length).toBe(n); // not yanked
    expect(screen.getByTestId("chat-jump-latest").textContent).toContain("New messages");
    fireEvent.click(screen.getByTestId("chat-jump-latest"));
    expect(bottom.mock.calls.length).toBe(n + 1);
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();
  });

  it("scrolled up: his own send brings him to the bottom", async () => {
    const bottom = vi.spyOn(chatScroll, "toBottom").mockImplementation(() => {});
    const at = vi.spyOn(chatScroll, "atBottom").mockReturnValue(true);
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    let release!: () => void;
    vi.spyOn(api, "sendDeskMessage").mockImplementation(() => new Promise((r) => (release = () => r({ threadId: "th_desk", pending: false }))));
    renderChat();
    const box = (await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement;
    at.mockReturnValue(false);
    act(() => void screen.getByTestId("chat-scroll").dispatchEvent(new Event("scroll")));
    await screen.findByTestId("chat-jump-latest");
    const n = bottom.mock.calls.length;
    fireEvent.change(box, { target: { value: "mine" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("chat-posting");
    expect(bottom.mock.calls.length).toBeGreaterThan(n);
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();
    await act(async () => release());
  });
});

describe("T49-S1 working timer", () => {
  it("formats elapsed time as m:ss under an hour, h:mm:ss after", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(195_000)).toBe("3:15");
    expect(formatElapsed(3_730_000)).toBe("1:02:10");
    expect(formatElapsed(-5_000)).toBe("0:00");
  });

  it("counts live from the server's turn start, so a reload shows the true elapsed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ working: true, status: "running", workingSince: "2026-11-01T11:56:45Z" }));
    renderChat();
    const el = await screen.findByTestId("chat-working-elapsed");
    expect(screen.getByTestId("chat-working").textContent).toBe("Team desk is working… 3:15");
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(el.textContent).toBe("3:16");
    await act(async () => void (await vi.advanceTimersByTimeAsync(3_600_000)));
    expect(screen.getByTestId("chat-working-elapsed").textContent).toBe("1:03:16");
  });

  it("without a server start it counts from when the page first saw the desk working", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ working: true, status: "running" }));
    renderChat();
    expect((await screen.findByTestId("chat-working-elapsed")).textContent).toBe("0:00");
    await act(async () => void (await vi.advanceTimersByTimeAsync(42_000)));
    expect(screen.getByTestId("chat-working-elapsed").textContent).toBe("0:42");
  });
});

describe("T6-S53 T3 restarting: a quiet line, the last transcript, queued sends", () => {
  it("t3: restarting keeps the transcript and shows 'T3 is restarting, reconnecting…', never the raw error", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ t3: "restarting" }));
    renderChat();
    expect((await screen.findByTestId("chat-t3-down")).textContent).toBe("T3 is restarting, reconnecting…");
    expect(screen.getByTestId("chat-t3-down").getAttribute("role")).toBe("status");
    expect(within(screen.getByTestId("chat-transcript")).getByTestId("chat-assistant").textContent).toContain("Team desk ready.");
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|fetch failed/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("t3: maintenance says planned maintenance; T3 up shows no line", async () => {
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ t3: "maintenance" }));
    renderChat();
    expect((await screen.findByTestId("chat-t3-down")).textContent).toBe("T3 is down for planned maintenance, reconnecting…");
    cleanup();
    get.mockResolvedValue(chat());
    renderChat();
    await screen.findByTestId("chat-transcript");
    expect(screen.queryByTestId("chat-t3-down")).toBeNull();
  });

  it("a voice note the desk does not have yet shows on the note itself: 'not delivered yet, retrying'", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({
        undeliveredNotes: [
          { id: "vn_341120fc", at: "2026-11-18T03:43:31Z", text: "are these requests landing somewhere?", state: "retrying" },
          { id: "vn_e423bce7", at: "2026-11-18T03:06:55Z", text: "is that already happening?", state: "failed" },
        ],
      }),
    );
    renderChat();
    const notes = await screen.findAllByTestId("chat-undelivered-note");
    expect(notes).toHaveLength(2);
    expect(notes[0].textContent).toContain("are these requests landing somewhere?");
    expect(within(notes[0]).getByTestId("chat-undelivered-state").textContent).toBe("Voice note not delivered yet, retrying");
    expect(within(notes[1]).getByTestId("chat-undelivered-state").textContent).toMatch(/^Voice note not delivered\. Its words are kept/);
  });

  // E948-S174 / E942-S151 iteration 2 (vn_3b3cf02e): the console holds it, the desk does not yet: it spins, never ✓ Sent
  it("a send queued while T3 is down shows as its own bubble, spinning Sending until the desk has it", async () => {
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ t3: "restarting" }));
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th_desk", pending: true, queued: true });
    renderChat();
    const box = (await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement;
    get.mockResolvedValue(chat({ t3: "restarting", queued: [{ id: "queued-1", text: "move it to PLAN-17", at: new Date().toISOString() }] }));
    fireEvent.change(box, { target: { value: "move it to PLAN-17" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const q = await screen.findByTestId("chat-queued");
    expect(q.textContent).toContain("move it to PLAN-17");
    expect(q.textContent).toContain("Sending · the desk gets it as soon as T3 answers");
    expect(q.textContent).not.toContain("✓");
    expect(box.value).toBe("");
    expect(screen.queryByTestId("chat-send-error")).toBeNull();
  });
});

describe("T33-S10 Chat opens in under 1 s", () => {
  /** Messages at positions from..to (step 2), alternating the owner / desk. */
  const range = (from: number, to: number) => {
    const out: DeskMessage[] = [];
    for (let p = from; p <= to; p += 2) out.push(msg({ id: `m${p}`, role: p % 4 ? "assistant" : "user", text: `line ${p}`, position: p }));
    return out;
  };

  it("asks for the newest 20 messages, and Show older messages puts the next older page on top", async () => {
    const get = vi.spyOn(api, "getDeskChat").mockImplementation(async (read) =>
      read?.before !== undefined ? chat({ messages: range(140, 178), hasEarlier: false }) : chat({ messages: range(180, 218), hasEarlier: true }),
    );
    renderChat();
    const t = await screen.findByTestId("chat-transcript");
    expect(get).toHaveBeenCalledWith({ limit: 20 });
    expect(within(t).getAllByRole("listitem").length).toBe(20);
    fireEvent.click(screen.getByTestId("chat-older"));
    await waitFor(() => expect(get).toHaveBeenCalledWith({ before: 180, limit: 20 }));
    await waitFor(() => expect(within(t).getAllByText(/^line \d+$/).length).toBe(40));
    const lines = within(t).getAllByText(/^line \d+$/).map((e) => e.textContent);
    expect(lines[0]).toBe("line 140");
    expect(lines.at(-1)).toBe("line 218");
    expect(screen.queryByTestId("chat-older")).toBeNull(); // the chat's start is reached
  });

  it("an older page the console is still reading says so quietly and retries by itself, never the red error", async () => {
    let tries = 0;
    const get = vi.spyOn(api, "getDeskChat").mockImplementation(async (read) => {
      if (read?.before === undefined) return chat({ messages: range(180, 218), hasEarlier: true });
      return ++tries < 3 ? chat({ messages: [], hasEarlier: true, loading: true }) : chat({ messages: range(140, 178), hasEarlier: false });
    });
    renderChat();
    const t = await screen.findByTestId("chat-transcript");
    fireEvent.click(screen.getByTestId("chat-older"));
    expect((await screen.findByText(OLDER_SLOW)).textContent).toBe(OLDER_SLOW);
    expect(screen.queryByText(/Could not load them/)).toBeNull();
    await waitFor(() => expect(within(t).getAllByText(/^line \d+$/).length).toBe(40), { timeout: OLDER_RETRY_MS * 3 + 1000 });
    expect(get.mock.calls.filter(([r]) => r?.before === 180)).toHaveLength(3);
    expect(screen.queryByText(OLDER_SLOW)).toBeNull();
    expect(screen.queryByText(/Could not load them/)).toBeNull();
  }, 10_000);

  it("without positions (an older console) the note about the T3 thread stays", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ hasEarlier: true }));
    renderChat();
    await screen.findByTestId("chat-transcript");
    expect(screen.queryByTestId("chat-older")).toBeNull();
    expect(screen.getByText(/Older messages are in the desk's T3 thread/)).toBeTruthy();
  });

  it("an answer from the console's last good read (stale) is read again within a second", async () => {
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValueOnce(chat({ stale: true })).mockResolvedValue(chat({ messages: [msg({ id: "a2", role: "assistant", text: "fresh reply" })] }));
    renderChat();
    await screen.findByTestId("chat-transcript");
    expect(await screen.findByText("fresh reply", undefined, { timeout: CHAT_POLL_STALE_MS + 1500 })).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("opening Chat again shows the last read at once, before the console answers", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ messages: [msg({ id: "a1", role: "assistant", text: "remembered line" })] }));
    renderChat();
    await screen.findByText("remembered line");
    cleanup();
    vi.spyOn(api, "getDeskChat").mockImplementation(() => new Promise(() => undefined)); // the console is slow this time
    renderChat();
    expect(await screen.findByText("remembered line", undefined, { timeout: 300 })).toBeTruthy();
  });

  it("lines that slide out of the newest 30 while the chat is open stay shown", async () => {
    let n = 0;
    vi.spyOn(api, "getDeskChat").mockImplementation(async () => (n++ === 0 ? chat({ messages: range(100, 158), hasEarlier: true }) : chat({ messages: range(104, 162), hasEarlier: true })));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderChat();
    await screen.findByText("line 100");
    await act(async () => {
      vi.advanceTimersByTime(CHAT_POLL_IDLE_MS + 10);
    });
    await screen.findByText("line 162");
    const lines = within(screen.getByTestId("chat-transcript")).getAllByText(/^line \d+$/).map((e) => e.textContent);
    expect(lines[0]).toBe("line 100");
    expect(lines).toHaveLength(32);
  });
});

describe("T33-S10 Chat does not wait for /api/me again", () => {
  it("a tab that already knows its world opens the desk while /api/me is still out", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ messages: [msg({ id: "a1", role: "assistant", text: "desk line" })] }));
    renderChat();
    await screen.findByText("desk line");
    cleanup();
    vi.spyOn(api as Required<typeof api>, "getMe").mockImplementation(() => new Promise(() => undefined)); // the console stalls
    renderChat();
    expect(await screen.findByTestId("chat-transcript", undefined, { timeout: 500 })).toBeTruthy();
  });
});

describe("T33-S10 a reload paints the last chat from this browser", () => {
  it("a new page (memory gone) shows the kept chat while the console is slow", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ messages: [msg({ id: "a1", role: "assistant", text: "kept line" })] }));
    renderChat();
    await screen.findByText("kept line");
    cleanup();
    const { chatCache } = await import("@/pages/Chat");
    chatCache.clear(); // a reload: only localStorage is left
    vi.spyOn(api, "getDeskChat").mockImplementation(() => new Promise(() => undefined));
    renderChat();
    expect(await screen.findByText("kept line", undefined, { timeout: 300 })).toBeTruthy();
  });
});

describe("Send never waits", () => {
  it("his message shows at once, the box clears and Send stays ready while the console has not answered", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const releases: (() => void)[] = [];
    const send = vi.spyOn(api, "sendDeskMessage").mockImplementation(() => new Promise((r) => releases.push(() => r({ threadId: "th_desk", pending: true }))));
    renderChat();
    const box = (await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    // shown before the console answers, box empty, no spinner on Send
    expect(screen.getByTestId("chat-posting").textContent).toContain("first");
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "second" } });
    const btn = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(screen.getAllByTestId("chat-posting").map((e) => e.textContent)).toEqual([expect.stringContaining("first"), expect.stringContaining("second")]);
    // one at a time, in his order
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe("first");
    await act(async () => releases[0]());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toBe("second");
    await act(async () => releases[1]());
  });

  it("the bubble leaves once the transcript holds his message (no doubles)", async () => {
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th_desk", pending: true });
    renderChat();
    const box = (await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement;
    get.mockResolvedValue(chat({ messages: [...chat().messages, msg({ id: "u9", role: "user", text: "landed now" })] }));
    fireEvent.change(box, { target: { value: "landed now" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(screen.queryByTestId("chat-posting")).toBeNull());
    expect(within(screen.getByTestId("chat-transcript")).getAllByText("landed now").length).toBe(1);
  });

  it("a failure the console found after its reply shows on that message, with Retry", async () => {
    const get = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th_desk", pending: true });
    renderChat();
    const box = (await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "will fail later" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const crid = send.mock.calls[0][2] as string;
    get.mockResolvedValue(chat({ sendError: { text: "thread compacting after 5 attempts", at: new Date().toISOString(), clientRequestId: crid } }));
    const failed = await screen.findByTestId("chat-failed", undefined, { timeout: CHAT_POLL_FAST_MS + 2000 });
    expect(failed.textContent).toContain("compacting");
    expect(screen.queryByTestId("chat-send-error")).toBeNull(); // on the bubble, not a loose line
    expect(within(failed).getByTestId("chat-retry")).toBeTruthy();
    fireEvent.click(within(failed).getByTestId("chat-unsend"));
    expect(box.value).toBe("will fail later"); // Edit puts his words back
  });
});
