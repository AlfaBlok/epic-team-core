// @vitest-environment jsdom
/**
 * One objective, one screen (the owner, vn_748ec5a1): "It's like we have two contexts, like two dashboards
 * for one objective ... I never approved that." An objective's milestone link opens the objective's own screen, on the tab
 * that does the old tab's job; a campaign and a milestone no objective holds keep their page (never a 404).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode } from "@/api/pursuit-types";
import { MilestonePage, objectiveOf } from "@/pages/Milestone";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const node = (id: string, milestoneId?: string, children: ScorecardNode[] = []): ScorecardNode =>
  ({ id, kind: "pursuit", name: id, greens: 0, total: 0, spines: [], rows: [], children, ...(milestoneId ? { milestoneId } : {}) }) as unknown as ScorecardNode;

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

describe("one objective, one screen", () => {
  it("finds the first objective in his order that holds a milestone, nested ones too", () => {
    const nodes = [node("first", "ms_z"), node("browser", "ms_a"), node("social", "ms_a"), node("house", undefined, [node("house~epic", "ms_h")])];
    expect(objectiveOf(nodes, "ms_a")?.id).toBe("browser");
    expect(objectiveOf(nodes, "ms_h")?.id).toBe("house~epic");
    expect(objectiveOf(nodes, "ms_none")).toBeUndefined();
  });

  it("an old milestone link with Switch personas opens the objective's Personas tab", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [node("launch", "ms_z")] } as never);
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ campaigns: [] } as never);
    render(
      <MemoryRouter initialEntries={["/milestones/ms_z?tab=personas"]}>
        <Routes>
          <Route path="milestones/:id" element={<MilestonePage />} />
          <Route path="sets/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("where")).textContent).toBe("/sets/launch?tab=personas");
  });

  it("a bare milestone link opens the objective on its summary's job, the key results", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [node("launch", "ms_z")] } as never);
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ campaigns: [] } as never);
    render(
      <MemoryRouter initialEntries={["/milestones/ms_z"]}>
        <Routes>
          <Route path="milestones/:id" element={<MilestonePage />} />
          <Route path="sets/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("where")).textContent).toBe("/sets/launch?tab=summary");
  });
});
