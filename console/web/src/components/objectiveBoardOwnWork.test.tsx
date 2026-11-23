// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import type { TotemMaps } from "@/api/totem-types";
import { GoalSetPage, objectiveTab } from "@/components/goalSets";
import { SCORECARD_PATH, boardOf, namesLaunchBoard } from "@/lib/scorecards";

// the owner: "the Board fix for every goal". The Board showed a product's whole launch board with its sign-in lights
// on every objective of that product and on objectives of no product, and ?tab=board fell back to Key results. On
// every objective the Board shows only its own epics and tickets; a launch board only where the objective names it.

const obj = (id: string, name: string, rank: number, spines: string[], keyResults: ScorecardNode["keyResults"] = []): ScorecardNode => ({
  id, kind: "pursuit", name, rank, greens: 0, total: 1, spines, keyResults,
  rows: [{ label: "Something counted", state: "red", value: "0", kind: "check" }],
  children: [],
});
const BODY: ScorecardsBody = {
  nodes: [
    obj("social-channels", "Social: Get every channel working", 1, ["team:docs/e29.md"], [
      { label: "Every channel posts", state: "red", value: "0", kind: "key-result", work: [
        // a ticket of another epic placed under this key result, and one already done
        { code: "E907-S3", repo: "team", title: "Placed here from the team epic", status: "running", kind: "ticket", epicCode: "EPIC-909" },
        { code: "E907-S4", repo: "team", title: "Finished long ago", status: "done", kind: "ticket" },
      ] },
    ]),
    obj("social-multi", "Social: Get multi-tenant working", 2, ["team:docs/e21.md"]),
    obj("house", "House: Buy a house", 3, ["house:EPIC.md"]),
  ],
  spineInfo: {
    "team:docs/e29.md": { repo: "team", path: "docs/e29.md", code: "EPIC-907", title: "Channels", doneMeans: { done: 0, total: 1 }, codes: ["E907-S1"], queue: [{ code: "E907-S1", title: "Post on TikTok", state: "ready", status: "ready" }] },
    "team:docs/e21.md": { repo: "team", path: "docs/e21.md", code: "EPIC-908", title: "Multi-tenant", doneMeans: { done: 0, total: 1 }, codes: ["E907-S2"], queue: [{ code: "E907-S2", title: "Move logins over", state: "waiting", status: "blocked" }] },
    "house:EPIC.md": { repo: "house", path: "EPIC.md", code: "EPIC-910", title: "House", doneMeans: { done: 0, total: 1 }, codes: ["E907-S5"], queue: [{ code: "E907-S5", title: "Visit the flat", state: "ready", status: "ready" }] },
  },
};
// the product's map lists both social objectives; the house names no product but its pursuit says Social.
const MAPS: TotemMaps = {
  statement: "",
  every: { totems: [], grows: [] },
  products: [
    { product: "social", name: "Social", repos: [], objectives: ["social-channels", "social-multi"], grows: [], totems: [
      { id: "launch-board", name: "Launch board", shape: "table", tab: "launch", lives: {} },
    ] },
  ],
};
const PURSUITS = [
  { id: "social-channels", name: "Social: Get every channel working", product: { id: "social", name: "Social" }, totems: [{ label: "Launch board", url: "/launch" }] },
  { id: "social-multi", name: "Social: Get multi-tenant working", product: { id: "social", name: "Social" }, totems: [{ label: "Epic deck", url: "/deck/team/x" }] },
  { id: "house", name: "House: Buy a house", product: { id: "social", name: "Social" }, totems: [] },
];

