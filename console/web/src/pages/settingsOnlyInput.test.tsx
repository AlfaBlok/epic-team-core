// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { DashboardPage, SettingsPage } from "@/pages/Settings";

// root L-80 (the owner): Settings is only what he changes. Red lines, the pages where he adds or
// replaces something and the project actions stay; Seats, Hosts, Applications, Voice feedback and the dashboard
// panels (read-only) left it, the panels for the Dashboard page.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const show = () =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );

const dashboard = () =>
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );

describe("Settings is only what he changes", () => {
  it("lists only pages with something to change, no project cards and no switch", async () => {
    await api.createMilestone({ title: "Memo launch", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", bigRoot: 1 });
    show();
    expect(await screen.findByTestId("team-overview-head")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(screen.getByTestId("new-focus")).toBeTruthy();
    expect(screen.queryByTestId("focus-milestones")).toBeNull();
    expect(screen.queryByTestId("milestone-card")).toBeNull();
    expect(screen.queryByTestId("dashboard-panels-switch")).toBeNull();
    for (const id of ["op-seats", "op-hosts", "op-applications", "op-feedback", "op-dashboard"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId("op-secrets")).toBeTruthy();
    expect(screen.getByTestId("op-credits")).toBeTruthy();
  });

  it("the Dashboard page shows the panels, without the red lines", async () => {
    await api.createMilestone({ title: "Memo launch", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", bigRoot: 1 });
    dashboard();
    expect(await screen.findByTestId("focus-milestones")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects and team" })).toBeTruthy();
    expect(screen.queryByTestId("operator-pages")).toBeNull();
  });
});
