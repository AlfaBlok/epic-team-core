// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Persona, type Run } from "@/api";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { TEAM_ROLES, YourTeamPage, memberView, plainSummary } from "@/pages/YourTeam";
import { landsAt } from "@/test/landsAt";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-10-25T23:40:00Z");
const pe = (id: string, name: string) => ({ id, name, remit: "x", skills: [], model: "", mayWrite: true, createdAt: "" }) as Persona;
const as = (id: string, personaId: string, over: Partial<Assignment> = {}): Assignment => ({
  id,
  milestoneId: "ms_zs",
  personaId,
  cadence: { type: "interval", everyMinutes: 60 },
  enabled: true,
  ...over,
});
const run = (id: string, assignmentId: string, over: Partial<Run>): Run => ({ id, assignmentId, milestoneId: "ms_zs", startedAt: "2026-10-25T20:00:00Z", endedAt: "2026-10-25T20:05:00Z", outcome: "progressed", summary: "", ...over });

// Shaped like a social world repo's dev copy: a Delivery Manager plus the four social personas.
const PERSONAS = [pe("pe_dm", "Delivery Manager"), pe("pe_li", "Listener"), pe("pe_au", "Author"), pe("pe_re", "Responder"), pe("pe_en", "Engager")];
const ASSIGNMENTS = [
  as("as_dm", "pe_dm"),
  as("as_li", "pe_li", { cadence: { type: "fixed_time", timeOfDay: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: "2026-10-26T07:00:00Z", nextWakeAt: "2026-10-26T07:00:00Z" }),
  as("as_au", "pe_au", { nextRunAt: "2026-10-26T00:30:00Z", retryAt: "2026-10-26T00:10:00Z", retryRunId: "run_au1" }),
  as("as_re", "pe_re", { nextRunAt: "2026-10-26T00:00:00Z" }),
  as("as_en", "pe_en", { enabled: false }),
];
const RUNS = [
  run("run_li1", "as_li", { summary: "Ranked 12 conversations about tax software; top 3 sent to the Author.", startedAt: "2026-10-25T07:00:00Z", endedAt: "2026-10-25T07:04:00Z" }),
  run("run_au1", "as_au", { outcome: "monitoring", summary: "No ready rows, no workers. Drafted 2 Reddit replies (f6e9738).", startedAt: "2026-10-25T23:00:00Z", endedAt: "2026-10-25T23:03:00Z" }),
  run("run_re1", "as_re", { outcome: "running", summary: "", startedAt: "2026-10-25T23:30:00Z", endedAt: undefined }),
  run("run_re0", "as_re", { summary: "Posted 6th Reddit reply; 1 comment draft left.", startedAt: "2026-10-25T23:00:00Z", endedAt: "2026-10-25T23:08:00Z" }),
  run("run_re_child", "as_re", { parentRunId: "run_re0", summary: "child worker" }),
  run("run_dm1", "as_dm", { summary: "Delivery manager wake" }),
];

function mockApi() {
  vi.spyOn(api, "listPersonas").mockResolvedValue(PERSONAS);
  vi.spyOn(api, "listAssignments").mockResolvedValue(ASSIGNMENTS);
  vi.spyOn(api, "listRuns").mockResolvedValue(RUNS);
}

const at = (path: string, skin: Skin) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T24-S4 Your team (social skin)", () => {
  it("renders the 4 persona cards from fixture data: did, doing now, next wake", async () => {
    mockApi();
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <YourTeamPage now={NOW} />
        </MemoryRouter>
      </SkinProvider>,
    );
    const cards = await screen.findAllByTestId("team-member");
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.querySelector(".text-base")!.textContent)).toEqual(["Listener", "Author", "Responder", "Engager"]);
    expect(screen.queryByText("Delivery Manager")).toBeNull();

    const [li, au, re, en] = cards.map((c) => within(c));
    expect(li.getByText("Got work done")).toBeTruthy();
    expect(li.getByText(/Ranked 12 conversations/)).toBeTruthy();
    expect(li.getByTestId("next-wake").textContent).toBe("in 7 h");

    // Plain words: bookkeeping sentences and commit ids are gone; the timed wake it asked for wins over the cadence.
    expect(au.getByText("Checked in, keeping watch")).toBeTruthy();
    expect(au.getByText("Drafted 2 Reddit replies.")).toBeTruthy();
    expect(au.queryByText(/ready rows|f6e9738/)).toBeNull();
    expect(au.getByTestId("doing-now").textContent).toMatch(/Keeping watch/);
    expect(au.getByTestId("next-wake").textContent).toBe("in 30 min (it asked to check back)");

    expect(re.getByTestId("doing-now").textContent).toBe("Working on it right now. Started 10 min ago.");
    expect(re.getAllByRole("listitem")).toHaveLength(1);
    expect(re.queryByText("child worker")).toBeNull();
    expect(re.getByTestId("next-wake").textContent).toBe("in 20 min");

    expect(en.getByTestId("doing-now").textContent).toBe("Resting. It is switched off.");
    expect(en.getByTestId("next-wake").textContent).toBe("Only when you ask");
    expect(en.getByText("Nothing yet.")).toBeTruthy();
  });

  it("has a route (no nav link since T58-S3) in the social skin", async () => {
    mockApi();
    expect(await landsAt("/your-team")).toBe("/personas"); // the Lately lines are on Personas
    cleanup();
    const { container } = render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>
      </SkinProvider>,
    );
    // out of the menu (its "Lately" lines go to Personas); the route stays for old links.
    expect([...container.querySelectorAll("nav a")].some((a) => a.getAttribute("href") === "/your-team")).toBe(false);
  });

  it("is absent in the console skin: no route, no nav link", () => {
    mockApi();
    at("/your-team", SKINS.console);
    expect(screen.getByText(/Not found\./)).toBeTruthy();
    expect(screen.queryByTestId("your-team")).toBeNull();
    cleanup();
    const { container } = render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    expect(container.querySelector('a[href="/your-team"]')).toBeNull();
    expect(screen.queryByText("Your team")).toBeNull();
  });

  it("fits a 412 px phone: one column below sm, cards shrink, long tokens wrap", async () => {
    mockApi();
    const long = "https://www.reddit.com/r/smallbusiness/comments/quarterly_taxes_for_freelancers_who_just_started_this_year";
    vi.spyOn(api, "listRuns").mockResolvedValue([run("run_long", "as_li", { summary: `Read ${long} today.` })]);
    render(
      <MemoryRouter>
        <YourTeamPage now={NOW} />
      </MemoryRouter>,
    );
    const grid = await screen.findByTestId("your-team");
    expect(grid.className).toMatch(/(^| )grid-cols-1( |$)/);
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.className).toContain("min-w-0");
    for (const c of screen.getAllByTestId("team-member")) expect(c.className).toContain("min-w-0");
    expect(screen.getByText(/quarterly_taxes/).className).toContain("[overflow-wrap:anywhere]");
  });

  it("a role with no persona on the team says so", () => {
    const v = memberView(TEAM_ROLES[0], [], [], [], NOW);
    expect(v.persona).toBeUndefined();
  });

  it("plainSummary drops bookkeeping and truncates", () => {
    expect(plainSummary("No ready rows, no workers. 0 new replies, 0 X mentions. Posted reply (94d5da3, A13 FYI).")).toBe("0 new replies, 0 X mentions. Posted reply.");
    expect(plainSummary("Reconciled (b1cdd71): E7-1 row done.")).toBe("");
    expect(plainSummary("word ".repeat(60), 20)).toHaveLength(20);
  });
});
