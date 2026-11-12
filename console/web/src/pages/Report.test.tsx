// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Persona, type Run } from "@/api";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import type { SocialPost } from "@/api/types";
import { buildWeeklyReport, emptySocialExport, postsOf, reportFrom, sampleSocialExport, sampleSocialData } from "@/lib/social";
import { ReportPage } from "@/pages/Report";
import { landsAt } from "@/test/landsAt";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Wed 2026-10-28 12:00 UTC: "this week" is the 7 days from Wed 2026-10-21 12:00 UTC.
const NOW = new Date("2026-10-28T12:00:00Z");

const persona = (id: string, name: string): Persona => ({ id, name, remit: "", skills: [], model: "m", mayWrite: true, createdAt: "2026-10-01T00:00:00Z" }) as Persona;
const PERSONAS = [persona("pe_l", "Listener"), persona("pe_a", "Author"), persona("pe_r", "Responder")];
let n = 0;
const run = (personaId: string, startedAt: string, outcome: Run["outcome"], summary = ""): Run => ({ id: `run_${++n}`, assignmentId: "as_1", personaId, startedAt, outcome, summary });
const RUNS: Run[] = [
  run("pe_l", "2026-10-26T08:00:00Z", "progressed", "Heard: 3 threads on agent memory in r/LocalLLaMA"),
  run("pe_l", "2026-10-27T08:00:00Z", "monitoring", "Heard: @someone asks for a plain-files memory"),
  run("pe_a", "2026-10-27T10:00:00Z", "progressed", "Drafted the LinkedIn post"),
  run("pe_r", "2026-10-28T09:00:00Z", "blocked", "DM held: laptop offline"),
  run("pe_a", "2026-10-21T11:00:00Z", "progressed", "Older than 7 days, not counted"),
];

// posts in the pack export's shape (GET /api/tenants/:id/social): kind when the row has one, else platform words.
let line = 5;
const row = (p: Partial<SocialPost>): SocialPost => ({
  id: null, date: null, persona: null, kind: null, platform: null, community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
  highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null, _line: line++, ...p,
});
const EXPORT = emptySocialExport("/r/social");
EXPORT.posts = [
  row({ date: "2026-10-20", persona: "Author", platform: "X (thread)", title: "Last week", status: "posted", replies: 9 }),
  row({ id: "P-1", date: "2026-10-26", persona: "Writer", kind: "post", platform: "X", title: "Memory as files", status: "measured", replies: 2 }),
  row({ date: "2026-10-27", persona: "Responder", platform: "Reddit (reply, r/x)", title: "Reply to a tester", status: "posted", replies: 1 }),
  row({ id: "P-3", date: "2026-10-27", persona: "Responder", kind: "reply", platform: "Reddit", title: "DM answer", status: "held", replies: 0 }),
  row({ id: "P-4", date: "2026-10-28", persona: "Writer", kind: "post", platform: "LinkedIn", title: "Plain files", status: "scheduled", replies: 0 }),
  row({ id: "P-5", date: "2026-10-28", persona: "Engager", kind: "outreach", platform: "X", title: "Cold reply", status: "draft", replies: null }),
];

describe("T24-S6 weekly report: sections from fixture data", () => {
  it("reads typed posts from the export", () => {
    const rows = postsOf(EXPORT);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toMatchObject({ id: "P-1", date: "2026-10-26", persona: "Writer", platform: "X", title: "Memory as files", status: "measured", replies: 2 });
    expect(rows[5]).toMatchObject({ statusText: "draft", status: "draft", replies: 0 });
  });

  it("this week is the last 7 days (rolling), so Monday morning still shows last week's work", () => {
    expect(reportFrom(NOW).toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(reportFrom(new Date("2026-10-26T00:20:00Z")).toISOString()).toBe("2026-10-19T00:20:00.000Z");
  });

  it("counts this week's posts, replies, runs and listening highlights only", () => {
    const r = buildWeeklyReport({ runs: RUNS, personas: PERSONAS, posts: postsOf(EXPORT), now: NOW });
    expect(r.posts).toEqual({ drafted: 5, scheduled: 3, published: 1, repliesSent: 1, repliesReceived: 3, waiting: 2 });
    expect(r.runs.total).toBe(4);
    expect(r.runs.byOutcome).toEqual({ progressed: 2, monitoring: 1, blocked: 1 });
    expect(r.runs.byPersona.map((p) => [p.name, p.runs, p.progressed])).toEqual([
      ["Listener", 2, 1],
      ["Author", 1, 1],
      ["Responder", 1, 0],
    ]);
    expect(r.listening.map((x) => x.summary)).toEqual(["Heard: @someone asks for a plain-files memory", "Heard: 3 threads on agent memory in r/LocalLLaMA"]);
  });

  it("the sample export always falls in the current week", () => {
    const rows = postsOf(sampleSocialExport(NOW));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.date >= "2026-10-21" && p.date <= "2026-10-28")).toBe(true);
  });

  it("renders every section from read routes; posts and credits carry their markers", async () => {
    vi.spyOn(api, "listRuns").mockResolvedValue(RUNS);
    vi.spyOn(api, "listPersonas").mockResolvedValue(PERSONAS);
    vi.spyOn(api, "getSocial").mockResolvedValue(sampleSocialData("acme", NOW));
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <ReportPage now={NOW} />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect(await screen.findByTestId("runs-total")).toHaveProperty("textContent", "4");
    expect(screen.getByText("Runs this week")).toBeTruthy(); // the console word
    expect(screen.getAllByTestId("report-persona")).toHaveLength(3);
    expect(screen.getAllByTestId("listening-item")).toHaveLength(2);
    expect((await within(screen.getByTestId("report-posts")).findByTestId("posts-sample")).textContent).toBe("sample");
    expect(screen.getByText("Published")).toBeTruthy();
    const credits = screen.getByTestId("credits");
    expect(within(credits).getByTestId("credits-mock").textContent).toBe("placeholder");
    expect(within(credits).getByText(/Placeholder value, not your real balance/)).toBeTruthy();
    expect(within(credits).getByTestId("credits-balance").textContent).toBe("2,750");
  });
});

const at = (path: string, skin: Skin) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T24-S6 report is a social-skin screen", () => {
  it("social skin: leads to the campaign's History tab, no nav link (T58-S3: History → Digests)", async () => {
    expect(await landsAt("/report")).toBe("/milestones/m1?tab=history");
    expect(screen.queryByRole("link", { name: "Weekly report" })).toBeNull();
  });

  it("console skin (acme): no nav link, no route, no credits", () => {
    at("/report", SKINS.console);
    expect(screen.queryByRole("link", { name: "Weekly report" })).toBeNull();
    expect(screen.getByText(/Not found\./)).toBeTruthy();
    expect(screen.queryByTestId("credits-mock")).toBeNull();
    cleanup();
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Weekly report" })).toBeNull();
  });
});
