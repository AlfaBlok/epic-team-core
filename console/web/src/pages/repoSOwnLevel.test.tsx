// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Assignment, type Milestone, type Persona } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { SidebarNav } from "@/components/Layout";
import { TeamPage } from "@/pages/Team";
import { Ancestry, MilestonePage } from "@/pages/Milestone";
import { writerOf } from "@/pages/social/Pipeline";
import { repoLevelIds } from "@/lib/campaign";
import { SKINS, SkinProvider } from "@/lib/skin";

// The other campaign was a social world repo's own
// milestone, ": the memory service social presence": still in the sidebar and on Team home next to "Reddit awareness week 37", and
// Draft it on the all-campaigns board woke its switched-off Writer copy, so new Reddit drafts had no Campaign tag and were
// filed under. The repo's own level is not a campaign: the skin leaves it out; Draft it goes to the campaign's Writer.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const card = (over: Partial<CampaignCard>): CampaignCard => ({ ...mockCampaignCard(), repo: "social", ...over });
const WEEK37 = (milestoneId: string, retired = false) =>
  card({
    title: "Reddit awareness week 37",
    milestoneId,
    ...(retired ? { retired: true } : {}),
    campaign: { code: "PLAN-11", name: "Reddit awareness week 37", path: "docs/spines/campaign-reddit-awareness-week-37.md", platform: "Reddit", period: null },
  });

describe("the repo's own level is not a campaign", () => {
  it("repoLevelIds names a repo card only while the repo runs a live named campaign", () => {
    const repo = card({ title: "PLAN-0: Memo social presence", milestoneId: "ms_epic0" });
    const other = card({ repo: "brand-campaign", title: "Epic campaign", milestoneId: "ms_epic" });
    expect([...repoLevelIds([repo, WEEK37("ms_w37"), other])]).toEqual(["ms_epic0"]);
    // Retire week 37 (or have no campaign yet): the repo card is the repo's campaign again.
    expect(repoLevelIds([repo, WEEK37("ms_w37", true)]).size).toBe(0);
    expect(repoLevelIds([repo]).size).toBe(0);
  });

  it("the social skin's sidebar leaves PLAN-0 out of Other campaigns; the console skin still lists it", async () => {
    // the social menu folds everything after his pinned campaigns into More; open it as a press would.
    localStorage.setItem("sidebar.more.open", "1");
    const mk = (title: string, bigRoot?: number) => api.createMilestone({ title, repo: "acme-ai/social", path: "docs/spines/root.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
    const w37: Milestone = await mk("Reddit awareness week 37", 1);
    const epic0: Milestone = await mk("PLAN-0: Memo social presence");
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "social" } } as never);
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [WEEK37(w37.id), card({ title: epic0.title, milestoneId: epic0.id })] });
    const total = (await api.listMilestones()).filter((m) => !m.bigRoot).length;
    // the social menu lists real campaigns only: here week 37 and another campaign of the same repo, a job.
    const job = await mk("Launch post job");

    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>
      </SkinProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("other-milestones-toggle").textContent).toMatch(/^Other campaigns \(1\)/));
    fireEvent.click(screen.getByTestId("other-milestones-toggle"));
    expect(screen.getByText(job.title)).toBeTruthy();
    expect(screen.queryByText("PLAN-0: Memo social presence")).toBeNull();
    expect(screen.getAllByText("Reddit awareness week 37").length).toBeGreaterThan(0);
    cleanup();

    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("other-milestones-toggle").textContent).toMatch(new RegExp(`^More goals \\(${total + 1}\\)`)));
  });
});

describe("Team home in the social skin", () => {
  it("shows week 37 as a campaign and no PLAN-0 card under Other milestones", async () => {
    const w37 = await api.createMilestone({ title: "Reddit awareness week 37", repo: "acme-ai/social", path: "docs/spines/campaign-reddit-awareness-week-37.md", owner: "Sam", bigRoot: 1 });
    const epic0 = await api.createMilestone({ title: "PLAN-0: Memo social presence", repo: "acme-ai/social", path: "docs/spines/root.md", owner: "Sam" });
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "social" } } as never);
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [WEEK37(w37.id), card({ title: epic0.title, milestoneId: epic0.id })] });
    vi.spyOn(api, "getSocial").mockRejectedValue(new Error("not in this test"));
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </SkinProvider>,
    );
    await waitFor(() => expect(screen.getAllByText("Reddit awareness week 37").length).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelector(`a[href="/milestones/${epic0.id}"] h3, a[href="/milestones/${epic0.id}"] .text-base`)).toBeNull());
    expect([...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === `/milestones/${w37.id}`)).toBe(true);
  });
});

