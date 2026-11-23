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
const WHEEL_PLAN = {
  product: "Memo",
  wheels: [
    {
      id: "memo-channels",
      name: "Memo: Get every channel working",
      keyResults: ["Every channel posted in the last 7 days"],
      plan: {
        id: "memo-channels",
        path: "docs/scorecards/memo-channels.json",
        present: true,
        line: "Get LinkedIn posting, then every channel.",
        keyResults: [{ kr: 1, how: "LinkedIn first, then X.", steps: [{ do: "LinkedIn posts every day", owner: "Engager", by: "2026-11-25", done: true }, { do: "X posts every day", owner: "Engager", by: "2026-11-28" }], greenWhen: "Every channel posted this week." }],
      },
    },
  ],
};
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
  vi.spyOn(api, "getCampaignWheelPlan").mockResolvedValue(WHEEL_PLAN);
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
  it("opens on Plan (it took the Deck's place); the graph's tabs Plan, Product, Benefits, Social kit, Inbox, Chat, Pipeline, Tasks, Trackers, Lessons, History; Summary, Tree, Activity, Personas, Settings are gone; one Settings and personas button", async () => {
    page("/milestones/ms-memo");
    const tabs = await screen.findByTestId("five-tabs");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Plan", "Product", "Benefits", "Social kit", "Inbox", "Chat", "Pipeline", "Tasks", "Trackers", "Lessons", "History"]);
    expect(await screen.findByTestId("plan-tab")).toBeTruthy();
    expect(screen.queryByTestId("brief-tab")).toBeNull();
    for (const gone of ["Summary", "Tree", "Activity", "Personas", "Settings", "more"]) expect(within(tabs).queryByRole("tab", { name: new RegExp(`^${gone}`) })).toBeNull();
    expect(screen.getByTestId("settings-and-personas").getAttribute("href")).toBe("/milestones/ms-memo?tab=settings");
  });

  // the owner 22 Nov: "benefits is like an extreme thing ... We need a tracker, man. Trackers are everywhere".
  it("the Benefits tab shows each benefit as the user reads it, whether it works today, and its screen", async () => {
    totems = { ...totems, benefits: { source: "data/brief.md · Benefits", asked: [{ id: "L-3", text: "Finds the threads where people have your problem." }], lines: [
      { id: "1", does: "Writes posts from your ideas.", benefit: "You show up every day.", status: "works today", soon: false, screen: { label: "Ideas", path: "data/assets/benefits/s1.webp", url: "/s1.webp" } },
      { id: "2", does: "Checks what worked.", benefit: "Posts get better.", status: "half built", soon: true },
    ] } };
    page("/milestones/ms-memo?tab=benefits");
    const tab = await screen.findByTestId("benefits-tab");
    const lines = within(tab).getAllByTestId("benefit-line");
    expect(lines.map((l) => within(l).getByText(/^You show|^Posts get/).textContent)).toEqual(["You show up every day.", "Posts get better."]);
    expect(within(tab).getAllByTestId("benefit-status").map((s) => s.textContent)).toEqual(["works today", "half built, coming soon"]);
    expect(within(lines[0]).getByRole("img").getAttribute("src")).toBe("/s1.webp");
    expect(within(screen.getByTestId("benefits-asked")).getByText(/Finds the threads/)).toBeTruthy();
  });

  it("the Benefits tab says so when the product has none written", async () => {
    totems = { ...totems, benefits: { source: null, lines: [], asked: [] } };
    page("/milestones/ms-memo?tab=benefits");
    expect(await screen.findByTestId("benefits-none")).toBeTruthy();
  });

  it("the Trackers tab shows the shortlists of the objective the campaign serves, named", async () => {
    vi.spyOn(api, "getCampaignTrackers").mockResolvedValue({ product: "Memo", wheels: [{ wheel: "memo-channels", name: "Memo: Get every channel working", tables: [{ id: "influencers", name: "Influencers", columns: ["Name", "Status"], statuses: ["candidate"], from: "own", open: true, rows: [["Ada", "candidate"]], counts: [{ status: "candidate", n: 1 }], file: "docs/trackers/memo-channels/influencers.csv" }] }] });
    page("/milestones/ms-memo?tab=trackers");
    const tab = await screen.findByTestId("trackers-tab");
    expect(tab.getAttribute("data-tables")).toBe("1");
    expect(within(tab).getByText("Memo: Get every channel working")).toBeTruthy();
    expect(within(tab).getByText("Influencers")).toBeTruthy();
  });

  // the owner 22 Nov (vn_f405ae72): "It's not a marketing plan, man. It's the plan. It's the plan for the wheel".
  it("the Plan tab is the plan of the objective the campaign serves, per key result, never a marketing plan", async () => {
    page("/milestones/ms-memo?tab=plan");
    const tab = await screen.findByTestId("plan-tab");
    expect(tab.getAttribute("data-plan")).toBe("wheel");
    expect(within(tab).getByTestId("plan-wheel").textContent).toBe("Memo: Get every channel working");
    expect(within(tab).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Every channel posted in the last 7 days"]);
    expect(within(tab).getAllByTestId("plan-step")).toHaveLength(2);
    expect(tab.id).toBe("plan-memo-channels");
    expect(within(tab).getByTestId("plan-kr").id).toBe("plan-memo-channels-kr-1");
    expect(within(tab).getByTestId("plan-green-when").textContent).toBe("Every channel posted this week.");
    expect(screen.queryByTestId("plan-edit")).toBeNull();
    expect(document.body.textContent).not.toMatch(/marketing plan/i);
  });

  it("a campaign that serves no objective says its plan is the plan of the objective it moves", async () => {
    vi.spyOn(api, "getCampaignWheelPlan").mockResolvedValue({ product: null, wheels: [] });
    page("/milestones/ms-memo?tab=plan");
    expect((await screen.findByTestId("campaign-wheel-plan-none")).textContent).toMatch(/plan of the objective it moves/);
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

  it("History: Logs and notes lists every file the tab homes for the campaign's repo, each opening read-only", async () => {
    // the seed's campaign: memo-ai/memo, its spine docs/spines/launch.md.
    const entry = (open: string, spine?: string) => ({ id: `memo:${open}`, repo: "memo", path: open, open, title: open, kind: "note" as const, files: 1, date: "2026-11-20T00:00:00Z", ...(spine ? { spine } : {}) });
    vi.spyOn(api, "homeTab").mockResolvedValue({ product: "all", tab: "history", label: "History", repos: ["memo"], patterns: [], homed: 4, covered: 4, entries: [entry("docs/log/launch/2026-W47.md", "docs/spines/launch.md"), entry("docs/log/root/2026-W47.md", "docs/spines/root.md"), entry("docs/outcomes/2026-11-20.jsonl"), { ...entry("docs/log/root/2026-W47.md"), id: "other:x", repo: "other" }] });
    page("/milestones/ms-memo?tab=history&history=files");
    const own = await screen.findByTestId("history-files");
    const rest = screen.queryByTestId("history-files-rest");
    // nothing missing: the campaign's own logs plus the rest of its repo's are every homed file of the repo.
    expect(Number(own.getAttribute("data-count")) + Number(rest?.getAttribute("data-count") ?? 0)).toBe(3);
    expect(own.getAttribute("data-count")).toBe("1");
    expect(screen.getAllByTestId("history-files-row")[0].querySelector("a")?.getAttribute("href")).toBe("/api/homes/file/memo/docs/log/launch/2026-W47.md");
  });

  it("Social kit (a node of the graph) is a tab of its own: the campaign's channels, never under the plan", async () => {
    page("/milestones/ms-memo?tab=kit");
    expect(await screen.findByTestId("campaign-kit")).toBeTruthy();
    expect(screen.queryByTestId("campaign-under-plan")).toBeNull();
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
