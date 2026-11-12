// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { MotionBody } from "@/api/types";
import { SKINS, SkinProvider } from "@/lib/skin";
import { sampleMotionSpines, sampleProduct } from "@/lib/motionSample";
import { computeMotion, metricDef, parseProduct } from "../../../../server/src/social/motionCompute";
import { AppRoutes } from "@/App";
import { CatalogView, PersonaDeck, ProductView, TargetsView } from "./Motion";

// the product deck page, each campaign's target, the metrics catalog, and one slide per role.

const body = (): MotionBody => ({
  tenantId: "acme",
  repo: "brand-campaign",
  repos: ["brand-campaign"],
  today: "2026-11-08",
  product: parseProduct(sampleProduct),
  ...computeMotion(
    {
      signups: [{ createdAt: "2026-11-06T10:00:00Z", offer: "tester-10" }],
      siteViews: [{ day: "2026-11-08", page: "/testers/", n: 9 }],
      snapshots: [],
      posts: [],
    },
    sampleMotionSpines,
  ),
});
const show = (el: JSX.Element, path = "/") =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>
    </SkinProvider>,
  );
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("T78-S1 product deck", () => {
  it("one slide per part, paged with Next and the index, n / N on the slide", () => {
    show(<ProductView m={body()} />);
    expect(screen.getByTestId("slide-title").textContent).toBe("Why it exists");
    expect(screen.getByTestId("slide-count").textContent).toBe("1 / 8");
    fireEvent.click(screen.getByTestId("deck-next"));
    expect(screen.getByTestId("slide-title").textContent).toBe("Who it is for");
    fireEvent.click(within(screen.getByTestId("product-index")).getByText(/How much it costs/));
    expect(screen.getByTestId("product-slide").textContent).toContain("€99 a month, planned");
    expect(screen.queryByTestId("product-gaps")).toBeNull();
  });

  it("says where the deck goes when the project has none", () => {
    show(<ProductView m={{ ...body(), product: parseProduct(null) }} />);
    expect(screen.getByTestId("product-missing").textContent).toContain("data/product.md");
  });

  it("is a page of its own, next to Performance in the menu", async () => {
    vi.spyOn(api, "getSocialMotion").mockResolvedValue(body());
    show(<AppRoutes />, "/product");
    expect(await screen.findByTestId("product-deck")).toBeTruthy();
    // targets, who moves what and the catalog sit under the deck on this page.
    const deck = screen.getByTestId("product-deck");
    const motion = await screen.findByTestId("motion");
    expect(deck.compareDocumentPosition(motion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(motion).getByTestId("targets")).toBeTruthy();
  });
});

describe("T78-S1 targets, catalog, who moves what", () => {
  it("each campaign's number of its target, a proposed one marked", () => {
    show(<TargetsView targets={body().targets} />);
    const t = screen.getAllByTestId("target");
    expect(t).toHaveLength(2);
    expect(t[0].textContent).toContain("proposed, you set it");
    expect(t[0].textContent).toContain(`of 500 ${metricDef("site_visitors")!.label.toLowerCase()} by 23 Nov`); // the catalog's words: the neutral site in the open core, ours with the hosted layer
    expect(within(t[1]).getByTestId("target-now").textContent).toBe("1");
    expect(t[1].textContent).toContain("of 10 tester applications by 17 Nov");
  });

  it("the catalog says No source yet where there is none", () => {
    // gave backlinks a source; a world that turns one off (source none) still reads "No source yet".
    const catalog = body().catalog.map((c) => (c.id === "customers" ? { ...c, source: null, now: null } : c));
    show(<CatalogView catalog={catalog} />);
    const rows = screen.getAllByTestId("catalog-row").map((r) => r.textContent ?? "");
    expect(rows.find((r) => r.includes("Backlinks"))).toContain("Source: the sites our visitors came from");
    expect(rows.find((r) => r.includes("Customers"))).toContain("No source yet");
    expect(rows.find((r) => r.includes("Site visitors"))).toContain("9");
  });

  it("one slide per role: the number it moves and the files it reads", () => {
    show(<PersonaDeck personas={body().personas} />);
    expect(screen.getByTestId("slide-title").textContent).toBe("Scout");
    fireEvent.click(screen.getByTestId("deck-next"));
    expect(screen.getByTestId("slide-title").textContent).toBe("Writer");
    const files = within(screen.getByTestId("persona-files")).getAllByRole("listitem").map((l) => l.textContent);
    expect(files[0]).toContain("data/product.md");
    expect(files.join(" ")).toContain("data/ideas.md");
    expect(screen.getByTestId("persona-slide").textContent).toContain("of 10 tester applications");
  });
});
