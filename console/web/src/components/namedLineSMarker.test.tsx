// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type RedLine } from "@/api";
import { OwnerPriorityTag, RedLineBand } from "@/components/ownerPriority";

// (the owner 2026-11-10 16:00Z: "It's a separate red line, but it's category red line … I want them in my face with
// this kind of red line coloring"): one red band per named line, in order, and each item's red marker names its line.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const memo: RedLine = {
  name: "Memo's first tester",
  sentence: "Get Memo's first real tester signed up and using it every day.",
  state: "agreed",
  ask: "T48-A6",
  at: "2026-11-10T07:10:00Z",
  items: [
    { repo: "memo", ref: "T23-A1" },
    { repo: "memo", ref: "T1" },
    { repo: "memo", ref: "U2" },
  ],
};
const flywheel: RedLine = {
  name: "Data-product flywheel",
  target: "2026-11-30",
  sentence: "By 30 November, two or three data products run on their own.",
  state: "proposed",
  ask: "T48-A8",
  at: "2026-11-10T17:00:00Z",
  items: [
    { repo: "deal-funnels", ref: "PLAN-5-A1" },
    { repo: "airbnb-observatory", ref: "PLAN-5-A3" },
    { repo: "deal-funnels", ref: "T5-S1" },
    { repo: "deal-funnels", ref: "T5-S3" },
  ],
};

describe("T48-S36 a named line's marker", () => {
  it("says which line, in red; a tap opens with the line's name and sentence", () => {
    render(<OwnerPriorityTag p={{ level: "high", why: "The bot sells the data.", ref: "PLAN-5-A1", redLine: { sentence: flywheel.sentence, state: "proposed", name: "Data-product flywheel", line: 1 } }} />);
    const tag = screen.getByTestId("owner-priority");
    expect(tag.textContent).toBe("Red line: Data-product flywheel");
    expect(tag.getAttribute("data-red-line")).toBe("Data-product flywheel");
    expect(tag.className).not.toContain("bg-red-600"); // the red line is a word, no red pill
    fireEvent.click(tag);
    expect(screen.getByTestId("owner-priority-red-line").textContent).toBe(`Red line, Data-product flywheel: ${flywheel.sentence}`);
  });
});

describe("T48-S36 a band per line", () => {
  it("shows every line in order with its name, state and deadline", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: memo, redLines: [memo, flywheel] });
    render(<RedLineBand />);
    await waitFor(() => expect(screen.getAllByTestId("red-line")).toHaveLength(2));
    expect(screen.getAllByTestId("red-line-name").map((e) => e.textContent)).toEqual(["Memo's first tester", "Data-product flywheel"]);
    // one slim row each: the count of items on it and the day; only a proposed line says so on its row.
    expect(screen.getAllByTestId("red-line-count").map((e) => e.textContent)).toEqual(["3", "4"]);
    expect(screen.getByTestId("red-line-target").textContent).toBe("by 30 Nov");
    const rows = screen.getAllByTestId("red-line-row").map((e) => e.textContent ?? "");
    expect(rows[0]).not.toContain("proposed");
    expect(rows[1]).toContain("proposed");
  });
  it("an older server with one `redLine` still shows its band", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: memo });
    render(<RedLineBand />);
    await waitFor(() => expect(screen.getAllByTestId("red-line")).toHaveLength(1));
  });
});
