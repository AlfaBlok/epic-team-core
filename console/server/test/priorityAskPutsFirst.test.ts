import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { parseAsks } from "../src/inbox/asks.js";
import { isPriorityLabel, moveFirstText, pursuitsDirFor, saysYes } from "../src/inbox/priorityAsk.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/**
 * the owner, an accepted rule (vn_cdcf1208): his order of work changes only when he edits his
 * objectives; when a note names a new first thing the team asks him one line, "Put X first in your objectives?", pinned
 * first in his inbox. His Yes moves X to the top of docs/pursuits.json (the one objectives file); his No closes it.
 */
const PURSUITS = { version: 1, pursuits: [{ id: "testers", title: "Five testers" }, { id: "passwords", title: "Passwords" }, { id: "team-browser", title: "Team browser" }] };
const ASK_YES = "- [ask E909-A7: approve @Sam since 2026-11-15 row E909-S1] Put Team browser first in your objectives? — label: priority — objective: team-browser — context: your voice note vn_cdcf1208 said the browser comes first now — recommend: yes, as your note said — unblocks: E909-S1";
const ASK_NO = "- [ask E909-A8: approve @Sam since 2026-11-15 row E909-S1] Put Passwords first in your objectives? — label: priority — objective: passwords — context: your voice note vn_cdcf1209 named passwords — recommend: yes — unblocks: E909-S1";

describe("the priority ask line", () => {
  it("reads its label and objective, and keeps them out of the question", () => {
    const [a] = parseAsks(`## Waiting on\n\n${ASK_YES}\n`);
    expect(a.putFirst).toEqual({ objective: "team-browser" });
    expect(a.ask).toBe("approve");
    expect(a.question).toBe("Put Team browser first in your objectives?");
    expect(a.recommend).toBe("yes, as your note said");
  });
  it("an objective field without the label stays plain text; the label alone is no priority ask", () => {
    const [a] = parseAsks(`## Waiting on\n\n${ASK_YES.replace(" — label: priority", "")}\n`);
    expect(a.putFirst).toBeUndefined();
    expect(a.question).toContain("objective: team-browser");
    const [b] = parseAsks(`## Waiting on\n\n${ASK_YES.replace(" — objective: team-browser", "")}\n`);
    expect(b.putFirst).toBeUndefined();
    expect(isPriorityLabel("Priority")).toBe(true);
    expect(isPriorityLabel("needs Mac agent")).toBe(false);
  });
  it("moves one objective to the top and keeps the rest in his order", () => {
    const out = moveFirstText(JSON.stringify(PURSUITS), "team-browser");
    expect(typeof out === "string" && JSON.parse(out).pursuits.map((p: { id: string }) => p.id)).toEqual(["team-browser", "testers", "passwords"]);
    expect(moveFirstText(JSON.stringify(PURSUITS), "testers")).toBe("same");
    expect(moveFirstText(JSON.stringify(PURSUITS), "house")).toBeNull();
  });
  it("Yes is the approve button or a plain answer that says yes", () => {
    expect(saysYes("approve", "")).toBe(true);
    expect(saysYes("answer", "Yes, put it first")).toBe(true);
    expect(saysYes("answer", "No")).toBe(false);
    expect(saysYes("deny", "yes")).toBe(false);
  });
});

// ---------- the route: his Yes on the card ----------

const PAGE = { "Sec-Fetch-Site": "same-origin" };
const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const SPINE = `# EPIC-909: Test world

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam: E909-A7, E909-A8

## Waiting on

${ASK_YES}
${ASK_NO}

## Issue Ledger

| Issue | Role | Owner | Title | Status | Depends on | Next action | Evidence |
|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | unassigned | Ask what comes first | blocked | none | none | x |
`;

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
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s107-"));
});
afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("API: Yes on a priority ask puts the objective first; No changes nothing", () => {
  it("writes the answer, then one commit with the objective first in the test world's objectives file", async () => {
    const origin = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(tmp, "seed");
    git(tmp, ["clone", "-q", origin, seed]);
    git(seed, ["checkout", "-q", "-b", "main"]);
    put(seed, "docs/spines/root.md", SPINE);
    put(seed, "docs/pursuits.json", JSON.stringify(PURSUITS, null, 2) + "\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "asks"]);
    git(seed, ["push", "-q", "origin", "main"]);
    const repo = path.join(tmp, "inbox");
    git(tmp, ["clone", "-q", origin, repo]);
    expect(pursuitsDirFor(repo, undefined)).toBe(repo);
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
    const order = () => {
      git(repo, ["pull", "-q", "--ff-only"]);
      return (JSON.parse(fs.readFileSync(path.join(repo, "docs/pursuits.json"), "utf8")).pursuits as { id: string }[]).map((p) => p.id);
    };
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const items = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    const by = (code: string) => items.find((i) => i.code === code);
    expect(by("E909-A7").putFirst).toEqual({ objective: "team-browser" });
    expect(by("E909-A8").putFirst).toEqual({ objective: "passwords" });

    // No first: closes the ask, the order stays his
    const no = await call("POST", `/api/waiting-on-owner/${by("E909-A8").id}/respond`, { kind: "deny", text: "not now", milestoneId: m.id });
    expect(no.status).toBe(201);
    expect(order()).toEqual(["testers", "passwords", "team-browser"]);

    const yes = await call("POST", `/api/waiting-on-owner/${by("E909-A7").id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    expect(yes.status).toBe(201);
    expect(order()).toEqual(["team-browser", "testers", "passwords"]);
    expect(git(repo, ["log", "-1", "--format=%s"])).toMatch(/team-browser first in the objectives \(E909-A7\)/);
    const spine = fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8");
    expect(spine).toMatch(/- \[answered E909-A7 [\d-]+ @Sam\] Put Team browser first/);
    expect(spine).toMatch(/- \[answered E909-A8 [\d-]+ @Sam\] Put Passwords first/);
    const got = ((await call("GET", `/api/owner-responses?milestoneId=${m.id}`)).json as any[]).find((x) => x.id === yes.json.id);
    expect(got.item.priorityMoved).toMatch(/^first in docs\/pursuits\.json/);
  });
});
