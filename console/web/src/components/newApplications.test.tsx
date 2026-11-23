// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { TesterSignup } from "@/api/types";
import { SKINS, SkinProvider } from "@/lib/skin";
import { NewApplications } from "./newApplications";

// Team home names the new applications
// and links /testers; the social skin (another world) shows nothing and makes no call.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = (id: string, offer: string, seenAt: string | null): TesterSignup => ({
  id,
  email: `${id}@ex.com`,
  name: "",
  useCase: "",
  plan: "",
  source: "",
  offer,
  createdAt: "2026-11-02T01:00:00Z",
  updatedAt: "2026-11-02T01:00:00Z",
  notified: null,
  seenAt,
});

describe("T46-S4 r2 NewApplications", () => {
  it("says how many applications are new and links the list", async () => {
    vi.spyOn(api, "listTesters").mockResolvedValue({ page: "", newCount: 2, signups: [row("a", "tester-10", null), row("b", "tester-10", null), row("c", "tester-10", "x"), row("w", "waitlist-alpha", "x")] });
    render(<NewApplications />, { wrapper: MemoryRouter });
    expect((await screen.findByTestId("new-applications-count")).textContent).toBe("2 new applications");
    expect(screen.getByText(/3 applications in all, the team's own tests left out/)).toBeTruthy();
    expect(screen.getByTestId("new-applications").querySelector("a")?.getAttribute("href")).toBe("/testers");
  });
  it("counts as the Applications tracker does when the server says so", async () => {
    vi.spyOn(api, "listTesters").mockResolvedValue({ page: "", newCount: 0, counted: 1, signups: [row("a", "tester-10", "x"), row("t", "tester-10", "x")] });
    render(<NewApplications />, { wrapper: MemoryRouter });
    expect(await screen.findByText(/1 application in all/)).toBeTruthy();
  });
  it("with none new it still names the list", async () => {
    vi.spyOn(api, "listTesters").mockResolvedValue({ page: "", newCount: 0, signups: [row("c", "tester-10", "x")] });
    render(<NewApplications />, { wrapper: MemoryRouter });
    expect((await screen.findByTestId("new-applications-count")).textContent).toBe("No new applications");
  });
  it("the social skin shows nothing and never calls the acme route", async () => {
    const spy = vi.spyOn(api, "listTesters");
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <NewApplications />
        </MemoryRouter>
      </SkinProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("new-applications")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
