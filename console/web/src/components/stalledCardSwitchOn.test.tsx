// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem } from "@/api";
import { StatusItemRow } from "@/components/waiting";
import { statusQuestion } from "@/lib/pending";

/**
 * E948-S204 (the owner, closing E948-S200 24 Nov: "a stalled-team card asks Should a team member work on it? and offers
 * Switch on, not Yes and No"): his question word for word, Switch on switches the goal's persona on (the Personas tab's
 * own switch), Leave it off is the quiet second choice, and the note box stays.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stalled: PendingItem = {
  id: "stalled:ms_7",
  kind: "stalled",
  state: "alarm",
  milestoneId: "ms_7",
  title: "3 steps ready, nobody on. Switch on Delivery Manager?",
  detail: "3 steps ready on Get 5 testers. Delivery Manager is switched off, so nobody wakes on it.",
  goal: "Get 5 testers",
  switchOn: [{ assignmentId: "as_1", persona: "Delivery Manager" }],
};
const labels = (root: ParentNode) => [...root.querySelectorAll("button, a")].map((b) => (b.textContent ?? "").trim()).filter(Boolean);
const card = (item: PendingItem) =>
  render(
    <MemoryRouter>
      <StatusItemRow item={item} />
    </MemoryRouter>,
  );

describe("the stalled-team card asks his question and switches the team on (E948-S204)", () => {
  it("asks Should a team member work on it?, names the goal, offers Switch on and Leave it off, never Yes, No or Answer", () => {
    expect(statusQuestion(stalled).question).toBe("Should a team member work on it?");
    card(stalled);
    const c = screen.getByTestId("status-item");
    expect(screen.getByTestId("status-item-question").textContent).toBe("Should a team member work on it?");
    expect(c.textContent).toContain("Get 5 testers");
    expect(screen.getByTestId("status-item-detail").textContent).toContain("Delivery Manager is switched off");
    expect(screen.getByTestId("stalled-switch-on").textContent).toContain("Switch on");
    expect(screen.getByTestId("stalled-leave-off").textContent).toContain("Leave it off");
    const all = labels(c);
    for (const no of ["Yes: go ahead", "No: drop it", "Answer", "Yes", "No"]) expect(all).not.toContain(no);
    // the free note stays: the card's words box
    expect(c.textContent).toMatch(/Voice|Text|note/i);
  });

  it("Switch on turns the goal's persona on through the Personas switch, in one tap", async () => {
    const on = vi.spyOn(api, "updateAssignment").mockResolvedValue({ id: "as_1" } as Awaited<ReturnType<typeof api.updateAssignment>>);
    const pause = vi.spyOn(api, "updateMilestone");
    card(stalled);
    fireEvent.click(screen.getByTestId("stalled-switch-on"));
    await waitFor(() => expect(on).toHaveBeenCalledWith("as_1", { enabled: true }));
    expect(pause).not.toHaveBeenCalled();
  });

  it("Leave it off pauses the goal, so the card does not come back", async () => {
    const pause = vi.spyOn(api, "updateMilestone").mockResolvedValue({ id: "ms_7" } as Awaited<ReturnType<typeof api.updateMilestone>>);
    const on = vi.spyOn(api, "updateAssignment");
    card(stalled);
    fireEvent.click(screen.getByTestId("stalled-leave-off"));
    await waitFor(() => expect(pause).toHaveBeenCalledWith("ms_7", { paused: true }));
    expect(on).not.toHaveBeenCalled();
  });

  it("with nobody to switch on, Switch on opens the goal's Personas tab", () => {
    card({ ...stalled, switchOn: undefined });
    expect(screen.getByTestId("stalled-switch-on").getAttribute("href")).toBe("/milestones/ms_7?tab=personas");
  });
});
