// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { ProductPage } from "@/pages/social/Motion";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";
import { mockTotems } from "@/lib/totems";
import { sampleCampaignProduct, sampleMotionSpines, sampleProduct } from "@/lib/motionSample";
import { CAMPAIGN_PRODUCT_PARTS, computeMotion, parseProduct } from "../../../server/src/social/motionCompute";

// (a social world repo's desk note; the owner on their: "make a proposal I can examine on a post (on the deck?)
// I'll give answer in situ"): every Product tab slide has the Brief slide's note box; the note is filed to the campaign's
// spine with the slide named, then handed to the campaign chat; his past notes on the slide show beside it.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => localStorage.clear());
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const CARD = {
  ...mockCampaignCard(),
  repo: "brand-campaign",
  remote: "Acme/brand-campaign",
  title: "Get testers",
  milestoneId: "ms-memo",
  campaign: { code: "PLAN-1", name: "Get testers", path: "docs/spines/campaign-get-testers.md", platform: "Reddit and X", period: null },
};
const motion = (campaign?: string) => {
  const m = computeMotion({ signups: [], siteViews: [], snapshots: [], posts: [] }, sampleMotionSpines);
  return {
    tenantId: "w",
    repo: "brand-campaign",
    repos: ["brand-campaign"],
    today: "2026-11-08",
    product: parseProduct(sampleProduct),
    ...(campaign ? { campaignProduct: { code: "PLAN-1", name: "Get testers", spine: "docs/spines/campaign-get-testers.md", ...parseProduct(sampleCampaignProduct, "docs/campaigns/epic-1/product.md", CAMPAIGN_PRODUCT_PARTS) } } : {}),
    ...m,
  };
};
const FILE = "docs/campaigns/epic-1/product.md";
const NOTES = [
  { date: "2026-11-08", file: FILE, slide: "What we push", note: "Older note on slide one.", noteBy: "Sam's" },
  { date: "2026-11-09", file: FILE, slide: "Why now", note: "A note on slide two.", noteBy: "Sam's" },
  { date: "2026-11-09", file: "data/product.md", slide: "What we push", note: "Same title, the project's deck.", noteBy: "Sam's" },
];
let asked: (string | undefined)[] = [];
beforeEach(() => {
  asked = [];
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "w" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "w", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "w", repo: "brand-campaign", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")) });
  vi.spyOn(api, "getCampaignTotems").mockImplementation(async () => ({ ...mockTotems(), productNotes: NOTES }));
  vi.spyOn(api, "getSocialMotion").mockImplementation(async (_t: string, _r?: string, campaign?: string) => (asked.push(campaign), motion(campaign) as never));
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
const page = (path: string) =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/milestones/:id" element={<><MilestonePage /><Where /></>} />
          <Route path="/product" element={<><ProductPage /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T78-S13: a note box on every Product tab slide", () => {
  it("shows the shared box (paperclip, mic, Send) and only this slide's past notes, which follow the slide", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/milestones/ms-memo/voice/state" ? { enabled: true, monthUsd: 0, limits: { monthCapUsd: 25 } } : {}), { status: 200, headers: { "content-type": "application/json" } })));
    page("/milestones/ms-memo?tab=product");
    const box = await screen.findByTestId("product-note");
    expect(within(box).getByTestId("product-note-box")).toBeTruthy();
    expect(within(box).getByTestId("words-tools")).toBeTruthy();
    expect(within(box).getByTestId("chat-attach")).toBeTruthy();
    expect(await within(box).findByTestId("answer-voice-button")).toBeTruthy();
    const notes = await screen.findByTestId("product-notes");
    await waitFor(() => expect(within(notes).getAllByTestId("product-note-line").map((l) => l.textContent)).toEqual(["8 Nov Older note on slide one."]));
    fireEvent.click(screen.getByRole("button", { name: /2\. Why now/ }));
    await waitFor(() => expect(within(screen.getByTestId("product-notes")).getAllByTestId("product-note-line").map((l) => l.textContent)).toEqual(["9 Nov A note on slide two."]));
  });

  it("Send files the note with the slide named, then hands it to the campaign chat; the note shows at once", async () => {
    const file = vi.spyOn(api, "fileProductNote").mockResolvedValue({ n: 1, commit: "abc", notes: [{ date: "2026-11-09", file: FILE, slide: "What we push", note: "Yes to the metric.", noteBy: "Sam's" }] });
    const chat = vi.spyOn(api, "sendMilestoneChatMessage").mockResolvedValue({ threadId: "t", pending: false });
    page("/milestones/ms-memo?tab=product");
    const box = await screen.findByTestId("product-note");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Yes to the metric." } });
    fireEvent.click(within(box).getByTestId("product-note-send"));
    await waitFor(() => expect(file).toHaveBeenCalledWith("w", "ms-memo", { file: FILE, slide: "What we push", note: "Yes to the metric." }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith("ms-memo", `[product slide 1: What we push · file ${FILE}] Yes to the metric.`));
    expect((await within(box).findByRole("status")).textContent).toMatch(/^Filed in the campaign's spine and sent to the campaign chat/);
    await waitFor(() => expect(within(screen.getByTestId("product-notes")).getAllByTestId("product-note-line").map((l) => l.textContent)).toEqual(["9 Nov Yes to the metric.", "8 Nov Older note on slide one."]));
  });

  it("a filing that fails says so at the button and sends nothing to the chat", async () => {
    vi.spyOn(api, "fileProductNote").mockRejectedValue(new Error("the spine write was refused"));
    const chat = vi.spyOn(api, "sendMilestoneChatMessage").mockResolvedValue({ threadId: "t", pending: false });
    page("/milestones/ms-memo?tab=product");
    const box = await screen.findByTestId("product-note");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "No." } });
    fireEvent.click(within(box).getByTestId("product-note-send"));
    expect((await within(box).findByRole("status")).textContent?.trim()).toBe("Not filed: the spine write was refused");
    expect(chat).not.toHaveBeenCalled();
  });

  it("the project's own Product page has no note box (it belongs to no campaign)", async () => {
    page("/product?project=brand-campaign");
    await screen.findByTestId("product-slide");
    expect(screen.queryByTestId("product-note")).toBeNull();
  });
});
