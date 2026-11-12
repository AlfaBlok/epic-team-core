// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import { loadDrafts } from "@/components/draftsToApprove";
import { CampaignsPage } from "@/pages/Campaigns";
import { ChatPage } from "@/pages/Chat";

// the owner's a social world repo session on the social site asked GET /api/tenants/the home world/campaigns (404 cross_tenant,
// 4x on 2026-11-01) whenever /api/me failed under load: worldId fell back to the home world. A world it does not know is never
// the home world: no call names the home world, the screen shows the error and the next poll retries.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const meDown = () => vi.spyOn(api as Required<typeof api>, "getMe").mockRejectedValue(new Error("The console did not answer in 30 s."));

describe("T48-S7 the social skin never asks acme's campaigns when its world is unknown", () => {
  it("Team home drafts: a failing /api/me makes no campaigns call", async () => {
    meDown();
    const list = vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "acme", campaigns: [] });
    await expect(loadDrafts()).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });

  it("Campaigns page: shows the error, never lists acme", async () => {
    meDown();
    const list = vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "acme", campaigns: [] });
    render(
      <MemoryRouter>
        <CampaignsPage />
      </MemoryRouter>,
    );
    await screen.findByText(/did not answer/);
    expect(list).not.toHaveBeenCalled();
  });

  it("Chat: shows the error, never loads acme's Team desk", async () => {
    meDown();
    const desk = vi.spyOn(api, "getDeskChat");
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/did not answer/);
    await waitFor(() => expect(desk).not.toHaveBeenCalled());
  });

  it("once /api/me names social, campaigns are asked in that world", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "social" } } as never);
    const list = vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [] });
    await loadDrafts();
    expect(list).toHaveBeenCalledWith("social");
  });
});
