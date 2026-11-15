import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { OUTCOME_LOG_RULE, WORKER_FINISH_RULE } from "../src/cycle/prompts.js";
import { openDb, type DB } from "../src/db.js";
import { appendLines, filterOutcomes, parseLines, productOf, stamp } from "../src/outcomes.js";
import { createStore } from "../src/store.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * The outcome log and one session per row: (1) one outcome log every persona writes at the end of a wake, in the repo
 * (docs/outcomes/<day>.jsonl, root L-45), filterable; (2) a second wheel never starts a worker on a row that already
 * has a live session: the run create refuses it (409 claimed) at dispatch time. Temp repos only.
 */
const EPIC = "docs/spines/epic-9.md";
let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e40s25-"));
  repo = makeRepo(tmp, "home_repo", {
    "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n",
    [EPIC]: spineText("PLAN-9", "Things", [
      { id: "T9-S1", status: "active" },
      { id: "T9-S2", status: "ready" },
      { id: "T9-S3", status: "active" },
    ]),
  });
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setOwner(id: string, owner: string) {
  const f = path.join(repo.dir, EPIC);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  const cells = lines[i].split(" | ");
  cells[2] = owner;
  lines[i] = cells.join(" | ");
  fs.writeFileSync(f, lines.join("\n"));
  git(repo.dir, "commit", "-q", "-am", `Claim ${id}: test`);
  git(repo.dir, "push", "-q", "origin", "main");
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });

async function setup() {
  const app = createApp(db, { read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] } });
  const m = (await (await app.request("/api/milestones", json({ title: "home_repo", repo: "Acme/home_repo", path: EPIC }))).json()) as { id: string };
  const store = createStore(db);
  const dm = (name: string) => {
    const p = store.createPersona({ name, remit: "r", skills: [], model: "sonnet", mayWrite: true });
    return store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
  };
  return { app, store, m, dm };
}

