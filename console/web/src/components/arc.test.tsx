// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Arc } from "@/api";
import { ArcView } from "@/components/arc";

/** a project's arc shows three steps in order, the current one marked "we are here", each linked to its deck. */

afterEach(cleanup);

const arc: Arc = {
  project: "Team",
  spine: "home_repo/docs/spines/root.md",
  aim: "The team works by itself.",
  file: "docs/arcs.md",
  fileStatus: "proposal for the owner to change",
  phases: [
    { place: "now", repo: "home_repo", code: "EPIC-940", line: "First step.", title: "Lanes and radar", status: "active", goal: null, href: "/deck/home_repo/EPIC-940" },
    { place: "next", repo: "home_repo", code: "EPIC-941", line: "Second step.", title: "Radar", status: "draft", goal: null, href: "/deck/home_repo/EPIC-941" },
    { place: "after", repo: "other", code: "EPIC-903", line: "Third step.", title: null, status: null, goal: null, href: null },
  ],
};

describe("ArcView", () => {
  it("shows now, next and after with we are here on the current epic, its line and its deck link", () => {
    render(
      <MemoryRouter>
        <ArcView arc={arc} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Proposed order, yours to change")).toBeTruthy();
    expect(screen.getByText("The team works by itself.")).toBeTruthy();
    const now = screen.getByTestId("arc-now");
    expect(now.textContent).toContain("Now · we are here");
    expect(within(now).getByRole("link", { name: "Lanes and radar" }).getAttribute("href")).toBe("/deck/home_repo/EPIC-940");
    expect(screen.getByTestId("arc-next").textContent).not.toContain("we are here");
    expect(screen.getByTestId("arc-next").textContent).toContain("Second step.");
    // an epic the book does not know shows its code, unlinked
    const after = screen.getByTestId("arc-after");
    expect(within(after).queryByRole("link")).toBeNull();
    expect(after.textContent).toContain("EPIC-903");
  });
  it("says nothing about a proposal once the order is settled", () => {
    render(
      <MemoryRouter>
        <ArcView arc={{ ...arc, fileStatus: "kept by the Delivery Manager" }} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Proposed order, yours to change")).toBeNull();
  });
});
