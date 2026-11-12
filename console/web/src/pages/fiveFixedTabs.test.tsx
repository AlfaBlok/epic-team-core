// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import type { CampaignTotems } from "@/api/types";
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
let sent: string[] = [];
beforeEach(() => {
  totems = mockTotems();
  sent = [];
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "social", repo: "social", data: sampleSocialExport(new Date("2026-11-03T10:00:00Z")) });
  vi.spyOn(api, "getCampaignTotems").mockImplementation(async () => totems);
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
  it("opens on Deck; E978-S1 round 2: Deck, Product, Waiting on me, Pipeline, Tasks, Observations, History, Chat; Summary, Tree, Activity, Personas, Settings are gone; one Settings and personas button", async () => {
    page("/milestones/ms-memo");
    const tabs = await screen.findByTestId("five-tabs");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Deck", "Product", "Waiting on me", "Pipeline", "Tasks", "Observations", "History", "Chat"]);
    expect(await screen.findByTestId("brief-tab")).toBeTruthy();
    for (const gone of ["Summary", "Tree", "Activity", "Personas", "Settings", "more"]) expect(within(tabs).queryByRole("tab", { name: new RegExp(`^${gone}`) })).toBeNull();
    expect(screen.getByTestId("settings-and-personas").getAttribute("href")).toBe("/milestones/ms-memo?tab=settings");
  });

  it("old links land on the tab that holds what they showed", () => {
    const t = (s: string) => fiveTabFromParams(new URLSearchParams(s));
    expect([t(""), t("tab=brief"), t("tab=summary"), t("tab=pipeline"), t("tab=work&view=posts"), t("tab=waiting"), t("tab=approvals"), t("tab=tree"), t("tab=activity"), t("tab=personas"), t("tab=history"), t("node=x")]).toEqual(["deck", "deck", "deck", "pipeline", "pipeline", "waiting", "waiting", "work", "history", "settings", "history", "work"]);
  });

  it("the console skin keeps its tabs on the same campaign", async () => {
    page("/milestones/ms-memo", SKINS.console);
    expect(await screen.findByRole("tab", { name: "Pipeline" })).toBeTruthy();
    expect(screen.queryByTestId("five-tabs")).toBeNull();
  });

  it("Brief: a deck you page through (slide 1 has the old Summary's facts), full screen with the feedback chat, Esc leaves", async () => {
    page("/milestones/ms-memo");
    expect((await screen.findByTestId("slide-title")).textContent).toBe("Where we are");
    expect(screen.getByTestId("slide-facts").textContent).toContain("1 thread out, 4 replies answered");
    expect(screen.getByTestId("slide-count").textContent).toBe("1 / 4");
    fireEvent.click(screen.getByTestId("deck-next"));
    await waitFor(() => expect(screen.getByTestId("slide-title").textContent).toBe("Why this campaign"));
    expect(screen.getByTestId("slide-draft").textContent).toContain("waits for your Approve");
    fireEvent.click(screen.getByTestId("brief-full"));
    expect(await screen.findByTestId("deck-full")).toBeTruthy();
    expect(screen.getByTestId("feedback-scope").textContent).toBe("This slide (2)Whole campaign");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("slide-title").textContent).toBe("Voice"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("deck-full")).toBeNull());
    expect(screen.getByTestId("where").textContent).toBe("?slide=3");
  });

  it("round 2: no heading block on Brief; every slide has the same fixed height and scrolls inside; feedback sits below the slide, not beside it", async () => {
    totems.slides[1].body = Array.from({ length: 60 }, (_, k) => `- line ${k}`).join("\n");
    page("/milestones/ms-memo");
    const tab = await screen.findByTestId("brief-tab");
    await screen.findByTestId("slide-title");
    expect(within(tab).queryByRole("heading", { name: "Brief" })).toBeNull();
    expect(tab.textContent).not.toContain("Every persona reads all of it when it wakes");
    const heightOf = () => [...screen.getByTestId("slide").classList].filter((c) => /(^|:)h-\[/.test(c)).join(" ");
    const first = heightOf();
    expect(first).toMatch(/h-\[/);
    expect(screen.getByTestId("slide-scroll").className).toContain("overflow-y-auto");
    fireEvent.click(screen.getByTestId("deck-next"));
    await waitFor(() => expect(screen.getByTestId("slide-count").textContent).toBe("2 / 4"));
    expect(heightOf()).toBe(first);
    // order: bar, slide, nav, then the note box (Node.DOCUMENT_POSITION_FOLLOWING = 4)
    const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & 4);
    expect(after(screen.getByTestId("brief-bar"), screen.getByTestId("slide"))).toBe(true);
    expect(after(screen.getByTestId("slide"), screen.getByTestId("deck-nav"))).toBe(true);
    expect(after(screen.getByTestId("deck-nav"), screen.getByTestId("slide-note"))).toBe(true);
    expect(screen.getByTestId("slide-note").closest("[data-testid=slide-feedback]")?.contains(screen.getByTestId("slide"))).toBe(false);
    // full screen: one column, slide, nav, then the chat
    fireEvent.click(screen.getByTestId("brief-full"));
    const full = await screen.findByTestId("deck-full");
    expect(full.className).not.toMatch(/lg:flex-row/);
    expect(heightOf()).not.toBe(first);
    expect(after(screen.getByTestId("deck-nav"), screen.getByTestId("feedback-chat"))).toBe(true);
  });

  it("a note on a slide goes to the campaign chat with the slide's ref; the rebuild shows Keep and Undo; Undo calls the spine writer", async () => {
    const undo = vi.spyOn(api, "undoSlide").mockResolvedValue({ commit: "abc" });
    page("/milestones/ms-memo?slide=3");
    expect((await screen.findByTestId("slide-title")).textContent).toBe("Voice");
    fireEvent.change(screen.getByLabelText("What should change on this slide"), { target: { value: "Too technical. Open on what the builder lost." } });
    fireEvent.click(screen.getByTestId("slide-note-send"));
    await waitFor(() => expect(sent).toEqual(["[slide 3: Voice · file docs/spines/campaign-reddit-awareness-week-37.md · ref ## Campaign plan > ### Voice] Too technical. Open on what the builder lost."]));
    expect(await screen.findByTestId("rebuild-waiting")).toBeTruthy();
    // the campaign chat's rebuild lands in the spine
    totems = mockTotems();
    totems.slides[2].body = "- Open on what the builder lost.\n- Me, first person, casual.";
    totems.rebuilds = [{ ref: "## Campaign plan > ### Voice", state: "rebuilt", date: "2026-11-03", note: "Too technical. Open on what the builder lost.", changes: [{ date: "2026-11-03", text: 'Slide rebuilt: "Voice" by the campaign chat' }] }];
    await waitFor(() => expect(screen.getByTestId("rebuild-banner")).toBeTruthy(), { timeout: 7000 });
    expect(screen.getByTestId("slide-body").querySelectorAll("[data-new]").length).toBe(1);
    expect(screen.getByTestId("slide-changes-count").textContent).toBe("1");
    fireEvent.click(screen.getByTestId("rebuild-undo"));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("social", "ms-memo", { file: "docs/spines/campaign-reddit-awareness-week-37.md", ref: "## Campaign plan > ### Voice" }));
  }, 15000);

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
  it("E971-S2 iteration 2: the benefits slide lists what it does with what you get under it; picking a row shows its real screen; a coming-soon line says so", async () => {
    totems.slides.splice(1, 0, {
      n: 2,
      ref: "## Benefits",
      file: "data/brief.md",
      title: "What it does for you",
      source: "data/brief.md · Benefits",
      body: "- **Writes posts from your rough ideas.** You show up every day without sitting down to write.",
      benefits: [
        { id: "1", does: "Writes posts from your rough ideas.", benefit: "You show up every day without sitting down to write.", status: "works today", soon: false, screen: { label: "Your ideas and the posts", path: "data/assets/benefits/s1.webp", url: "/api/tenants/social/social/file?repo=pod-campaign&path=data%2Fassets%2Fbenefits%2Fs1.webp" } },
        { id: "2", does: "Holds every post for your yes.", benefit: "Nothing goes out in your name that you didn't want.", status: "works today", soon: false, screen: { label: "The switch", path: "data/assets/benefits/s2.webp", url: "/f/s2.webp" } },
        { id: "5", does: "Checks what worked and changes the next posts.", benefit: "Your posts get better without you reading the numbers.", status: "half built", soon: true },
      ],
    });
    totems.slides.forEach((x, k) => (x.n = k + 1));
    page("/milestones/ms-memo?slide=2");
    expect((await screen.findByTestId("slide-title")).textContent).toBe("What it does for you");
    const rows = screen.getAllByTestId("benefit-row");
    expect(rows.map((r) => within(r).getByTestId("benefit-does").textContent)).toEqual(["Writes posts from your rough ideas.", "Holds every post for your yes.", "Checks what worked and changes the next posts.Coming soon"]);
    expect(within(rows[0]).getByTestId("benefit-gives").textContent).toBe("You show up every day without sitting down to write.");
    expect(rows[0].getAttribute("aria-pressed")).toBe("true");
    const side = screen.getByTestId("benefit-screen-side");
    expect(side.querySelector("img")!.getAttribute("src")).toContain("social/file?repo=pod-campaign");
    expect(side.textContent).toContain("Your ideas and the posts");
    expect(screen.queryByTestId("benefit-screen-row")).toBeNull(); // on a phone the list shows first
    fireEvent.click(rows[1]);
    expect(rows[1].getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("benefit-screen-side").querySelector("img")!.getAttribute("src")).toBe("/f/s2.webp");
    expect(screen.getByTestId("benefit-screen-row").querySelector("img")!.getAttribute("src")).toBe("/f/s2.webp");
    fireEvent.click(rows[2]);
    expect(rows[2].hasAttribute("data-soon")).toBe(true);
    expect(screen.getByTestId("benefit-screen-side").textContent).toContain("Being built");
  });

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
