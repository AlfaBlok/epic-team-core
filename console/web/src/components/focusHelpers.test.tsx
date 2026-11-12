// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { SidebarNav } from "@/components/Layout";
import { MilestoneDialog } from "@/components/dialogs";
import { TeamPage } from "@/pages/Team";
import { moveFocus, nextFocusPosition } from "@/lib/bigRoots";

// the big roots are "Focus milestones", the rest "Other milestones"; any milestone can be pinned
// to focus (and unpinned, reordered), and "New focus milestone" creates one already pinned.

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const focusTitles = () => {
  const head = screen.getByTestId("focus-milestones");
  const grid = head.parentElement!.querySelector(`[data-testid="focus-milestones"] ~ div.grid`)!;
  return [...grid.querySelectorAll('[data-testid="milestone-card"] .text-base')].map((e) => e.textContent);
};
const cardOf = (title: string) => screen.getAllByTestId("milestone-card").find((c) => within(c).queryByText(title))!;

describe("T41-S2 focus helpers", () => {
  it("next position follows the last focus milestone; moving renumbers only what changes", () => {
    expect(nextFocusPosition([])).toBe(1);
    expect(nextFocusPosition([{ bigRoot: 2 }, {}, { bigRoot: 4 }])).toBe(5);
    expect(nextFocusPosition([{ bigRoot: 99 }])).toBe(99);
    const roots = [{ id: "a", bigRoot: 1 }, { id: "b", bigRoot: 2 }, { id: "c", bigRoot: 3 }];
    expect(moveFocus(roots, 2, -1)).toEqual([{ id: "c", bigRoot: 2 }, { id: "b", bigRoot: 3 }]);
    expect(moveFocus(roots, 0, -1)).toEqual([]);
    // gaps (one removed from the middle) close on the next move
    expect(moveFocus([{ id: "a", bigRoot: 1 }, { id: "c", bigRoot: 3 }, { id: "d", bigRoot: 4 }], 0, 1)).toEqual([{ id: "c", bigRoot: 1 }, { id: "a", bigRoot: 2 }, { id: "d", bigRoot: 3 }]);
  });
});

