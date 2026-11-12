// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Run, type Ticket, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { AskedNoRow } from "@/components/askedNoRow";
import { RunsPage } from "@/pages/Runs";
import { TicketsPage } from "@/pages/Lists";

/** the shared list pane for every list left after, server limits, one-line Answered on a phone. */

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E4",
  nodeKey: "ms_1/T4",
  path: "docs/E4.md",
  title: "T4 Pick the logger layout",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  recommendation: "one",
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: new Date(Date.now() - 2 * 86400_000).toISOString(),
  decidable: false,
  ...over,
});
const later = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
const snoozed = (n: number) => Array.from({ length: n }, (_, i) => base({ id: `wj_z${i}`, code: `E904-A${i + 1}`, question: `Snoozed ask ${i + 1} `.repeat(15), snoozedUntil: later }));
const fyi = (n: number) =>
  Array.from({ length: n }, (_, i) => base({ id: `wj_f${i}`, state: "answered", decidedBy: "Unblocker", question: `Decided ${i + 1}?`, answer: "one", options: undefined, recommendation: undefined }));
const answered = (n: number) => Array.from({ length: n }, (_, i) => base({ id: `wj_a${i}`, state: "answered", question: `Answered ask ${i + 1}?`, answer: "yes" }));
const wrap = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Waiting on you: Snoozed and Decided for you in the shared pane", () => {
  it("Snoozed (25) open: 20 one-line rows in the pane, Show 20 / 50 / all; a click on a question shows it in full", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...snoozed(25)]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    fireEvent.click(await screen.findByTestId("snoozed-count"));
    const section = screen.getByTestId("snoozed-section");
    const pane = within(section).getByTestId("snoozed-pane");
    expect(pane.className).toMatch(/max-h-\[30rem\]/);
    expect(pane.className).toMatch(/overflow-y-auto/);
    expect(within(pane).getAllByTestId("snoozed-row")).toHaveLength(20);
    expect(within(section).getByTestId("snoozed-more").textContent).toBe("20 of 25 shown");
    const q = within(pane).getAllByTestId("snoozed-question")[0];
    expect(q.className).toMatch(/truncate/);
    fireEvent.click(q);
    expect(q.className).not.toMatch(/truncate/);
    expect(q.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("snoozed-limit-all"));
    expect(within(pane).getAllByTestId("snoozed-row")).toHaveLength(25);
    expect(window.localStorage.getItem("teamHome.limit.snoozed")).toBe("0");
  });

  it("Decided for you (25): folds on its heading with the count (closed by default, remembered); open = 20 cards in the pane", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...fyi(25)]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    const section = await screen.findByTestId("decided-for-you");
    const toggle = within(section).getByTestId("decided-for-you-toggle");
    expect(toggle.textContent).toContain("Decided for you25");
    expect(within(section).queryByTestId("decided-for-you-pane")).toBeNull();
    fireEvent.click(toggle);
    expect(window.localStorage.getItem("teamHome.section.decided-for-you")).toBe("open");
    expect(within(within(section).getByTestId("decided-for-you-pane")).getAllByRole("listitem")).toHaveLength(20);
    expect(within(section).getByTestId("decided-for-you-more").textContent).toBe("20 of 25 shown");
    fireEvent.click(within(section).getByTestId("decided-for-you-limit-50"));
    expect(within(within(section).getByTestId("decided-for-you-pane")).getAllByRole("listitem")).toHaveLength(25);
    fireEvent.click(toggle);
    expect(within(section).queryByTestId("decided-for-you-pane")).toBeNull();
    expect(window.localStorage.getItem("teamHome.section.decided-for-you")).toBe("closed");
  });

  it("Answered rows are one line on a phone: no wrap, the answer text hidden below sm (on hover and in the opened card)", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...answered(3)]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    const section = await screen.findByTestId("answered-section");
    fireEvent.click(within(section).getByTestId("answered-section-toggle"));
    const row = within(section).getAllByTestId("answered-row")[0];
    const button = row.querySelector("button")!;
    expect(button.className).toMatch(/whitespace-nowrap/);
    expect(button.className).not.toMatch(/flex-wrap/);
    expect(button.getAttribute("title")).toContain("answered by");
    const answer = within(row).getByTestId("answered-answer");
    expect(answer.className).toMatch(/\bhidden\b/);
    expect(answer.className).toMatch(/sm:inline/);
    expect(within(row).getByTestId("answered-question").className).toMatch(/truncate/);
  });

  it("on a phone a qualified code drops its repo/ prefix and a snooze date its weekday (both still in the text)", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base({ repo: "home_repo", code: "E904-A0" }), base({ id: "wj_2", repo: "memo", code: "E907-A0" }), ...snoozed(2).map((i) => ({ ...i, repo: "memo" }))]);
    wrap(<WaitingOnYou />);
    fireEvent.click(await screen.findByTestId("snoozed-count"));
    const row = screen.getAllByTestId("snoozed-row")[0];
    const prefix = within(row).getByText("memo/");
    expect(prefix.className).toMatch(/max-sm:hidden/);
    expect(prefix.parentElement!.textContent).toBe("memo/E904-A1");
    const badge = within(row).getByText(/until/).parentElement!;
    expect(badge.querySelectorAll(".max-sm\\:hidden").length).toBeGreaterThanOrEqual(2); // "until " and the weekday
    expect(row.textContent).toMatch(/until \w{3}/);
  });
});

