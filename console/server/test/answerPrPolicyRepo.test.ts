import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { SETTLE_MS } from "../src/inbox/routes.js";
import { WRITTEN_BY_ASKER, isPolicySkip, pendingNote, settleWritten } from "../src/inbox/pending.js";

/**
 * an answer in a repo whose Integration policy needs a PR never left `queued` (the memory service, answered
 * 2026-10-25 03:21Z; the asker wrote the line through its own PR f9e26a3, the card still said queued a week later).
 * Now: delivered once the asker's wake has it, sent once the spine shows the line; the console still never pushes there.
 */

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const ASK = "- [ask PLAN-6-A1: decide @Sam since 2026-10-24 row S4] Should `health.memo.example.com` be public? — options: yes | no — recommend: no — unblocks: S4";
/** `actedOn`: the trailing segment the real the memory service line carries (the card reads it into the question; the settle matches by code). */
const ANSWERED = (done = "", actedOn = "") =>
  `- [answered PLAN-6-A1 2026-10-25 @Sam${done}] Should \`health.memo.example.com\` be public? — answer: no, internal only${actedOn}`;
const spine = (line: string) => `# PLAN-6: health page

Spine ID: memo-health
Integration policy: main-direct via self-merged CI-gated PR (main requires the ci check)

## Current State

Status: active
Waiting on: Sam (PLAN-6-A1)

## Waiting on

${line}

## Issue Ledger

| Issue | Role | Owner | Title | Status |
|---|---|---|---|---|
| S4 | Ticket worker | unassigned | health page | blocked |
`;
const REL = "docs/PLAN-6.md";

class FakeT3 {
  calls: { op: string; args: any }[] = [];
  private n = 0;
  async listProjects() {
    return [{ id: "p_memo", title: "memo", workspaceRoot: "/x/memo", repositoryIdentity: { displayName: "acme-ai/memo" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    this.calls.push({ op: "launchThread", args: input });
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

let tmp: string;
let origin: string;
let repo: string;
let db: DB;
let t3: FakeT3;
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s40-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, REL, spine(ASK));
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "ask"]);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "memo");
  git(tmp, ["clone", "-q", origin, repo]);
  db = openDb(path.join(tmp, "console.db"));
  t3 = new FakeT3();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A console process on the shared db (a second one = a restart, e.g. the deploy). */
const boot = () => {
  const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, {
    read: readCfg,
    cycle: {
      enabled: true,
      t3: t3 as unknown as T3Client,
      dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" }), done: async () => {} } as unknown as Dispatcher,
      publicUrl: "http://console.test",
    },
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call };
};

async function seed(call: ReturnType<typeof boot>["call"]) {
  const m = (await call("POST", "/api/milestones", { title: "Memo health", repo: "acme-ai/memo", path: REL })).json;
  const p = (await call("POST", "/api/personas", { name: "Epic Spine health", remit: "keeps the spine", model: "opus" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
  const item = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "PLAN-6-A1");
  expect(item).toMatchObject({ state: "open", source: "ask" });
  return { m, a, item };
}

/** The asker's own PR merged: the answered line lands on origin/main and the console's checkout pulls it. */
const askerPrMerges = (line: string) => {
  const w = path.join(tmp, "asker");
  git(tmp, ["clone", "-q", origin, w]);
  put(w, REL, spine(line));
  git(w, ["commit", "-q", "-am", "Merge pull request #1434 from acme-ai/wt/e6-a1-answer"]);
  git(w, ["push", "-q", "origin", "main"]);
  git(repo, ["pull", "-q", "--ff-only", "origin", "main"]);
};
const row = (id: string) => db.prepare("SELECT delivery, delivery_error, spine_status, spine_reason, spine_at, wake_status FROM jordi_responses WHERE id = ?").get(id) as any;

describe("T6-S40 an answer in a PR-policy repo leaves queued", () => {
  it("the console does not push; the woken asker makes it delivered ('spine line pending in memo PR'); its PR merging makes it sent", async () => {
    const { call } = boot();
    const { m, item } = await seed(call);
    const head = git(origin, ["rev-parse", "main"]);
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "no, internal only", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(isPolicySkip(r.json.spine.reason)).toBe(true);
    expect(r.json).toMatchObject({ delivery: "delivered", deliveryError: pendingNote("memo"), spine: { status: "skipped" }, wake: { notified: "woken" } });
    expect(r.json.deliveryError).toBe("delivered, spine line pending in memo PR");
    expect(r.json.deliveredAt).toBeTruthy();
    // Nothing pushed, nothing written in the checkout; the wake prompt told the asker to write the line itself.
    expect(git(origin, ["rev-parse", "main"])).toBe(head);
    expect(fs.readFileSync(path.join(repo, REL), "utf8")).toBe(spine(ASK));
    expect(t3.calls.find((c) => c.op === "launchThread")!.args.message).toContain("could not write this answer into the spine");

    // A Retry (re-delivery) while the PR is pending keeps it delivered (not back to queued).
    const again = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(again.json).toMatchObject({ delivery: "delivered", spine: { status: "skipped" } });

    // The asker's PR merges; the next inbox read (after the throttle) sees the line: sent, spine written by the asker.
    askerPrMerges(ANSWERED());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SETTLE_MS + 1_000);
    const list = (await call("GET", `/api/owner-responses?milestoneId=${m.id}`)).json as any[];
    expect(list[0]).toMatchObject({ id: r.json.id, delivery: "sent", spine: { status: "written", reason: WRITTEN_BY_ASKER } });
    expect(list[0].deliveryError).toBeUndefined();
    const card = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "PLAN-6-A1");
    expect(card).toMatchObject({ state: "answered", response: { delivery: "sent" } });
    const act = (await call("GET", `/api/owner-activity?milestoneId=${m.id}`)).json as any[];
    expect(act[0]).toMatchObject({ type: "response", delivery: "sent", spine: { status: "written" } });
  });

  it("Wake unticked: the asker does not have it, so it stays queued (with Retry) until the line shows up", async () => {
    const { call } = boot();
    const { m, item } = await seed(call);
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "no", milestoneId: m.id, wake: false });
    expect(r.json).toMatchObject({ delivery: "queued", spine: { status: "skipped" }, wake: { notified: "off" } });
    expect(isPolicySkip(r.json.deliveryError)).toBe(true);
  });

