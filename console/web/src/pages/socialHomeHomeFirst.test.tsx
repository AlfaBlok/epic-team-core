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
    const blocked = await screen.findByText(/Blocked, waiting on you/);
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

  it("the menu: Home and Chat on top, then the pinned campaigns under their project, then Performance, Product, Messages", async () => {
    at(<SidebarNav />);
    const groups = await screen.findByTestId("project-groups");
    const main = screen.getByTestId("nav-main");
    expect([...main.querySelectorAll("a")].map((a) => a.textContent?.replace(/\d+/g, "").trim())).toEqual(["Home", "Chat"]);
    expect(screen.queryByTestId("project-switcher")).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId("project-group-social")).getAllByTestId("big-root").map((a) => a.dataset.milestoneId)).toEqual(["m-z1", "m-z2"]));
    expect(within(screen.getByTestId("project-group-brand-campaign")).getAllByTestId("big-root").map((a) => a.dataset.milestoneId)).toEqual(["m-e1"]);
    expect(main.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const pages = screen.getByTestId("nav-social-pages");
    expect(groups.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // a project's name narrows every page to it, pressed again it goes back to all projects
    fireEvent.click(screen.getByTestId("project-social"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?project=social"));
    fireEvent.click(screen.getByTestId("project-social"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
  });

  it("the EpicTeam home and menu keep their order", async () => {
    at(<SidebarNav />, "/", SKINS.console);
    const main = await screen.findByTestId("nav-main");
    expect([...main.querySelectorAll("a")][0].textContent).toContain("Inbox");
    expect(screen.queryByTestId("project-groups")).toBeNull();
    cleanup();
    at(<TeamPage />, "/", SKINS.console);
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(screen.queryByTestId("project-campaigns")).toBeNull();
  });
});
