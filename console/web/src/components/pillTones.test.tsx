// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type CountsView, type DeskChat, type DeskMessage } from "@/api";
import { Layout, SidebarNav } from "@/components/Layout";
import { PILL_TONES } from "@/components/homeSection";
import { CHAT_POLL_IDLE_MS, ChatPage, ChatView } from "@/pages/Chat";
import { SkinProvider, SKINS } from "@/lib/skin";
import { mockCampaignCard } from "@/api/mockCampaigns";

/**
 * Team (sidebar and top bar) shows red = waiting on you to unblock and
 * green = waiting for your review; Chat shows blue = unread replies; every sidebar milestone carries the same pills; the social
 * skin the same (L-5). The numbers come from GET /api/counts (one small answer); opening a chat marks it read.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const pills = (el: Element) => [...el.querySelectorAll("[data-count-pill]")].map((p) => `${(p as HTMLElement).dataset.tone}:${p.textContent}`);

/**
 * The status batch with `needs` open items per milestone (red), the review list with the green cards, and /counts with
 * blue. Every red and green pill is the length of its list (lib/inbox), so the seed is lists, not numbers; a
 * total above the per-milestone sum is items on a milestone not in the sidebar.
 */
async function seed(needs: Record<string, number>, counts: (ids: string[]) => Partial<CountsView>) {
  const ms = await api.listMilestones();
  const ids = ms.map((m) => m.id);
  const c = { needsYou: Object.values(needs).reduce((a, b) => a + b, 0), review: 0, chat: 0, milestones: {}, ...counts(ids) } as CountsView;
  const item = (milestoneId: string, n: number) => ({ id: `wj_${milestoneId}_${n}`, kind: "ask" as const, state: "open" as const, milestoneId, title: "Q?" });
  const of = (id: string) => Array.from({ length: needs[id] ?? 0 }, (_, n) => item(id, n));
  const extra = Array.from({ length: Math.max(0, (c.needsYou ?? 0) - Object.values(needs).reduce((a, b) => a + b, 0)) }, (_, n) => item("ms_elsewhere", n));
  const real = api.listStatus.bind(api);
  vi.spyOn(api, "listStatus").mockImplementation(async () => {
    const r = await real();
    const milestones = r.milestones.map((x) => ({ ...x, items: of(x.milestoneId), needsYou: needs[x.milestoneId] ?? 0, loading: false }));
    const items = [...Object.keys(needs).flatMap(of), ...extra];
    return { ...r, milestones, items, needsYou: items.length, loading: false };
  });
  const per = Object.entries(c.milestones).flatMap(([id, m]) => Array.from({ length: m.review ?? 0 }, (_, n) => ({ id: `rv_${id}_${n}`, milestoneId: id })));
  const cards = [...per, ...Array.from({ length: Math.max(0, (c.review ?? 0) - per.length) }, (_, n) => ({ id: `rv_x_${n}` }))];
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : cards) as never);
  const getCounts = vi.spyOn(api, "getCounts").mockImplementation(async () => c);
  return { ms, ids, getCounts };
}

describe("T48-S19 pill tones", () => {
  it("red = needs you, green = review, blue = unread, grey = info: defined once", () => {
    expect(PILL_TONES["needs-you"]).toContain("bg-[hsl(0_72%_51%)]"); // (the owner on: "I still want green and red pills")
    expect(PILL_TONES.review).toContain("bg-[hsl(142_72%_29%)]");
    // the unread pill is a quiet dark grey, never blue; red and green stay the only bright counters.
    expect(PILL_TONES.unread).toContain("bg-border"); // unread is the quiet grey pill
    expect(PILL_TONES.unread).not.toMatch(/sky|blue/);
    expect(PILL_TONES.info).toContain("bg-muted");
  });
});