describe("outcome log", () => {
  it("stamps, appends once and filters outcome lines", () => {
    const run = { id: "run_1", summary: "T9-S1 build the page", assignmentId: "a", milestoneId: "m" } as never;
    const lines = stamp([{ kind: "delivered", text: "The page is live." }, { kind: "learning", text: "L-9 added", row: "T9-S2" }], { run, persona: "Ticket worker", repo: "app", at: "2026-11-12T23:00:00.000Z", source: "run" });
    expect(lines[0]).toMatchObject({ row: "T9-S1", product: "app", persona: "Ticket worker", day: "2026-11-12", runId: "run_1" });
    expect(lines[1].row).toBe("T9-S2");
    const a = appendLines("", lines);
    expect(a.added).toBe(2);
    expect(appendLines(a.text, lines).added).toBe(0); // a resend adds nothing
    const all = parseLines(a.text + "not json\n");
    expect(all).toHaveLength(2);
    expect(filterOutcomes(all, { kind: "learning" }).map((o) => o.text)).toEqual(["L-9 added"]);
    expect(filterOutcomes(all, { row: "t9-s1", persona: "ticket worker" })).toHaveLength(1);
    expect(productOf("Acme/app", { app: "Acme Team" })).toBe("Acme Team");
  });

  it("the run PATCH carries outcomes into the repo's day file, and GET /api/outcomes reads them back filtered", async () => {
    const { app, dm } = await setup();
    const a = dm("Delivery manager");
    const run = (await (await app.request("/api/runs", json({ assignmentId: a.id, outcome: "running", summary: "wake" }))).json()) as { id: string };
    const r = await app.request(
      `/api/runs/${run.id}`,
      patch({ outcome: "progressed", summary: "T9-S1 shipped", endedAt: new Date().toISOString(), outcomes: [{ kind: "delivered", text: "The outcome page is live.", row: "T9-S1", link: "https://team.example/outcomes" }, { kind: "merged", text: "Two learnings merged into one.", row: "T9-S2" }] }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { outcomesLogged: { added: number; path: string } };
    expect(body.outcomesLogged).toMatchObject({ added: 2 });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(repo.dir, `docs/outcomes/${day}.jsonl`);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(repo.originLog()[0]).toMatch(/^Outcomes T9-S1, T9-S2: 2 logged by Delivery manager/);
    const got = (await (await app.request("/api/outcomes?kind=delivered")).json()) as { outcomes: { text: string; persona: string }[]; facets: { kind: string[] } };
    expect(got.outcomes.map((o) => [o.text, o.persona])).toEqual([["The outcome page is live.", "Delivery manager"]]);
    expect(got.facets.kind).toEqual(["delivered", "merged"]);
    // a backfill through POST /api/outcomes, same file, nothing twice
    const again = await app.request("/api/outcomes", json({ runId: run.id, outcomes: [{ kind: "delivered", text: "The outcome page is live.", row: "T9-S1", link: "https://team.example/outcomes" }] }));
    expect(again.status).toBe(200);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("every worker brief and wake asks for the outcomes", () => {
    expect(WORKER_FINISH_RULE).toContain(OUTCOME_LOG_RULE);
    expect(OUTCOME_LOG_RULE).toContain('"outcomes"');
  });
});

describe("one live session per row, checked at dispatch", () => {
  it("a second Delivery Manager's worker for a row another wake already runs is refused (409 claimed)", async () => {
    const { app, dm } = await setup();
    const a1 = dm("Delivery manager");
    const a2 = dm("Second desk");
    const w1 = (await (await app.request("/api/runs", json({ assignmentId: a1.id, outcome: "running", summary: "wake 1" }))).json()) as { id: string };
    const w2 = (await (await app.request("/api/runs", json({ assignmentId: a2.id, outcome: "running", summary: "wake 2" }))).json()) as { id: string };
    const first = await app.request("/api/runs", json({ assignmentId: a1.id, parentRunId: w1.id, outcome: "running", summary: "T9-S2 build it" }));
    expect(first.status).toBe(201);
    const second = await app.request("/api/runs", json({ assignmentId: a2.id, parentRunId: w2.id, outcome: "running", summary: "T9-S2 build it again" }));
    expect(second.status).toBe(409);
    const e = (await second.json()) as { error: { code: string; message: string } };
    expect(e.error.code).toBe("claimed");
    expect(e.error.message).toContain("already has a live session");
    // another row is free
    expect((await app.request("/api/runs", json({ assignmentId: a2.id, parentRunId: w2.id, outcome: "running", summary: "T9-S3 other" }))).status).toBe(201);
  });

  it("a live claim in the row (a T3 thread, another host) refuses; a claim by a run that ended is stale and allows", async () => {
    const { app, dm } = await setup();
    const a = dm("Delivery manager");
    const w = (await (await app.request("/api/runs", json({ assignmentId: a.id, outcome: "running", summary: "wake" }))).json()) as { id: string };
    const later = new Date(Date.now() + 3600_000).toISOString().slice(0, 16) + "Z";
    const now = new Date().toISOString().slice(0, 16) + "Z";
    setOwner("T9-S1", `thread-desk-7 — claimed ${now}, lease until ${later}`);
    const held = await app.request("/api/runs", json({ assignmentId: a.id, parentRunId: w.id, outcome: "running", summary: "T9-S1 again" }));
    expect(held.status).toBe(409);
    expect(((await held.json()) as { error: { message: string } }).error.message).toContain("thread-desk-7 holds it");
    // claimed by a run the console knows that already ended: stale
    const old = (await (await app.request("/api/runs", json({ assignmentId: a.id, outcome: "failed", summary: "old wake", endedAt: new Date().toISOString() }))).json()) as { id: string };
    setOwner("T9-S3", `${old.id} — claimed ${now}, lease until ${later}`);
    expect((await app.request("/api/runs", json({ assignmentId: a.id, parentRunId: w.id, outcome: "running", summary: "T9-S3 retry" }))).status).toBe(201);
  });
});
