// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { milestoneBookHref, planRows, sampleMilestoneBook } from "@/lib/book";
import { MilestoneBookPage } from "@/pages/MilestoneBook";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

// /book/<key> now leads to the deck (pages/BookRedirect.tsx); the milestone book page is rendered directly here,
// and /book's index lives on as "Every epic" at /deck/all.
const at = (path: string, skin: Skin = SKINS.console) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path.replace(/^\/book(?=$|[?#])/, "/deck/all")]}>
        <Routes>
          <Route path="/book/:key" element={<MilestoneBookPage />} />
          <Route path="*" element={<AppRoutes />} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("E947-S1 Epic Book per milestone", () => {
  it("opens with the goal, where we are, the plan (track + tree diagram) and next steps", async () => {
    const spy = vi.spyOn(api, "getMilestoneBook").mockResolvedValue({ book: sampleMilestoneBook("ms_1"), building: false });
    at("/book/ms_1");
    expect(await screen.findByText("home_repo: Epic Book")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith("ms_1");
    expect(within(screen.getByTestId("mbook-section-goal")).getByText(/Run a small team of AI employees/)).toBeTruthy();
    expect(screen.getByTestId("mbook-where").textContent).toContain("1 of 2 goals met.");
    expect(screen.getByTestId("mbook-track").getAttribute("aria-label")).toBe("1 of 2 goals met");
    expect(screen.getByTestId("mbook-goals").textContent).toContain("Three personas run a milestone unattended.");
    // the tree diagram: the milestone, its open epics (stuck first), its done ones folded into one row
    const rows = screen.getAllByTestId("mbook-plan-row");
    expect(rows.map((r) => [r.querySelector("text")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 18), r.getAttribute("data-state")])).toEqual([
      ["root home_repo", "moving"],
      ["EPIC-922 Two world", "stuck"],
      ["EPIC-940 Lanes and", "moving"],
      ["1 done", "done"],
    ]);
    expect(screen.getByTestId("mbook-next").textContent).toContain("Two worlds live: waiting on Sam");
    //'s table sits after Next steps, before Lately (agreed order)
    const order = ["mbook-section-next", "book-capabilities", "mbook-section-lately"].map((id) => screen.getByTestId(id));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the project" }).getAttribute("href")).toBe("/milestones/ms_1");
    expect(screen.getByText("26e6b01").getAttribute("href")).toBe("https://github.com/Acme/home_repo/commit/26e6b01");
  });

  it("E908-S33: /book/<id>#where scrolls to that section once the book has loaded", async () => {
    vi.spyOn(api, "getMilestoneBook").mockResolvedValue({ book: sampleMilestoneBook("ms_1"), building: false });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    at("/book/ms_1#where");
    await screen.findByText("home_repo: Epic Book");
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe("where");
  });

  it("folds closed children, stops at depth 2 and counts what is below", () => {
    const b = sampleMilestoneBook();
    const deep = [
      ...b.tree,
      { ...b.tree[1], path: "a.md", code: "EPIC-950", parent: "docs/spines/epic-940.md", depth: 2 },
      { ...b.tree[1], path: "b.md", code: "EPIC-951", parent: "a.md", depth: 3 },
      { ...b.tree[1], path: "c.md", code: "EPIC-952", parent: "docs/spines/epic-940.md", depth: 2, state: "parked" as const },
    ];
    expect(planRows(deep).map((r) => [r.code ?? r.title, r.depth, r.hidden ?? 0, r.parent])).toEqual([
      ["root", 0, 0, -1],
      ["EPIC-922", 1, 0, 0],
      ["EPIC-940", 1, 0, 0],
      ["EPIC-950", 2, 1, 2],
      ["1 parked", 2, 0, 2],
      ["1 done", 1, 0, 0],
    ]);
    expect(milestoneBookHref("ms_1")).toBe("/book/ms_1");
  });

  it("draws folded epics as one dashed line under their fold parent, not as rows of their own", () => {
    const b = sampleMilestoneBook();
    const tree = [
      ...b.tree,
      { ...b.tree[1], path: "a.md", code: "EPIC-950", parent: "docs/spines/epic-940.md", depth: 2, foldedInto: "docs/spines/epic-940.md" },
      { ...b.tree[1], path: "b.md", code: "EPIC-951", parent: "docs/spines/epic-940.md", depth: 2, state: "done" as const, foldedInto: "docs/spines/epic-940.md" },
    ];
    const rows = planRows(tree).map((r) => [r.code ?? r.title, r.depth, r.parent]);
    expect(rows).toContainEqual(["2 folded in: EPIC-950, EPIC-951", 2, 2]);
    expect(rows.map((r) => r[0])).not.toContain("EPIC-950");
  });

  it("says it is being built when the server has no book yet", async () => {
    vi.spyOn(api, "getMilestoneBook").mockResolvedValue({ book: null, building: true });
    at("/book/home_repo");
    expect(await screen.findByText(/being built from the spines/)).toBeTruthy();
  });

  it("each milestone page has its deck (a Deck tab) in the console skin, not in the social skin", async () => {
    const { MilestonePage } = await import("@/pages/Milestone");
    const m = await api.createMilestone({ title: "Bookish", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    const page = (skin: Skin) =>
      render(
        <SkinProvider skin={skin}>
          <MemoryRouter initialEntries={[`/milestones/${m.id}`]}>
            <Routes>
              <Route path="/milestones/:id" element={<MilestonePage />} />
            </Routes>
          </MemoryRouter>
        </SkinProvider>,
      );
    page(SKINS.console);
    expect(await screen.findByTestId("tab-deck")).toBeTruthy();
    cleanup();
    // another world's milestone (the home world sees it as the platform) has no book
    const get = api.getMilestone.bind(api);
    vi.spyOn(api, "getMilestone").mockImplementation(async (id) => ({ ...(await get(id)), world: "social" }));
    page(SKINS.console);
    await screen.findByTestId("chat-about-this");
    expect(screen.queryByTestId("tab-deck")).toBeNull();
    vi.restoreAllMocks();
    cleanup();
    page(SKINS.social);
    await screen.findByTestId("chat-about-this");
    expect(screen.queryByTestId("tab-deck")).toBeNull();
  });
});

describe("E947-S3 last updated and stale books", () => {
  it("the milestone book shows its last-updated date; a stale one says so", async () => {
    const b = sampleMilestoneBook("ms_1");
    vi.spyOn(api, "getMilestoneBook").mockResolvedValue({ book: b, building: false });
    at("/book/ms_1");
    const u = await screen.findByTestId("mbook-updated");
    expect(u.textContent).toMatch(/^Last updated /);
    expect(u.getAttribute("title")).toMatch(/spine changed .* · capabilities probed .* · daily refresh /);
    cleanup();
    const old = "2026-10-20T05:00:00.000Z";
    vi.spyOn(api, "getMilestoneBook").mockResolvedValue({ book: { ...b, updated: { at: old, spineAt: old, probeAt: null, refreshedAt: old, stale: true } }, building: false });
    at("/book/ms_1");
    expect((await screen.findByTestId("mbook-updated")).textContent).toMatch(/^Stale: last updated .*over 2 days ago/);
  });

  it("/book lists stale books as stuck, each linking to its book, and says when the daily refresh ran", async () => {
    const { sampleBook } = await import("@/lib/book");
    vi.spyOn(api, "getBook").mockResolvedValue({
      book: sampleBook(),
      building: false,
      refreshedAt: "2026-11-02T02:00:00.000Z",
      dailyRefreshAt: null,
      staleBooks: [{ milestoneId: "ms_9", title: "House decision", repo: "house", updatedAt: "2026-10-20T05:00:00.000Z" }],
    });
    at("/book");
    const box = await screen.findByTestId("book-stale");
    expect(box.textContent).toMatch(/Stuck: 1 epic deck is older than 2 days/);
    expect(within(box).getByText("House decision").closest("a")?.getAttribute("href")).toBe("/book/ms_9");
    expect(screen.getByTestId("book-refreshed").textContent).toMatch(/daily pull not run yet/);
  });
});

describe("E947-S4 everything made for this", () => {
  it("lists each epic's deliverables after Next steps: newest first, kinds, a stopped preview with its folder, a gone page marked", async () => {
    vi.spyOn(api, "getMilestoneBook").mockResolvedValue({ book: sampleMilestoneBook("ms_1"), building: false });
    at("/book/ms_1");
    const sec = await screen.findByTestId("mbook-section-made");
    expect(within(sec).getByText("Everything made for this (4)")).toBeTruthy();
    const next = screen.getByTestId("mbook-section-next");
    expect(next.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const epics = within(sec).getAllByTestId("mbook-made-epic");
    expect(epics.map((e) => [e.querySelector("summary")?.textContent, e.hasAttribute("open")])).toEqual([
      ["roothome_repo3", true],
      ["EPIC-940Lanes and radar1", false],
    ]);
    const items = within(epics[0]).getAllByTestId("made-item");
    expect(items.map((i) => [i.getAttribute("data-kind"), i.getAttribute("data-check")])).toEqual([
      ["live page", "ok"],
      ["proposal", "not running"],
      ["evidence", "gone"],
    ]);
    expect(within(sec).getByRole("link", { name: "The Epic Book for home_repo" }).getAttribute("href")).toBe("https://team.example.com/book/home_repo");
    expect(within(items[1]).getByTestId("made-not-running").textContent).toContain("Serve it again from home_repo/docs");
    expect(within(items[1]).getByRole("link", { name: "read its files" }).getAttribute("href")).toContain("/tree/main/docs/plans/e40-1-voice-note");
    expect(within(items[2]).getByTestId("made-gone").textContent).toContain("No longer there");
    expect(within(sec).getByText("Nothing linked yet in EPIC-922.")).toBeTruthy();
  });

  it("the whole Epic Book shows the list inside each epic", async () => {
    const { sampleBook, sampleMade } = await import("@/lib/book");
    const b = sampleBook();
    b.repos[0].epics[1] = { ...b.repos[0].epics[1], made: sampleMade()[0].items };
    vi.spyOn(api, "getBook").mockResolvedValue({ book: b, building: false } as never);
    at("/book");
    const lists = await screen.findAllByTestId("made-list");
    expect(lists).toHaveLength(1);
    expect(within(lists[0]).getAllByTestId("made-item")).toHaveLength(3);
    expect(screen.getByText("Everything made for this (3)")).toBeTruthy();
  });
});