describe("T48-S19 sidebar pills", () => {
  it("Team: red + green; Chat: blue; each milestone its own red then green, never blue (T48-S33); nothing at 0", async () => {
    const mk = (title: string) => api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam" });
    const [a, b, c] = [await mk("Pills A"), await mk("Pills B"), await mk("Pills C")];
    const { ms, getCounts } = await seed({ [a.id]: 2, [c.id]: 1 }, () => ({
      review: 5,
      chat: 3,
      milestones: { [a.id]: { needsYou: 2, review: 1, chat: 4 }, [b.id]: { review: 2 }, [c.id]: { needsYou: 1 } },
    }));
    getCounts.mockClear();
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [] } as never); // no objectives yet, so the goals are listed
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const main = await screen.findByTestId("nav-main");
    const team = within(main).getByText("Inbox").closest("a")!; // the home is the Inbox
    await waitFor(() => expect(pills(team)).toEqual(["needs-you:3", "review:5"]));
    expect(within(team).getByTestId("waiting-count").textContent).toBe("3");
    expect(within(team).getByTestId("team-review-count").textContent).toBe("5");
    const chat = within(main).getByText("Chat").closest("a")!;
    expect(pills(chat)).toEqual(["unread:3"]);
    expect(within(chat).getByTestId("chat-unread").title).toBe("3 unread messages");

    const line = (id: string) => document.querySelector(`[data-testid="sidebar-milestones"] a[href="/milestones/${id}"]`)!;
    // no Other goals fold; with no objectives yet the goals are listed straight
    const open = screen.queryByTestId("other-milestones-toggle");
    if (open?.getAttribute("aria-expanded") === "false") act(() => open.click());
    await waitFor(() => expect(pills(line(a.id))).toEqual(["needs-you:2", "review:1"]));
    expect(pills(line(b.id))).toEqual(["review:2"]);
    expect(pills(line(c.id))).toEqual(["needs-you:1"]);
    for (const m of ms.filter((x) => ![a.id, b.id, c.id].includes(x.id))) expect(pills(line(m.id))).toEqual([]);
    expect(line(a.id).querySelector('[data-testid="sidebar-review"]')!.getAttribute("data-milestone-id")).toBe(a.id);
    // no blue pill anywhere in the milestones (focus roots, each line, the folded Other milestones line).
    expect(document.querySelectorAll('[data-testid="sidebar-milestones"] [data-tone="unread"]')).toHaveLength(0);
    if (open) {
      act(() => open.click());
      expect(open.getAttribute("aria-expanded")).toBe("false");
      expect(pills(open).some((p) => p.startsWith("unread"))).toBe(false);
    }
  });

  it("the social skin shows the same pills (PLAN-34 L-5)", async () => {
    // the social menu folds everything after his pinned campaigns into More; open it as a press would.
    localStorage.setItem("sidebar.more.open", "1");
    const [a] = await api.listMilestones();
    await seed({ [a.id]: 1 }, () => ({ review: 2, chat: 1, milestones: { [a.id]: { needsYou: 1, review: 2, chat: 1 } } }));
    // the social menu lists campaigns only: this milestone is one.
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "t", campaigns: [{ ...mockCampaignCard(), milestoneId: a.id }] });
    render(
      <MemoryRouter>
        <SkinProvider skin={SKINS.social}>
          <SidebarNav />
        </SkinProvider>
      </MemoryRouter>,
    );
    const main = await screen.findByTestId("nav-main");
    const team = () => main.querySelector('a[href="/inbox"]')!; // the pills sit on the Inbox entry
    await waitFor(() => expect(pills(team())).toEqual(["needs-you:1", "review:2"]));
    expect(pills(within(main).getByText("Chat").closest("a")!)).toEqual(["unread:1"]);
    const open = screen.queryByTestId("other-milestones-toggle");
    if (open?.getAttribute("aria-expanded") === "false") act(() => open.click());
    await waitFor(() => expect(pills(document.querySelector(`[data-testid="sidebar-milestones"] a[href="/milestones/${a.id}"]`)!)).toEqual(["needs-you:1", "review:2"]));
  });

  it("the top bar (phone) carries Team's red + green and Chat's blue, each a link; the Layout reads /counts once", async () => {
    const { getCounts } = await seed({}, () => ({ needsYou: 2, review: 4, chat: 1 }));
    getCounts.mockClear();
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("topbar-pills");
    expect(pills(within(bar).getByTestId("topbar-team"))).toEqual(["needs-you:2", "review:4"]);
    expect(within(bar).getByTestId("topbar-team").getAttribute("href")).toBe("/inbox");
    expect(pills(within(bar).getByTestId("topbar-chat"))).toEqual(["unread:1"]);
    expect(within(bar).getByTestId("topbar-chat").getAttribute("href")).toBe("/chat");
    await screen.findAllByTestId("chat-unread");
    expect(getCounts).toHaveBeenCalledTimes(1); // the top bar and the sidebar share one read
  });

  it("nothing to show: no pills, but Inbox and Chat stay in the top bar (T18-S9)", async () => {
    await seed({}, () => ({ needsYou: 0, review: 0, chat: 0 }));
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    await screen.findByTestId("nav-main");
    await new Promise((r) => setTimeout(r, 20));
    const bar = screen.getByTestId("topbar-pills");
    expect(within(bar).queryAllByTestId("pills")).toHaveLength(0);
    expect(within(bar).getByTestId("topbar-team").getAttribute("href")).toBe("/inbox");
    expect(within(bar).getByTestId("topbar-chat").getAttribute("href")).toBe("/chat");
    expect(within(bar).getByTestId("topbar-chat").getAttribute("aria-label")).toBe("Chat");
  });

  it("T18-S9: the top bar shows on the desktop too (not phone-only); the menu button and brand stay phone-only", async () => {
    await seed({}, () => ({ needsYou: 0, review: 0, chat: 2 }));
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Layout />
      </MemoryRouter>,
    );
    const top = await screen.findByTestId("topbar");
    expect(top.className).not.toMatch(/(^| )md:hidden( |$)/);
    expect(within(top).getByTestId("topbar-brand").className).toMatch(/md:hidden/);
    expect(within(top).getByLabelText("Open menu").className).toMatch(/md:hidden/);
    // on Chat, Home is one tap away (the mark) and Chat is marked as the current page
    expect(within(top).getByTestId("topbar-brand").getAttribute("href")).toBe("/");
    expect(within(top).getByTestId("topbar-team").getAttribute("href")).toBe("/inbox");
    expect(within(top).getByTestId("topbar-chat").className).toMatch(/bg-accent text-foreground/);
    await waitFor(() => expect(pills(within(top).getByTestId("topbar-chat"))).toEqual(["unread:2"]));
  });
});

