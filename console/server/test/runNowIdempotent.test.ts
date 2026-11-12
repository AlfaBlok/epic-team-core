import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";

/** Run now is idempotent per clientRequestId; a slow first wake (thread launch) no longer holds the request. */
class SlowT3 implements T3Client {
  launched = 0;
  release: (() => void)[] = [];
  /** When set, launchThread waits until `release` is called. */
  hold = false;
  async listProjects() {
    return [{ id: "host1:proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    this.launched++;
    if (this.hold) await new Promise<void>((r) => this.release.push(r));
    return { threadId: `thread${this.launched}` };
  }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(runNowReplyMs?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s22-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new SlowT3();
  const store = createStore(db);
  const app = createApp(db, { cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", runNowReplyMs } });
  cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "r", skills: [], model: "sonnet", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: false });
  const post = async (body: unknown) => {
    const res = await app.request(`/api/assignments/${a.id}/run-now`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const runs = () => store.listRuns().filter((r) => r.assignmentId === a.id);
  return { t3, store, a, post, runs };
}

describe("T6-S22 Run now idempotent", () => {
  it("a repeat with the same clientRequestId returns the same run (200), no second launch, no 409", async () => {
    const t = setup();
    const first = await t.post({ clientRequestId: "crid-1" });
    expect(first.status).toBe(201);
    const again = await t.post({ clientRequestId: "crid-1" });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);
    expect(t.t3.launched).toBe(1);
    expect(t.runs()).toHaveLength(1);
  });

  it("a repeat that arrives while the first is still launching the home thread waits for it and gets the same run", async () => {
    const t = setup();
    t.t3.hold = true;
    const p1 = t.post({ clientRequestId: "crid-2" });
    await new Promise((r) => setTimeout(r, 20));
    const p2 = t.post({ clientRequestId: "crid-2" });
    await new Promise((r) => setTimeout(r, 20));
    t.t3.release.forEach((r) => r());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.json.id).toBe(r1.json.id);
    expect(t.t3.launched).toBe(1);
    expect(t.runs()).toHaveLength(1);
  });

  it("a genuinely new request (new id, or none) while the run is live still gets 409 already_running", async () => {
    const t = setup();
    const first = await t.post({ clientRequestId: "crid-3" });
    const other = await t.post({ clientRequestId: "crid-4" });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("already_running");
    expect(other.json.error.message).toBe(`run ${first.json.id} of this assignment is still running`);
    expect((await t.post({})).status).toBe(409);
    expect(t.t3.launched).toBe(1);
  });

  it("a slow first wake answers with the run row after runNowReplyMs; the launch still completes on that run", async () => {
    const t = setup(30);
    t.t3.hold = true;
    const r = await t.post({ clientRequestId: "crid-5" });
    expect(r.status).toBe(201);
    expect(r.json.outcome).toBe("running");
    expect(t.t3.launched).toBe(1);
    t.t3.release.forEach((x) => x());
    await new Promise((x) => setTimeout(x, 20));
    expect(t.runs()).toHaveLength(1);
    const again = await t.post({ clientRequestId: "crid-5" });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(r.json.id);
  });
});
