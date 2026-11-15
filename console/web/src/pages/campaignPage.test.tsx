// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Persona, type Assignment } from "@/api";
import type { SocialData, SocialWriteAction } from "@/api/types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { AppRoutes } from "@/App";
import { MilestonePage } from "@/pages/Milestone";
import { TeamPage } from "@/pages/Team";
import { sampleSocialExport } from "@/lib/social";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { landsAt } from "@/test/landsAt";
import { writerOf } from "@/pages/social/Pipeline";

// step 2 (approved mockup): a campaign (a milestone whose repo has the social pack) opens on its Pipeline,
// with Brief & directions and History as tabs, each fed that milestone's repo; the Pipeline gains Add idea, Draft it now,
// Edit and Park; the old social paths lead to the campaign's tabs; Add job makes a one-off job in a world.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
// these tests drive the cards' own buttons: every card starts open (the board's Open all, remembered in the browser).
beforeEach(() => (localStorage.clear(), localStorage.setItem("e74:open-all:v1", "1")));
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const CARD = { ...mockCampaignCard(), repo: "brand-campaign", remote: "Acme/brand-campaign", title: "Epic campaign", milestoneId: "ms-memo" };
const social = (repo: string): SocialData => {
  const data = sampleSocialExport(new Date("2026-11-02T10:00:00Z"));
  data.ideas = [{ id: "I-2", date: "2026-11-01", idea: "Keep the why behind a choice", format: null, platform: "Reddit", from: "Scout", link: null, state: "new", why: null, became: [], _line: 5 }];
  return { tenantId: "social", repo, data };
};

let asked: (string | undefined)[] = [];
let writes: SocialWriteAction[] = [];
beforeEach(() => {
  asked = [];
  writes = [];
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [CARD] });
  vi.spyOn(api, "getSocial").mockImplementation(async (_t: string, repo?: string) => (asked.push(repo), social(repo ?? "social")));
  vi.spyOn(api, "socialWrite").mockImplementation(async (_t: string, w: SocialWriteAction, repo?: string) => {
    writes.push(w);
    return { ...social(repo ?? "?"), action: w.action, id: "", commit: "abc1234", push: { state: "pushed" }, files: [] } as never;
  });
});

const page = (path: string, skin: Skin = SKINS.social) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
          <Route path="/" element={<TeamPage section="settings" />} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("campaign page", () => {
  it("opens on Pipeline; tabs Pipeline, Brief & directions, History in front; Approvals, Backlog, Definitions under more", async () => {
    page("/milestones/ms-memo", SKINS.console); // the social skin shows the five tabs (fiveFixedTabs.test.tsx); these old tabs live on in the console skin
    const tabs = await screen.findByRole("tablist");
    const names = within(tabs).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+/g, "").trim());
    // the campaign's own chat sits next to its tabs (as the console milestone's Chat tab, with Call).
    expect(names.slice(0, 5)).toEqual(["Pipeline", "Brief & directions", "History", "Chat", "Summary"]);
    expect(names.filter((n) => n === "Chat")).toHaveLength(1);
    expect(names).not.toContain("Approvals");
    expect(within(tabs).getByRole("tab", { name: "Pipeline" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("lane-draft")).toBeTruthy();
    // fed the milestone's repo (Epic campaign), not the world's first social repo
    expect(asked).toContain("brand-campaign");
    expect(asked).not.toContain(undefined);
    fireEvent.click(screen.getByTestId("more-tabs"));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Approvals", "Backlog", "Definitions"]);
  });

  it("Brief & directions names the campaign's repo and file; History is compact rows with Digests", async () => {
    page("/milestones/ms-memo?tab=brief", SKINS.console); // the social skin shows the five tabs (fiveFixedTabs.test.tsx); these old tabs live on in the console skin
    expect((await screen.findByTestId("brief-source")).textContent).toContain("Acme/brand-campaign · data/brief.md");
    expect(screen.getByRole("link", { name: /Open in GitHub/ }).getAttribute("href")).toBe("https://github.com/Acme/brand-campaign/blob/HEAD/data/brief.md");
    expect(await screen.findByRole("heading", { name: "Directions" })).toBeTruthy();
    cleanup();
    page("/milestones/ms-memo?tab=history", SKINS.console); // the social skin shows the five tabs (fiveFixedTabs.test.tsx); these old tabs live on in the console skin
    expect(await screen.findByTestId("history-summary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Digests" }));
    const views = await screen.findByTestId("digest-view");
    expect(within(views).getAllByRole("button").map((b) => b.textContent)).toEqual(["Daily digest", "Weekly report"]);
    fireEvent.click(within(views).getByRole("button", { name: "Weekly report" }));
    expect(await screen.findByRole("heading", { name: "Weekly report" })).toBeTruthy();
  });

  it("T58-S4: the campaign's Chat tab is that campaign's chat (its milestone chat, its Call), never the world desk", async () => {
    const own = vi.spyOn(api, "getMilestoneChat").mockResolvedValue({ available: true, threadId: "th_m", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as never);
    const world = vi.spyOn(api, "getWorldDeskChat");
    page("/milestones/ms-memo?tab=chat");
    await waitFor(() => expect(own).toHaveBeenCalledWith("ms-memo", { limit: 20 }));
    expect(world).not.toHaveBeenCalled();
  });

  it("a milestone without the social pack keeps the console's tabs and opens on Summary", async () => {
    page("/milestones/ms-e5");
    const tabs = await screen.findByRole("tablist");
    expect(within(tabs).queryByRole("tab", { name: "Pipeline" })).toBeNull();
    expect(within(tabs).getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tabs).getByRole("tab", { name: "Approvals" })).toBeTruthy();
  });
});

