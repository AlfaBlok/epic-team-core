import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createReview } from "../src/review/review.js";
import { denyCell, relaunchCell, RELAUNCH_CELL_MAX } from "../src/review/rows.js";
import { cardFilesLine, createAttachments, splitCardFiles } from "../src/desk/attachments.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * files sent from a card's box (Answer, Changes wanted, Decline) go with the answer as one line of links after
 * his words: in the spine answer line, the reopened row's status, and the wake or brief of the agent who reads it.
 */
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

let tmp: string;
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s11r2-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the files line of a card answer", () => {
  it("follows his words on one line, one link per file, no round brackets", () => {
    const db = openDb(":memory:");
    const atts = createAttachments({ db, dir: path.join(tmp, "files"), world: () => "acme", publicUrl: "https://team.example/" });
    const a = atts.add(PNG, "image/png", "Screenshot 2026-11-08 at 20.01.png");
    const b = atts.add(PNG, "image/png", "phone.png");
    const t = atts.cardText("the button is too small", [a.id, b.id, a.id]);
    expect(t).toBe(`the button is too small ${cardFilesLine([`https://team.example${a.path}`, `https://team.example${b.path}`])}`);
    expect(t).not.toMatch(/[()\n]/);
    expect(t).toContain("📎 Sam attached 2 files, open each with your console headers: https://team.example/api/chat/attachments/att_");
    // files alone are an answer too
    expect(atts.cardText("", [b.id])).toBe(`📎 Sam attached a file, open it with your console headers: https://team.example${b.path}`);
    expect(splitCardFiles(t)).toEqual({ words: "the button is too small", files: t.slice("the button is too small ".length) });
    expect(() => atts.cardText("x", ["att_000000000000"])).toThrow(/no attachment/);
    // another world's file is not found
    const other = createAttachments({ db, dir: path.join(tmp, "files"), world: () => "social", publicUrl: "https://team.example" });
    expect(() => other.cardText("x", [a.id])).toThrow(/no attachment/);
    db.close();
  });

  it("a status cell shortens his words but keeps the files line whole", () => {
    const files = cardFilesLine(["https://team.example/api/chat/attachments/att_0123456789ab/shot.png"]);
    const long = `${"word ".repeat(100)}(see)`;
    const cell = relaunchCell("T1-S1", "2026-11-08", `${long} ${files}`, "Sam", 2)("review") as string;
    expect(cell).toMatch(/^active \(iteration 2, relaunched by Sam 2026-11-08: (word ){20,}.*… 📎 Sam attached a file, open it with your console headers: https:\/\/team\.example\/api\/chat\/attachments\/att_0123456789ab\/shot\.png\)$/);
    expect(cell.length).toBeLessThan(RELAUNCH_CELL_MAX + files.length + 80);
    expect(denyCell("T1-S1", "2026-11-08", files)("review")).toBe(`superseded (denied by Sam 2026-11-08: ${files})`);
    expect(relaunchCell("T1-S1", "2026-11-08", "short (words)")("review")).toBe("active (relaunched by Sam 2026-11-08: short [words])");
  });
});

