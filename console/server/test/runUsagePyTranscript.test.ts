import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createUsageCollector, HostUnavailable, realScanner, toRunUsage, type ScanResult, type Scanner, type UsageHost } from "../src/usage/collector.js";
import { costUsd, priceFor } from "../src/usage/prices.js";

/** tokens per wake (transcript scan, collector, prices, API). Fixture transcripts only; no real text stored. */
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../scripts/run_usage.py");
const SECRET = "TOP-SECRET-MESSAGE-TEXT";

const rid = (n: number) => `run_${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (text: string, ts: string, extra: object = {}) => ({ type: "user", timestamp: ts, message: { role: "user", content: text }, ...extra });
const asst = (id: string, model: string, u: { i?: number; cw?: number; cr?: number; o?: number }, ts: string) => ({
  type: "assistant",
  timestamp: ts,
  message: {
    id,
    model,
    role: "assistant",
    content: [{ type: "text", text: SECRET }],
    usage: { input_tokens: u.i ?? 0, cache_creation_input_tokens: u.cw ?? 0, cache_read_input_tokens: u.cr ?? 0, output_tokens: u.o ?? 0 },
  },
});
const writeJsonl = (file: string, lines: object[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function fixtures() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e8s16-"));
  const seat = path.join(tmp, ".claude_seat1");
  const proj = path.join(seat, "projects", "-home-agent-github-x");
  // 1. A fresh Unblocker wake: first message carries `this run`; one API message written as two lines (same usage).
  writeJsonl(path.join(proj, "aaaa.jsonl"), [
    user(`${SECRET} ## Console protocol (run ${rid(1)})\nConsole API: … · this run ${rid(1)}.`, "2026-10-24T10:00:00Z"),
    asst("msg_1", "claude-opus-5-5", { i: 10, cw: 1000, cr: 0, o: 5 }, "2026-10-24T10:00:01Z"),
    asst("msg_1", "claude-opus-5-5", { i: 10, cw: 1000, cr: 0, o: 50 }, "2026-10-24T10:00:02Z"),
    asst("msg_2", "claude-opus-5-5", { i: 2, cw: 0, cr: 1000, o: 100 }, "2026-10-24T10:00:03Z"),
    // a different model in the same run (multi-model sums)
    asst("msg_3", "claude-sonnet-5-5", { i: 1, cr: 500, o: 10 }, "2026-10-24T10:00:04Z"),
    asst("msg_x", "<synthetic>", { i: 999 }, "2026-10-24T10:00:05Z"),
  ]);
  // Native subagent of that session: belongs to run 1.
  writeJsonl(path.join(proj, "aaaa", "subagents", "agent-1.jsonl"), [
    user("sub task", "2026-10-24T10:00:03Z", { isSidechain: true }),
    asst("msg_s1", "claude-haiku-5-5", { i: 7, o: 3 }, "2026-10-24T10:00:03Z"),
  ]);
  // 2. A home thread holding two wakes (2 then 3), with the owner message between (stays in wake 2's segment).
  writeJsonl(path.join(proj, "bbbb.jsonl"), [
    user(`wake: this run ${rid(2)}.`, "2026-10-24T11:00:00Z"),
    asst("msg_b1", "claude-opus-5-5", { i: 1, o: 1 }, "2026-10-24T11:00:01Z"),
    user("Sam: please also check X", "2026-10-24T11:05:00Z"),
    asst("msg_b2", "claude-opus-5-5", { i: 1, o: 1 }, "2026-10-24T11:05:01Z"),
    user(`wake: this run ${rid(3)}.`, "2026-10-24T12:00:00Z"),
    asst("msg_b3", "claude-opus-5-5", { i: 5, o: 5 }, "2026-10-24T12:00:01Z"),
  ]);
  // 3. A child worker of run 2: its prompt names its own PATCH url and the parent id; counted only for the child.
  writeJsonl(path.join(proj, "cccc.jsonl"), [
    user(`You are a worker. parentRunId ${rid(2)}. When done: curl -X PATCH http://x/api/runs/${rid(4)}`, "2026-10-24T11:10:00Z"),
    asst("msg_c1", "claude-sonnet-5-5", { i: 3, o: 30 }, "2026-10-24T11:10:01Z"),
  ]);
  // 4. A the main server home thread: each wake is a stub; the protocol (with the run id) comes back in the curl's tool result.
  const toolResult = (text: string, ts: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text }] }] } });
  writeJsonl(path.join(proj, "eeee.jsonl"), [
    user("Setup only (agent-team console). Do exactly this", "2026-10-24T08:00:00Z"),
    asst("msg_e0", "claude-opus-5-5", { i: 1000 }, "2026-10-24T08:00:01Z"),
    user("Agent-team console wake for assignment as_1.\nRun `curl …/wake`", "2026-10-24T09:00:00Z"),
    asst("msg_e1", "claude-opus-5-5", { i: 1, o: 10 }, "2026-10-24T09:00:01Z"), // the curl call: belongs to run 6
    toolResult(`${SECRET}\n## Console protocol (run ${rid(6)})\nthis run ${rid(6)}.`, "2026-10-24T09:00:02Z"),
    asst("msg_e2", "claude-opus-5-5", { i: 2, o: 20 }, "2026-10-24T09:00:03Z"),
    toolResult(`[{"id":"${rid(2)}","summary":"older wake"}]`, "2026-10-24T09:00:04Z"), // a runs listing names another run: no switch
    asst("msg_e3", "claude-opus-5-5", { i: 3, o: 30 }, "2026-10-24T09:00:05Z"),
    user("Agent-team console wake for assignment as_1.\nRun `curl …/wake`", "2026-10-24T10:00:00Z"),
    asst("msg_e4", "claude-opus-5-5", { i: 4, o: 40 }, "2026-10-24T10:00:01Z"),
    toolResult(`## Console protocol (run ${rid(7)})`, "2026-10-24T10:00:02Z"),
    asst("msg_e5", "claude-opus-5-5", { i: 5, o: 50 }, "2026-10-24T10:00:03Z"),
  ]);
  // 5. Unrelated session (no run id): ignored.
  writeJsonl(path.join(proj, "dddd.jsonl"), [user("hello", "2026-10-24T09:00:00Z"), asst("msg_d", "claude-opus-5-5", { i: 100 }, "2026-10-24T09:00:01Z")]);
  return { dirs: [seat, path.join(tmp, ".claude_missing")] };
}

