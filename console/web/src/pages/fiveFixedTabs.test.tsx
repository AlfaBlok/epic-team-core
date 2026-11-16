// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import type { CampaignTotems } from "@/api/types";
import type { MarketingPlan } from "@/api/campaign-types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { MilestonePage } from "@/pages/Milestone";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { fiveTabFromParams, mockTotems, slideNote, splitTaskCodes, absoluteLinks } from "@/lib/totems";

// a campaign in the social skin has five fixed tabs,
// each a part of its epic file; the console skin keeps its tabs (L-5: the build team's console waits a week).

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

const CARD = { ...mockCampaignCard(), repo: "social", remote: "memo-ai/social", title: "Reddit awareness week 37", milestoneId: "ms-memo" };
let totems: CampaignTotems;
// the campaign's Plan, eight fixed sections; two written, the rest not yet.
const TITLES = ["Goal and numbers", "Who", "Messages", "Channels", "Offer", "This week's test", "Budget", "How we measure and change"];
const KEYS = ["goal", "who", "messages", "channels", "offer", "test", "budget", "measure"] as const;
const PLAN: MarketingPlan = {
  source: "spine",
  path: "docs/spines/c.md",
  repo: "social",
  line: "Bring your context home.",
  missing: [],
  sections: KEYS.map((key, i) => ({
    key,
    title: TITLES[i],
    written: key === "goal" || key === "offer",
    lead: key === "offer" ? "Your first 30 memories free." : null,
    boxes: key === "offer" ? [{ label: "Gets", text: "first 30 memories free", note: "no card" }] : [],
    table: key === "goal" ? { head: ["Step", "Today", "Goal"], rows: [["Signed up", "1", "10"]] } : null,
    quotes: [],
  })),
};
let sent: string[] = [];
beforeEach(() => {
  totems = mockTotems();
  sent = [];
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "social", repo: "social", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")) });
  vi.spyOn(api, "getCampaignTotems").mockImplementation(async () => totems);
  vi.spyOn(api, "getCampaignPlan").mockResolvedValue(PLAN);
  vi.spyOn(api, "getMilestoneChat").mockResolvedValue({ messages: [] } as never);
  vi.spyOn(api, "sendMilestoneChatMessage").mockImplementation(async (_id: string, text: string) => (sent.push(text), { threadId: "t", pending: true }));
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
}
const page = (path: string, skin: Skin = SKINS.social) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/milestones/:id"
            element={
              <>
                <MilestonePage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("E964-S14 five fixed tabs", () => {
  it("opens on Plan (it took the Deck's place); Plan, Product, Waiting on me, Pipeline, Tasks, Observations, History, Chat; Summary, Tree, Activity, Personas, Settings are gone; one Settings and personas button", async () => {
    page("/milestones/ms-memo");
    const tabs = await screen.findByTestId("five-tabs");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Plan", "Product", "Waiting on me", "Pipeline", "Tasks", "Observations", "History", "Chat"]);
    expect(await screen.findByTestId("plan-tab")).toBeTruthy();
    expect(screen.queryByTestId("brief-tab")).toBeNull();
    for (const gone of ["Summary", "Tree", "Activity", "Personas", "Settings", "more"]) expect(within(tabs).queryByRole("tab", { name: new RegExp(`^${gone}`) })).toBeNull();
    expect(screen.getByTestId("settings-and-personas").getAttribute("href")).toBe("/milestones/ms-memo?tab=settings");
  });

  it("the Plan tab shows the eight fixed sections in order, written ones as boxes, the rest Not written yet", async () => {
    page("/milestones/ms-memo?tab=plan");
    const tab = await screen.findByTestId("plan-tab");
    expect(within(tab).getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/^\d+/, ""))).toEqual(TITLES);
    expect(within(screen.getByTestId("plan-section-offer")).getByText("first 30 memories free")).toBeTruthy();
    expect(within(screen.getByTestId("plan-section-goal")).getByTestId("plan-funnel").textContent).toContain("today 1 · goal 10");
    expect(within(tab).getAllByTestId("plan-not-written")).toHaveLength(6);
  });

  it("the console skin's campaign has the Plan tab too", async () => {
    page("/milestones/ms-memo?tab=plan", SKINS.console);
    expect(await screen.findByTestId("plan-tab")).toBeTruthy();
    expect(screen.getByTestId("tab-plan")).toBeTruthy();
  });

  it("old links land on the tab that holds what they showed", () => {
    const t = (s: string) => fiveTabFromParams(new URLSearchParams(s));
    expect([t(""), t("tab=brief"), t("tab=summary"), t("tab=pipeline"), t("tab=work&view=posts"), t("tab=waiting"), t("tab=approvals"), t("tab=tree"), t("tab=activity"), t("tab=personas"), t("tab=history"), t("node=x")]).toEqual(["plan", "plan", "plan", "pipeline", "pipeline", "waiting", "waiting", "work", "history", "settings", "history", "work"]);
    expect(t("tab=deck")).toBe("plan");
  });

  it("the console skin keeps its tabs on the same campaign", async () => {
    page("/milestones/ms-memo", SKINS.console);
    expect(await screen.findByRole("tab", { name: "Pipeline" })).toBeTruthy();
    expect(screen.queryByTestId("five-tabs")).toBeNull();
  });

  it("Tasks: the goal path, Add task (a row through the tree writer), then the task groups (Waiting on me and Pipeline are tabs of their own)", async () => {
    const add = vi.spyOn(api, "addToTree").mockResolvedValue({ kind: "row", path: "x", id: "E911-S7", ready: true } as never);
    page("/milestones/ms-memo?tab=work&row=E911-S4");
    expect((await screen.findByTestId("goal-path")).textContent).toBe("Memo social presence›Reddit awareness week 37›3 tasks");
    fireEvent.change(screen.getByTestId("add-task-title"), { target: { value: "Research which subreddits allow a demo video" } });
    fireEvent.click(screen.getByTestId("add-task-send"));
    await waitFor(() => expect(add).toHaveBeenCalledWith("ms-memo", { kind: "row", title: "Research which subreddits allow a demo video" }));
    expect((await screen.findByTestId("add-task-result")).textContent).toContain("Added E911-S7");
    const groups = screen.getByTestId("task-groups");
    expect(within(groups).getAllByTestId("task-row").map((r) => r.getAttribute("data-row"))).toEqual(["E911-S1", "E911-S2", "E911-S4"]);
    // ?row= opens the folded Done group and marks the row
    expect(screen.getByTestId("tasks-done").textContent).toContain("Research a fresh question");
    expect(screen.queryByTestId("work-view")).toBeNull();
  });

  it("Observations: in force, a proposed brief change with Add to the brief / Not now, retired kept", async () => {
    const decide = vi.spyOn(api, "decideProposal").mockResolvedValue({ commit: "abc" });
    page("/milestones/ms-memo?tab=observations");
    expect((await screen.findByTestId("obs-force-count")).textContent).toBe("2");
    expect(screen.getByTestId("obs-proposals").textContent).toContain("End every reply on one specific question.");
    fireEvent.click(screen.getByTestId("proposal-add"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("social", "ms-memo", { file: "docs/spines/campaign-reddit-awareness-week-37.md", id: "L-4", action: "add" }));
    expect(screen.getByTestId("obs-retired-count").textContent).toBe("1");
  });

  it("History: weeks, then days, one line per wake; Decisions marked; task codes link to Work", async () => {
    page("/milestones/ms-memo?tab=history");
    const week = await screen.findByTestId("history-week");
    expect(week.textContent).toContain("Week 45");
    expect(week.textContent).toContain("running: 1 of 3 threads out");
    const lines = screen.getAllByTestId("history-line");
    expect(lines.map((l) => l.getAttribute("data-kind"))).toEqual(["decision", "wake", "owner"]);
    expect(lines[2].textContent).toContain("You");
    const code = within(lines[1]).getByTestId("task-link");
    expect(code.getAttribute("href")).toBe("/milestones/ms-memo?tab=work&row=E911-S4");
    expect(within(lines[1]).getByText("I-15").getAttribute("href")).toBe("https://github.com/memo-ai/social/blob/HEAD/data/ideas.md");
    fireEvent.click(within(screen.getByTestId("history-filter")).getByText("Decisions"));
    await waitFor(() => expect(screen.getAllByTestId("history-line").map((l) => l.getAttribute("data-kind"))).toEqual(["decision"]));
  });

  it("Chat is the campaign chat with words on where notes land", async () => {
    page("/milestones/ms-memo?tab=chat");
    expect(await screen.findByTestId("milestone-chat")).toBeTruthy();
    expect(screen.getByText(/Each reply says where your words landed/)).toBeTruthy();
  });
});

describe("E964-S14 helpers", () => {
  it("slideNote carries the slide's number, title, file and ref", () => {
    expect(slideNote({ n: 5, title: "Voice", file: "f.md", ref: "## A > ### Voice" }, " hi ")).toBe("[slide 5: Voice · file f.md · ref ## A > ### Voice] hi");
  });
  it("task codes split out, but not inside a link", () => {
    expect(splitTaskCodes("E911-S4 idea, [E911-S5](x) and E911-S6.")).toEqual([{ code: "E911-S4" }, { text: " idea, [E911-S5](x) and " }, { code: "E911-S6" }, { text: "." }]);
  });
  it("relative links go to GitHub, images and unsafe links drop to their label", () => {
    expect(absoluteLinks("[a](../../../data/x.md) ![i](p.png) [b](javascript:alert(1)) [c](https://x.io)", { remote: "o/r", path: "docs/log/c/2026-W45.md" })).toBe("[a](https://github.com/o/r/blob/HEAD/data/x.md) i b) [c](https://x.io)");
  });
});
