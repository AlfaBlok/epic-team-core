// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type SocialData, type SocialIdea, type SocialPost, type SocialWriteResult } from "@/api";
import { ApiError } from "@/api/real";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { emptySocialExport } from "@/lib/social";
import { countIdeas, ideaViews, prioritiesBody } from "@/lib/ideas";
import { IdeasPage } from "@/pages/Ideas";
import { landsAt } from "@/test/landsAt";

// My ideas & priorities: idea states with the posts they became; add / edit / drop; week + month with one Save;
// a 422's pack issue lines inline.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let line = 5;
const idea = (i: Partial<SocialIdea>): SocialIdea => ({ id: null, date: "2026-10-26", idea: null, format: null, platform: null, from: "Sam", link: null, state: "new", why: null, became: [], _line: line++, ...i });
const post = (p: Partial<SocialPost>): SocialPost => ({
  id: null, date: null, persona: null, kind: null, platform: null, community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
  highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null, _line: line++, ...p,
});

const EXPORT = emptySocialExport("/r/social");
EXPORT.ideas = [
  idea({ id: "I-1", idea: "Decisions need memory", state: "picked up", became: ["P-0143"] }),
  idea({ id: "I-2", idea: "One diagram like this", link: "https://x.com/a/status/1", state: "picked up", became: ["P-0144"] }),
  idea({ id: "I-3", idea: "A thread on pricing", state: "parked", why: "Never say prices" }),
  idea({ id: "I-4", idea: "How git log saved me", state: "new" }),
  idea({ id: "I-5", idea: "Shared memory demo video", from: "Scout", state: "epic", why: "PLAN-9" }),
];
EXPORT.posts = [
  post({ id: "P-0143", status: "posted", link: "https://reddit.com/r/x/1", idea: "I-1" }),
  post({ id: "P-0144", status: "draft", idea: "I-2" }),
];
EXPORT.directions.week = [{ id: "H1", highlight: "git log is memory", why: "launch", until: "2026-11-01", served_by: ["P-0143", "P-0144"], _line: 5 }];
EXPORT.directions.month = [{ id: "M1", priority: "EpicSpine angle", why: null, month: "2026-11", served_by: [], _line: 9 }];
const DATA: SocialData = { tenantId: "social", repo: "social", data: EXPORT };

const result = (d: SocialData["data"], action = "x"): SocialWriteResult => ({ ...DATA, data: d, action, id: "", commit: "abc", push: { state: "pushed" }, files: [] });

const page = () => {
  vi.spyOn(api, "getSocial").mockResolvedValue(DATA);
  return render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter>
        <IdeasPage />
      </MemoryRouter>
    </SkinProvider>,
  );
};

describe("T34-S8 idea views", () => {
  it("state folds in what it became: a live post → posted (linked), a draft → drafted; newest first; only new / picked up droppable", () => {
    const v = ideaViews(EXPORT);
    expect(v.map((i) => [i.id, i.shown, i.droppable])).toEqual([
      ["I-5", "epic", false],
      ["I-4", "new", true],
      ["I-3", "parked", false],
      ["I-2", "drafted", true],
      ["I-1", "posted", true],
    ]);
    expect(v.find((i) => i.id === "I-1")!.became).toEqual([{ id: "P-0143", status: "posted", link: "https://reddit.com/r/x/1" }]);
    expect(countIdeas(v)).toMatchObject({ all: 5, new: 1, "picked up": 0, drafted: 1, posted: 1, parked: 1, epic: 1 });
  });

  it("priorities body: both lists whole, blank rows dropped, a new row without id", () => {
    expect(
      prioritiesBody(
        [{ id: "H1", highlight: " a ", why: "", until: "2026-11-01", servedBy: [] }, { id: "", highlight: "b", why: "w", until: "", servedBy: [] }, { id: "", highlight: " ", why: "", until: "", servedBy: [] }],
        [],
      ),
    ).toEqual({ week: [{ id: "H1", highlight: "a", why: null, until: "2026-11-01" }, { id: null, highlight: "b", why: "w", until: null }], month: [] });
  });
});

