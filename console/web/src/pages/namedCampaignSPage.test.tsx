// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { SocialData, SocialPost } from "@/api/types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { NewCampaignPage } from "@/pages/Campaigns";
import { loadDrafts } from "@/components/draftsToApprove";
import { MilestoneDialog } from "@/components/dialogs";
import { narrowToCampaign } from "@/lib/useSocialWrite";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";

// named campaigns inside a repo. The campaign's page reads only its
// rows (`?campaign=<code>`), shows its plan on the Brief tab (Edit plan), and is renamed or retired from its header; a retired
// one comes back from Add campaign or job; New campaign in a repo that runs campaigns makes a named one with a plan and roles.

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

const PLAN = "Campaign tag: `EPIC-905`\nPlatform: Reddit\nPeriod: 2026-11-02 to 2026-11-08\n\n### Key messages\n\n- Memory you own";
const NAMED: CampaignCard = {
  ...mockCampaignCard(),
  repo: "social",
  title: "Reddit awareness week 37",
  milestoneId: "ms-memo",
  campaign: { code: "EPIC-905", name: "Reddit awareness week 37", path: "docs/spines/campaign-reddit-awareness-week-37.md", platform: "Reddit", period: "2026-11-02 to 2026-11-08" },
};
const post = (id: string, campaign: string | null, status = "held"): SocialPost =>
  ({ id, date: "2026-11-02", persona: "Writer", kind: "post", platform: "Reddit", campaign, community: null, slot: null, title: id, text: id, format: null, assets: [], topic: null, highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status, _line: 5 }) as SocialPost;
const social = (repo: string, campaign?: string): SocialData => {
  const data = sampleSocialExport(new Date("2026-11-02T10:00:00Z"));
  data.posts = [post("P-0001", null), post("P-0002", "EPIC-905"), post("P-0003", "epic-905")];
  return { tenantId: "social", repo, data, ...(campaign ? { campaign: { ...NAMED.campaign!, plan: PLAN } } : {}) };
};

let asked: [string | undefined, string | undefined][] = [];
beforeEach(() => {
  asked = [];
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [NAMED] });
  vi.spyOn(api, "getSocial").mockImplementation(async (_t: string, repo?: string, campaign?: string) => (asked.push([repo, campaign]), social(repo ?? "social", campaign)));
});

const page = (path: string) =>
  render(
    <SkinProvider skin={SKINS.console /* the social skin shows the five tabs; the old campaign tabs live on in the console skin */}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
          <Route path="/" element={<div>team home</div>} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("a named campaign's page", () => {
  it("reads only its rows (?campaign=<code>) and shows its plan on the Brief tab; Edit plan saves it as the section", async () => {
    const save = vi.spyOn(api, "setCampaignPlan").mockResolvedValue({});
    page("/milestones/ms-memo?tab=brief");
    const panel = await screen.findByTestId("campaign-plan");
    expect(await within(panel).findByText("Memory you own")).toBeTruthy();
    expect(within(panel).getByTestId("campaign-plan-source").textContent).toContain("Reddit · 2026-11-02 to 2026-11-08");
    expect(within(panel).getByTestId("campaign-plan-source").textContent).toContain("tag EPIC-905");
    expect(asked).toContainEqual(["social", "EPIC-905"]);
    expect(asked.every(([, c]) => c === "EPIC-905")).toBe(true);
    expect(screen.getByTestId("brief-source").textContent).toMatch(/The brief every campaign of this repo shares/);
    fireEvent.click(within(panel).getByTestId("campaign-plan-edit"));
    const text = within(panel).getByTestId("campaign-plan-text") as HTMLTextAreaElement;
    expect(text.value).toBe(PLAN);
    fireEvent.change(text, { target: { value: `${PLAN}\n- Open source` } });
    fireEvent.click(within(panel).getByTestId("campaign-plan-save"));
    await waitFor(() => expect(save).toHaveBeenCalledWith("social", "ms-memo", `${PLAN}\n- Open source`));
    expect(await within(panel).findByText(/Plan saved and committed as you/)).toBeTruthy();
  });

  it("Rename asks for the name and keeps the tag; Retire says nothing is deleted, then goes home", async () => {
    const rename = vi.spyOn(api, "renameCampaign").mockResolvedValue({});
    const retire = vi.spyOn(api, "retireCampaign").mockResolvedValue({});
    page("/milestones/ms-memo");
    fireEvent.click(await screen.findByTestId("campaign-rename"));
    expect(screen.getByText(/Its posts keep their tag EPIC-905/)).toBeTruthy();
    const input = screen.getByTestId("campaign-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Reddit awareness week 37");
    fireEvent.change(input, { target: { value: "Reddit awareness, November" } });
    fireEvent.click(screen.getByTestId("campaign-rename-save"));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("social", "ms-memo", "Reddit awareness, November"));
    fireEvent.click(screen.getByTestId("campaign-retire"));
    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("campaign-retire-confirm"));
    await waitFor(() => expect(retire).toHaveBeenCalledWith("social", "ms-memo"));
    expect(await screen.findByText("team home")).toBeTruthy();
  });

  it("a repo card (no campaign) reads the whole repo and has no plan panel", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [{ ...NAMED, campaign: undefined, title: "Memo social presence" }] });
    page("/milestones/ms-memo?tab=brief");
    expect(await screen.findByTestId("brief-source")).toBeTruthy();
    expect(screen.queryByTestId("campaign-plan")).toBeNull();
    expect(asked.every(([, c]) => c === undefined)).toBe(true);
  });
});

