// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat } from "@/api";
import type { ScorecardsBody } from "@/api/pursuit-types";
import { GoalSetPage, GoalSetsPage, SidebarGoalSets, filterChat, krNumber, objectiveTab, pinDeciding } from "@/components/goalSets";
import { SCORECARD_PATH, SCORECARDS_PATH, SET_NAME, indexScorecards, homeOf, sortInbox, type InboxRow } from "@/lib/scorecards";

/**
 *  (the owner vn_fe52ef4a, vn_fd4f7a7a): every sidebar entry is a goal set, nested; one opens its table
 * of coloured rows, kanban, inbox, chat desk, context and personas; All goal sets on top holds the combined inbox,
 * sortable across the sets, and the team desk. The name is one setting.
 */
const BODY: ScorecardsBody = {
  nodes: [
    {
      id: "launch",
      kind: "pursuit",
      name: "Launch",
      rank: 1,
      milestoneId: "ms_1",
      greens: 1,
      total: 2,
      spines: ["app:docs/e1.md", "app:docs/e2.md"],
      objective: "A customer pays.",
      headline: "Customers pay",
      objectiveStatus: "proposed",
      objectiveWas: "A customer pays.",
      file: { path: "docs/scorecards/launch.json", present: false },
      teams: [{ persona: "Builder", enabled: true, pace: "every 60 min", paceNow: "every 30 min" }],
      spineRef: { repo: "app", code: "EPIC-901" },
      // the objective's key results, as its file gives them (the mock-up's shape)
      keyResults: [
        { label: "Testers apply", state: "red", value: "0 of 5", note: "read 13 Nov", target: "5 by 17 Nov", kind: "key-result", doneMeans: "E901-1", work: [{ code: "E901-S1", repo: "app", title: "Build the page", status: "ready", kind: "ticket", epicCode: "EPIC-901" }, { code: "E901-S9", repo: "app", status: "done", kind: "ticket" }] },
        { label: "Site answers", state: "green", value: "yes", kind: "key-result", work: [], evidence: { what: "the site itself", url: "https://app.example/" } },
        { label: "Most of your time goes here", state: "red", value: "14%", note: "aim 80%", kind: "key-result", work: [] },
      ],
      sidebar: [{ id: "launch~app:docs/e1.md", name: "Launch it", greens: 1, total: 2 }],
      rows: [
        { label: "Site answers", state: "green", value: "200", kind: "check" },
        { label: "Testers apply", state: "red", value: "0 of 5", kind: "check", group: "Testers come", target: "5", by: "2026-11-17", work: [{ code: "E901-S1", repo: "app", title: "Build the page", status: "ready", kind: "ticket", epicCode: "EPIC-901" }, { code: "E901-S9", repo: "app", status: "done", kind: "ticket" }] },
        { label: "Rows ready, waiting for a worker", state: "amber", value: "1", kind: "flow" },
      ],
      children: [
        {
          id: "launch~app:docs/e1.md",
          kind: "epic",
          name: "Launch epic",
          code: "EPIC-901",
          repo: "app",
          path: "docs/e1.md",
          milestoneId: "ms_1",
          greens: 1,
          total: 2,
          spines: ["app:docs/e1.md", "app:docs/e2.md"],
          rows: [{ label: "Site is up", state: "green", value: "done", kind: "done-means" }],
          children: [{ id: "launch~app:docs/e2.md", kind: "epic", name: "Testers", code: "EPIC-902", repo: "app", path: "docs/e2.md", greens: 0, total: 1, spines: ["app:docs/e2.md"], rows: [], children: [] }],
        },
      ],
    },
    { id: "folded", kind: "pursuit", name: "Folded", rank: 3, foldedInto: "launch", greens: 0, total: 0, spines: [], rows: [], children: [] },
    { id: "vault", kind: "pursuit", name: "Vault", rank: 2, greens: 0, total: 1, spines: ["app:docs/v.md"], rows: [{ label: "Logins saved", state: "red", value: "0", kind: "check" }], children: [] },
  ],
  progress: { since: "2026-11-12T00:00:00Z", today: 2, week: 5, sets: { launch: { today: 1, week: 3 }, vault: { today: 1, week: 2 } } },
  spineInfo: {
    "app:docs/e1.md": { repo: "app", path: "docs/e1.md", code: "EPIC-901", title: "Launch epic", doneMeans: { done: 1, total: 2 }, codes: ["E901-S1", "E901-A3"], queue: [{ code: "E901-S1", title: "Build the page", state: "ready", status: "ready" }] },
    "app:docs/e2.md": { repo: "app", path: "docs/e2.md", code: "EPIC-902", title: "Testers", doneMeans: { done: 0, total: 1 }, codes: ["E902-S1", "E902-S2"], queue: [{ code: "E902-S2", title: "Reddit post", state: "running", status: "active" }] },
    "app:docs/v.md": { repo: "app", path: "docs/v.md", title: "Vault", doneMeans: { done: 0, total: 1 }, codes: ["E909-A1"], queue: [] },
  },
};

const ASK = (id: string, code: string, since: string, priority: number) => ({ id, kind: "ask", state: "open", milestoneId: "ms_1", title: `Ask ${code}`, code, repo: "app", since, priority });

