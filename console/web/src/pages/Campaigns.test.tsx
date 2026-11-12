// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { api } from "@/api";
import type { CampaignInput, CampaignPlan, CampaignResult } from "@/api/campaign-types";
import { mockCampaignCard, mockCampaignPlan } from "@/api/mockCampaigns";
import { landsAt } from "@/test/landsAt";
import { CampaignsPage } from "@/pages/Campaigns";

// the Campaigns list and the New campaign wizard (social skin).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = (path: string, skin: Skin = SKINS.social) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("Campaigns list", () => {
  it("one card per pack repo: name, posts this week, live, held, next post, link into its screens", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue({
      tenantId: "home",
      campaigns: [mockCampaignCard(), { ...mockCampaignCard(), repo: "other", remote: undefined, title: "Other", milestoneId: null, postsThisWeek: 0, live: 0, held: 0, nextPost: null }],
    });
    // no route of its own in the social skin any more (campaigns are pinned cards on Team); the list still renders.
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <CampaignsPage />
        </MemoryRouter>
      </SkinProvider>,
    );
    const cards = await screen.findAllByTestId("campaign-card");
    expect(cards).toHaveLength(2);
    const z = within(cards[0]);
    expect(z.getByText("Memo social presence")).toBeTruthy();
    expect(z.getByText("memo-ai/social")).toBeTruthy();
    expect(z.getByTestId("posts-this-week").textContent).toBe("3");
    expect(z.getByTestId("live").textContent).toBe("12");
    expect(z.getByTestId("held").textContent).toBe("1");
    expect(z.getByTestId("next-post").textContent).toBe("Next post: Wed 28 Oct 18:00 · Reddit · How git log saved me from a bad memory");
    // into its screens (?repo= picks the campaign) and its milestone (Engine room)
    expect(z.getByRole("link", { name: /Open campaign/ }).getAttribute("href")).toBe("/social?repo=social");
    expect(z.getByRole("link", { name: "Pipeline" }).getAttribute("href")).toBe("/social/pipeline?repo=social");
    expect(z.getByRole("link", { name: "History" }).getAttribute("href")).toBe("/social/history?repo=social");
    expect(z.getByRole("link", { name: "Engine room" }).getAttribute("href")).toBe("/milestones/m1");
    const o = within(cards[1]);
    expect(o.getByTestId("next-post").textContent).toBe("Next post: none scheduled");
    expect(o.getByRole("link", { name: "Finish setup" }).getAttribute("href")).toBe("/campaigns/new?repo=other");
    expect(screen.getByRole("link", { name: /New campaign/ }).getAttribute("href")).toBe("/campaigns/new");
  });

  it("empty world: points to New campaign; the console skin has no Campaigns screen", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "home", campaigns: [] });
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <CampaignsPage />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect(await screen.findByText(/No campaigns yet/)).toBeTruthy();
    cleanup();
    expect(await landsAt("/campaigns")).toBe("/");
    cleanup();
    at("/campaigns", SKINS.console);
    expect(screen.getByText(/Not found/)).toBeTruthy();
  });

  it("T58-S3: no Campaigns menu entry; Add campaign or job → Campaign opens the wizard", async () => {
    vi.spyOn(api, "listCampaignRepos").mockResolvedValue([]);
    at("/"); // the Layout renders the sidebar
    expect(screen.queryByRole("link", { name: "Campaigns" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Add campaign or job" })[0]);
    fireEvent.click(await screen.findByTestId("choose-campaign"));
    expect(await screen.findByRole("heading", { name: "New campaign" })).toBeTruthy();
  });
});

describe("New campaign wizard", () => {
  it("repo → brief → preview (nothing written) → create; shows the commits and the team", async () => {
    vi.spyOn(api, "listCampaignRepos").mockResolvedValue([
      { name: "social", remote: "memo-ai/social", hasPack: true, campaign: true },
      { name: "acme-social", hasPack: false, campaign: false },
    ]);
    const preview = vi.spyOn(api, "previewCampaign").mockImplementation(async (_t: string, i: CampaignInput): Promise<CampaignPlan> => ({
      ...mockCampaignPlan("home", { ...i, repo: "home_social" }),
      repo: i.repo,
      title: i.title ?? i.repo,
    }));
    const create = vi.spyOn(api, "createCampaign").mockImplementation(
      async (_t: string, i: CampaignInput): Promise<CampaignResult> => ({
        ...mockCampaignPlan("home", { ...i, repo: "home_social" }),
        repo: i.repo,
        title: i.title ?? i.repo,
        milestoneId: "m9",
        commits: [
          { step: "init", commit: "abcdef1234567", push: { state: "pushed" } },
          { step: "brief", commit: "1234567abcdef", push: { state: "pushed" } },
        ],
      }),
    );
    at("/campaigns/new");
    const radio = await screen.findByRole("radio", { name: /acme-social/ });
    const next = screen.getByRole("button", { name: /Next/ }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(radio);
    fireEvent.click(next);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme social" } });
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Acme heard by builders." } });
    fireEvent.change(screen.getByLabelText(/Key messages/), { target: { value: "git is memory\n\n durable state " } });
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));

    await screen.findByText(/3. Preview/);
    const form = { repo: "acme-social", title: "Acme social", objective: "Acme heard by builders.", keyMessages: ["git is memory", "durable state"] };
    expect(preview).toHaveBeenCalledWith("home", form);
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByTestId("plan-milestone").textContent).toBe('Create the campaign "Acme social" (its spine is docs/spines/root.md)');
    expect(screen.getByTestId("plan-init").textContent).toMatch(/^Turn the social pack on: 3 files/);
    expect(screen.getByTestId("plan-brief").textContent).toBe("Seed the brief: objective and key messages");
    expect(screen.getByTestId("plan-push").textContent).toBe("Commit as Sam and push to origin");
    const rows = within(screen.getByTestId("plan-team")).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("td")!.textContent)).toEqual(["Scout", "Writer", "Publisher", "Responder", "Engager", "Reporter"]);
    expect(within(screen.getByTestId("plan-role-Scout")).getByText(/new, from template scout/)).toBeTruthy();
    expect(within(screen.getByTestId("plan-role-Scout")).getByText("new, enabled")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    const done = await screen.findByTestId("campaign-done");
    expect(create).toHaveBeenCalledWith("home", form);
    expect(done.textContent).toMatch(/Pack on: commit abcdef1 \(pushed\)/);
    expect(done.textContent).toMatch(/Brief seeded: commit 1234567 \(pushed\)/);
    expect(done.textContent).toMatch(/6 assignment\(s\) created, enabled; 0 kept/);
  });

  it("an existing campaign: the preview says what is kept, the button updates; a server error shows and nothing moves on", async () => {
    vi.spyOn(api, "listCampaignRepos").mockResolvedValue([{ name: "social", remote: "memo-ai/social", hasPack: true, campaign: true }]);
    vi.spyOn(api, "previewCampaign").mockImplementation(async (_t, i) => mockCampaignPlan("home", i));
    vi.spyOn(api, "createCampaign").mockRejectedValue(new Error("uncommitted changes in AGENTS.md: commit or discard them first"));
    at("/campaigns/new?repo=social");
    // Next in a repo that runs campaigns starts a named campaign; re-running the repo setup is the secondary button.
    await screen.findByText(/already runs campaigns/);
    fireEvent.click(screen.getByTestId("rerun-setup"));
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await screen.findByText(/3. Preview/);
    expect(screen.getByTestId("plan-init").textContent).toBe("Pack init skipped: the pack is on already (Pack: social in AGENTS.md)");
    expect(screen.getByTestId("plan-brief").textContent).toBe("Brief left as it is (no objective or key messages given)");
    expect(within(screen.getByTestId("plan-role-Scout")).getByText("exists: kept")).toBeTruthy();
    expect(within(screen.getByTestId("plan-role-Reporter")).getByText("new, enabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update campaign" }));
    await waitFor(() => expect(screen.getByText(/uncommitted changes in AGENTS.md/)).toBeTruthy());
    expect(screen.queryByTestId("campaign-done")).toBeNull();
  });
});
