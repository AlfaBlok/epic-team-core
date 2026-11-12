// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type MilestoneStatusView, type MilestoneTree, type Run, type TreeNode } from "@/api";
import { MilestoneStrip, StateWord } from "@/components/status";
import { EpicTree, readyIdleCount, TreeCounts } from "@/components/tree";
import { NextWakeList, StampButton } from "@/components/planning";
import { OutcomeBadge } from "@/components/common";

/** Planning / Parked are grey states; Mark ready for delivery; Next wake picks up; self-readied runs. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLANNING: MilestoneStatusView = {
  milestoneId: "ms_1",
  outcome: { word: "not_yet", source: "derived" },
  flow: { word: "planning", reason: "planning: a draft, no wake works it until Sam stamps it ready" },
  items: [],
  needsYou: 0,
  reasons: [],
};

const n = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", flags: [], children, ...over,
});
const TREE: MilestoneTree = {
  milestoneId: "ms_1",
  root: n("root", { kind: "spine", status: "active", color: "blue", runState: "running" }, [
    n("root/R-1", { ready: true }),
    n("root/CHILD", { kind: "spine", status: "draft", runState: "planning", path: "docs/spines/child.md" }, [n("root/CHILD/C-1", { ready: true })]),
    n("root/DEF", { kind: "spine", status: "deferred", runState: "parked", path: "docs/spines/def.md" }),
  ]),
  counts: { grey: 3, blue: 1, yellow: 0, red: 0, green: 0 },
  nonGreen: 4,
  closed: 0,
  flagged: 0,
  planning: 1,
  parked: 1,
  source: "spines",
  warnings: [],
};

describe("Planning / Parked words", () => {
  it("the strip and the sidebar word are grey, never an alarm colour", () => {
    render(
      <MemoryRouter>
        <MilestoneStrip status={PLANNING} />
        <StateWord word="parked" />
      </MemoryRouter>,
    );
    const strip = screen.getByTestId("state-strip");
    expect(strip.dataset.state).toBe("planning");
    expect(strip.textContent).toContain("Planning");
    expect(strip.className).not.toMatch(/orange|amber|red/);
    expect(screen.getAllByTestId("state-word").map((w) => w.textContent)).toEqual(["Parked"]);
  });

  it("tree rows show Planning / Parked, the counts row 'N planning', and only own rows count as ready", () => {
    render(
      <MemoryRouter>
        <EpicTree tree={TREE} actions={(x) => (x.runState === "planning" ? <StampButton milestoneId="ms_1" to="ready" path={x.path} /> : null)} />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId("hold-word").map((w) => w.dataset.state)).toEqual(["planning", "parked"]);
    expect(screen.getByTestId("count-planning").textContent).toContain("1planning");
    expect(screen.getByTestId("count-parked").textContent).toContain("1parked");
    expect(readyIdleCount(TREE.root)).toBe(1); // R-1; C-1 belongs to the child's own tree
    expect(screen.getAllByTestId("stamp-ready")).toHaveLength(1);
  });

  it("TreeCounts hides planning / parked when there are none", () => {
    render(<TreeCounts tree={{ ...TREE, planning: 0, parked: 0 }} />);
    expect(screen.queryByTestId("count-planning")).toBeNull();
  });
});

describe("Mark ready for delivery", () => {
  it("writes through the stamp API (child epic by path) and shows a refusal", async () => {
    const stamp = vi.spyOn(api, "stampMilestone").mockResolvedValueOnce({ to: "ready", path: "docs/spines/child.md" }).mockRejectedValueOnce(new Error("only Sam stamps ready"));
    render(<StampButton milestoneId="ms_1" to="ready" path="docs/spines/child.md" />);
    fireEvent.click(screen.getByTestId("stamp-ready"));
    await vi.waitFor(() => expect(stamp).toHaveBeenCalledWith("ms_1", { to: "ready", path: "docs/spines/child.md" }));
    await vi.waitFor(() => expect((screen.getByTestId("stamp-ready") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("stamp-ready"));
    expect((await screen.findByTestId("stamp-error")).textContent).toBe("Not marked ready: only Sam stamps ready");
  });

  it("Mark ready is the primary filled button; Move back stays secondary (outline)", () => {
    render(<StampButton milestoneId="ms_1" to="ready" />);
    expect(screen.getByTestId("stamp-ready").className).toMatch(/\bbg-primary\b/);
    render(<StampButton milestoneId="ms_1" to="draft" />);
    expect(screen.getByTestId("stamp-draft").className).not.toMatch(/\bbg-primary\b/);
  });

  it("Move back to Planning writes draft", async () => {
    const stamp = vi.spyOn(api, "stampMilestone").mockResolvedValue({ to: "draft", path: "p" });
    render(<StampButton milestoneId="ms_1" to="draft" />);
    expect(screen.getByTestId("stamp-draft").textContent).toContain("Move back to Planning");
    fireEvent.click(screen.getByTestId("stamp-draft"));
    await vi.waitFor(() => expect(stamp).toHaveBeenCalledWith("ms_1", { to: "draft" }));
  });
});

describe("Next wake picks up", () => {
  it("empty: 'Nothing is stamped ready'", async () => {
    vi.spyOn(api, "nextWake").mockResolvedValue({ items: [], at: "2026-10-25T00:00:00Z" });
    render(
      <MemoryRouter>
        <NextWakeList />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("next-wake-empty")).textContent).toBe("Nothing is stamped ready");
  });

  it("lists each ready epic and row with the persona and its wake time, grouped by milestone", async () => {
    const at = "2026-10-25T02:00:00Z";
    vi.spyOn(api, "nextWake").mockResolvedValue({
      items: [
        { milestoneId: "ms_1", milestoneTitle: "EPIC-905", kind: "epic", id: "EPIC-905", title: "Five", nodeKey: "k1", persona: "Delivery Manager", at },
        { milestoneId: "ms_1", milestoneTitle: "EPIC-905", kind: "row", id: "E5-1", title: "First", nodeKey: "k2", persona: "Delivery Manager", at },
      ],
      at,
    });
    render(
      <MemoryRouter>
        <NextWakeList now={Date.parse("2026-10-25T00:00:00Z")} />
      </MemoryRouter>,
    );
    const items = await screen.findAllByTestId("next-wake-item");
    expect(items.map((i) => i.dataset.kind)).toEqual(["epic", "row"]);
    expect(screen.getByTestId("next-wake").textContent).toMatch(/EPIC-905Delivery Manager · next wake in 2 h/);
    // a long slug wraps (it may shrink and break anywhere), so the Team home stays phone-wide.
    for (const id of screen.getAllByTestId("next-wake-id")) {
      expect(id.className).toContain("break-all");
      expect(id.className).not.toContain("shrink-0");
    }
  });
});

describe("self-readied run", () => {
  it("shows an amber self-readied chip beside the outcome", () => {
    const run = { id: "r1", assignmentId: "a1", startedAt: "2026-10-25T00:00:00Z", outcome: "progressed", summary: "x", kind: "wake", selfReadied: ["docs/spines/x.md: Status: ready"] } as Run;
    render(<OutcomeBadge outcome="progressed" run={run} />);
    const chip = screen.getByTestId("self-readied");
    expect(chip.textContent).toBe("self-readied");
    expect(chip.getAttribute("title")).toContain("docs/spines/x.md: Status: ready");
  });
});