describe("Pipeline: Add idea, Draft it now, Edit, Park", () => {
  const writer = { id: "pe_w", name: "Writer", remit: "Pack role: Writer" } as Persona;
  beforeEach(() => {
    vi.spyOn(api, "listPersonas").mockResolvedValue([writer, { id: "pe_s", name: "Scout", remit: "Pack role: Scout" } as Persona]);
    vi.spyOn(api, "listAssignments").mockResolvedValue([
      { id: "as_s", milestoneId: "ms-memo", personaId: "pe_s" } as Assignment,
      { id: "as_w", milestoneId: "ms-memo", personaId: "pe_w" } as Assignment,
      { id: "as_other", milestoneId: "ms-e5", personaId: "pe_w" } as Assignment,
    ]);
  });

  it("writerOf finds the campaign's Writer assignment (Pack role line or name)", () => {
    expect(writerOf("ms-memo", [{ id: "as_w", milestoneId: "ms-memo", personaId: "pe_w" } as Assignment], [writer])).toEqual({ assignmentId: "as_w", name: "Writer" });
    expect(writerOf("ms-e5", [], [writer])).toBeUndefined();
  });

  it("Add idea writes the ideas action; Draft it now wakes the Writer with the idea and says so at the button; Park drops it", async () => {
    const run = vi.spyOn(api, "runAssignmentNow").mockResolvedValue({ id: "run_1" } as never);
    page("/milestones/ms-memo", SKINS.console); // the social skin shows the five tabs (fiveFixedTabs.test.tsx); these old tabs live on in the console skin
    const ideas = await screen.findByTestId("lane-idea");
    fireEvent.change(within(ideas).getByLabelText("Add an idea"), { target: { value: "Every launch gets the same reply" } });
    fireEvent.click(within(ideas).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(writes[0]).toEqual({ action: "ideas", body: { idea: "Every launch gets the same reply", format: null, platform: null, link: null } }));
    const card = (await within(ideas).findAllByTestId("lane-item")).find((c) => c.textContent?.includes("I-2"))!;
    fireEvent.click(within(card).getByRole("button", { name: "Park" }));
    await waitFor(() => expect(writes.at(-1)).toEqual({ action: "ideas/I-2/drop" }));
    // a failed wake says so at the button and the idea stays in Ideas.
    run.mockRejectedValueOnce(new Error("session-cap on host1, will retry"));
    fireEvent.click(within(card).getByRole("button", { name: "Draft it" }));
    expect((await within(card).findByTestId("draft-now-note")).textContent).toBe("Not started: session-cap on host1, will retry");
    expect(within(screen.getByTestId("lane-draft")).queryByText(/I-2/)).toBeNull();
    // Draft it now moves the idea into Drafts at once, spinning and not clickable, while the Writer works.
    fireEvent.click(within(card).getByRole("button", { name: "Draft it" }));
    await waitFor(() => expect(run).toHaveBeenLastCalledWith("as_w", expect.stringContaining("Draft idea I-2 now")));
    const drafting = await waitFor(() => within(screen.getByTestId("lane-draft")).getAllByTestId("lane-item").find((c) => c.textContent?.includes("I-2"))!);
    expect(within(drafting).getByTestId("card-working").textContent).toContain("The Writer is drafting it");
    expect(drafting.getAttribute("aria-busy")).toBe("true");
    expect(within(drafting).getAllByRole("button").filter((b) => !b.hasAttribute("data-fold-open")).map((b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([["Writer is drafting…", true]]);
    expect(within(screen.getByTestId("lane-idea")).queryByText(/I-2/)).toBeNull();
    localStorage.removeItem("e61:drafting:v1");
  });

  it("Topics: the Scout's topics are a filter of the Ideas lane (their old screen leads here)", async () => {
    page("/milestones/ms-memo", SKINS.console); // the social skin shows the five tabs (fiveFixedTabs.test.tsx); these old tabs live on in the console skin
    const ideas = await screen.findByTestId("lane-idea");
    fireEvent.click(within(within(ideas).getByTestId("ideas-view")).getByRole("button", { name: /Topics/ }));
    expect(within(ideas).getByTestId("topic-list")).toBeTruthy();
    expect(within(ideas).queryByLabelText("Add an idea")).toBeNull();
  });

  it("Board / Week: Week shows the calendar inside the Pipeline", async () => {
    page("/milestones/ms-memo", SKINS.console); // the social skin shows the five tabs (fiveFixedTabs.test.tsx); these old tabs live on in the console skin
    await screen.findByTestId("lane-draft");
    fireEvent.click(within(screen.getByTestId("pipeline-view")).getByRole("button", { name: "Week" }));
    expect(await screen.findByTestId("week-label")).toBeTruthy();
    expect(screen.queryByTestId("lane-draft")).toBeNull();
  });
});

describe("old social paths lead to the campaign's tabs (social skin)", () => {
  it.each([
    ["/social", "/"],
    ["/social/pipeline", "/pipeline"],
    ["/social/pipeline?repo=brand-campaign", "/milestones/ms-memo"],
    ["/calendar", "/pipeline"],
    ["/ideas", "/pipeline"],
    ["/social/topics", "/pipeline"],
    ["/social/directions", "/milestones/ms-memo?tab=brief"],
    ["/brief", "/milestones/ms-memo?tab=brief"],
    ["/social/history", "/milestones/ms-memo?tab=history"],
    ["/digest?date=2026-11-01", "/milestones/ms-memo?tab=history&date=2026-11-01"],
    ["/report", "/milestones/ms-memo?tab=history"],
    ["/your-team", "/personas"],
    ["/campaigns", "/"],
  ])("%s → %s", async (from, to) => {
    expect(await landsAt(from)).toBe(to);
  });

  it("the wizard stays a page, and the console skin still reaches the social screens as pages", async () => {
    expect(await landsAt("/campaigns/new")).toBe("/campaigns/new");
    cleanup();
    render(
      <SkinProvider skin={SKINS.console}>
        <MemoryRouter initialEntries={["/social/pipeline?repo=social"]}>
          <AppRoutes />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect(await screen.findByTestId("lane-draft")).toBeTruthy();
  });
});

describe("Add job (social skin)", () => {
  it("Team's Add job: what, Done means, repo, persona; Add and start creates the job and wakes the persona", async () => {
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_s", name: "Scout", remit: "" } as Persona]);
    const add = vi.spyOn(api, "addJob").mockResolvedValue({ tenantId: "social", repo: "brand-campaign", milestoneId: "ms_job", path: "docs/spines/job-x.md", status: "ready", commit: "c", push: { state: "pushed" }, assignmentId: "as_job" });
    const run = vi.spyOn(api, "runAssignmentNow").mockResolvedValue({ id: "run_1" } as never);
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ mode: "on", identity: { kind: "none" }, tenant: { id: "social" }, worlds: [] } as never);
    page("/");
    fireEvent.click(await screen.findByRole("button", { name: "Add job" }));
    const dlg = await screen.findByTestId("job-dialog");
    fireEvent.change(within(dlg).getByLabelText("What should be done?"), { target: { value: "Find 10 subreddits that allow tool posts" } });
    fireEvent.change(within(dlg).getByLabelText("Done means"), { target: { value: "- the list is in the brief\n\neach sub's rules" } });
    await within(dlg).findByRole("option", { name: "Acme/brand-campaign" });
    fireEvent.change(within(dlg).getByLabelText("Persona"), { target: { value: "pe_s" } });
    fireEvent.click(within(dlg).getByTestId("job-start"));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith("social", { repo: "brand-campaign", title: "Find 10 subreddits that allow tool posts", doneMeans: ["the list is in the brief", "each sub's rules"], personaId: "pe_s" }),
    );
    await waitFor(() => expect(run).toHaveBeenCalledWith("as_job", expect.stringContaining("New job")));
  });

  it("the console skin's Add milestone stays the console dialog (repo picker, track or create an epic)", async () => {
    page("/", SKINS.console);
    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("heading", { name: "Add project" })).toBeTruthy();
    expect(screen.queryByTestId("job-dialog")).toBeNull();
    await act(async () => {});
  });
});
