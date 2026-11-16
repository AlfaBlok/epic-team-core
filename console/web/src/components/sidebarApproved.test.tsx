// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { SidebarNav } from "@/components/Layout";

/**
 * the owner's yes ("Yes: build it") on the sidebar mock-up ("we need to harmonize the
 * sidebar ... maybe we can have like pinned and non-pinned ... The settings should be expandable"): Inbox and Chat, his
 * objectives pinned in his order then one folded More objectives, Tools folded, Settings folded (only what he changes,
 * settings are only what he changes), worlds last.
 */
const node = (id: string, name: string, rank: number, unpinned?: boolean): ScorecardNode =>
  ({ id, kind: "pursuit", name, rank, greens: 0, total: 1, spines: [], keyResults: [{ label: "One", state: "red", value: "0", kind: "key-result", work: [] }], rows: [], children: [], ...(unpinned ? { unpinned: true } : {}) }) as ScorecardNode;
const body: ScorecardsBody = { nodes: [node("launch", "Acme: 5 testers", 1), node("books", "Books: accounts in order", 2, true), node("servers", "Acme: servers run themselves", 3)], spineInfo: {} };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the sidebar he approved", () => {
  it("pins his objectives in his order, folds the unpinned ones and the other goals into More objectives, and Add objective", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const pinned = await screen.findByTestId("sidebar-pinned-objectives");
    expect(within(pinned).getAllByTestId("sidebar-set").map((x) => x.dataset.set)).toEqual(["launch", "servers"]);
    // numbered down the pinned list, no gap where the unpinned one sits in his order
    expect(within(pinned).getAllByTestId("sidebar-set-nr").map((x) => x.textContent)).toEqual(["1", "2"]);
    expect(screen.getByTestId("sidebar-goal-sets-all").textContent).toMatch(/^Objectives/);
    expect(screen.queryByTestId("sidebar-products")).toBeNull();
    expect(screen.getByTestId("add-milestone").textContent).toBe("Add objective");
    const toggle = screen.getByTestId("more-objectives-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("sidebar-more-objectives")).toBeNull();
    fireEvent.click(toggle);
    const more = screen.getByTestId("sidebar-more-objectives");
    expect(within(more).getAllByTestId("sidebar-set").map((x) => x.dataset.set)).toEqual(["books"]);
    // the goals no objective holds follow (the house, travel, hair): the mock's milestones
    await waitFor(() => expect(within(more).getAllByTestId("big-root").length).toBeGreaterThan(0));
    expect(Number(within(toggle).getByTestId("more-objectives-count").textContent)).toBe(1 + within(more).getAllByTestId("big-root").length);
  });

  it("Tools and Settings are folded; Settings holds only what he changes, the pages he reads are Tools", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const tools = await screen.findByTestId("nav-pages");
    const settings = screen.getByTestId("nav-settings");
    expect(within(tools).queryAllByRole("link")).toHaveLength(0);
    expect(within(settings).queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(within(tools).getByTestId("nav-pages-toggle"));
    fireEvent.click(within(settings).getByTestId("nav-settings-toggle"));
    const names = (el: HTMLElement) => within(el).getAllByRole("link").map((a) => a.textContent?.trim());
    await waitFor(() => expect(names(tools)).toContain("Voice notes"));
    for (const t of ["Spines", "Runs", "Threads", "Tickets", "Seats", "Hosts", "Dashboard"]) expect(names(tools)).toContain(t);
    for (const t of ["All settings", "Personas", "Priority mode", "Secrets", "Connections", "Credits"]) expect(names(settings)).toContain(t);
    for (const t of ["Seats", "Hosts", "Runs", "Spines", "Dashboard"]) expect(names(settings)).not.toContain(t);
    expect(within(settings).getByText(/Dark mode|Light mode/)).toBeTruthy();
    // one Voice notes entry: a page pinned as "… voice notes" never shows a second one
    expect(names(tools).filter((n) => /voice notes/i.test(n ?? "") && n !== "Voice feedback")).toEqual(["Voice notes"]);
    expect(localStorage.getItem("sidebar.tools.open")).toBe("1");
  });
});
