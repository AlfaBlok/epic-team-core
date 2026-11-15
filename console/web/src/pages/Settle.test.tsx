// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { Milestone } from "@/api";
import { MilestonePage } from "@/pages/Milestone";
import { TeamPage } from "@/pages/Team";
import { SidebarNav } from "@/components/Layout";
import { canSettle } from "@/lib/derive";
import type { MilestoneStatusView } from "@/api";

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

const DONE: Partial<Milestone> = { status: "done", verdict: { word: "accomplished", source: "outcome" } };
const make = (title: string) =>
  api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });

async function renderPage(patch: Partial<Milestone>, search = "", outcome?: MilestoneStatusView["outcome"], items: MilestoneStatusView["items"] = []) {
  const m = await make("Settleable");
  const real = api.getMilestone.bind(api);
  vi.spyOn(api, "getMilestone").mockImplementation(async (id) => ({ ...(await real(id)), ...patch }));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  // Settle reads the server's outcome mark; a done milestone with the owner's verdict is accomplished.
  const accomplished = patch.verdict?.word === "accomplished";
  vi.spyOn(api, "getMilestoneStatus").mockResolvedValue({
    milestoneId: m.id, outcome: outcome ?? { word: accomplished ? "accomplished" : "not_yet", source: accomplished ? "outcome" : "derived" },
    flow: { word: patch.settledAt ? "settled" : items.length ? "needs_you" : "nothing_to_do", reason: "" }, items, needsYou: items.length, reasons: [],
  });
  render(
    <MemoryRouter initialEntries={[`/milestones/${m.id}${search}`]}>
      <Routes>
        <Route path="/" element={<div data-testid="team-home" />} />
        <Route path="/milestones/:id" element={<MilestonePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return m;
}

describe("canSettle (T13-S2: only Sam's mark opens Settle)", () => {
  it("accomplished, partially, superseded; never ready to mark, reopened or not yet", () => {
    for (const word of ["accomplished", "partially", "superseded"] as const) expect(canSettle({ outcome: { word } })).toBe(true);
    for (const word of ["not_yet", "ready_to_mark", "reopened"] as const) expect(canSettle({ outcome: { word } })).toBe(false);
    expect(canSettle(undefined)).toBe(false);
  });
});

describe("Settle button on the milestone page (M2-21)", () => {
  it("shows for an accomplished milestone; clicking settles it and goes to Team home", async () => {
    const m = await renderPage(DONE);
    const btn = await screen.findByRole("button", { name: /Settle/ });
    const spy = vi.spyOn(api, "settleMilestone");
    fireEvent.click(btn);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(m.id));
    expect(await screen.findByTestId("team-home")).toBeTruthy();
    expect((await api.listMilestones()).some((x) => x.id === m.id)).toBe(false);
  });

  it("is shown disabled with 'not accomplished yet' until the outcome is marked (ready to mark included)", async () => {
    await renderPage({ status: "done", verdict: { word: "accomplished?", source: "derived" } }, "", { word: "ready_to_mark", source: "derived" });
    const btn = (await screen.findByRole("button", { name: /^Settle$/ })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("settle-reason").textContent).toBe("not accomplished yet");
    expect(screen.getByRole("button", { name: /Review and mark/ })).toBeTruthy();
  });

  it("a settled milestone page stays reachable, shows a Settled badge next to the unchanged status, and no Settle button", async () => {
    await renderPage({ ...DONE, settledAt: "2026-10-22T10:00:00.000Z" });
    const badge = await screen.findByTestId("settled-badge");
    expect(badge.textContent).toBe("Settled");
    expect(screen.getByTestId("outcome-badge").getAttribute("title")).toContain("spine Status: done"); // spine status unchanged, in the tooltip
    expect(screen.queryByRole("button", { name: /^Settle$/ })).toBeNull();
  });

  it("not settled → no badge", async () => {
    await renderPage(DONE);
    await screen.findByTestId("set-tabs");
    expect(screen.queryByTestId("settled-badge")).toBeNull();
  });
});

describe("Settings tab (M2-21)", () => {
  it("settles an accomplished milestone and returns to Team home", async () => {
    const m = await renderPage(DONE, "?tab=settings");
    const spy = vi.spyOn(api, "settleMilestone");
    const btn = (await screen.findAllByRole("button", { name: /Settle/ })).find((b) => !(b as HTMLButtonElement).disabled)!;
    fireEvent.click(btn);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(m.id));
    expect(await screen.findByTestId("team-home")).toBeTruthy();
  });

  it("Settle is disabled until accomplished; the spine's Status word lives here", async () => {
    await renderPage({ status: "active", verdict: { word: "in progress", source: "derived" } }, "?tab=settings");
    const btn = (await screen.findAllByRole("button", { name: /Settle/ }))[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/^Not accomplished yet: available once you mark the outcome/)).toBeTruthy();
    expect(screen.getByTestId("spine-status").textContent).toBe("spine: active");
  });

  it("unsettles a settled milestone", async () => {
    const m = await renderPage({ ...DONE, settledAt: "2026-10-22T10:00:00.000Z" }, "?tab=settings");
    const spy = vi.spyOn(api, "unsettleMilestone");
    fireEvent.click(await screen.findByRole("button", { name: "Unsettle" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(m.id));
  });
});

describe("hidden by default (mock API + sidebar + Team home)", () => {
  it("listMilestones hides settled; includeSettled shows them; status and verdict are unchanged", async () => {
    const m = await make("Quietly done");
    await api.updateMilestone(m.id, {});
    const before = await api.getMilestone(m.id);
    const settled = await api.settleMilestone(m.id);
    expect(settled.settledAt).toBeTruthy();
    expect(settled.status).toBe(before.status);
    expect(settled.verdict).toEqual(before.verdict);
    expect((await api.listMilestones()).some((x) => x.id === m.id)).toBe(false);
    expect((await api.listMilestones({ includeSettled: true })).find((x) => x.id === m.id)?.settledAt).toBeTruthy();
    expect((await api.getMilestone(m.id)).settledAt).toBeTruthy(); // direct URL still works
    const back = await api.unsettleMilestone(m.id);
    expect(back.settledAt).toBeUndefined();
    expect((await api.listMilestones()).some((x) => x.id === m.id)).toBe(true);
  });

  it("the sidebar and Team home omit a settled milestone", async () => {
    const m = await make("Gone from lists");
    render(
      <MemoryRouter>
        <SidebarNav />
        <TeamPage section="settings" />
      </MemoryRouter>,
    );
    expect((await screen.findAllByText("Gone from lists")).length).toBeGreaterThan(0);
    cleanup();
    await api.settleMilestone(m.id);
    render(
      <MemoryRouter>
        <SidebarNav />
        <TeamPage section="settings" />
      </MemoryRouter>,
    );
    await screen.findByText("Focus projects", { selector: "h2" }); // the section heading is "Focus milestones"
    await waitFor(() => expect(screen.getByTestId("sidebar-milestones")).toBeTruthy());
    expect(screen.queryByText("Gone from lists")).toBeNull();
  });

  it("waiting items of a settled milestone are hidden globally (counts), but not when scoped", async () => {
    const id = "ms-e5"; // seeded with an open Needs the owner row
    const open = async (f = {}) => (await api.listWaitingOnOwner(f)).filter((w) => w.milestoneId === id);
    const before = (await open()).length;
    expect(before).toBeGreaterThan(0);
    await api.settleMilestone(id);
    expect(await open()).toHaveLength(0);
    expect(await open({ includeSettled: true })).toHaveLength(before);
    expect(await open({ milestoneId: id })).toHaveLength(before);
    await api.unsettleMilestone(id);
    expect(await open()).toHaveLength(before);
  });
});

describe("T13-S2 header marks and the mark dialog", () => {
  it("every milestone header shows two prominent badges, OUTCOME and FLOW; no quiet 'spine:' text", async () => {
    await renderPage({ status: "active" });
    const outcome = await screen.findByTestId("outcome-badge");
    expect(outcome.textContent).toBe("OutcomeNot accomplished yet");
    expect(screen.getByTestId("flow-badge").textContent).toBe("FlowNothing to do");
    expect(screen.queryByText(/^spine: /)).toBeNull();
  });

  it("reopened: 'Reopened · N open' links to the Tree, Settle stays off, the old verdict is history", async () => {
    await renderPage(
      { status: "done", outcome: { verdict: "accomplished", sentence: "x", evidence: [], risk: null, closedAt: "2026-10-24", closedBy: "Sam (console)" } },
      "",
      { word: "reopened", source: "outcome", open: 2, note: "Outcome says accomplished, but 2 goals under it are not done" },
    );
    const badge = await screen.findByTestId("outcome-badge");
    expect(badge.textContent).toBe("OutcomeReopened · 2 open");
    expect(badge.closest("a")?.getAttribute("href")).toBe("?tab=tree");
    expect(screen.getByTestId("reopened-line").textContent).toContain("History: Accomplished 2026-10-24 by Sam (console)");
    expect((screen.getByRole("button", { name: /^Settle$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("settle-reason").textContent).toBe("not accomplished yet: 2 open under it");
  });

  it("Ready to mark: the strip links to the dialog; marking sends verdict, sentence, note and the evidence table", async () => {
    const item = { id: "ready_to_mark:x", kind: "ready_to_mark" as const, state: "open" as const, milestoneId: "x", title: "Review and mark the outcome" };
    const m = await renderPage(
      { status: "review", doctrine: { doneMeans: [{ id: "E3-1", text: "it works", done: true }] } as Milestone["doctrine"], outcome: { verdict: null, sentence: "It works.", evidence: [{ doneMeans: "E3-1 it works", links: ["abc1234"] }], risk: null, closedAt: null, closedBy: null } },
      "",
      { word: "ready_to_mark", source: "derived" },
      [item],
    );
    expect((await screen.findByTestId("state-strip")).textContent).toContain("Needs you· 1 · 1 to mark");
    expect(screen.getByTestId("review-and-mark").getAttribute("href")).toBe(`/milestones/${m.id}?mark=1`);
    const spy = vi.spyOn(api, "markMilestone").mockResolvedValue({ verdict: "partially", path: "p", status: {} as MilestoneStatusView });
    fireEvent.click(screen.getByRole("button", { name: /Review and mark/ }));
    const dialog = await screen.findByTestId("mark-dialog");
    expect((screen.getByLabelText("Evidence for E3-1 it works") as HTMLInputElement).value).toBe("abc1234");
    fireEvent.click(screen.getByRole("radio", { name: /Partially/ }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "half of it" } });
    fireEvent.submit(dialog);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(m.id, { verdict: "partially", sentence: "It works.", risk: "", note: "half of it", evidence: [{ doneMeans: "E3-1 it works", evidence: "abc1234" }] }),
    );
  });
});
