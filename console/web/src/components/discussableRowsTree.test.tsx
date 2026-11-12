// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import type { Assignment, MilestoneTree, Persona, Run, TicketSession, TreeNode } from "@/api";
import { RunTimeline } from "@/components/timeline";
import { chatAboutFromParams, DiscussButton, discussable, milestoneChatHref, runTicketId } from "@/components/ticketSession";
import { MilestonePage } from "@/pages/Milestone";
import { timelineGroups } from "@/lib/derive";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Discuss on ledger rows (Tree tab) and on child runs that carry a ticket id; it opens the milestone's Chat tab. */
const session = (over: Partial<TicketSession> = {}): TicketSession => ({
  milestoneId: "ms_1",
  rowId: "T9-S1",
  path: "docs/spines/epic.md",
  threadId: "thread_t1",
  environmentId: "env_1",
  link: "t3code://threads/env_1/thread_t1",
  persona: { id: "pe_b", name: "Builder" },
  fellBack: false,
  launched: true,
  ...over,
});

const node = (over: Partial<TreeNode> & Pick<TreeNode, "key" | "id" | "kind">): TreeNode => ({ title: over.id, status: "ready", color: "grey", children: [], flags: [], ...over });

describe("discussable rows of a tree", () => {
  const root = node({
    key: "r",
    id: "PLAN-9",
    kind: "spine",
    path: "docs/spines/epic.md",
    children: [
      node({ key: "r/T9-S1", id: "T9-S1", kind: "ticket" }),
      node({ key: "r/T9-S2", id: "T9-S2", kind: "ticket", status: "done", color: "green" }),
      node({ key: "r/T9-S3", id: "T9-S3", kind: "ticket", status: "superseded", closed: true }),
      node({ key: "r/T9-S4", id: "T9-S4", kind: "ticket", flags: ["repeat"] }),
      node({ key: "r/dod", id: "E9-1", kind: "dod", status: "open" }),
      node({
        key: "r/child",
        id: "PLAN-10",
        kind: "spine",
        path: "docs/spines/child.md",
        children: [node({ key: "r/child/C-S1", id: "C-S1", kind: "ticket" })],
      }),
      node({
        key: "r/T9-S5",
        id: "T9-S5",
        kind: "ticket",
        path: "docs/tickets/e9-s5.md",
        children: [node({ key: "r/T9-S5/sub", id: "S5.1", kind: "ticket" })],
      }),
    ],
  });
  it("offers open ticket rows under a spine with their spine's path; not done, closed, shown-elsewhere, DoD or linked-file rows", () => {
    expect([...discussable(root)]).toEqual([
      ["r/T9-S1", "docs/spines/epic.md"],
      ["r/child/C-S1", "docs/spines/child.md"],
      ["r/T9-S5", "docs/spines/epic.md"],
    ]);
  });
});

describe("runTicketId", () => {
  it("reads the id a child run's summary starts with; a wake or a plain sentence has none", () => {
    expect(runTicketId({ parentRunId: "w", summary: "T6-S14 keep moving" })).toBe("T6-S14");
    expect(runTicketId({ parentRunId: "w", summary: "**M2-28:** commits" })).toBe("M2-28");
    expect(runTicketId({ parentRunId: "w", summary: "fix the tree" })).toBeUndefined();
    expect(runTicketId({ parentRunId: "w", summary: "2026 plan" })).toBeUndefined();
    expect(runTicketId({ summary: "T6-S14 keep moving" })).toBeUndefined();
  });
});

const chatOf = (_m?: string) => ({ available: true, threadId: "thread_rd", messages: [], working: false, sending: 0, hasEarlier: false }) as any;

/** Where the router is now (path + query), rendered so a test can read it. */
function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

describe("milestoneChatHref / chatAboutFromParams", () => {
  it("round-trips id, title and run; no item → the bare Chat tab", () => {
    const href = milestoneChatHref("ms 1", { id: "T19-S1", title: "Chat & more", run: "run_k1" });
    expect(href).toBe("/milestones/ms%201?tab=chat&about=T19-S1&title=Chat+%26+more&run=run_k1");
    expect(chatAboutFromParams(new URL(href, "http://x").searchParams)).toEqual({ id: "T19-S1", title: "Chat & more", run: "run_k1" });
    expect(milestoneChatHref("ms_1")).toBe("/milestones/ms_1?tab=chat");
    expect(chatAboutFromParams(new URLSearchParams("tab=chat"))).toBeUndefined();
  });
});

describe("DiscussButton", () => {
  it("is a link to this milestone's Chat tab about the row; no ticket session is opened", () => {
    render(
      <MemoryRouter>
        <DiscussButton milestoneId="ms_1" row="T9-S1" title="Build the thing" />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /Discuss/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/milestones/ms_1?tab=chat&about=T9-S1&title=Build+the+thing");
    expect(screen.queryByRole("button")).toBeNull();
    expect("openTicketSession" in api).toBe(false);
  });

  it("a ticket session from before stays linked beside it", () => {
    render(
      <MemoryRouter>
        <DiscussButton milestoneId="ms_1" row="T9-S1" session={session({ launched: false })} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Discuss/ }).getAttribute("href")).toContain("tab=chat");
    expect((screen.getByRole("link", { name: /Ticket session/ }) as HTMLAnchorElement).getAttribute("href")).toContain("thread_t1");
  });

  it("is a phone-sized tap target and wraps (412 px)", () => {
    render(
      <MemoryRouter>
        <DiscussButton milestoneId="ms_1" row="T9-S1" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("discuss").className).toContain("flex-wrap");
    expect(screen.getByRole("link", { name: /Discuss/ }).className).toContain("max-sm:min-h-11");
  });
});

