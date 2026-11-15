// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { ProductView, PursuitKitBody } from "@/api/pursuit-types";
import { ProductPage, ProductsPage } from "@/components/products";
import { SocialKitView } from "@/components/socialKit";

/** each product defined once; its objectives name it and its kit is read from it. */
const LIVE: ProductView = {
  id: "live",
  name: "Live",
  url: "https://live.example",
  tagline: "Agents that post for you",
  accent: "#7c3bed",
  deck: {
    repo: "live-campaign",
    path: "data/product.md",
    title: "Live: the product deck",
    parts: [
      { part: "Why it exists", label: "The problem it solves", body: "Posting every day takes hours." },
      { part: "Who it is for", label: "Who it is for", body: "- Founders" },
      { part: "How it works", label: "How it works", body: "1. **An idea.**\n2. **Posted.**\n\nEvery step is a file." },
      { part: "What it does for you", label: "What it does for you", body: "- **You show up every day.**", from: "brief.md#benefits" },
    ],
    missing: [],
  },
  kit: true,
  wheels: [
    { id: "live-testers", name: "Testers file name", state: "red", greens: 1, total: 6, rank: 2 },
    { id: "live-channels", name: "Channels", state: "amber", greens: 8, total: 12, rank: 6 },
  ],
};
const KIT: PursuitKitBody = { product: { id: "live", name: "Live" }, kit: { id: "live", name: "Live", tagline: "Agents that post for you" } };

describe("products", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the list shows each defined product and how many objectives use it", async () => {
    vi.spyOn(api, "listProducts").mockResolvedValue({ products: [LIVE] });
    render(
      <MemoryRouter>
        <ProductsPage />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("product-row");
    expect(row.getAttribute("href")).toBe("/products/live");
    expect(row.textContent).toContain("2 objectives");
  });

  it("a product's page opens on its four parts and the objectives on it, by the sidebar's names", async () => {
    vi.spyOn(api, "getProduct").mockResolvedValue(LIVE);
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [{ id: "live-testers", kind: "pursuit", name: "5 testers using Live", rank: 2, greens: 1, total: 6, state: "red", spines: [], children: [], rows: [] }] } as never);
    render(
      <MemoryRouter initialEntries={["/products/live"]}>
        <Routes>
          <Route path="/products/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const parts = await screen.findAllByTestId("product-part");
    expect(parts.map((p) => p.querySelector("h2")?.textContent)).toEqual(["The problem it solves", "Who it is for", "How it works", "What it does for you"]);
    // a sequence reads as boxes in one line, the words after it
    expect(screen.getAllByTestId("product-step").map((x) => x.textContent)).toEqual(["1An idea.", "2Posted."]);
    expect(screen.getByTestId("product-steps").parentElement?.textContent).toContain("Every step is a file.");
    expect(screen.getByTestId("product-line").textContent).toBe("Agents that post for you. 2 objectives use it.");
    await waitFor(() => expect(screen.getAllByTestId("product-wheel")[0].textContent).toContain("5 testers using Live"));
    expect(screen.getAllByTestId("product-wheel")[1].getAttribute("href")).toBe("/sets/live-channels");
    expect(screen.getByTestId("set-tab-kit")).toBeTruthy();
    expect(screen.getByTestId("product-source").textContent).toContain("live-campaign data/product.md and brief.md#benefits");
  });

  it("the Social kit tab reads the product's kit, its pictures from the product", async () => {
    vi.spyOn(api, "getProduct").mockResolvedValue(LIVE);
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [] } as never);
    const kit = vi.spyOn(api, "getProductKit").mockResolvedValue(KIT);
    render(
      <MemoryRouter initialEntries={["/products/live?tab=kit"]}>
        <Routes>
          <Route path="/products/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const k = await screen.findByTestId("social-kit");
    expect(kit).toHaveBeenCalledWith("live");
    const img = k.querySelector("img");
    if (img) expect(img.getAttribute("src")).toMatch(/^\/api\/products\/live\/kit\/previews\//);
  });

  it("an objective's Social kit tab says whose kit it is and links to the product", async () => {
    vi.spyOn(api, "getPursuitKit").mockResolvedValue({ ...KIT, pursuit: { id: "live-testers", name: "Testers" } });
    render(
      <MemoryRouter>
        <SocialKitView id="live-testers" />
      </MemoryRouter>,
    );
    const line = await screen.findByTestId("kit-of-product");
    expect(within(line).getByRole("link").getAttribute("href")).toBe("/products/live");
  });
});
