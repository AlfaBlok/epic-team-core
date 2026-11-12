// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Milestone, type StatusBatch } from "@/api";
import { SidebarNav } from "@/components/Layout";
import { TeamPage } from "@/pages/Team";

// milestones are the owner's big roots, in his order, each with % done, its color and the waiting-on-you count;
// the per-repo milestones fold under "Other milestones" (their waiting count stays visible on the fold).

afterEach(cleanup);
beforeEach(() => localStorage.clear());

let made: Record<string, Milestone> = {};
async function seed() {
  const mk = (title: string, bigRoot?: number) =>
    api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
  made = {
    house: await mk("House decision", 4),
    social: await mk("SocialApp launch", 1),
    memo: await mk("Memo launch", 2),
    hair: await mk("Hair transplant", 3),
    infra: await mk("ops · PLAN-2"),
  };
}

function fakeStatus() {
  const real = api.listStatus.bind(api);
  const prog: Record<string, { pct: number; needs: number; color: "blue" | "grey" | "red" }> = {
    [made.social.id]: { pct: 40, needs: 2, color: "blue" },
    [made.memo.id]: { pct: 60, needs: 0, color: "blue" },
    [made.hair.id]: { pct: 0, needs: 0, color: "grey" },
    [made.house.id]: { pct: 30, needs: 1, color: "red" },
    [made.infra.id]: { pct: 10, needs: 1, color: "blue" },
  };
  return vi.spyOn(api, "listStatus").mockImplementation(async (): Promise<StatusBatch> => {
    const r = await real();
    const tpl = r.milestones[0];
    const milestones = Object.entries(prog).map(([id, p]) => ({
      ...tpl,
      milestoneId: id,
      needsYou: p.needs,
      items: Array.from({ length: p.needs }, (_, k) => ({ id: `${id}:${k}`, kind: "ask" as const, state: "open" as const, milestoneId: id, title: "ask" })),
      progress: { pct: p.pct, done: 1, total: 3, color: p.color },
    }));
    return { ...r, milestones };
  });
}

describe("T40-S3 sidebar: big roots", () => {
  it("lists the big roots first in Sam's order with % and waiting count; others fold with their count", async () => {
    await seed();
    const spy = fakeStatus();
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getAllByTestId("big-root")).toHaveLength(4));
      const roots = screen.getAllByTestId("big-root");
      // the state word now shares the line under the bar with the percent, so read the name's own line
      expect(roots.map((r) => r.querySelector(".line-clamp-2")?.textContent?.trim())).toEqual(["SocialApp launch", "Memo launch", "Hair transplant", "House decision"]);
      // no bar, percent or coloured dot; one word (running, needs you, idle) and the counts.
      await waitFor(() => expect(within(roots[0]).getByTestId("sidebar-needs-you").textContent).toBe("2"));
      expect(within(roots[0]).getByTestId("sidebar-state").textContent).toBe("needs you");
      expect(within(roots[0]).queryByTestId("big-root-pct")).toBeNull();
      expect(within(roots[0]).queryByTestId("tree-dot")).toBeNull();
      expect(within(roots[1]).queryByTestId("sidebar-needs-you")).toBeNull();

      // The per-repo milestone is folded; its waiting count shows on the fold.
      expect(screen.queryByText("ops · PLAN-2")).toBeNull();
      const toggle = screen.getByTestId("other-milestones-toggle");
      expect(toggle.textContent).toMatch(/^Other projects \(3\)/); // the infra repo + the mock seed's two
      expect(within(toggle).getByTestId("other-needs-you").textContent).toBe("1");
      fireEvent.click(toggle);
      expect(screen.getByText("ops · PLAN-2")).toBeTruthy();
      expect(localStorage.getItem("sidebar.otherMilestones.open")).toBe("1");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("T40-S3 Team home: big roots lead", () => {
  it("shows the big roots' progress %, then Other milestones with their Done means", async () => {
    const spy = fakeStatus();
    try {
      render(
        <MemoryRouter>
          <TeamPage section="settings" />
        </MemoryRouter>,
      );
      await screen.findByTestId("other-milestones");
      const progress = await screen.findAllByTestId("card-progress");
      expect(progress).toHaveLength(4);
      expect(progress[0].textContent).toBe("Progress40%");
      const titles = [...document.querySelectorAll("a h3, a [class*='CardTitle'], a .text-base")].map((e) => e.textContent);
      expect(titles.indexOf("SocialApp launch")).toBeLessThan(titles.indexOf("ops · PLAN-2"));
    } finally {
      spy.mockRestore();
    }
  });
});
