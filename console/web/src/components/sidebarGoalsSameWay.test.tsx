// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api, type MilestoneStatusView } from "@/api";
import type { ScorecardsBody } from "@/api/pursuit-types";
import { GoalSetPage, SidebarGoalSets } from "@/components/goalSets";
import { SidebarNav } from "@/components/Layout";
import { MilestonePage } from "@/pages/Milestone";
import { SCORECARD_PATH } from "@/lib/scorecards";

/**
 * The owner (Team desk): "Why sidebar element selection work so different when selecting a goal or a
 * 'project'? What's the difference? Everything". His phone showed House decision with a green 1 in the sidebar that
 * opened the old milestone page, where no tab showed that 1. Now every sidebar entry is a goal opened the same way,
 * and a pill counts exactly what its tab shows: the same function, read at the same moment, and a tap on it opens that tab.
 */

const objective = (milestoneId: string): ScorecardsBody => ({
  nodes: [
    {
      id: "launch",
      kind: "pursuit",
      name: "Launch",
      rank: 1,
      milestoneId,
      greens: 0,
      total: 1,
      spines: ["app:docs/e1.md"],
      keyResults: [{ label: "Testers apply", state: "red", value: "0 of 5", kind: "key-result", work: [] }],
      rows: [],
      children: [],
    },
  ],
  spineInfo: { "app:docs/e1.md": { repo: "app", path: "docs/e1.md", code: "EPIC-901", title: "Launch epic", doneMeans: { done: 0, total: 1 }, codes: ["E901-A3"], queue: [] } },
});

const ask = (id: string, milestoneId: string, code: string) => ({ id, kind: "ask", state: "open", milestoneId, title: `Ask ${code}`, code, repo: "app", since: "2026-11-15T10:00:00Z" });
const statusOf = (milestoneId: string, items: ReturnType<typeof ask>[]): MilestoneStatusView =>
  ({ milestoneId, outcome: { word: "not_yet", source: "derived" }, flow: { word: "idle", reason: "" }, items, needsYou: items.length, reasons: [] }) as never;

