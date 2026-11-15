import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { workerBriefRules } from "../src/cycle/prompts.js";
import { openDb, type DB } from "../src/db.js";
import { activityWhy, defFor, outcomeDefLine, parseDefs, setOutcomeDefsDir, DEFS_FILE } from "../src/outcomeDefs.js";
import { splitActivity } from "../src/outcomes.js";
import { createStore } from "../src/store.js";
import { makeRepo, spineText } from "./reviewFixture.js";

/**
 * What counts as an outcome, per persona: one file (docs/outcomes/what-counts.json of the home repo) that
 * every wake prompt and worker brief carries, the Outcomes page shows beside each persona, and the outcome log uses to
 * refuse a line that only reports activity. Temp repos only, plus a parse check of the real file.
 */
const REAL = path.resolve(__dirname, "../../../..", DEFS_FILE);
const EPIC = "docs/spines/epic-9.md";
const DEFS = {
  rule: "An outcome is something now true.",
  neverCounts: [
    { pattern: "^(checked|verified)\\b", why: "a check alone is activity" },
    { pattern: "\\bre-?stamp(ed)?\\b", why: "a restamp is bookkeeping" },
    { pattern: "([", why: "a broken pattern is dropped" },
  ],
  default: { counts: "Something now true.", doesNot: "Checking." },
  personas: [
    { persona: "Ticket worker", counts: "The row's result is live.", doesNot: "Code not live.", examples: ["The page is live."] },
    { persona: "Delivery manager", counts: "A row moved for real.", doesNot: "Workers dispatched.", examples: [] },
  ],
};
let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e40s43-"));
  repo = makeRepo(tmp, "home_repo", {
    "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n",
    [EPIC]: spineText("PLAN-9", "Things", [{ id: "T9-S1", status: "active" }]),
    [DEFS_FILE]: JSON.stringify(DEFS),
  });
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  setOutcomeDefsDir(undefined);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });

describe("what counts as an outcome", () => {
  it("the real file parses, names every persona once, and none of its examples is activity", () => {
    const defs = parseDefs(fs.readFileSync(REAL, "utf8"));
    expect(defs.neverCounts.length).toBeGreaterThan(3);
    const names = defs.personas.map((p) => p.persona.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["ticket worker", "delivery manager", "team desk", "gap finder", "strategist", "learning harvester", "books"]) expect(names).toContain(n);
    for (const p of defs.personas) {
      expect(p.doesNot.length).toBeGreaterThan(5);
      for (const e of p.examples ?? []) expect(activityWhy(e, defs), `${p.persona}: ${e}`).toBeUndefined();
    }
    for (const t of ["Checked 12 rows, all fine", "Spine restamped", "Input reviewer daily duty done", "Started the build", "nothing new since the last wake", "E79 batch b3: 10 records written"])
      expect(activityWhy(t, defs), t).toBeDefined();
  });

  it("a persona gets its own definition, an unknown one the default, a broken pattern is dropped", () => {
    const defs = parseDefs(JSON.stringify(DEFS));
    expect(defs.neverCounts).toHaveLength(2);
    expect(defFor("ticket worker", defs).counts).toBe("The row's result is live.");
    expect(defFor("Watcher", defs)).toMatchObject({ persona: "Watcher", counts: "Something now true." });
    const line = outcomeDefLine("Ticket worker", defs);
    expect(line).toContain("What counts as an outcome for you (Ticket worker): The row's result is live.");
    expect(line).toContain("Does not count: Code not live.");
    expect(line).toContain('Example: "The page is live."');
    const s = splitActivity([{ text: "Checked the deck" }, { text: "The deck is live." }, { text: "Spine re-stamped" }], defs);
    expect(s.keep.map((o) => o.text)).toEqual(["The deck is live."]);
    expect(s.refused.map((o) => o.why)).toEqual(["a check alone is activity", "a restamp is bookkeeping"]);
  });

  it("every worker brief carries the Ticket worker's definition", () => {
    setOutcomeDefsDir(repo.dir);
    expect(workerBriefRules()[1]).toContain("What counts as an outcome for you (Ticket worker): The row's result is live.");
  });

  it("the run PATCH refuses activity lines, logs a manager's child run as the Ticket worker, and GET serves the definitions", async () => {
    const app = createApp(db, { read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] } });
    setOutcomeDefsDir(repo.dir);
    const m = (await (await app.request("/api/milestones", json({ title: "home_repo", repo: "Acme/home_repo", path: EPIC }))).json()) as { id: string };
    const store = createStore(db);
    const p = store.createPersona({ name: "Delivery manager", remit: "r", skills: [], model: "sonnet", mayWrite: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const wake = (await (await app.request("/api/runs", json({ assignmentId: a.id, outcome: "running", summary: "wake" }))).json()) as { id: string };
    const child = (await (await app.request("/api/runs", json({ assignmentId: a.id, parentRunId: wake.id, outcome: "running", summary: "T9-S1 build the page" }))).json()) as { id: string };
    const r = await app.request(
      `/api/runs/${child.id}`,
      patch({ outcome: "progressed", summary: "T9-S1 shipped", endedAt: new Date().toISOString(), outcomes: [{ kind: "delivered", text: "The page is live." }, { kind: "other", text: "Checked the page at 390 px." }] }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { outcomesLogged: { added: number; refused: { text: string; why: string }[] } };
    expect(body.outcomesLogged.added).toBe(1);
    expect(body.outcomesLogged.refused).toEqual([{ text: "Checked the page at 390 px.", why: "a check alone is activity" }]);
    // only refused lines: nothing written, the reason comes back
    const w = await app.request(`/api/runs/${wake.id}`, patch({ outcome: "progressed", summary: "wake done", endedAt: new Date().toISOString(), outcomes: [{ kind: "other", text: "Spine restamped" }] }));
    expect(((await w.json()) as { outcomesLogged: { added: number; refused: unknown[] } }).outcomesLogged).toMatchObject({ added: 0, refused: [{ text: "Spine restamped" }] });

    const got = (await (await app.request("/api/outcomes")).json()) as { outcomes: { text: string; persona: string }[]; definitions: { rule: string; personas: { persona: string; counts: string }[] } };
    expect(got.outcomes.map((o) => [o.text, o.persona])).toEqual([["The page is live.", "Ticket worker"]]);
    expect(got.definitions.rule).toBe(DEFS.rule);
    expect(got.definitions.personas.map((d) => d.persona)).toEqual(["Ticket worker", "Delivery manager"]);
    const one = (await (await app.request("/api/outcomes?persona=ticket%20worker")).json()) as { outcomes: unknown[] };
    expect(one.outcomes).toHaveLength(1);
  });
});
