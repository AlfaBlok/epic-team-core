// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api, type Milestone } from "@/api";
import { mockCampaignCard } from "@/api/mockCampaigns";
import type { CampaignCard } from "@/api/campaign-types";
import { TeamPage } from "@/pages/Team";
import { SidebarNav } from "@/components/Layout";
import { HomePage } from "@/components/homeView";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";

// "we should have home, and the team is by
// default all projects always... and chat... And then we see the campaigns very quickly, and then all the widgets, I think,
// are after the campaigns... the campaigns belong to specific projects".

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => (localStorage.clear(), forgetWorld()));
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ms = (id: string, title: string, repo: string, bigRoot?: number) =>
  ({ id, title, repo, path: `docs/spines/${id}.md`, owner: "Sam", paused: false, status: "active", createdAt: "2026-11-01T00:00:00Z", ...(bigRoot ? { bigRoot } : {}) }) as unknown as Milestone;
const card = (repo: string, milestoneId: string, title: string): CampaignCard => ({ ...mockCampaignCard(), repo, milestoneId, title, campaign: { code: milestoneId, name: title, path: "p", platform: null, period: null } }) as CampaignCard;

beforeEach(() => {
  vi.spyOn(api, "listMilestones").mockResolvedValue([
    ms("m-z2", "Day in the life on Reddit", "social", 2),
    ms("m-e1", "Epic launch", "brand-campaign", 3),
    ms("m-z1", "Memory testers", "social", 1),
    ms("m-z3", "Old Memory idea", "social"),
  ]);
  vi.spyOn(api, "listCampaigns").mockResolvedValue({
    tenantId: "social",
    campaigns: [card("social", "m-z1", "Memory testers"), card("social", "m-z2", "Day in the life on Reddit"), card("social", "m-z3", "Old Memory idea"), card("brand-campaign", "m-e1", "Epic launch")],
  });
});

function Where() {
  return <div data-testid="where">{useLocation().search}</div>;
}
const at = (ui: React.ReactNode, path = "/", skin: Skin = SKINS.social) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <ProjectProvider>
          {ui}
          <Where />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const names = (el: HTMLElement) => within(el).queryAllByTestId("campaign-name").map((n) => n.textContent);

