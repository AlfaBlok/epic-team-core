// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { OnePager, SocialData } from "@/api/types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";
import { planWithoutOnePager } from "@/pages/social/OnePager";

// the plan's `Deck:` line is
// a "Strategy deck" link in the one-pager's header on Brief & directions, a plain link in this tab (L-5).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DECK = "http://vps-a9-1.tail.example:8792/get-testers/deck/index.html";
const PLAN = `Campaign tag: \`PLAN-2\`\nPlatform: Reddit and X\nDeck: ${DECK}\n\n### Key messages\n\n- Apply in two minutes`;
const card = (deck: string | null): CampaignCard => ({
  ...mockCampaignCard(),
  repo: "brand-campaign",
  title: "Get testers",
  milestoneId: "ms-memo",
  campaign: { code: "PLAN-2", name: "Get testers", path: "docs/spines/campaign-get-testers.md", platform: "Reddit and X", period: null, deck },
});
const EMPTY: OnePager = { state: "empty", line: null, fields: {}, draft: null };
const page = (c: CampaignCard) => {
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [c] });
  const social: SocialData = { tenantId: "social", repo: "brand-campaign", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")), campaign: { ...c.campaign!, plan: PLAN, onePager: EMPTY } };
  vi.spyOn(api, "getSocial").mockResolvedValue(social);
  return render(
    <SkinProvider skin={SKINS.console /* the social skin shows the five tabs; the old campaign tabs live on in the console skin */}>
      <MemoryRouter initialEntries={["/milestones/ms-memo?tab=brief"]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );
};

describe("the campaign's strategy deck on Brief & directions", () => {
  it("is a link in the one-pager's header, same tab; the plan below drops the Deck line", async () => {
    page(card(DECK));
    const op = await screen.findByTestId("campaign-onepager");
    const a = within(op).getByTestId("campaign-deck-link") as HTMLAnchorElement;
    expect(a.textContent).toBe("Strategy deck");
    expect(a.getAttribute("href")).toBe(DECK);
    expect(a.getAttribute("target")).toBeNull();
    expect(planWithoutOnePager(PLAN)).not.toMatch(/Deck:/);
    expect(planWithoutOnePager(PLAN)).toMatch(/Platform: Reddit and X/);
  });

  it("no Deck line, no link", async () => {
    page(card(null));
    const op = await screen.findByTestId("campaign-onepager");
    expect(within(op).queryByTestId("campaign-deck-link")).toBeNull();
  });
});
