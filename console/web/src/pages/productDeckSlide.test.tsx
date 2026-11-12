// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { ProductPage } from "@/pages/social/Motion";
import { OnePagerPanel } from "@/pages/social/OnePager";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";
import { mockTotems } from "@/lib/totems";
import { sampleCampaignProduct, sampleMotionSpines, sampleProduct } from "@/lib/motionSample";
import { screenUrl, slideBlocks, statValue } from "@/lib/productSlide";
import { CAMPAIGN_PRODUCT_PARTS, computeMotion, parseProduct } from "../../../../../hosted/console/server/src/social/motionCompute";

// the campaign's
// Product tab is its one deck, drawn to persuade: a claim, big live numbers, real screens; the one-pager points to it.

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

const CARD = {
  ...mockCampaignCard(),
  repo: "brand-campaign",
  remote: "Acme/brand-campaign",
  title: "Get testers",
  milestoneId: "ms-memo",
  campaign: { code: "PLAN-1", name: "Get testers", path: "docs/spines/campaign-get-testers.md", platform: "Reddit and X", period: null },
};
const motion = (campaign?: string) => {
  const m = computeMotion({ signups: [], siteViews: [], snapshots: [], posts: [] }, sampleMotionSpines);
  return {
    tenantId: "w",
    repo: "brand-campaign",
    repos: ["brand-campaign"],
    today: "2026-11-08",
    product: parseProduct(sampleProduct),
    ...(campaign ? { campaignProduct: { code: "PLAN-1", name: "Get testers", spine: "docs/spines/campaign-get-testers.md", ...parseProduct(sampleCampaignProduct, "docs/campaigns/epic-1/product.md", CAMPAIGN_PRODUCT_PARTS) } } : {}),
    ...m,
  };
};
let asked: (string | undefined)[] = [];
beforeEach(() => {
  asked = [];
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "w" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "w", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "w", repo: "brand-campaign", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")) });
  vi.spyOn(api, "getCampaignTotems").mockImplementation(async () => mockTotems());
  vi.spyOn(api, "getSocialMotion").mockImplementation(async (_t: string, _r?: string, campaign?: string) => (asked.push(campaign), motion(campaign) as never));
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
const page = (path: string) =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/milestones/:id" element={<><MilestonePage /><Where /></>} />
          <Route path="/product" element={<><ProductPage /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T78-S6: a product deck slide", () => {
  it("splits a claim, runs of Stat and Screen lines and the rest, in order", () => {
    const b = slideBlocks("Five builders, free.\n\nStat: live:target | applications\nStat: 5 | seats\n\n- one\n- two\n\nScreen: data/assets/a.png | The page\nScreen: data/assets/b.png | The post");
    expect(b.lead).toBe("Five builders, free.");
    expect(b.blocks.map((x) => x.kind)).toEqual(["stats", "md", "screens"]);
    expect(b.blocks[0]).toEqual({ kind: "stats", items: [{ value: "live:target", label: "applications" }, { value: "5", label: "seats" }] });
    expect(b.blocks[2]).toEqual({ kind: "screens", items: [{ src: "data/assets/a.png", caption: "The page" }, { src: "data/assets/b.png", caption: "The post" }] });
    expect(slideBlocks("- a list first\n- b").lead).toBeNull();
  });

  it("reads live numbers and serves only repo assets or https images", () => {
    const catalog = [{ id: "posts_out", now: 3, source: "x" }, { id: "backlinks", now: null, source: null }];
    expect(statValue("live:target", { target: 1234, catalog })).toBe("1,234");
    expect(statValue("live:posts_out", { catalog })).toBe("3");
    expect(statValue("live:backlinks", { catalog })).toBe("–");
    expect(statValue("4 weeks", { catalog })).toBe("4 weeks");
    expect(screenUrl("data/assets/A-36-testers-page.png", "w", "brand-campaign")).toBe("/api/tenants/w/social/file?repo=brand-campaign&path=data%2Fassets%2FA-36-testers-page.png");
    expect(screenUrl("https://epicspine.dev/x.png", "w", null)).toBe("https://epicspine.dev/x.png");
    expect(screenUrl("data/assets/../secret.png", "w", "r")).toBeNull();
    expect(screenUrl("docs/x.png", "w", "r")).toBeNull();
    expect(screenUrl("http://plain.example/x.png", "w", "r")).toBeNull();
  });
});

describe("T78-S6: the campaign's one deck on its Product tab", () => {
  it("draws the claim large, the target's live number and real screens", async () => {
    page("/milestones/ms-memo?tab=product");
    const slide = await screen.findByTestId("product-slide");
    expect(within(slide).getByTestId("slide-lead").textContent).toBe("Five builders run SocialApp on their own Reddit and X this November, for free.");
    const stats = within(slide).getAllByTestId("slide-stat").map((s) => s.textContent);
    expect(stats[1]).toBe("5free tester seats");
    expect(stats[0]).toMatch(/^(\d+|–)applications so far, of 10 by 17 Nov$/);
    const index = screen.getByTestId("product-index");
    expect(within(index).getAllByRole("button").map((b) => b.textContent)).toEqual(CAMPAIGN_PRODUCT_PARTS.map((p, k) => `${k + 1}. ${p}`));
    expect(screen.queryByTestId("product-gaps")).toBeNull();
    fireEvent.click(within(index).getByRole("button", { name: "5. Proof" }));
    const img = (await screen.findByTestId("slide-screen")).querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/tenants/w/social/file?repo=brand-campaign&path=data%2Fassets%2FA-36-testers-page.png");
    expect(img.getAttribute("alt")).toBe("The testers page");
  });

  it("a folded one-pager is one line pointing to the Product tab, with no form", async () => {
    const data = sampleSocialExport(new Date("2026-11-03T10:00:00Z"));
    vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "w", repo: "brand-campaign", data, campaign: { ...CARD.campaign, deck: null, onePager: { state: "empty", line: null, fields: {}, draft: null, moved: true } } } as never);
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <OnePagerPanel card={CARD as never} milestoneId="ms-memo" />
        </MemoryRouter>
      </SkinProvider>,
    );
    const moved = await screen.findByTestId("onepager-moved");
    expect(moved.textContent).toBe("This campaign's one-pager moved into its one deck: open the Product tab.");
    expect(within(moved).getByRole("link").getAttribute("href")).toBe("/milestones/ms-memo?tab=product");
    expect(screen.queryByTestId("onepager-save")).toBeNull();
  });
});