describe("run_usage.py transcript scan", () => {
  it("matches by run id, sums per model, dedupes API messages, keeps child runs and wakes of one thread apart", async () => {
    const { dirs } = fixtures();
    const scan = realScanner({ script: SCRIPT, dirs });
    const runs = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: rid(n), since: 0 }));
    const r = await scan.scan("main", runs);
    expect(r[rid(1)]!.models).toEqual({
      "claude-opus-5-5": { input: 12, cacheWrite: 1000, cacheRead: 1000, output: 150, turns: 2 },
      "claude-sonnet-5-5": { input: 1, cacheWrite: 0, cacheRead: 500, output: 10, turns: 1 },
      "claude-haiku-5-5": { input: 7, cacheWrite: 0, cacheRead: 0, output: 3, turns: 1 },
    });
    expect(r[rid(2)]!.models).toEqual({ "claude-opus-5-5": { input: 2, cacheWrite: 0, cacheRead: 0, output: 2, turns: 2 } });
    expect(r[rid(3)]!.models).toEqual({ "claude-opus-5-5": { input: 5, cacheWrite: 0, cacheRead: 0, output: 5, turns: 1 } });
    expect(r[rid(4)]!.models).toEqual({ "claude-sonnet-5-5": { input: 3, cacheWrite: 0, cacheRead: 0, output: 30, turns: 1 } });
    expect(r[rid(5)]).toBeNull();
    // home thread: stub + curl turn + the rest of the wake, until the next stub
    expect(r[rid(6)]!.models).toEqual({ "claude-opus-5-5": { input: 6, cacheWrite: 0, cacheRead: 0, output: 60, turns: 3 } });
    expect(r[rid(7)]!.models).toEqual({ "claude-opus-5-5": { input: 9, cacheWrite: 0, cacheRead: 0, output: 90, turns: 2 } });
  });

  it("never prints message text", async () => {
    const { dirs } = fixtures();
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("python3", ["-I", SCRIPT, JSON.stringify({ runs: [{ id: rid(1), since: 0 }], dirs })], { encoding: "utf8" });
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("Console protocol");
  });

  it("a sandboxed world job's transcript (worlds/.logs/<world>/<run>.jsonl) is that run's, whole, seat sandbox", async () => {
    const { dirs } = fixtures();
    const worlds = path.join(tmp!, "worlds");
    // the job's stub never says `this run`: the file name is the run
    writeJsonl(path.join(worlds, ".logs", "world-a", `${rid(90)}.jsonl`), [
      user(`${SECRET} wake for world-a`, "2026-11-24T16:18:00Z"),
      asst("msg_z1", "claude-opus-5-5", { i: 4, cw: 100, cr: 1000, o: 40 }, "2026-11-24T16:18:01Z"),
      asst("msg_z1", "claude-opus-5-5", { i: 4, cw: 100, cr: 1000, o: 60 }, "2026-11-24T16:18:02Z"),
      asst("msg_z2", "claude-opus-5-5", { i: 1, o: 10 }, "2026-11-24T16:18:03Z"),
    ]);
    const { execFileSync } = await import("node:child_process");
    const run = (ids: string[]) =>
      JSON.parse(execFileSync("python3", ["-I", SCRIPT, JSON.stringify({ runs: ids.map((id) => ({ id, since: 0 })), dirs, worldLogs: worlds })], { encoding: "utf8" }));
    const r = run([rid(90), rid(91)]);
    expect(r[rid(90)]).toEqual({ models: { "claude-opus-5-5": { input: 5, cacheWrite: 100, cacheRead: 1000, output: 70, turns: 2 } }, files: 1, seat: "sandbox" });
    expect(r[rid(91)]).toBeNull();
    expect(r._meta.scan).toBe(3);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("skips files older than the run (mtime filter)", async () => {
    const { dirs } = fixtures();
    const r = await realScanner({ script: SCRIPT, dirs }).scan("main", [{ id: rid(1), since: Date.now() / 1000 + 3600 }]);
    expect(r[rid(1)]).toBeNull();
  });

  it("worker without ssh configured is deferred (HostUnavailable)", async () => {
    await expect(realScanner({ script: SCRIPT, dirs: [] }).scan("worker", [{ id: rid(1), since: 0 }])).rejects.toBeInstanceOf(HostUnavailable);
  });
});

