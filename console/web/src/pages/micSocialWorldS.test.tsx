// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";
import { mockTotems } from "@/lib/totems";
import { clearNoteState } from "@/voice/useNote";
import { campaignVoiceBase } from "@/voice/AnswerVoice";

// the social world's boxes (a Brief slide's note, the Brief's feedback chat, a Product slide's
// note) record on the campaign's own voice routes, so the mic shows wherever that world has voice; the Team desk's
// /api/voice is the home world's only (another world gets world_scope) and is never asked from these boxes.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  clearNoteState();
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const CARD = { ...mockCampaignCard(), repo: "social", remote: "acme-ai/social", title: "Reddit campaign", milestoneId: "ms-memo" };
let asked: string[] = [];
const voice = (enabled: boolean) => {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      if (url === "/api/voice/state") return new Response(JSON.stringify({ error: { code: "world_scope" } }), { status: 403, headers: { "content-type": "application/json" } });
      const body = url === "/api/milestones/ms-memo/voice/state" ? (enabled ? { enabled: true, monthUsd: 0, limits: { monthCapUsd: 5 } } : { enabled: false, worldOff: true }) : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
};
beforeEach(() => {
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "social", repo: "social", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")) });
  vi.spyOn(api, "getCampaignTotems").mockImplementation(async () => mockTotems());
  vi.spyOn(api, "getMilestoneChat").mockResolvedValue({ available: true, sending: 0, hasEarlier: false, messages: [], working: false } as never);
});
const page = (path: string) =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T78-S15: the mic in the social world's boxes", () => {
  it("the campaign's voice routes", () => {
    expect(campaignVoiceBase("ms_a/b")).toBe("/api/milestones/ms_a%2Fb/voice");
  });

  it("a Brief slide's note box and its full-screen feedback chat show the mic from the campaign's own voice state", async () => {
    voice(true);
    page("/milestones/ms-memo");
    const box = await screen.findByTestId("slide-note");
    expect(await within(box).findByTestId("answer-voice-button")).toBeTruthy();
    fireEvent.click(screen.getByTestId("brief-full"));
    const chat = await screen.findByTestId("feedback-chat");
    expect(await within(chat).findByTestId("note-button")).toBeTruthy();
    expect(asked).toContain("/api/milestones/ms-memo/voice/state");
    expect(asked).not.toContain("/api/voice/state");
  });

  it("a Product slide's note box shows the mic from the campaign's voice state", async () => {
    voice(true);
    page("/milestones/ms-memo?tab=product");
    const box = await screen.findByTestId("product-note");
    expect(await within(box).findByTestId("answer-voice-button")).toBeTruthy();
    expect(asked).not.toContain("/api/voice/state");
  });

  it("a world without voice (its switch off) shows no mic in the boxes; typing and Send still work", async () => {
    voice(false);
    page("/milestones/ms-memo");
    const box = await screen.findByTestId("slide-note");
    await waitFor(() => expect(asked).toContain("/api/milestones/ms-memo/voice/state"));
    expect(within(box).queryByTestId("answer-voice-button")).toBeNull();
    expect(within(box).getByTestId("slide-note-send")).toBeTruthy();
  });
});