describe("lists with several campaigns in one repo", () => {
  it("Drafts to approve reads each repo once and files a tagged draft under its campaign; a retired campaign's drafts leave the list", async () => {
    const repoCard: CampaignCard = { ...mockCampaignCard(), repo: "social", title: "Memo social presence", milestoneId: "ms-root", held: 3 };
    const retired: CampaignCard = { ...NAMED, milestoneId: "ms-old", title: "Old", campaign: { ...NAMED.campaign!, code: "EPIC-903", name: "Old" }, retired: true };
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [NAMED, repoCard, retired] });
    vi.spyOn(api, "getSocial").mockImplementation(async (_t: string, repo?: string) => {
      asked.push([repo, undefined]);
      const d = social(repo ?? "?");
      d.data.posts.push(post("P-0004", "EPIC-903"));
      return d;
    });
    const { items } = await loadDrafts();
    expect(asked).toEqual([["social", undefined]]);
    expect(items.map((i) => [i.post.id, i.campaign, i.milestoneId])).toEqual([
      ["P-0001", "Memo social presence", "ms-root"],
      ["P-0002", "Reddit awareness week 37", "ms-memo"],
      ["P-0003", "Reddit awareness week 37", "ms-memo"],
    ]);
  });

  it("narrowToCampaign keeps the campaign's rows (code any case, or its name) after a write answers with the whole repo", () => {
    const d = social("social");
    d.data.posts.push(post("P-0009", "Reddit awareness week 37"));
    expect(narrowToCampaign(d, "EPIC-905", "Reddit awareness week 37").data.posts.map((p) => p.id)).toEqual(["P-0002", "P-0003", "P-0009"]);
    expect(narrowToCampaign(d, "EPIC-905").data.posts.map((p) => p.id)).toEqual(["P-0002", "P-0003"]);
  });

  it("Add campaign or job lists retired campaigns with Restore", async () => {
    const restore = vi.spyOn(api, "restoreCampaign").mockResolvedValue({});
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [NAMED, { ...NAMED, milestoneId: "ms-old", title: "Epic campaign: EpicSpine, EpicTeam, SocialApp", campaign: undefined, retired: true }] });
    vi.spyOn(api, "listPersonas").mockResolvedValue([]);
    const created = vi.fn();
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <MilestoneDialog open onOpenChange={() => undefined} onCreated={created} offerCampaign onCampaign={() => undefined} />
        </MemoryRouter>
      </SkinProvider>,
    );
    const box = await screen.findByTestId("retired-campaigns");
    expect(within(box).getByText("Epic campaign: EpicSpine, EpicTeam, SocialApp")).toBeTruthy();
    expect(within(box).queryByText("Reddit awareness week 37")).toBeNull();
    fireEvent.click(within(box).getByTestId("campaign-restore"));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("social", "ms-old"));
    expect(created).toHaveBeenCalledWith({ id: "ms-old" });
    // the job's repo picker lists the repo once
    const repoSelect = screen.getByLabelText("Repo") as HTMLSelectElement;
    expect([...repoSelect.options].map((o) => o.value)).toEqual(["social"]);
  });
});

describe("New campaign in a repo that runs campaigns", () => {
  it("makes a named campaign: name kept as written, the plan parts given, the roles that work it; then opens its Brief", async () => {
    vi.spyOn(api, "listCampaignRepos").mockResolvedValue([{ name: "social", remote: "acme-ai/social", hasPack: true, campaign: true }]);
    const create = vi.spyOn(api, "createNamedCampaign").mockResolvedValue({ milestoneId: "ms-new" } as never);
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={["/campaigns/new"]}>
          <Routes>
            <Route path="/campaigns/new" element={<NewCampaignPage />} />
            <Route path="/milestones/:id" element={<div>campaign page</div>} />
          </Routes>
        </MemoryRouter>
      </SkinProvider>,
    );
    fireEvent.click(await screen.findByRole("radio", { name: /acme-ai\/social/ }));
    expect(screen.getByTestId("rerun-setup")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    const form = await screen.findByTestId("named-campaign-form");
    // it opens prefilled from the campaign template, with the example plan's answer beside each part
    expect(await within(form).findByTestId("named-campaign-template")).toBeTruthy();
    await waitFor(() => expect((within(form).getByLabelText("Frame") as HTMLTextAreaElement).value).toBe("(to fill in: the one idea every post serves)"));
    expect(within(form).getByTestId("named-frame-example").textContent).toMatch(/Example: Bring your context home/);
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Reddit awareness week 37" } });
    fireEvent.change(within(form).getByLabelText("Channels"), { target: { value: "Reddit" } });
    fireEvent.change(within(form).getByLabelText("Key messages (one per line)"), { target: { value: "- Memory you own\nOpen source\n" } });
    // the brief's other set parts
    fireEvent.change(within(form).getByLabelText("Format"), { target: { value: "text only" } });
    fireEvent.change(within(form).getByLabelText("Cadence: the equal test"), { target: { value: "Reddit: 1 thread a day" } });
    fireEvent.change(within(form).getByLabelText("Reader action"), { target: { value: "answer the question" } });
    fireEvent.click(within(form).getByLabelText("Writer"));
    fireEvent.click(within(form).getByLabelText("Responder"));
    fireEvent.click(within(form).getByTestId("named-campaign-create"));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("social", { repo: "social", name: "Reddit awareness week 37", plan: { platform: "Reddit", format: "text only", cadence: "Reddit: 1 thread a day", readerAction: "answer the question", frame: "(to fill in: the one idea every post serves)", keyMessages: ["Memory you own", "Open source"] }, roles: ["Writer", "Responder"], template: true }),
    );
    expect(await screen.findByText("campaign page")).toBeTruthy();
  });
});
