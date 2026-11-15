// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { CycleOffBanner, DodCard, Overview, PersonasTab, SettingsTab, SpineShapeHint, TicketStatus, UNTRACKED_NOTE } from "@/pages/Milestone";
import type { Assignment, Milestone, Persona, Run, TreeNode, WaitingItem } from "@/api";
import { dodCount } from "@/lib/format";
import { PersonaDialog, remitHint, remitPlaceholder } from "@/components/dialogs";

// Radix Switch measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CycleOffBanner", () => {
  it("says wakes and Run now are off when GET /api/cycle is disabled", async () => {
    vi.spyOn(api, "getCycle").mockResolvedValue({ enabled: false });
    render(<CycleOffBanner />);
    expect((await screen.findByRole("status")).textContent).toMatch(/Scheduler is off — wakes won't fire and Run now is unavailable/);
  });
  it("renders nothing when the cycle is on", async () => {
    const spy = vi.spyOn(api, "getCycle").mockResolvedValue({ enabled: true });
    const { container } = render(<CycleOffBanner />);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("PersonaDialog remit guidance", () => {
  it("tells the user to write the job, not the milestone, with a generic example", () => {
    render(<PersonaDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(remitHint())).toBeTruthy();
    expect(remitHint()).toContain("not the project");
    const remit = screen.getByLabelText("Remit") as HTMLTextAreaElement;
    expect(remit.placeholder).toBe(remitPlaceholder());
    fireEvent.change(remit, { target: { value: "x" } });
    expect(remit.value).toBe("x");
  });
});

const ms = (dod: Milestone["dod"]): Milestone => ({
  id: "ms_1",
  title: "EPIC-902",
  repo: "ops",
  path: "docs/EPIC-902-MAIN-CONTROL.md",
  owner: "Sam",
  paused: false,
  createdAt: "2026-10-16T00:00:00Z",
  dod,
});

describe("DodCard", () => {
  it("untracked Exit Test: 'N criteria', neutral dots, the note, no progress bar, bold rendered", () => {
    const items = ["**CPU**: <= 1.5 cores", "**Disk**: root <= 60%", "**Memory**: limits", "**Data safe**: dump", "**Nothing silent**"].map((text, i) => ({ text, checked: null, id: String(i + 1) }));
    const { container } = render(<DodCard m={ms({ done: 0, total: 0, items, tracked: false })} />);
    expect(screen.getByText("5 criteria")).toBeTruthy();
    expect(screen.queryByText("0/0")).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain("These criteria aren't checkboxes, so progress can't be tracked.");
    expect(container.textContent).not.toContain("**");
    expect(screen.getByText("CPU").tagName).toBe("STRONG");
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(Array.from(container.querySelectorAll("li")).map((li) => li.textContent?.slice(0, 3))).toEqual(["1.C", "2.D", "3.M", "4.D", "5.N"]);
    expect(container.querySelector("svg.lucide-square, svg.lucide-check-square")).toBeNull();
    expect(UNTRACKED_NOTE).toMatch(/Make them `- \[ \]` items under `## Definition Of Done`/);
  });

  it("tracked checklist keeps the done/total header and progress bar", () => {
    const { container } = render(<DodCard m={ms({ done: 0, total: 7, tracked: true, items: Array.from({ length: 7 }, (_, i) => ({ text: `item ${i}`, checked: false })) })} />);
    expect(screen.getByText("0/7")).toBeTruthy();
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.textContent).not.toContain("aren't checkboxes");
  });
});

describe("SpineShapeHint + labels", () => {
  it("lists found and missing sections with what EpicSpine expects", () => {
    const { container } = render(<SpineShapeHint shape={{ dod: false, currentState: true, status: true, waitingOn: false, issueLedger: true, queue: true }} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("4/6 sections read · 2 missing");
    expect(container.textContent).toContain("Waiting on — EpicSpine expects");
    expect(container.textContent).not.toContain("Issue Ledger — EpicSpine expects");
  });

  it("dodCount and status detail tooltip", () => {
    expect(dodCount({ done: 0, total: 0, items: [{ text: "a", checked: null }], tracked: false })).toBe("1 criterion");
    expect(dodCount({ done: 2, total: 3, items: [] })).toBe("2/3");
    expect(dodCount(undefined)).toBe("0/0");
    render(<TicketStatus status="blocked" detail="waiting on Sam's go (since 10-13)" />);
    expect(screen.getByTitle("waiting on Sam's go (since 10-13)").textContent).toBe("blocked");
  });
});

async function renderPage(search = "", patch: Partial<Milestone> = {}) {
  const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
  const { MilestonePage } = await import("@/pages/Milestone");
  const m = await api.createMilestone({ title: "Treeish", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
  const real = api.getMilestone.bind(api);
  vi.spyOn(api, "getMilestone").mockImplementation(async (id) => ({ ...(await real(id)), ...patch }));
  const loc = { search: "" };
  function Spy() {
    loc.search = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[`/milestones/${m.id}${search}`]}>
      <Routes>
        <Route
          path="/milestones/:id"
          element={
            <>
              <MilestonePage />
              <Spy />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { m, loc };
}

const waitingItem = (id: string, question: string): WaitingItem => ({
  id,
  source: "needs_jordi",
  state: "open",
  milestoneId: "ms_x",
  milestoneTitle: "x",
  title: question,
  ask: "approve",
  question,
  contextLinks: [],
  owner: { kind: "none", label: "nobody" },
} as unknown as WaitingItem);

describe("Milestone page layout (M2-16)", () => {
  it("tabs in order, Summary is the default with no ?tab", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    await renderPage();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Summary", "Waiting on you", "Tree", "Chat", "Deck", "Activity", "Personas", "Approvals", "Backlog", "Definitions", "Settings"]);
    expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
  });

  it("E965-S4 (was E917-S2's wrap): the tab strip is one 36 px row at every width; what does not fit folds under More", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    await renderPage();
    const list = await screen.findByRole("tablist");
    const cls = list.className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["h-9", "flex-nowrap", "[&>button]:shrink-0"]));
    expect(cls).not.toContain("flex-wrap");
    // every tab carries its id for the fold; jsdom has no layout, so none is folded and no More shows on a milestone
    expect(Array.from(list.querySelectorAll("[role=tab]")).every((t) => t.getAttribute("data-tab-id"))).toBe(true);
    expect(screen.queryByTestId("more-tabs")).toBeNull();
  });

  it("E917-S2: Backlog hides Source and lets Title narrow below sm, so the table fits a phone", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "getBacklog").mockResolvedValue([{ id: "E5-1", title: "Fleet inventory", status: "done", owner: "worker", source: "ledger" }] as never);
    await renderPage("?tab=backlog");
    const source = await screen.findByRole("columnheader", { name: "Source" });
    expect(source.className).toMatch(/(^| )hidden( |$)/);
    expect(source.className).toContain("sm:table-cell");
    expect(screen.getByRole("cell", { name: "ledger" }).className).toContain("sm:table-cell");
    expect(screen.getByRole("cell", { name: "Fleet inventory" }).className).toContain("min-w-[8rem] sm:min-w-[12rem]");
  });

  it("Summary: strip hidden at 0, tiles link to their tabs", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    await renderPage();
    const tree = await screen.findByRole("link", { name: "Tree tab" });
    expect(tree.getAttribute("href")).toMatch(/\?tab=tree$/);
    expect(screen.getByRole("link", { name: "Personas tab" }).getAttribute("href")).toMatch(/\?tab=personas$/);
    expect(screen.getByRole("link", { name: "Activity tab" }).getAttribute("href")).toMatch(/\?tab=activity$/);
    expect(screen.queryByTestId("waiting-strip")).toBeNull();
    expect(screen.getByTestId("waiting-count").textContent).toBe("0");
    fireEvent.click(tree);
    expect((await screen.findByRole("tab", { name: /^Tree/ })).getAttribute("aria-selected")).toBe("true");
  });

  it("E913-S7: Tree tab label carries red / amber / blue count pills (zero hidden) and the tile labels its numbers", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const ready: TreeNode = { key: "k/S2", id: "S2", kind: "ticket", title: "ready one", status: "ready", color: "grey", children: [], flags: [], ready: true };
    const root: TreeNode = { key: "k/R", id: "R", kind: "spine", title: "root", status: "active", color: "blue", children: [ready], flags: [] };
    const getTree = vi.spyOn(api, "getTree").mockResolvedValue({ milestoneId: "x", root, counts: { grey: 3, blue: 1, yellow: 5, red: 0, green: 1 }, nonGreen: 9, closed: 0, flagged: 0, source: "spines", warnings: [] });
    await renderPage();
    const tab = await screen.findByRole("tab", { name: /^Tree/ });
    await waitFor(() => expect(screen.getByTestId("tree-tab-yellow").textContent).toBe("5"));
    expect(screen.queryByTestId("tree-tab-red")).toBeNull();
    expect(screen.getByTestId("tree-tab-yellow").getAttribute("title")).toBe("5 blocked");
    // the ready row counts as open, like the tree draws it
    expect(screen.getByTestId("tree-tab-blue").getAttribute("aria-label")).toBe("2 open");
    expect(tab.textContent?.replace(/\d+$/, "")).toBe("Tree");
    expect(screen.getByTestId("tile-count-yellow").textContent).toBe("5blocked on a dependency");
    expect(screen.getByTestId("tile-count-grey").textContent).toBe("2draft");
    expect(getTree).toHaveBeenCalledTimes(1); // the tab pills and the Summary tile share one fetch
  });

  it("E913-S8: tile counts link to the Tree tab filtered to that color; ?show= filters the tree and clicks update it", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const leaf = (id: string, color: TreeNode["color"]): TreeNode => ({ key: `k/${id}`, id, kind: "ticket", title: `t ${id}`, status: color, color, children: [], flags: [] });
    const root: TreeNode = { key: "k/R", id: "R", kind: "spine", title: "root", status: "active", color: "blue", children: [leaf("Y1", "yellow"), leaf("G1", "green")], flags: [] };
    vi.spyOn(api, "getTree").mockResolvedValue({ milestoneId: "x", root, counts: { grey: 0, blue: 1, yellow: 1, red: 0, green: 1 }, nonGreen: 2, closed: 0, flagged: 0, source: "spines", warnings: [] });
    const { loc } = await renderPage();
    const yellow = await screen.findByTestId("tile-count-yellow");
    expect(yellow.getAttribute("href")).toMatch(/\?tab=tree&show=yellow$/);
    expect(screen.getByTestId("tile-count-red").tagName).toBe("SPAN"); // zero: not a link
    expect(screen.getByRole("link", { name: "Tree tab" }).getAttribute("href")).toMatch(/\?tab=tree$/);
    fireEvent.click(yellow);
    await waitFor(() => expect(screen.getByTestId("count-yellow").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("t Y1")).toBeTruthy();
    expect(screen.queryByText("t G1")).toBeNull();
    fireEvent.click(screen.getByTestId("count-green"));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("show")).toBe("yellow,green"));
    expect(screen.getByText("t G1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tree-filter-clear"));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("show")).toBeNull());
  });

  it("Summary strip: count, first two asks, see all → Waiting on you tab; red badge", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([waitingItem("w1", "Rotate the key"), waitingItem("w2", "Pick the host"), waitingItem("w3", "Third ask")]);
    await renderPage();
    const strip = await screen.findByTestId("waiting-strip");
    expect(strip.textContent).toContain("Rotate the key");
    expect(strip.textContent).toContain("Pick the host");
    expect(within(strip).getAllByTestId("ask-kind").map((t) => t.textContent)).toEqual(["Approve", "Approve"]);
    expect(strip.textContent).not.toContain("Third ask");
    // the pill stays first, before the code
    const li = within(strip).getAllByRole("listitem")[0];
    expect(li.firstElementChild).toBe(within(li).getByTestId("ask-kind"));
    expect(screen.getByTestId("waiting-count").className).toContain("bg-amber-500"); // amber = Needs you
    fireEvent.click(screen.getByRole("link", { name: "see all →" }));
    expect((await screen.findByRole("tab", { name: /Waiting on you/ })).getAttribute("aria-selected")).toBe("true");
  });

  it("old ?tab=overview opens Definitions; old ?node= link opens Tree", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    await renderPage("?tab=overview");
    expect((await screen.findByRole("tab", { name: "Definitions" })).getAttribute("aria-selected")).toBe("true");
    cleanup();
    const { tabFromParams } = await import("@/pages/Milestone");
    expect(tabFromParams(new URLSearchParams("node=EPIC-902/E904"))).toBe("tree");
    expect(tabFromParams(new URLSearchParams("tab=bogus"))).toBe("summary");
    expect(tabFromParams(new URLSearchParams("tab=summary&node=x"))).toBe("summary");
  });

  it("switching to Summary while a node is selected keeps the node and an explicit tab", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const { loc } = await renderPage("?node=a/b");
    const summary = await screen.findByRole("tab", { name: "Summary" });
    fireEvent.mouseDown(summary);
    await vi.waitFor(() => expect(loc.search).toBe("?tab=summary&node=a%2Fb"));
  });

  const chain = { servesChain: [{ path: "docs/EPIC-900-VPS-FLEET.md", title: "EPIC-900 VPS fleet" }, { path: "docs/spines/root.md", title: "ops root" }] };

  it("ancestry breadcrumb: root first, this milestone last; crumbs open in the console (M2-14 hooks)", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listRepos").mockResolvedValue([{ name: "ops", path: "/repos/ops", remote: "Acme/ops", hasEpicSpine: true }]);
    const root = await api.createMilestone({ title: "infra root", repo: "Acme/ops", path: "docs/spines/root.md", owner: "Sam" });
    await renderPage("", { repo: "Acme/ops", remote: "Acme/ops", doctrine: chain });
    const nav = await screen.findByRole("navigation", { name: "Ancestry" });
    expect(nav.textContent).toBe("ops rootEPIC-900 VPS fleetTreeish");
    // Tracked ancestor → its milestone; untracked → the ad hoc spine view of that checkout.
    await vi.waitFor(() => expect(screen.getByRole("link", { name: "ops root" }).getAttribute("href")).toBe(`/milestones/${root.id}`));
    expect(screen.getByRole("link", { name: "EPIC-900 VPS fleet" }).getAttribute("href")).toBe("/spines/ops/view?path=docs%2FEPIC-900-VPS-FLEET.md&title=EPIC-900+VPS+fleet");
  });

  it("ancestry crumbs fall back to GitHub when the checkout is unknown", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listRepos").mockResolvedValue([]);
    await renderPage("", { repo: "Acme/ops", remote: "Acme/ops", doctrine: chain });
    const crumb = await screen.findByRole("link", { name: "ops root" });
    expect(crumb.getAttribute("href")).toBe("https://github.com/Acme/ops/blob/HEAD/docs/spines/root.md");
  });

  it("no breadcrumb on a root spine", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    await renderPage();
    await screen.findAllByRole("tab");
    expect(screen.queryByRole("navigation", { name: "Ancestry" })).toBeNull();
  });
});

