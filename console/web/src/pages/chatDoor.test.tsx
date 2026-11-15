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
 * through the door (the owner let into the home world on a customer site, /api/me identity.door) the home world's
 * Chat is its own world desk (/api/tenants/<home>/desk/messages), as a customer's; never the private console's Team desk
 * (/api/desk/messages, the platform's one thread). Without the door the home world keeps its Team desk.
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

describe("the door's Chat is the home world's own desk", () => {
  it("a door session opens the home world's world desk, never the Team desk", async () => {
    const { teamDesk, worldDesk } = await open(true);
    await waitFor(() => expect(worldDesk).toHaveBeenCalled());
    expect(worldDesk.mock.calls[0][0]).toBe(homeWorld());
    expect(teamDesk).not.toHaveBeenCalled();
  });
  it("the private console's owner keeps the Team desk", async () => {
    const { teamDesk, worldDesk } = await open(false);
    await waitFor(() => expect(teamDesk).toHaveBeenCalled());
    expect(worldDesk).not.toHaveBeenCalled();
  });
});