describe("T41-S2 Team home: Focus milestones", () => {
  it("names both sections, pins an other milestone to focus, then unpins it, and the order comes back", async () => {
    const mk = (title: string, bigRoot?: number) => api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
    await mk("SocialApp launch", 1);
    await mk("Memo launch", 2);
    const infra = await mk("ops · PLAN-9");
    const spy = vi.spyOn(api, "updateMilestone");
    render(
      <MemoryRouter>
        <TeamPage section="settings" />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("focus-milestones")).textContent).toBe("Focus projects");
    expect(screen.getByTestId("other-milestones").textContent).toBe("Other projects");
    expect(screen.getByRole("button", { name: /New focus project/ })).toBeTruthy();
    await waitFor(() => expect(focusTitles()).toEqual(["SocialApp launch", "Memo launch"]));

    fireEvent.click(within(cardOf("ops · PLAN-9")).getByRole("button", { name: /Pin to focus/ }));
    await waitFor(() => expect(focusTitles()).toEqual(["SocialApp launch", "Memo launch", "ops · PLAN-9"]));
    expect(spy).toHaveBeenLastCalledWith(infra.id, { bigRoot: 3 });
    expect((await screen.findByTestId("focus-note")).textContent).toContain("pinned to focus at 3");

    // reorder: up swaps it with the memory service launch (two PATCHes), down puts it back
    fireEvent.click(within(cardOf("ops · PLAN-9")).getByRole("button", { name: /Move .* up/ }));
    await waitFor(() => expect(focusTitles()).toEqual(["SocialApp launch", "ops · PLAN-9", "Memo launch"]));
    fireEvent.click(within(cardOf("ops · PLAN-9")).getByRole("button", { name: /Move .* down/ }));
    await waitFor(() => expect(focusTitles()).toEqual(["SocialApp launch", "Memo launch", "ops · PLAN-9"]));

    fireEvent.click(within(cardOf("ops · PLAN-9")).getByRole("button", { name: /^Unpin$/ }));
    await waitFor(() => expect(focusTitles()).toEqual(["SocialApp launch", "Memo launch"]));
    expect(spy).toHaveBeenLastCalledWith(infra.id, { bigRoot: null });
    expect((await api.getMilestone(infra.id)).bigRoot).toBeUndefined();
    expect(within(cardOf("ops · PLAN-9")).getByRole("button", { name: /Pin to focus/ })).toBeTruthy();
    spy.mockRestore();
  });

  it("the sidebar names them Focus milestones", async () => {
    await api.createMilestone({ title: "Hair transplant", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", bigRoot: 1 });
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    await waitFor(() => expect(within(screen.getByTestId("sidebar-milestones")).getByText("Focus projects")).toBeTruthy());
    expect(screen.getByTestId("other-milestones-toggle").textContent).toMatch(/^Other projects/);
  });
});

describe("T41-S2 New focus milestone", () => {
  const pickRepo = async (name: string) => {
    fireEvent.change(screen.getByLabelText("Search repos"), { target: { value: name } });
    fireEvent.click(await within(screen.getByRole("listbox", { name: "Repos" })).findByText(name));
  };

  it("an existing spine: one POST carrying the focus position", async () => {
    const onCreated = vi.fn();
    const spy = vi.spyOn(api, "createMilestone");
    render(<MilestoneDialog open onOpenChange={() => {}} onCreated={onCreated} focusAt={7} />);
    expect(screen.getByRole("heading", { name: "New focus project" })).toBeTruthy();
    expect(screen.getByTestId("focus-hint").textContent).toContain("number 7");
    await pickRepo("home_repo");
    fireEvent.click(screen.getByRole("radio", { name: /Track an existing spine/ }));
    fireEvent.click(await within(screen.getByRole("listbox", { name: "Spine files" })).findByText("EPIC: Agent team"));
    fireEvent.click(screen.getByRole("button", { name: "Add focus project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ repo: "Acme/home_repo", bigRoot: 7 }));
    expect(onCreated.mock.calls[0][0]).toMatchObject({ bigRoot: 7 });
    spy.mockRestore();
  });

  it("a new epic (no spine yet): bootstrap, then made focus in the same submit", async () => {
    const onCreated = vi.fn();
    render(<MilestoneDialog open onOpenChange={() => {}} onCreated={onCreated} focusAt={5} />);
    await pickRepo("ops");
    fireEvent.click(screen.getByRole("radio", { name: /Create a new epic/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Test focus" } });
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "A goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Create epic as focus" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const m = onCreated.mock.calls[0][0];
    expect(m).toMatchObject({ title: "Test focus", bigRoot: 5 });
    expect((await api.getMilestone(m.id)).bigRoot).toBe(5);
  });
});

describe("T41-S2 a saved focus change shows before the list refetch answers", () => {
  it("Pin to focus moves the card at once and the next position counts it, while the refetch is still out", async () => {
    const mk = (title: string, bigRoot?: number) => api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
    await mk("SocialApp launch", 1);
    await mk("Slow A");
    const real = api.listMilestones.bind(api);
    let hold = false;
    const spy = vi.spyOn(api, "listMilestones").mockImplementation((o) => (hold ? new Promise(() => {}) : real(o)));
    try {
      render(
        <MemoryRouter>
          <TeamPage section="settings" />
        </MemoryRouter>,
      );
      await waitFor(() => expect(focusTitles()).toContain("SocialApp launch"));
      await waitFor(() => expect(screen.getAllByTestId("milestone-card").some((c) => within(c).queryByText("Slow A"))).toBe(true));
      const before = focusTitles();
      hold = true; // production: the list answers seconds after the PATCH
      fireEvent.click(within(cardOf("Slow A")).getByRole("button", { name: /Pin to focus/ }));
      await waitFor(() => expect(focusTitles()).toEqual([...before, "Slow A"]));
      await waitFor(() => expect(screen.getByTestId("focus-note").textContent).toMatch(/pinned to focus at \d+\.$/)); // done, no longer "saving…"
      // the next new focus milestone goes after it, not onto its place
      const at = (await real()).find((m) => m.title === "Slow A")!.bigRoot!;
      fireEvent.click(screen.getByRole("button", { name: /New focus project/ }));
      expect((await screen.findByTestId("focus-hint")).textContent).toContain(`number ${at + 1}`);
    } finally {
      spy.mockRestore();
    }
  });
});
