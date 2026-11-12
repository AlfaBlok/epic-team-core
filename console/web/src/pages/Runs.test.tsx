// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Milestone, type Persona, type Run } from "@/api";
import { RunsPage } from "@/pages/Runs";
import { RunTimeline } from "@/components/timeline";
import { filterRunsByPersona, timelineGroups } from "@/lib/derive";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ms = (id: string, title: string) => ({ id, title, repo: "r", path: "p", owner: "", paused: false, createdAt: "" }) as unknown as Milestone;
const pe = (id: string, name: string) => ({ id, name, remit: "x", skills: [], model: "", mayWrite: true, createdAt: "" }) as Persona;
const as = (id: string, milestoneId: string, personaId: string): Assignment => ({ id, milestoneId, personaId, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
const run = (id: string, over: Partial<Run>): Run => ({ id, assignmentId: "as_e4", milestoneId: "ms_e4", startedAt: "2026-10-21T20:00:00Z", outcome: "progressed", summary: "", ...over });

const MILESTONES = [ms("ms_e4", "poly-maker E904"), ms("ms_m4", "M4 browser auth")];
const PERSONAS = [pe("pe_dm", "Delivery Manager"), pe("pe_bs", "Browser steward")];
const ASSIGNMENTS = [as("as_e4", "ms_e4", "pe_dm")];
// M4's assignments were deleted: one run stamped with its persona, one older run without (pre-).
const RUNS = [
  run("run_e4", { outcome: "blocked", seat: "seat1", threadId: "th_e4", summary: "E904 blocked on Sam (nj_f480d480)", startedAt: "2026-10-21T21:34:00Z" }),
  run("run_child", { parentRunId: "run_e4", summary: "child: Q7 measured", startedAt: "2026-10-21T21:35:00Z", threadId: "th_child" }),
  run("run_m4a", { assignmentId: "as_89f3952a", milestoneId: "ms_m4", personaId: "pe_bs", outcome: "idle", summary: "nothing to do", startedAt: "2026-10-20T10:00:00Z" }),
  run("run_m4b", { assignmentId: "as_55c2ec21", milestoneId: "ms_m4", outcome: "idle", summary: "nothing", startedAt: "2026-10-19T10:00:00Z" }),
];

/** the server's `?top=` over whatever listRuns returns: the newest wakes (no parent), their child runs, the count. */
async function runsTop({ top, milestoneId }: { top?: number; milestoneId?: string }) {
  const all = await api.listRuns();
  const roots = all.filter((r) => !r.parentRunId && (!milestoneId || r.milestoneId === milestoneId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const ids = new Set((top ? roots.slice(0, top) : roots).map((r) => r.id));
  return { runs: all.filter((r) => ids.has(r.id) || (r.parentRunId && ids.has(r.parentRunId))), total: roots.length };
}

function mockApi() {
  vi.spyOn(api, "listRuns").mockResolvedValue(RUNS);
  vi.spyOn(api, "listRunsTop").mockImplementation(runsTop);
  vi.spyOn(api, "listMilestones").mockResolvedValue(MILESTONES);
  vi.spyOn(api, "listPersonas").mockResolvedValue(PERSONAS);
  vi.spyOn(api, "listAssignments").mockResolvedValue(ASSIGNMENTS);
}

describe("Runs page (M2-19 global runs)", () => {
  it("waits for assignments before listing, so live runs never flash as assignment deleted", async () => {
    mockApi();
    let resolve!: (a: Assignment[]) => void;
    vi.spyOn(api, "listAssignments").mockReturnValue(new Promise((r) => (resolve = r)));
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <RunsPage />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryAllByTestId("wake-line")).toHaveLength(0);
    resolve(ASSIGNMENTS);
    const rows = await screen.findAllByTestId("wake-line");
    expect(rows[0].textContent).toContain("Delivery Manager");
    expect(rows[0].textContent).not.toContain("assignment deleted");
  });

  it("lists every run newest first with milestone, persona, outcome, seat, thread; child runs nested; orphans marked", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <RunsPage />
      </MemoryRouter>,
    );
    // each wake is one line; opened, its full card and child runs follow.
    const lines = await screen.findAllByTestId("wake-line");
    expect(lines).toHaveLength(3);
    expect(screen.queryAllByTestId("run-row")).toHaveLength(0);
    lines.forEach((l) => fireEvent.click(within(l).getByRole("button", { expanded: false })));
    const rows = screen.getAllByTestId("run-row");
    expect(rows.map((r) => r.textContent?.slice(0, 40))).toHaveLength(4);
    // Order: E904 wake, its child (nested right after), then the M4 runs newest first.
    expect(rows[0].textContent).toContain("Delivery Manager");
    expect(rows[0].textContent).toContain("poly-maker E904");
    expect(rows[0].textContent).toContain("seat1");
    expect(rows[0].textContent).toContain("blocked");
    expect(within(rows[0]).getByRole("link", { name: /thread/ }).getAttribute("href")).toContain("th_e4");
    expect(within(rows[0]).getByRole("link", { name: "nj_f480d480" }).getAttribute("href")).toBe("/milestones/ms_e4?tab=waiting&item=nj_f480d480");
    expect(rows[1].textContent).toContain("↳ child run");
    expect(rows[1].style.paddingLeft).toBe("40px");
    expect(rows[2].textContent).toContain("Browser steward");
    expect(rows[2].textContent).toContain("assignment deleted");
    expect(rows[3].textContent).toContain("deleted assignment");
    expect(rows[3].textContent).toContain("assignment deleted");
    expect(rows[3].textContent).toContain("M4 browser auth");
  });

  it("filters by milestone, persona and outcome (children follow their wake)", async () => {
    mockApi();
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <RunsPage />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("wake-line");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "ms_m4" } });
    expect(screen.getAllByTestId("wake-line")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "pe_bs" } });
    expect(screen.getAllByTestId("wake-line")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "blocked" } });
    expect(screen.getAllByTestId("wake-line")).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId("wake-line")).getByRole("button"));
    expect(screen.getAllByTestId("run-row")).toHaveLength(2); // the blocked wake and its child
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "failed" } });
    expect(screen.getByText("No runs match these filters.")).toBeTruthy();
  });
});