describe("Team home: Done waiting for your review, Asked no row yet", () => {

  // no pane and no Show 20 / 50 / all for review cards; components/review.test.tsx
  it("Asked, no row yet asks the server for the Show choice (?limit=20, then all) and counts its total", async () => {
    const item = (id: string) => ({ milestoneId: "ms_1", milestoneTitle: "home_repo", path: "docs/spines/epic-940.md", spineTitle: "EPIC-940", id, text: `${id} text `.repeat(20) });
    const all = Array.from({ length: 88 }, (_, i) => item(`E40-${i + 1}`));
    const list = vi.spyOn(api, "listAskedNoRow").mockImplementation(async (limit) => ({ items: limit ? all.slice(0, limit) : all, total: all.length }));
    wrap(<AskedNoRow />);
    expect((await screen.findByTestId("asked-no-row-count")).textContent).toBe("88");
    expect(list).toHaveBeenLastCalledWith(20);
    fireEvent.click(screen.getByTestId("asked-no-row-toggle"));
    const pane = screen.getByTestId("asked-no-row-pane");
    const lines = within(pane).getAllByTestId("asked-no-row-item");
    expect(lines).toHaveLength(20);
    expect(lines[0].className).toMatch(/whitespace-nowrap/);
    expect(lines[0].getAttribute("title")).toContain("text");
    fireEvent.click(lines[0]);
    expect(lines[0].className).not.toMatch(/whitespace-nowrap/);
    expect(screen.getByTestId("asked-no-row-more").textContent).toBe("20 of 88 shown");
    fireEvent.click(screen.getByTestId("asked-no-row-limit-all"));
    await waitFor(() => expect(within(screen.getByTestId("asked-no-row-pane")).getAllByTestId("asked-no-row-item")).toHaveLength(88));
    expect(list).toHaveBeenLastCalledWith(undefined);
  });
});