describe("Milestone page Tree tab (M2-10)", () => {
  it("opens from a ?tab=tree link and renders the epic tree", async () => {
    const { MemoryRouter, Route, Routes } = await import("react-router-dom");
    const { MilestonePage } = await import("@/pages/Milestone");
    const m = await api.createMilestone({ title: "Treeish", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    render(
      <MemoryRouter initialEntries={[`/milestones/${m.id}?tab=tree`]}>
        <Routes>
          <Route path="/milestones/:id" element={<MilestonePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByRole("tab", { name: /^Tree/ })).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("tree-counts")).toBeTruthy();
    expect(screen.getByRole("tree")).toBeTruthy();
  });
});

describe("Overview with Doctrine-2 fields", () => {
  const doctrine: NonNullable<Milestone["doctrine"]> = {
    goal: "Every epic states its goal.",
    serves: "Gives EPIC-900 a self-explaining tree.",
    servesChain: [{ path: "docs/EPIC-900-OPERATING-SYSTEM.md", title: "EPIC-900: EpicSpine operating system" }],
    children: [
      { path: "docs/EPIC-903-EPIC-LOG.md", title: "EPIC-903: Epic log", status: "done", contributes: "Discovers the epic tree." },
      { path: "docs/EPIC-905-CONSOLE-OVERVIEW.md", title: "EPIC-905: Console overview", status: "ready" },
    ],
    doneMeans: [
      { id: "DOD-1", text: "spines.py emits the fields", done: true },
      { id: "DOD-2", text: "console renders them", done: false },
    ],
    pages: [{ path: "docs/doctrine/enforcement.md", title: "Doctrine enforcement plan", via: "docs/EPIC-904-DOCTRINE-2.md" }],
    missingSections: ["goal", "serves"],
  };
  const withDoctrine = (d?: Milestone["doctrine"]): Milestone => ({
    ...ms({ done: 0, total: 1, items: [{ text: "old dod item", checked: false }] }),
    status: "active",
    doctrine: d,
  });
  const order = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-section]")).map((e) => e.getAttribute("data-section"));
  const renderOverview = (m: Milestone) => render(<MemoryRouter><Overview m={m} /></MemoryRouter>);

  it("renders compliance note, goal, serves chain, children, done means, pages, then the existing content", () => {
    const { container } = renderOverview(withDoctrine(doctrine));
    expect(order(container)).toEqual(["compliance", "goal", "serves", "children", "done-means", "pages", "existing"]);
    expect(container.textContent).toContain("not yet compliant: goal, serves");
    const serves = container.querySelector('[data-section="serves"]')!.textContent!;
    expect(serves.indexOf("Gives EPIC-900")).toBeLessThan(serves.indexOf("EPIC-900: EpicSpine operating system"));
    const children = container.querySelector('[data-section="children"]')!;
    expect(children.querySelectorAll("li")).toHaveLength(2);
    expect(children.textContent).toContain("Discovers the epic tree.");
    expect(children.textContent).toContain("done");
    const dm = container.querySelector('[data-section="done-means"]')!;
    expect(dm.textContent).toContain("1/2");
    expect(dm.querySelectorAll("svg.lucide-square-check-big, svg.lucide-check-square, svg.lucide-square")).toHaveLength(2);
    expect(container.querySelector('[data-section="pages"]')!.textContent).toContain("via docs/EPIC-904-DOCTRINE-2.md");
    // Done means replaces the Definition of Done card.
    expect(container.textContent).not.toContain("Definition of Done");
    expect(container.textContent).not.toContain("old dod item");
  });

  it("E908-S19: the Blocked card is amber only while asks are open, plain otherwise (never red)", () => {
    const blocked = { ...withDoctrine(undefined), status: "blocked" as const, blockedReason: "Waiting on: Sam" };
    const { unmount } = renderOverview(blocked);
    const plain = document.querySelector('[data-testid="blocked-card"]')!;
    expect(plain.outerHTML).not.toMatch(/red-|amber-/);
    unmount();
    render(<MemoryRouter><Overview m={blocked} needsYou /></MemoryRouter>);
    const amber = document.querySelector('[data-testid="blocked-card"]')!;
    expect(amber.outerHTML).toMatch(/amber-/);
    expect(amber.outerHTML).not.toMatch(/red-/);
  });

  it("absent fields render nothing; no doctrine looks as today", () => {
    const { container } = renderOverview(withDoctrine({ goal: "Only a goal.", servesChain: [{ path: "docs/root.md", title: "root" }] }));
    expect(order(container)).toEqual(["goal", "existing"]);
    expect(container.textContent).not.toContain("not yet compliant");
    expect(container.textContent).toContain("Definition of Done"); // no doneMeans → DoD card stays
    cleanup();
    const today = renderOverview(withDoctrine(undefined));
    expect(order(today.container)).toEqual(["existing"]);
    expect(today.container.textContent).toContain("old dod item");
  });

  it("with an Outcome (M2-12 card now on Summary, M2-16), Definitions still lists Done means", () => {
    const m: Milestone = {
      ...withDoctrine(doctrine),
      outcome: { verdict: "accomplished", sentence: "done", evidence: [], risk: null, closedAt: null, closedBy: null },
    };
    const { container } = renderOverview(m);
    expect(order(container)).toEqual(["compliance", "goal", "serves", "children", "done-means", "pages", "existing"]);
  });
});

describe("Waiting-on-you deep link (M2-19)", () => {
  it("?tab=waiting&item=<id> opens the tab and highlights that card", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([waitingItem("nj_a", "First"), waitingItem("nj_b", "Root steps on HOST1?")]);
    await renderPage("?tab=waiting&item=nj_b");
    expect((await screen.findByRole("tab", { name: /Waiting on you/ })).getAttribute("aria-selected")).toBe("true");
    await vi.waitFor(() => expect(document.getElementById("waiting-nj_b")?.getAttribute("data-highlighted")).toBe("true"), { timeout: 5000 });
    expect(document.getElementById("waiting-nj_b")?.className).toContain("ring-sky-500");
    expect(document.getElementById("waiting-nj_a")?.getAttribute("data-highlighted")).toBeNull();
  });
});

