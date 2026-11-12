// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { Assignment, Milestone, Persona, Run, StopResult } from "@/api";
import { RunTimeline } from "@/components/timeline";
import { AddButton } from "@/components/runControls";
import { OutcomeBadge, outcomeLabel } from "@/components/common";
import { PersonasTab } from "@/pages/Milestone";
import { timelineGroups } from "@/lib/derive";

// Radix measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Steer + Stop on every running run (wake or child worker), Add on a tree node. */
const asg: Assignment = { id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true };
const persona = { id: "pe_1", name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false, createdAt: "2026-10-16T00:00:00Z" } as Persona;
const run = (over: Partial<Run>): Run => ({ id: "r", assignmentId: "as_1", milestoneId: "ms_1", startedAt: "2026-10-25T10:00:00Z", outcome: "running", summary: "", threadId: "thread_x", ...over });
const wake = run({ id: "run_wake", threadId: "thread_wake", summary: "wake" });
const kid1 = run({ id: "run_k1", parentRunId: "run_wake", threadId: "thread_k1", summary: "worker one", startedAt: "2026-10-25T10:01:00Z" });
const kid2 = run({ id: "run_k2", parentRunId: "run_wake", threadId: "thread_k2", summary: "worker two", startedAt: "2026-10-25T10:02:00Z", outcome: "progressed", endedAt: "2026-10-25T10:03:00Z" });
const stopResult = (r: Run): StopResult => ({ run: { ...r, outcome: "stopped" }, workers: [], workersRunning: 0, workerErrors: [] });

const timeline = (runs: Run[]) =>
  render(
    <MemoryRouter>
      <RunTimeline groups={timelineGroups(runs, [asg])} personas={[persona]} now={Date.parse("2026-10-25T10:05:00Z")} />
    </MemoryRouter>,
  );
const controlsOf = (id: string) => within(document.getElementById(`run-${id}`)!).queryByTestId("run-controls");