describe("Discuss on run rows", () => {
  const asg: Assignment = { id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true };
  const persona = { id: "pe_1", name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false, createdAt: "2026-10-16T00:00:00Z" } as Persona;
  const run = (over: Partial<Run>): Run => ({ id: "r", assignmentId: "as_1", milestoneId: "ms_1", startedAt: "2026-10-25T10:00:00Z", outcome: "running", summary: "", threadId: "thread_x", ...over });
  it("a child run that starts with a ticket id has Discuss for that row and its run; a wake and a child without an id do not", () => {
    const runs = [
      run({ id: "run_wake", summary: "wake" }),
      run({ id: "run_k1", parentRunId: "run_wake", summary: "T9-S1 build it", startedAt: "2026-10-25T10:01:00Z" }),
      run({ id: "run_k2", parentRunId: "run_wake", summary: "tidy up", startedAt: "2026-10-25T10:02:00Z" }),
    ];
    render(
      <MemoryRouter>
        <RunTimeline groups={timelineGroups(runs, [asg])} personas={[persona]} now={Date.parse("2026-10-25T10:05:00Z")} />
      </MemoryRouter>,
    );
    const inRow = (id: string) => within(document.getElementById(`run-${id}`)!).queryAllByTestId("discuss");
    expect(inRow("run_wake")).toHaveLength(0);
    expect(inRow("run_k2")).toHaveLength(0);
    expect(inRow("run_k1")).toHaveLength(1);
    expect(within(inRow("run_k1")[0]).getByRole("link", { name: /Discuss/ }).getAttribute("href")).toBe("/milestones/ms_1?tab=chat&about=T9-S1&run=run_k1");
  });
});

describe("Tree tab → Chat tab", () => {
  const treeFor = (mid: string): MilestoneTree => ({
    milestoneId: mid,
    root: node({
      key: "root",
      id: "PLAN-9",
      kind: "spine",
      path: "docs/spines/m2-team-console.md",
      children: [
        node({ key: "root/T9-S1", id: "T9-S1", kind: "ticket", title: "Open one" }),
        node({ key: "root/T9-S2", id: "T9-S2", kind: "ticket", title: "Done one", status: "done", color: "green" }),
        node({ key: "root/T9-S3", id: "T9-S3", kind: "ticket", title: "Has a session" }),
      ],
    }),
    counts: { grey: 3, blue: 0, yellow: 0, red: 0, green: 1 },
    nonGreen: 2,
    closed: 0,
    flagged: 0,
    source: "spines",
    warnings: [],
  });

  it("Discuss on an open row opens the Chat tab with the chip; the next message carries [page: <milestone> · <row id>]", async () => {
    const m = await api.createMilestone({ title: "Treeish", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    vi.spyOn(api, "getTree").mockResolvedValue(treeFor(m.id));
    vi.spyOn(api, "listTicketSessions").mockResolvedValue([session({ milestoneId: m.id, rowId: "T9-S3", path: "docs/spines/m2-team-console.md", threadId: "thread_s3", link: "t3code://threads/env_1/thread_s3", launched: false })]);
    vi.spyOn(api, "getMilestoneChat").mockResolvedValue(chatOf(m.id));
    const send = vi.spyOn(api, "sendMilestoneChatMessage").mockResolvedValue({ threadId: "thread_rd", pending: false });
    render(
      <MemoryRouter initialEntries={[`/milestones/${m.id}?tab=tree`]}>
        <Routes>
          <Route path="/milestones/:id" element={<><MilestonePage /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("tree");
    await waitFor(() => expect(screen.getAllByTestId("discuss")).toHaveLength(2)); // is done
    expect(screen.getByRole("link", { name: /Ticket session/ }).getAttribute("href")).toContain("thread_s3");
    fireEvent.click(screen.getAllByRole("link", { name: /Discuss/ })[0]);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/milestones/${m.id}?tab=chat&about=T9-S1&title=Open+one`));
    expect((await screen.findByTestId("chat-hint")).textContent).toContain("About T9-S1 · Open one");
    fireEvent.change(screen.getByRole("textbox", { name: /Message to the Repo desk/ }), { target: { value: "why is it stuck?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(m.id, "why is it stuck?", "Treeish · T9-S1", expect.any(String)));
    // Sent: the hint is dropped from the URL and the chip goes.
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/milestones/${m.id}?tab=chat`));
    expect(screen.queryByTestId("chat-hint")).toBeNull();
  });

  it("a run's Discuss link adds the run id to the hint; the chip's × drops it", async () => {
    const m = await api.createMilestone({ title: "Runny", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    vi.spyOn(api, "getMilestoneChat").mockResolvedValue(chatOf(m.id));
    const send = vi.spyOn(api, "sendMilestoneChatMessage").mockResolvedValue({ threadId: "thread_rd", pending: false });
    render(
      <MemoryRouter initialEntries={[milestoneChatHref(m.id, { id: "T9-S1", run: "run_k1" })]}>
        <Routes>
          <Route path="/milestones/:id" element={<><MilestonePage /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("chat-hint")).textContent).toContain("About T9-S1 · run run_k1");
    fireEvent.change(screen.getByRole("textbox", { name: /Message to the Repo desk/ }), { target: { value: "status?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(m.id, "status?", "Runny · T9-S1 · run_k1", expect.any(String)));
    cleanup();
    render(
      <MemoryRouter initialEntries={[milestoneChatHref(m.id, { id: "T9-S1" })]}>
        <Routes>
          <Route path="/milestones/:id" element={<><MilestonePage /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Drop the page hint" }));
    await waitFor(() => expect(screen.queryByTestId("chat-hint")).toBeNull());
    expect(screen.getByTestId("where").textContent).toBe(`/milestones/${m.id}?tab=chat`);
  });
});
