// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, type Assignment, type Persona, type Run } from "@/api";
import { PersonaDialog } from "@/components/dialogs";
import { RunTimeline } from "@/components/timeline";
import { timelineGroups } from "@/lib/derive";

/** any cadence persona's skipped wakes show as "<persona>: nothing new"; personas can opt out of skipping. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = (id: string, hour: number, summary: string): Run => ({
  id,
  assignmentId: "as_dm",
  milestoneId: "ms_1",
  startedAt: `2026-10-24T${String(hour).padStart(2, "0")}:00:00Z`,
  endedAt: `2026-10-24T${String(hour).padStart(2, "0")}:00:01Z`,
  outcome: "idle",
  summary,
});

describe("T8-S17 skip wakes when nothing changed", () => {
  it("collapses a Delivery Manager's skipped wakes under its own name", () => {
    const assignments: Assignment[] = [{ id: "as_dm", milestoneId: "ms_1", personaId: "pe_dm", cadence: { type: "interval", everyMinutes: 120 }, enabled: true }];
    const personas = [{ id: "pe_dm", name: "Delivery Manager" }] as Persona[];
    const runs = [run("s2", 6, "skipped: nothing new since real"), run("s1", 4, "skipped: nothing new since real"), run("real", 2, "dispatched S2")];
    render(<RunTimeline groups={timelineGroups(runs, assignments)} personas={personas} />);
    const rows = screen.getAllByTestId("nothing-new");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Delivery Manager: nothing new");
    expect(rows[0].textContent).toContain("2 wakes skipped");
    expect(screen.getByText("dispatched S2")).toBeTruthy();
  });

  it("the persona dialog defaults skipping on and sends skipUnchanged false when switched off", async () => {
    const create = vi.spyOn(api, "createPersona").mockResolvedValue({} as never);
    render(<PersonaDialog open onOpenChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Skip wakes when nothing changed" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    fireEvent.change(screen.getByPlaceholderText("infra-steward"), { target: { value: "dm" } });
    fireEvent.change(screen.getByRole("textbox", { name: /remit/i }), { target: { value: "deliver" } });
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ skipUnchanged: false });
  });

  it("an existing persona without the field shows skipping on", () => {
    const p = { id: "pe", name: "DM", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true, createdAt: "" } as Persona;
    render(<PersonaDialog open onOpenChange={() => {}} persona={p} />);
    expect(within(document.body).getByRole("switch", { name: "Skip wakes when nothing changed" }).getAttribute("aria-checked")).toBe("true");
  });
});
