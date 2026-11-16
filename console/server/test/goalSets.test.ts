import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyGreenHistory, buildScorecards, createWorkFinder, workState, parseScorecardFile, queueStateOf, readSpineInfo, rowTitle, weekStart, type GreenHistory } from "../src/scorecards.js";

/**
 *  (the owner vn_fe52ef4a, vn_fd4f7a7a): every sidebar entry is a goal set, nested; each a table of
 * measurable rows (green, amber, red), its queue, its inbox codes; the rows of its file come first.
 */

const LEDGER = (rows: string[]) => `## Issue Ledger\n\n| ID | Owner | Assignment | Task | Status | Next |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
const SPINES: Record<string, string> = {
  "app:docs/spines/epic-1.md": `# EPIC-901: Launch\nParent spine: none\n\n## Done means\n\n- [x] E901-1 Site is up\n- [ ] E901-2 First customer pays\n\n## Children\n\n- [EPIC-902: Testers](epic-2.md)\n- [Not a child](other.md)\n\n## Waiting on\n\n- [ask E901-A3: decide @the owner] Which price?\n\n${LEDGER([
    "| E901-S1 | worker | run | Build the page: more words | ready | x |",
    "| E901-S2 | worker | run | Fix the login | active (iteration 2) | x |",
    "| E901-S3 | worker | run | Old thing | done | x |",
    "| E901-S4 | worker | run | Wait for keys | blocked on E901-A3 | x |",
  ])}`,
  "app:docs/spines/epic-2.md": `# EPIC-902: Testers\nParent spine: [EPIC-901](epic-1.md)\n\n## Done means\n\n- [ ] E902-1 Five testers\n\n${LEDGER(["| E902-S1 | worker | run | Call for testers | review | x |", "| E902-S2 | worker | run | Reddit post | ready | x |"])}`,
  "app:docs/spines/other.md": `# EPIC-909: Other\nParent spine: [EPIC-905](epic-5.md)\n`,
};
const read = (repo: string, rel: string) => SPINES[`${repo}:${rel}`];

const pursuit = (o: Record<string, unknown> = {}) => ({
  id: "launch",
  name: "Launch",
  greenWhen: "A customer pays.",
  state: "amber" as const,
  greens: 1,
  total: 2,
  lines: [
    { label: "Site answers", state: "green" as const, value: "200" },
    { label: "Testers apply", state: "red" as const, value: "0 of 5" },
  ],
  totems: [],
  motion: "moving" as const,
  lastMove: { at: "2026-11-12T20:00:00Z", repo: "app", subject: "E901-S2 fix" },
  rank: 1,
  parked: false,
  effort: { tier: "Top", wakeFactor: 2, maxWorkers: 10, stallHours: 1, words: "most effort" },
  epics: [{ repo: "app", path: "docs/spines/epic-1.md", milestoneId: "ms_1" }],
  milestones: [{ id: "ms_1", title: "App", via: "own" as const, teams: [{ persona: "Builder", enabled: true, pace: "every 60 min", paceNow: "every 30 min" }] }],
  ...o,
});