describe("T60-S10 the SocialApp home: Home first, campaigns by project, widgets after", () => {
  it("opens on every project's campaigns, each under its project, pinned first in his order, before the inbox and the widgets", async () => {
    at(<TeamPage />);
    expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
    const memory = await screen.findByTestId("campaigns-of-social");
    await waitFor(() => expect(names(memory)).toEqual(["Memory testers", "Day in the life on Reddit", "Old Memory idea"]));
    expect(within(memory).getAllByTestId("milestone-card").map((c) => c.dataset.pinned)).toEqual(["yes", "yes", "no"]);
    expect(names(screen.getByTestId("campaigns-of-brand-campaign"))).toEqual(["Epic launch"]);
    // the campaigns come before the inbox (Blocked, review) and the widgets
    const campaigns = screen.getByTestId("project-campaigns");
    const blocked = await screen.findByText(/^Blocked on you/);
    expect(campaigns.compareDocumentPosition(blocked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a project link narrows the home to that project; All projects brings every one back", async () => {
    at(<TeamPage />, "/?project=brand-campaign");
    await screen.findByTestId("campaigns-of-brand-campaign");
    expect(screen.queryByTestId("campaigns-of-social")).toBeNull();
    fireEvent.click(screen.getByTestId("only-brand-campaign"));
    await screen.findByTestId("campaigns-of-social");
    expect(screen.getByTestId("where").textContent).toBe("");
  });

  it("the menu: Home, Inbox, Chat, then only his pinned campaigns; everything else folds into More", async () => {
    at(<SidebarNav />);
    const pinned = await screen.findByTestId("sidebar-campaigns");
    const main = screen.getByTestId("nav-main");
    expect([...main.querySelectorAll("a")].map((a) => a.textContent?.replace(/\d+/g, "").trim())).toEqual(["Home", "Inbox", "Chat"]);
    // the pinned campaigns in his order (1, 2, 3), each with its number ring; the unpinned one is not here
    await waitFor(() => expect(within(pinned).getAllByTestId("sidebar-campaign").map((a) => a.dataset.milestoneId)).toEqual(["m-z1", "m-z2", "m-e1"]));
    expect(within(pinned).getAllByTestId("campaign-ring")).toHaveLength(3);
    expect(main.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // folded: no projects, no other pages, no settings until More is pressed
    expect(screen.queryByTestId("project-groups")).toBeNull();
    expect(screen.queryByTestId("nav-social-pages")).toBeNull();
    expect(screen.queryByTestId("nav-pages")).toBeNull();
    const toggle = screen.getByTestId("sidebar-more-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(pinned.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    // More open: every campaign by project, then Performance, Product, Messages; the choice is kept
    const groups = await screen.findByTestId("project-groups");
    await waitFor(() => expect(within(screen.getByTestId("project-group-social")).getAllByTestId("big-root").map((a) => a.dataset.milestoneId)).toEqual(["m-z1", "m-z2"]));
    expect(groups.compareDocumentPosition(screen.getByTestId("nav-social-pages")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(localStorage.getItem("sidebar.more.open")).toBe("1");
    // a project's name narrows every page to it, pressed again it goes back to all projects
    fireEvent.click(screen.getByTestId("project-social"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?project=social"));
    fireEvent.click(screen.getByTestId("project-social"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
  });

  it("Home is the console skin's All objectives page with his pinned campaigns as the rows", async () => {
    at(<HomePage />);
    const home = await screen.findByTestId("campaigns-home");
    expect(within(home).getByRole("heading", { name: "Your campaigns" })).toBeTruthy();
    await waitFor(() => expect(within(home).getAllByTestId("all-sets-row").map((r) => r.dataset.set)).toEqual(["m-z1", "m-z2", "m-e1"]));
    // lean rows: number ring, light, name, colour bar; the row opens the campaign
    const first = within(home).getAllByTestId("all-sets-row")[0];
    expect(within(first).getByTestId("campaign-ring")).toBeTruthy();
    expect(within(first).getByTestId("kr-strip")).toBeTruthy();
    expect(within(first).getByTestId("wheel-row-link").getAttribute("href")).toBe("/milestones/m-z1");
    expect(within(home).getByTestId("set-tab-inbox").getAttribute("href")).toBe("/inbox");
    expect(within(home).getByTestId("campaigns-home-more").textContent).toContain("1 more campaign");
    // no old campaign grid
    expect(screen.queryByTestId("project-campaigns")).toBeNull();
  });

  it("the the console skin Home stays All objectives (no campaigns page)", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [{ id: "p1", kind: "pursuit", name: "Five testers", greens: 0, total: 0, spines: [], children: [], rows: [] }], spineInfo: {} } as never);
    at(<HomePage />, "/", SKINS.console);
    expect(await screen.findByTestId("goal-sets-page")).toBeTruthy();
    expect(screen.queryByTestId("campaigns-home")).toBeNull();
  });

  it("E907-S3: after the campaigns, SocialApp's own items, then Blocked, then the cards to review, and only then the history", async () => {
    vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({
      worlds: [{ tenantId: "social-world", tenantName: "Sam", app: "SocialApp", appUrl: "https://cloud.example.com", items: [{ key: "ask:a", kind: "ask", id: "a", title: "Approve Sprint 1", openUrl: "https://cloud.example.com/" }] }],
    });
    at(<TeamPage />);
    const band = await screen.findByTestId("other-world");
    const campaigns = screen.getByTestId("project-campaigns");
    const blocked = await screen.findByText(/^Blocked on you/);
    const review = await screen.findByTestId("waiting-for-review");
    expect(campaigns.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band.compareDocumentPosition(blocked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(blocked.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the history (Answered and the rest) comes after the review list, never between Blocked and it
    const answered = screen.queryAllByText(/^Answered/);
    for (const a of answered) expect(review.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the the console skin home and menu keep their order", async () => {
    at(<SidebarNav />, "/", SKINS.console);
    const main = await screen.findByTestId("nav-main");
    // Home (the goals view) then the Inbox, in both skins.
    expect([...main.querySelectorAll("a")][0].textContent).toContain("Home");
    expect([...main.querySelectorAll("a")][1].textContent).toContain("Inbox");
    expect(screen.queryByTestId("project-groups")).toBeNull();
    cleanup();
    at(<TeamPage />, "/", SKINS.console);
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(screen.queryByTestId("project-campaigns")).toBeNull();
  });
});
