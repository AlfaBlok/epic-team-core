// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { SidebarNav } from "@/components/Layout";
import { TeamPage } from "@/pages/Team";
import { pageMilestones } from "@/lib/bigRoots";

// milestones list in the owner's priority order (focus first, his order, then the others); about 20 show and
// the rest wait behind Load more, on the sidebar and on Team home.

afterEach(cleanup);
beforeEach(() => localStorage.clear());

let total = 0;
beforeAll(async () => {
  const mk = (title: string, bigRoot?: number) =>
    api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
  // Created out of order: the list must follow the focus position, not the creation time.
  await mk("Focus three", 3);
  await mk("Focus one", 1);
  await mk("Focus two", 2);
  for (let i = 1; i <= 22; i++) await mk(`Other ${String(i).padStart(2, "0")}`);
  total = (await api.listMilestones()).length;
});

describe("T40-S5 pageMilestones", () => {
  it("cuts focus then others at the limit and counts the rest", () => {
    expect(pageMilestones([1, 2], [3, 4, 5], 3)).toEqual({ roots: [1, 2], rest: [3], hidden: 2 });
    expect(pageMilestones([1, 2, 3], [4], 2)).toEqual({ roots: [1, 2], rest: [], hidden: 2 });
    expect(pageMilestones([1], [2], 20)).toEqual({ roots: [1], rest: [2], hidden: 0 });
  });
});

describe("T40-S5 sidebar: about 20, then Load more", () => {
  it("shows 20 in priority order and loads the rest on Load more", async () => {
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    // every goal no objective holds sits in the folded More objectives, its count on the fold.
    const toggle = await screen.findByTestId("more-objectives-toggle");
    await waitFor(() => expect(within(toggle).getByTestId("more-objectives-count").textContent).toBe(String(total)));
    expect(screen.queryAllByTestId("big-root")).toHaveLength(0);
    expect(screen.queryByTestId("sidebar-load-more")).toBeNull();
    fireEvent.click(toggle);
    // focus first, in priority order, then the others: about 20 in all
    expect(screen.getAllByTestId("big-root").slice(0, 3).map((r) => r.querySelector(".line-clamp-2")?.textContent?.trim())).toEqual(["Focus one", "Focus two", "Focus three"]);
    const box = screen.getByTestId("sidebar-milestones");
    const links = () => within(box).getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/milestones/"));
    expect(links()).toHaveLength(20);
    expect(within(box).queryByText("Other 22")).toBeNull();
    const more = screen.getByTestId("sidebar-load-more");
    expect(more.textContent).toBe(`Load more (${total - 20})`);
    fireEvent.click(more);
    expect(links()).toHaveLength(total);
    expect(within(box).getByText("Other 22")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-load-more")).toBeNull();
  });
});

describe("T40-S5 Team home: about 20 cards, then Load more", () => {
  it("shows 20 cards with focus first and loads the rest on Load more", async () => {
    render(
      <MemoryRouter>
        <TeamPage section="settings" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByTestId("milestone-card")).toHaveLength(20));
    const cards = screen.getAllByTestId("milestone-card");
    expect(cards.slice(0, 3).map((c) => c.querySelector("a")?.textContent)).toEqual([
      expect.stringContaining("Focus one"),
      expect.stringContaining("Focus two"),
      expect.stringContaining("Focus three"),
    ]);
    fireEvent.click(screen.getByTestId("team-load-more"));
    expect(screen.getAllByTestId("milestone-card")).toHaveLength(total);
    expect(screen.queryByTestId("team-load-more")).toBeNull();
  });
});
