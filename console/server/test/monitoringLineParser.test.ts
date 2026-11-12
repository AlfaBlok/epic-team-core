import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle, SEND_RETRY_PREFIX } from "../src/cycle/service.js";
import { parseMonitoring } from "../src/adapters/monitoring.js";
import { parseDoc } from "../src/adapters/doc.js";
import { T3Error, type T3Client } from "../src/t3/client.js";
import type { ReadConfig } from "../src/routes/read.js";
import { TIER_BLOCKED } from "../src/inbox/asks.js";
import { TIMED_WAKE_RULE, WORKER_FINISH_RULE } from "../src/cycle/prompts.js";
import { STATE_RULE } from "../src/wakePrompt.js";

/** one plain status per milestone; a clock or condition wait is Monitoring, never "blocked". */

const HOLD = fs.readFileSync(path.join(__dirname, "fixtures/EPIC-902-hold.md"), "utf8");
const EPIC2_LINE =
  "7-day hold, all 5 DoD green since 2026-10-24T06:53+02:00 until 2026-10-31T06:53+02:00 · next check 2026-10-25T02:00Z archiver delete proof (DOD-2) · then write Outcome, Status review";

describe("Monitoring: line parser", () => {
  it("present: what, since, until (UTC), next check + what, then", () => {
    expect(parseMonitoring(EPIC2_LINE)).toEqual([
      {
        what: "7-day hold, all 5 DoD green",
        since: "2026-10-24T04:53:00.000Z",
        until: "2026-10-31T04:53:00.000Z",
        nextCheckAt: "2026-10-25T02:00:00.000Z",
        nextCheck: "archiver delete proof (DOD-2)",
        then: "write Outcome, Status review",
      },
    ]);
  });

  it("absent / none: []", () => {
    expect(parseMonitoring(undefined)).toEqual([]);
    expect(parseMonitoring("")).toEqual([]);
    expect(parseMonitoring("none")).toEqual([]);
    expect(parseDoc("# X\n\n## Current State\n\nStatus: active\n").monitoring).toEqual([]);
    expect(parseDoc("# X\n").monitoring).toEqual([]);
  });

  it("several items separated by ` ; `, and several lines", () => {
    const items = parseMonitoring(["DNS propagation until 2026-10-26 · next check 2026-10-25T08:00Z dig from 3 resolvers ; cert renewal · next check 2026-11-01T00:00Z", "backup soak since 2026-10-20"]);
    expect(items.map((i) => i.what)).toEqual(["DNS propagation", "cert renewal", "backup soak"]);
    expect(items[0]).toMatchObject({ until: "2026-10-26T00:00:00.000Z", nextCheckAt: "2026-10-25T08:00:00.000Z", nextCheck: "dig from 3 resolvers" });
    expect(items[1]).toMatchObject({ nextCheckAt: "2026-11-01T00:00:00.000Z" });
    expect(items[1].nextCheck).toBeUndefined();
    expect(items[2].since).toBe("2026-10-20T00:00:00.000Z");
  });

  it("malformed parts are ignored, never a crash", () => {
    const [i] = parseMonitoring("hold since someday until soon · next check tomorrow-ish the logs · gibberish part · then close");
    expect(i.what).toBe("hold since someday until soon");
    expect(i.since).toBeUndefined();
    expect(i.until).toBeUndefined();
    expect(i.nextCheckAt).toBeUndefined();
    expect(i.nextCheck).toBe("tomorrow-ish the logs");
    expect(i.then).toBe("close");
    expect(parseMonitoring(" · · ; ;")).toEqual([]);
    expect(() => parseMonitoring("since 9999-99-99T99:99Z until ∞ · next check")).not.toThrow();
  });

  it("the PLAN-2-shaped spine exposes it (bullets / bold labels tolerated)", () => {
    expect(parseDoc(HOLD).monitoring).toHaveLength(1);
    expect(parseDoc(HOLD.replace("Monitoring:", "- **Monitoring:**")).monitoring[0].nextCheckAt).toBe("2026-10-25T02:00:00.000Z");
  });
});

describe("prompts teach monitoring", () => {
  it("blocked needs an open ask; date/condition waits are monitoring with nextCheckAt; the DM keeps the Monitoring line", () => {
    expect(TIER_BLOCKED).toContain("`monitoring`, with `nextCheckAt: <ISO UTC>`");
    expect(TIER_BLOCKED).toContain("stores a `blocked` that cites no open ask as monitoring");
    expect(WORKER_FINISH_RULE).toContain("`outcome: monitoring` with `nextCheckAt: <ISO UTC>`");
    expect(TIMED_WAKE_RULE).toContain("`outcome: monitoring` with `nextCheckAt: <ISO UTC>`");
    expect(STATE_RULE).toContain("Monitoring: <what> since <ISO> until <ISO> · next check <ISO> <what> · then <what happens after>");
  });
});

