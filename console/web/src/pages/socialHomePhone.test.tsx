// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "@/api";
import { forgetOtherWorlds, plainItemTitle } from "@/components/otherWorlds";
import { postingWord, TeamPage } from "@/pages/Team";
import { SKINS, SkinProvider } from "@/lib/skin";

// E907-S3. The owner: "I'm looking at the home of the social app, and on the mobile, it's
// just a total mess". On a phone Home is the campaigns and what waits on him, like EpicTeam's quiet Inbox: whole
// campaign names, a short posting line, no laptop switch, the widgets folded under one line, finger-sized buttons.
// The real-browser half (no sideways scroll, every button at least 40 px at 390 px) is scripts/test_social_qc.py and
// scripts/social_qc.mjs --assert on the live Home.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => localStorage.clear());
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe("postingWord", () => {
  it("says a live campaign posts in a few words and drops the bracketed how", () => {
    expect(postingWord("Live: posting on Reddit and X (its Publisher sends its approved posts)")).toEqual({ live: true, text: "Posting on Reddit and X" });
    expect(postingWord("Live: posting (the repo's Publisher sends its approved posts at their slot)")).toEqual({ live: true, text: "Posting" });
  });
  it("keeps a not-live line whole", () => {
    expect(postingWord("Not live yet: it starts 2026-12-10")).toEqual({ live: false, text: "Not live yet: it starts 2026-12-10" });
    expect(postingWord(undefined)).toBeUndefined();
  });
});

describe("plainItemTitle", () => {
  it("drops a leading row or ask code", () => {
    expect(plainItemTitle("E907-S3 Pattern: handle, Sam email")).toBe("Pattern: handle, Sam email");
    expect(plainItemTitle("acme/EPIC-907-A1 Pick the name")).toBe("Pick the name");
    expect(plainItemTitle("Approve Sprint 1 (13 to 17 Nov)")).toBe("Approve Sprint 1 (13 to 17 Nov)");
  });
});

describe("the social Home on a phone", () => {
  const worlds = {
    worlds: [
      {
        tenantId: "social",
        tenantName: "social",
        app: "SocialApp",
        appUrl: "https://cloud.social.example",
        items: [],
        campaigns: [{ name: "Customer alpha: 30 days on a fresh X account", milestoneId: "ms_ca", goal: "0 of 100 followers, by 8 Dec", posting: "Live: posting on X (its Publisher sends its approved posts)", openUrl: "https://cloud.social.example/milestones/ms_ca" }],
      },
    ],
  };
  const home = () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "home" } } as never);
    vi.spyOn(api, "getSocial").mockRejectedValue(new Error("not in this test"));
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "home", campaigns: [] });
    vi.spyOn(api as Required<typeof api>, "listCompanyWorlds").mockResolvedValue(worlds as never);
    return render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </SkinProvider>,
    );
  };

  it("a campaign card shows its whole name (wraps, never cut), its goal and a short posting line", async () => {
    home();
    const card = await screen.findByTestId("elsewhere-campaign");
    const name = card.querySelector('[data-testid="campaign-name"]')!;
    expect(name.textContent).toBe("Customer alpha: 30 days on a fresh X account");
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(card.querySelector('[data-testid="campaign-goal"]')!.textContent).toBe("0 of 100 followers, by 8 Dec");
    expect(card.querySelector('[data-testid="campaign-posting"]')!.textContent).toBe("Posting on X");
  });

  it("no laptop switch, and the widgets fold under one line at the end", async () => {
    home();
    await screen.findByTestId("elsewhere-campaign");
    expect(screen.queryByText("I'm on my laptop for")).toBeNull();
    const toggle = screen.getByTestId("home-more-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("home-more-body")).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("home-more-body")).toBeTruthy());
    expect(localStorage.getItem("social-home-more")).toBe("1");
  });

  it("New campaign and Add job are finger-sized on a phone", async () => {
    home();
    for (const id of ["new-focus", "add-job"]) expect((await screen.findByTestId(id)).className).toMatch(/max-sm:min-h-11/);
  });
});

describe("the social skin touch rule", () => {
  it("polish.css makes every button, select, input and standalone link at least 40 px on a touch screen, in both skins", () => {
    const css = readFileSync(join(__dirname, "..", "polish.css"), "utf8");
    const block = css.slice(css.indexOf("the phone Home"));
    expect(block).toMatch(/@media \(pointer: coarse\)/);
    // both products get it: the rule is no longer held to the social skin
    expect(block).toMatch(/\n  main :is\(button, select, input/);
    expect(block.slice(0, block.indexOf("a card with a ticket code"))).not.toMatch(/data-skin="social"/);
    expect(block).toMatch(/min-height: 40px/);
  });
});
