import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { tempApp } from "./helpers.js";
import { withIdentity } from "../src/identityPage.js";

let t: ReturnType<typeof tempApp>;
beforeEach(() => {
  t = tempApp();
});
afterEach(() => t.cleanup());

const milestoneIn = { title: "E5", repo: "/repo", path: "tickets/E5.md", owner: "Sam" };
const personaIn = { name: "steward", remit: "check health read-only", skills: ["epic-spine"], model: "opus" };

async function seed() {
  const m = (await t.call("POST", "/api/milestones", milestoneIn)).json;
  const p = (await t.call("POST", "/api/personas", personaIn)).json;
  const a = (
    await t.call("POST", "/api/assignments", {
      milestoneId: m.id,
      personaId: p.id,
      cadence: { type: "interval", everyMinutes: 120 },
    })
  ).json;
  return { m, p, a };
}

describe("empty database", () => {
  it("starts with no hard-wired data", async () => {
    for (const r of ["milestones", "personas", "assignments", "runs", "needs-owner"])
      expect((await t.call("GET", `/api/${r}`)).json).toEqual([]);
  });
  it("creates the DB directory and records the schema version", () => {
    expect(fs.existsSync(path.join(t.dir, "nested", "console.db"))).toBe(true);
    expect(t.db.pragma("user_version", { simple: true })).toBe(24);
  });
});

describe("milestones", () => {
  it("round-trips create / get / list / patch / delete", async () => {
    const created = await t.call("POST", "/api/milestones", milestoneIn);
    expect(created.status).toBe(201);
    const m = created.json;
    expect(m).toMatchObject({ ...milestoneIn, paused: false, status: "active", dod: { done: 0, total: 0, items: [] } });
    expect(m.id).toMatch(/^ms_/);
    expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);

    expect((await t.call("GET", `/api/milestones/${m.id}`)).json).toEqual({ ...m, world: "home" }); // the one-milestone read names its world
    expect((await t.call("GET", "/api/milestones")).json).toEqual([m]);

    const patched = await t.call("PATCH", `/api/milestones/${m.id}`, { paused: true, title: "E5 Observatory" });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ title: "E5 Observatory", paused: true, status: "paused", repo: "/repo" });

    expect((await t.call("DELETE", `/api/milestones/${m.id}`)).status).toBe(204);
    expect((await t.call("GET", `/api/milestones/${m.id}`)).status).toBe(404);
    expect((await t.call("DELETE", `/api/milestones/${m.id}`)).status).toBe(404);
  });

  it("rejects invalid bodies with JSON errors", async () => {
    const missing = await t.call("POST", "/api/milestones", { title: "x" });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe("validation_error");
    expect(missing.json.error.details.map((d: any) => d.path[0]).sort()).toEqual(["path", "repo"]);

    expect((await t.call("POST", "/api/milestones", { ...milestoneIn, title: "  " })).status).toBe(400);
    expect((await t.call("POST", "/api/milestones", { ...milestoneIn, status: "done" })).json.error.code).toBe(
      "validation_error",
    );
    const bad = await t.call("POST", "/api/milestones", "{not json");
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_json");
    expect((await t.call("PATCH", "/api/milestones/nope", { title: "x" })).status).toBe(404);
  });
});

describe("personas", () => {
  it("round-trips with skills array and mayWrite default false", async () => {
    const p = (await t.call("POST", "/api/personas", personaIn)).json;
    expect(p).toMatchObject({ ...personaIn, mayWrite: false });
    expect(p.id).toMatch(/^pe_/);
    const patched = (await t.call("PATCH", `/api/personas/${p.id}`, { skills: [], mayWrite: true })).json;
    expect(patched).toMatchObject({ name: "steward", skills: [], mayWrite: true });
    expect((await t.call("GET", "/api/personas")).json).toEqual([patched]);
    expect((await t.call("DELETE", `/api/personas/${p.id}`)).status).toBe(204);
    expect((await t.call("GET", "/api/personas")).json).toEqual([]);
  });

  it("validates", async () => {
    expect((await t.call("POST", "/api/personas", { name: "x" })).status).toBe(400);
    expect((await t.call("POST", "/api/personas", { ...personaIn, skills: "a,b" })).status).toBe(400);
    expect((await t.call("POST", "/api/personas", { ...personaIn, mayWrite: "no" })).status).toBe(400);
  });
});

