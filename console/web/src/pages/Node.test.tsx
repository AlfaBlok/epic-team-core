// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api, type Milestone, type NodeTree, type SpineListing, type TreeNode, type WaitingItem } from "@/api";
import { EpicTree } from "@/components/tree";
import { milestoneNodeHref, nodeViewHref, spineHref, spineViewHref } from "@/lib/nodes";
import { MilestoneNodePage, SpineViewPage } from "@/pages/Node";
import { clearSpinesCache, SpinesPage } from "@/pages/Spines";
import { TeamPage } from "@/pages/Team";

// findBy* waits 10 s: the host runs these under heavy load.
const W = { timeout: 10_000 };

// Open action, node view (summary + scoped waiting + subtree), Track as project, Spines page, Team counts.
beforeEach(() => {
  localStorage.clear();
  clearSpinesCache();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const node = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({ key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "draft", color: "grey", children: [], flags: [], ...over });
const ROW1 = node("ms_e4/EPIC-904/#1", { id: "draft", title: "1. Define the doctrine", status: "active", color: "red", asks: [{ ask: "approve", question: "Approve?", who: "Sam", since: "2026-10-19" }] });
const ROW2 = node("ms_e4/EPIC-904/#2", { id: "draft", title: "2. Plan enforcement", status: "active", color: "blue", flags: ["stale"], notes: ["untouched"] });
const ROOT = node("ms_e4/EPIC-904", { id: "EPIC-904", kind: "spine", title: "Doctrine 2", status: "active", color: "blue", path: "docs/EPIC-904-DOCTRINE-2.md", children: [ROW1, ROW2] });
const tree = (over: Partial<NodeTree> = {}): NodeTree => ({
  milestoneId: "ms_e4",
  root: ROOT,
  counts: { grey: 0, blue: 2, yellow: 0, red: 1, green: 0 },
  nonGreen: 3,
  closed: 0,
  flagged: 1,
  source: "spines",
  warnings: [],
  repo: "epicspine-skill",
  remote: "Acme/epicspine-skill",
  tracked: {},
  ...over,
});
const ask: WaitingItem = {
  id: "wj_e4",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "1",
  milestoneId: "ms_e4",
  milestoneTitle: "EPIC-904",
  nodeKey: ROW1.key,
  path: "docs/EPIC-904-DOCTRINE-2.md",
  title: "1. Define the doctrine",
  ask: "approve",
  question: "Approve the doctrine page and enforcement plan (steps 1+2) as one?",
  recommendation: "approve, with both small answers yes",
  contextLinks: [{ label: "approval page", url: "http://vps-a9-1.tail.example:36879/index.html" }],
  owner: { kind: "none", label: "no one to deliver to, attach a persona" },
  decidable: false,
};
const milestone = { id: "ms_e4", title: "EPIC-904", repo: "Acme/epicspine-skill", path: "docs/EPIC-904-DOCTRINE-2.md", owner: "", paused: false, createdAt: "2026-10-21T00:00:00Z", nonGreen: 3 } as Milestone;

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
const at = (url: string, el: JSX.Element, path: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={path} element={el} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe("tree Open action", () => {
  it("links every spine and ticket node (not DoD, not refs) to its node view", () => {
    const dod = node("ms_e4/EPIC-904/dod:E4-1:0", { kind: "dod", id: "E4-1" });
    const ref = node("ms_e4/EPIC-904/x", { flags: ["repeat"] });
    render(
      <MemoryRouter>
        <EpicTree tree={tree({ root: { ...ROOT, children: [ROW1, ROW2, dod, ref] } })} openHref={(n) => milestoneNodeHref("ms_e4", n.key)} />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole("link", { name: /^Open / });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/milestones/ms_e4/node/ms_e4%2FEPIC-904",
      "/milestones/ms_e4/node/ms_e4%2FEPIC-904%2F%231",
      "/milestones/ms_e4/node/ms_e4%2FEPIC-904%2F%232",
    ]);
  });
});

describe("link helpers (M2-16 breadcrumb hook)", () => {
  it("nodeViewHref = milestone node view; spineHref = tracked milestone, else ad hoc view", () => {
    expect(nodeViewHref("ms_e4", "ms_e4/EPIC-904/#1")).toBe("/milestones/ms_e4/node/ms_e4%2FEPIC-904%2F%231");
    const ref = { repo: "epicspine-skill", path: "docs/EPIC-900-OPERATING-SYSTEM.md" };
    expect(spineHref(ref, { "docs/EPIC-900-OPERATING-SYSTEM.md": "ms_0" })).toBe("/milestones/ms_0");
    expect(spineHref(ref, {})).toBe("/spines/epicspine-skill/view?path=docs%2FEPIC-900-OPERATING-SYSTEM.md");
  });
});

describe("milestone node view", () => {
  it("round-trips the encoded node key and shows a leaf's row facts and scoped waiting, no subtree", async () => {
    vi.spyOn(api, "getMilestone").mockResolvedValue(milestone);
    const leaf = { ...ROW1, dependsOn: "#17, #18, #19", nextAction: "Dispatch when #17-#19 are integrated" };
    const getNodeTree = vi.spyOn(api, "getNodeTree").mockResolvedValue(tree({ root: leaf, counts: { grey: 0, blue: 0, yellow: 0, red: 1, green: 0 }, nonGreen: 1, flagged: 0, tracked: { "docs/EPIC-904-DOCTRINE-2.md": "ms_e4" } }));
    const waiting = vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask]);
    const runs = vi.spyOn(api, "listRuns").mockResolvedValue([]);
    vi.spyOn(api, "listAssignments").mockResolvedValue([]);
    at(milestoneNodeHref("ms_e4", ROW1.key), <MilestoneNodePage />, "/milestones/:id/node/:nodeKey");
    const facts = await screen.findByTestId("row-facts", {}, W);
    expect(getNodeTree).toHaveBeenCalledWith("ms_e4", "ms_e4/EPIC-904/#1");
    // one milestone's runs, never all of them.
    expect(runs).toHaveBeenCalledWith({ milestoneId: "ms_e4" });
    expect(facts.textContent).toContain("Depends on#17, #18, #19");
    expect(facts.textContent).toContain("Next actionDispatch when #17-#19 are integrated");
    // A leaf has no subtree: no summary card, no counts row, no one-row tree.
    expect(screen.queryByTestId("subtree-summary")).toBeNull();
    expect(screen.queryByTestId("tree-counts")).toBeNull();
    // The waiting query starts in a passive effect after the commit that shows the summary, so the call is only
    // guaranteed once its data has rendered: wait for the card before asserting on the call.
    expect(await screen.findByText(/^Approve the doctrine page/, {}, W)).toBeTruthy();
    expect(waiting).toHaveBeenCalledWith({ milestoneId: "ms_e4", nodeKey: "ms_e4/EPIC-904/#1", includeSuperseded: true });
    // the context links sit under More, opened by the card's heading
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.getByText("approval page").closest("a")!.getAttribute("href")).toBe("http://vps-a9-1.tail.example:36879/index.html");
    expect(screen.queryByText("heuristic")).toBeNull();
    // A ticket node: no Track action.
    expect(screen.queryByRole("button", { name: /Track as project/ })).toBeNull();
  });

  it("a tracked spine links to its milestone; an untracked one is tracked through createMilestone", async () => {
    vi.spyOn(api, "getMilestone").mockResolvedValue(milestone);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const child = node("ms_e4/EPIC-904/EPIC-905", { kind: "spine", id: "EPIC-905", title: "Next", path: "docs/EPIC-905.md" });
    vi.spyOn(api, "getNodeTree").mockResolvedValue(tree({ root: child, tracked: { "docs/EPIC-904-DOCTRINE-2.md": "ms_e4" } }));
    const create = vi.spyOn(api, "createMilestone").mockResolvedValue({ ...milestone, id: "ms_new" });
    at(milestoneNodeHref("ms_e4", child.key), <MilestoneNodePage />, "/milestones/:id/node/:nodeKey");
    fireEvent.click(await screen.findByRole("button", { name: /Track as project/ }, W));
    expect(await screen.findByTestId("where", {}, W)).toBeTruthy();
    expect(create).toHaveBeenCalledWith({ title: "Next", repo: "Acme/epicspine-skill", path: "docs/EPIC-905.md", owner: "" });
    expect(screen.getByTestId("where").textContent).toBe("/milestones/ms_new");
    cleanup();

    vi.spyOn(api, "getNodeTree").mockResolvedValue(tree({ tracked: { "docs/EPIC-904-DOCTRINE-2.md": "ms_e4" } }));
    at(milestoneNodeHref("ms_e4", ROOT.key), <MilestoneNodePage />, "/milestones/:id/node/:nodeKey");
    expect((await screen.findByRole("link", { name: "Project page" }, W)).getAttribute("href")).toBe("/milestones/ms_e4");
    expect(screen.queryByRole("button", { name: /Track as project/ })).toBeNull();
  });
});