// ---------- API: milestone exposes monitoring[]; stored runs ----------

let reposRoot: string;
let db: DB | undefined;
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e8s14-"));
  fs.mkdirSync(path.join(reposRoot, "ops/.git"), { recursive: true });
  fs.writeFileSync(path.join(reposRoot, "ops/.git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/ops.git\n`);
  fs.mkdirSync(path.join(reposRoot, "ops/docs"), { recursive: true });
  fs.writeFileSync(path.join(reposRoot, "ops/docs/PLAN-2.md"), HOLD);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

describe("GET /milestones/:id", () => {
  it("carries monitoring[] from the spine (PLAN-2 fixture), [] for a spine without it", async () => {
    db = openDb(path.join(reposRoot, "c.db"));
    const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read });
    const post = async (body: unknown) =>
      (await app.request("/api/milestones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const m = await post({ title: "PLAN-2", repo: "Acme/ops", path: "docs/PLAN-2.md" });
    const got = (await (await app.request(`/api/milestones/${m.id}`)).json()) as any;
    expect(got.monitoring).toEqual(parseMonitoring(EPIC2_LINE));
    expect(got.status).toBe("active");
    fs.writeFileSync(path.join(reposRoot, "ops/docs/PLAN-2.md"), HOLD.replace(/^Monitoring:.*$/m, ""));
    const list = (await (await app.request(`/api/milestones`)).json()) as any[];
    expect(list[0].monitoring).toEqual([]);
  });
});

// ---------- retry once on a failed wake send ----------

class FakeT3 implements T3Client {
  failures = 0;
  sent = 0;
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    return { threadId: "home" };
  }
  async sendToThread() {
    this.sent++;
    if (this.failures-- > 0) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "read ECONNRESET" } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

async function cycleSetup(sendRetryMs: number) {
  db = openDb(path.join(reposRoot, "cy.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", sendRetryMs });
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const first = await cycle.runNow(a.id); // launches the home thread; later wakes send into it
  store.updateRun(first.id, { outcome: "progressed", endedAt: new Date().toISOString() });
  return { t3, store, cycle, a };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("wake send: retry once (fake T3)", () => {
  it("first send fails (fetch failed): run stays running, says when it retries; the retry delivers", async () => {
    const t = await cycleSetup(40);
    t.t3.failures = 1;
    const run = await t.cycle.runNow(t.a.id);
    expect(run.outcome).toBe("running");
    expect(run.summary).toMatch(new RegExp(`^${SEND_RETRY_PREFIX} \\(fetch failed \\(ECONNRESET: read ECONNRESET\\)\\); retrying once at `));
    await until(() => t.t3.sent >= 2 && !t.store.getRun(run.id)!.summary.startsWith(SEND_RETRY_PREFIX));
    const after = t.store.getRun(run.id)!;
    expect(t.t3.sent).toBe(2);
    expect(after.outcome).toBe("running");
    expect(after.summary).toMatch(/^Run now: waiting for the persona to wake \(sent on retry after/);
    t.cycle.stop();
  });

  it("the retry fails too: the run is recorded failed, once", async () => {
    const t = await cycleSetup(40);
    t.t3.failures = 2;
    const run = await t.cycle.runNow(t.a.id);
    expect(run.outcome).toBe("running");
    await until(() => t.store.getRun(run.id)!.outcome !== "running");
    const after = t.store.getRun(run.id)!;
    expect(after.outcome).toBe("failed");
    expect(after.summary).toMatch(/^Run now failed after 1 retry: fetch failed/);
    expect(t.t3.sent).toBe(2);
    t.cycle.stop();
  });

  it("an unknown thread (not found) fails at once; sendRetryMs 0 turns the retry off", async () => {
    const t = await cycleSetup(40);
    t.t3.sendToThread = async () => {
      throw new T3Error('t3_thread_send: {"code":"not_found","message":"Thread x not found."}');
    };
    const e = await t.cycle.runNow(t.a.id).catch((x) => x);
    expect(e.code).toBe("t3_error");
    t.cycle.stop();
    db!.close();
    db = undefined;
    const u = await cycleSetup(0);
    u.t3.failures = 1;
    const e2 = await u.cycle.runNow(u.a.id).catch((x) => x);
    expect(e2.code).toBe("t3_error");
    expect(u.store.getRun(e2.details.runId)!.outcome).toBe("failed");
    u.cycle.stop();
  });
});