describe("assignments", () => {
  it("round-trips both cadence types and filters by milestone", async () => {
    const { m, p, a } = await seed();
    // New assignments default to enabled=false (safety: nothing fires until toggled on).
    expect(a).toMatchObject({ milestoneId: m.id, personaId: p.id, enabled: false, cadence: { everyMinutes: 120 } });
    expect(a.t3ScheduledTaskId).toBeUndefined();

    const fixed = { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] };
    const patched = (await t.call("PATCH", `/api/assignments/${a.id}`, { cadence: fixed, enabled: false })).json;
    expect(patched).toMatchObject({ cadence: fixed, enabled: false });
    expect((await t.call("GET", `/api/assignments?milestoneId=${m.id}`)).json).toEqual([patched]);
    expect((await t.call("GET", `/api/assignments?milestoneId=other`)).json).toEqual([]);
    expect((await t.call("GET", `/api/assignments?personaId=${p.id}`)).json).toHaveLength(1);
    expect((await t.call("DELETE", `/api/assignments/${a.id}`)).status).toBe(204);
  });

  it("rejects bad cadences and unknown references", async () => {
    const { m, p } = await seed();
    const base = { milestoneId: m.id, personaId: p.id };
    for (const cadence of [
      { type: "interval", everyMinutes: 0 },
      { type: "interval", everyMinutes: 1.5 },
      { type: "fixed_time", timeOfDay: "9:00", weekdays: [1] },
      { type: "fixed_time", timeOfDay: "24:00", weekdays: [1] },
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [7] },
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 1] },
      { type: "cron", expr: "* * * * *" },
    ]) {
      const r = await t.call("POST", "/api/assignments", { ...base, cadence });
      expect(r.status, JSON.stringify(cadence)).toBe(400);
    }
    const unknown = await t.call("POST", "/api/assignments", {
      ...base,
      personaId: "pe_missing",
      cadence: { type: "interval", everyMinutes: 60 },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.code).toBe("unknown_reference");
  });

  it("is removed when its milestone or persona is deleted", async () => {
    const { m, p } = await seed();
    await t.call("DELETE", `/api/personas/${p.id}`);
    expect((await t.call("GET", "/api/assignments")).json).toEqual([]);
    expect((await t.call("GET", "/api/milestones")).json).toHaveLength(1);
    await t.call("DELETE", `/api/milestones/${m.id}`);
  });

  it("run-now is refused while the cycle is off (kill switch default)", async () => {
    const { a } = await seed();
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("cycle_disabled");
    expect((await t.call("GET", "/api/runs")).json).toEqual([]);
    expect((await t.call("POST", "/api/assignments/nope/run-now")).status).toBe(404);
  });
});

