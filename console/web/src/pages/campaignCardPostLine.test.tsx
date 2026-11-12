// @vitest-environment jsdom
import { forgetWorld as forgetWorldE33 } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Assignment, type Milestone, type Persona, type Run } from "@/api";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { TeamPage, PostLine } from "@/pages/Team";
import { PersonasPage } from "@/pages/Personas";
import { ChatPage } from "@/pages/Chat";
import { latelyOf } from "@/pages/YourTeam";
import { SKINS, SkinProvider } from "@/lib/skin";

// step 3 (approved mockup, Team home): a campaign card's post line (next post, drafts waiting, live, latest
// digest) and its Pipeline button; Personas rows with their "Lately" line and Run now; the Chat picker in pinned order.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const card = {
  ...mockCampaignCard(),
  milestoneId: "ms-memo",
  held: 2,
  live: 43,
  nextPost: { id: "P-0048", slot: "2026-11-02 14:00", platform: "X", title: "t" },
  latestDigest: { date: "2026-11-01", line: "3 posts measured, 1 new style rule" },
};

// each test is its own tab (a tab remembers its world)
beforeEach(() => forgetWorldE33());

describe("campaign card post line", () => {
  it("next post, drafts waiting, live and the latest digest", () => {
    render(<PostLine c={card} />);
    const l = screen.getByTestId("card-post-line");
    expect(l.textContent).toContain("Next post Mon 2 Nov 14:00 · X · 2 drafts wait for you · 43 out");
    expect(l.textContent).toContain("Latest digest Sun 1 Nov: 3 posts measured, 1 new style rule");
    cleanup();
    render(<PostLine c={{ ...card, nextPost: null, held: 1, live: 0, latestDigest: null }} />);
    expect(screen.getByTestId("card-post-line").textContent).toBe("Nothing scheduled · 1 draft waits for you · 0 out");
    cleanup();
    // a named campaign says whether it is live (posting) or not, and why.
    render(<PostLine c={{ ...card, posting: { live: false, line: "Not live: its Publisher is off, so its approved posts wait" } }} />);
    const p = screen.getByTestId("card-posting");
    expect(p.dataset.live).toBe("no");
    expect(p.textContent).toBe("Not liveits Publisher is off, so its approved posts wait");
  });

  it("on Team home a social-pack milestone's card shows it, with a Pipeline button when pinned; other cards do not", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: [card] });
    const ms = await api.listMilestones();
    vi.spyOn(api, "listMilestones").mockResolvedValue(ms.map((m: Milestone) => (m.id === "ms-memo" ? { ...m, bigRoot: 1 } : m)));
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </SkinProvider>,
    );
    const line = await screen.findByTestId("card-post-line");
    const zcard = line.closest('[data-testid="milestone-card"]') as HTMLElement;
    expect(within(zcard).getByTestId("card-pipeline").getAttribute("href")).toBe("/milestones/ms-memo");
    expect(within(zcard).getByRole("button", { name: /Unpin/ })).toBeTruthy(); // step 1: focus works in the social skin
    expect(screen.getAllByTestId("card-post-line")).toHaveLength(1);
  });
});

describe("Personas: Lately and Run now (both sites)", () => {
  const runs = [
    { id: "r1", assignmentId: "as_w", startedAt: "2026-11-02T08:00:00Z", outcome: "progressed", summary: "Redrafted P-0008 for your note." },
    { id: "r2", assignmentId: "as_w", startedAt: "2026-11-01T08:00:00Z", outcome: "progressed", summary: "Drafted P-0061 from I-5 (commit abc1234def)." },
    { id: "r3", assignmentId: "as_w", startedAt: "2026-10-31T08:00:00Z", outcome: "idle", summary: "" },
    { id: "r4", assignmentId: "as_w", startedAt: "2026-10-30T08:00:00Z", outcome: "progressed", summary: "Older." },
    { id: "r5", assignmentId: "as_w", startedAt: "2026-11-02T09:00:00Z", outcome: "running", summary: "" },
  ] as unknown as Run[];
  const assignments = [{ id: "as_w", personaId: "pe_w", milestoneId: "ms-memo" }] as Assignment[];

  it("latelyOf: the last three ended wakes in plain words, newest first", () => {
    expect(latelyOf("pe_w", assignments, runs)).toEqual(["Redrafted P-0008 for your note.", "Drafted P-0061 from I-5.", "nothing new to do"]);
    expect(latelyOf("pe_other", assignments, runs)).toEqual([]);
  });

  it("the Personas page shows the Lately line and Run now (one assignment), which spins and says it is waking", async () => {
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_w", name: "Writer", remit: "", skills: [], model: "opus", mayWrite: true } as unknown as Persona]);
    vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
    vi.spyOn(api, "listRuns").mockResolvedValue(runs);
    const run = vi.spyOn(api, "runAssignmentNow").mockResolvedValue({ id: "run_x" } as never);
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <PersonasPage />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect((await screen.findByTestId("persona-lately")).textContent).toBe("Lately: Redrafted P-0008 for your note. · Drafted P-0061 from I-5. · nothing new to do");
    expect(screen.getByRole("heading", { name: "Personas" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("persona-run-now"));
    await waitFor(() => expect(run).toHaveBeenCalledWith("as_w", expect.stringContaining("Run now from the Personas page")));
    expect(await screen.findByText("Writer is waking now")).toBeTruthy();
  });
});

describe("T58-S4 Chat: the world's team desk; each campaign's chat is its page's Chat tab", () => {
  it("the top-level Chat has no campaign picker and talks to the world's desk; Call is the world desk's", async () => {
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ mode: "on", identity: { kind: "none" }, tenant: { id: "social", skin: "social" }, worlds: [] } as never);
    const world = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue({ available: true, threadId: "th_w", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as never);
    const send = vi.spyOn(api, "sendWorldDeskMessage").mockResolvedValue({ threadId: "th_w", pending: false });
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={["/chat"]}>
          <Routes>
            <Route path="/chat" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </SkinProvider>,
    );
    await waitFor(() => expect(world).toHaveBeenCalledWith("social", { limit: 30 }));
    expect(screen.queryByTestId("desk-campaign")).toBeNull();
    const box = await screen.findByLabelText(/Message to the Team desk/);
    fireEvent.change(box, { target: { value: "Which campaign needs me?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("social", "Which campaign needs me?", undefined, expect.any(String)));
  });
});
