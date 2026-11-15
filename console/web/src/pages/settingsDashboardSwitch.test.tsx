// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { SettingsPage } from "@/pages/Settings";
import { DASHBOARD_PANELS_KEY } from "@/lib/dashboardPanels";

// Settings keeps red lines, the operator pages and the project actions; the dashboard panels he does not use
// (project cards, personas and the rest) sit behind one switch, off by default, that brings them back.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const show = () =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );

describe("Settings without the dashboard panels", () => {
  it("hides the project cards by default and keeps the project actions", async () => {
    await api.createMilestone({ title: "Memo launch", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", bigRoot: 1 });
    show();
    expect(await screen.findByTestId("team-overview-head")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(screen.getByTestId("new-focus")).toBeTruthy();
    expect(screen.queryByTestId("focus-milestones")).toBeNull();
    expect(screen.queryByTestId("milestone-card")).toBeNull();
    const box = screen.getByTestId("dashboard-panels-switch").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it("the switch brings them back and is remembered", async () => {
    await api.createMilestone({ title: "Memo launch", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", bigRoot: 1 });
    show();
    fireEvent.click(screen.getByTestId("dashboard-panels-switch").querySelector("input")!);
    expect(await screen.findByTestId("focus-milestones")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects and team" })).toBeTruthy();
    expect(localStorage.getItem(DASHBOARD_PANELS_KEY)).toBe("on");
    cleanup();
    show();
    expect(await screen.findByTestId("focus-milestones")).toBeTruthy();
  });
});
