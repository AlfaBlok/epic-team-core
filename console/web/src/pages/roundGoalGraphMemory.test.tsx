// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { GoalGraphLinks, GoalGraphPage, consolePathOf, landingFileOf, memoryPagePath } from "@/pages/GoalGraph";

const MEMORY = `/${memoryPagePath()}`;

// the goal graph
// reports and his the memory service memory open inside the console, each saying which memory it is, with a way back.

afterEach(cleanup);

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="goal-graph/*" element={<GoalGraphPage />} />
        <Route path={memoryPagePath()} element={<GoalGraphPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("T76-S1 round 3: goal graph and Memo memory inside the console", () => {
  it("maps console pages to repo pages and back", () => {
    expect(landingFileOf("/goal-graph")).toBe("/landing/index.html");
    expect(landingFileOf("/goal-graph/")).toBe("/landing/index.html");
    expect(landingFileOf("/goal-graph/notes/2026-11-07-e-5fc46c")).toBe("/landing/notes/2026-11-07-e-5fc46c.html");
    expect(landingFileOf(MEMORY)).toBe("/landing/memory/index.html");
    expect(landingFileOf("/goal-graph/notes/../x")).toBeUndefined();
    for (const p of ["/goal-graph", "/goal-graph/notes/2026-11-07-e-5fc46c", MEMORY]) expect(consolePathOf(landingFileOf(p)!)).toBe(p);
  });

  // Round 4 (the owner: "I don't understand what this is about"): only the way back stays above the report, no tabs, no deck link.
  it("a note report: back to Team home, all notes and the report in a frame, nothing else", () => {
    at("/goal-graph/notes/2026-11-07-e-5fc46c");
    expect(screen.getByTestId("goal-graph-back").getAttribute("href")).toBe("/");
    expect(screen.getByTestId("goal-graph-all").getAttribute("href")).toBe("/goal-graph");
    expect(screen.queryByTestId("memory-tabs")).toBeNull();
    expect(screen.getByTestId("goal-graph-page").querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByTestId("goal-graph-frame").getAttribute("src")).toBe("/landing/notes/2026-11-07-e-5fc46c.html");
  });

  it("the memory page frames the memory page", () => {
    at(MEMORY);
    expect(screen.queryByTestId("goal-graph-all")).toBeNull();
    expect(screen.getByTestId("goal-graph-frame").getAttribute("src")).toBe("/landing/memory/index.html");
  });

  it("an unknown page says so and links to the notes", () => {
    at("/goal-graph/whatever");
    expect(screen.queryByTestId("goal-graph-frame")).toBeNull();
    expect(screen.getByTestId("goal-graph-missing").textContent).toContain("No such page");
  });

  it("Team home links both, one line each saying which memory it is", () => {
    render(
      <MemoryRouter>
        <GoalGraphLinks />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("home-goal-graph").getAttribute("href")).toBe("/goal-graph");
    expect(screen.getByTestId("home-memory-page").getAttribute("href")).toBe(MEMORY);
    expect(screen.getByTestId("goal-graph-links").textContent).toContain("Where your voice notes went");
    expect(screen.getByTestId("goal-graph-links").textContent).toContain("not by goal");
  });

  it("the memory page's path is the memory service's name (the neutral Memory here)", () => {
    expect(memoryPagePath()).toBe("memory-memory");
  });
});
