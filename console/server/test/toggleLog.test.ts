import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempApp } from "./helpers.js";

/** each on/off toggle writes one run-log line (who, when, from→to); "never on" is derived from the log. */
let t: ReturnType<typeof tempApp>;
beforeEach(() => {
  t = tempApp();
});
afterEach(() => t.cleanup());

async function seed(enabled: boolean) {
  const m = (await t.call("POST", "/api/milestones", { title: "E5", repo: "/repo", path: "tickets/E5.md", owner: "Sam" })).json;
  const p = (await t.call("POST", "/api/personas", { name: "steward", remit: "health", skills: [], model: "opus" })).json;
  const a = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled })).json;
  return { m, p, a };
}
const runs = async (id: string) => (await t.call("GET", `/api/runs?assignmentId=${id}`)).json as any[];

describe("T6-S7 toggle log", () => {
  it("attached off reads never on; switching on writes one line with actor and time and clears it", async () => {
    const { a } = await seed(false);
    expect(a.neverOn).toBe(true);
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.neverOn).toBe(true);
    expect(await runs(a.id)).toEqual([]);
    // the list reads a kept set of ever-on assignments: it must turn when the toggle line is added
    expect((await t.call("GET", "/api/assignments")).json[0].neverOn).toBe(true);

    const before = Date.now();
    const on = await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ enabled: true, neverOn: false });
    const lines = await runs(a.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "toggle", outcome: "idle", summary: "toggle off→on: switched on by Sam" });
    expect(Date.parse(lines[0].startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(lines[0].endedAt).toBe(lines[0].startedAt);
    // A toggle line is not a wake: lastRunAt stays unset.
    expect(on.json.lastRunAt).toBeUndefined();

    // Back off by an agent (X-Console-Actor): a second line, and it stays "ever on".
    const res = await t.app.request(`/api/assignments/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Console-Actor": "T6-S7 worker" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).neverOn).toBe(false);
    const after = await runs(a.id);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.summary)).toContain("toggle on→off: switched off by T6-S7 worker");
    expect((await t.call("GET", "/api/assignments")).json[0].neverOn).toBe(false);
  });

  it("a PATCH that does not change enabled writes no line", async () => {
    const { a } = await seed(true);
    expect(a.neverOn).toBe(false);
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    await t.call("PATCH", `/api/assignments/${a.id}`, { cadence: { type: "interval", everyMinutes: 60 } });
    expect(await runs(a.id)).toEqual([]);
  });

  it("off with an earlier cadence wake or park note is not never on; Run now alone is", async () => {
    const { a } = await seed(false);
    const ins = t.db.prepare(
      "INSERT INTO runs (id, assignment_id, milestone_id, started_at, ended_at, outcome, summary, kind) VALUES (?, ?, ?, ?, ?, 'idle', ?, 'wake')",
    );
    ins.run("run_now", a.id, a.milestoneId, "2026-10-22T10:00:00Z", "2026-10-22T10:05:00Z", "Run now: woke");
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.neverOn).toBe(true);
    ins.run("run_cad", a.id, a.milestoneId, "2026-10-22T12:00:00Z", "2026-10-22T12:05:00Z", "Woke on cadence");
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.neverOn).toBe(false);
  });

  it("the ever-on set follows a deleted run too (its stamp counts deletes, not every row)", async () => {
    const { a } = await seed(false);
    const ins = t.db.prepare(
      "INSERT INTO runs (id, assignment_id, milestone_id, started_at, ended_at, outcome, summary, kind) VALUES (?, ?, ?, ?, ?, 'idle', ?, 'wake')",
    );
    ins.run("run_cad", a.id, a.milestoneId, "2026-10-22T12:00:00Z", "2026-10-22T12:05:00Z", "Woke on cadence");
    ins.run("run_later", a.id, a.milestoneId, "2026-10-22T13:00:00Z", "2026-10-22T13:05:00Z", "Run now: woke");
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.neverOn).toBe(false);
    t.db.prepare("DELETE FROM runs WHERE id = 'run_cad'").run();
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.neverOn).toBe(true);
  });
});
