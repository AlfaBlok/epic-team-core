// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { questionsUrl, orderRepos, plainOf, sampleBook, titleRest } from "@/lib/book";


// the book's questions link is this console's (sites); a neutral one here
globalThis.__IDENTITY__ = { ...globalThis.__IDENTITY__, sites: { bookQuestionsUrl: "http://worker.tail.example:8795/plans/q/index.html" } };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const at = (path: string, skin: Skin = SKINS.console) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("Epic Book page", () => {
  it("shows open epics per repo with goal, why, timeline, next and what a stuck one waits on; links the questions page", async () => {
    vi.spyOn(api, "getBook").mockResolvedValue({ book: sampleBook(), building: false });
    at("/deck/all");
    expect(await screen.findByText("Every epic")).toBeTruthy();
    const epics = await screen.findAllByTestId("book-epic");
    // "Open" (default) hides done epics: root,
    expect(epics.map((e) => e.id)).toEqual(["root", "EPIC-940", "EPIC-922"]);
    expect(within(epics[2]).getByTestId("book-stuck").textContent).toBe("Stuck on: E922-A1 (Sam)");
    const e40 = within(epics[1]);
    expect(e40.getByText("Sam opens team.example.com and sees his big lanes, not a flat list.")).toBeTruthy();
    expect(e40.getByText(/Sam steers from the top branches/)).toBeTruthy();
    expect(e40.getByTestId("book-timeline").textContent).toContain("Epic Book");
    expect(e40.getByText("72c751e").getAttribute("href")).toBe("https://github.com/Acme/home_repo/commit/72c751e");
    expect(screen.getByTestId("book-questions").getAttribute("href")).toBe(questionsUrl());

    fireEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect((await screen.findAllByTestId("book-epic")).map((e) => e.id)).toContain("EPIC-916");
    fireEvent.click(screen.getByRole("button", { name: "Stuck" }));
    expect((await screen.findAllByTestId("book-epic")).map((e) => e.id)).toEqual(["EPIC-922"]);
  });

  it("says it is being built when the server has no book yet", async () => {
    vi.spyOn(api, "getBook").mockResolvedValue({ book: null, building: true });
    at("/deck/all");
    expect(await screen.findByText(/being built from the spines/)).toBeTruthy();
  });

  it("rework: asks again until the book is there, then scrolls /book#capabilities to the table", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const get = vi
      .spyOn(api, "getBook")
      .mockResolvedValueOnce({ book: null, building: true })
      .mockResolvedValue({ book: sampleBook(), building: true, refreshedAt: "2026-11-02T02:00:00.000Z", dailyRefreshAt: "2026-11-01T18:46:51.581Z" });
    at("/deck/all#capabilities");
    expect(await screen.findByText(/being built from the spines/)).toBeTruthy();
    expect(await screen.findByTestId("book-capabilities", {}, { timeout: 5_000 })).toBeTruthy(); // no 30 s wait
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("book-refreshing").textContent).toContain("refreshing");
    expect(screen.getByTestId("book-refreshed").textContent).toMatch(/Refreshed .*daily pull/);
    await vi.waitFor(() => expect(scrolled).toContain("capabilities"));
  }, 10_000);

  it("rework: shows this browser's last book while the server restarts", async () => {
    vi.spyOn(api, "getBook").mockResolvedValueOnce({ book: sampleBook(), building: false });
    at("/deck/all");
    expect(await screen.findByTestId("book-capabilities")).toBeTruthy();
    cleanup();
    vi.spyOn(api, "getBook").mockRejectedValue(new Error("502 Bad Gateway"));
    at("/deck/all#capabilities");
    expect(await screen.findByTestId("book-capabilities")).toBeTruthy();
    expect(screen.queryByText(/502/)).toBeNull();
    expect(screen.getByTestId("book-refreshing")).toBeTruthy();
  });

  it("is in neither sidebar (on each milestone and epic instead)", () => {
    const nav = (skin: Skin) =>
      render(
        <SkinProvider skin={skin}>
          <MemoryRouter>
            <SidebarNav />
          </MemoryRouter>
        </SkinProvider>,
      );
    // the deck sits on each milestone and epic page, no longer in the sidebar of either skin.
    nav(SKINS.console);
    expect(screen.queryByRole("link", { name: /Epic deck/ })).toBeNull();
    cleanup();
    nav(SKINS.social);
    expect(screen.queryByRole("link", { name: /Epic deck/ })).toBeNull();
  });

  it("orders home_repo first, then by open epics; strips the code from titles", () => {
    const b = sampleBook();
    const r = (name: string, open: number) => ({ ...b.repos[0], name, counts: { moving: open, stuck: 0, parked: 0, done: 0 } });
    expect(orderRepos([r("a", 1), r("b", 5), r("home_repo", 0)]).map((x) => x.name)).toEqual(["home_repo", "b", "a"]);
    expect(titleRest(b.repos[0].epics[1])).toBe("Lanes and radar: Sam sees his big lanes and what moves each");
  });

  it("shows home_repo's services x capabilities table with dates, gaps' why and fix, and the last real use", async () => {
    vi.spyOn(api, "getBook").mockResolvedValue({ book: sampleBook(), building: false });
    at("/deck/all?show=stuck");
    const table = await screen.findByTestId("book-capabilities");
    expect(screen.getByTestId("book-capabilities-link").getAttribute("href")).toBe("#capabilities");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Service", "Egress (proxy?)", "Read", "Reply", "Read DMs"]);
    const rows = within(table).getAllByTestId("cap-row");
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["X@MemoAccount", "YouTubewaits on EPIC-929-A1"]);
    const cells = within(rows[0]).getAllByTestId("cap-cell");
    expect(cells.map((c) => c.getAttribute("data-state"))).toEqual(["works", "works", "gap"]);
    expect(cells[0].textContent).toContain("tested 1 Nov");
    expect(cells[2].textContent).toContain("Why: DMs moved to encrypted X Chat");
    expect(cells[2].textContent).toContain("Fix: Sam enters the X Chat passcode once");
    expect(within(cells[1]).getByText("x_reply").getAttribute("href")).toBe("https://x.com/MemoAccount/status/2116906887027261931");
    expect(within(rows[1]).getAllByText("not listed")).toHaveLength(2);
    expect(within(table).getByText(/Data: docs\/status\/service-capabilities.json/).getAttribute("href")).toContain("/blob/main/docs/status/service-capabilities.json");
  });

  it("shows the service's feature list from its one data file, with the inbox-focus group and the rows that built each line", async () => {
    const b = sampleBook();
    b.repos[0] = {
      ...b.repos[0],
      features: {
        service: "EpicTeam",
        title: "What EpicTeam does for you",
        updated: "2026-11-08",
        groups: [
          { id: "main", title: "What it does", features: [{ id: "seat-pool", title: "One usage limit never stops the work.", text: "One pool of seats.", rows: ["EPIC-950"], section: "seats" }] },
          {
            id: "inbox-focus",
            title: "Keeps your inbox focused, no context overload",
            intro: "Only what needs you.",
            features: [{ id: "one-page-one-card", title: "One page, one card", text: "One card per page.", rows: ["E943-S7"], learning: "root L-51", since: "2026-11-08" }],
          },
        ],
        source: "docs/features/epicteam.json",
        href: "https://github.com/Acme/home_repo/blob/main/docs/features/epicteam.json",
      },
    };
    vi.spyOn(api, "getBook").mockResolvedValue({ book: b, building: false });
    at("/deck/all#features");
    const list = await screen.findByTestId("book-features");
    expect(list.id).toBe("features");
    expect(screen.getByTestId("book-features-link").getAttribute("href")).toBe("#features");
    expect(within(list).getByText(/2 features/)).toBeTruthy();
    const groups = within(list).getAllByTestId("feature-group");
    expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual(["What it does", "Keeps your inbox focused, no context overload"]);
    const one = within(groups[1]).getByTestId("feature");
    expect(one.textContent).toContain("One page, one card");
    expect(one.textContent).toContain("built by E943-S7 · root L-51 · since 8 Nov");
    expect(within(list).getByText(/Data: docs\/features\/epicteam.json/).getAttribute("href")).toContain("/blob/main/docs/features/epicteam.json");
  });

  it("the ranked top journeys show as a ladder above the feature list, rung 1 first", async () => {
    const b = { ...sampleBook() };
    b.repos = [
      {
        ...b.repos[0],
        topJourneys: {
          rankedAt: "2026-11-15",
          journeys: [
            { rank: 1, id: "whole-loop", title: "Say it once, and it comes back done.", why: "You talk, finished work comes back.", screen: "https://team.example/" },
            { rank: 2, id: "review-card", title: "One card a task.", why: "A minute to check.", clip: "http://clips/r.mp4" },
          ],
          source: "docs/features/hero-journeys.json",
        },
      },
      ...b.repos.slice(1),
    ];
    vi.spyOn(api, "getBook").mockResolvedValue({ book: b, building: false });
    at("/deck/all#top-journeys");
    const ladder = await screen.findByTestId("top-journeys");
    expect(ladder.id).toBe("top-journeys");
    expect(screen.getByTestId("book-top-journeys-link").getAttribute("href")).toBe("#top-journeys");
    const rungs = within(ladder).getAllByTestId("top-journey");
    expect(rungs.map((r) => within(r).getByTestId("top-journey-rank").textContent)).toEqual(["1", "2"]);
    expect(rungs[0].textContent).toContain("You talk, finished work comes back.");
    expect(within(rungs[0]).getByText("Open it").getAttribute("href")).toBe("https://team.example/");
    expect(within(rungs[1]).getByText("Watch the clip").getAttribute("href")).toBe("http://clips/r.mp4");
  });

  it("worker: a second service's list shows under its own anchor, each naming the page that draws it", async () => {
    const list = (service: string, file: string) => ({
      service,
      title: `What ${service} does for you`,
      groups: [{ id: "main", title: "What it does", features: [{ id: "a", title: `${service} line`, text: "Text.", rows: ["E946-S17"] }] }],
      source: `docs/features/${file}.json`,
    });
    const team = list("EpicTeam", "epicteam");
    const b = { ...sampleBook() };
    b.repos = [{ ...b.repos[0], features: team, featureLists: [team, list("Social", "social")] }, ...b.repos.slice(1)];
    vi.spyOn(api, "getBook").mockResolvedValue({ book: b, building: false });
    at("/deck/all#features");
    const lists = await screen.findAllByTestId("book-features");
    expect(lists.map((l) => l.id)).toEqual(["features", "features-social"]);
    expect(screen.getAllByTestId("book-features-link").map((a) => a.getAttribute("href"))).toEqual(["#features", "#features-social"]);
    // E948-S129: the page it names is a link he taps
    expect(lists[0].textContent).toMatch(/read by this page and epicspine.dev\/team\./);
    expect(lists[1].textContent).toMatch(/read by this page and epicspine.dev\/social\./);
    expect(within(lists[0]).getByRole("link", { name: "epicspine.dev/team" }).getAttribute("href")).toBe("https://epicspine.dev/team");
    expect(within(lists[1]).getByText("Social line")).toBeTruthy();
  });

  it("a plain status block on top, and every cell reads Works / Partly / Not yet with its reason", async () => {
    vi.spyOn(api, "getBook").mockResolvedValue({ book: sampleBook(), building: false });
    at("/deck/all?show=stuck");
    const table = await screen.findByTestId("book-capabilities");
    const lines = within(within(table).getByTestId("cap-status")).getAllByTestId("cap-status-line");
    expect(lines.map((l) => l.getAttribute("data-word"))).toEqual(["partly", "not yet"]);
    expect(lines[0].textContent).toBe("PartlyYour account (home), Reddit: Works only while your Mac is online.");
    expect(lines[1].textContent).toContain("Not yet");
    const words = within(table).getAllByTestId("cap-word");
    // read: its own plain word; reply: derived from works; read_dms: derived from gap; YouTube read_dms: n/a
    expect(words.map((w) => w.textContent)).toEqual(["Partly", "Works", "Not yet", "n/a"]);
    const plain = within(table).getAllByTestId("cap-plain");
    expect(plain[0].textContent).toBe("Mentions work without your Mac; the feed needs your Mac online.");
    expect(plain[2].textContent).toBe("DMs moved to encrypted X Chat. Fix: Sam enters the X Chat passcode once");
  });

  it("a hand-written Works gives way when the daily probe finds the cell failing", () => {
    const c = { state: "gap" as const, summary: "s", tested: "2026-11-02T00:00:00Z", test: "t", why: "logged out", fix: "re-sync", plain: { word: "works" as const, text: "Works." } };
    expect(plainOf(c)).toEqual({ word: "not yet", text: "logged out. Fix: re-sync" });
    expect(plainOf({ ...c, state: "works" })).toEqual({ word: "works", text: "Works." });
  });

  it("rework: every service shows its egress, what happens when it is offline, the tester world, a legend and the scope", async () => {
    vi.spyOn(api, "getBook").mockResolvedValue({ book: sampleBook(), building: false });
    at("/deck/all?show=stuck");
    const table = await screen.findByTestId("book-capabilities");
    expect(within(table).getByTestId("cap-scope").textContent).toContain("any seat or persona launched from home_repo");
    const eg = within(table).getAllByTestId("cap-egress");
    expect(eg.map((e) => e.getAttribute("data-kind"))).toEqual(["laptop", "api", "server"]);
    expect(eg[0].textContent).toContain("Sam's Mac (laptop egress)");
    expect(eg[0].textContent).toContain("When offline: refused, nothing sent");
    expect(eg[0].textContent).toContain("Tester world: the tester's own browser, direct from server");
    expect(within(table).getByText("went out via laptop (MX 189.128.x.x)")).toBeTruthy();
    const legend = within(table).getByTestId("cap-egress-legend");
    expect(legend.textContent).toContain("none (API): the service's own API from the server");
    expect(within(table).getByTestId("cap-other").textContent).toContain("Memo memory: search and store team memory");
  });
});