/** where the router is now (the pill's tap is a navigation, not a new page load). */
function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("every sidebar entry is a goal, opened one way, its pills the ones its Inbox tab shows", () => {
  it("an objective's pills equal its Inbox tab's, and a tap on a pill opens that tab", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue(objective("ms_1"));
    vi.spyOn(api, "listStatus").mockResolvedValue({ milestones: [], items: [ask("a1", "ms_1", "E901-A3")], needsYou: 1, at: "2026-11-15T12:00:00Z" } as never);
    vi.spyOn(api, "listReviewItems").mockResolvedValue([{ id: "rv1", title: "Testers call", ref: "E901-S1", repo: "app", path: "docs/e1.md", state: "review", liveUrl: "https://x", createdAt: "2026-11-15", milestoneId: "ms_1" }] as never);
    vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [] } as never);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarGoalSets />
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
    const entry = (await screen.findAllByTestId("sidebar-set"))[0];
    await waitFor(() => expect(within(entry).getByTestId("sidebar-set-asks").textContent).toBe("1"));
    const side = { ask: within(entry).getByTestId("sidebar-set-asks").textContent, review: within(entry).getByTestId("sidebar-set-review").textContent };
    expect(side).toEqual({ ask: "1", review: "1" });
    // the pill opens the Inbox tab, never the first tab
    expect(within(entry).getByTestId("goal-pills").getAttribute("data-to")).toBe("/sets/launch?tab=inbox");
    fireEvent.click(within(entry).getByTestId("sidebar-set-review"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/sets/launch?tab=inbox"));
    const tab = await screen.findByTestId("set-tab-inbox");
    expect(tab.getAttribute("aria-current")).toBe("page");
    // the same numbers on the tab it opened, in the same colours
    await waitFor(() => expect(within(tab).getByTestId("tab-inbox-asks").textContent).toBe(side.ask));
    expect(within(tab).getByTestId("tab-inbox-review").textContent).toBe(side.review);
    expect(within(tab).getByTestId("tab-inbox-asks").getAttribute("data-tone")).toBe("needs-you");
    expect(within(tab).getByTestId("tab-inbox-review").getAttribute("data-tone")).toBe("review");
    // the tab's two pills are the rows its list draws, red for the asks and green for the rest; read as one text the
    // tab says "11" (a check once read "2" and "3" as 23), so each pill is read by its own id.
    const rows = await within(screen.getByTestId("slim-inbox")).findAllByTestId("slim-inbox-row");
    expect(rows.filter((r) => r.getAttribute("data-kind") === "ask").length).toBe(Number(side.ask));
    expect(rows.filter((r) => r.getAttribute("data-kind") !== "ask").length).toBe(Number(side.review));
  });

  it("a milestone an objective holds is not listed again; one no objective holds is a goal row whose pills equal its Inbox tab's", async () => {
    const held = await api.createMilestone({ title: "Held by Launch", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam", bigRoot: 1 });
    const house = await api.createMilestone({ title: "House decision", repo: "Acme/house_decision", path: "EPIC.md", owner: "Sam", bigRoot: 2 });
    vi.spyOn(api, "listScorecards").mockResolvedValue(objective(held.id));
    const batch = { milestones: [statusOf(house.id, [ask("h1", house.id, "H-A1")]), statusOf(held.id, [])], items: [ask("h1", house.id, "H-A1")], needsYou: 1, at: "2026-11-15T12:00:00Z" };
    vi.spyOn(api, "listStatus").mockResolvedValue(batch as never);
    vi.spyOn(api, "getMilestoneStatus").mockImplementation(async (id: string) => batch.milestones.find((s) => s.milestoneId === id)! as never);
    vi.spyOn(api, "listReviewItems").mockResolvedValue([{ id: "rv-h", title: "Pick the house", ref: "H-S1", repo: "Acme/house_decision", path: "EPIC.md", state: "review", liveUrl: "https://x", createdAt: "2026-11-15", milestoneId: house.id }] as never);
    vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [] } as never);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarNav />
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
    const list = await screen.findByTestId("sidebar-milestones");
    await waitFor(() => expect(within(list).getByText("House decision")).toBeTruthy());
    // the objective's milestone is the objective (listed once, above, with its wheel), never a second entry
    expect(within(list).queryByText("Held by Launch")).toBeNull();
    expect(within(list).getByTestId("sidebar-focus-heading").textContent).toBe("Other goals");
    const row = within(list).getByText("House decision").closest("a")! as HTMLAnchorElement;
    expect(within(row).getByTestId("sidebar-goal-wheel")).toBeTruthy();
    await waitFor(() => expect(within(row).getByTestId("sidebar-needs-you").textContent).toBe("1"));
    const side = { ask: within(row).getByTestId("sidebar-needs-you").textContent, review: within(row).getByTestId("sidebar-review").textContent };
    expect(side).toEqual({ ask: "1", review: "1" });
    // the green 1 of his screenshot opens the Inbox tab that lists it
    fireEvent.click(within(row).getByTestId("sidebar-review"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/milestones/${encodeURIComponent(house.id)}?tab=inbox`));
    const tab = await screen.findByTestId("set-tab-inbox");
    expect(tab.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(within(tab).getByTestId("tab-inbox-asks").textContent).toBe(side.ask));
    expect(within(tab).getByTestId("tab-inbox-review").textContent).toBe(side.review);
    // the same screen as an objective's: the answer box and the objective's tabs
    expect(screen.getByTestId("set-answer-box")).toBeTruthy();
    expect(within(screen.getByTestId("set-tabs")).getAllByRole("link").map((l) => l.textContent?.replace(/\d+$/, ""))).toEqual(["Key results", "Board", "Inbox", "Chat desk", "Context", "Personas", "Pages"]);
    // and the tab lists the card the green pill counted
    expect(await within(screen.getByTestId("goal-inbox")).findByText(/Pick the house/)).toBeTruthy();
  });

  it("a milestone he retired leaves the list; its page still opens by its link", async () => {
    const house = await api.createMilestone({ title: "Travel plans", repo: "Acme/abnb-agent", path: "EPIC.md", owner: "Sam", bigRoot: 1 });
    const bots = await api.createMilestone({ title: "Market bots", repo: "Acme/market-bots", path: "docs/spines/root.md", owner: "Sam", bigRoot: 2 });
    vi.spyOn(api, "listScorecards").mockResolvedValue({ ...objective("ms_none"), retired: [bots.id] });
    vi.spyOn(api, "listStatus").mockResolvedValue({ milestones: [], items: [], needsYou: 0, at: "2026-11-16T05:00:00Z" } as never);
    vi.spyOn(api, "listReviewItems").mockResolvedValue([] as never);
    vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [] } as never);
    render(
      <MemoryRouter initialEntries={[`/milestones/${bots.id}`]}>
        <SidebarNav />
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );
    const list = await screen.findByTestId("sidebar-milestones");
    await waitFor(() => expect(within(list).getByText("Travel plans")).toBeTruthy());
    expect(within(list).queryByText("Market bots")).toBeNull();
    expect(house.id).not.toBe(bots.id);
    // its old link still opens its own page
    expect(await screen.findByTestId("set-answer-box")).toBeTruthy();
  });
});
