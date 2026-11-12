// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { OnePager, SocialData } from "@/api/types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";
import { DRAFT_SEED, draftedBy, planWithoutOnePager } from "@/pages/social/OnePager";

// the campaign one-pager on top of the Brief & directions tab. the owner owns every line
// (Save commits as him); Draft it with me asks the campaign chat; a draft the desk holds shows as a draft, never as his.

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

const PLAN =
  "Campaign tag: `PLAN-11`\nPlatform: Reddit\nOne-pager: Sam's, saved 2026-11-02\n\n### One-pager draft\n\nHeld for Sam: T11-S1, drafted by the Repo desk on 2026-11-03 from the plan. Not his decision until he approves it on his review card or saves the one-pager on the Brief tab.\n\n#### The bet\n\nThreads, not posts.\n\n### Why this campaign\n\nMy own why.\n\n### Key messages\n\n- Memory you own";
const CARD: CampaignCard = {
  ...mockCampaignCard(),
  repo: "social",
  title: "Reddit awareness week 37",
  milestoneId: "ms-memo",
  campaign: { code: "PLAN-11", name: "Reddit awareness week 37", path: "docs/spines/campaign-reddit-awareness-week-37.md", platform: "Reddit", period: null },
};
const social = (onePager: OnePager): SocialData => ({ tenantId: "social", repo: "social", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")), campaign: { ...CARD.campaign!, plan: PLAN, onePager } });
const EMPTY: OnePager = { state: "empty", line: null, fields: {}, draft: null };
const HELD: OnePager = {
  state: "owner",
  line: "Sam's, saved 2026-11-02",
  fields: { "Why this campaign": "My own why." },
  draft: { row: "T11-S1", note: "Held for Sam: T11-S1, drafted by the Repo desk on 2026-11-03 from the plan. Not his decision until he approves it.", fields: { "Why this campaign": "Desk's why.", "The bet": "Threads, not posts." } },
};

const page = (op: OnePager, path = "/milestones/ms-memo?tab=brief") => {
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockResolvedValue(social(op));
  return render(
    <SkinProvider skin={SKINS.console /* the social skin shows the five tabs; the old campaign tabs live on in the console skin */}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );
};

describe("the campaign one-pager on Brief & directions", () => {
  it("sits above the plan on the same tab (no new tab); the plan below no longer repeats the one-pager parts", async () => {
    page(EMPTY);
    const op = await screen.findByTestId("campaign-onepager");
    const plan = await screen.findByTestId("campaign-plan");
    expect(op.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const label of ["Why this campaign", "The bet", "What we measure", "What we hope", "My calls", "Not doing", "Approval"]) expect(within(op).getByLabelText(label)).toBeTruthy();
    expect(within(op).getByTestId("onepager-empty").textContent).toMatch(/No one-pager yet/);
    expect(await within(plan).findByText("Memory you own")).toBeTruthy();
    expect(within(plan).queryByText("My own why.")).toBeNull();
    expect(within(plan).queryByText(/One-pager draft/)).toBeNull();
    expect(screen.queryByRole("tab", { name: /one-pager/i })).toBeNull();
  });

  it("a held draft shows as a draft, not his: banner with its row, the draft's lines in the fields; Save as mine commits them as his", async () => {
    const save = vi.spyOn(api, "saveOnePager").mockResolvedValue({ commit: "abc1234def", closedDraft: "T11-S1" });
    page(HELD);
    const op = await screen.findByTestId("campaign-onepager");
    const banner = await within(op).findByTestId("onepager-draft-banner");
    expect(banner.textContent).toMatch(/Draft, not yours yet \(T11-S1\)/);
    expect(banner.textContent).toMatch(/Approve makes it yours/);
    expect((within(op).getByLabelText("The bet") as HTMLTextAreaElement).value).toBe("Threads, not posts.");
    expect((within(op).getByLabelText("Why this campaign") as HTMLTextAreaElement).value).toBe("Desk's why.");
    fireEvent.change(within(op).getByLabelText("What we hope"), { target: { value: "2 tester sign-ups" } });
    fireEvent.click(within(op).getByTestId("onepager-save"));
    await waitFor(() => expect(save).toHaveBeenCalledWith("social", "ms-memo", expect.objectContaining({ why: "Desk's why.", bet: "Threads, not posts.", hope: "2 tester sign-ups" })));
    expect((await within(op).findByTestId("onepager-save-note")).textContent).toMatch(/Saved as yours · commit abc1234 · draft T11-S1 closed/);
  });

  it("Draft it with me sends the seed to this campaign's chat and opens its Chat tab", async () => {
    const send = vi.spyOn(api, "sendMilestoneChatMessage").mockResolvedValue({ threadId: "t", pending: true });
    vi.spyOn(api, "getMilestoneChat").mockResolvedValue({ messages: [], pending: false } as never);
    page(EMPTY);
    fireEvent.click(await screen.findByTestId("onepager-draft-with-me"));
    await waitFor(() => expect(send).toHaveBeenCalledWith("ms-memo", DRAFT_SEED, "Reddit awareness week 37 · Brief & directions", expect.stringMatching(/^onepager-seed:ms-memo:/)));
    expect(await screen.findByTestId("milestone-chat")).toBeTruthy();
  });

  it("the banner says who drafted it once, without the note's third-person sentence", () => {
    expect(draftedBy("Held for Sam: T11-S1, drafted by the Repo desk on 2026-11-03 from the plan. Not his decision until he approves it.")).toBe("Drafted by the Repo desk on 2026-11-03 from the plan.");
    expect(draftedBy("free text")).toBe("free text");
  });

  it("planWithoutOnePager drops the one-pager parts, the draft and the One-pager line, keeps the rest", () => {
    const p = planWithoutOnePager(PLAN);
    expect(p).not.toMatch(/One-pager|Why this campaign|Threads, not posts/);
    expect(p).toContain("Platform: Reddit");
    expect(p).toContain("### Key messages\n\n- Memory you own");
  });
});
