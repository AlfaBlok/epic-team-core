// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat, type Me } from "@/api";
import { ChatPage } from "@/pages/Chat";
import { forgetWorld } from "@/lib/useSocial";
import { homeWorld } from "@/lib/identity";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/**
 * through the door (the owner let into the home world on a customer site, /api/me identity.door) the home
 * world's Chat is his Team desk with its history (/api/desk/messages, answered to the owner's door only, routeScope.ts
 * DOOR_HOME), the same as on the private console; never an empty world desk. Another world keeps its own world desk.
 */
const chat = { available: true, messages: [] } as unknown as DeskChat;
const me = (door: boolean) =>
  ({ mode: "on", identity: { kind: "session", tenantId: homeWorld(), email: "sam@example.com", name: "Sam", role: "member", ...(door ? { door: true } : {}) }, tenant: { id: homeWorld(), name: "Home" }, worlds: [] }) as unknown as Me;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetWorld();
});

async function open(door: boolean) {
  forgetWorld();
  vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me(door));
  const teamDesk = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat);
  const worldDesk = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue(chat);
  vi.spyOn(api, "markChatSeen").mockResolvedValue({} as never);
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { teamDesk, worldDesk };
}

describe("the door's Chat is his Team desk", () => {
  it("a door session opens his Team desk with its history, never the empty world desk", async () => {
    const { teamDesk, worldDesk } = await open(true);
    await waitFor(() => expect(teamDesk).toHaveBeenCalled());
    expect(worldDesk).not.toHaveBeenCalled();
  });
  it("the private console's owner keeps the Team desk", async () => {
    const { teamDesk, worldDesk } = await open(false);
    await waitFor(() => expect(teamDesk).toHaveBeenCalled());
    expect(worldDesk).not.toHaveBeenCalled();
  });
});