describe("Steer (M2-37)", () => {
  const m = { id: "ms_1", title: "E904", repo: "r", path: "p", owner: "Sam", paused: false, createdAt: "2026-10-16T00:00:00Z" } as Milestone;
  const persona: Persona = { id: "per_1", name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false, createdAt: "2026-10-16T00:00:00Z" };
  const asg: Assignment = { id: "asg_1", milestoneId: "ms_1", personaId: "per_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true };
  const run = (outcome: Run["outcome"]): Run => ({ id: "run_1", assignmentId: "asg_1", startedAt: "2026-10-22T10:00:00Z", outcome, summary: "woke", threadId: "mcp:t1" });
  const setup = (runs: Run[]) => {
    vi.spyOn(api, "listAssignments").mockResolvedValue([asg]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([persona]);
    vi.spyOn(api, "listRuns").mockResolvedValue(runs);
    vi.spyOn(api, "getCycle").mockResolvedValue({ enabled: true });
    vi.spyOn(api, "listNeedsOwner").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <PersonasTab m={m} />
      </MemoryRouter>,
    );
  };

  it("shows Steer only while the assignment's run is running", async () => {
    setup([run("idle")]);
    await screen.findByText("Run now");
    expect(screen.queryByText("Steer")).toBeNull();
    cleanup();
    setup([run("running")]);
    expect(await screen.findByText("Steer")).toBeTruthy();
  });

  it("modal sends the message, disables Send while posting, closes on success", async () => {
    let done!: (v: unknown) => void;
    const steer = vi.spyOn(api, "steerAssignment").mockReturnValue(new Promise((r) => (done = r)) as never);
    setup([run("running")]);
    fireEvent.click(await screen.findByText("Steer"));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // empty message
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: " skip E904 " } });
    fireEvent.click(send);
    await waitFor(() => expect(steer).toHaveBeenCalledWith("asg_1", "skip E904", expect.stringMatching(/^console-steer-/)));
    expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(true);
    done({ run: run("running"), threadId: "mcp:t1", mode: "steer" });
    await waitFor(() => expect(screen.queryByLabelText("Message")).toBeNull());
  });

  it("keeps the modal open and shows the error inline when the send fails", async () => {
    vi.spyOn(api, "steerAssignment").mockRejectedValue(new Error("this assignment has no running run with a thread to steer"));
    setup([run("running")]);
    fireEvent.click(await screen.findByText("Steer"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/no running run/)).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });
});

