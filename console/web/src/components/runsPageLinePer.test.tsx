// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Milestone, type Persona, type Run } from "@/api";
import { RunsPage } from "@/pages/Runs";
import { TeamPage } from "@/pages/Team";
import { milestoneRunStats, personaRunStats, wakesDidSomething } from "@/lib/derive";
import { runStats, wakesDidSomething as serverWakesDidSomething } from "../../../server/src/runStats";

/** one line per wake on the Runs page, its card on a click; the Team home counts wakes without the run list. */

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const run = (id: string, over: Partial<Run>): Run => ({ id, assignmentId: "as_1", milestoneId: "ms_1", startedAt: new Date(Date.now() - 3600_000).toISOString(), outcome: "progressed", summary: "", kind: "wake", ...over });
const milestones = [{ id: "ms_1", title: "PLAN-48: Review inbox: finished work waits for review", repo: "Acme/home_repo", path: "docs/spines/epic-48.md" }] as Milestone[];
const personas = [{ id: "pe_1", name: "Delivery Manager" }] as Persona[];
const assignments: Assignment[] = [{ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 240 }, enabled: true }];

describe("T48-S18 Runs page: one line per wake", () => {
  const long = "T48-S18 made the Runs page one line per wake. ".repeat(8);
  const wakes = [
    run("run_live", { outcome: "running", seat: "seat5", summary: "working on T48-S18", threadId: "th_live", usageLive: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 200, costUsd: 0.42, collectedAt: new Date().toISOString() } as Run["usageLive"] }),
    run("run_done", { startedAt: new Date(Date.now() - 7200_000).toISOString(), seat: "seat2", summary: `${long}\nsecond line`, usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 3.5, turns: 1, model: "opus", source: "t3" } as unknown as Run["usage"] }),
  ];
  const child = run("run_kid", { parentRunId: "run_done", summary: "T48-S18 child worker", seat: "seat7" });
  const setup = () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue(milestones);
    vi.spyOn(api, "listPersonas").mockResolvedValue(personas);
    vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listRunsTop").mockResolvedValue({ runs: [...wakes, child], total: 2 });
    wrap(<RunsPage />);
  };

  it("shows each wake as one line: outcome, persona, milestone, age, seat, cost and the summary cut to one line (full on hover)", async () => {
    setup();
    const lines = await screen.findAllByTestId("wake-line");
    expect(lines).toHaveLength(2);
    expect(screen.queryAllByTestId("run-row")).toHaveLength(0); // no cards, no child runs until a click
    const done = lines[1];
    const btn = within(done).getByRole("button");
    expect(btn.className).toMatch(/whitespace-nowrap/);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("title")).toBe(`${long}\nsecond line`);
    expect(within(done).getByTestId("wake-summary").textContent).toBe(long);
    expect(within(done).getByTestId("wake-summary").className).toMatch(/truncate/);
    expect(done.textContent).toContain("Delivery Manager");
    expect(done.textContent).toContain("Progressed");
    expect(within(done).getByTestId("wake-milestone").textContent).toBe(milestones[0].title);
    expect(within(done).getByTestId("wake-seat").textContent).toBe("seat2");
    expect(within(done).getByTestId("wake-cost").textContent).toBe("$3.50");
    expect(done.querySelector("time")?.textContent).toMatch(/2h|2 h|hours/);
    // Phone: milestone, seat and cost are dropped below sm / md.
    expect(within(done).getByTestId("wake-milestone").className).toMatch(/^hidden .*sm:inline/);
    expect(within(done).getByTestId("wake-seat").className).toMatch(/^hidden .*md:inline/);
    expect(within(done).getByTestId("wake-cost").className).toMatch(/^hidden .*md:inline/);
    // A long chip is clipped on a phone (age and summary stay on the line); the card's column never grows past the pane.
    expect(within(done).getByTestId("wake-chip").className).toMatch(/max-w-\[7\.5rem\].*sm:max-w-none.*\[&_\*\]:flex-nowrap/);
  });

  it("keeps a live marker on a running wake's line", async () => {
    setup();
    const [live, done] = await screen.findAllByTestId("wake-line");
    expect(within(live).getByTestId("wake-live")).toBeTruthy();
    expect(live.dataset.live).toBe("true");
    expect(within(live).getByTestId("wake-cost").textContent).toBe("$0.42 so far");
    expect(within(done).queryByTestId("wake-live")).toBeNull();
  });

  it("a click opens the wake's full card with its child runs, controls and thread; a second click folds it", async () => {
    setup();
    const done = (await screen.findAllByTestId("wake-line"))[1];
    fireEvent.click(within(done).getByRole("button"));
    expect(within(done).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getAllByTestId("run-row");
    expect(rows).toHaveLength(2); // the wake's card and its child run
    expect(rows[0].textContent).toContain("second line"); // full summary in the card
    expect(rows[1].textContent).toContain("↳ child run");
    expect(rows[1].textContent).toContain("T48-S18 child worker");
    expect(rows[0].previousElementSibling).toBe(done); // inline, right under its line
    expect(rows[0].className).toMatch(/grid-cols-\[minmax\(0,1fr\)\]/); // a wide note line wraps or clips, never widens the card
    fireEvent.click(within(done).getByRole("button"));
    expect(screen.queryAllByTestId("run-row")).toHaveLength(0);
    // The live wake opens to its Steer / Stop controls and thread link.
    const live = screen.getAllByTestId("wake-line")[0];
    fireEvent.click(within(live).getByRole("button"));
    const card = screen.getByTestId("run-row");
    expect(within(card).getByRole("link", { name: /thread/ })).toBeTruthy();
    expect(card.textContent).toMatch(/Steer|Stop/);
  });
});

