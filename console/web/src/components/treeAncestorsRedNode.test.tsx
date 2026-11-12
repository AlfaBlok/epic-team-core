// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MilestoneStatusView, MilestoneTree, TreeNode } from "@/api";
import { EpicTree } from "@/components/tree";
import { MilestoneStrip } from "@/components/status";

// every red dot counted is on screen on load, a collapsed chip counts items like the
// tab, the banner says the number, a row waiting on an ask counted elsewhere is ringed, never a second red dot.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const n = (id: string, color: TreeNode["color"], children: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({
  key: `k/${id}`,
  id,
  kind: "spine",
  title: `title ${id}`,
  status: "draft",
  color,
  children,
  flags: [],
  ...extra,
});

// the memory service: → Foundation → ZAL → (red, 1 item), as painted by the server (ancestors carry rollup red).
const memo = (): MilestoneTree => {
  const epic7 = n("PLAN-7", "red", [n("T0", "grey", [], { kind: "ticket" })], { waiting: 1 });
  const zal = n("ZAL", "blue", [epic7, n("ZAL-2", "grey", [n("ZAL-2a", "red", [], { waiting: 2, kind: "ticket" })], { rollup: "red" })], { rollup: "red" });
  const root = n("PLAN-0", "blue", [n("Foundation", "blue", [zal], { rollup: "red" })], { rollup: "red" });
  return { milestoneId: "ms_z", root, counts: { grey: 2, blue: 3, yellow: 0, red: 3, green: 0 }, nonGreen: 5, closed: 0, flagged: 0, source: "spines", warnings: [] };
};
const visibleRedItems = () =>
  [...document.querySelectorAll('ul[role="tree"] [data-testid="tree-dot"][data-color="red"]')].reduce((a, d) => a + Number(d.getAttribute("data-waiting")), 0);

describe("T13-S13 tree", () => {
  it("ancestors of a red node open on load, even when Sam had folded them: red dots rendered = the counts-row red", () => {
    window.localStorage.setItem("epicTree.open.k/ZAL", "closed");
    window.localStorage.setItem("epicTree.open.k/Foundation", "closed");
    render(<EpicTree tree={memo()} />);
    expect(screen.getByTestId("count-red-value").textContent).toBe("3");
    expect(visibleRedItems()).toBe(3);
    // A node with nothing red below keeps its fold.
    expect(screen.queryByText("T0")).toBeNull();
  });

  it("a collapsed node's chip counts red items (the tab's unit), not red nodes", () => {
    const t = memo();
    for (const x of [t.root, t.root.children[0], t.root.children[0].children[0]]) delete x.rollup;
    t.root.children[0].children[0].children[1].rollup = undefined;
    render(<EpicTree tree={t} />);
    const chip = screen.getByTestId("collapsed-summary");
    expect(chip.querySelector('[data-color="red"]')?.textContent).toBe("3");
  });

  it("T6-S42: a row that waits on an open ask counted elsewhere is ringed and named, never a red dot", () => {
    const t = memo();
    t.root.children[0].children[0].children[0].children[0].waitsOn = ["PLAN-29-A1"];
    window.localStorage.setItem("epicTree.open.k/PLAN-7", "open");
    render(<EpicTree tree={t} />);
    const row = screen.getByText("T0").closest("div")!.parentElement!.parentElement!;
    const dot = row.querySelector('[data-testid="tree-dot"]')!;
    expect(dot.getAttribute("data-color")).toBe("grey");
    expect(dot.getAttribute("data-rollup")).toBe("red");
    expect(screen.getByTestId("waits-on-ask").textContent).toBe("waits on PLAN-29-A1");
    expect(visibleRedItems()).toBe(3);
  });
});

describe("T13-S13 banner", () => {
  it("says the number first: Needs you · 1 · 1 to mark ready", () => {
    const status: MilestoneStatusView = {
      milestoneId: "ms_z",
      outcome: { word: "not_yet", source: "derived" },
      flow: { word: "needs_you", reason: "1 to mark ready" },
      items: [{ id: "wj_1", kind: "mark_ready", state: "open", milestoneId: "ms_z", title: "Mark PLAN-7 ready", ask: "approve" }],
      needsYou: 1,
      reasons: [],
      defects: [{ milestoneId: "ms_z", repo: "memo", code: "T7-A2", path: "docs/PLAN-7-REAL-USER-TEST.md", line: 34, text: "x" }],
    } as MilestoneStatusView;
    render(
      <MemoryRouter>
        <MilestoneStrip status={status} />
      </MemoryRouter>,
    );
    const strip = screen.getByTestId("state-strip");
    expect(strip.getAttribute("data-needs-you")).toBe("1");
    expect(strip.textContent).toContain("Needs you· 1 · 1 to mark ready");
    expect(strip.textContent).not.toMatch(/question|Waits on/);
    expect(screen.getByTestId("defect-line").textContent).toBe("Delivery Manager to fix: docs/PLAN-7-REAL-USER-TEST.md:35 names memo/T7-A2, which is no ask");
  });

  it("T13-S14: a line naming Sam with no ask is a Delivery Manager line in the header, never counted", () => {
    const status: MilestoneStatusView = {
      milestoneId: "ms_a",
      outcome: { word: "not_yet", source: "derived" },
      flow: { word: "queued", reason: "queued" },
      items: [],
      needsYou: 0,
      reasons: [],
      defects: [
        { kind: "free_text", milestoneId: "ms_a", repo: "home_repo", path: "docs/spines/epic-17-console-mobile.md", line: 33, text: "x", note: "names Sam with no ask: write a coded ask or drop the line" },
      ],
    } as MilestoneStatusView;
    render(
      <MemoryRouter>
        <MilestoneStrip status={status} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("state-strip").getAttribute("data-needs-you")).toBe("0");
    const line = screen.getByTestId("defect-line");
    expect(line.getAttribute("data-kind")).toBe("free_text");
    expect(line.textContent).toBe("Delivery Manager to fix: docs/spines/epic-17-console-mobile.md:34 names Sam with no ask: write a coded ask or drop the line");
  });
});