describe("prices", () => {
  it("costs per MTok, family fallback, unknown model has no price", () => {
    expect(costUsd("claude-opus-5-5", { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 })).toBeCloseTo(4);
    expect(costUsd("claude-opus-5-5", { input: 0, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 })).toBeCloseTo(20 + 5 + 0.2);
    expect(costUsd("claude-sonnet-5-5", { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 })).toBeCloseTo(12);
    expect(priceFor("claude-opus-4-8")?.input).toBe(4);
    expect(costUsd("gpt-x", { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 })).toBeUndefined();
  });

  it("toRunUsage sums models, picks the top model and marks the estimate", () => {
    const u = toRunUsage(
      { models: { "claude-opus-5-5": { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0, turns: 2 }, "claude-haiku-5-5": { input: 10, cacheWrite: 0, cacheRead: 0, output: 0, turns: 1 } } },
      "claude-code:main",
      "2026-10-24T00:00:00Z",
    );
    expect(u).toMatchObject({ model: "claude-opus-5-5", input: 1_000_010, turns: 3, estimate: true, source: "claude-code:main" });
    expect(u.costUsd).toBeCloseTo(4.000001);
    expect(toRunUsage({ models: { mystery: { input: 5, cacheWrite: 0, cacheRead: 0, output: 0, turns: 1 } } }, "s", "t").costUsd).toBeNull();
  });
});

