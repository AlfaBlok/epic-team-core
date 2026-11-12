import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { dataHash, wakeFingerprint } from "../src/cycle/skipUnchanged.js";
import { parseWakeParts } from "../src/cycle/wakeWhy.js";

/** a change under the repo's data/ counts as news, so the cadence wake runs (no skip). */
class FakeT3 implements T3Client {
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: "t" }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const node = (id: string, p: string): TreeNode => ({ key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children: [], flags: [] });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e34s13-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m", root: node("PLAN-1", "docs/epic.md"),
    counts: { grey: 1, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 1, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3(), publicUrl: "http://x", treeFor, treeTodo: async () => "", repoDir: () => repo });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "memo-social", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Listener", remit: "listen", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  const cadence = async () => {
    const w = await cycle.wake(a.id, { threadId: "home" });
    return { ...w, real: w.run?.outcome === "running" };
  };
  const finish = async (edit?: () => void) => {
    const r = newest();
    edit?.();
    store.updateRun(r.id, { outcome: "idle", endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return r;
  };
  return { repo, cycle, a, cadence, finish, newest };
}

describe("T34-S13 no skipped wake when data/ changes", () => {
  it("a new or edited file under data/ runs the next cadence wake; unchanged data/ still skips", async () => {
    const t = setup();
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    expect((await t.cadence()).real).toBe(false); // nothing changed: skipped
    fs.mkdirSync(path.join(t.repo, "data/ideas"), { recursive: true });
    fs.writeFileSync(path.join(t.repo, "data/ideas/i1.md"), "an idea Sam dropped\n");
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    expect((await t.cadence()).real).toBe(false);
    fs.appendFileSync(path.join(t.repo, "data/ideas/i1.md"), "priority: this week\n");
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    fs.rmSync(path.join(t.repo, "data/ideas/i1.md"));
    expect((await t.cadence()).real).toBe(true);
  });

  it("the wake's own data/ writes are not news (fingerprint refreshed at run end)", async () => {
    const t = setup();
    await t.cadence();
    await t.finish(() => {
      fs.mkdirSync(path.join(t.repo, "data/posts"), { recursive: true });
      fs.writeFileSync(path.join(t.repo, "data/posts/p1.md"), "posted\n");
    });
    expect((await t.cadence()).real).toBe(false);
  });

  it("wake-check names the data/ part", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    fs.mkdirSync(path.join(t.repo, "data"), { recursive: true });
    fs.writeFileSync(path.join(t.repo, "data/feedback.md"), "more like this\n");
    const c = (await t.cycle.wakeCheck(t.a.id)) as { wouldSkip: boolean; why?: string };
    expect(c.wouldSkip).toBe(false);
    expect(c.why).toContain("data/ files changed");
  });

  it("dataHash: '' without data/, changes with content and paths; fingerprints of repos without data/ unchanged", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "console-e34s13-h-"));
    try {
      expect(dataHash(repo)).toBe("");
      fs.mkdirSync(path.join(repo, "data/a"), { recursive: true });
      fs.writeFileSync(path.join(repo, "data/a/x.json"), "{}");
      const h1 = dataHash(repo);
      expect(h1).toMatch(/^[0-9a-f]{32}$/);
      fs.writeFileSync(path.join(repo, "data/a/x.json"), "{\"k\":1}");
      const h2 = dataHash(repo);
      expect(h2).not.toBe(h1);
      fs.renameSync(path.join(repo, "data/a/x.json"), path.join(repo, "data/a/y.json"));
      expect(dataHash(repo)).not.toBe(h2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
    const base = { spines: "s", running: [], readyAndSeatFree: false, answer: "", prompt: "" };
    expect(wakeFingerprint({ ...base, data: "" })).toBe(wakeFingerprint(base));
    expect(wakeFingerprint({ ...base, data: "d" })).not.toBe(wakeFingerprint(base));
    // parts recorded before (no data key) still parse
    expect(parseWakeParts(JSON.stringify({ spines: "s", prompt: "p", answer: "", running: "r", ready: "0" }))?.data).toBe("");
  });
});

