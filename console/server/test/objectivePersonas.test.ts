import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { buildScorecards } from "../src/scorecards.js";
import { ASSIGNMENTS_FILE, assignmentEntryOf, parseAssignments } from "../src/team/assignmentRecord.js";
import { objectiveSection, buildWakePrompt, redFirstLine } from "../src/wakePrompt.js";

/**
 * The owner asked for one Delivery Manager per objective on its Personas tab: an assignment names the
 * objective it works, in the team repo's state/assignments.json first; several objectives on one milestone are marked
 * shared so each Personas tab lists only its own; a persona that names one is told in its wake to work only that one.
 */
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
let tmp: string;
let reposRoot: string;
const dbs: DB[] = [];
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

function repo(name: string, files: Record<string, string>) {
  const origin = path.join(tmp, "origins", `${name}.git`);
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const dir = path.join(reposRoot, name);
  git(tmp, ["clone", "-q", origin, dir]);
  git(dir, ["checkout", "-q", "-b", "main"]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  git(dir, ["push", "-q", "origin", "main"]);
  return { dir, origin, onMain: (rel: string) => git(origin, ["show", `main:${rel}`]) };
}

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-objpersonas-"));
  reposRoot = path.join(tmp, "repos");
  fs.mkdirSync(reposRoot);
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function boot(dbFile = path.join(tmp, "console.db")) {
  const db = openDb(dbFile);
  dbs.push(db);
  const app = createApp(db, { read: { reposRoot, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] }, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { db, call };
}
const SPINE = "# PLAN-7: Seven\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n";

describe("an assignment names its objective", () => {
  it("attach with an objective writes it to state/assignments.json; a patch changes or clears it; a fresh console.db reads it back", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const { call } = boot();
    const m = (await call("POST", "/api/milestones", { title: "Seven", repo: "proj", path: "docs/spines/root.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "Runs it." })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: false, objective: "vault" })).json;
    expect(a.objective).toBe("vault");
    const file = () => JSON.parse(team.onMain(ASSIGNMENTS_FILE)).assignments as Record<string, unknown>[];
    expect(file().find((x) => x.id === a.id)).toMatchObject({ objective: "vault", enabled: false });
    await call("PATCH", `/api/assignments/${a.id}`, { objective: "team-browser" });
    expect(file().find((x) => x.id === a.id)).toMatchObject({ objective: "team-browser" });
    const fresh = boot(path.join(tmp, "fresh.db"));
    expect((await fresh.call("GET", `/api/assignments/${a.id}`)).json).toMatchObject({ objective: "team-browser", enabled: false });
    await call("PATCH", `/api/assignments/${a.id}`, { objective: "" });
    expect(file().find((x) => x.id === a.id)?.objective).toBeUndefined();
    expect((await call("GET", `/api/assignments/${a.id}`)).json.objective).toBeUndefined();
    expect((await call("PATCH", `/api/assignments/${a.id}`, { objective: "Not An Id" })).status).toBe(400);
  });

  it("the file keeps an entry without an objective as it was", () => {
    const p = parseAssignments(JSON.stringify({ assignments: [{ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true, createdAt: "x" }] }));
    expect("entries" in p && p.entries[0]).not.toHaveProperty("objective");
    expect(assignmentEntryOf({ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true, writeEnabled: false, writeScope: "", createdAt: "x" })).not.toHaveProperty("objective");
  });

  it("objectives on one milestone are marked shared; one alone is not", () => {
    const pursuit = (id: string, ms: string) => ({ id, name: id, greenWhen: "", state: "amber" as const, greens: 0, total: 1, lines: [], totems: [], motion: "moving" as const, epics: [], milestones: [{ id: ms, title: ms, via: "root" as const, teams: [] }] });
    const nodes = buildScorecards({ pursuits: [pursuit("alignment", "ms_root"), pursuit("vault", "ms_root"), pursuit("house", "ms_house")], staleDays: 3 } as never, () => undefined).nodes;
    expect(Object.fromEntries(nodes.map((n) => [n.id, !!n.milestoneShared]))).toEqual({ alignment: true, vault: true, house: false });
  });

  it("the wake of a persona that names an objective says to work only it, with its epics", () => {
    const s = objectiveSection("vault", { name: "App: Finish the vault move", epics: ["app: docs/spines/accounts.md"] });
    expect(s).toMatch(/^## Your objective: you are its objective manager/);
    expect(s).toContain("App: Finish the vault move (`vault` in docs/pursuits.json): you work this objective only");
    expect(s).toContain("its key results green, not tickets closed");
    expect(s).toContain("/scripts/kr_orphans.py --objective vault");
    expect(s).toContain("both_ways.py ask <objective id|desk>");  // ask the moment something is unclear, never weekly
    expect(s).not.toContain("Once a week you tell the owner");
    expect(s).toContain("kr_orphans.py write vault <n>");
    expect(s).toContain("Your report opens with each key result");
    expect(s).toContain("app: docs/spines/accounts.md");
    expect(objectiveSection("gone")).toContain("`gone` in docs/pursuits.json");
  });

  it("the wake message names the objective's red key results and the one command, read whole every wake", () => {
    const card = JSON.stringify({ keyResults: [{ label: "Five testers", colour: "red" }, { label: "Cap", colour: "green" }] });
    const l = redFirstLine("vault", card);
    expect(l).toContain("Red key results (1): Five testers.");
    expect(l).toContain("kr_orphans.py --objective vault");
    expect(redFirstLine("vault", JSON.stringify({ keyResults: [{ label: "Cap", colour: "green" }] }))).toBe("");
    expect(redFirstLine("vault", "not json")).toBe("");
  });

  it("an objective manager's wake opens with its red key results that nothing moves", () => {
    const p = { name: "Delivery Manager", remit: "Run the milestone.", skills: [] };
    const m = { title: "T", repo: "o/r", path: "docs/x.md", owner: undefined } as never;
    const s = buildWakePrompt(p, m, { writeEnabled: true, writeScope: "x", objective: "vault" });
    expect(s).toMatch(/## This wake[\s\S]*0\. First, before alerts[\s\S]*kr_orphans\.py --objective vault[\s\S]*\n1\. /);
    expect(buildWakePrompt(p, m, { writeEnabled: true, writeScope: "x" })).not.toContain("kr_orphans.py --objective");
  });

  it("a Delivery Manager of another world's spine the objective lists after its own is its second manager, on its own spine", () => {
    const o = { name: "App: Keep the feeds running", epics: ["feeds: docs/spines/root.md", "listings: docs/spines/root.md"] };
    const s = objectiveSection("feeds", o, true, "acme/listings: docs/spines/root.md");
    expect(s).toMatch(/^## Your objective: you are a second manager from your own world/);
    expect(s).toContain("Bind and dispatch from your own spine only");
    expect(s).toContain("feeds: docs/spines/root.md) has its own objective manager");
    expect(objectiveSection("feeds", o, true, "acme/feeds: docs/spines/root.md")).toMatch(/^## Your objective: you are its objective manager/);
    expect(objectiveSection("feeds", o, true, "acme/elsewhere: docs/x.md")).toMatch(/^## Your objective: you are its objective manager/);
  });

  it("a whole-team persona that names an objective only has its home there and still serves all", () => {
    const s = objectiveSection("vault", { name: "App: Finish the vault move", epics: ["app: docs/spines/accounts.md"] }, false);
    expect(s).toMatch(/^## Your home objective/);
    expect(s).toContain("its Personas tab lists you. You still serve every objective");
    expect(s).not.toContain("work this objective only");
    expect(s).not.toContain("objective manager");
    expect(s).not.toContain("docs/spines/accounts.md");
  });
});
