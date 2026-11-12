import { describe, expect, it } from "vitest";
import { createMockClient } from "./mock";
import { nestRuns, runsForMilestone } from "@/lib/derive";

const NOW = new Date("2026-10-14T12:00:00Z");
const client = () => createMockClient({ now: () => NOW, simulateRunMs: 0 });

describe("mock client seed", () => {
  it("has the E5 milestone, a paused Memo launch and infra-steward every 2 h", async () => {
    const api = client();
    const ms = await api.listMilestones();
    const e5 = ms.find((m) => m.title.includes("E5 Fleet Observatory"))!;
    expect(e5.dod?.total).toBe(7);
    expect(ms.find((m) => m.title === "Memo launch")?.status).toBe("paused");
    const steward = (await api.listPersonas()).find((p) => p.name === "infra-steward")!;
    expect(steward.mayWrite).toBe(false);
    const a = (await api.listAssignments()).find((x) => x.personaId === steward.id)!;
    expect(a.cadence).toEqual({ type: "interval", everyMinutes: 120 });
    const runs = await api.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(8);
    expect(runs.some((r) => r.parentRunId)).toBe(true);
    expect(new Set(runs.map((r) => r.outcome))).toEqual(new Set(["running", "progressed", "blocked", "idle", "failed"]));
    expect((await api.listNeedsOwner()).filter((n) => n.status === "open").length).toBeGreaterThanOrEqual(1);
  });

  it("returns copies, not live references", async () => {
    const api = client();
    const [m] = await api.listMilestones();
    m.title = "mutated";
    expect((await api.getMilestone(m.id)).title).not.toBe("mutated");
  });
});

describe("mock client mutations", () => {
  it("creates a milestone, attaches a persona, runs it and records the run", async () => {
    const api = client();
    const m = await api.createMilestone({ title: "Test", repo: "o/r", path: "docs/spines/x.md", owner: "Sam" });
    expect(m.status).toBe("active");
    const p = await api.createPersona({ name: "tester", remit: "test", skills: ["a"], model: "claude-haiku-5-5", mayWrite: false });
    const a = await api.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 30 } });
    expect(a.enabled).toBe(false); // default off
    expect(a.nextRunAt).toBeUndefined();
    expect((await api.updateAssignment(a.id, { enabled: true })).nextRunAt).toBe("2026-10-14T12:30:00.000Z");

    const run = await api.runAssignmentNow(a.id);
    expect(run.outcome).toBe("running");
    expect(run.seat).toBe("seat1"); // most headroom in the seed
    const all = await api.listRuns();
    expect(runsForMilestone(m.id, await api.listAssignments(), all).map((r) => r.id)).toEqual([run.id]);

    // a Run now note is kept on the run; blank = none
    expect((await api.runAssignmentNow(a.id, "  focus S5  ")).instructions).toBe("focus S5");
    expect((await api.runAssignmentNow(a.id, "   ")).instructions).toBeUndefined();

    const disabled = await api.updateAssignment(a.id, { enabled: false });
    expect(disabled.nextRunAt).toBeUndefined();
  });

  it("bootstraps a milestone with an empty path and a running run", async () => {
    const api = client();
    const { milestone, run } = await api.bootstrapMilestone({ repo: "o/r", title: "New epic", goal: "do x", kind: "spine" });
    expect(milestone.path).toBe("");
    expect(run).toMatchObject({ assignmentId: `bootstrap:${milestone.id}`, outcome: "running" });
    expect((await api.listMilestones()).map((m) => m.id)).toContain(milestone.id);
  });

  it("pauses, approves and cascades deletes", async () => {
    const api = client();
    const [e5] = await api.listMilestones();
    expect((await api.updateMilestone(e5.id, { paused: true })).status).toBe("paused");
    expect((await api.updateMilestone(e5.id, { paused: false })).status).toBe("active"); // its Waiting on line does not make it blocked

    const [n] = await api.listNeedsOwner();
    expect((await api.updateNeedsOwner(n.id, "approved")).status).toBe("approved");

    await api.deleteMilestone(e5.id);
    expect((await api.listAssignments()).some((a) => a.milestoneId === e5.id)).toBe(false);
    await expect(api.getMilestone(e5.id)).rejects.toThrow(/not found/);
  });

  it("nests child runs under their parent", async () => {
    const api = client();
    const tree = nestRuns(await api.listRuns());
    const parent = tree.find((n) => n.run.id === "run-7")!;
    expect(parent.children.map((c) => c.run.id)).toEqual(["run-7c1"]);
    expect(tree.every((n) => !n.run.parentRunId)).toBe(true);
  });
});
