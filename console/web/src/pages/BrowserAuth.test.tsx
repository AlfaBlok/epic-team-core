// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api, type AuthSync } from "@/api";
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
    expect(await screen.findByText(/curl -sSL http:\/\/c\/auth-sync/)).toBeTruthy();
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
    expect(await screen.findByText("Chrome / acme (Profile 3)")).toBeTruthy();
    expect(screen.getByText("agent@home_repo")).toBeTruthy();
    expect(screen.getByText(/^in /).className).toMatch(/amber/);
    expect(screen.getByText("session dead").parentElement!.title).toMatch(/HTTP 403/);
    fireEvent.click(screen.getByRole("button", { name: "Clear *.reddit.com" }));
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
