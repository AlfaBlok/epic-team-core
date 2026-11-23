// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type SignedInCheck } from "@/api";
import { authPunchline, BrowserAuthPage } from "@/pages/BrowserAuth";
import type { AuthSite } from "@/api";

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
    // the Browser's old Mac step never shows; the team signs in again itself
    expect(x.queryByText(FIX)).toBeNull();
    expect(x.getByText("The team signs in again itself.")).toBeTruthy();
    const reddit = within(screen.getByTestId("check-reddit"));
    expect(reddit.getByText("signed in")).toBeTruthy();
    expect(screen.getByTestId("check-reddit").textContent).not.toMatch(/Sync/);
    expect(within(screen.getByTestId("check-instagram")).getByText("not synced")).toBeTruthy();
    expect(screen.getByTestId("check-instagram").textContent).toMatch(/The team signs in again itself/);
    expect(document.body.textContent).not.toMatch(/run the command|press Sync/);
    expect(within(screen.getByTestId("check-youtube")).getByText("by its API")).toBeTruthy();
  });

  it("keeps each label on one line: a long name ends in an ellipsis and keeps its full name in the title", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    vi.spyOn(api, "listEgress").mockResolvedValue([]);
    vi.spyOn(api, "listSignedInCheck").mockResolvedValue([row({ site: "x-examplehq_data", state: "not_synced", fix: FIX })]);
    render(
      <MemoryRouter>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    const label = within(await screen.findByTestId("check-x-examplehq_data")).getByTestId("check-label");
    expect(label.textContent).toBe("x-examplehq_data");
    expect(label.getAttribute("title")).toBe("x-examplehq_data");
    expect(label.className).toMatch(/\btruncate\b/);
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
    await screen.findByText("Each sign-in the team makes shows here.");
    expect(screen.queryByTestId("signed-in-check")).toBeNull();
  });
});

describe("the Browser auth page opens with its answer in two accents", () => {
  const site = (o: Partial<AuthSite>): AuthSite => ({
    id: o.pattern ?? "s",
    pattern: "*.reddit.com",
    domains: ["reddit.com"],
    cookieCount: 9,
    sourceBrowser: "Chrome",
    sourceProfile: "example.com (Default)",
    syncedAt: at,
    loginCookie: "session",
    loginExpiry: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    ...o,
  });

  it("says how many sign-ins are good and which the team signs in to again", () => {
    const reddit = site({});
    const airbnb = site({ id: "a", pattern: "*.airbnb.com", session: "dead" });
    const x = site({ id: "x", pattern: "*.x.com", accounts: ["OpsDesk"] });
    expect(authPunchline([])).toBe("No sign-ins yet. The team signs in itself.");
    expect(authPunchline([reddit])).toBe("The 1 sign-in is good.");
    expect(authPunchline([reddit, x])).toBe("All 2 sign-ins are good.");
    expect(authPunchline([reddit, airbnb, x])).toBe("2 of 3 sign-ins good, the team signs in again to airbnb.com.");
    const out = [row({ site: "x", state: "signed_out", pattern: "*.x.com" })];
    expect(authPunchline([reddit, airbnb, x], out)).toBe("1 of 3 sign-ins good, the team signs in again to airbnb.com, @OpsDesk.");
  });

  it("puts the answer box right under the title, the prose after the rows, and shows the laptop and API states as grey text", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([site({}), site({ id: "a", pattern: "*.airbnb.com", session: "dead" })]);
    vi.spyOn(api, "listEgress").mockResolvedValue([]);
    vi.spyOn(api, "listSignedInCheck").mockResolvedValue([
      row({ site: "x", state: "held", pattern: "*.x.com" }),
      row({ site: "youtube", state: "by_api" }),
      row({ site: "airbnb", state: "error" }),
    ]);
    render(
      <MemoryRouter>
        <BrowserAuthPage />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("auth-punchline");
    expect(box.textContent).toBe("1 of 2 sign-ins good, the team signs in again to airbnb.com.");
    const h1 = screen.getByRole("heading", { level: 1 });
    // nothing but the header's own row sits between the title and the answer: the prose comes after the rows
    expect(h1.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const about = screen.getByTestId("auth-about");
    expect(box.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("signed-in-check").compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(h1.parentElement!.textContent).toBe("Browser auth");
    await screen.findByTestId("check-x");
    for (const [id, text] of [["check-x", "waiting for the laptop"], ["check-youtube", "by its API"], ["check-airbnb", "could not check"]]) {
      const el = within(screen.getByTestId(id)).getByText(text);
      expect(el.className).toMatch(/text-muted-foreground/);
      expect(el.className).not.toMatch(/amber|border|rounded/);
    }
  });
});
