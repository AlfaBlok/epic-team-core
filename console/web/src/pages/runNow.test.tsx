// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { PersonasTab } from "@/pages/Milestone";
import { RunNote } from "@/components/common";
import type { Assignment, Milestone, Persona, Run } from "@/api";

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

/** Run now opens a dialog with optional one-off instructions for that wake. */
describe("Run now dialog (T8-S2)", () => {
  const m = { id: "ms_1", title: "E904", repo: "r", path: "p", owner: "Sam", paused: false, createdAt: "2026-10-16T00:00:00Z" } as Milestone;
  const persona: Persona = { id: "per_1", name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false, createdAt: "2026-10-16T00:00:00Z" };
  const asg: Assignment = { id: "asg_1", milestoneId: "ms_1", personaId: "per_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true };
  const run: Run = { id: "run_1", assignmentId: "asg_1", startedAt: "2026-10-22T10:00:00Z", outcome: "running", summary: "Run now: waiting" };
  const setup = () => {
    vi.spyOn(api, "listAssignments").mockResolvedValue([asg]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([persona]);
    vi.spyOn(api, "listRuns").mockResolvedValue([]);
    vi.spyOn(api, "getCycle").mockResolvedValue({ enabled: true });
    vi.spyOn(api, "listNeedsOwner").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <PersonasTab m={m} />
      </MemoryRouter>,
    );
  };

  it("opens a dialog instead of waking at once; Cancel wakes nothing", async () => {
    const runNow = vi.spyOn(api, "runAssignmentNow").mockResolvedValue(run);
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    expect(screen.getByLabelText("Instructions for this run")).toBeTruthy();
    expect(screen.getByText("Run Delivery Manager now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Instructions for this run")).toBeNull());
    expect(runNow).not.toHaveBeenCalled();
  });

  it("submits the trimmed note and closes", async () => {
    const runNow = vi.spyOn(api, "runAssignmentNow").mockResolvedValue(run);
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    fireEvent.change(screen.getByLabelText("Instructions for this run"), { target: { value: "  finish S5 first\nno deploy  " } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("asg_1", "finish S5 first\nno deploy", expect.stringMatching(/^console-run-now-/)));
    await waitFor(() => expect(screen.queryByLabelText("Instructions for this run")).toBeNull());
  });

  it("empty (or blank) submit sends no note", async () => {
    const runNow = vi.spyOn(api, "runAssignmentNow").mockResolvedValue(run);
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    fireEvent.change(screen.getByLabelText("Instructions for this run"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("asg_1", undefined, expect.stringMatching(/^console-run-now-/)));
  });

  it("Ctrl/Cmd+Enter submits", async () => {
    const runNow = vi.spyOn(api, "runAssignmentNow").mockResolvedValue(run);
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    const box = screen.getByLabelText("Instructions for this run");
    fireEvent.change(box, { target: { value: "go" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("asg_1", "go", expect.stringMatching(/^console-run-now-/)));
  });

  it("keeps the dialog open with the error when the wake fails (e.g. setting up)", async () => {
    vi.spyOn(api, "runAssignmentNow").mockRejectedValue(new Error("setting up, retry in ~1 min"));
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("setting up, retry in ~1 min")).toBeTruthy();
    expect(screen.getByLabelText("Instructions for this run")).toBeTruthy();
  });

  it("T6-S22: the Run button is disabled while the request is in flight; a second click sends nothing", async () => {
    let resolve!: (r: Run) => void;
    const runNow = vi.spyOn(api, "runAssignmentNow").mockImplementation(() => new Promise<Run>((r) => (resolve = r)));
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    const btn = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    const starting = (await screen.findByRole("button", { name: "Starting…" })) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    fireEvent.submit(starting.closest("form")!);
    expect(runNow).toHaveBeenCalledTimes(1);
    resolve(run);
    await waitFor(() => expect(screen.queryByLabelText("Instructions for this run")).toBeNull());
  });

  it("T6-S22: a genuinely new click while a run is live still shows the server's 'still running' message", async () => {
    vi.spyOn(api, "runAssignmentNow").mockRejectedValue(new Error("run run_9 of this assignment is still running"));
    setup();
    fireEvent.click(await screen.findByText("Run now"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("run run_9 of this assignment is still running")).toBeTruthy();
  });
});

describe("RunNote (T8-S2 Activity)", () => {
  it("shows the first line collapsed and the full note inside", () => {
    render(<RunNote text={"first line\nsecond line"} />);
    const d = screen.getByTestId("run-note") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector("summary")!.textContent).toBe("Sam's note: first line");
    expect(d.textContent).toContain("second line");
  });
  it("renders nothing without a note", () => {
    const { container } = render(<RunNote />);
    expect(container.innerHTML).toBe("");
  });
});

/** Run now on a milestone a wake would not work (planning / parked / finished) says so and needs a confirm. */
describe("Run now on a non-runnable milestone (T14-S2)", () => {
  const persona: Persona = { id: "per_1", name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false, createdAt: "2026-10-16T00:00:00Z" };
  const asg: Assignment = { id: "asg_1", milestoneId: "ms_1", personaId: "per_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true };
  const run: Run = { id: "run_1", assignmentId: "asg_1", startedAt: "2026-10-22T10:00:00Z", outcome: "running", summary: "Run now: waiting" };
  const setup = (extra: Partial<Milestone>) => {
    const m = { id: "ms_1", title: "E904", repo: "r", path: "p", owner: "Sam", paused: false, createdAt: "2026-10-16T00:00:00Z", ...extra } as Milestone;
    vi.spyOn(api, "listAssignments").mockResolvedValue([asg]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([persona]);
    vi.spyOn(api, "listRuns").mockResolvedValue([]);
    vi.spyOn(api, "getCycle").mockResolvedValue({ enabled: true });
    vi.spyOn(api, "listNeedsOwner").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <PersonasTab m={m} />
      </MemoryRouter>,
    );
  };

  it("a planning milestone: the dialog says so; Run stays disabled until the confirm is switched on", async () => {
    const runNow = vi.spyOn(api, "runAssignmentNow").mockResolvedValue(run);
    setup({ runState: "planning", runnable: false });
    fireEvent.click(await screen.findByText("Run now"));
    expect(screen.getByText("This epic is Planning: a wake would not work it")).toBeTruthy();
    const go = screen.getByRole("button", { name: "Run anyway" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(runNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Wake it anyway" }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("asg_1", undefined, expect.stringMatching(/^console-run-now-/)));
  });

  it("a runnable or unknown milestone: no confirm, plain Run", async () => {
    vi.spyOn(api, "runAssignmentNow").mockResolvedValue(run);
    setup({ runState: "running", runnable: true });
    fireEvent.click(await screen.findByText("Run now"));
    expect(screen.queryByText(/a wake would not work it/)).toBeNull();
    expect(screen.queryByRole("switch", { name: "Wake it anyway" })).toBeNull();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
