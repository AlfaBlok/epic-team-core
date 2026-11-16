// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Me } from "@/api";
import { HomePage } from "@/components/homeView";

// the owner 2026-11-16 ("it should just chat, we should direct to chat ... load with first objective"):
// a paid team workspace's Home is its chat with its first objective on top; other worlds keep their Home.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => forgetWorld());

const me = (tenant: string) => ({ mode: "on", identity: { kind: "user" }, tenant: { id: tenant, name: tenant, skin: "console" }, worlds: [] }) as unknown as Me;
const chat = { available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as any;
const objective = {
  milestoneId: "ms_1",
  goal: "Get going: Dana and the team agree in the chat what to do first",
  starter: true,
  green: 1,
  total: 3,
  results: [
    { id: "E0-1", text: "Dana told the team", green: true },
    { id: "E0-2", text: "written as results", green: false },
    { id: "E0-3", text: "first one green", green: false },
  ],
};
const home = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<HomePage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("Home opens on the chat in a paid team workspace", () => {
  it("shows the workspace's chat with its first objective on one line (1 of 3 green)", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("et-dana"));
    const fo = vi.spyOn(api, "getFirstObjective").mockResolvedValue(objective);
    const desk = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue(chat);
    home();
    await waitFor(() => expect(screen.getByTestId("first-objective")).toBeTruthy());
    expect(fo).toHaveBeenCalledWith("et-dana");
    expect(screen.getByText("Let's get going")).toBeTruthy();
    expect(screen.getByLabelText("1 of 3 results green")).toBeTruthy();
    expect(screen.getByTestId("first-objective").getAttribute("href")).toBe("/milestones/ms_1");
    await waitFor(() => expect(desk).toHaveBeenCalledWith("et-dana", { limit: 20 }));
  });

  it("a workspace with no first objective (unpaid, social skin) keeps its Home", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("et-free"));
    const fo = vi.spyOn(api, "getFirstObjective").mockRejectedValue(new Error("no_first_objective"));
    const desk = vi.spyOn(api, "getWorldDeskChat");
    home();
    await waitFor(() => expect(fo).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByTestId("first-objective")).toBeNull();
    expect(desk).not.toHaveBeenCalled();
  });

  it("our own world never asks", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("home"));
    const fo = vi.spyOn(api, "getFirstObjective");
    home();
    await new Promise((r) => setTimeout(r, 50));
    expect(fo).not.toHaveBeenCalled();
  });
});