function world(host: "main" | "worker" = "main") {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e8s16db-"));
  const db: DB = openDb(path.join(tmp, "console.db"));
  const store = createStore(db);
  const m = store.createMilestone({ title: "Whatgpt", repo: "/x", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Unblocker", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: false, host });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
  return { db, store, m, p, a };
}
const usageCol = (db: DB, id: string) => db.prepare(`SELECT usage, usage_note, usage_checked_at FROM runs WHERE id = ?`).get(id) as { usage: string | null; usage_note: string | null };

class FakeScanner implements Scanner {
  calls: { host: UsageHost; ids: string[] }[] = [];
  result: ScanResult = {};
  asleep = false;
  async scan(host: UsageHost, runs: { id: string; since: number }[]) {
    this.calls.push({ host, ids: runs.map((r) => r.id) });
    if (this.asleep && host === "worker") throw new HostUnavailable("ssh: connect timed out");
    return Object.fromEntries(runs.map((r) => [r.id, this.result[r.id] ?? null]));
  }
}

describe("usage collector", () => {
  const MIN = 60_000;
  it("stores usage for an ended run, leaves running and unsettled runs, zeros a thread-less (skipped) wake", async () => {
    const { db, store, a } = world();
    let t = Date.parse("2026-10-24T12:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const done = store.createRun({ assignmentId: a.id, startedAt: iso(t - 30 * MIN), endedAt: iso(t - 10 * MIN), threadId: "th1", outcome: "progressed", summary: "s" });
    const fresh = store.createRun({ assignmentId: a.id, startedAt: iso(t - 2 * MIN), endedAt: iso(t - 0.5 * MIN), threadId: "th2", outcome: "progressed", summary: "s" });
    const open = store.createRun({ assignmentId: a.id, startedAt: iso(t - 5 * MIN), threadId: "th3", outcome: "running", summary: "" });
    const skipped = store.createRun({ assignmentId: a.id, startedAt: iso(t - 20 * MIN), endedAt: iso(t - 20 * MIN), outcome: "idle", summary: "skipped: previous run still running" });
    const answer = store.createRun({ assignmentId: a.id, startedAt: iso(t - 20 * MIN), endedAt: iso(t - 15 * MIN), threadId: "th1", outcome: "progressed", summary: "", kind: "answer_run" });
    const sc = new FakeScanner();
    sc.result[done.id] = { models: { "claude-opus-5-5": { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, turns: 1 } }, files: 1 };
    const c = createUsageCollector(db, { scanner: sc, now: () => t });
    const r = await c.collect();
    expect(r.collected.sort()).toEqual([done.id, skipped.id].sort());
    expect(sc.calls).toEqual([{ host: "main", ids: expect.arrayContaining([done.id, skipped.id]) }]);
    expect(sc.calls[0].ids).not.toContain(fresh.id);
    expect(sc.calls[0].ids).not.toContain(open.id);
    expect(sc.calls[0].ids).not.toContain(answer.id);
    expect(JSON.parse(usageCol(db, done.id).usage!)).toMatchObject({ model: "claude-opus-5-5", input: 1, cacheWrite: 2, cacheRead: 3, output: 4, turns: 1, source: "claude-code:main", estimate: true });
    expect(JSON.parse(usageCol(db, skipped.id).usage!)).toMatchObject({ input: 0, output: 0, costUsd: 0, source: "no-thread" });
    t += 5 * MIN; // fresh is settled now
    await c.collect();
    expect(sc.calls.at(-1)!.ids).toEqual([fresh.id]);
  });

  it("missing transcript: usage stays null with a note and is retried after retryMs", async () => {
    const { db, store, a } = world();
    let t = Date.parse("2026-10-24T12:00:00Z");
    const run = store.createRun({ assignmentId: a.id, startedAt: new Date(t - 30 * MIN).toISOString(), endedAt: new Date(t - 10 * MIN).toISOString(), threadId: "th", outcome: "progressed", summary: "" });
    const sc = new FakeScanner();
    const c = createUsageCollector(db, { scanner: sc, now: () => t, retryMs: 10 * MIN });
    expect((await c.collect()).missing).toEqual([run.id]);
    expect(usageCol(db, run.id)).toMatchObject({ usage: null, usage_note: expect.stringMatching(/^missing/) });
    t += 5 * MIN;
    await c.collect();
    expect(sc.calls).toHaveLength(1); // not yet due
    t += 6 * MIN;
    sc.result[run.id] = { models: { "claude-sonnet-5-5": { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, turns: 1 } }, files: 1 };
    expect((await c.collect()).collected).toEqual([run.id]);
    expect(usageCol(db, run.id).usage_note).toBeNull();
  });

  it("worker asleep: deferred (note) and read on a later sweep; main runs are not held up", async () => {
    const v3 = world("worker");
    let t = Date.parse("2026-10-24T12:00:00Z");
    const run = v3.store.createRun({ assignmentId: v3.a.id, startedAt: new Date(t - 30 * MIN).toISOString(), endedAt: new Date(t - 10 * MIN).toISOString(), threadId: "th", outcome: "progressed", summary: "" });
    const sc = new FakeScanner();
    sc.asleep = true;
    sc.result[run.id] = { models: { "claude-opus-5-5": { input: 9, cacheWrite: 0, cacheRead: 0, output: 9, turns: 1 } }, files: 1 };
    const c = createUsageCollector(v3.db, { scanner: sc, now: () => t });
    expect((await c.collect()).deferred).toEqual([run.id]);
    expect(usageCol(v3.db, run.id)).toMatchObject({ usage: null, usage_note: expect.stringMatching(/^deferred: worker/) });
    sc.asleep = false;
    t += 11 * MIN;
    expect((await c.collect()).collected).toEqual([run.id]);
    expect(sc.calls.map((x) => x.host)).toEqual(["worker", "worker"]);
  });

  it("gives up on runs older than maxAgeMs", async () => {
    const { db, store, a } = world();
    const t = Date.parse("2026-10-24T12:00:00Z");
    store.createRun({ assignmentId: a.id, startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T01:00:00Z", threadId: "th", outcome: "progressed", summary: "" });
    const sc = new FakeScanner();
    await createUsageCollector(db, { scanner: sc, now: () => t }).collect();
    expect(sc.calls).toHaveLength(0);
  });
});

describe("usage API", () => {
  async function app() {
    const w = world();
    const p2 = w.store.createPersona({ name: "Delivery manager", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const a2 = w.store.createAssignment({ milestoneId: w.m.id, personaId: p2.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const sc = new FakeScanner();
    const application = createApp(w.db, { browser: { browserUrl: "http://127.0.0.1:9" }, usage: { scanner: sc, settleMs: 0 } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await application.request(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    return { ...w, a2, sc, call };
  }

  it("run objects carry usage once collected (run-end hook), and the totals group by persona, milestone and day", async () => {
    const w = await app();
    const now = Date.now();
    const run = w.store.createRun({ assignmentId: w.a.id, startedAt: new Date(now - 60_000).toISOString(), threadId: "th", outcome: "running", summary: "" });
    w.sc.result[run.id] = { models: { "claude-opus-5-5": { input: 1000, cacheWrite: 0, cacheRead: 0, output: 1_000_000, turns: 3 }, }, files: 1 };
    expect((await w.call("PATCH", `/api/runs/${run.id}`, { outcome: "idle", summary: "done", endedAt: new Date().toISOString() })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_500)); // settleMs 0 + 1 s margin in runEnded
    const got = (await w.call("GET", `/api/runs/${run.id}`)).json;
    expect(got.usage).toMatchObject({ input: 1000, output: 1_000_000, turns: 3, estimate: true });
    expect(got.usage.costUsd).toBeCloseTo(20.004);
    expect((await w.call("GET", `/api/runs?limit=5`)).json[0].usage.output).toBe(1_000_000);
    // A skipped wake of the other persona (no thread): 0, counted as skipped.
    w.store.createRun({ assignmentId: w.a2.id, startedAt: new Date(now - 30_000).toISOString(), endedAt: new Date(now - 30_000).toISOString(), outcome: "idle", summary: "skipped" });
    w.db.prepare(`UPDATE runs SET usage = ? WHERE thread_id IS NULL`).run(JSON.stringify(toRunUsage(null, "no-thread", new Date().toISOString())));
    const byPersona = (await w.call("GET", `/api/usage?groupBy=persona`)).json;
    expect(byPersona.groups.map((g: { label: string }) => g.label)).toEqual(["Unblocker", "Delivery manager"]);
    expect(byPersona.groups[1]).toMatchObject({ runs: 1, collected: 1, skipped: 1, output: 0, costUsd: 0 });
    expect(byPersona.total).toMatchObject({ runs: 2, collected: 2, output: 1_000_000 });
    const byMilestone = (await w.call("GET", `/api/usage?groupBy=milestone`)).json;
    expect(byMilestone.groups).toEqual([expect.objectContaining({ label: "Whatgpt", runs: 2 })]);
    const byDay = (await w.call("GET", `/api/usage?groupBy=day&from=${new Date(now - 7 * 86400_000).toISOString()}`)).json;
    expect(byDay.groups.reduce((n: number, g: { runs: number }) => n + g.runs, 0)).toBe(2);
    // window excludes old runs
    const old = (await w.call("GET", `/api/usage?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`)).json;
    expect(old.total.runs).toBe(0);
    expect((await w.call("GET", `/api/usage?groupBy=bogus`)).status).toBe(400);
    expect((await w.call("GET", `/api/usage?from=yesterday`)).status).toBe(400);
  });

  it("an uncollected run counts as pending, not as zero", async () => {
    const w = await app();
    const now = Date.now();
    w.store.createRun({ assignmentId: w.a.id, startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 30_000).toISOString(), threadId: "th", outcome: "idle", summary: "" });
    const t = (await w.call("GET", `/api/usage`)).json.total;
    expect(t).toMatchObject({ runs: 1, collected: 0, pending: 1, output: 0 });
  });
});
