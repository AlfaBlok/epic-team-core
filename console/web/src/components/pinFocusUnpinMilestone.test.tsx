// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import { MilestonePage } from "@/pages/Milestone";
import { TeamPage } from "@/pages/Team";
import { SKINS, SkinProvider } from "@/lib/skin";

// the milestone page header pins the milestone he is on to focus, or unpins it, with the same focus
// list, order and save path as Team home; a pin goes at the end of the focus list.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const mk = (title: string, bigRoot?: number) => api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
const header = () => screen.getByRole("heading", { level: 1 }).parentElement!.parentElement!;
const renderMilestone = (id: string, social = false) => {
  const page = (
    <MemoryRouter initialEntries={[`/milestones/${id}`]}>
      <Routes>
        <Route path="/milestones/:id" element={<MilestonePage />} />
      </Routes>
    </MemoryRouter>
  );
  return render(social ? <SkinProvider skin={SKINS.social}>{page}</SkinProvider> : page);
};
const focusTitles = async () => {
  render(
    <MemoryRouter>
      <TeamPage section="settings" />
    </MemoryRouter>,
  );
  const head = await screen.findByTestId("focus-milestones");
  const grid = () => head.parentElement!.querySelector(`[data-testid="focus-milestones"] ~ div.grid`)!;
  await waitFor(() => expect(grid().querySelectorAll('[data-testid="milestone-card"]').length).toBeGreaterThan(0));
  const titles = [...grid().querySelectorAll('[data-testid="milestone-card"] .text-base')].map((e) => e.textContent);
  cleanup();
  return titles;
};

describe("T40-S4 Pin to focus / Unpin in the milestone page header", () => {
  it("pins the milestone at the end of Team home's focus list, then unpins it and the order comes back", async () => {
    await mk("SocialApp launch", 1);
    await mk("Memo launch", 2);
    const infra = await mk("ops · PLAN-9");
    const spy = vi.spyOn(api, "updateMilestone");
    expect(await focusTitles()).toEqual(["SocialApp launch", "Memo launch"]);

    renderMilestone(infra.id);
    await screen.findByRole("heading", { level: 1, name: "ops · PLAN-9" });
    const pin = await within(header()).findByRole("button", { name: /Pin to focus/ });
    await waitFor(() => expect((pin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(pin);
    expect(await within(header()).findByRole("button", { name: /^Unpin$/ })).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(infra.id, { bigRoot: 3 });
    expect(within(header()).getByTestId("header-focus-note").textContent).toContain("pinned to focus at 3");
    cleanup();
    expect(await focusTitles()).toEqual(["SocialApp launch", "Memo launch", "ops · PLAN-9"]);

    renderMilestone(infra.id);
    const unpin = await within(await screen.findByRole("heading", { level: 1 }).then(() => header())).findByRole("button", { name: /^Unpin$/ });
    await waitFor(() => expect((unpin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(unpin);
    expect(await within(header()).findByRole("button", { name: /Pin to focus/ })).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(infra.id, { bigRoot: null });
    expect(within(header()).getByTestId("header-focus-note").textContent).toContain("unpinned from focus");
    cleanup();
    expect(await focusTitles()).toEqual(["SocialApp launch", "Memo launch"]);
  });

  it("spins while saving (L-38), and the social skin shows it too", async () => {
    await mk("SocialApp launch", 1);
    const m = await mk("Job board");
    const end = Math.max(...(await api.listMilestones()).map((x) => x.bigRoot ?? 0)) + 1;
    let release!: () => void;
    const real = api.updateMilestone.bind(api);
    vi.spyOn(api, "updateMilestone").mockImplementation(async (id, patch) => {
      await new Promise<void>((r) => (release = r));
      return real(id, patch);
    });
    renderMilestone(m.id, true);
    await screen.findByRole("heading", { level: 1, name: "Job board" });
    const pin = await within(header()).findByRole("button", { name: /Pin to focus/ });
    await waitFor(() => expect((pin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(pin);
    const busy = await within(header()).findByRole("button", { name: /Pinning…/ });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(within(header()).getByTestId("header-focus-note").textContent).toContain("saving to your team repo");
    release();
    expect(await within(header()).findByRole("button", { name: /^Unpin$/ })).toBeTruthy();
    expect((await api.getMilestone(m.id)).bigRoot).toBe(end);
  });
});