describe("T34-S13 laptop online status for Sign-ins (GET /api/auth/egress)", () => {
  it("reads the caller's Team Browser /health; state and times, never the egress IP; a down browser is a 502", async () => {
    const http = await import("node:http");
    const { tempApp } = await import("./helpers.js");
    const health = {
      ok: true,
      egress: {
        egresses: {
          laptop: { state: "offline", since: "2026-10-27T01:00:00Z", lastSeen: "2026-10-27T00:59:00Z", checkedAt: "2026-10-27T01:05:00Z", reason: "peer offline", ip: "187.1.2.3", loc: "MX", whenDown: "hold", pagesToday: 3 },
          decodo: { state: "weird", ip: "1.2.3.4" },
        },
        routes: [],
      },
    };
    const fake = http.createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/health" ? health : {}));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    const browserUrl = `http://127.0.0.1:${(fake.address() as import("node:net").AddressInfo).port}`;
    const t = tempApp({ browser: { browserUrl } });
    try {
      const r = await t.call("GET", "/api/auth/egress");
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        egresses: [
          { name: "laptop", state: "offline", since: "2026-10-27T01:00:00Z", lastSeen: "2026-10-27T00:59:00Z", checkedAt: "2026-10-27T01:05:00Z", reason: "peer offline", whenDown: "hold" },
          { name: "decodo", state: "unknown" },
        ],
      });
      expect(JSON.stringify(r.json)).not.toContain("187.1.2.3");
      health.egress.egresses.laptop.state = "online";
      expect((await t.call("GET", "/api/auth/egress")).json.egresses[0].state).toBe("online");
      // the outbox's held writes ride on the laptop's line (and only there).
      (health as Record<string, unknown>).outbox = { held: 2, oldest_held_at: null, last_24h: {} };
      const held = (await t.call("GET", "/api/auth/egress")).json.egresses;
      expect(held[0]).toMatchObject({ name: "laptop", heldWrites: 2 });
      expect(held[1].heldWrites).toBeUndefined();
    } finally {
      t.cleanup();
      fake.close();
    }
    const down = tempApp({ browser: { browserUrl: "http://127.0.0.1:9" } });
    try {
      const r = await down.call("GET", "/api/auth/egress");
      expect(r.status).toBe(502);
      expect(r.json.error.code).toBe("browser_unavailable");
    } finally {
      down.cleanup();
    }
  });
});

describe("T34-S13 generic persona templates (PLAN-11 E11-3)", () => {

  it("parseTemplate refuses a file with a missing key or section, or a name that is not the file's", async () => {
    const { parseTemplate } = await import("../src/personaTemplates.js");
    const ok = "---\nname: x\ntemplate: x\nmodel: m # alias\nhost: host1\n---\n\n## Remit\nr\n\n## Reads\nin\n\n## Writes\nout\n";
    expect(parseTemplate(ok, "x")).toMatchObject({ name: "x", model: "m", remit: "r", reads: "in", writes: "out", prompt: "r\n\nReads: in\n\nWrites: out" });
    expect(parseTemplate(ok, "y")).toBeUndefined();
    expect(parseTemplate(ok.replace("host: host1\n", ""), "x")).toBeUndefined();
    expect(parseTemplate(ok.replace("## Reads\nin\n\n", ""), "x")).toBeUndefined();
  });

  it("GET /api/persona-templates lists them (PERSONA_TEMPLATES_DIR wins)", async () => {
    const { tempApp } = await import("./helpers.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e34s13-t-"));
    fs.writeFileSync(path.join(dir, "watcher.md"), "---\nname: watcher\ntemplate: watcher\nmodel: claude-sonnet-5-5\nhost: host1\n---\n## Remit\nwatch\n## Reads\nlogs\n## Writes\nnotes\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# not a template\n");
    const prev = process.env.PERSONA_TEMPLATES_DIR;
    const t = tempApp();
    try {
      const real = await t.call("GET", "/api/persona-templates");
      expect(real.status).toBe(200);
      expect(real.json.map((x: any) => x.name)).toEqual(expect.arrayContaining(["author", "engager", "listener", "responder"]));
      process.env.PERSONA_TEMPLATES_DIR = dir;
      expect((await t.call("GET", "/api/persona-templates")).json).toEqual([
        { name: "watcher", template: "watcher", model: "claude-sonnet-5-5", host: "host1", skills: [], remit: "watch", reads: "logs", writes: "notes", prompt: "watch\n\nReads: logs\n\nWrites: notes" },
      ]);
    } finally {
      if (prev === undefined) delete process.env.PERSONA_TEMPLATES_DIR;
      else process.env.PERSONA_TEMPLATES_DIR = prev;
      t.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