describe("T48-S18 Team home: wake counts from /api/runs/stats", () => {
  it("never loads the run list; the card and persona numbers come from the stats answer", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([{ ...milestones[0], status: "active" } as Milestone]);
    vi.spyOn(api, "listPersonas").mockResolvedValue(personas);
    vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
    vi.spyOn(api, "listThreads").mockResolvedValue([]);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    const last = run("run_last", { summary: "last wake said this", outcome: "idle" });
    const stats = vi.spyOn(api, "getRunStats").mockResolvedValue({ milestones: { ms_1: { last24h: 7, last } }, personas: { pe_1: { count: 42, last } }, wakes24h: { did: 3, total: 9 } });
    const listRuns = vi.spyOn(api, "listRuns").mockResolvedValue([]);
    wrap(<TeamPage section="settings" />);
    await waitFor(() => expect(screen.getByText("7 runs in 24 h")).toBeTruthy());
    expect(screen.getByText(/42 runs · on 1 project/)).toBeTruthy();
    expect(screen.getAllByText("last wake said this").length).toBeGreaterThan(0);
    expect(screen.getByTestId("wakes-did-something").textContent).toBe("3 of 9 wakes in 24 h did something");
    expect(stats).toHaveBeenCalled();
    // No run list at all: neither the 500 newest nor the footer's last 24 h.
    expect(listRuns).not.toHaveBeenCalled();
  });
});

describe("T48-S18 the server's runStats gives the Team home's numbers", () => {
  it("equals milestoneRunStats / personaRunStats on the same 500 runs (wakes, children, answer runs, toggles, orphans, bootstrap, ties)", () => {
    const now = new Date("2026-11-02T04:00:00Z");
    const ms = ["ms_a", "ms_b", "ms_c", "ms_d"];
    const as: Assignment[] = [
      { id: "as_1", milestoneId: "ms_a", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
      { id: "as_2", milestoneId: "ms_b", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
      { id: "as_3", milestoneId: "ms_b", personaId: "pe_2", cadence: { type: "interval", everyMinutes: 60 }, enabled: false },
      { id: "as_4", milestoneId: "ms_c", personaId: "pe_2", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
    ];
    const kinds = ["wake", "wake", "answer_run", "toggle", "wake"] as const;
    const ids = ["as_1", "as_2", "as_3", "as_4", "as_gone", "bootstrap:ms_d"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), (seed >> 16) % n);
    const runs: Run[] = Array.from({ length: 500 }, (_, i) => {
      const assignmentId = ids[rnd(ids.length)];
      const stamp = assignmentId === "as_gone" ? ms[rnd(3)] : assignmentId.startsWith("bootstrap:") ? undefined : as.find((a) => a.id === assignmentId)!.milestoneId;
      return run(`r${i}`, {
        assignmentId,
        milestoneId: rnd(10) === 0 ? ms[rnd(4)] : stamp, // now and then a stamp that differs from the assignment's milestone
        personaId: assignmentId === "as_gone" ? "pe_1" : undefined,
        startedAt: new Date(now.getTime() - Math.floor(i / 3) * 37 * 60_000).toISOString(), // threes share a start
        kind: kinds[rnd(5)],
        outcome: (["progressed", "idle", "running", "blocked"] as const)[rnd(4)],
        repeating: rnd(5) === 0 ? 3 : undefined,
        parentRunId: rnd(6) === 0 ? `r${Math.max(0, i - 1)}` : undefined,
      });
    });
    const got = runStats(runs, as, now);
    for (const m of [...ms, "ms_none"]) {
      const want = milestoneRunStats(m, as, runs, now);
      expect({ m, last24h: got.milestones[m]?.last24h ?? 0, last: got.milestones[m]?.last?.id }).toEqual({ m, last24h: want.last24h, last: want.last?.id });
    }
    for (const p of ["pe_1", "pe_2", "pe_none"]) {
      const want = personaRunStats(p, as, runs);
      expect({ p, count: got.personas[p]?.count ?? 0, last: got.personas[p]?.last?.id }).toEqual({ p, count: want.count, last: want.last?.id });
    }
    expect(serverWakesDidSomething(runs, now)).toEqual(wakesDidSomething(runs, now));
    expect(wakesDidSomething(runs, now).did).toBeGreaterThan(0);
    expect(got.milestones.ms_b.last24h).toBeGreaterThan(0);
    expect(got.milestones.ms_d.last24h).toBeGreaterThan(0); // bootstrap runs count for their milestone
  });
});