describe("E906-S10 Activity 'Running' filter", () => {
  it("lists only wakes with a live run; the select has the option; no match → empty note", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_r", name: "runner" }] as never);
    const mid = async () => (await api.listMilestones()).filter((x) => x.title === "Treeish").at(-1)!.id;
    vi.spyOn(api, "listAssignments").mockImplementation(async () => [
      { id: "as_r", milestoneId: await mid(), personaId: "pe_r", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
    ]);
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    let live = true;
    vi.spyOn(api, "listRuns").mockImplementation(async () => [
      { id: "r_old", assignmentId: "as_r", startedAt: ago(120), endedAt: ago(110), outcome: "progressed", summary: "old wake" },
      { id: "r_new", assignmentId: "as_r", startedAt: ago(20), endedAt: ago(15), outcome: "progressed", summary: "new wake" },
      {
        id: "r_kid",
        assignmentId: "as_r",
        parentRunId: "r_new",
        startedAt: ago(14),
        outcome: "running",
        threadId: "th_kid",
        summary: "worker",
        t3: { status: live ? "live" : "completed", startedAt: ago(14), checkedAt: ago(1) },
      },
    ]);
    await renderPage("?tab=activity&kind=running");
    expect(await screen.findByText("worker running · 14 min")).toBeTruthy();
    expect(screen.getByText("new wake")).toBeTruthy();
    expect(screen.queryByText("old wake")).toBeNull();
    expect(screen.getByText("1 worker running")).toBeTruthy();
    const select = screen.getByLabelText("Kind") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["All runs", "Wake runs", "Answer runs", "Running"]);
    fireEvent.change(select, { target: { value: "" } });
    expect(await screen.findByText("old wake")).toBeTruthy();
    cleanup();
    live = false;
    await renderPage("?tab=activity&kind=running");
    expect(await screen.findByText("No runs match this filter.")).toBeTruthy();
  });
});