describe("node with children", () => {
  it("draws the counts row once (the tree's), the flagged list in From here down, and no row facts without cells", async () => {
    vi.spyOn(api, "getMilestone").mockResolvedValue(milestone);
    vi.spyOn(api, "getNodeTree").mockResolvedValue(tree({ tracked: { "docs/EPIC-904-DOCTRINE-2.md": "ms_e4" } }));
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listRuns").mockResolvedValue([]);
    vi.spyOn(api, "listAssignments").mockResolvedValue([]);
    at(milestoneNodeHref("ms_e4", ROOT.key), <MilestoneNodePage />, "/milestones/:id/node/:nodeKey");
    const summary = await screen.findByTestId("subtree-summary", {}, W);
    expect(within(summary).getByTestId("subtree-flags").textContent).toContain("2. Plan enforcement");
    expect(screen.getAllByTestId("tree-counts")).toHaveLength(1);
    expect(screen.queryByTestId("row-facts")).toBeNull();
  });
});

describe("ad hoc spine view", () => {
  it("opens an untracked spine: read-only waiting cards, Track as project", async () => {
    const getSpineTree = vi.spyOn(api, "getSpineTree").mockResolvedValue(tree({ milestoneId: "spine", root: { ...ROOT, key: "spine/EPIC-904" } }));
    const waiting = vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([{ ...ask, milestoneId: "spine" }]);
    at(spineViewHref({ repo: "epicspine-skill", path: "docs/EPIC-904-DOCTRINE-2.md" }), <SpineViewPage />, "/spines/:repo/view");
    expect(await screen.findByText(/^Approve the doctrine page/, {}, W)).toBeTruthy();
    expect(getSpineTree).toHaveBeenCalledWith({ repo: "epicspine-skill", path: "docs/EPIC-904-DOCTRINE-2.md", title: undefined, nodeKey: undefined });
    expect(waiting).toHaveBeenCalledWith({ repo: "epicspine-skill", path: "docs/EPIC-904-DOCTRINE-2.md", title: undefined, nodeKey: "spine/EPIC-904" });
    expect(screen.getByText(/Track as project to answer here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.getByRole("button", { name: /Track as project/ })).toBeTruthy();
  });
});

describe("Spines page", () => {
  const listing: SpineListing = {
    repo: "epicspine-skill",
    remote: "Acme/epicspine-skill",
    root: "docs/EPIC-900-OPERATING-SYSTEM.md",
    fetchedAt: new Date().toISOString(),
    refreshing: false,
    nodes: [
      { path: "docs/EPIC-900-OPERATING-SYSTEM.md", id: "EPIC-900", title: "Operating system", status: "active", color: "blue", rollup: "active", rollupColor: "blue", parent: null, depth: 0, dod: { done: 1, total: 4 }, openAsks: 0 },
      { path: "docs/EPIC-904-DOCTRINE-2.md", id: "EPIC-904", title: "Doctrine 2", status: "active", color: "blue", rollup: "active", rollupColor: "blue", parent: "docs/EPIC-900-OPERATING-SYSTEM.md", depth: 1, dod: { done: 0, total: 5 }, openAsks: 1, milestoneId: "ms_e4" },
    ],
  };
  it("lists EpicSpine repos with each spine's color, open asks and an ad hoc link; caches per repo", async () => {
    vi.spyOn(api, "listRepos").mockResolvedValue([
      { name: "epicspine-skill", path: "/r/epicspine-skill", remote: "Acme/epicspine-skill", hasEpicSpine: true },
      { name: "plain", path: "/r/plain", hasEpicSpine: false },
    ]);
    const list = vi.spyOn(api, "listRepoSpines").mockResolvedValue(listing);
    at("/spines", <SpinesPage />, "/spines");
    const rows = await screen.findAllByTestId("spine-row", {}, W);
    expect(rows).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("epicspine-skill");
    expect(screen.getByTestId("spine-count").textContent).toBe("2 spines");
    expect(within(rows[1]).getByTestId("open-asks").textContent).toBe("1 ask");
    expect(within(rows[1]).getByText("tracked")).toBeTruthy();
    expect(rows[1].querySelector("[data-testid=tree-dot]")!.getAttribute("data-color")).toBe("blue");
    expect(within(rows[1]).getByRole("link").getAttribute("href")).toBe(spineViewHref({ repo: "epicspine-skill", path: "docs/EPIC-904-DOCTRINE-2.md", title: "Doctrine 2" }));
    expect(screen.getByText("Show 1 repos without EpicSpine")).toBeTruthy();
    cleanup();

    // Revisit: cached rows render before the read answers.
    list.mockReturnValue(new Promise(() => {}));
    at("/spines", <SpinesPage />, "/spines");
    expect(await screen.findAllByTestId("spine-row", {}, W)).toHaveLength(2);
  });
});

describe("Team page cards", () => {
  it("show non-green and waiting-on-you counts per milestone", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([milestone, { ...milestone, id: "ms_2", title: "Other", nonGreen: 0 }]);
    vi.spyOn(api, "listAssignments").mockResolvedValue([]);
    vi.spyOn(api, "listRuns").mockResolvedValue([]);
    vi.spyOn(api, "listThreads").mockResolvedValue([]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([]);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask]);
    // the card's count is the server status batch's needsYou for that milestone.
    const st = (id: string, needsYou: number) => ({ milestoneId: id, outcome: { word: "not_yet" as const, source: "derived" as const }, flow: { word: needsYou ? ("needs_you" as const) : ("nothing_to_do" as const), reason: "" }, items: [], needsYou, reasons: [] });
    // the count is the length of the milestone's open items (the list Blocked shows), not a bare number.
    const open = { id: ask.id, kind: "ask" as const, state: "open" as const, milestoneId: milestone.id, title: "Approve the doctrine page" };
    vi.spyOn(api, "listStatus").mockResolvedValue({ milestones: [{ ...st(milestone.id, 1), items: [open] }, st("ms_2", 0)], items: [open], needsYou: 1, at: "" });
    render(
      <MemoryRouter>
        <TeamPage section="settings" />
      </MemoryRouter>,
    );
    // the cards live on the Inbox; the overview's project cards keep their counts.
    const counts = await screen.findAllByTestId("card-counts", {}, W);
    expect(counts.map((c) => c.textContent)).toEqual(["3 non-green1 waiting on you", "all green0 waiting on you"]);
  });
});