describe("Runs and Tickets pages", () => {
  const run = (id: string, over: Partial<Run>): Run => ({ id, assignmentId: "as_1", milestoneId: "ms_1", startedAt: "2026-10-21T20:00:00Z", outcome: "progressed", summary: "", ...over });
  const assignments: Assignment[] = [{ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 240 }, enabled: true }];
  const wakes = Array.from({ length: 30 }, (_, i) => run(`run_${i}`, { startedAt: new Date(Date.UTC(2026, 9, 1, 0, 30 - i)).toISOString(), outcome: i % 2 ? "idle" : "progressed" }));
  const child = run("run_kid", { parentRunId: "run_0", startedAt: "2026-10-01T00:31:00Z", summary: "child" });

  it("Runs: the server sends the newest 20 wakes with their children (?top=20); Show all asks for every wake", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([]);
    vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const flat = vi.spyOn(api, "listRuns").mockResolvedValue([...wakes, child]);
    const top = vi.spyOn(api, "listRunsTop").mockImplementation(async ({ top }) => ({ runs: [...(top ? wakes.slice(0, top) : wakes), child], total: 30 }));
    wrap(<RunsPage />);
    const pane = await screen.findByTestId("runs-pane");
    expect(top).toHaveBeenLastCalledWith({ top: 20, milestoneId: undefined });
    expect(flat).not.toHaveBeenCalled();
    expect(pane.className).toMatch(/max-h-\[30rem\]/);
    expect(within(pane).getAllByTestId("wake-line")).toHaveLength(20); // one line per wake, children inside it
    expect(screen.getByTestId("runs-count").textContent).toBe("30");
    expect(screen.getByTestId("runs-more").textContent).toBe("20 of 30 shown");
    fireEvent.click(screen.getByTestId("runs-limit-all"));
    await waitFor(() => expect(within(screen.getByTestId("runs-pane")).getAllByTestId("wake-line")).toHaveLength(30));
    expect(top).toHaveBeenLastCalledWith({ top: undefined, milestoneId: undefined });
  });

  it("Runs: an outcome filter reads the newest 500 runs as before and cuts the matches to the Show choice here", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([]);
    vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const many = Array.from({ length: 60 }, (_, i) => run(`run_m${i}`, { startedAt: new Date(Date.UTC(2026, 9, 2, 0, 60 - i)).toISOString(), outcome: "idle" }));
    const flat = vi.spyOn(api, "listRuns").mockResolvedValue(many);
    vi.spyOn(api, "listRunsTop").mockResolvedValue({ runs: many.slice(0, 20), total: 60 });
    render(
      <MemoryRouter initialEntries={["/runs?outcome=idle"]}>
        <RunsPage />
      </MemoryRouter>,
    );
    const pane = await screen.findByTestId("runs-pane");
    expect(flat).toHaveBeenCalled();
    expect(within(pane).getAllByTestId("wake-line")).toHaveLength(20);
    expect(screen.getByTestId("runs-more").textContent).toBe("20 of 60 shown");
  });

  it("Tickets: one line per ticket in the pane; the server sends the Show choice (?limit=20)", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([]);
    const all: Ticket[] = Array.from({ length: 160 }, (_, i) => ({ id: `T${i + 1}`, title: `Ticket ${i + 1} `.repeat(20), repo: "r", status: "ready", source: "ledger" }));
    const list = vi.spyOn(api, "listTicketsTop").mockImplementation(async (limit) => ({ tickets: limit ? all.slice(0, limit) : all, total: 160 }));
    wrap(<TicketsPage />);
    const pane = await screen.findByTestId("tickets-pane");
    expect(list).toHaveBeenLastCalledWith(20);
    expect(pane.tagName).toBe("DIV");
    expect(pane.className).toMatch(/max-h-\[30rem\]/);
    expect(within(pane).getAllByRole("row")).toHaveLength(21); // header + 20
    expect(screen.getByTestId("tickets-more").textContent).toBe("20 of 160 shown");
    const title = within(pane).getAllByRole("cell")[1];
    expect(title.className).toMatch(/truncate/);
    expect(title.getAttribute("title")).toContain("Ticket 1");
    fireEvent.click(screen.getByTestId("tickets-limit-50"));
    await waitFor(() => expect(within(screen.getByTestId("tickets-pane")).getAllByRole("row")).toHaveLength(51));
    expect(list).toHaveBeenLastCalledWith(50);
  });
});
