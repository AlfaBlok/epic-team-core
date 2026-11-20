// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { Reconnecting, SidebarNav } from "@/components/Layout";
import { createRealClient } from "@/api/real";

afterEach(cleanup);
// the goals no objective holds sit in the sidebar's More objectives fold; these tests read them open.
beforeEach(() => localStorage.setItem("sidebar.moreObjectives.open", "1"));

const LONG = "M4 — Browser auth sync (Mac cookies → host1 for authed agent browsing)";

describe("Sidebar (M2-7: long titles stay inside the sidebar)", () => {
  it("clips the sidebar and clamps milestone titles to 2 lines with the full title as tooltip", async () => {
    await api.createMilestone({ title: LONG, repo: "Acme/home_repo", path: "docs/spines/m4-browser-auth-sync.md", owner: "Sam" });
    const { container } = render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const text = await screen.findByText(LONG);
    expect(text.className).toMatch(/\bline-clamp-2\b/);
    expect(text.className).toMatch(/\bmin-w-0\b/);
    expect(text.className).toMatch(/\bbreak-words\b/);
    expect(text.className).not.toMatch(/\btruncate\b/);

    const link = text.closest("a")!;
    expect(link.getAttribute("title")).toBe(LONG);
    expect(link.className).toMatch(/\bmin-w-0\b/);

    // Every grid/flex ancestor up to the sidebar root shrinks instead of growing with its content.
    const list = screen.getByTestId("sidebar-milestones");
    expect(list.className).toMatch(/\bmin-w-0\b/);
    expect(list.className).toMatch(/\bgrid-cols-1\b/);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bmin-w-0\b/);
    expect(root.className).toMatch(/\boverflow-x-hidden\b/);
    for (const nav of container.querySelectorAll("nav")) expect(nav.className).toMatch(/\bmin-w-0\b/);
  });

  it("labels the button 'Add milestone'", async () => {
    // with no objective the goals list stands alone and ends with its Add button (with objectives it is in their fold)
    vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [] } as never);
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    // the menu draws at once, when its lists are in
    await waitFor(() => expect(document.querySelector("[data-waiting-on]")?.getAttribute("data-waiting-on") ?? "").toBe(""), { timeout: 3000 });
    expect(await screen.findByRole("button", { name: "Add project" })).toBeTruthy();
  });
});