  it("restart repair (the stuck Memo card): a queued row whose line is in the spine, done-marked, becomes sent with the done date; an older woken one still pending becomes delivered", async () => {
    const { call } = boot();
    const { m, a, item } = await seed(call);
    const reason = "Integration policy mentions a PR or CI (“main-direct via self-merged CI-gated PR”): the console does not push";
    const ins = db.prepare(
      `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, assignment_id, delivery, delivery_error, created_at, spine_status, spine_reason, spine_path, wake_status, wake_reason)
       VALUES (?, ?, ?, ?, 'answer', 'no, internal only', ?, 'queued', ?, ?, 'skipped', ?, ?, ?, ?)`,
    );
    // Like jr_61d1934f (woken) and jr_67caed49 (wake skipped), both still queued.
    ins.run("jr_old_woken", item.id, m.id, JSON.stringify(item), a.id, reason, "2026-10-24T21:55:30.994Z", reason, REL, "woken", null);
    ins.run("jr_old_skipped", item.id, m.id, JSON.stringify(item), a.id, reason, "2026-10-25T03:21:57.921Z", reason, REL, "skipped", `the answer is not in the spine yet (${reason})`);

    // Before the asker's PR: a restart marks the woken one delivered; the skipped one (asker never got it) stays queued.
    boot();
    expect(row("jr_old_woken")).toMatchObject({ delivery: "delivered", delivery_error: pendingNote("memo"), spine_status: "skipped" });
    expect(row("jr_old_skipped")).toMatchObject({ delivery: "queued", spine_status: "skipped" });

    // The asker wrote and consumed the line (PR #1434 f9e26a3, then "· done 2026-10-25 f9e26a3"); the deploy restarts the console.
    askerPrMerges(ANSWERED(" · done 2026-10-25 f9e26a3", " — acted on: S4 is tailnet-only"));
    const { call: call2 } = boot();
    for (const id of ["jr_old_woken", "jr_old_skipped"])
      expect(row(id)).toMatchObject({ delivery: "sent", delivery_error: null, spine_status: "written", spine_reason: WRITTEN_BY_ASKER, spine_at: "2026-10-25T00:00:00.000Z" });
    const list = (await call2("GET", `/api/owner-responses?milestoneId=${m.id}`)).json as any[];
    expect(list.filter((r) => r.delivery !== "sent")).toEqual([]);
  });

  it("settleWritten leaves alone: a line still open, a persona request, a checkout it cannot find", async () => {
    const { call } = boot();
    const { m, item } = await seed(call);
    const ins = db.prepare(
      `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, delivery, created_at, spine_status, spine_reason, spine_path) VALUES (?, ?, ?, ?, 'answer', 'x', 'queued', ?, 'skipped', 'r: the console does not push', ?)`,
    );
    ins.run("jr_open", item.id, m.id, JSON.stringify(item), "2026-10-31T00:00:00.000Z", REL);
    ins.run("jr_nj", "nj_1", m.id, JSON.stringify({ ...item, source: "needs_jordi" }), "2026-10-31T00:00:00.000Z", REL);
    const other = (await call("POST", "/api/milestones", { title: "elsewhere", repo: "acme-ai/gone", path: REL })).json;
    ins.run("jr_norepo", item.id, other.id, JSON.stringify(item), "2026-10-31T00:00:00.000Z", REL);
    expect(settleWritten(db, (id) => (id === m.id ? repo : undefined))).toEqual([]);
    askerPrMerges(ANSWERED());
    expect(settleWritten(db, (id) => (id === m.id ? repo : undefined))).toEqual(["jr_open"]);
    expect(row("jr_nj").delivery).toBe("queued");
    expect(row("jr_norepo").delivery).toBe("queued");
  });
});
