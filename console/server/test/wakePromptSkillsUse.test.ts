import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client } from "../src/t3/client.js";
import { serializeManifest, skillProblems, wakeSkillCheck, type CliRun } from "../src/teamSkills.js";
import { buildWakePrompt, skillsSection } from "../src/wakePrompt.js";

// a persona's wake names its team skills with their use_when line, and a declared skill missing from the library or not
// installed on the persona's host fails the wake check (run failed with the reason, no T3 call) instead of running without it.
const LIB = {
  version: 1,
  skills: [
    { name: "diagram-design", use_when: "a branded editorial diagram (architecture, flowchart, ...) as HTML/SVG", source: { type: "github", repo: "c/d", commit: "0".repeat(40), path: "skills/diagram-design" } },
    { name: "pdf", use_when: "Use this skill whenever the user wants to do anything with PDF files.", source: { type: "local", path: "skills/pdf" } },
  ],
};
const dirs = (missing: string[] = []) => ({
  code: missing.length ? 1 : 0,
  json: { ok: true, green: !missing.length, dirs: [{ dir: "~/.claude/skills", ok: ["diagram-design"], missing: [] }, { dir: "~/.claude_seat2/skills", ok: [], missing }] },
});

describe("T53-S3 wake prompt: skills with their use_when", () => {
  it("lists each attached skill as `Use <name> when …`", () => {
    const s = skillsSection(["diagram-design", "pdf", "other"], { "diagram-design": LIB.skills[0].use_when, pdf: LIB.skills[1].use_when });
    expect(s).toContain("## Skills");
    expect(s).toContain("- Use `diagram-design` when you need a branded editorial diagram (architecture, flowchart, ...) as HTML/SVG");
    expect(s).toContain("- Use `pdf` whenever the user wants to do anything with PDF files");
    expect(s).toContain("- `other`");
    // a SKILL.md line that already starts with When (content-strategy) is not doubled
    expect(skillsSection(["cs"], { cs: "When the user wants to plan a content strategy." })).toContain("- Use `cs` when the user wants to plan a content strategy");
    const p = buildWakePrompt({ name: "Writer", remit: "R", skills: ["diagram-design"] }, { title: "T", repo: "r", path: "s.md", owner: "" }, undefined, undefined, undefined, 10, undefined, { "diagram-design": "a diagram" });
    expect(p).toMatch(/## Skills\nYour team skills .*\n- Use `diagram-design` when you need a diagram\n/);
    expect(buildWakePrompt({ name: "W", remit: "R", skills: [] }, { title: "T", repo: "r", path: "s.md", owner: "" })).not.toContain("## Skills");
  });
});

describe("T53-S3 wake check", () => {
  it("names a skill the library lacks and one missing in a config dir of the host", () => {
    expect(skillProblems(["diagram-design"], ["diagram-design"], dirs().json)).toBeUndefined();
    expect(skillProblems(["gh"], ["diagram-design"])).toBe("gh is not in the team skills library (add it on Team skills, or take it off the persona)");
    expect(skillProblems(["diagram-design"], ["diagram-design"], dirs(["diagram-design"]).json, "worker")).toBe(
      "diagram-design is not installed on worker (missing in ~/.claude_seat2/skills; team-skills sync has not linked it yet)",
    );
  });

  it("checks the persona's host once a minute; an unreadable host report lets the wake go with a note", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "e53s3-lib-"));
    fs.mkdirSync(path.join(repo, "skills"));
    fs.writeFileSync(path.join(repo, "skills/team-skills.json"), serializeManifest(LIB as any));
    const calls: string[] = [];
    let report: any = dirs();
    const cli: CliRun = async (host) => (calls.push(host), report);
    let t = 0;
    const check = wakeSkillCheck({ repoDir: repo, cli, now: () => t });
    const p = { name: "Writer", skills: ["diagram-design"], host: "worker" as const };
    expect(await check(p)).toEqual({ ok: true, use: { "diagram-design": LIB.skills[0].use_when } });
    await check(p);
    expect(calls).toEqual(["worker"]); // cached
    t = 61_000;
    report = dirs(["diagram-design"]);
    expect(await check(p)).toMatchObject({ ok: false, reason: expect.stringContaining("diagram-design is not installed on worker") });
    t = 130_000;
    report = { code: 2, err: "ssh: connect timed out" };
    expect(await check(p)).toMatchObject({ ok: true, note: expect.stringContaining("could not check skills installed on worker (ssh: connect timed out)") });
    expect(await check({ ...p, skills: [] })).toEqual({ ok: true, use: {} });
    expect(await wakeSkillCheck({ repoDir: path.join(repo, "nope"), cli })(p)).toMatchObject({ ok: false, reason: expect.stringContaining("library cannot be read") });
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

class FakeT3 implements T3Client {
  launched = 0;
  sends: string[] = [];
  async listProjects() {
    return [{ id: "main:proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    this.launched++;
    return { threadId: `thread${this.launched}` };
  }
  async sendToThread(_t: string, text: string) {
    this.sends.push(text);
  }
  async readThreadStatus() { return { status: "running", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(skills: string[], report = dirs()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e53s3-"));
  fs.mkdirSync(path.join(dir, "skills"));
  fs.writeFileSync(path.join(dir, "skills/team-skills.json"), serializeManifest(LIB as any));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const cli: CliRun = async () => report;
  const app = createApp(db, { cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x" }, teamSkills: { repoDir: dir, cli, wakeCheck: true } });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Writer", remit: "r", skills, model: "sonnet", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  const lastRun = () => store.listRuns().find((x) => x.assignmentId === a.id)!;
  return { t3, store, a, call, lastRun };
}

describe("T53-S3 the wake check in the cycle", () => {
  it("Run now of a persona whose skill is not in the library: run failed with the reason, no thread launched", async () => {
    const t = setup(["diagram-design", "gh"]);
    const r = await t.call("POST", `/api/assignments/${t.a.id}/run-now`, {});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("skill_check");
    expect(r.json.error.message).toContain("gh is not in the team skills library");
    const run = t.store.listRuns().find((x) => x.assignmentId === t.a.id)!;
    expect(run.outcome).toBe("failed");
    expect(run.summary).toBe("Wake check failed: skill check: gh is not in the team skills library (add it on Team skills, or take it off the persona)");
    expect(t.t3.launched).toBe(0);
  });

  it("a home-thread wake of a persona whose skill is not installed on its host is told to stop, run failed", async () => {
    const t = setup(["diagram-design"], dirs(["diagram-design"]));
    const w = await t.call("POST", `/api/assignments/${t.a.id}/wake`, {});
    expect(w.text).toMatch(/stopped by the wake check: skill check: diagram-design is not installed on main/);
    expect(t.lastRun()).toMatchObject({ outcome: "failed", summary: expect.stringContaining("Wake check failed: skill check: diagram-design is not installed on main (missing in ~/.claude_seat2/skills") });
  });

  it("a passing check: the wake prompt carries the skill with its use_when", async () => {
    const t = setup(["diagram-design"]);
    const w = await t.call("POST", `/api/assignments/${t.a.id}/wake`, {});
    expect(w.text).toContain("- Use `diagram-design` when you need a branded editorial diagram");
    expect(t.lastRun().outcome).toBe("running");
  });
});
