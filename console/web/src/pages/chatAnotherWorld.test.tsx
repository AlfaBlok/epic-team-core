// @vitest-environment jsdom
import { forgetWorld as forgetWorldE33 } from "@/lib/useSocial";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Me, type Milestone } from "@/api";
import { ChatPage } from "@/pages/Chat";
import { TeamPage } from "@/pages/Team";
import { SKINS, SkinProvider } from "@/lib/skin";

// the social skin in a world other than the home world never calls the platform's routes (403 world_scope under auth on):
// Chat is the world's own team desk (was a campaign's desk) instead of the home world's Team desk; Team's Add opens the campaign wizard, never bootstrap.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const me = (tenant: string) => ({ mode: "shadow", identity: { kind: "none" }, tenant: { id: tenant, name: tenant, skin: "social" }, worlds: [] }) as unknown as Me;
const ms = (id: string, title: string) => ({ id, title, repo: "social", path: "docs/spines/root.md", owner: "Sam", paused: false }) as unknown as Milestone;

// each test is its own tab (a tab remembers its world)
beforeEach(() => forgetWorldE33());

describe("Chat in another world", () => {
  it("social: the world's own team desk (T58-S4: no campaign picker, its own thread and Call), never the Team desk or one campaign's chat", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("social"));
    vi.spyOn(api, "listMilestones").mockResolvedValue([ms("ms_z1", "Make Memo heard"), ms("ms_z2", "Second campaign")]);
    const world = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as any);
    const campaign = vi.spyOn(api, "getMilestoneChat");
    const desk = vi.spyOn(api, "getDeskChat");
    render(
      <MemoryRouter initialEntries={["/chat?campaign=ms_z2"]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(world).toHaveBeenCalledWith("social", { limit: 30 }));
    expect(screen.queryByTestId("desk-campaign")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Campaign" })).toBeNull();
    expect(campaign).not.toHaveBeenCalled();
    expect(desk).not.toHaveBeenCalled();
  });

  it("home: the Team desk as before", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me("home"));
    const desk = vi.spyOn(api, "getDeskChat").mockResolvedValue({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as any);
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(desk).toHaveBeenCalled());
    expect(screen.queryByTestId("world-chats")).toBeNull();
  });
});

describe("Team's Add in the social skin", () => {
  it("T58-S3: New campaign opens the campaign wizard; Add job opens the milestone dialog named for a job", async () => {
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<TeamPage />} />
            <Route path="/campaigns/new" element={<div data-testid="wizard" />} />
          </Routes>
        </MemoryRouter>
      </SkinProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add job" }));
    expect(await screen.findByRole("heading", { name: "Add job" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "New campaign" }));
    expect(await screen.findByTestId("wizard")).toBeTruthy();
  });
});
