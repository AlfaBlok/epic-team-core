// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api, type AuthSite, type AuthSync } from "@/api";
import { BrowserAuthPage } from "@/pages/BrowserAuth";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let search = "";
function Spy() {
  search = useLocation().search;
  return null;
}

const sync = (over: Partial<AuthSync>): AuthSync => ({
  token: "as" + "1".repeat(32),
  status: "pending",
  patterns: ["*.reddit.com"],
  browserHint: "chrome",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  command: `curl -sSL http://c/auth-sync/as${"1".repeat(32)}.sh | sh`,
  scriptUrl: "",
  ...over,
});

describe("Browser auth page", () => {
  it("mints a command, puts the token in the URL, polls, and shows the result", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    const start = vi.spyOn(api, "startAuthSync").mockResolvedValue(sync({}));
    const poll = vi
      .spyOn(api, "getAuthSync")
      .mockResolvedValueOnce(sync({}))
      .mockResolvedValue(
        sync({ status: "synced", result: { browser: "Chrome", profile: "Profile 3", profileName: "acme", sites: [{ pattern: "*.reddit.com", cookieCount: 23, domains: ["reddit.com"] }] } }),
      );
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <Routes>
          <Route path="/auth" element={<><BrowserAuthPage /><Spy /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/No synced sites yet/);
    fireEvent.click(screen.getByRole("button", { name: /Sync browser auth/ }));
    fireEvent.change(screen.getByPlaceholderText("*.reddit.com, x.com"), { target: { value: "*.reddit.com, x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Get command/ }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ patterns: ["*.reddit.com", "x.com"], browser: expect.any(String) }));
    const box = await screen.findByText(/curl -sSL http:\/\/c\/auth-sync/);
    // the copy box holds strictly the one command the owner runs, never text for the Claude app
    expect(box.textContent).toBe(`curl -sSL http://c/auth-sync/as${"1".repeat(32)}.sh | sh`);
    expect(box.getAttribute("data-owner-command")).toBe("sync-browser-auth");
    expect(screen.getByText("On your Mac, in the Terminal app")).toBeTruthy();
    expect(screen.queryByText(/Claude app/)).toBeNull();
    expect(search).toBe(`?sync=as${"1".repeat(32)}`);
    expect(await screen.findByText(/Synced from Chrome \/ acme/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/23 cookies \(reddit.com\)/)).toBeTruthy();
    expect(poll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(search).toBe(""));
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

  it("shows each row's profile and accounts, and Re-sync names that profile with the same one-line command", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue(rows);
    const start = vi.spyOn(api, "startAuthSync").mockResolvedValue(sync({ patterns: ["*.x.com"], targetProfile: "Chrome/Profile 5" }));
    vi.spyOn(api, "getAuthSync").mockResolvedValue(sync({ patterns: ["*.x.com"], targetProfile: "Chrome/Profile 5" }));
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("example.com (ops@)")).toBeTruthy();
    expect(screen.getByText("example.com (sam@example.com)")).toBeTruthy();
    for (const a of ["@SamNews", "@SamShop", "@OpsDesk", "@OpsData"]) expect(screen.getByText(a)).toBeTruthy();
    expect(screen.getAllByText("default")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Re-sync *.x.com from example.com (ops@)" }));
    expect(screen.getByTestId("resync-target").textContent).toMatch(/example\.com \(ops@\).*Holds @OpsDesk, @OpsData/);
    fireEvent.click(screen.getByRole("button", { name: /Get command/ }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ patterns: ["*.x.com"], browser: expect.any(String), profile: "Chrome/Profile 5" }));
    const box = await screen.findByText(/curl -sSL http:\/\/c\/auth-sync/);
    expect(box.textContent).toBe(`curl -sSL http://c/auth-sync/as${"1".repeat(32)}.sh | sh`);
    expect(box.getAttribute("data-owner-command")).toBe("sync-browser-auth");
    expect(document.querySelectorAll("[data-owner-command]")).toHaveLength(1);
    expect(screen.getByTestId("resync-note").textContent).toMatch(/opens the example\.com \(ops@\) profile/);
    // the press also put the row on the Mac list; still one copy line only
    expect(screen.getByTestId("resync-mac-list").textContent).toMatch(/on your Mac list now too: the next Run all there re-syncs it for you/);
    expect(screen.queryByText(/Claude/)).toBeNull();
  });

  it("falls back to a plain sync when the Team Browser does not know profiles yet", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue(rows);
    const start = vi
      .spyOn(api, "startAuthSync")
      .mockRejectedValueOnce(new Error("Unrecognized key(s) in object: 'profile'"))
      .mockResolvedValue(sync({ patterns: ["*.x.com"] }));
    vi.spyOn(api, "getAuthSync").mockResolvedValue(sync({ patterns: ["*.x.com"] }));
    render(
      <MemoryRouter initialEntries={["/auth"]}>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Re-sync *.x.com from example.com (sam@example.com)" }));
    fireEvent.click(screen.getByRole("button", { name: /Get command/ }));
    await waitFor(() => expect(start).toHaveBeenLastCalledWith({ patterns: ["*.x.com"], browser: expect.any(String) }));
    expect(await screen.findByText(/curl -sSL/)).toBeTruthy();
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
      // only the row with an open Re-sync says the Mac list runs it, with its last try's reason
      expect(screen.getAllByTestId("mac-list").map((e) => e.textContent)).toEqual([
        "On your Mac list: Run all re-syncs it for you, nothing to paste. Last try: no login cookie in Chrome / Profile 5",
      ]);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("on a phone each row is a card with its profile, accounts and Re-sync", async () => {
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
    expect(screen.getByRole("button", { name: "Re-sync *.x.com from example.com (ops@)" })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("Browser sign-ins on the social skin (T46-S7)", () => {
  it("tells a tester the sign-ins stay in their team's own browser and offers X and Reddit", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: /Sync browser auth/ }));
    expect((await screen.findByDisplayValue("x.com, *.reddit.com")) as HTMLInputElement).toBeTruthy();
  });
});