// ---------- an ask in the inbox: Answer / Changes wanted with a pasted screenshot ----------

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[], at?: string) => execFileSync("git", args, { cwd, env: at ? { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const A2 = "- [ask T9-A2: approve @Sam since 2026-10-20 row T5] Approve the two mockups? — recommend: yes — context: notes.md";
const A3 = "- [ask T9-A3: provide @Sam since 2026-10-20] Which screen looks wrong? — context: notes.md";
const SPINE = `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam: T9-A2, T9-A3

## Waiting on

${A2}
${A3}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T5 | Mockups and logos | Sam go | done (fed T9-A2) |
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

describe("API: a card's answer carries the files pasted into its box", () => {
  let db: DB;
  afterEach(() => db?.close());
  const setup = () => {
    const origin = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(tmp, "seed");
    git(tmp, ["clone", "-q", origin, seed]);
    git(seed, ["checkout", "-q", "-b", "main"]);
    put(seed, "docs/spines/root.md", SPINE);
    put(seed, "docs/spines/notes.md", "# notes\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "asks"], "2026-10-20T10:00:00.000Z");
    git(seed, ["push", "-q", "origin", "main"]);
    const repo = path.join(tmp, "inbox");
    git(tmp, ["clone", "-q", origin, repo]);
    db = openDb(path.join(tmp, "console.db"));
    const app = createApp(db, {
      read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
      chatAttachmentsDir: path.join(tmp, "chat-attachments"),
      cycle: { enabled: true, t3: new FakeT3() as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? PAGE : { "Content-Type": "application/json", ...PAGE }, body: body === undefined ? undefined : JSON.stringify(body) }, local);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const upload = async (name: string) => {
      const res = await app.request("/api/chat/attachments", { method: "POST", headers: { "content-type": "image/png", "x-filename": encodeURIComponent(name), ...PAGE }, body: PNG as Uint8Array<ArrayBuffer> }, local);
      expect(res.status).toBe(201);
      return ((await res.json()) as { attachment: { id: string; path: string } }).attachment;
    };
    const file = () => {
      git(repo, ["pull", "-q", "--ff-only"]);
      return fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8");
    };
    return { call, upload, file, app };
  };
  const seedMilestone = async (call: ReturnType<typeof setup>["call"]) => {
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    await call("POST", "/api/runs", { assignmentId: a.id, outcome: "progressed", startedAt: "2026-10-20T09:00:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
    const items = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    return { m, a, items };
  };

  it("Changes wanted with a pasted screenshot: the [feedback] line, the reopened row and the wake carry its link", async () => {
    const { call, upload, file, app } = setup();
    const { m, a, items } = await seedMilestone(call);
    const shot = await upload("image.png");
    const a2 = items.find((i) => i.code === "T9-A2");
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "feedback", text: "the logo is cut off", attachments: [shot.id], milestoneId: m.id });
    expect(r.status).toBe(201);
    const link = `http://console.test${shot.path}`;
    expect(r.json.text).toBe(`the logo is cut off ${cardFilesLine([link])}`);
    const text = file();
    expect(text).toContain(`— feedback: the logo is cut off 📎 Sam attached a file, open it with your console headers: ${link}`);
    expect(text).toMatch(new RegExp(`\\| T5 \\| Mockups and logos \\| Sam go \\| active \\(feedback T9-A2 by Sam [\\d-]+, round 2: the logo is cut off 📎 .*${link.replace(/[.]/g, "\\.")}\\) \\|`));
    const run = ((await call("GET", `/api/runs?assignmentId=${a.id}`)).json as any[]).find((x) => x.id === r.json.wake.runId);
    expect(run.instructions).toContain(link);
    // the agent who reads it opens the file (same world, its console headers)
    const got = await app.request(shot.path, { headers: PAGE }, local);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
  });

  it("an Answer of files alone is an answer; an unknown file changes nothing", async () => {
    const { call, upload, file } = setup();
    const { m, items } = await seedMilestone(call);
    const a3 = items.find((i) => i.code === "T9-A3");
    const bad = await call("POST", `/api/waiting-on-owner/${a3.id}/respond`, { kind: "answer", text: "this one", attachments: ["att_000000000000"], milestoneId: m.id });
    expect(bad.status).toBe(404);
    expect(bad.json.error.code).toBe("not_found");
    expect(file()).toContain(A3);
    const shot = await upload("screen.png");
    const r = await call("POST", `/api/waiting-on-owner/${a3.id}/respond`, { kind: "answer", text: "", attachments: [shot.id], milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(file()).toMatch(/- \[answered T9-A3 [\d-]+ @Sam\] Which screen looks wrong\? .* — answer: 📎 Sam attached a file, open it with your console headers: http:\/\/console\.test\/api\/chat\/attachments\/att_\w+\/screen\.png$/m);
  });
});

// ---------- a review card: Changes wanted (relaunch) and Decline ----------

describe("API: a review card's Changes wanted and Decline carry the files", () => {
  const EPIC = "docs/spines/epic-59.md";
  const LIVE = "https://team.example/audit";
  it("relaunch: the row's status and the new worker's brief carry the link; an unknown file is a 404 and writes nothing", async () => {
    const repo = makeRepo(tmp, "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nRoot spine: self\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
      [EPIC]: spineText("PLAN-59", "Security audits", [{ id: "T59-S1", title: "Security audit", status: "review", evidence: `[audit](${LIVE})` }]),
    });
    const db = openDb(path.join(tmp, "console.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const dm = store.createPersona({ name: "Delivery manager", remit: "d", skills: [], model: "", mayWrite: false });
    store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const woke: string[] = [];
    const review = createReview(db, {
      store,
      reposRoot: tmp,
      writer: createSpineWriter(),
      cycle: { runNowRequest: async (_id: string, o: { instructions?: string }) => (woke.push(o.instructions ?? ""), { run: { id: "run_new" } }) },
      live: { fetch: web({ [LIVE]: 200 }).f, consoleHosts: [] },
    });
    const atts = createAttachments({ db, dir: path.join(tmp, "files"), world: () => "acme", publicUrl: "https://team.example" });
    const shot = atts.add(PNG, "image/png", "image.png");
    await review.list({ wait: true });
    const s1 = (await review.list()).find((i) => i.ref === "T59-S1")!;
    const r = await review.relaunch(s1.id, atts.cardText("not in the inbox card", [shot.id]));
    expect("error" in r ? r : r.item).toMatchObject({ state: "relaunched" });
    const link = `https://team.example${shot.path}`;
    expect(repo.rowLine(EPIC, "T59-S1")).toContain(`relaunched by Sam ${new Date().toISOString().slice(0, 10)}: not in the inbox card 📎 Sam attached a file, open it with your console headers: ${link})`);
    expect(woke[0]).toContain(`not in the inbox card 📎 Sam attached a file, open it with your console headers: ${link}`);
    db.close();
  });

  it("the routes take attachments (an unknown one is a 404) and refuse an empty Changes wanted", async () => {
    const db = openDb(path.join(tmp, "console.db"));
    const app = createApp(db, { read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] }, chatAttachmentsDir: path.join(tmp, "chat-attachments") });
    const call = async (url: string, body: unknown) => {
      const res = await app.request(url, { method: "POST", headers: { "Content-Type": "application/json", ...PAGE }, body: JSON.stringify(body) }, local);
      return { status: res.status, json: (await res.json()) as any };
    };
    expect((await call("/api/review-items/rv_x/relaunch", { feedback: "redo", attachments: ["att_000000000000"] })).status).toBe(404);
    expect((await call("/api/review-items/rv_x/deny", { reason: "", attachments: ["att_000000000000"] })).json.error.code).toBe("not_found");
    expect((await call("/api/review-items/rv_x/relaunch", { feedback: "  " })).status).toBe(400);
    expect((await call("/api/review-items/rv_x/relaunch", { feedback: "x", attachments: Array.from({ length: 9 }, (_, i) => `att_${i}`) })).status).toBe(400);
    db.close();
  });
});