describe("Draft it on the all-campaigns board", () => {
  const writer = { id: "pe_w", name: "Writer", remit: "Pack role: Writer" } as Persona;
  const scout = { id: "pe_s", name: "Scout", remit: "Pack role: Scout" } as Persona;
  const asg = (id: string, milestoneId: string, personaId: string, enabled: boolean) => ({ id, milestoneId, personaId, enabled }) as Assignment;

  it("wakes the Writer working on the repo's campaign, not the switched-off copy on PLAN-0", () => {
    const all = [asg("as_off", "ms_epic0", "pe_w", false), asg("as_w37", "ms_w37", "pe_w", true), asg("as_s", "ms_epic0", "pe_s", true)];
    expect(writerOf("ms_epic0", all, [writer, scout], ["ms_w37"])).toEqual({ assignmentId: "as_w37", name: "Writer" });
    // On the campaign's own page: its own Writer.
    expect(writerOf("ms_w37", all, [writer, scout])).toEqual({ assignmentId: "as_w37", name: "Writer" });
    // A repo with no campaign: its own Writer, on or off, as before.
    expect(writerOf("ms_epic0", all, [writer, scout])).toEqual({ assignmentId: "as_off", name: "Writer" });
    expect(writerOf("ms_epic0", [asg("as_on", "ms_epic0", "pe_w", true), ...all], [writer], ["ms_w37"])).toEqual({ assignmentId: "as_on", name: "Writer" });
  });
});

describe("a retired campaign's page", () => {
  it("offers Restore, not Retire", async () => {
    const m = await api.createMilestone({ title: "Epic campaign: EpicSpine, the console skin, SocialApp", repo: "Acme/brand-campaign", path: "docs/spines/root.md", owner: "Sam" });
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "social" } } as never);
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [card({ repo: "brand-campaign", title: m.title, milestoneId: m.id, retired: true })] });
    vi.spyOn(api, "getSocial").mockRejectedValue(new Error("not in this test"));
    const restore = vi.spyOn(api, "restoreCampaign").mockResolvedValue({});
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={[`/milestones/${m.id}`]}>
          <Routes>
            <Route path="/milestones/:id" element={<MilestonePage />} />
          </Routes>
        </MemoryRouter>
      </SkinProvider>,
    );
    fireEvent.click(await screen.findByTestId("campaign-restore"));
    expect(screen.queryByTestId("campaign-retire")).toBeNull();
    await waitFor(() => expect(restore).toHaveBeenCalledWith("social", m.id));
  });
});

describe("week 37's breadcrumb", () => {
  it("leaves out the repo's own level (PLAN-0) when told; the console keeps the full trail", async () => {
    const repo = "acme-ai/social";
    const epic0 = { id: "ms_epic0", title: "PLAN-0: Memo social presence", repo, path: "docs/spines/root.md" } as Milestone;
    const w37 = { id: "ms_w37", title: "Reddit awareness week 37", repo, path: "docs/spines/campaign-reddit-awareness-week-37.md", doctrine: { servesChain: [{ path: "docs/spines/root.md", title: "PLAN-0: Memo social presence" }] } } as unknown as Milestone;
    vi.spyOn(api, "listMilestones").mockResolvedValue([epic0, w37]);
    vi.spyOn(api, "listRepos").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <Ancestry m={w37} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("PLAN-0: Memo social presence")).toBeTruthy();
    cleanup();
    render(
      <MemoryRouter>
        <Ancestry m={w37} hidden={new Set(["ms_epic0"])} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listMilestones).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("PLAN-0: Memo social presence")).toBeNull();
  });
});
