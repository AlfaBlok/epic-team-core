import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpineNode, SpinesJson } from "../src/adapters/spines.js";
import { epicRefs, parseBigRocks, rocksFor } from "../src/deck/bigRocks.js";
import { materialChange, weeklyActivity, type DeckMaterial, type EpicDeck } from "../src/deck/build.js";
import { appendLines, createDeckNotify, deckCards, linesToAdd, parseDeckUpdates, trendOf, DECK_UPDATES_FILE } from "../src/deck/notify.js";
import { openDb, type DB } from "../src/db.js";
import type { SpineWriter, EditInput } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";

/** the big rocks board, the epic deck per high-level epic, and its one card per day. */

const ROCKS = `# Big rocks: the heavy themes in Sam's voice notes

Goal sentence: We want Sam's heaviest themes on one board.
Window: 2026-09-01 to 2026-11-07
Read: 49 voice notes on 25 days (17 personal notes skipped)
Last read: 2026-11-07
Method: Read every note.
Note: Mostly four weeks.

## R1 · Get real users now
We want: We want real testers this week.
Weight: heavy
Frequency: 6 notes on 5 days, first 2026-10-13, last 2026-11-07
Epics: EPIC-922, memo/EPIC-900
Why it weighs: He asks again and again.
Evidence:
- 2026-11-07 [Log/2026-11-07.md#^e-5fc46c](https://github.com/Acme/obsidian-brain/blob/main/Log/2026-11-07.md#%5Ee-5fc46c): "It's time to get testers."
- 2026-10-13 [Log/2026-10-13.md#^e-6bf319](https://example.com/x): "I think I should launch."

## R2 · A goal tree he trusts
We want: We want a tree he trusts.
Weight: medium
Frequency: 3 notes on 2 days, first 2026-10-27, last 2026-11-07
Epics: EPIC-941
Why it weighs: It keeps coming back.
Evidence:
- 2026-11-07 [Log/2026-11-07.md#^e-1](https://example.com/y): "a tree"

## R3 · Unmapped
We want: Something.
Weight: medium
Frequency: 3 notes on 3 days, first 2026-10-01, last 2026-10-03
Epics: no epic yet
Evidence:
`;

describe("E975-S2 the big rocks board", () => {
  it("parses the header, each rock's fields, evidence and epic refs", () => {
    const b = parseBigRocks(ROCKS);
    expect(b).toMatchObject({ goal: "We want Sam's heaviest themes on one board.", window: "2026-09-01 to 2026-11-07", lastRead: "2026-11-07", note: "Mostly four weeks." });
    expect(b.rocks.map((r) => [r.id, r.name, r.weight, r.frequency.notes, r.frequency.days])).toEqual([
      ["R1", "Get real users now", "heavy", 6, 5],
      ["R2", "A goal tree he trusts", "medium", 3, 2],
      ["R3", "Unmapped", "medium", 3, 3],
    ]);
    expect(b.rocks[0].want).toBe("We want real testers this week.");
    expect(b.rocks[0].epics).toEqual(["home_repo/EPIC-922", "memo/EPIC-900"]);
    expect(b.rocks[0].evidence[0]).toEqual({ date: "2026-11-07", ref: "Log/2026-11-07.md#^e-5fc46c", url: "https://github.com/Acme/obsidian-brain/blob/main/Log/2026-11-07.md#%5Ee-5fc46c", quote: "It's time to get testers." });
    expect(b.rocks[2].epics).toEqual([]);
    expect(epicRefs("M6, EPIC-936; other/EPIC-902")).toEqual(["home_repo/M6", "home_repo/EPIC-936", "other/EPIC-902"]);
  });
  it("a deck serves the rocks that name any epic of its subtree, in its own repo only", () => {
    const rocks = parseBigRocks(ROCKS).rocks;
    expect(rocksFor(rocks, "home_repo", ["EPIC-940", "EPIC-941"]).map((r) => r.id)).toEqual(["R2"]);
    expect(rocksFor(rocks, "memo", ["EPIC-900"]).map((r) => r.id)).toEqual(["R1"]);
    expect(rocksFor(rocks, "home_repo", ["EPIC-900"])).toEqual([]);
  });
});