describe("runs", () => {
  it("creates, filters, patches and keeps history after the assignment is detached", async () => {
    const { m, a } = await seed();
    const parent = (
      await t.call("POST", "/api/runs", { assignmentId: a.id, startedAt: "2026-10-14T10:00:00.000Z", seat: "seat1" })
    ).json;
    expect(parent).toMatchObject({ outcome: "running", seat: "seat1", summary: "" });
    const child = (
      await t.call("POST", "/api/runs", {
        assignmentId: a.id,
        parentRunId: parent.id,
        startedAt: "2026-10-14T10:05:00.000Z",
        outcome: "idle",
        summary: "diagnose only",
      })
    ).json;
    expect(child.parentRunId).toBe(parent.id);
    // only top-level runs count as a wake
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.lastRunAt).toBe("2026-10-14T10:00:00.000Z");

    const done = await t.call("PATCH", `/api/runs/${parent.id}`, {
      outcome: "progressed",
      endedAt: "2026-10-14T10:20:00.000Z",
      summary: "relaunched worker",
      threadId: "thread-1",
    });
    expect(done.json).toMatchObject({ outcome: "progressed", threadId: "thread-1" });

    const byMilestone = (await t.call("GET", `/api/runs?milestoneId=${m.id}`)).json;
    expect(byMilestone.map((r: any) => r.id)).toEqual([child.id, parent.id]); // newest first
    expect((await t.call("GET", `/api/runs?assignmentId=${a.id}&limit=1`)).json).toHaveLength(1);
    expect((await t.call("GET", "/api/runs?assignmentId=other")).json).toEqual([]);

    await t.call("DELETE", `/api/assignments/${a.id}`);
    expect((await t.call("GET", `/api/runs?milestoneId=${m.id}`)).json).toHaveLength(2);
  });

  it("validates", async () => {
    const { a } = await seed();
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id, outcome: "done" })).status).toBe(400);
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id, startedAt: "yesterday" })).status).toBe(400);
    expect((await t.call("POST", "/api/runs", { assignmentId: "as_missing" })).json.error.code).toBe(
      "unknown_reference",
    );
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id, parentRunId: "run_x" })).status).toBe(400);
    expect((await t.call("GET", "/api/runs?limit=0")).status).toBe(400);
    expect((await t.call("PATCH", "/api/runs/nope", { outcome: "idle" })).status).toBe(404);
  });
});

describe("needs-owner", () => {
  it("T62-S4: an ask raised with no spine to write is refused and nothing is recorded; Needs Sam rows take no status", async () => {
    const { m, a } = await seed();
    const run = (await t.call("POST", "/api/runs", { assignmentId: a.id })).json;
    const item = await t.call("POST", "/api/needs-owner", {
      runId: run.id,
      milestoneId: m.id,
      question: "Restart cloudflared?",
      proposedAction: "systemctl --user restart cloudflared - why Sam: it widens access",
    });
    expect(item.status).toBe(409);
    expect(item.json.error).toMatchObject({ code: "spine_write_refused" });
    expect(item.json.error.message).toMatch(/Nothing was recorded/);
    expect((await t.call("GET", "/api/needs-owner")).json).toEqual([]);
    expect((await t.call("PATCH", "/api/needs-owner/nj_x", { status: "approved" })).status).toBe(410);
    expect((await t.call("POST", "/api/needs-owner/nj_x/supersede", {})).status).toBe(410);
    expect((await t.call("POST", "/api/needs-owner", { milestoneId: m.id })).status).toBe(400);
    expect((await t.call("POST", "/api/needs-owner", { milestoneId: "ms_nope", question: "q?" })).status).toBe(404);
    expect((await t.call("GET", "/api/needs-owner?status=bogus")).status).toBe(400);
  });
});

describe("routing", () => {
  it("returns JSON 404 for unknown API routes", async () => {
    const r = await t.call("GET", "/api/nothing");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });

  it("serves the built UI with SPA fallback and no path escape", async () => {
    const dist = path.join(t.dir, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
    fs.writeFileSync(path.join(dist, "assets", "a.js"), "console.log(1)");
    fs.writeFileSync(path.join(t.dir, "secret.txt"), "secret");
    const app = createApp(t.db, { staticDir: dist });
    const get = async (u: string) => {
      const res = await app.request(u);
      return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
    };
    expect(await get("/")).toMatchObject({ status: 200, text: withIdentity("<html>app</html>") });
    const js = await get("/assets/a.js");
    expect(js).toMatchObject({ status: 200, text: "console.log(1)" });
    expect(js.type).toContain("javascript");
    expect((await get("/milestones/ms_1")).text).toBe(withIdentity("<html>app</html>"));
    expect((await get("/%2e%2e/secret.txt")).text).not.toBe("secret");
    expect((await get("/api/nothing")).status).toBe(404);
  });

  it("says the UI is not built when dist is missing", async () => {
    const res = await createApp(t.db, { staticDir: path.join(t.dir, "nope") }).request("/");
    expect(res.status).toBe(404);
  });
});