describe("Sidebar draws whole, the objectives in its first frame", () => {
  it("keeps one skeleton while GET /api/scorecards has not answered, then draws the menu and the objectives together", async () => {
    let answer!: (v: never) => void;
    const spy = vi.spyOn(api, "listScorecards").mockReturnValue(new Promise((r) => (answer = r)) as never);
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      // every other list is in: the menu still waits, named, on the objectives' scores only
      await waitFor(() => expect(document.querySelector("[data-waiting-on]")?.getAttribute("data-waiting-on")).toBe("scorecards"), { timeout: 3000 });
      expect(screen.getByTestId("sidebar-body").hidden).toBe(true);
      answer({ nodes: [] } as never);
      await waitFor(() => expect(document.querySelector("[data-waiting-on]")).toBeNull());
      expect(screen.getByTestId("sidebar-body").hidden).toBe(false);
      expect(screen.getByTestId("nav-inbox")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Add project" })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Sidebar draws whole, the Messages entry in its first frame", () => {
  it("keeps one skeleton while the chats are not read, then draws the menu", async () => {
    let answer!: (v: never) => void;
    const spy = vi.spyOn(api, "getMessages").mockReturnValue(new Promise((r) => (answer = r)) as never);
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      await waitFor(() => expect(document.querySelector("[data-waiting-on]")?.getAttribute("data-waiting-on") ?? "").toContain("messages"), { timeout: 3000 });
      expect(screen.getByTestId("sidebar-body").hidden).toBe(true);
      answer({ repos: [], chats: [], counts: { waiting: 0 } } as never);
      await waitFor(() => expect(document.querySelector("[data-waiting-on]")).toBeNull());
      expect(screen.getByTestId("sidebar-body").hidden).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Sidebar inbox count (T13-S13: replaces the M2-10 non-green count)", () => {
  it("shows the server status's needsYou per milestone, nothing at 0, never the open-node count", async () => {
    const a = await api.createMilestone({ title: "Waits", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    const b = await api.createMilestone({ title: "Quiet", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    const real = api.listStatus.bind(api);
    const spy = vi.spyOn(api, "listStatus").mockImplementation(async () => {
      const r = await real();
      // a milestone's pill is the length of its open items (the list its page shows)
      const item = (id: string) => ({ id: `wj_${id}`, kind: "ask" as const, state: "open" as const, milestoneId: id, title: "Q?" });
      const fake = (id: string, n: number) => ({ ...(r.milestones.find((x) => x.milestoneId === id) ?? r.milestones[0]), milestoneId: id, needsYou: n, items: n ? [item(id)] : [] });
      return { ...r, milestones: [...r.milestones.filter((x) => x.milestoneId !== a.id && x.milestoneId !== b.id), fake(a.id, 1), fake(b.id, 0)] };
    });
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      const waits = (await screen.findByText("Waits")).closest("a")!;
      await waitFor(() => expect(waits.querySelector('[data-testid="sidebar-needs-you"]')?.textContent).toBe("1"));
      const quiet = screen.getByText("Quiet").closest("a")!;
      expect(quiet.querySelector('[data-testid="sidebar-needs-you"]')).toBeNull();
      expect(document.querySelector('[data-testid="non-green"]')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Sidebar count while the console's spines are not read yet (T13-S16)", () => {
  it("a loading status draws a loading mark, never a number (no 0, no low count), and the Team badge waits too", async () => {
    const a = await api.createMilestone({ title: "Cold", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    const real = api.listStatus.bind(api);
    const spy = vi.spyOn(api, "listStatus").mockImplementation(async () => {
      const r = await real();
      const base = r.milestones.find((x) => x.milestoneId === a.id) ?? r.milestones[0];
      return { ...r, loading: true, needsYou: null, milestones: [...r.milestones.filter((x) => x.milestoneId !== a.id), { ...base, milestoneId: a.id, items: [], needsYou: null, loading: true }] };
    });
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      const cold = (await screen.findByText("Cold")).closest("a")!;
      await waitFor(() => expect(cold.querySelector('[data-testid="needs-you-loading"]')).not.toBeNull());
      expect(cold.querySelector('[data-testid="sidebar-needs-you"]')).toBeNull();
      expect(document.querySelector('[data-testid="waiting-count"]')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Sidebar docTitle (Doctrine-2 spine title)", () => {
  it("shows the spine's title when the server derives one, the stored title in the tooltip", async () => {
    const stored = "poly-maker · EPIC: E904 ONE LOGGER — the market is observed once";
    const m = await api.createMilestone({ title: stored, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    const list = api.listMilestones.bind(api);
    const spy = vi.spyOn(api, "listMilestones").mockImplementation(async (o) => (await list(o)).map((x) => (x.id === m.id ? { ...x, docTitle: "PLAN-4: ONE LOGGER" } : x)));
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      const link = (await screen.findByText("PLAN-4: ONE LOGGER")).closest("a")!;
      expect(link.getAttribute("title")).toBe(`PLAN-4: ONE LOGGER (console title: ${stored})`);
      expect(screen.queryByText(stored)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Sidebar explicit title (T6-S26)", () => {
  it("a title saved in Settings wins over the spine's title; the spine's title moves to the tooltip", async () => {
    const m = await api.createMilestone({ title: "Memo", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    const list = api.listMilestones.bind(api);
    const spy = vi
      .spyOn(api, "listMilestones")
      .mockImplementation(async (o) => (await list(o)).map((x) => (x.id === m.id ? { ...x, docTitle: "EPIC 0 · Foundation Spine", titleOverride: true } : x)));
    try {
      render(
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>,
      );
      const link = (await screen.findByText("Memo")).closest("a")!;
      expect(link.getAttribute("title")).toBe("Memo (spine title: EPIC 0 · Foundation Spine)");
      expect(screen.queryByText("EPIC 0 · Foundation Spine")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("T44-S5: a console restart shows one quiet line, not a red error", () => {
  it("'Console restarting, reconnecting…' while a GET waits out a proxy 502, gone once it answers", async () => {
    const answers = [new Response("bad gateway", { status: 502 }), new Response("[]", { status: 200 })];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    render(<Reconnecting />);
    const p = createRealClient().listMilestones();
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Console restarting, reconnecting…");
    expect(await p).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    vi.unstubAllGlobals();
  });
});
