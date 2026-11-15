// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { epicPagesLink, filterGroups, PagesIndexPage } from "@/components/pagesIndex";
import type { PagesBody } from "@/api/pages-types";

/** No floating pages: the Pages index lists every one-off page by epic, linking down and to the epic deck. */
const BODY: PagesBody = {
  total: 3,
  groups: [
    {
      id: "team-EPIC-904",
      repo: "team",
      epic: "EPIC-904",
      epicTitle: "Talk to the desk",
      pages: [
        { port: 9241, url: "http://pages.example:9241/", title: "What we did", row: "E904-S57", repo: "team", epic: "EPIC-904" },
        { port: 9242, url: "http://pages.example:9242/", title: "Daily reports", row: "E904-S56", repo: "team", epic: "EPIC-904" },
      ],
    },
    { id: "social-EPIC-900", repo: "social", epic: "EPIC-900", epicTitle: "Social presence", pages: [{ port: 9031, url: "http://pages.example:9031/", title: "Giveaway", row: "E900-S29", repo: "social", epic: "EPIC-900" }] },
  ],
};

function show(entry = "/pages") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <PagesIndexPage />
    </MemoryRouter>,
  );
}

describe("pages index", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom has no scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("groups by repo, then epic, all folded at first, with counts on each header", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue(BODY);
    show();
    const repos = await screen.findAllByTestId("pages-repo");
    expect(repos.map((r) => r.getAttribute("data-repo"))).toEqual(["team", "social"]);
    expect(repos.every((r) => r.getAttribute("data-open") === "false")).toBe(true);
    expect(within(repos[0]).getByTestId("pages-repo-count").textContent).toBe("1 epic · 2 pages");
    expect(screen.queryAllByTestId("pages-group")).toHaveLength(0);
    expect(screen.getByTestId("pages-summary").textContent).toBe("3 pages in 2 epics across 2 repos");
    expect(screen.getByTestId("pages-rule").textContent).toContain("3 pages");
  });

  it("opens a repo to its epics and an epic to its pages, and remembers what he opened", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue(BODY);
    show();
    fireEvent.click((await screen.findAllByTestId("pages-repo-toggle"))[0]);
    const group = screen.getByTestId("pages-group");
    expect(group.id).toBe("team-EPIC-904");
    expect(within(group).getByText(/Talk to the desk/)).toBeTruthy();
    expect(within(group).getByTestId("pages-group-count").textContent).toBe("2");
    expect(within(group).getByTestId("pages-deck-link").getAttribute("href")).toBe("/deck/team/EPIC-904");
    expect(within(group).queryAllByTestId("pages-page")).toHaveLength(0);
    fireEvent.click(within(group).getByTestId("pages-group-toggle"));
    const pages = within(group).getAllByTestId("pages-page");
    expect(pages).toHaveLength(2);
    expect(within(pages[0]).getByRole("link").getAttribute("href")).toBe("http://pages.example:9241/");
    expect(pages[0].textContent).toContain("What we did");
    expect(pages[0].textContent).toContain("E904-S57");
    expect(JSON.parse(window.localStorage.getItem("pages.open")!).sort()).toEqual(["repo:team", "team-EPIC-904"]);
    cleanup();
    show();
    expect((await screen.findAllByTestId("pages-page")).length).toBe(2);
  });

  it("search filters pages, epics and repos as he types, and opens every match", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue(BODY);
    show();
    const box = await screen.findByTestId("pages-search");
    fireEvent.change(box, { target: { value: "daily" } });
    expect(screen.getAllByTestId("pages-repo").map((r) => r.getAttribute("data-repo"))).toEqual(["team"]);
    expect(screen.getAllByTestId("pages-page").map((p) => p.textContent)).toEqual([expect.stringContaining("Daily reports")]);
    expect(screen.getByTestId("pages-summary").textContent).toBe("1 page match, of 3");
    fireEvent.change(box, { target: { value: "social presence" } });
    expect(screen.getAllByTestId("pages-page").map((p) => p.textContent)).toEqual([expect.stringContaining("Giveaway")]);
    fireEvent.change(box, { target: { value: "nothing like this" } });
    expect(screen.getByTestId("pages-none")).toBeTruthy();
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.queryAllByTestId("pages-page")).toHaveLength(0);
  });

  it("a page's way back up (#<repo>-<epic>) opens that repo and epic", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue(BODY);
    show("/pages#social-EPIC-900");
    const group = await screen.findByTestId("pages-group");
    expect(group.id).toBe("social-EPIC-900");
    expect(within(group).getAllByTestId("pages-page")).toHaveLength(1);
  });

  it("an epic deck links down to its group, or nowhere when it has no pages", () => {
    expect(epicPagesLink(BODY, "team", "EPIC-904")).toEqual({ href: "/pages#team-EPIC-904", count: 2 });
    expect(epicPagesLink(BODY, "team", "EPIC-901")).toBeNull();
    expect(filterGroups(BODY.groups, "E900-S29")[0].pages).toHaveLength(1);
  });

  it("says where the list lives when it is empty", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue({ groups: [], total: 0 });
    show();
    expect(await screen.findByText(/docs\/pages\/registry.json names them/)).toBeTruthy();
  });

  it("pinned pages open the list by name, with when they last refreshed and a Refresh button", async () => {
    const pinned = { port: 9442, url: "http://pages.example:9442/", title: "Our scorecard", name: "Team scorecard", pinned: true, slug: "scorecard", refresh: "x.service", row: "E907-S3", repo: "team", epic: "EPIC-907" };
    vi.spyOn(api, "listPages").mockResolvedValue({ ...BODY, pinned: [pinned] });
    vi.spyOn(api, "pinnedPageStatus").mockResolvedValue({ refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString(), refreshable: true, running: false });
    const refresh = vi.spyOn(api, "refreshPinnedPage").mockResolvedValue({ refreshedAt: null, refreshable: true, running: true });
    show();
    const card = await screen.findByTestId("pages-pinned-page");
    const list = screen.getByTestId("pages-index");
    // the Pinned group comes before every repo
    expect(list.innerHTML.indexOf("pages-pinned")).toBeLessThan(list.innerHTML.indexOf("pages-repo"));
    expect(within(card).getByText("Team scorecard").closest("a")?.getAttribute("href")).toBe("/scorecard");
    expect((await within(card).findByTestId("pages-pinned-refreshed")).textContent).toMatch(/Refreshed 5 ?m/);
    // the address is its own wrapping line, never cut off on a phone
    const address = within(card).getByTestId("pages-pinned-address");
    expect(address.textContent).toMatch(/\/scorecard$/);
    expect(address.className).not.toMatch(/truncate/);
    fireEvent.click(within(card).getByTestId("pages-pinned-refresh"));
    expect(await within(card).findByText(/Refreshing now/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledWith(9442);
  });

  it("Pin offers a plain name from the title, refuses a code, and saves the name", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue({
      total: 1,
      groups: [{ id: "team-EPIC-906", repo: "team", epic: "EPIC-906", epicTitle: "Unattended", pages: [{ port: 9443, url: "http://pages.example:9443/", title: "E906-S12 server health wheel: 14 things", row: "E906-S12", repo: "team", epic: "EPIC-906" }] }],
    });
    const pin = vi.spyOn(api, "pinPage").mockResolvedValue({ ok: true });
    show("/pages#team-EPIC-906");
    fireEvent.click(await screen.findByTestId("pages-pin"));
    const input = screen.getByTestId("pages-name-input") as HTMLInputElement;
    expect(input.value).toBe("Server health wheel");
    fireEvent.change(input, { target: { value: "EPIC-906 wheel" } });
    fireEvent.click(screen.getByTestId("pages-name-save"));
    expect((await screen.findByTestId("pages-name-error")).textContent).toMatch(/no epic or row code/);
    expect(pin).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Server health" } });
    fireEvent.click(screen.getByTestId("pages-name-save"));
    await vi.waitFor(() => expect(pin).toHaveBeenCalledWith({ port: 9443, pinned: true, name: "Server health" }));
  });

  it("a pinned card shows its name as the title, the code only small, and renames or unpins", async () => {
    const pinned = { port: 9442, url: "http://pages.example:9442/", title: "Team scorecard", name: "Scorecard", pinned: true, slug: "scorecard", row: "E907-S3", repo: "team", epic: "EPIC-906" };
    vi.spyOn(api, "listPages").mockResolvedValue({ ...BODY, pinned: [pinned] });
    vi.spyOn(api, "pinnedPageStatus").mockResolvedValue({ refreshedAt: null, refreshable: false, running: false });
    const pin = vi.spyOn(api, "pinPage").mockResolvedValue({ ok: true });
    show();
    const card = await screen.findByTestId("pages-pinned-page");
    const title = card.querySelector("span.font-semibold")!;
    expect(title.textContent).toBe("Scorecard");
    expect(within(card).getByTestId("pages-pinned-row").textContent).toBe("made by E907-S3");
    fireEvent.click(within(card).getByTestId("pages-pinned-unpin"));
    await vi.waitFor(() => expect(pin).toHaveBeenCalledWith({ port: 9442, pinned: false }));
    fireEvent.click(within(card).getByTestId("pages-pinned-rename"));
    const input = (await screen.findByTestId("pages-name-input")) as HTMLInputElement;
    expect(input.value).toBe("Scorecard");
    fireEvent.change(input, { target: { value: "Our scorecard" } });
    fireEvent.click(screen.getByTestId("pages-name-save"));
    await vi.waitFor(() => expect(pin).toHaveBeenCalledWith({ port: 9442, pinned: true, name: "Our scorecard" }));
  });
});