describe("run controls in Activity", () => {
  it("every running run (wake and child) has Steer and Stop; a finished run has neither", () => {
    timeline([wake, kid1, kid2]);
    for (const id of ["run_wake", "run_k1"]) {
      const c = within(controlsOf(id)!);
      expect(c.getByRole("button", { name: /Steer/ })).toBeTruthy();
      expect(c.getByRole("button", { name: /Stop/ })).toBeTruthy();
    }
    expect(controlsOf("run_k2")).toBeNull();
  });

  it("controls wrap on a phone (412 px)", () => {
    timeline([wake]);
    expect(controlsOf("run_wake")!.className).toContain("flex-wrap");
  });

  it("Stop on a child worker: reason required, sent for that run, no 'and its workers' box", async () => {
    const stop = vi.spyOn(api, "stopRun").mockResolvedValue(stopResult(kid1));
    timeline([wake, kid1]);
    fireEvent.click(within(controlsOf("run_k1")!).getByRole("button", { name: /Stop/ }));
    expect(screen.queryByLabelText(/and its workers/)).toBeNull();
    const go = screen.getByRole("button", { name: "Stop" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  off track  " } });
    fireEvent.click(go);
    await waitFor(() => expect(stop).toHaveBeenCalledWith("run_k1", { reason: "off track" }));
    await waitFor(() => expect(screen.queryByLabelText("Reason")).toBeNull());
  });

  it("Stop on a wake with running workers offers 'and its workers': unticked leaves them, ticked stops them", async () => {
    const stop = vi.spyOn(api, "stopRun").mockResolvedValue(stopResult(wake));
    timeline([wake, kid1, kid2]);
    fireEvent.click(within(controlsOf("run_wake")!).getByRole("button", { name: /Stop/ }));
    expect(screen.getByText(/1 running; left running if unticked/)).toBeTruthy(); // only the running child counts
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "persona only" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenLastCalledWith("run_wake", { reason: "persona only", withWorkers: false }));
    await waitFor(() => expect(screen.queryByLabelText("Reason")).toBeNull());

    fireEvent.click(within(controlsOf("run_wake")!).getByRole("button", { name: /Stop/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "all of it" } });
    fireEvent.click(screen.getByLabelText(/and its workers/));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenLastCalledWith("run_wake", { reason: "all of it", withWorkers: true }));
  });

  it("a failed stop shows the server's message and keeps the dialog open", async () => {
    vi.spyOn(api, "stopRun").mockRejectedValue(new Error("t3_thread_interrupt: boom"));
    timeline([wake]);
    fireEvent.click(within(controlsOf("run_wake")!).getByRole("button", { name: /Stop/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByLabelText("Reason")).toBeTruthy();
  });

  it("Steer on a child run goes to that run by id (one request id per open dialog)", async () => {
    const steer = vi.spyOn(api, "steerRun").mockResolvedValue({ run: kid1, threadId: "thread_k1", mode: "steer" });
    const steerAssignment = vi.spyOn(api, "steerAssignment");
    timeline([wake, kid1]);
    fireEvent.click(within(controlsOf("run_k1")!).getByRole("button", { name: /Steer/ }));
    expect(screen.getByText("Steer worker")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "  use staging  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(steer).toHaveBeenCalledWith("run_k1", "use staging", expect.stringMatching(/^console-steer-/)));
    expect(steerAssignment).not.toHaveBeenCalled();
  });

  it("a run with no thread yet cannot be stopped or steered", () => {
    timeline([run({ id: "run_new", threadId: undefined })]);
    const c = within(controlsOf("run_new")!);
    expect((c.getByRole("button", { name: /Stop/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((c.getByRole("button", { name: /Steer/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a stopped run reads Stopped in grey, not as a failure", () => {
    expect(outcomeLabel("stopped")).toBe("Stopped");
    render(<OutcomeBadge outcome="stopped" />);
    const b = screen.getByText("Stopped");
    expect(b.getAttribute("data-word")).toBe("stopped");
  });
});

describe("Stop next to Steer on the Milestone page", () => {
  const m = { id: "ms_1", title: "E904", repo: "r", path: "p", owner: "Sam", paused: false, createdAt: "2026-10-16T00:00:00Z" } as Milestone;
  it("shows Stop beside Steer for a running persona and stops its run, with its workers when ticked", async () => {
    vi.spyOn(api, "listAssignments").mockResolvedValue([asg]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([persona]);
    vi.spyOn(api, "listRuns").mockResolvedValue([wake, kid1]);
    vi.spyOn(api, "getCycle").mockResolvedValue({ enabled: true });
    vi.spyOn(api, "listNeedsOwner").mockResolvedValue([]);
    const stop = vi.spyOn(api, "stopRun").mockResolvedValue(stopResult(wake));
    render(
      <MemoryRouter>
        <PersonasTab m={m} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: /Steer/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "hold" } });
    fireEvent.click(screen.getByLabelText(/and its workers/));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith("run_wake", { reason: "hold", withWorkers: true }));
  });
});

describe("Add on a tree node", () => {
  it("adds a draft: kind, title and one line go to the milestone (path only for a child epic's node)", async () => {
    const add = vi.spyOn(api, "addToTree").mockResolvedValue({ kind: "row", path: "docs/spines/e.md", id: "T9-S3" });
    render(<AddButton milestoneId="ms_1" nodeTitle="Offline" path="docs/spines/offline.md" />);
    fireEvent.click(screen.getByTestId("tree-add"));
    expect(screen.getByText("Add under Offline")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Add" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "done_means" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Works offline " } });
    fireEvent.change(screen.getByLabelText("One line"), { target: { value: "no network needed" } });
    fireEvent.click(submit);
    await waitFor(() => expect(add).toHaveBeenCalledWith("ms_1", { kind: "done_means", title: "Works offline", line: "no network needed", path: "docs/spines/offline.md" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
  });

  it("the root node sends no path; a refusal from the spine writer is shown", async () => {
    const add = vi.spyOn(api, "addToTree").mockRejectedValue(new Error("nothing written: the checkout has uncommitted changes"));
    render(<AddButton milestoneId="ms_1" />);
    fireEvent.click(screen.getByTestId("tree-add"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/uncommitted changes/)).toBeTruthy();
    expect(add).toHaveBeenCalledWith("ms_1", { kind: "row", title: "Idea" });
  });
});