describe("goal sets", () => {
  it("reads a spine's rows, asks, Done means and queue", () => {
    const s = readSpineInfo("app", "docs/spines/epic-1.md", SPINES["app:docs/spines/epic-1.md"]);
    expect(s.code).toBe("EPIC-901");
    expect(s.codes).toEqual(expect.arrayContaining(["E901-S1", "E901-S2", "E901-S3", "E901-S4", "E901-A3"]));
    expect(s.queue.map((q) => [q.code, q.state])).toEqual([
      ["E901-S1", "ready"],
      ["E901-S2", "running"],
      ["E901-S4", "waiting"],
    ]);
    expect(s.queue[0].title).toBe("Build the page");
    expect(s.boxes).toEqual([
      { id: "E901-1", text: "Site is up", done: true },
      { id: "E901-2", text: "First customer pays", done: false },
    ]);
  });

  it("nests a child epic only when its Parent spine points back", () => {
    const b = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read);
    const [set] = b.nodes;
    expect(set.kind).toBe("pursuit");
    expect(set.children).toHaveLength(1);
    const epic = set.children[0];
    expect(epic.children.map((c) => c.code)).toEqual(["EPIC-902"]);
    expect(set.spines).toEqual(["app:docs/spines/epic-1.md", "app:docs/spines/epic-2.md"]);
    expect(set.milestoneId).toBe("ms_1");
    expect(set.teams?.[0].persona).toBe("Builder");
  });

  it("makes a table of coloured rows: live lines, flow, epics; the epic its Done means and children", () => {
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read).nodes;
    expect(set.objective).toBe("A customer pays.");
    expect(set.file).toEqual({ path: "docs/scorecards/launch.json", present: false });
    const by = Object.fromEntries(set.rows.map((r) => [r.label, r]));
    expect(by["Site answers"].state).toBe("green");
    expect(by["Testers apply"].state).toBe("red");
    expect(by["Moving, not stale"].state).toBe("green");
    expect(by["Rows being worked on now"]).toMatchObject({ value: "1", state: "green" });
    expect(by["Rows ready, waiting for a worker"]).toMatchObject({ value: "2", state: "amber" });
    expect(by["Rows stuck or waiting on something"]).toMatchObject({ value: "1", state: "amber" });
    expect(by["Launch"]).toMatchObject({ kind: "epic", state: "amber", value: "1 of 2 done" });
    for (const r of set.rows) expect(["green", "amber", "red", "unknown"]).toContain(r.state);
    const epic = set.children[0];
    expect(epic.rows.find((r) => r.kind === "done-means" && r.note === "E901-2")?.state).toBe("amber");
    expect(epic.rows.find((r) => r.kind === "epic")).toMatchObject({ label: "Testers", state: "red" });
  });

  it("puts the file's Objective and key results first; a `line` row reads the live line", () => {
    const file = JSON.stringify({
      objective: "Our first paying customer",
      proposal: "the shape proposal",
      rows: [
        { label: "Paying customers", kind: "key-result", value: "0", target: "1", state: "red" },
        { label: "Testers who applied", kind: "key-result", line: "Testers apply", target: "5" },
        { label: "", kind: "health" },
      ],
    });
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read, { file: () => file }).nodes;
    expect(set.objective).toBe("Our first paying customer");
    expect(set.file).toEqual({ path: "docs/scorecards/launch.json", present: true, proposal: "the shape proposal" });
    expect(set.rows[0]).toMatchObject({ label: "Paying customers", kind: "key-result", state: "red", target: "1" });
    expect(set.rows[1]).toMatchObject({ label: "Testers who applied", state: "red", value: "0 of 5" });
    // the live line it used is not listed twice, and the file's rows replace the other pursuit checks
    expect(set.rows.filter((r) => r.value === "0 of 5")).toHaveLength(1);
    expect(set.rows.find((r) => r.label === "Site answers")).toBeUndefined();
  });

  it("a pursuit with a goal number heads its set with its name alone, never the number glued on", () => {
    const file = JSON.stringify({ objective: "5 testers using the app", objectiveStatus: "agreed", rows: [] });
    const [set] = buildScorecards({ pursuits: [{ ...pursuit({ name: "App: 5 testers" }), goal: { now: 0, target: 5 } }], staleDays: 3 }, read, { file: () => file }).nodes;
    expect(set.headline).toBe("App: 5 testers");
    expect(set.objective).toBe("5 testers using the app");
  });

  it("a broken file is ignored, not fatal", () => {
    expect(parseScorecardFile("{nope")).toBeNull();
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read, { file: () => "{nope" }).nodes;
    expect(set.file?.present).toBe(false);
    expect(set.rows.length).toBeGreaterThan(5);
  });

  it("words: queue states and row titles", () => {
    expect(queueStateOf("ready")).toBe("ready");
    expect(queueStateOf("active (iteration 2)")).toBe("running");
    expect(queueStateOf("blocked on E901-A3")).toBe("waiting");
    expect(queueStateOf("review")).toBeNull();
    expect(queueStateOf("done (approved)")).toBeNull();
    expect(rowTitle("[Link](x.md) words: more")).toBe("Link words");
  });

  it("the proposal's row shape: group, source, target, by, value, colour, and the work linked to the row", () => {
    const file = JSON.stringify({
      rows: [
        { group: "Testers come", label: "Tester applications", source: "the apply form", target: "10", by: "2026-11-17", value: "0", colour: "red", work: ["E901-S1", "EPIC-902", "app:E909-S9"] },
        { group: "Testers come", label: "Waitlist", value: "1", colour: "amber" },
      ],
    });
    const finder = (repo: string, code: string) => ({ code, repo, kind: code === "E901-S1" ? ("ticket" as const) : code === "EPIC-902" ? ("epic" as const) : ("unknown" as const) });
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read, { file: () => file, work: finder }).nodes;
    expect(set.rows[0]).toMatchObject({ group: "Testers come", source: "the apply form", target: "10", by: "2026-11-17", value: "0", state: "red" });
    expect(set.rows[0].work?.map((w) => [w.code, w.kind])).toEqual([
      ["E901-S1", "ticket"],
      ["EPIC-902", "epic"],
      ["E909-S9", "unknown"],
    ]);
    expect(set.rows[1]).toMatchObject({ state: "amber", work: [] });
    // the epic row is worked by its queued rows; a Done-means box by the rows that name it
    expect(set.rows.find((r) => r.kind === "epic")?.work?.map((w) => w.code)).toEqual(["E901-1", "E901-2", "E901-S1", "E901-S2", "E901-S4"]);
  });

  it("the work finder reads a ticket's title and status and an epic's Done means from the repo's spines", () => {
    const files: Record<string, string> = { "docs/spines/epic-1.md": SPINES["app:docs/spines/epic-1.md"], "docs/spines/epic-2.md": SPINES["app:docs/spines/epic-2.md"] };
    const fsRead = (_repo: string, rel: string) => files[rel];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    for (const k of Object.keys(files)) fs.writeFileSync(path.join(dir, k), files[k]);
    const find = createWorkFinder(() => dir, fsRead);
    expect(find("app", "E901-S2")).toMatchObject({ kind: "ticket", title: "Fix the login", status: "active", epicCode: "EPIC-901" });
    expect(find("app", "EPIC-902")).toMatchObject({ kind: "epic", title: "Testers", status: "0 of 1 done" });
    expect(find("app", "E907-S7").kind).toBe("unknown");
  });

  it("counts rows that turned green today and this week; a row first seen green is not counted", () => {
    const body = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read);
    const h: GreenHistory = { since: "2026-11-01T00:00:00Z", rows: {} };
    const t0 = Date.parse("2026-11-10T09:00:00Z"); // a Tuesday
    const first = applyGreenHistory(structuredClone(body), h, t0);
    expect(first.progress).toMatchObject({ today: 0, week: 0 });
    // "Testers apply" turns green on Thursday
    const b2 = structuredClone(body);
    b2.nodes[0].rows.find((r) => r.label === "Testers apply")!.state = "green";
    const thu = Date.parse("2026-11-12T15:00:00Z");
    const second = applyGreenHistory(b2, h, thu);
    expect(second.progress).toMatchObject({ today: 1, week: 1, sets: { launch: { today: 1, week: 1 } } });
    expect(second.nodes[0].rows.find((r) => r.label === "Testers apply")?.greenSince).toBe(new Date(thu).toISOString());
    // next day: still counted this week, not today
    const third = applyGreenHistory(structuredClone(b2), h, Date.parse("2026-11-13T08:00:00Z"));
    expect(third.progress).toMatchObject({ today: 0, week: 1 });
    // next Monday: a new week
    expect(weekStart(Date.parse("2026-11-16T08:00:00Z"))).toBe(Date.parse("2026-11-16T00:00:00Z"));
    expect(applyGreenHistory(structuredClone(b2), h, Date.parse("2026-11-16T08:00:00Z")).progress.week).toBe(0);
  });

  it("a set's file gives its objective sentence, proposed until agreed, under the pursuit's name; an epic's objective is its Goal sentence", () => {
    const file = JSON.stringify({ objective: "First customer pays", objectiveStatus: "proposed", objectiveWas: "A long line that reads like a problem.", rows: [] });
    const withGoal = (repo: string, rel: string) => (rel === "docs/spines/epic-1.md" ? SPINES["app:docs/spines/epic-1.md"].replace("Parent spine: none", "Parent spine: none\nGoal sentence: Customers pay for the product.") : read(repo, rel));
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, withGoal, { file: () => file }).nodes;
    expect(set).toMatchObject({ headline: "Launch", objectiveStatus: "proposed", objectiveWas: "A long line that reads like a problem.", objective: "First customer pays" });
    // no file rows: the pursuit's checks stand in
    expect(set.rows.find((r) => r.label === "Site answers")).toBeTruthy();
    expect(set.children[0].objective).toBe("Customers pay for the product.");
    const [plain] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read).nodes;
    // with no file the pursuit's name still heads it, the green-when line is its objective
    expect(plain).toMatchObject({ headline: "Launch", objective: "A customer pays." });
  });

  it("each thing under a key result has a colour; an epic row lists its Done-means items and its rows", () => {
    expect(workState("ticket", "done")).toBe("green");
    expect(workState("ticket", "review")).toBe("green");
    expect(workState("ticket", "active")).toBe("amber");
    expect(workState("ticket", "ready")).toBe("amber");
    expect(workState("ticket", "blocked")).toBe("red");
    expect(workState("epic", "0 of 3 done")).toBe("red");
    expect(workState("epic", "3 of 3 done")).toBe("green");
    expect(workState("unknown", "x")).toBe("unknown");
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, read).nodes;
    const epicRow = set.rows.find((r) => r.kind === "epic")!;
    expect(epicRow.work?.map((w) => [w.code, w.kind, w.state])).toEqual([
      ["E901-1", "done-means", "green"],
      ["E901-2", "done-means", "amber"],
      ["E901-S1", "ticket", "amber"],
      ["E901-S2", "ticket", "amber"],
      ["E901-S4", "ticket", "red"],
    ]);
  });

  it("the work finder finds a Done-means item by its id", () => {
    const files: Record<string, string> = { "docs/spines/epic-1.md": SPINES["app:docs/spines/epic-1.md"] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/spines/epic-1.md"), files["docs/spines/epic-1.md"]);
    const find = createWorkFinder(() => dir, (_r, rel) => files[rel]);
    expect(find("app", "E901-2")).toMatchObject({ kind: "done-means", title: "First customer pays", status: "open", state: "amber", epicCode: "EPIC-901" });
    expect(find("app", "E901-S4")).toMatchObject({ kind: "ticket", state: "red" });
  });

  it("the objectives mock-up: the file's key results (Done-means id, value, note, colour, work), the sidebar's child epics in short words, the spine named, a set folded into another", () => {
    const file = JSON.stringify({
      objective: "Customers pay",
      objectiveStatus: "agreed",
      spine: "app EPIC-901",
      keyResults: [
        { label: "Site is up", doneMeans: "E901-2", value: "not yet", colour: "red", work: ["E901-S1"] },
        { label: "Testers apply", doneMeans: "check", value: "0 of 5", note: "by 17 Nov", colour: "red", work: ["E901-A3"] },
        { label: "Feedback", value: "no data yet" },
      ],
      sidebar: [{ epic: "EPIC-902", name: "Testers come" }, { epic: "EPIC-999", name: "Not in the tree" }],
      foldedInto: "other",
    });
    const files: Record<string, string> = { "docs/spines/epic-1.md": SPINES["app:docs/spines/epic-1.md"].replace("- [ ] E901-2", "- [x] E901-2"), "docs/spines/epic-2.md": SPINES["app:docs/spines/epic-2.md"] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-"));
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
    const fsRead = (_repo: string, rel: string) => files[rel];
    const work = createWorkFinder(() => dir, fsRead);
    const [set] = buildScorecards({ pursuits: [pursuit()], staleDays: 3 }, fsRead, { file: () => file, work }).nodes;
    expect(set.headline).toBe("Launch");
    expect(set.objective).toBe("Customers pay");
    expect(set.objectiveStatus).toBe("agreed");
    expect(set.spineRef).toEqual({ repo: "app", code: "EPIC-901" });
    expect(set.foldedInto).toBe("other");
    // a key result whose Done-means box is ticked in its spine shows green, done
    expect(set.keyResults!.map((k) => [k.label, k.state, k.value, k.note ?? "", k.doneMeans ?? ""])).toEqual([
      ["Site is up", "green", "done", "", "E901-2"],
      ["Testers apply", "red", "0 of 5", "by 17 Nov", "check"],
      ["Feedback", "unknown", "no data yet", "", ""],
    ]);
    expect(set.keyResults![0].work!.map((w) => [w.code, w.kind, w.state])).toEqual([["E901-S1", "ticket", "amber"]]);
    // an ask under a key result is work waiting on an answer, red
    expect(set.keyResults![1].work!.map((w) => [w.code, w.status, w.state])).toEqual([["E901-A3", "waiting on an answer", "red"]]);
    expect(set.sidebar).toEqual([{ id: "launch~app:docs/spines/epic-2.md", name: "Testers come", greens: 0, total: 1 }]);
    // an epic names its own spine
    expect(set.children[0].spineRef).toEqual({ repo: "app", code: "EPIC-901" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
