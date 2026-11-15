// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type InboxSearchResult, type LaptopView, type MacTask, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { InboxSearchBox } from "@/components/inboxSearch";
import { searchMacTasks } from "@/components/laptopSwitch";
import { CampaignGoals } from "@/components/campaignGoals";
import { ConnectCards } from "@/components/connectCards";
import { InboxSearchProvider, saysNeedle } from "@/lib/inboxSearch";
import { resetSnoozes } from "@/lib/snooze";

/**
 * E948-S78, the owner 2026-11-13 (Team desk, "search not working", with a screenshot): searching the Inbox for
 * "t9-a10" still showed, under Blocked on you, the laptop panel's Mac tasks E986-S29 and E959-S22 that do not match.
 * The search filters every block, the laptop panel included; a block with no match hides.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ownSearch = api.searchInbox;
const ownLaptop = api.laptop;
afterEach(() => {
  api.searchInbox = ownSearch;
  api.laptop = ownLaptop;
  cleanup();
  vi.restoreAllMocks();
  resetSnoozes();
});
beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

const ask = (id: string, code: string, extra: Partial<WaitingItem> = {}): WaitingItem =>
  ({ id, source: "ask", state: "open", repo: "home_repo", code, milestoneId: "ms_x", milestoneTitle: "home_repo", path: "docs/spines/epic-9.md", line: 12, title: `row of ${code}`, ask: "decide", question: `Question ${code}?`, contextLinks: [], owner: { label: "Delivery Manager" }, decidable: false, ...extra }) as WaitingItem;
const pending = (id: string): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_x", title: `row of ${id}` });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-13T21:00:00Z" });
const task = (key: string, row: string, title: string, order: number, extra: Partial<MacTask> = {}): MacTask => ({ key, repo: "home_repo", row, title, order, command: `text for ${row}`, minutes: 5, ...extra });

const TASKS = [
  task("t-airbnb", "E986-S29", "Confirm the team helper in your Bitwarden organization, Claude files your Airbnb login", 1),
  task("t-keys", "E959-S22", "Security checklist 4 of 4: the same key swap on host1", 2),
  task("t-macask", "E977-S3", "Sign the Mac app", 3, { ask: "E977-A2" }),
];

function inbox() {
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([
    ask("wj_tax", "T9-A10", { question: "Paste the Cloudflare token for T9-A10?" }),
    ask("wj_mac", "E977-A2", { question: "Sign the Mac app", macAgent: true } as Partial<WaitingItem>),
  ]);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_tax")]));
  const view: LaptopView = { session: { id: "ls_1", since: "2026-11-13T20:00:00Z", until: new Date(Date.now() + 3_600_000).toISOString(), by: "owner" }, tasks: TASKS, listUrl: "http://example/mac/" };
  api.laptop = vi.fn(async () => view);
  api.searchInbox = vi.fn(async (q: string): Promise<InboxSearchResult> => {
    const ids = /t9-a10/i.test(q) ? ["wj_tax"] : /mac app/i.test(q) ? ["wj_mac"] : [];
    return { q, tookMs: 2, total: ids.length, counts: { blocked: ids.length, review: 0, done: 0 }, hits: ids.map((id) => ({ id, section: "blocked" as const, where: ["card" as const], title: "" })), rows: [] };
  });
  render(
    <MemoryRouter>
      <InboxSearchProvider>
        <InboxSearchBox />
        <WaitingOnYou title="Blocked on you" fold="blocked" laptop part="blocked" />
      </InboxSearchProvider>
    </MemoryRouter>,
  );
}
const type = (v: string) => fireEvent.change(screen.getByTestId("inbox-search-input"), { target: { value: v } });

describe("the Inbox search filters the laptop panel (E948-S78)", () => {
  it("t9-a10 keeps its card and hides the laptop panel, whose Mac tasks do not match", async () => {
    inbox();
    await waitFor(() => expect(screen.getAllByTestId("laptop-task")).toHaveLength(3));
    type("t9-a10");
    await waitFor(() => expect(screen.queryByTestId("laptop-switch")).toBeNull());
    expect(screen.queryByText(/Airbnb login/)).toBeNull();
    expect(screen.queryByText(/Security checklist/)).toBeNull();
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(1);
    expect(screen.getByTestId("waiting-card").textContent).toContain("T9-A10");
    // Clear brings the panel and its three tasks back.
    fireEvent.click(screen.getByTestId("inbox-search-clear"));
    await waitFor(() => expect(screen.getAllByTestId("laptop-task")).toHaveLength(3));
  });

  it("a Mac task whose ask the search kept, or whose own words hold the text, stays alone in the panel", async () => {
    inbox();
    await waitFor(() => expect(screen.getAllByTestId("laptop-task")).toHaveLength(3));
    type("Mac app");
    await waitFor(() => expect(screen.getAllByTestId("laptop-task")).toHaveLength(1));
    expect(screen.getByTestId("laptop-switch").textContent).toContain("Sign the Mac app");
    type("e959-s22");
    await waitFor(() => expect(screen.getByTestId("laptop-switch").textContent).toContain("Security checklist"));
    expect(screen.getAllByTestId("laptop-task")).toHaveLength(1);
  });

  it("searchMacTasks: tied by the kept ask, or by title, row or ask words; nothing else", () => {
    const kept = [ask("wj_mac", "E977-A2", { macAgent: true } as Partial<WaitingItem>)];
    expect(searchMacTasks(TASKS, kept, "zzz").map((t) => t.key)).toEqual(["t-macask"]);
    expect(searchMacTasks(TASKS, [], "airbnb").map((t) => t.key)).toEqual(["t-airbnb"]);
    expect(searchMacTasks(TASKS, [], "t9-a10")).toEqual([]);
  });
});

describe("the Inbox search filters the goals block too (E948-S78)", () => {
  it("a word no goal holds hides Your goals and their numbers; a word one holds keeps only that one", async () => {
    api.searchInbox = vi.fn(async (q: string): Promise<InboxSearchResult> => ({ q, tookMs: 1, total: 0, counts: { blocked: 0, review: 0, done: 0 }, hits: [], rows: [] }));
    render(
      <MemoryRouter>
        <InboxSearchProvider>
          <InboxSearchBox />
          <CampaignGoals />
        </InboxSearchProvider>
      </MemoryRouter>,
    );
    const headline = (await screen.findAllByTestId("experiment-headline"))[0].textContent!;
    type("t9-a10");
    await waitFor(() => expect(screen.queryByTestId("campaign-goals")).toBeNull());
    type(headline.split(/\s+/).filter((w) => w.length > 3)[0] ?? headline);
    await waitFor(() => expect(screen.getByTestId("campaign-goals")).toBeTruthy());
    expect(screen.getAllByTestId("experiment-headline").map((x) => x.textContent)).toContain(headline);
  });

  it("saysNeedle: no search keeps everything; otherwise any word holding the text, any case", () => {
    expect(saysNeedle("", "anything")).toBe(true);
    expect(saysNeedle("t9-a10", "Paste the token for T9-A10")).toBe(true);
    expect(saysNeedle("t9-a10", "Security checklist", undefined, null)).toBe(false);
  });
});

describe("the Inbox search filters the one-tap connect card too (E948-S78)", () => {
  it("a word the card does not hold hides it; its channel name keeps it", async () => {
    api.searchInbox = vi.fn(async (q: string): Promise<InboxSearchResult> => ({ q, tookMs: 1, total: 0, counts: { blocked: 0, review: 0, done: 0 }, hits: [], rows: [] }));
    vi.spyOn(api, "listConnects").mockResolvedValue({
      connects: [{ id: "sam-youtube", title: "Connect Sam YouTube", what: "Posts Shorts.", account: "sam@example.com", channel: { name: "Sam", handle: "@SamShorts" }, gives: ["upload videos"], connected: false, startUrl: "https://cloud.example.com/start", inbox: true }],
    });
    render(
      <MemoryRouter>
        <InboxSearchProvider>
          <InboxSearchBox />
          <ConnectCards where="inbox" />
        </InboxSearchProvider>
      </MemoryRouter>,
    );
    await screen.findByTestId("connect-sam-youtube");
    type("t9-a10");
    await waitFor(() => expect(screen.queryByTestId("connect-sam-youtube")).toBeNull());
    type("samshorts");
    await waitFor(() => expect(screen.getByTestId("connect-sam-youtube")).toBeTruthy());
  });
});
