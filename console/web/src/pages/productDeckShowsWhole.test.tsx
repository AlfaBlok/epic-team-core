// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import { ProductPage } from "@/pages/social/Motion";
import { SKINS, SkinProvider } from "@/lib/skin";
import { sampleFeatureList as list, sampleMotionSpines, sampleProduct, withFeatures } from "@/lib/motionSample";
import { computeMotion, parseProduct } from "../../../server/src/social/motionCompute";
import { expandFeatures } from "../../../server/src/social/productFeatures";

// the
// product deck's `Features:` part shows the service's whole feature list, one paper slide per group, every line on it.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const groups = list.groups.filter((g) => g.features.length);
const product = expandFeatures(parseProduct(withFeatures(sampleProduct)), () => list);
beforeEach(() => {
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "w" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "w", campaigns: [] });
  vi.spyOn(api, "getSocialMotion").mockResolvedValue({ tenantId: "w", repo: "pod-campaign", repos: ["pod-campaign"], today: "2026-11-10", product, ...computeMotion({ signups: [], siteViews: [], snapshots: [], posts: [] }, sampleMotionSpines) } as never);
});

describe("T43-S15: the product deck shows the whole feature list", () => {
  it("one slide per group, each with every line of that group and where it comes from", async () => {
    const first = product.slides.findIndex((s) => s.features);
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={[`/product?slide=${first + 1}`]}>
          <Routes>
            <Route path="/product" element={<ProductPage />} />
          </Routes>
        </MemoryRouter>
      </SkinProvider>,
    );
    for (const [k, g] of groups.entries()) {
      const slide = await screen.findByTestId("product-slide");
      await waitFor(() => expect(within(slide).getByTestId("slide-title").textContent).toBe(`Every feature: ${g.title}`));
      const items = within(slide).getAllByTestId("slide-feature");
      expect(items.map((li) => li.textContent)).toEqual(g.features.map((f) => f.title.replace(/\.$/, "") + f.text));
      expect(within(slide).getByTestId("slide-features-count").textContent).toBe(`${g.features.length} ${g.features.length === 1 ? "feature" : "features"}, from the SocialApp feature list`);
      expect(within(slide).getByRole("link", { name: "the SocialApp feature list" }).getAttribute("href")).toBe("https://github.com/Acme/home_repo/blob/main/docs/features/socialapp.json");
      if (k < groups.length - 1) fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${first + k + 2}\\. Every feature`) }));
    }
    expect(screen.getAllByRole("button", { name: /\. Every feature: / })).toHaveLength(groups.length);
  });
});
