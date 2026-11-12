import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { addAcceptedAskRow, goalOfAsk, recommendationTitle } from "../src/review/followups.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/**
 * Accept all on a persona's set of recommendations, next to accept one,
 * ask a question back or say no; each accepted one becomes a ready row the team delivers (his accept the ready stamp, L-37).
 */
const LEDGER = `## Issue Ledger

| Issue | Role | Owner | Title | Status | Depends on | Next action | Evidence |
|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | unassigned | Write the reader | done | none | none | x |

## Decisions

| Date | Outcome | Decision | Summary | Evidence | Revisit |
|---|---|---|---|---|---|
| 2026-10-20 | accepted | start | s | e | never |
`;

describe("addAcceptedAskRow", () => {
  it("adds one ready row naming the ask and a Decisions row, once", () => {
    const text = `# EPIC-909: x\n\n${LEDGER}`;
    const a = addAcceptedAskRow(text, { code: "E909-A4", question: "You approve: one scoreboard on your home?", persona: "Advisor" }, "2026-11-11");
    if ("skip" in a) throw new Error(a.skip);
    expect(a.ref).toBe("E909-S2");
    expect(a.text).toContain("| E909-S2 | Ticket worker | unassigned | one scoreboard on your home (Advisor's recommendation): Sam accepted it in E909-A4, deliver it. | ready | none | worker | Sam accepted E909-A4 2026-11-11 on the console |");
    expect(a.text).toMatch(/\| 2026-11-11 \| accepted \| E909-S2 ready: Sam accepted E909-A4 \(Advisor's recommendation\) \(root L-37\): one scoreboard on your home \|/);
    const again = addAcceptedAskRow(a.text, { code: "E909-A4", question: "x" }, "2026-11-12");
    expect(again).toEqual({ skip: "row E909-S2 is there already for E909-A4" });
    // another ask whose code starts the same still gets its own row
    expect("ref" in addAcceptedAskRow(a.text, { code: "E909-A41", question: "y" }, "2026-11-12")).toBe(true);
  });
  it("names the goal from the ask code; refuses a spine with no ledger", () => {
    expect(goalOfAsk("E948-A9")).toBe("EPIC-948");
    expect(goalOfAsk("ROOT-A2")).toBe("ROOT");
    expect(goalOfAsk(undefined)).toBeUndefined();
    expect(recommendationTitle("You approve: **park** the work?")).toBe("park the work");
    expect(addAcceptedAskRow("# x\n", { code: "E909-A1", question: "q" }, "2026-11-11")).toEqual({ skip: "the spine of E909-A1 has no Issue Ledger table" });
  });
});

// ---------- the route: approve with asRow ----------

const PAGE = { "Sec-Fetch-Site": "same-origin" };
const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[], at?: string) => execFileSync("git", args, { cwd, env: at ? { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const SPINE = `# EPIC-909: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam: E909-A2, E909-A3, E909-A5

## Waiting on

- [ask E909-A2: approve @Sam since 2026-10-20] You approve: one scoreboard on your home? — context: Why: you see the red lines at a glance
- [ask E909-A3: approve @Sam since 2026-10-20] You approve: a weekly tester mail? — context: Why: testers come back
- [ask E909-A5: approve @Sam since 2026-10-20] You approve: a third product? — context: Why: more data

${LEDGER}`;

class FakeT3 {
  async listProjects() {
    return [{ id: "mcp:inbox", title: "inbox", workspaceRoot: "/nowhere/inbox", repositoryIdentity: { displayName: "acme/inbox" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    return { threadId: "thread_1" };
  }
  async sendToThread() {}
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

let tmp: string;
let db: DB | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s42-"));
});
afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("API: Accept on a recommendation makes a ready row", () => {
  it("approve with asRow writes the answered line and a ready row; a plain approve and a No add none", async () => {
    const origin = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(tmp, "seed");
    git(tmp, ["clone", "-q", origin, seed]);
    git(seed, ["checkout", "-q", "-b", "main"]);
    put(seed, "docs/spines/root.md", SPINE);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "asks"], "2026-10-20T10:00:00.000Z");
    git(seed, ["push", "-q", "origin", "main"]);
    const repo = path.join(tmp, "inbox");
    git(tmp, ["clone", "-q", origin, repo]);
    db = openDb(path.join(tmp, "console.db"));
    const app = createApp(db, {
      read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
      cycle: { enabled: true, t3: new FakeT3() as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? PAGE : { "Content-Type": "application/json", ...PAGE }, body: body === undefined ? undefined : JSON.stringify(body) }, local);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const file = () => {
      git(repo, ["pull", "-q", "--ff-only"]);
      return fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8");
    };
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" });
    const adv = (await call("POST", "/api/personas", { name: "Advisor", remit: "recommends", model: "opus" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: adv.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    await call("POST", "/api/runs", { assignmentId: a.id, outcome: "progressed", startedAt: "2026-10-20T09:00:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
    const items = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    const by = (code: string) => items.find((i) => i.code === code);
    // the set is built from these: the Advisor wrote them
    expect(by("E909-A2").asker).toMatchObject({ personaName: "Advisor", via: "ask" });

    const r2 = await call("POST", `/api/waiting-on-owner/${by("E909-A2").id}/respond`, { kind: "approve", text: "", milestoneId: m.id, asRow: true });
    expect(r2.status).toBe(201);
    const r3 = await call("POST", `/api/waiting-on-owner/${by("E909-A3").id}/respond`, { kind: "approve", text: "", milestoneId: m.id, asRow: true });
    expect(r3.status).toBe(201);
    const r5 = await call("POST", `/api/waiting-on-owner/${by("E909-A5").id}/respond`, { kind: "deny", text: "not now", milestoneId: m.id, asRow: true });
    expect(r5.status).toBe(201);
    const text = file();
    expect(text).toMatch(/- \[answered E909-A2 [\d-]+ @Sam\] You approve: one scoreboard/);
    expect(text).toMatch(/\| E909-S2 \| Ticket worker \| unassigned \| one scoreboard on your home \(Advisor's recommendation\): Sam accepted it in E909-A2, deliver it\. \| ready \|/);
    expect(text).toMatch(/\| E909-S3 \| Ticket worker \| unassigned \| a weekly tester mail \(Advisor's recommendation\): Sam accepted it in E909-A3, deliver it\. \| ready \|/);
    expect(text).not.toMatch(/accepted it in E909-A5/);
    expect(text.match(/\| ready \|/g)).toHaveLength(2);
    // the card hears which row it made
    const got = ((await call("GET", `/api/owner-responses?milestoneId=${m.id}`)).json as any[]).find((x) => x.id === r2.json.id);
    expect(got.item.readyRow ?? got.item.readyRowError).toBe("E909-S2");
  });
});