const mat = (over: Partial<DeckMaterial> = {}): DeckMaterial => ({ state: "moving", status: "active", goals: ["E1:0", "E2:0"], outcome: false, asks: [], epics: ["EPIC-941:moving"], rocks: [], ...over });

describe("E975-S1 what changed, in plain words", () => {
  it("names met goals, new asks, a state change, finished and new epics, new rocks", () => {
    const was = mat();
    expect(materialChange(was, mat({ goals: ["E1:1", "E2:0"] }))).toEqual(["A goal is met: E1."]);
    expect(materialChange(was, mat({ asks: ["E940-A1"], state: "stuck" }))).toEqual(["It is waiting on someone now.", "A new question waits on you: E940-A1."]);
    expect(materialChange(was, mat({ epics: ["EPIC-941:done", "EPIC-942:moving"], rocks: ["R2"] }))).toEqual([
      "One epic under it finished: EPIC-941.",
      "A new epic under it: EPIC-942.",
      "It now serves a big rock: R2.",
    ]);
    expect(materialChange(undefined, was)).toEqual(["The deck changed."]);
    expect(materialChange(was, mat({ status: "review" }))).toEqual(["Its plan changed."]);
  });
  it("counts changes per week, oldest first", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const w = weeklyActivity(["2026-11-06", "2026-11-05", "2026-10-30", "2026-01-01"], now, 3);
    expect(w.map((x) => x.n)).toEqual([0, 1, 2]);
  });
});

const deck = (code: string, fp: string, material = mat()): EpicDeck =>
  ({ ref: { repo: "home_repo", code }, fingerprint: fp, material, measure: { goalsMet: 1, goalsTotal: 2, epics: { moving: 2, stuck: 0, parked: 0, done: 1 } } }) as unknown as EpicDeck;

