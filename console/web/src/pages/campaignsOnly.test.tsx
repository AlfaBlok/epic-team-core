// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { SidebarNav } from "@/components/Layout";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { TeamPage } from "@/pages/Team";
import { campaignMilestones } from "@/lib/campaign";
import { SKINS, SkinProvider } from "@/lib/skin";

// The social Home listed every milestone of the world as a campaign (a house decision, a server, taxes). The owner:
// "Right now I opened it up and it felt like a little bit of a mess." The social skin now lists only real campaigns
// (the campaign list) and the jobs in their repos.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => localStorage.clear());
// with objectives the sidebar lists no other goals; these tests read the goal list of a workspace with none yet.
beforeEach(() => void vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [] } as never));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const card = (over: Partial<CampaignCard>): CampaignCard => ({ ...mockCampaignCard(), repo: "brand-campaign", remote: "Acme/brand-campaign", ...over });

describe("campaignMilestones", () => {
  const ms = [
    { id: "ms_camp", repo: "Acme/brand-campaign" },
    { id: "ms_job", repo: "Acme/brand-campaign" },
    { id: "ms_house", repo: "Acme/house" },
    { id: "ms_vps", repo: "Acme/ops" },
    { id: "ms_old", repo: "Acme/old-campaign" },
    { id: "ms_level", repo: "Acme/social" },
    { id: "ms_w37", repo: "srv/repos/social" },
  ];
  it("keeps live campaigns and the jobs in their repos, drops every other project, retired campaigns and a repo's own level", () => {
    const cards = [
      card({ milestoneId: "ms_camp" }),
      card({ repo: "old-campaign", remote: "Acme/old-campaign", milestoneId: "ms_old", retired: true }),
      card({ repo: "social", remote: "Acme/social", milestoneId: "ms_level" }),
      card({ repo: "social", remote: "Acme/social", milestoneId: "ms_w37", campaign: { code: "PLAN-11", name: "Week 37", path: "docs/spines/w37.md", platform: "Reddit", period: null } }),
    ];
    expect(campaignMilestones(cards, ms).map((m) => m.id)).toEqual(["ms_camp", "ms_job", "ms_w37"]);
  });
  it("a world with no campaign lists nothing, and nothing before the list is read", () => {
    expect(campaignMilestones([], ms)).toEqual([]);
    expect(campaignMilestones(undefined, ms)).toEqual([]);
  });
});

describe("the social Home and menu", () => {
  const seed = async () => {
    const mk = (title: string, repo: string, bigRoot?: number) => api.createMilestone({ title, repo, path: "docs/spines/root.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
    const camp = await mk("Get testers", "Acme/brand-campaign", 1);
    const house = await mk("House decision", "Acme/house", 2);
    const vps = await mk("Server stability", "Acme/ops", 3);
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "social" } } as never);
    vi.spyOn(api, "getSocial").mockRejectedValue(new Error("not in this test"));
    return { camp, house, vps };
  };
  const inSocial = (el: JSX.Element) =>
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>{el}</MemoryRouter>
      </SkinProvider>,
    );
  const homeLinks = () => [...document.querySelectorAll('[data-testid="project-campaigns"] a')].map((a) => a.getAttribute("href"));

  it("Home shows the campaign and none of the world's other projects", async () => {
    const { camp, house, vps } = await seed();
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [card({ milestoneId: camp.id })] });
    inSocial(<TeamPage />);
    await waitFor(() => expect(homeLinks()).toContain(`/milestones/${camp.id}`));
    expect(homeLinks()).not.toContain(`/milestones/${house.id}`);
    expect(homeLinks()).not.toContain(`/milestones/${vps.id}`);
  });

  it("the menu lists the campaign and leaves House decision and Server stability out", async () => {
    const { camp } = await seed();
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [card({ milestoneId: camp.id })] });
    inSocial(<SidebarNav />);
    await waitFor(() => expect(screen.getAllByText("Get testers").length).toBeGreaterThan(0));
    expect(screen.queryByText("House decision")).toBeNull();
    expect(screen.queryByText("Server stability")).toBeNull();
  });

  it("a world that runs no campaign (the owner's own) lists none and points to the world that does", async () => {
    const { house } = await seed();
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "home", campaigns: [] });
    vi.spyOn(api as Required<typeof api>, "listCompanyWorlds").mockResolvedValue({ worlds: [{ tenantId: "social", tenantName: "social", app: "SocialApp", appUrl: "https://cloud.social.example", items: [] }] });
    inSocial(<TeamPage />);
    const link = await screen.findByTestId("campaigns-elsewhere-link");
    expect(link.getAttribute("href")).toBe("https://cloud.social.example");
    expect(homeLinks()).not.toContain(`/milestones/${house.id}`);
  });

  it("a world that runs no campaign names the real ones of the world that does, each opening there", async () => {
    const { house, vps } = await seed();
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "home", campaigns: [] });
    vi.spyOn(api as Required<typeof api>, "listCompanyWorlds").mockResolvedValue({
      worlds: [
        {
          tenantId: "social",
          tenantName: "social",
          app: "SocialApp",
          appUrl: "https://cloud.social.example",
          items: [],
          campaigns: [
            { name: "Memo testers", milestoneId: "ms_mt", goal: "0 of 10 testers signed up, by 22 Nov", openUrl: "https://cloud.social.example/milestones/ms_mt" },
            { name: "Day in the life", milestoneId: "ms_dl", openUrl: "https://cloud.social.example/milestones/ms_dl" },
          ],
        },
      ],
    });
    inSocial(<TeamPage />);
    const cards = await screen.findAllByTestId("elsewhere-campaign");
    expect(cards.map((a) => a.querySelector('[data-testid="campaign-name"]')!.textContent)).toEqual(["Memo testers", "Day in the life"]);
    expect(cards[0].getAttribute("href")).toBe("https://cloud.social.example/milestones/ms_mt");
    expect(cards[0].textContent).toContain("0 of 10 testers");
    expect(homeLinks()).not.toContain(`/milestones/${house.id}`);
    expect(homeLinks()).not.toContain(`/milestones/${vps.id}`);
  });

  it("the console skin keeps listing every project", async () => {
    const { house } = await seed();
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "home", campaigns: [] });
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.querySelector(`a[href="/milestones/${house.id}"]`)).toBeTruthy());
  });
});