beforeEach(() => {
  vi.spyOn(api, "listScorecards").mockResolvedValue(BODY);
  vi.spyOn(api, "listStatus").mockResolvedValue({ milestones: [], items: [], needsYou: 0, at: "2026-11-23T12:00:00Z" } as never);
  vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: PURSUITS } as never);
  vi.spyOn(api, "listReviewItems").mockResolvedValue([] as never);
  vi.spyOn(api, "getTotems").mockResolvedValue(MAPS);
  vi.spyOn(api, "getTotem").mockImplementation(async (product: string, id: string) => ({ product, id, name: "Launch board", shape: "table", where: "lights", empty: false, headers: ["Light", "State", "What turns it green"], rows: [["X signed in", "red", "sign in"]] }) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
      </Routes>
    </MemoryRouter>,
  );
const cards = () => screen.getAllByTestId("kanban-card").map((c) => c.dataset.row);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the Board shows only the objective's own work", () => {
  it("?tab=board opens the Board by its name, like ?tab=tree and ?tab=kanban", () => {
    expect(objectiveTab("board")).toBe("kanban");
    expect(objectiveTab("tree")).toBe("kanban");
    expect(objectiveTab("kanban")).toBe("kanban");
  });

  it("?tab=board opens the Board, not Key results", async () => {
    open("/sets/social-multi?tab=board");
    expect(await screen.findByTestId("set-kanban")).toBeTruthy();
    expect(screen.getByTestId("set-tab-kanban").getAttribute("aria-current")).toBe("page");
  });

  it("the objective that names its launch board shows it, with its own epic's rows and the tickets placed under its key results", async () => {
    open("/sets/social-channels?tab=kanban");
    const homed = await screen.findAllByTestId("homed-totem");
    expect(homed.map((h) => h.dataset.tab)).toEqual(["launch"]);
    expect(cards()).toEqual(["E907-S1", "E907-S3"]);
    expect(within(screen.getByTestId("kanban-running")).getByText("Placed here from the team epic")).toBeTruthy();
  });

  it("another objective of the same product shows no launch board, only its own rows", async () => {
    open("/sets/social-multi?tab=kanban");
    await screen.findByTestId("set-kanban");
    await settle();
    await settle();
    expect(screen.queryAllByTestId("homed-totem")).toHaveLength(0);
    expect(screen.queryAllByTestId("totem-tab")).toHaveLength(0);
    expect(cards()).toEqual(["E907-S2"]);
  });

  it("an objective outside the products shows its own board, never a product's launch board as a fallback", async () => {
    open("/sets/house?tab=board");
    await screen.findByTestId("set-kanban");
    await settle();
    await settle();
    expect(screen.queryAllByTestId("homed-totem")).toHaveLength(0);
    expect(cards()).toEqual(["E907-S5"]);
  });

  it("boardOf: own epics' rows, then placed tickets once each, nothing done, nothing of another objective", () => {
    const [channels, multi, house] = BODY.nodes;
    expect(boardOf(BODY, channels).map((r) => [r.code, r.state])).toEqual([["E907-S1", "ready"], ["E907-S3", "running"]]);
    expect(boardOf(BODY, multi).map((r) => r.code)).toEqual(["E907-S2"]);
    expect(boardOf(BODY, house).map((r) => r.code)).toEqual(["E907-S5"]);
    // a placed ticket that is also one of its own rows shows once
    const twice = { ...channels, keyResults: [{ label: "k", state: "red" as const, value: "0", kind: "key-result" as const, work: [{ code: "E907-S1", repo: "team", status: "ready", kind: "ticket" as const }] }] };
    expect(boardOf(BODY, twice).map((r) => r.code)).toEqual(["E907-S1"]);
  });

  it("namesLaunchBoard reads only the objective's own totems", () => {
    expect(namesLaunchBoard([{ label: "Launch board", url: "/launch" }])).toBe(true);
    expect(namesLaunchBoard([{ label: "Lights", url: "/launch" }])).toBe(true);
    expect(namesLaunchBoard([{ label: "Epic deck", url: "/deck/x" }])).toBe(false);
    expect(namesLaunchBoard([])).toBe(false);
    expect(namesLaunchBoard(undefined)).toBe(false);
  });
});