describe("E975-S1 one card per deck per day", () => {
  const FILE = `# Epic deck updates\n\n## Log\n\n- 2026-11-05 · home_repo/EPIC-940 · fp aaa · goals 0/2 · epics 0/3 · First look at this deck. · baseline\n- 2026-11-06 · home_repo/EPIC-940 · fp bbb · goals 1/2 · epics 1/3 · A goal is met: E1.\n- 2026-11-06 · home_repo/EPIC-922 · fp ccc · goals 0/1 · epics 0/0 · Its plan changed. · seen 2026-11-06\n`;
  it("parses lines; the cards are each deck's newest line, not a baseline, not seen, not older than 14 days", () => {
    const lines = parseDeckUpdates(FILE);
    expect(lines.map((l) => [l.ref.code, l.fp, l.baseline, l.seen ?? null])).toEqual([
      ["EPIC-940", "aaa", true, null],
      ["EPIC-940", "bbb", false, null],
      ["EPIC-922", "ccc", false, "2026-11-06"],
    ]);
    expect(deckCards(lines, "2026-11-07").map((l) => [l.ref.code, l.text])).toEqual([["EPIC-940", "A goal is met: E1."]]);
    expect(deckCards(lines, "2026-11-30")).toEqual([]);
    expect(trendOf(lines, { repo: "home_repo", code: "epic-940" })).toEqual([
      { date: "2026-11-05", goalsMet: 0, goalsTotal: 2, epicsDone: 0, epicsTotal: 3 },
      { date: "2026-11-06", goalsMet: 1, goalsTotal: 2, epicsDone: 1, epicsTotal: 3 },
    ]);
  });
  it("adds a baseline for a new deck, a change line for a moved one, and holds a second change on the same day", () => {
    const lines = parseDeckUpdates(FILE);
    const add = linesToAdd([deck("EPIC-940", "ddd", mat({ goals: ["E1:1", "E2:1"] })), deck("EPIC-936", "eee"), deck("EPIC-922", "ccc")], lines, "2026-11-07", () => mat({ goals: ["E1:1", "E2:0"] }));
    expect(add.map((a) => a.line)).toEqual([
      "- 2026-11-07 · home_repo/EPIC-940 · fp ddd · goals 1/2 · epics 1/3 · A goal is met: E2.",
      "- 2026-11-07 · home_repo/EPIC-936 · fp eee · goals 1/2 · epics 1/3 · First look at this deck. · baseline",
    ]);
    expect(linesToAdd([deck("EPIC-940", "zzz")], parseDeckUpdates(FILE), "2026-11-06", () => undefined)).toEqual([]);
    expect(appendLines("# x\n", ["- a"])).toBe("# x\n\n## Log\n\n- a\n");
    expect(appendLines(FILE, ["- a"]).endsWith("seen 2026-11-06\n- a\n")).toBe(true);
  });
  it("a tick writes every new line in one commit through the spine writer and remembers each deck's material", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e75s1n-"));
    fs.mkdirSync(path.join(dir, "docs/status"), { recursive: true });
    fs.writeFileSync(path.join(dir, DECK_UPDATES_FILE), FILE);
    const db = openDb(path.join(dir, "c.db"));
    const edits: string[] = [];
    const writer = {
      async edit(o: EditInput) {
        const p = path.join(o.repoDir, o.path);
        const r = o.edit(fs.readFileSync(p, "utf8"), "2026-11-07");
        if ("skip" in r) return { status: "skipped" as const, reason: r.skip };
        fs.writeFileSync(p, r.text);
        edits.push(r.msg);
        return { status: "written" as const, sha: "abc1234" };
      },
    } as unknown as SpineWriter;
    let decks = [deck("EPIC-940", "ddd"), deck("EPIC-936", "eee")];
    const n = createDeckNotify({ db, repoDir: () => dir, writer, decks: async () => decks, now: () => Date.parse("2026-11-07T10:00:00Z"), log: () => {} });
    expect(await n.tick()).toEqual({ added: 2, status: "written abc1234" });
    expect(edits).toEqual(["1 epic deck changed (console)"]);
    expect(await n.tick()).toEqual({ added: 0, status: "unchanged" });
    decks = [deck("EPIC-940", "fff")];
    expect((await n.tick()).added).toBe(0); // same day: waits for tomorrow
    expect(n.cards().map((c) => c.ref.code)).toEqual(["EPIC-940"]);
    // Seen writes `· seen <date>` on the card's line; the card goes
    expect((await n.seen({ repo: "home_repo", code: "EPIC-940" }, "2026-11-07")).status).toBe("written");
    expect(n.cards()).toEqual([]);
    expect(fs.readFileSync(path.join(dir, DECK_UPDATES_FILE), "utf8")).toMatch(/home_repo\/EPIC-940 · fp ddd .* · seen 2026-11-07$/m);
    expect((await n.seen({ repo: "home_repo", code: "EPIC-940" }, "2026-11-07")).status).toBe("skipped");
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({ id: over.path, parent: null, status: "active", rollup_status: "active", dod: [], children: [], ...over });
const ROOT = "docs/spines/root.md";
const spines: SpinesJson = {
  root: ROOT,
  orphans: [],
  mismatches: [],
  nodes: [
    node({ path: ROOT, title: "home_repo", goal: "Run a small team.", current_state: { status: "active", next_action: "go" } as never, done_means: [{ id: "DOD-1", text: "One", done: true }] }),
    node({
      path: "docs/spines/epic-940.md",
      title: "EPIC-940: Lanes and radar",
      parent: ROOT,
      goal: "We want Sam to see his lanes.",
      serves: "Sam sees what moves.",
      current_state: { status: "active", next_action: "build lanes" } as never,
      done_means: [
        { id: "E40-1", text: "Lanes on the home", done: true },
        { id: "E40-2", text: "Radar", done: false },
      ],
    }),
    node({ path: "docs/spines/epic-941.md", title: "EPIC-941: Sub of 40", parent: "docs/spines/epic-940.md", current_state: { status: "active" } as never, ...({ waiting_on: [{ code: "E941-A1", who: "Sam", question: "Pick a name", state: "open" }] } as object) }),
    node({ path: "docs/spines/epic-922.md", title: "EPIC-922: Two worlds", parent: ROOT, current_state: { status: "active" } as never }),
    node({ path: "docs/spines/epic-916.md", title: "EPIC-916: Clean trees", parent: ROOT, status: "done" }),
  ],
};

describe("E975-S1 GET /api/deck/:repo/:code, /api/decks, /api/rocks, /api/deck-cards", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e75s1-"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/spines"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/status"), { recursive: true });
    for (const n of spines.nodes) fs.writeFileSync(path.join(root, "home_repo", n.path), `# ${n.title}\n\n## Current State\n\nStatus: ${n.status}\n`);
    fs.writeFileSync(path.join(root, "home_repo/docs/big-rocks.md"), ROCKS);
    fs.writeFileSync(
      path.join(root, "home_repo", DECK_UPDATES_FILE),
      `# Epic deck updates\n\n## Log\n\n- ${new Date().toISOString().slice(0, 10)} · home_repo/EPIC-940 · fp abc · goals 1/2 · epics 0/1 · A goal is met: E40-1.\n`,
    );
    resetRepoScans(0);
  });
  afterEach(() => {
    resetRepoScans();
    db?.close();
    db = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = () => {
    db = openDb(path.join(root, "c.db"));
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => spines };
    return createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" }, book: { git: async () => "" } });
  };

  it("answers one epic's deck at its stable URL: rocks first, goal and why, goals, plan, waits on Sam, trend", async () => {
    const a = app();
    const m = createStore(db!).createMilestone({ title: "Lanes", repo: "Acme/home_repo", path: "docs/spines/epic-940.md", owner: "", paused: false });
    const res = await a.request("/api/deck/home_repo/EPIC-940");
    expect(res.status).toBe(200);
    const { deck: d } = (await res.json()) as { deck: EpicDeck };
    expect(d).toMatchObject({ ref: { repo: "home_repo", code: "EPIC-940" }, href: "/deck/home_repo/EPIC-940", title: "Lanes and radar", milestoneId: m.id, goal: "We want Sam to see his lanes.", serves: "Sam sees what moves." });
    expect(d.rocks.map((r) => r.id)).toEqual(["R2"]);
    expect(d.goals.map((g) => [g.id, g.done])).toEqual([["E40-1", true], ["E40-2", false]]);
    expect(d.plan.map((n) => n.code)).toEqual(["EPIC-940", "EPIC-941"]);
    expect(d.waits).toEqual([{ code: "E941-A1", who: "Sam", question: "Pick a name", epic: "EPIC-941" }]);
    expect(d.measure).toMatchObject({ goalsMet: 1, goalsTotal: 2, asksOnJordi: 1 });
    expect(d.measure.trend).toHaveLength(1);
    expect(d.material).toMatchObject({ goals: ["E40-1:1", "E40-2:0"], asks: ["E941-A1"], rocks: ["R2"] });
    expect(d.fingerprint).toMatch(/^[0-9a-f]{10}$/);
    // the code is case-free; the root spine answers as `root`; an unknown epic is a 404
    expect((await a.request("/api/deck/home_repo/epic-940")).status).toBe(200);
    expect(((await (await a.request("/api/deck/home_repo/root")).json()) as { deck: EpicDeck }).deck.rocks.map((r) => r.id)).toEqual(["R1", "R2"]);
    expect((await a.request("/api/deck/home_repo/EPIC-999")).status).toBe(404);
  });

  it("lists Sam's focus milestones, then the open lanes of home_repo's root; the board names each rock's decks; the cards", async () => {
    const a = app();
    const s = createStore(db!);
    const m = s.createMilestone({ title: "Lanes", repo: "Acme/home_repo", path: "docs/spines/epic-940.md", owner: "", paused: false });
    db!.prepare("UPDATE milestones SET big_root = 1 WHERE id = ?").run(m.id);
    const v = (await (await a.request("/api/decks")).json()) as { decks: { ref: { code: string }; kind: string; rocks: string[] }[]; cards: { ref: { code: string }; text: string }[] };
    expect(v.decks.map((d) => [d.ref.code, d.kind, d.rocks])).toEqual([
      ["EPIC-940", "big", ["R2"]],
      ["EPIC-922", "lane", ["R1"]],
    ]);
    expect(v.cards.map((c) => [c.ref.code, c.text])).toEqual([["EPIC-940", "A goal is met: E40-1."]]);
    const r = (await (await a.request("/api/rocks")).json()) as { rocks: { rocks: { id: string; decks: { href: string }[] }[] } };
    expect(r.rocks.rocks.map((x) => [x.id, x.decks.map((d) => d.href)])).toEqual([
      ["R1", ["/deck/home_repo/EPIC-922"]],
      ["R2", ["/deck/home_repo/EPIC-940"]],
      ["R3", []],
    ]);
    expect((await a.request("/api/deck-cards/seen", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
  it("E975-S3: /api/deck-of/<milestone or repo> answers the deck of its spine, so an old /book/<key> link opens the deck", async () => {
    const a = app();
    const s = createStore(db!);
    const m = s.createMilestone({ title: "Lanes", repo: "Acme/home_repo", path: "docs/spines/epic-940.md", owner: "", paused: false });
    s.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    expect(await (await a.request(`/api/deck-of/${m.id}`)).json()).toMatchObject({ href: "/deck/home_repo/EPIC-940", repo: "home_repo" });
    expect(((await (await a.request("/api/deck-of/home_repo")).json()) as { href: string }).href).toMatch(/^\/deck\/home_repo\//);
    expect((await a.request("/api/deck-of/ms_nope")).status).toBe(404);
  });

  it("E975-S2 round 2: the deck and the board say who keeps them, on which milestone, how often, from which repo", async () => {
    fs.writeFileSync(
      path.join(root, "home_repo/docs/big-rocks.md"),
      ROCKS.replace("Last read: 2026-11-07\n", "Last read: 2026-11-07\nKept by: Gap finder (EPIC-979)\nRefresh: Once a week\nSources: Sam's voice notes come from Memo\n"),
    );
    const a = app();
    const s = createStore(db!);
    const lanes = s.createMilestone({ title: "Lanes", repo: "Acme/home_repo", path: "docs/spines/epic-940.md", owner: "", paused: false });
    const top = s.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    const dm = s.createPersona({ name: "Delivery manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const gap = s.createPersona({ name: "Gap finder", remit: "find gaps", skills: [], model: "claude-opus-5-5", mayWrite: true });
    s.createAssignment({ milestoneId: lanes.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
    s.createAssignment({ milestoneId: top.id, personaId: gap.id, cadence: { type: "fixed_time", timeOfDay: "13:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, enabled: true });
    type About = { milestone: { id: string; own: boolean } | null; workers: { name: string; cadence: string; personaId: string }[]; repo: string; spinePath: string; refresh: { at: string }; rocks: { keeper: { name: string; milestone: string; cadence: string } } };
    // has no milestone of its own: the nearest one above it (Lanes) works it
    const sub = ((await (await a.request("/api/deck/home_repo/EPIC-941")).json()) as { about: About }).about;
    expect(sub).toMatchObject({ repo: "home_repo", spinePath: "docs/spines/epic-941.md", milestone: { id: lanes.id, own: false } });
    expect(sub.workers.map((w) => [w.name, w.cadence, w.personaId])).toEqual([["Delivery manager", "every 2 hours", dm.id]]);
    expect(sub.refresh.at).toMatch(/^\d\d:00 /);
    expect(sub.rocks.keeper).toMatchObject({ name: "Gap finder", milestone: "home_repo" });
    expect(sub.rocks.keeper.cadence).toMatch(/^every day at 13:00 /);
    const r = (await (await a.request("/api/rocks")).json()) as { about: { keptBy: string; refresh: string; sources: string; keeper: { personaId: string } } };
    expect(r.about).toMatchObject({ keptBy: "Gap finder (EPIC-979)", refresh: "Once a week", sources: "Sam's voice notes come from Memo", keeper: { personaId: gap.id } });
  });
});
