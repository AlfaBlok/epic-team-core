// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type AuthSite } from "@/api";
import { BrowserAuthPage } from "@/pages/BrowserAuth";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** he rejected the Mac sync, the team signs in itself: none of its words or buttons are on the page. */
function expectNoMacSync() {
  const text = document.body.textContent ?? "";
  for (const w of [/Sync browser auth/i, /Get command/, /auth-sync/, /Re-sync/, /Terminal app/, /Mac list/]) expect(text).not.toMatch(w);
  expect(screen.queryByRole("button", { name: /Sync browser auth|Get command|Re-sync/ })).toBeNull();
  expect(document.querySelectorAll("[data-owner-command]")).toHaveLength(0);
}

describe("Browser auth page", () => {
  it("never offers the Mac command, its Get command button or a Re-sync; says the team signs in itself", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    const start = vi.spyOn(api, "startAuthSync");
    render(
      <MemoryRouter initialEntries={["/auth?sync=as" + "1".repeat(32)]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    await screen.findByText("Each sign-in the team makes shows here.");
    expect(screen.getByTestId("auth-about").textContent).toMatch(/The team signs in itself with the Team Browser and the logins in Bitwarden/);
    expectNoMacSync();
    expect(start).not.toHaveBeenCalled();
  });

  it("lists sites with an expiry warning and asks before Clear", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([
      {
        id: "site_1",
        pattern: "*.reddit.com",
        domains: ["reddit.com"],
        cookieCount: 23,
        earliestExpiry: new Date(Date.now() + 86_400_000).toISOString(),
        sourceBrowser: "Chrome",
        sourceProfile: "acme (Profile 3)",
        syncedAt: new Date().toISOString(),
        lastUsedBy: "agent@home_repo",
        lastUsedAt: new Date().toISOString(),
        session: "dead",
        sessionReason: "HTTP 403 on https://www.reddit.com/r/x/.json",
      },
    ]);
    const clear = vi.spyOn(api, "clearAuthSite").mockResolvedValue();
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("acme (Profile 3)")).toBeTruthy();
    expect(screen.getByText("agent@home_repo")).toBeTruthy();
    expect(screen.getByText(/^in /).className).toMatch(/text-destructive/);
    expect(screen.getByText("session dead").parentElement!.title).toMatch(/HTTP 403/);
    fireEvent.click(screen.getByRole("button", { name: "Clear *.reddit.com from acme (Profile 3)" }));
    // (an old browser service without loginCookie: the earliest cookie, as before)
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("site_1"));
  });

  it("shows the login expiry, with the short-lived earliest cookie only as a muted hint (T25-S1)", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([
      {
        id: "site_x",
        pattern: "*.x.com",
        domains: ["x.com"],
        cookieCount: 19,
        earliestExpiry: new Date(Date.now() + 28 * 60_000).toISOString(),
        loginExpiry: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        loginCookie: "auth_token, ct0",
        sourceBrowser: "Chrome",
        sourceProfile: "example.com (Default)",
        syncedAt: new Date().toISOString(),
        session: "ok",
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    const login = await screen.findByText(/^login: in /);
    expect(login.className).not.toMatch(/amber/);
    expect(login.title).toMatch(/From auth_token, ct0/);
    expect(screen.getByText(/^shortest cookie in /).className).toMatch(/muted/);
  });
});

describe("one row per site and Chrome profile", () => {
  const x = (over: Partial<AuthSite>): AuthSite => ({
    id: "site_a",
    pattern: "*.x.com",
    domains: ["x.com"],
    cookieCount: 21,
    sourceBrowser: "Chrome",
    sourceProfile: "example.com (Default)",
    syncedAt: new Date().toISOString(),
    ...over,
  });
  const rows = [
    x({ profileKey: "Chrome/Default", profileLabel: "example.com (sam@example.com)", accounts: ["SamNews", "SamShop"], defaultForReads: true }),
    x({ id: "site_b", cookieCount: 15, sourceProfile: "example.com (Profile 5)", profileKey: "Chrome/Profile 5", profileLabel: "example.com (ops@)", accounts: ["OpsDesk", "OpsData"], defaultForReads: false }),
  ];

  it("shows each row's profile and accounts, with no Re-sync or Mac command", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue(rows);
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("example.com (ops@)")).toBeTruthy();
    expect(screen.getByText("example.com (sam@example.com)")).toBeTruthy();
    for (const a of ["@SamNews", "@SamShop", "@OpsDesk", "@OpsData"]) expect(screen.getByText(a)).toBeTruthy();
    expect(screen.getAllByText("default")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Clear *.x.com from example.com (ops@)" })).toBeTruthy();
    expectNoMacSync();
  });

  // each row says its sync state in the inbox reminder's own words (the browser service's outOfSync test).
  it("a stale row shows the exact Out of sync line, a fresh row says In sync", async () => {
    const stale = x({
      id: "site_b",
      cookieCount: 15,
      profileKey: "Chrome/Profile 5",
      profileLabel: "example.com (ops@)",
      accounts: ["OpsDesk", "OpsData"],
      loginCookie: "auth_token",
      loginExpiry: new Date(Date.now() + 86_400_000).toISOString(),
      resync: { reason: "out-of-sync", why: "the login runs out within 3 days", requestedAt: new Date().toISOString(), lastError: "no login cookie in Chrome / Profile 5" },
    });
    const fresh = x({ ...rows[0], loginCookie: "auth_token", loginExpiry: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    const dead = x({ id: "site_c", pattern: "*.reddit.com", domains: ["reddit.com"], session: "dead" });
    for (const phone of [false, true]) {
      if (phone) vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
      vi.spyOn(api, "listAuthSites").mockResolvedValue([fresh, stale, dead]);
      render(
        <MemoryRouter initialEntries={["/auth"]}>
          <BrowserAuthPage />
        </MemoryRouter>,
      );
      await screen.findByText("example.com (ops@)");
      const lines = screen.getAllByTestId("sync-state").map((e) => [e.textContent, e.getAttribute("data-stale")]);
      expect(lines).toEqual([
        ["In sync: @SamNews, @SamShop, lives in profile example.com (sam@example.com).", "no"],
        ["Out of sync: @OpsDesk, @OpsData, lives in profile example.com (ops@).", "yes"],
        ["Out of sync: reddit.com, lives in profile example.com (Default).", "yes"],
      ]);
      // no row sends him to the Mac list any more
      expect(screen.queryAllByTestId("mac-list")).toHaveLength(0);
      expectNoMacSync();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("on a phone each row is a card with its profile and accounts, no Re-sync", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
    vi.spyOn(api, "listAuthSites").mockResolvedValue(rows);
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("auth-cards")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("@OpsDesk")).toBeTruthy();
    expectNoMacSync();
    vi.unstubAllGlobals();
  });
});

describe("Browser sign-ins on the social skin (T46-S7)", () => {
  it("tells a tester the sign-ins stay in their team's own browser, with no Mac command", async () => {
    const { SKINS, SkinProvider } = await import("@/lib/skin");
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    vi.spyOn(api, "listEgress").mockResolvedValue([]);
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={["/auth"]}>
          <BrowserAuthPage />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect(screen.getByRole("heading", { name: "Browser sign-ins" })).toBeTruthy();
    expect(screen.getByText(/only your team uses them, never anyone else's/)).toBeTruthy();
    await screen.findByText("Each sign-in the team makes shows here.");
    expectNoMacSync();
  });
});
