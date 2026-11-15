// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { OneOffsPage, punchline } from "@/components/oneOffs";
import type { OneOffsBody } from "@/api/oneoff-types";

/** The One-offs page opens with its answer and the lifecycle boxes, then each one-off with stage, epic, card, note. */
const BODY: OneOffsBody = {
  spine: "docs/spines/one-offs.md",
  deliveredDays: 7,
  counts: { filed: 0, "in work": 1, stuck: 0, "your card": 1, delivered: 1, parked: 0 },
  oneOffs: [
    { id: "E903-S1", name: "Passport photo", stage: "your card", status: "review", epic: { repo: "app", path: "docs/spines/one-offs.md", code: "EPIC-903", title: "One-offs" }, card: { rel: "docs/cards/E903-S1.md", title: "The slot was booked.", evidenceUrl: "https://example.com/slot" }, date: "2026-11-12" },
    { id: "E938-S10", name: "Glass dispute, two notes", stage: "in work", status: "active", epic: { repo: "app", path: "docs/spines/epic-938.md", code: "EPIC-938", title: "Airbnb acts" }, source: { ref: "Log/2026-11-12.md#^e-5bc524", url: "https://example.com/note" }, next: "worker writes both", date: "2026-11-12" },
    { id: "E903-S3", name: "Fresh errand", stage: "delivered", status: "done", epic: { repo: "app", path: "docs/spines/one-offs.md", code: "EPIC-903" }, date: "2026-11-11" },
  ],
};

describe("one-offs page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("leads with the answer and the five lifecycle boxes, then lists open and delivered one-offs", async () => {
    vi.spyOn(api, "listOneOffs").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <OneOffsPage />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("one-offs-punchline")).textContent).toBe("2 one-offs open: 1 waiting on your card, 1 in work.");
    const steps = screen.getAllByTestId("one-offs-step");
    expect(steps.map((s) => s.dataset.stage)).toEqual(["note", "filed", "in work", "your card", "delivered"]);
    expect(steps.map((s) => s.dataset.count)).toEqual(["", "0", "1", "1", "1"]);
    const open = within(screen.getByTestId("one-offs-list")).getAllByTestId("one-off");
    expect(open.map((o) => o.dataset.row)).toEqual(["E903-S1", "E938-S10"]);
    expect(within(open[0]).getByText("The slot was booked.").getAttribute("href")).toBe("/");
    expect(within(open[1]).getByText("Airbnb acts").getAttribute("href")).toBe("/deck/app/EPIC-938");
    expect(within(open[1]).getByText("Your voice note").getAttribute("href")).toBe("https://example.com/note");
    expect(within(screen.getByTestId("one-offs-delivered")).getAllByTestId("one-off")).toHaveLength(1);
  });

  it("says plainly when nothing is open", () => {
    expect(punchline({ ...BODY, oneOffs: [], counts: { filed: 0, "in work": 0, stuck: 0, "your card": 0, delivered: 0, parked: 0 } })).toBe("No one-off open.");
  });
});
