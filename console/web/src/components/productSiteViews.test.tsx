// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { api } from "@/api";
import type { SiteCount } from "@/api/types";
import { ProductSiteViews } from "@/components/products";

/** a product's page shows its website's views per day, yesterday first, the same counts as Every site. */
const site = (host: string, name: string, vals: [string, number][]): SiteCount => ({
  host,
  label: host,
  what: name,
  name,
  url: `https://${host}/`,
  note: "",
  visits: vals.map(([date, value]) => ({ date, value })),
  signups: [],
  testVisitsToday: 0,
  testSignupsToday: 0,
  source: "",
});

describe("website views on a product's page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows yesterday's views and the last 7 days of its own site only", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "acme" } } as never);
    vi.spyOn(api, "getSiteKpis").mockResolvedValue({
      tenantId: "acme",
      shown: true,
      today: "2026-11-26",
      series: [],
      sites: [
        site("beta.example.com", "Beta", [["2026-11-19", 5], ["2026-11-24", 16], ["2026-11-25", 19], ["2026-11-26", 6]]),
        site("gamma.example.com", "Gamma", [["2026-11-25", 16]]),
      ],
    } as never);
    render(<ProductSiteViews name="Beta" />);
    const box = await screen.findByTestId("product-site");
    expect(box.getAttribute("data-site")).toBe("beta.example.com");
    expect(within(box).getByTestId("product-site-yesterday").textContent).toBe("19 views");
    expect(box.textContent).toContain("40 in the last 7 days");
    const days = within(box).getAllByTestId("product-site-day");
    expect(days.map((d) => d.getAttribute("data-day"))).toEqual(["2026-11-26", "2026-11-25", "2026-11-24", "2026-11-23", "2026-11-22", "2026-11-21", "2026-11-20", "2026-11-19"]);
    expect(days[0].textContent).toContain("Today so far");
    expect(screen.queryByText(/gamma\.example\.com/)).toBeNull();
  });

  it("shows nothing for a product with no counted site", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "acme" } } as never);
    vi.spyOn(api, "getSiteKpis").mockResolvedValue({ tenantId: "acme", shown: true, today: "2026-11-26", series: [], sites: [] } as never);
    const { container } = render(<ProductSiteViews name="Delta" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});
