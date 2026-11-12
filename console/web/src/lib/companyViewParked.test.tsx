// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { CompanyGate } from "@/lib/companyView";

/**
 * the Company view's pages render only when /api/me says companyView (CONSOLE_COMPANY_VIEW=1 on the server).
 */
const me = (companyView?: boolean) => ({ mode: "off", identity: { kind: "legacy", tenantId: "home" }, tenant: null, worlds: [], ...(companyView ? { companyView } : {}) }) as never;
const page = () =>
  render(
    <MemoryRouter>
      <CompanyGate>
        <p data-testid="company-page">the Company view</p>
      </CompanyGate>
    </MemoryRouter>,
  );

describe("the Company view is parked", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("off by default: one plain line and the way home, never the page", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me());
    page();
    expect((await screen.findByTestId("company-view-off")).textContent).toContain("The Company view is parked");
    expect(screen.queryByTestId("company-page")).toBeNull();
    expect(screen.getByText("Back to the Team home").getAttribute("href")).toBe("/");
  });

  it("a failed /api/me keeps it parked", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockRejectedValue(new Error("down"));
    page();
    expect(await screen.findByTestId("company-view-off")).toBeTruthy();
  });

  it("on: the page renders", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me(true));
    page();
    expect(await screen.findByTestId("company-page")).toBeTruthy();
    expect(screen.queryByTestId("company-view-off")).toBeNull();
  });
});
