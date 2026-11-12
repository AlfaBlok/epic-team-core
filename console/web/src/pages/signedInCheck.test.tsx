// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type SignedInCheck } from "@/api";
import { BrowserAuthPage } from "@/pages/BrowserAuth";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = new Date(Date.now() - 20 * 60_000).toISOString();
const row = (o: Partial<SignedInCheck> & Pick<SignedInCheck, "site" | "state">): SignedInCheck => ({ detail: "", fix: "none", checkedAt: at, since: at, ...o });
const FIX = "Sign in to x.com as @MemoAgent in Chrome (example.com profile), then on the console's Browser auth page press Sync for *.x.com and run the command it gives you on your Mac.";

describe("T86-S2 the hourly signed-in check on Browser auth", () => {
  it("shows each site's state, since when, the fix step for a lost or missing session, and that the ask is in the inbox", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    vi.spyOn(api, "listEgress").mockResolvedValue([]);
    vi.spyOn(api, "listSignedInCheck").mockResolvedValue([
      row({ site: "reddit", state: "signed_in", detail: "as u/jordimr", pattern: "*.reddit.com" }),
      row({ site: "x", state: "signed_out", detail: "landed on /login", fix: FIX, pattern: "*.x.com", ask: { code: "PLAN-86-A2", path: "docs/spines/red.md", raisedAt: at } }),
      row({ site: "instagram", state: "not_synced", fix: "Sign in to instagram.com with the team's account in Chrome, then press Sync." }),
      row({ site: "youtube", state: "by_api" }),
    ]);
    render(
      <MemoryRouter>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("signed-in-check");
    expect(box.textContent).toMatch(/checked every hour/);
    const x = within(screen.getByTestId("check-x"));
    expect(x.getByText("signed out")).toBeTruthy();
    expect(x.getByText("in your inbox")).toBeTruthy();
    expect(x.getByText(FIX)).toBeTruthy();
    const reddit = within(screen.getByTestId("check-reddit"));
    expect(reddit.getByText("signed in")).toBeTruthy();
    expect(screen.getByTestId("check-reddit").textContent).not.toMatch(/Sync/);
    expect(within(screen.getByTestId("check-instagram")).getByText("not synced")).toBeTruthy();
    expect(screen.getByTestId("check-instagram").textContent).toMatch(/Sign in to instagram\.com/);
    expect(within(screen.getByTestId("check-youtube")).getByText("by its API")).toBeTruthy();
  });

  it("shows nothing when the browser keeps no check", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    vi.spyOn(api, "listEgress").mockResolvedValue([]);
    vi.spyOn(api, "listSignedInCheck").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    await screen.findByText(/No synced sites yet/);
    expect(screen.queryByTestId("signed-in-check")).toBeNull();
  });
});
