// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { SidebarNav } from "@/components/Layout";
import { loadGoalSets } from "@/lib/sidebarScripts";

/**
 * the owner's yes ("Yes: build it") on the sidebar mock-up ("we need to harmonize the
 * sidebar ... maybe we can have like pinned and non-pinned ... The settings should be expandable"): Inbox and Chat, his
 * objectives in his order in one list (the owner, "These are all objectives ... and they're sorted"), then one folded
 * Other goals for the goals no objective holds, Tools folded, Settings folded (only what he changes,
 * settings are only what he changes), worlds last.
 */
const node = (id: string, name: string, rank: number): ScorecardNode =>
  ({ id, kind: "pursuit", name, rank, greens: 0, total: 1, spines: [], keyResults: [{ label: "One", state: "red", value: "0", kind: "key-result", work: [] }], rows: [], children: [] }) as ScorecardNode;
const body: ScorecardsBody = { nodes: [node("launch", "Acme: 5 testers", 1), node("books", "Books: accounts in order", 2), node("servers", "Acme: servers run themselves", 3)], spineInfo: {} };

// the objectives list is its own script: in, as the menu's warm-up has it before he opens the menu
beforeAll(async () => {
  await loadGoalSets();
}, 60_000);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the sidebar he approved", () => {
  it("lists every objective in his order in one list, then Add objective; the other goals fold apart", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const pinned = await screen.findByTestId("sidebar-objectives");
    // one list in his order: an objective once marked unpinned sits in it too
    expect(within(pinned).getAllByTestId("sidebar-set").map((x) => x.dataset.set)).toEqual(["launch", "books", "servers"]);
    expect(screen.queryByText(/More objectives/)).toBeNull();
    // option A (the owner's pick): no numbers; the ring, then the product word over the goal on one left edge, no box
    expect(within(pinned).queryAllByTestId("sidebar-set-nr")).toEqual([]);
    for (const li of within(pinned).getAllByTestId("sidebar-set")) {
      expect(within(li).getByTestId("sidebar-set-link").className).toContain("grid-cols-[18px_minmax(0,1fr)_auto]");
      const product = within(li).queryByTestId("objective-product");
      if (product) {
        expect(product.className).not.toMatch(/(^| )(px-|rounded|bg-)/);
        expect(within(li).getByTestId("objective-goal").className).toContain("col-start-2");
      }
    }
    expect(screen.getByTestId("sidebar-goal-sets-all").textContent).toMatch(/^Objectives/);
    expect(screen.queryByTestId("sidebar-products")).toBeNull();
    expect(screen.getByTestId("add-milestone").textContent).toBe("Add objective");
    const toggle = await screen.findByTestId("nav-other-goals-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/^Other goals/);
    fireEvent.click(toggle);
    const other = screen.getByTestId("nav-other-goals");
    expect(within(other).queryAllByTestId("sidebar-set")).toHaveLength(0);
    // the goals no objective holds (the mock's milestones), never an objective
    await waitFor(() => expect(within(other).getAllByTestId("big-root").length).toBeGreaterThan(0));
    expect(Number(within(toggle).getByTestId("nav-other-goals-count").textContent)).toBe(within(other).getAllByTestId("big-root").length);
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
    // the owner's 22 Nov verdicts: Seats and Hosts stay, Runs went up to the top, the rest left the menu.
    for (const t of ["Pages", "Post stats", "Persona outcomes", "Seats", "Hosts"]) expect(names(tools)).toContain(t);
    for (const t of ["Spines", "Runs", "Threads", "Tickets", "Dashboard", "Applications", "Voice feedback", "One-offs", "Outcomes"]) expect(names(tools)).not.toContain(t);
    const main = screen.getByTestId("nav-main");
    expect(within(main).getAllByRole("link").map((a) => a.textContent?.trim())).toContain("Runs");
    expect(names(tools)[0]).not.toBe("Voice notes");
    for (const t of ["All settings", "Personas", "Priority mode", "Secrets", "Connections", "Credits"]) expect(names(settings)).toContain(t);
    for (const t of ["Seats", "Hosts", "Runs", "Spines", "Dashboard"]) expect(names(settings)).not.toContain(t);
    expect(within(settings).getByText(/Dark mode|Light mode/)).toBeTruthy();
    // one Voice notes entry: a page pinned as "… voice notes" never shows a second one
    expect(names(tools).filter((n) => /voice notes/i.test(n ?? "") && n !== "Voice feedback")).toEqual(["Voice notes"]);
    expect(localStorage.getItem("sidebar.tools.open")).toBe("1");
  });
});