describe("E906-S26 Settings title wins over the spine title", () => {
  const SPINE = "EPIC 0 · Foundation Spine — operating behavior";
  it("no explicit title: header shows the spine's title; Settings starts from it and hints how to override", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    await renderPage("?tab=settings", { docTitle: SPINE });
    expect(await screen.findByRole("heading", { name: SPINE })).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(SPINE);
    expect(screen.getByText(`Shown instead of the spine's own title (${SPINE}). Clear to use the spine title.`)).toBeTruthy();
  });

  it("explicit title: header and Settings show it; saving a new one or clearing it sends the title", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const update = vi.spyOn(api, "updateMilestone").mockImplementation(async (id) => api.getMilestone(id));
    await renderPage("?tab=settings", { title: "Memo", docTitle: SPINE, titleOverride: true });
    expect(await screen.findByRole("heading", { name: "Memo" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SPINE })).toBeNull();
    const input = screen.getByLabelText("Title") as HTMLInputElement;
    expect(input.value).toBe("Memo");
    expect(input.required).toBe(false);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ title: "" })));
  });
});

describe("E906-S52 Settings form survives polling", () => {
  const base = { id: "ms_s52", title: "Saved title", repo: "Acme/home_repo", path: "docs/spines/x.md", owner: "Sam" } as unknown as Milestone;
  const view = (m: Milestone) => (
    <MemoryRouter>
      <SettingsTab m={m} />
    </MemoryRouter>
  );

  it("a new but equal milestone object (a poll) keeps what the user typed", () => {
    vi.spyOn(api, "getMilestoneStatus").mockResolvedValue(null as never);
    const { rerender } = render(view(base));
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Typed title" } });
    rerender(view({ ...base }));
    expect(title.value).toBe("Typed title");
    // Even a changed saved value elsewhere leaves the edited field alone.
    rerender(view({ ...base, owner: "Agent" }));
    expect(title.value).toBe("Typed title");
    expect((screen.getByDisplayValue("Agent") as HTMLInputElement).value).toBe("Agent");
  });

  it("a changed saved value with no local edits updates the form", () => {
    vi.spyOn(api, "getMilestoneStatus").mockResolvedValue(null as never);
    const { rerender } = render(view(base));
    rerender(view({ ...base, title: "Renamed elsewhere", repo: "Acme/other" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Renamed elsewhere");
    expect(screen.getByDisplayValue("Acme/other")).toBeTruthy();
  });

  it("after Save the form follows the saved values again", async () => {
    vi.spyOn(api, "getMilestoneStatus").mockResolvedValue(null as never);
    const update = vi.spyOn(api, "updateMilestone").mockResolvedValue(base);
    const { rerender } = render(view(base));
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "  New title  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    rerender(view({ ...base, title: "New title" }));
    await waitFor(() => expect(title.value).toBe("New title"));
  });
});

describe("E919-S1 milestone Chat tab", () => {
  it("opens this milestone's own repo-desk thread, never the Team desk, and sends to it", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const desk = vi.spyOn(api, "getDeskChat");
    const get = vi.spyOn(api, "getMilestoneChat");
    const send = vi.spyOn(api, "sendMilestoneChatMessage");
    const { m } = await renderPage("?tab=chat");
    expect((await screen.findByRole("tab", { name: "Chat" })).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Repo desk ready.")).toBeTruthy();
    expect(get).toHaveBeenCalledWith(m.id, { limit: 20 });
    expect(desk).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Open in T3/ }).getAttribute("href")).toContain(`repo-desk-${m.id}`);
    fireEvent.change(screen.getByLabelText("Message to the Repo desk"), { target: { value: "what happened today?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(m.id, "what happened today?", undefined, expect.stringMatching(/^chat-/)));
    expect(await screen.findByText(/mock repo desk/)).toBeTruthy();
  });

  it("does not open the thread until the tab is opened", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const get = vi.spyOn(api, "getMilestoneChat");
    await renderPage();
    await screen.findAllByRole("tab");
    expect(get).not.toHaveBeenCalled();
  });
});
