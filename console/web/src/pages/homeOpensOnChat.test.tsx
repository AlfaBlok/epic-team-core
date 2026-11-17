// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Me } from "@/api";
import { HomePage } from "@/components/homeView";

// the owner 2026-11-17 (vn_7bc94847: "one objective and several key results ... First objective, get set up, and then key
// results"): a paid team workspace's Home is its one objective, Get set up, with each key result and its light, and its
// chat beside it; other worlds keep their Home.

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
  name: "Get set up",
  green: 2,
  total: 5,
  measuredAt: new Date().toISOString(),
  keyResults: [
    { id: "E0-1", name: "Workspace open", target: "You paid and your workspace opened.", green: true, state: "green" as const, by: "ticked" as const },
    { id: "E0-2", name: "First chat answered", target: "Your team answered your first message in the chat.", green: true, state: "green" as const },
    { id: "E0-3", name: "First project made", target: "A project from what you want done is on your list.", green: false, state: "amber" as const, note: "Tell the chat what you want done first." },
    { id: "E0-4", name: "First teammate woke", target: "A teammate woke up, worked on your project and reported back.", green: false, state: "red" as const, note: "Your teammates start when your workspace's own server is ready." },
    { id: "E0-5", name: "First result turned green", target: "One result of your first project is green.", green: false, state: "amber" as const },
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
  it("shows ONE objective, Get set up, each key result with its light, and the chat beside it", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("et-dana"));
    const fo = vi.spyOn(api, "getFirstObjective").mockResolvedValue(objective);
    const desk = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue(chat);
    home();
    await waitFor(() => expect(screen.getByTestId("get-set-up")).toBeTruthy());
    expect(fo).toHaveBeenCalledWith("et-dana");
    expect(screen.getByTestId("set-objective").textContent).toBe("Get set up");
    expect(screen.getByTestId("set-answer").textContent).toBe("2 of 5 key results are green. Next: first project made.");
    const items = screen.getAllByTestId("kr-item");
    expect(items.map((i) => [i.querySelector('[data-testid="kr-name"]')!.firstChild!.textContent, i.getAttribute("data-state")])).toEqual([
      ["Workspace open", "green"],
      ["First chat answered", "green"],
      ["First project made", "amber"],
      ["First teammate woke", "red"],
      ["First result turned green", "amber"],
    ]);
    expect(screen.getAllByTestId("kr-light")).toHaveLength(5); // each key result its traffic light
    expect(screen.queryByText(/tap a key result/)).toBeNull(); // nothing to open: the chat works them
    expect(await screen.findByText("Chat with your team")).toBeTruthy();
    await waitFor(() => expect(desk).toHaveBeenCalledWith("et-dana", { limit: 20 }));
  });

  // the owner 17 Nov (vn_c149df3a): a new workspace made by an account that already has one has no Get set up, and still shows
  it("an existing account's new workspace shows its name, no Get set up, Add the first objective and the chat", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("et-dana-side"));
    vi.spyOn(api, "getFirstObjective").mockResolvedValue({ firstObjective: false, workspace: "Side project", objectives: [] });
    const desk = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue(chat);
    home();
    await waitFor(() => expect(screen.getByTestId("clean-workspace")).toBeTruthy());
    expect(screen.queryByTestId("get-set-up")).toBeNull();
    expect(screen.queryByText(/Get set up/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Side project" })).toBeTruthy();
    expect(screen.getByTestId("clean-workspace-answer").textContent).toMatch(/no objective yet/);
    expect(screen.getByTestId("clean-workspace-add").textContent).toBe("Add the first objective");
    expect(await screen.findByText("Tell your team what this workspace is for and its first objective.")).toBeTruthy();
    await waitFor(() => expect(desk).toHaveBeenCalledWith("et-dana-side", { limit: 20 }));
  });

  it("its objectives show with their results once added", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("et-dana-side"));
    vi.spyOn(api, "getFirstObjective").mockResolvedValue({ firstObjective: false, workspace: "Side project", objectives: [{ milestoneId: "ms_9", title: "Ship the side project", green: 1, total: 2 }] });
    vi.spyOn(api, "getWorldDeskChat").mockResolvedValue(chat);
    home();
    const list = await screen.findByTestId("clean-workspace-objectives");
    expect(list.textContent).toContain("Ship the side project");
    expect(list.textContent).toContain("1 of 2 green");
    expect(screen.getByTestId("clean-workspace-add").textContent).toBe("Add an objective");
  });

  it("a workspace with no first objective (unpaid, social skin) keeps its Home", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("et-free"));
    const fo = vi.spyOn(api, "getFirstObjective").mockRejectedValue(new Error("no_first_objective"));
    const desk = vi.spyOn(api, "getWorldDeskChat");
    home();
    await waitFor(() => expect(fo).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByTestId("get-set-up")).toBeNull();
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