describe("T34-S8 My ideas & priorities screen", () => {
  it("lists ideas with state chips and links to the post each became; filters by state", async () => {
    page();
    const i1 = await screen.findByTestId("idea-I-1");
    expect(within(i1).getByTestId("idea-state-I-1").textContent).toBe("posted");
    expect(within(i1).getByTestId("became-P-0143").getAttribute("href")).toBe("https://reddit.com/r/x/1");
    expect(within(screen.getByTestId("idea-I-2")).getByTestId("became-P-0144").textContent).toBe("P-0144 → draft");
    expect(within(screen.getByTestId("idea-I-3")).getByText("why: Never say prices")).toBeTruthy();
    expect(within(screen.getByTestId("idea-I-3")).queryByText("Drop")).toBeNull(); // parked: not the owner's move
    expect(within(screen.getByTestId("idea-I-5")).queryByText("Drop")).toBeNull();
    fireEvent.click(screen.getByTestId("filter-parked"));
    expect(screen.queryByTestId("idea-I-1")).toBeNull();
    expect(screen.getByTestId("idea-I-3")).toBeTruthy();
  });

  it("add posts an idea and shows the answer's export; edit and drop post to the row", async () => {
    const after = structuredClone(EXPORT);
    after.ideas.push(idea({ id: "I-6", idea: "A new one", platform: "X" }));
    const write = vi.spyOn(api, "socialWrite").mockResolvedValue(result(after));
    page();
    fireEvent.change(await screen.findByLabelText("New idea"), { target: { value: " A new one " } });
    fireEvent.change(screen.getByLabelText("New platform"), { target: { value: "X" } });
    fireEvent.click(screen.getByText("Add idea"));
    expect(await screen.findByTestId("idea-I-6")).toBeTruthy();
    expect(write).toHaveBeenLastCalledWith("social", { action: "ideas", body: { idea: "A new one", format: null, platform: "X", link: null } }, "social");
    expect((screen.getByLabelText("New idea") as HTMLInputElement).value).toBe("");

    fireEvent.click(within(screen.getByTestId("idea-I-4")).getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Edit I-4 idea"), { target: { value: "How git log saved me from a bad memory" } });
    fireEvent.click(screen.getByText("Save I-4"));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith("social", { action: "ideas/I-4", body: { idea: "How git log saved me from a bad memory", format: null, platform: null, link: null } }, "social"));

    const dropped = structuredClone(after);
    dropped.ideas.find((i) => i.id === "I-4")!.state = "parked";
    write.mockResolvedValueOnce(result(dropped));
    fireEvent.click(within(screen.getByTestId("idea-I-4")).getByText("Drop"));
    await waitFor(() => expect(screen.getByTestId("idea-state-I-4").textContent).toBe("parked"));
    expect(write).toHaveBeenLastCalledWith("social", { action: "ideas/I-4/drop" }, "social");
  });

  it("a 422 shows every pack issue line inline at the row, nothing changes", async () => {
    vi.spyOn(api, "socialWrite").mockRejectedValue(new ApiError(422, "pack refused", "invalid", ["pack social: data/ideas.md I-4: illegal state change new -> parked by Sam", "second line"]));
    page();
    fireEvent.click(within(await screen.findByTestId("idea-I-4")).getByText("Drop"));
    const issues = await screen.findByTestId("idea-issues-I-4");
    expect(within(issues).getByText(/illegal state change new -> parked by Sam/)).toBeTruthy();
    expect(within(issues).getByText("second line")).toBeTruthy();
    expect(screen.getByTestId("idea-state-I-4").textContent).toBe("new");
  });

  it("week + month priorities: edit, add a row, one Save posts both; a 422 shows inline", async () => {
    const write = vi.spyOn(api, "socialWrite").mockRejectedValueOnce(new ApiError(422, "bad", "invalid", ["data/directions.md ## Month: bad month"]));
    page();
    const save = await screen.findByText("Save priorities");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByTestId("prio-week")).getByText("2 posts")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("This week 1 Highlight"), { target: { value: "git log is your agent's memory" } });
    fireEvent.click(within(screen.getByTestId("prio-month")).getByText("+ Add"));
    fireEvent.change(screen.getByLabelText("This month 2 Priority"), { target: { value: "Open source" } });
    fireEvent.click(save);
    expect(await screen.findByText("data/directions.md ## Month: bad month")).toBeTruthy();
    const body = {
      week: [{ id: "H1", highlight: "git log is your agent's memory", why: "launch", until: "2026-11-01" }],
      month: [{ id: "M1", priority: "EpicSpine angle", why: null, month: "2026-11" }, { id: null, priority: "Open source", why: null, month: null }],
    };
    expect(write).toHaveBeenLastCalledWith("social", { action: "directions", body }, "social");
    // the edits survive the refusal; a retry that passes shows Saved
    const after = structuredClone(EXPORT);
    after.directions.month.push({ id: "M2", priority: "Open source", why: null, month: null, served_by: [], _line: 10 });
    write.mockResolvedValueOnce(result(after));
    fireEvent.click(screen.getByText("Save priorities"));
    expect(await screen.findByTestId("prio-saved")).toBeTruthy();
    expect(screen.queryByTestId("prio-issues")).toBeNull();
    expect(within(screen.getByTestId("prio-month")).getByText("M2")).toBeTruthy();
  });
});

describe("T34-S8 screen set", () => {
  const routeAt = (path: string, skin: Skin) =>
    render(
      <SkinProvider skin={skin}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </SkinProvider>,
    );

  it("social skin: route, no nav link (T58-S3: ideas live on the campaign's Pipeline); console skin: neither", async () => {
    vi.spyOn(api, "getSocial").mockResolvedValue(DATA);
    const nav = render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect(nav.container.querySelector('a[href="/ideas"]')).toBeNull();
    cleanup();
    expect(await landsAt("/ideas")).toBe("/pipeline"); // the all-campaigns Pipeline (Ideas lane, Add idea with a campaign pick)
    cleanup();
    const con = render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    expect(con.container.querySelector('a[href="/ideas"]')).toBeNull();
    cleanup();
    routeAt("/ideas", SKINS.console);
    expect(screen.getByText(/Not found\./)).toBeTruthy();
  });
});