beforeEach(() => {
  vi.spyOn(api, "listScorecards").mockResolvedValue(BODY);
  vi.spyOn(api, "listStatus").mockResolvedValue({
    milestones: [],
    items: [ASK("a1", "E901-A3", "2026-11-12T10:00:00Z", 5), ASK("a2", "E909-A1", "2026-11-10T10:00:00Z", 9)],
    needsYou: 2,
    at: "2026-11-12T12:00:00Z",
  } as never);
  vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [] } as never);
  vi.spyOn(api, "listReviewItems").mockResolvedValue([{ id: "rv1", title: "Testers call", ref: "E902-S1", repo: "app", path: "docs/e2.md", state: "review", liveUrl: "https://x", createdAt: "2026-11-12", milestoneId: "ms_1" }] as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("goal sets: the pure parts", () => {
  it("places an item in the deepest set that holds its spine, by path or by code", () => {
    const ix = indexScorecards(BODY);
    expect(homeOf(ix, BODY.nodes, { repo: "app", path: "docs/e2.md", ref: "E902-S1" })?.node.name).toBe("Testers");
    expect(homeOf(ix, BODY.nodes, { repo: "owner/app", code: "E901-A3" })?.node.name).toBe("Launch epic");
    expect(homeOf(ix, BODY.nodes, { repo: "app", code: "E909-A1" })?.pursuit.name).toBe("Vault");
    expect(homeOf(ix, BODY.nodes, { repo: "app", code: "X-1" })).toBeUndefined();
  });

  it("sorts across the sets: his order, newest, longest waiting", () => {
    const ix = indexScorecards(BODY);
    const p = (id: string) => ix.byId.get(id);
    const rows: InboxRow[] = [
      { id: "old-vault", kind: "ask", title: "b", since: "2026-11-01T00:00:00Z", pursuit: p("vault") },
      { id: "new-launch", kind: "ask", title: "a", since: "2026-11-12T00:00:00Z", pursuit: p("launch") },
      { id: "nowhere", kind: "review", title: "c", since: "2026-11-11T00:00:00Z" },
    ];
    expect(sortInbox(rows, "priority").map((r) => r.id)).toEqual(["new-launch", "old-vault", "nowhere"]);
    expect(sortInbox(rows, "newest").map((r) => r.id)).toEqual(["new-launch", "nowhere", "old-vault"]);
    expect(sortInbox(rows, "waiting").map((r) => r.id)).toEqual(["old-vault", "nowhere", "new-launch"]);
  });

  it("the chat keeps his lines from this set (its tag or its codes) and the answers to them", () => {
    const chat = {
      available: true,
      working: false,
      sending: 0,
      hasEarlier: false,
      messages: [
        { id: "1", role: "user", kind: "message", text: "about the vault", status: "done" },
        { id: "2", role: "assistant", kind: "message", text: "vault answer", status: "done" },
        { id: "3", role: "user", kind: "message", text: "hi", page: `${SET_NAME.one} · Launch`, status: "done" },
        { id: "4", role: "assistant", kind: "message", text: "launch answer", status: "done" },
        { id: "5", role: "user", kind: "message", text: "what about E901-S1?", status: "done" },
      ],
    } as DeskChat;
    expect(filterChat(chat, `${SET_NAME.one} · Launch`, ["EPIC-901", "E901-"]).messages.map((m) => m.id)).toEqual(["3", "4", "5"]);
    // none of the desk's lines is about it: an empty view, not one stuck on loading
    const none = filterChat({ ...chat, stale: true } as typeof chat, `${SET_NAME.one} · Other`, ["E999-"]);
    expect(none.messages).toEqual([]);
    expect(none.stale).toBe(false);
  });
});

describe("goal sets: the screens", () => {
  it("the sidebar (as the mock-up): the Objectives heading on top with its counts, each objective with its strip of key results and its child epics in short words, nested", async () => {
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <SidebarGoalSets />
      </MemoryRouter>,
    );
    const all = await screen.findByTestId("sidebar-goal-sets-all");
    expect(all.getAttribute("href")).toBe(`/${SCORECARDS_PATH}`);
    // the heading says Objectives and opens every objective (its title still says All objectives).
    expect(all.textContent).toContain(SET_NAME.many);
    expect(all.getAttribute("title")).toBe("All objectives");
    expect(within(all).getByTestId("sidebar-all-counts").textContent).toBe("1 green · 3 red");
    expect(within(all).queryByTestId("sidebar-sets-asks")).toBeNull();
    expect(screen.getByTestId("sidebar-goal-sets").textContent).not.toContain("Objectives · by priority");
    const top = screen.getAllByTestId("sidebar-set").filter((x) => x.dataset.depth === "0");
    // a set folded into another objective is left out
    expect(top.map((x) => x.dataset.set)).toEqual(["launch", "vault"]);
    expect(within(top[0]).getByTestId("sidebar-set-link").getAttribute("href")).toBe("/sets/launch");
    expect(within(top[0]).getByTestId("sidebar-set-link").textContent).toContain("Customers pay");
    // only its name, its inbox pills and its colour circle: no strip, no child rows
    expect(within(top[0]).getByTestId("sidebar-set-wheel")).toBeTruthy();
    expect(within(top[0]).queryByTestId("kr-strip")).toBeNull();
    expect(within(top[0]).queryByTestId("sidebar-set-kids")).toBeNull();
    expect(within(top[0]).queryByTestId("sidebar-kid-link")).toBeNull();
    expect(within(top[0]).getByTestId("sidebar-set-asks").textContent).toBe("1");
    expect(within(top[0]).getByTestId("sidebar-set-review").textContent).toBe("1");
    // the open one adds no second list under its name: Board, Inbox, Chat desk and Social kit are its page's tabs
    expect(screen.queryByTestId("sidebar-set-inside")).toBeNull();
    expect(screen.queryByTestId("sidebar-inside-chat")).toBeNull();
  });

  it("its Plan tab is the wheel's plan: per key result only the plain steps to green, drawn as one line with who and by when (vn_06b0de06), never the approach, a marketing plan or the key results' numbers", async () => {
    const plan = vi.spyOn(api, "getObjectivePlan");
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=plan"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const tab = await screen.findByTestId("plan-tab");
    expect(plan).toHaveBeenCalledWith("launch");
    expect(tab.dataset.plan).toBe("wheel");
    expect(within(tab).getByTestId("plan-line").textContent).toMatch(/first key result green/);
    const steps = within(tab).getAllByTestId("plan-step");
    expect(steps).toHaveLength(2);
    expect(within(steps[1]).getByTestId("plan-step-owner").textContent).toBe("Ticket worker");
    expect(within(steps[1]).getByTestId("plan-step-by").textContent).toBe("26 Nov");
    expect(tab.textContent).not.toMatch(/marketing|who we reach|the offer|budget/i);
    const kr = within(tab).getAllByTestId("plan-kr")[0];
    // only the steps, ending on green: the approach, what each changes, green when and if it stalls stay in the data for agents
    expect(within(kr).getByTestId("plan-green").textContent).toBe("Green");
    for (const gone of ["plan-how", "plan-step-changes", "plan-green-when", "plan-if-stuck"]) expect(within(kr).queryByTestId(gone)).toBeNull();
    expect(kr.textContent).not.toMatch(/blocks it first|what comes first|no miss|one decision/);
    // the heading is the key result's name only: its value, target and ticket list stay on the Key results tab
    expect(kr.querySelector("h3")!.textContent).not.toMatch(/→|\d+%/);
    expect(kr.textContent).not.toMatch(/\b[A-Z]\d*-S\d+\b/); // no ticket codes: the Board tab holds the tickets
    expect(screen.getByTestId("set-tab-plan").getAttribute("aria-current")).toBe("page");
  });

  it("one set opens on its one-line answer, the spine line, and its key results as the mock-up drew them; a key result opens its coloured work", async () => {
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("kr-sheet");
    expect(screen.getByTestId("set-answer-box").contains(screen.getByTestId("set-answer"))).toBe(true);
    expect(screen.getByTestId("set-answer").textContent).toBe("1 of 3 key results are green, 2 red. 1 has nothing working on it.");
    expect(screen.getByTestId("kr-summary").textContent).toContain("1 of 3 green");
    const krs = screen.getAllByTestId("kr-item");
    // green first, then amber, then red (vn_68cda1fe); a colour keeps the file's order
    expect(krs.map((r) => r.dataset.state)).toEqual(["green", "red", "red"]);
    const [green, red, idleRed] = krs;
    expect(within(red).getByTestId("kr-things").textContent).toBe("2 things under it");
    // a table of three columns on every screen: key result, target, current (vn_68cda1fe: "Testers sign up, 5, 3")
    expect(screen.getByTestId("kr-sheet-head").textContent).toBe("Key resultTargetCurrent");
    expect(within(red).getByTestId("kr-target").textContent).toBe("5 by 17 Nov");
    // the current cell: the value alone, coloured by its state, the status word for readers; no stamp in this fixture
    expect(within(red).getByTestId("kr-now").textContent).toBe("0 of 5 (Behind)nothing measures this yet");
    expect(within(red).getByTestId("kr-now").dataset.state).toBe("red");
    // no target in the file: "no target yet", in grey
    expect(within(green).getByTestId("kr-target").textContent).toBe("no target yet");
    // the key results come before the spine line: the first thing he sees
    expect(screen.getByTestId("kr-sheet").compareDocumentPosition(screen.getByTestId("spine-line")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // green with no work: no mark in red; red with none: "nothing working on this"
    expect(within(idleRed).getByTestId("kr-no-work").textContent).toBe("nothing working on this");
    expect(within(red).queryByTestId("kr-detail")).toBeNull();
    // the owner: "please make rows reasonable height": the current value's words are cut to three lines, whole on hover;
    // vn_1e5a86e8: the number itself is big and bold in its colour, its words small under it
    const short = within(within(red).getByTestId("kr-now")).getByTestId("kr-now-short");
    expect(within(short).getByTestId("kr-big").textContent).toBe("0");
    expect(within(short).getByTestId("kr-big").className).toContain("font-bold");
    expect(within(short).getByTestId("kr-unit").textContent).toBe("of 5");
    expect(within(short).getByTestId("kr-unit").className).toContain("line-clamp-3");
    expect(within(within(red).getByTestId("kr-target")).getByTestId("kr-big").textContent).toBe("5");
    expect(within(red).getByTestId("kr-now").getAttribute("title")).toBe("Behind: 0 of 5 · read 13 Nov");
    // the target is never cut (vn_15aa4467: "the target ... I want to see it fully in this view")
    expect(within(within(red).getByTestId("kr-target")).getByTestId("kr-target-text").className).not.toContain("line-clamp");
    // the same three columns on a phone and a laptop
    // vn_b0c6e015: the key result takes most of a phone's width, no arrow column there (the arrow sits in the first cell)
    expect(within(red).getByTestId("kr-row").className).toContain("grid-cols-[minmax(0,1fr)_minmax(0,4rem)_minmax(0,4.25rem)]");
    expect(within(red).getByTestId("kr-row").className).toContain("sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,10rem)_1rem]");
    expect(within(red).getByTestId("kr-open-phone").className).toContain("sm:hidden");
    // ...and the whole row is tinted in its colour, not just the current cell
    expect(red.getAttribute("style")).toMatch(/background: rgba\(220, 40, 40, 0.12\)/);
    expect(green.getAttribute("style")).toMatch(/background: rgba\(\d+, \d+, \d+, 0.12\)/);
    expect(within(red).getByTestId("kr-now").getAttribute("style")).toBeNull();
    fireEvent.click(within(red).getByTestId("kr-row"));
    // ...and a tap opens the whole status and target, uncut, above its work
    const whole = within(screen.getAllByTestId("kr-item")[1]).getByTestId("kr-detail-status");
    expect(within(whole).getByTestId("kr-now-full").className).not.toContain("line-clamp");
    expect(whole.textContent).toBe("Status nowBehind: 0 of 5 · read 13 Novnothing measures this yetTarget 5 by 17 NovEvidence: no evidence yet. Nothing we can open shows why it is this colour.");
    // the owner: "I want to see a link to the evidence for the color"; none named reads plainly, in grey
    expect(within(whole).getByTestId("kr-evidence-none").className).toContain("text-muted-foreground");
    expect(within(whole).queryByTestId("kr-evidence-link")).toBeNull();
    // the work under it goes green first too
    const items = within(screen.getAllByTestId("kr-item")[1]).getAllByTestId("kr-work-item");
    expect(items.map((x) => [x.textContent, x.dataset.state])).toEqual([
      ["E901-S9ticketdone", "green"],
      ["E901-S1Build the pageready", "amber"],
    ]);
    expect(items[1].getAttribute("href")).toBe("/deck/app/EPIC-901?pursuit=launch");
    expect(screen.getByTestId("kr-legend").textContent).toContain("red: behind or stuck");
    // every measured row stays one tap away, with its two inbox rows
    const rows = await screen.findAllByTestId("set-row");
    expect(rows.map((r) => r.dataset.state)).toEqual(["green", "red", "amber", "red", "amber"]);
    expect(rows[3].textContent).toContain("Asks waiting on you");
    expect(screen.getAllByTestId("set-row-group").map((g) => g.firstElementChild?.textContent)).toEqual(["Checks", "Testers come", "Is it moving", "Waiting on you"]);
    // progress: rows turned green today and this week, for this set
    expect(screen.getByTestId("set-progress-today").textContent).toContain("1");
    expect(screen.getByTestId("set-progress-week").textContent).toContain("3");
    expect(screen.getAllByTestId(/^set-tab-/).map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Key results", "Plan", "Inbox", "Chat", "Personas", "Board", "Context", "Pages", "Trackers", "Consumption", "Log"]);
  });

  it("the kanban shows ready, running, waiting and review for the set and the sets inside it", async () => {
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=kanban"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("set-kanban");
    expect(within(screen.getByTestId("kanban-ready")).getByText("Build the page")).toBeTruthy();
    expect(within(screen.getByTestId("kanban-running")).getByText("Reddit post")).toBeTruthy();
    expect(await within(screen.getByTestId("kanban-review")).findByText("Testers call")).toBeTruthy();
  });

  it("personas say who works on it", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue({ ...BODY, nodes: BODY.nodes.map((n) => ({ ...n, milestoneId: undefined })) });
    // an objective first looks for personas that name it; none here, so its teams list shows
    vi.spyOn(api, "listAssignments").mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=personas"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // a node with a milestone shows its live persona controls; one with only a teams list shows that list.
    expect((await screen.findByTestId("set-persona", undefined, { timeout: 8000 })).textContent).toContain("every 30 min");
  });

  // the kernel: the Context tab opens with the objective's one where-we-are, read first and rewritten last.
  it("the Context tab opens with the objective's where-we-are: the answer, the open questions, what changed", async () => {
    const where = vi.spyOn(api, "whereWeAre").mockResolvedValue({
      path: "docs/scorecards/launch.md", present: true, at: "2026-11-22T22:30Z", by: "run_x", row: "E901-S1",
      answer: "One customer paid; the page is live.", open: ["Who is the second customer?"], changed: ["2026-11-22 E901-S1: the page went live"],
    });
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=context"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("where-we-are");
    await within(box).findByText("One customer paid; the page is live.");
    expect(where).toHaveBeenCalledWith("launch");
    expect(within(box).getByTestId("where-open").textContent).toContain("Who is the second customer?");
    expect(within(box).getByTestId("where-changed").textContent).toContain("22 Nov · E901-S1 the page went live");
    expect(within(box).getByTestId("where-stamp").textContent).toContain("Rewritten 22 Nov 22:30Z for E901-S1");
    // it is the whole tab: nothing else in the objective's Context
    const ctx = screen.getByTestId("set-context");
    expect(ctx.contains(box)).toBe(true);
    expect(ctx.children).toHaveLength(1);
  });

  it("an objective with no where-we-are yet says where the first one will live", async () => {
    vi.spyOn(api, "whereWeAre").mockResolvedValue({ path: "docs/scorecards/launch.md", present: false, open: [], changed: [] });
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=context"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("where-we-are");
    await waitFor(() => expect(box.getAttribute("data-present")).toBe("false"));
    expect(box.textContent).toContain("docs/scorecards/launch.md");
  });

  // one objective, one screen (the owner, vn_748ec5a1: "two dashboards for one objective"): the switch is on the objective's own tab.
  it("one objective, one screen: its personas switch on or off in place, never on a second page", { timeout: 30000 }, async () => {
    const m = { id: "ms_1", title: "Launch week", repo: "app", path: "docs/e.md", owner: "Sam", paused: false, createdAt: "2026-11-01T00:00:00Z" };
    vi.spyOn(api, "getMilestone").mockResolvedValue(m as never);
    const a = { id: "as_1", milestoneId: "ms_1", personaId: "p_1", enabled: true, writeEnabled: true, cadence: { kind: "interval", minutes: 60 }, createdAt: "2026-11-01T00:00:00Z" };
    vi.spyOn(api, "listAssignments").mockResolvedValue([a] as never);
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "p_1", name: "Builder", model: "opus" }] as never);
    vi.spyOn(api, "listRuns").mockResolvedValue([] as never);
    const update = vi.spyOn(api, "updateAssignment").mockResolvedValue({ ...a, enabled: false } as never);
    const nodes = BODY.nodes.map((n) => (n.id === "launch" ? n : { ...n, milestoneId: undefined, children: [] }));
    vi.spyOn(api, "listScorecards").mockResolvedValue({ ...BODY, nodes });
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=personas"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("objective-personas", {}, { timeout: 15000 });
    await within(box).findByText("Builder", {}, { timeout: 5000 });
    expect(within(box).getByText("Builder")).toBeTruthy();
    expect(screen.queryByText("Switch personas on or off")).toBeNull();
    fireEvent.click(within(box).getByText("on", { selector: "label" }).querySelector("[role=switch]")!);
    await waitFor(() => expect(update).toHaveBeenCalledWith("as_1", { enabled: false }));
    // still the objective's screen, under its one name
    expect(screen.getByTestId("goal-set-page").getAttribute("data-set")).toBe("launch");
    expect(screen.queryByText("Launch week")).toBeNull();
    expect(screen.getByTestId("objective-pause")).toBeTruthy();
  });

  it("an objective names its product with a link to the product and its social kit; an old ?tab=kit link opens the product's kit", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [{ id: "launch", name: "Launch", product: { id: "notes", name: "Notes" }, totems: [] }] } as never);
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("set-product-link")).getAttribute("href")).toBe("/products/notes");
    expect(screen.getByTestId("set-product-kit").getAttribute("href")).toBe("/products/notes?tab=kit");
    cleanup();
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=kit"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
          <Route path="/products/:id" element={<div data-testid="product-landed">{"kit"}</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("product-landed")).toBeTruthy();
  });

  it("an old milestone tab opens the objective tab that does its job now", async () => {
    render(
      <MemoryRouter initialEntries={["/sets/launch?tab=approvals"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("set-context")).toBeTruthy();
    expect(objectiveTab("summary")).toBe("table");
    expect(objectiveTab("waiting")).toBe("inbox");
    expect(objectiveTab("activity")).toBe("personas");
    expect(objectiveTab("settings")).toBe("personas");
    expect(objectiveTab("nonsense")).toBe("table");
  });

  it("the objectives screen says in one plain line what his order does", async () => {
    render(
      <MemoryRouter initialEntries={["/sets"]}>
        <Routes>
          <Route path={SCORECARDS_PATH} element={<GoalSetsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const line = await screen.findByTestId("objective-order-rule");
    expect(line.textContent).toBe("Your order decides what goes first: a higher objective's cards come first in your inbox, and its ready work gets workers first.");
  });

  it("All goal sets: one line per set, and the combined inbox sorts across them", async () => {
    render(
      <MemoryRouter initialEntries={["/sets?tab=inbox"]}>
        <Routes>
          <Route path={SCORECARDS_PATH} element={<GoalSetsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("slim-inbox");
    expect(screen.getByTestId("all-sets-answer").textContent).toContain("1 of 4 key results are green across 2 objectives");
    const rows = await screen.findAllByTestId("slim-inbox-row");
    expect(rows).toHaveLength(3);
    // priority: his order (Launch first), then the server's priority
    expect(rows[rows.length - 1].textContent).toContain("Vault");
    // the Inbox sections' Sort: the same three choices, remembered for this tab only
    const sort = screen.getByTestId("slim-inbox-sort") as HTMLSelectElement;
    expect([...sort.options].map((o) => o.textContent)).toEqual(["Highest priority", "Most recent", "Longest standing"]);
    expect(sort.value).toBe("priority");
    fireEvent.change(sort, { target: { value: "oldest" } });
    expect(screen.getAllByTestId("slim-inbox-row")[0].textContent).toContain("E909-A1");
    expect(window.localStorage.getItem("teamHome.sort.combined-inbox")).toBe("oldest");
    expect(window.localStorage.getItem("teamHome.sort.set-inbox")).toBeNull();
  });

  it("the set leads with its short objective, marked proposed, and a line from the spine to the work", async () => {
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const h = await screen.findByTestId("set-objective");
    expect(h.textContent).toBe("Customers payproposed");
    expect(screen.getByTestId("spine-line-spine").textContent).toContain("EPIC-901");
    expect(screen.getByTestId("spine-line-objective").textContent).toContain("Goal sentence");
    expect(screen.getByTestId("spine-line-krs").textContent).toContain("3 key results");
    expect(screen.getByTestId("spine-line-krs").textContent).toContain("Done means");
    // one line with arrows at every width: four boxes, three arrows, no stacking
    const line = screen.getByTestId("spine-line");
    expect(screen.getAllByTestId("spine-line-arrow").map((a) => a.textContent)).toEqual(["→", "→", "→"]);
    expect(line.className).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]");
    expect(line.className).not.toMatch(/(^| )grid-cols-1( |$)/);
    // phone tabs: one line that scrolls sideways, never a wrapped grid
    const tabs = screen.getByTestId("set-tabs");
    expect(tabs.className).toContain("overflow-x-auto");
    expect(tabs.className).not.toContain("grid-cols");
    expect(screen.getByTestId("set-tab-inbox").className).toContain("min-h-11");
    expect(screen.getByTestId("spine-line-work").textContent).toContain("2 things");
    // the spine box opens the spine its file names
    expect(within(screen.getByTestId("spine-line-spine")).getByTestId("spine-line-open").getAttribute("href")).toBe("/spines/app/view?path=docs%2Fe1.md");
  });

  it("a plan in a top-level EPIC.md with no EPIC number is the objective's spine, and its box opens it", async () => {
    const body = structuredClone(BODY);
    const n = body.nodes[0];
    delete n.spineRef;
    n.children = [{ id: "launch~plans:EPIC.md", kind: "epic", name: "EPIC: Home Plan", repo: "plans", path: "EPIC.md", greens: 0, total: 3, spines: ["plans:EPIC.md"], rows: [], children: [] }];
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("spine-line-spine");
    expect(box.textContent).not.toContain("no spine");
    const a = within(box).getByTestId("spine-line-open");
    expect(a.textContent).toBe("Home Plan");
    expect(a.getAttribute("href")).toBe("/spines/plans/view?path=EPIC.md");
    expect(box.textContent).toContain("plans spine");
  });

  it("an opened key result links to the evidence behind its colour, with when it was read", async () => {
    const at = new Date(Date.now() - 3 * 3600000).toISOString();
    const body = structuredClone(BODY);
    body.nodes[0].keyResults![1].measuredAt = at;
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter initialEntries={["/sets/launch?kr=Site%20answers"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const ev = await screen.findByTestId("kr-evidence");
    const a = within(ev).getByTestId("kr-evidence-link");
    expect(a.getAttribute("href")).toBe("https://app.example/");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(ev.textContent).toBe("Evidence: the site itself ↗ · read 3 h ago");
  });

  it("each key result says where it came from: his words in the row, the linked note when opened", async () => {
    const body = structuredClone(BODY);
    body.nodes[0].keyResults![1].from = { said: "100% of the my logins are on the multi-tenant", when: "22 Nov 09:28Z", url: "https://notes.example/log#^e-1" };
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter initialEntries={["/sets/launch?kr=Site%20answers"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("kr-from");
    expect(row.textContent).toBe("From your note, 22 Nov 09:28Z: 100% of the my logins are on the multi-tenant");
    expect(row.tagName).toBe("SPAN");
    const full = screen.getByTestId("kr-from-full");
    expect(full.getAttribute("href")).toBe("https://notes.example/log#^e-1");
    expect(screen.getAllByTestId("kr-from")).toHaveLength(1);
  });

  it("the key result that decides the objective stays first in its table whatever its colour", async () => {
    const body = structuredClone(BODY);
    body.nodes[0].keyResults![0].decides = true; // red, would sort after the green one
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("kr-sheet");
    const names = screen.getAllByTestId("kr-name").map((n) => n.textContent ?? "");
    expect(names[0]).toContain("Testers apply");
    expect(names[1]).toContain("Site answers");
    expect(pinDeciding([{ decides: false, n: 1 }, { decides: true, n: 2 }, { n: 3 }]).map((r) => r.n)).toEqual([2, 1, 3]);
  });

  it("a link to one key result opens it", async () => {
    render(
      <MemoryRouter initialEntries={["/sets/launch?kr=Testers%20apply"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("kr-detail")).toBeTruthy();
    expect(screen.getByTestId("set-all-rows").hasAttribute("open")).toBe(false);
  });

  it("a set with a social kit shows no kit tab and no kit in its Plan: the kit stays on its campaign", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue({
      ...BODY,
      nodes: [{ ...BODY.nodes[0], rows: [...BODY.nodes[0].rows, { label: "The social kit is complete", state: "green", value: "7 of 7 parts", kind: "check", note: "all parts there" }] }, ...BODY.nodes.slice(1)],
    });
    vi.spyOn(api, "listPursuits").mockResolvedValue({
      staleDays: 3,
      pursuits: [
        { id: "launch", name: "Launch", totems: [{ label: "Social kit", url: "/sets/brand?tab=kit" }] },
        { id: "brand", name: "Brand", kit: true, totems: [] },
        { id: "vault", name: "Vault", totems: [] },
      ],
    } as never);
    const kit = vi.spyOn(api, "getPursuitKit").mockResolvedValue({ pursuit: { id: "brand", name: "Brand" }, kit: { id: "brand", name: "Brand", tagline: "Hi.", colours: [], accounts: [], bios: [], templates: [] } } as never);
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("set-tab-plan");
    // root L-100: the same nine tabs on every objective; the kit is content inside the Plan.
    expect(screen.queryByTestId("set-tab-kit")).toBeNull();
    expect(screen.queryByTestId("set-row-kit")).toBeNull();
    fireEvent.click(screen.getByTestId("set-tab-plan"));
    expect(await screen.findByTestId("plan-tab")).toBeTruthy();
    expect(screen.queryByTestId("social-kit")).toBeNull();
    expect(kit).not.toHaveBeenCalled();
    cleanup();
    render(
      <MemoryRouter initialEntries={["/sets/vault"]}>
        <Routes>
          <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("set-objective");
    expect(screen.queryByTestId("set-tab-kit")).toBeNull();
    cleanup();
    // the sidebar lists no sub-links: the kit is one tap away as the objective page's tab.
    render(
      <MemoryRouter initialEntries={["/sets/launch"]}>
        <SidebarGoalSets />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("sidebar-set");
    expect(screen.queryByTestId("sidebar-inside-kit")).toBeNull();
  });
});

describe("the key-result table of every wheel", () => {
  it("a wheel with no persona shows a red no persona pill, and the screen names every goal without one; a switched-off one is only a quiet pill", async () => {
    vi.spyOn(api, "personaGaps").mockResolvedValue({
      ok: false,
      gaps: [
        { kind: "objective", id: "vault", title: "Vault", world: "home", turner: "none", why: "No persona: this wheel does not turn", milestoneId: "ms_9" },
        { kind: "milestone", id: "ms_8", title: "Company and accountant", world: "home", turner: "off", why: "Its personas are switched off: it turns once one is switched on", milestoneId: "ms_8" },
      ],
      checked: { objectives: 2, milestones: 9 },
      at: "2026-11-15T04:00:00Z",
    });
    vi.spyOn(api, "listScorecards").mockResolvedValue({ ...BODY, nodes: BODY.nodes.map((n) => (n.id === "vault" ? { ...n, noPersona: "none" as const } : n.id === "launch" ? { ...n, noPersona: "off" as const } : n)) });
    render(
      <MemoryRouter initialEntries={["/sets"]}>
        <Routes>
          <Route path={SCORECARDS_PATH} element={<GoalSetsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const line = await screen.findByTestId("persona-gaps");
    expect(line.textContent).toContain("1 goal has no persona. A wheel without a persona does not turn.");
    expect(within(line).getAllByTestId("persona-gap").map((li) => li.textContent)).toEqual(["Vaultobjective"]);
    const vault = (await screen.findAllByTestId("all-sets-row")).find((r) => r.getAttribute("data-set") === "vault")!;
    const pill = within(vault).getByTestId("wheel-no-persona");
    expect(pill.textContent).toBe("no persona");
    expect(pill.getAttribute("title")).toBe("No persona: this wheel does not turn.");
    const launch = screen.getAllByTestId("all-sets-row").find((r) => r.getAttribute("data-set") === "launch")!;
    expect(within(launch).getByTestId("wheel-no-persona").textContent).toBe("persona off");
  });

  it("nothing shows when every goal turns", async () => {
    vi.spyOn(api, "personaGaps").mockResolvedValue({ ok: true, gaps: [], checked: { objectives: 2, milestones: 9 }, at: "2026-11-15T04:00:00Z" });
    render(
      <MemoryRouter initialEntries={["/sets"]}>
        <Routes>
          <Route path={SCORECARDS_PATH} element={<GoalSetsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findAllByTestId("all-sets-row");
    expect(screen.queryByTestId("persona-gaps")).toBeNull();
    expect(screen.queryByTestId("wheel-no-persona")).toBeNull();
  });

  it("an idle wheel (below green, no worker, nothing waiting on him) shows a red idle pill on its row and in the sidebar; a moving one shows none", async () => {
    const { WheelsTable, IdlePill } = await import("@/components/goalSets");
    const nodes = BODY.nodes.map((n, i) => (i === 0 ? { ...n, idle: { idle: true, reason: "idle: 2 key results not green, no worker" } } : { ...n, idle: { idle: false, reason: "moving: worker on E907-S1" } }));
    render(
      <MemoryRouter>
        <WheelsTable nodes={nodes} />
      </MemoryRouter>,
    );
    const rows = screen.getAllByTestId("all-sets-row");
    const pill = within(rows[0]).getByTestId("wheel-idle");
    expect(pill.textContent).toBe("idle");
    // the owner's phone: the name squeezed one letter per line beside the pills; the pills sit under the name, in its column.
    expect(pill.closest('[data-testid="wheel-status-pills"]')?.parentElement?.contains(within(rows[0]).getByTestId("wheel-name"))).toBe(true);
    expect(within(rows[0]).getByTestId("wheel-name").className).not.toContain("anywhere");
    expect(pill.getAttribute("title")).toContain("Its Delivery Manager starts its next step on its next regular wake");
    rows.slice(1).forEach((r) => expect(within(r).queryByTestId("wheel-idle")).toBeNull());
    cleanup();
    render(<IdlePill n={{}} />);
    expect(screen.queryByTestId("wheel-idle")).toBeNull();
  });

  it("one row per wheel with its traffic light; a tap opens its key results with target and status, a tap closes it", async () => {
    const { WheelsTable } = await import("@/components/goalSets");
    render(
      <MemoryRouter>
        <WheelsTable nodes={BODY.nodes} />
      </MemoryRouter>,
    );
    const rows = screen.getAllByTestId("all-sets-row");
    expect(rows.length).toBe(BODY.nodes.length);
    expect(within(rows[0]).getByTestId("wheel-light").dataset.state).toBe("red");
    // lean rows: name, colour and pills only, no grey count line under the name
    expect(within(rows[0]).getByTestId("kr-strip")).toBeTruthy();
    expect(screen.queryByTestId("wheel-count")).toBeNull();
    expect(rows[0].textContent).not.toMatch(/of \d+ green|nothing working|turned green/);
    expect(within(rows[0]).queryByTestId("kr-sheet")).toBeNull();
    fireEvent.click(within(rows[0]).getByTestId("wheel-toggle"));
    const sheet = within(rows[0]).getByTestId("kr-sheet");
    expect(within(sheet).getAllByTestId("kr-item").length).toBe(3);
    expect(within(sheet).getAllByTestId("kr-now").map((x) => x.dataset.state)).toEqual(["green", "red", "red"]);
    expect(within(sheet).getAllByTestId("kr-target")[1].textContent).toBe("5 by 17 Nov");
    fireEvent.click(within(rows[0]).getByTestId("wheel-toggle"));
    expect(within(rows[0]).queryByTestId("kr-sheet")).toBeNull();
  });

  it("the owner's phone: one grid per row, number, label and goal flow from one left edge, bars stay on one line, shade only on hover devices", async () => {
    const { WheelsTable } = await import("@/components/goalSets");
    render(
      <MemoryRouter>
        <WheelsTable nodes={BODY.nodes} />
      </MemoryRouter>,
    );
    const rows = screen.getAllByTestId("all-sets-row");
    for (const r of rows) {
      const grid = within(r).getByTestId("wheel-row-grid");
      // the shade covers the whole row, and never sticks after a tap on a phone
      expect(grid.className).toContain("[@media(hover:hover)]:hover:bg-accent/30");
      expect(within(r).getByTestId("wheel-toggle").className).not.toMatch(/(^| )hover:bg/);
      // the number is inline text in the name, never its own column the name hangs beside
      const name = within(r).getByTestId("wheel-name");
      expect(within(name).getByTestId("wheel-number").textContent).toMatch(/^\d+\.$/);
      expect(name.className).not.toMatch(/(^| )(flex|grid|inline-flex)( |$)/);
      expect(name.querySelector("span")?.className ?? "").not.toMatch(/(^| )(flex|grid)( |$)/);
      // bars never wrap to a second row
      expect(within(r).getByTestId("kr-strip").className).toContain("flex-nowrap");
      // the count slot is there on every row, so the name column is the same width on every row
      expect(within(r).getByTestId("wheel-counts")).toBeTruthy();
    }
  });

  it("an opened wheel says what its place in his order buys it (effort follows importance)", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue({ pursuits: [{ id: BODY.nodes[0].id, effort: { tier: "Top", wakeFactor: 2, maxWorkers: 10, stallHours: 1, words: "Wakes twice as often, up to 10 workers, nudged after 1 h idle." } }] } as never);
    const { WheelsTable } = await import("@/components/goalSets");
    render(
      <MemoryRouter>
        <WheelsTable nodes={BODY.nodes} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getAllByTestId("wheel-toggle")[0]);
    expect((await screen.findByTestId("wheel-effort")).textContent).toBe("Effort, place 1: Top. Wakes twice as often, up to 10 workers, nudged after 1 h idle.");
  });
});

describe("the owner's notes on the objective screen (vn_15aa4467)", () => {
  it("reads key dates from the key results' targets, soonest first", async () => {
    const { keyDatesOf } = await import("@/components/goalSets");
    expect(
      keyDatesOf([
        { label: "5 testers", target: "5 testers by 8 Dec" },
        { label: "Applications", target: "5 applications by Friday 20 November" },
        { label: "Posts", target: "7 a week, one a day" },
      ]),
    ).toEqual([
      { day: "20 Nov", label: "Applications" },
      { day: "8 Dec", label: "5 testers" },
    ]);
  });
  it("says a key result's status in a word", async () => {
    const { STATUS_SAYS } = await import("@/components/goalSets");
    expect(STATUS_SAYS).toEqual({ green: "At target", amber: "On its way", red: "Behind", unknown: "Not measured" });
  });
});

describe("krNumber (vn_1e5a86e8: the number big, its words small)", () => {
  it("splits a number from its words and leaves dates and words alone", () => {
    expect(krNumber("1.19 GB")).toEqual({ lead: "", num: "1.19", rest: "GB" });
    expect(krNumber("0 of 5")).toEqual({ lead: "", num: "0", rest: "of 5" });
    expect(krNumber("100%")).toEqual({ lead: "", num: "100%", rest: "" });
    expect(krNumber("under 2 GB")).toEqual({ lead: "under", num: "2", rest: "GB" });
    expect(krNumber("median 5")).toEqual({ lead: "median", num: "5", rest: "" });
    expect(krNumber("5 by 17 Nov")).toEqual({ lead: "", num: "5", rest: "by 17 Nov" });
    expect(krNumber("done by 24 Nov")).toBeNull();
    expect(krNumber("live")).toBeNull();
    expect(krNumber("not yet")).toBeNull();
  });
});

describe("his objective groups in the sidebar (his voice note 25 Nov: groups that collapse and expand, central first)", () => {
  it("shows each group in his order with its objectives, folds one with a tap and keeps it folded in this browser", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue({ ...BODY, nodes: BODY.nodes.map((n) => (n.id === "launch" ? { ...n, group: "personal" as const } : n.id === "vault" ? { ...n, group: "central" as const } : n)) });
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarGoalSets />
      </MemoryRouter>,
    );
    const groups = await screen.findAllByTestId("sidebar-group");
    expect(groups.map((g) => g.dataset.group)).toEqual(["central", "personal"]);
    expect(within(groups[0]).getAllByTestId("sidebar-set").map((x) => x.dataset.set)).toEqual(["vault"]);
    fireEvent.click(within(groups[1]).getByTestId("sidebar-group-toggle"));
    expect(within(groups[1]).queryByTestId("sidebar-set")).toBeNull();
    expect(within(groups[1]).getByTestId("sidebar-group-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("sidebar.group.personal.folded")).toBe("1");
    view.unmount();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarGoalSets />
      </MemoryRouter>,
    );
    const again = await screen.findAllByTestId("sidebar-group");
    expect(within(again[1]).queryByTestId("sidebar-set")).toBeNull();
    expect(within(again[0]).getAllByTestId("sidebar-set")).toHaveLength(1);
  });

  it("keeps one list with no headings while no objective has a group", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarGoalSets />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("sidebar-set");
    expect(screen.queryByTestId("sidebar-group")).toBeNull();
  });
});