const msg = (over: Partial<DeskMessage> & Pick<DeskMessage, "id" | "role" | "text">): DeskMessage => ({ kind: "message", status: "completed", at: new Date().toISOString(), ...over });
const deskChat = (messages: DeskMessage[]): DeskChat => ({ available: true, threadId: "th_1", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages });

describe("T48-S19 opening a chat marks it read", () => {
  it("the Chat page marks the world's desk seen on open and the pills refresh", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(deskChat([msg({ id: "a1", role: "assistant", text: "hello" })]));
    const seen = vi.spyOn(api, "markChatSeen").mockResolvedValue({ key: "team", seenAt: new Date().toISOString(), unread: 0 });
    let unread = 2;
    vi.spyOn(api, "getCounts").mockImplementation(async () => ({ needsYou: 0, review: 0, chat: unread, milestones: {} }));
    seen.mockImplementation(async () => {
      unread = 0;
      return { key: "team", seenAt: new Date().toISOString(), unread: 0 };
    });
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/chat" element={<ChatPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("hello");
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ chat: "desk" }));
    await waitFor(() => expect(screen.queryByTestId("chat-unread")).toBeNull());
  });

  it("a chat view marks seen on open and again on each new line, never again for the same lines", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let messages = [msg({ id: "a1", role: "assistant", text: "first" })];
      const load = vi.fn(async () => deskChat(messages));
      const markSeen = vi.fn(async () => ({}));
      vi.spyOn(api, "getCounts").mockResolvedValue({ needsYou: 0, review: 0, chat: 0, milestones: {} });
      render(
        <MemoryRouter>
          <ChatView who="Repo desk" load={load} sendMessage={async () => ({ threadId: "th_1", pending: false })} placeholder="…" markSeen={markSeen} />
        </MemoryRouter>,
      );
      await screen.findByText("first");
      await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
      // polled again with the same lines: no new mark
      await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_IDLE_MS + 10)));
      expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(markSeen).toHaveBeenCalledTimes(1);
      // a new reply arrives while it is open: marked again
      messages = [...messages, msg({ id: "a2", role: "assistant", text: "second" })];
      await act(async () => void (await vi.advanceTimersByTimeAsync(CHAT_POLL_IDLE_MS + 10)));
      await screen.findByText("second");
      expect(markSeen).toHaveBeenCalledTimes(2);
      // back into view: marked again
      await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
      expect(markSeen).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the milestone Chat tab marks that milestone's chat", async () => {
    const m = (await api.listMilestones())[0];
    vi.spyOn(api, "getMilestoneChat").mockResolvedValue(deskChat([msg({ id: "a1", role: "assistant", text: "repo desk here" })]));
    const seen = vi.spyOn(api, "markChatSeen").mockResolvedValue({ key: `milestone:${m.id}`, seenAt: new Date().toISOString(), unread: 0 });
    const { MilestonePage } = await import("@/pages/Milestone");
    render(
      <MemoryRouter initialEntries={[`/milestones/${m.id}?tab=chat`]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("repo desk here", {}, { timeout: 3000 });
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ chat: "milestone", id: m.id }));
  });
});
