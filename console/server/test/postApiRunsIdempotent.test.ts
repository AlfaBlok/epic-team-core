import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { CHILD_RUN_RETRY_RULE, wakeProtocol, wakeStub } from "../src/cycle/prompts.js";

/**
 * a run create that timed out on the client still created the run, so the retry made a second one
 * (run_f24abe37/run_c2372452, run_6ef910eb/run_e7ccc501), and a timed-out stub POST /wake started run_b15b6a47 while its
 * retries were skipped. POST /api/runs and POST /wake are idempotent per clientRequestId.
 */
class FakeT3 implements T3Client {
  launched = 0;
  sent: string[] = [];
  async listProjects() {
    return [{ id: "host1:proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(o: { message?: string }) {
    this.launched++;
    this.sent.push(o.message ?? "");
    return { threadId: `thread${this.launched}` };
  }
  async sendToThread(_t: string, message: string) {
    this.sent.push(message);
  }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((f) => f());
  cleanups = [];
});

function setup(file?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s35-"));
  const dbFile = file ?? path.join(dir, "c.db");
  const db: DB = openDb(dbFile);
  const t3 = new FakeT3();
  const store = createStore(db);
  const app = createApp(db, { cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", runState: async () => undefined } });
  cleanups.push(() => {
    db.close();
    if (!file) fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  return { db, dbFile, t3, store, call };
}

function seed(store: ReturnType<typeof createStore>, enabled = false) {
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "r", skills: [], model: "sonnet", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled });
  return { m, p, a };
}

describe("T6-S35 POST /api/runs idempotent per clientRequestId", () => {
  it("the same clientRequestId returns the same run with 200, never a second run", async () => {
    const t = setup();
    const { a } = seed(t.store);
    const body = { assignmentId: a.id, outcome: "running", summary: "T6-S35 worker", clientRequestId: "T6-S35-231500" };
    const first = await t.call("POST", "/api/runs", body);
    expect(first.status).toBe(201);
    expect(first.json.clientRequestId).toBe("T6-S35-231500");
    const again = await t.call("POST", "/api/runs", body);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);
    // a retry whose other fields differ still names the first run: the id is the request, not the body
    const third = await t.call("POST", "/api/runs", { ...body, summary: "changed" });
    expect(third.status).toBe(200);
    expect(third.json.id).toBe(first.json.id);
    expect(third.json.summary).toBe("T6-S35 worker");
    expect(t.store.listRuns({ assignmentId: a.id })).toHaveLength(1);
  });

  it("a new id, no id, or the same id on another assignment each create a run", async () => {
    const t = setup();
    const { a } = seed(t.store);
    const { a: b } = seed(t.store);
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id, clientRequestId: "r1" })).status).toBe(201);
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id, clientRequestId: "r2" })).status).toBe(201);
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id })).status).toBe(201);
    expect((await t.call("POST", "/api/runs", { assignmentId: a.id })).status).toBe(201);
    expect((await t.call("POST", "/api/runs", { assignmentId: b.id, clientRequestId: "r1" })).status).toBe(201);
    expect(t.store.listRuns({ assignmentId: a.id })).toHaveLength(4);
    expect(t.store.listRuns({ assignmentId: b.id })).toHaveLength(1);
  });

  it("two concurrent creates with one id (the timed-out first still in flight) make one run", async () => {
    const t = setup();
    const { a } = seed(t.store);
    // `blocked` awaits the ask lookup before inserting: the window where a retry overtakes the first request
    const body = { assignmentId: a.id, outcome: "blocked", summary: "waits on a time", clientRequestId: "race-1" };
    const [r1, r2] = await Promise.all([t.call("POST", "/api/runs", body), t.call("POST", "/api/runs", body)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.json.id).toBe(r2.json.id);
    expect(t.store.listRuns({ assignmentId: a.id })).toHaveLength(1);
  });

  it("survives a console restart (the id is stored on the run, unique per assignment)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s35r-"));
    const file = path.join(dir, "c.db");
    const t1 = setup(file);
    const { a } = seed(t1.store);
    const first = await t1.call("POST", "/api/runs", { assignmentId: a.id, clientRequestId: "keep-1" });
    t1.db.close();
    cleanups = cleanups.slice(1);
    const t2 = setup(file);
    const again = await t2.call("POST", "/api/runs", { assignmentId: a.id, clientRequestId: "keep-1" });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);
    expect(() =>
      t2.db.prepare("INSERT INTO runs (id, assignment_id, started_at, outcome, summary, client_request_id) VALUES ('run_x', ?, '2026-10-31T00:00:00Z', 'idle', '', 'keep-1')").run(a.id),
    ).toThrow(/UNIQUE/);
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it("PATCH cannot set or change a run's clientRequestId", async () => {
    const t = setup();
    const { a } = seed(t.store);
    const r = await t.call("POST", "/api/runs", { assignmentId: a.id, clientRequestId: "p1" });
    expect((await t.call("PATCH", `/api/runs/${r.json.id}`, { clientRequestId: "p2" })).status).toBe(400);
  });
});

describe("T6-S35 POST /assignments/:id/wake idempotent per clientRequestId", () => {
  it("a retried stub wake gets the same run and prompt; without an id the retry is still skipped", async () => {
    const t = setup();
    const { a } = seed(t.store, true);
    const w1 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, { clientRequestId: "run_stub1" });
    expect(w1.json.run.outcome).toBe("running");
    const w2 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, { clientRequestId: "run_stub1" });
    expect(w2.json.run.id).toBe(w1.json.run.id);
    expect(w2.json.skipped).toBeUndefined();
    expect(w2.json.prompt).toBe(w1.json.prompt);
    const w3 = await t.call("POST", `/api/assignments/${a.id}/wake`, {});
    expect(w3.text).toMatch(/still running/);
    expect(t.store.listRuns({ assignmentId: a.id }).filter((r) => r.kind === "wake" && r.outcome === "running")).toHaveLength(1);
  });

  it("Run now's stub carries the run id as clientRequestId and says to retry with it", async () => {
    const t = setup();
    const { a } = seed(t.store, true);
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`, {});
    expect(r.status).toBe(201);
    const stub = t.t3.sent.at(-1)!;
    expect(stub).toContain(`-d '{"clientRequestId":"${r.json.id}"}'`);
    expect(stub).toMatch(/retry the same command \(same clientRequestId/);
    // the stub's own POST, then its retry: one wake, the Run now run claimed both times
    const w1 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, { clientRequestId: r.json.id });
    const w2 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, { clientRequestId: r.json.id });
    expect(w1.json.run.id).toBe(r.json.id);
    expect(w2.json.run.id).toBe(r.json.id);
    expect(t.store.listRuns({ assignmentId: a.id }).filter((x) => x.kind === "wake")).toHaveLength(1);
  });
});

describe("T6-S35 dispatch text", () => {
  it("the wake prompt's child-run create sends a clientRequestId and the retry rule", () => {
    const protocol = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", mayWrite: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "Delivery Manager" },
    } as any);
    expect(protocol).toContain('"clientRequestId":"<ticket id>-<this wake run id>"');
    expect(protocol).toContain(CHILD_RUN_RETRY_RULE);
    expect(wakeStub("http://c", "asg_1")).toContain("-d '{}'");
  });

  it("the Delivery Manager remit template says the same", () => {
    const remit = fs.readFileSync(path.join(__dirname, "../../../../docs/personas/delivery-manager.md"), "utf8");
    expect(remit).toMatch(/new `clientRequestId`.*retry with the same id/);
  });
});