describe("Milestone Activity: runs of deleted assignments (M2-19)", () => {
  it("are grouped under their stamped persona, else 'deleted assignment', marked 'assignment deleted'", () => {
    const m4 = RUNS.filter((r) => r.milestoneId === "ms_m4");
    const groups = timelineGroups(m4, ASSIGNMENTS);
    expect(groups.map((g) => [g.assignmentId, g.personaId, g.deleted])).toEqual([
      ["as_89f3952a", "pe_bs", true],
      ["as_55c2ec21", undefined, true],
    ]);
    render(
      <MemoryRouter>
        <RunTimeline groups={groups} personas={PERSONAS} />
      </MemoryRouter>,
    );
    const sections = screen.getAllByRole("region");
    expect(sections[0].getAttribute("aria-label")).toBe("runs of Browser steward");
    expect(sections[1].getAttribute("aria-label")).toBe("runs of deleted assignment");
    expect(within(sections[0]).getByText("assignment deleted")).toBeTruthy();
    expect(within(sections[1]).getByText("assignment deleted")).toBeTruthy();
    // Live E904 group is not marked.
    cleanup();
    render(
      <MemoryRouter>
        <RunTimeline groups={timelineGroups(RUNS.filter((r) => r.milestoneId === "ms_e4"), ASSIGNMENTS)} personas={PERSONAS} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("assignment deleted")).toBeNull();
  });

  it("the ?persona= filter keeps a persona's runs from its deleted assignments", () => {
    expect(filterRunsByPersona(RUNS, ASSIGNMENTS, "pe_bs").map((r) => r.id)).toEqual(["run_m4a"]);
    expect(filterRunsByPersona(RUNS, ASSIGNMENTS, "pe_dm").map((r) => r.id)).toEqual(["run_e4", "run_child"]);
  });
});

describe("M2-32 blank_report and answer_run rendering", () => {
  const extra = [
    run("run_blank", { outcome: "blank_report", summary: "Woke [console: T3 turn completed, no report from persona]", startedAt: "2026-10-22T08:00:00Z" }),
    run("run_ans", { kind: "answer_run", outcome: "progressed", summary: "Answer run: look at T5", startedAt: "2026-10-22T09:00:00Z" }),
  ];
  const withExtra = () => {
    mockApi();
    vi.spyOn(api, "listRuns").mockResolvedValue([...RUNS, ...extra]);
  };

  it("/runs labels both, and filters by outcome blank_report and by kind", async () => {
    withExtra();
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <RunsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("wake-line");
    expect(rows[0].textContent).toContain("answer run");
    expect(rows[1].textContent).toContain("Ended without report");
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "answer_run" } });
    expect(screen.getAllByTestId("wake-line")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "wake" } });
    expect(screen.getAllByTestId("wake-line").some((r) => r.textContent?.includes("answer run"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "blank_report" } });
    expect(screen.getAllByTestId("wake-line")).toHaveLength(1);
  });

  it("timeline: answer run labelled, not numbered as a wake, not counted", () => {
    const groups = timelineGroups([...RUNS, ...extra], ASSIGNMENTS);
    const g = groups.find((x) => x.assignmentId === "as_e4")!;
    render(
      <MemoryRouter>
        <RunTimeline groups={groups} personas={PERSONAS} />
      </MemoryRouter>,
    );
    expect(g.wakes.filter((w) => w.wake > 0).map((w) => w.wake)).toEqual([2, 1]);
    expect(screen.getAllByText("answer run").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 wakes, 1 answer run/)).toBeTruthy();
    expect(screen.getByText("Ended without report")).toBeTruthy();
  });
});
