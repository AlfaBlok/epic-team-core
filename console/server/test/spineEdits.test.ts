import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { isOpen, judge } from "../src/auth/routeScope.js";
import { runWithAuth } from "../src/auth/identity.js";
import { crossSiteRefusal } from "../src/auth/csrf.js";
import type { EditInput, SpineWriter } from "../src/inbox/spineWrite.js";
import { applyStep, createSteps, deskLine, mountSteps, ownerNote, STEP_WRITES_PER_MIN, stepsIn, ticksIn } from "../src/steps/steps.js";

// a steps page has a Done switch per step; a tick is a Decisions row in the
// owning spine, one Team desk line and a wake of the waiting row's owner; untick undoes all three; reload reads the spine.

const SPINE = "docs/spines/epic-9.md";
const TEXT = `# PLAN-9: test

## Issue Ledger

| Issue | Status |
|---|---|
| T9-S1 | blocked |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-11-01 | accepted | first | one | x | never |

## Operating Learnings

None yet.
`;

let db: DB;
let repo: string;
let told: { world: string; text: string; id: string }[];
let woken: { mid: string; note: string }[];
let commits: string[];

const writer = (): SpineWriter =>
  ({
    edit: async (o: EditInput) => {
      const file = path.join(o.repoDir, o.path);
      const e = o.edit(fs.readFileSync(file, "utf8"), "2026-11-09");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.writeFileSync(file, e.text);
      commits.push(e.msg);
      return { status: "written", sha: `sha${commits.length}`, path: o.path };
    },
  }) as unknown as SpineWriter;

const make = (o: { wake?: boolean } = {}) =>
  createSteps({
    db,
    pump: false, // the tests file and wake with drain
    fileDelayMs: 0,
    writer: writer(),
    repoDir: (n) => (n === "home_repo" ? repo : undefined),
    milestoneFor: async (r, s) => (r === "home_repo" && s === SPINE ? "ms_1" : undefined),
    wake:
      o.wake === false
        ? undefined
        : async (mid, note) => {
            woken.push({ mid, note });
            return { runId: "run_x" };
          },
    tell: async (world, text, id) => {
      told.push({ world, text, id });
      return true;
    },
  });

beforeEach(() => {
  db = openDb(":memory:");
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "e87s1-"));
  fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(repo, SPINE), TEXT);
  told = [];
  woken = [];
  commits = [];
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const page = { id: "sp_0a1b2c3d", title: "Your account steps", url: "http://host3:9019/kit/steps/" };

const text = (r: ReturnType<typeof applyStep>) => {
  if ("skip" in r) throw new Error(r.skip);
  return r.text;
};

describe("T87-S1 spine edits", () => {
  it("Done adds one Decisions row, reads back, and Not started takes it out", () => {
    const t = { page, step: "x-epicteam", title: "X · @EpicTeamHQ", row: "T83-S5" };
    const done = text(applyStep(TEXT, t, "done", undefined, "2026-11-09"));
    const row = done.split("\n").find((l) => l.includes("[step-done sp_0a1b2c3d/x-epicteam]"))!;
    expect(row).toMatch(/^\| 2026-11-09 \| accepted \| Step done: X · @EpicTeamHQ on Your account steps \[step-done sp_0a1b2c3d\/x-epicteam\], T83-S5 can go on \| Sam switched Done/);
    expect(done.indexOf(row)).toBeGreaterThan(done.indexOf("| 2026-11-01 |"));
    expect(done.indexOf(row)).toBeLessThan(done.indexOf("## Operating Learnings"));
    expect(ticksIn(done, page.id)).toEqual({ "x-epicteam": { at: "2026-11-09" } });
    expect(ticksIn(done, "sp_ffffffff")).toEqual({});
    expect(applyStep(done, t, "done", undefined, "2026-11-10")).toEqual({ skip: "already done in the spine" });
    expect(text(applyStep(done, t, "todo", undefined, "2026-11-09"))).toBe(TEXT);
    expect(applyStep(TEXT, t, "todo", undefined, "2026-11-09")).toEqual({ skip: "already not started in the spine" });
    expect(applyStep("# no table\n", { page, step: "a", title: "a" }, "done", undefined, "2026-11-09")).toEqual({ skip: "the spine has no ## Decisions table" });
  });

  it("Stuck replaces Done and keeps his words; a note is its own row; the view reads all of it", () => {
    const t = { page, step: "s2", title: "X · @EpicTeamHQ", row: "T83-S5" };
    const done = text(applyStep(TEXT, t, "done", undefined, "2026-11-09"));
    const stuck = applyStep(done, t, "stuck", "The code never came | twice", "2026-11-09");
    expect("skip" in stuck ? undefined : stuck.changed).toEqual({ state: true, note: true });
    const s1 = text(stuck);
    expect(s1).not.toContain("[step-done sp_0a1b2c3d/s2]");
    const row = s1.split("\n").find((l) => l.includes("[step-stuck sp_0a1b2c3d/s2]"))!;
    expect(row.split(" | ").length).toBe(6); // the pipe in his words stays inside one cell
    expect(stepsIn(s1, page.id).steps).toEqual({ s2: { state: "stuck", at: "2026-11-09", words: "The code never came / twice" } });
    // a note with no state change: its own row, the state stays
    const s2 = text(applyStep(s1, t, "stuck", "Tried again at 18:00", "2026-11-09"));
    expect(stepsIn(s2, page.id)).toEqual({ steps: { s2: { state: "stuck", at: "2026-11-09", words: "The code never came / twice" } }, notes: { s2: [{ at: "2026-11-09", words: "Tried again at 18:00" }] } });
    // Done with words: the stuck row goes, Done and a note row stay
    const s3 = text(applyStep(s2, t, "done", "Worked with the SMS code", "2026-11-09"));
    expect(stepsIn(s3, page.id).steps).toEqual({ s2: { state: "done", at: "2026-11-09" } });
    expect(stepsIn(s3, page.id).notes.s2.map((n) => n.words)).toEqual(["Tried again at 18:00", "Worked with the SMS code"]);
  });

  it("the desk line and the owner's note say what happened, in plain words", () => {
    const t = { page, step: "x", title: "X · @EpicTeamHQ", row: "T83-S5" };
    expect(deskLine(t, "done", { repo: "home_repo", spine: SPINE, sha: "abc1234", woke: "the Delivery manager was woken (run r)" })).toMatch(
      /^\[step done\] Done: X · @EpicTeamHQ on Your account steps \(http:\/\/host3:9019\/kit\/steps\/\), for T83-S5\. Saved in home_repo docs\/spines\/epic-9\.md \(abc1234\); the Delivery manager was woken/,
    );
    expect(deskLine(t, "todo", { repo: "home_repo", spine: SPINE, woke: "x" })).toMatch(/^\[step done\] Back to not started: /);
    expect(deskLine(t, "stuck", { repo: "home_repo", spine: SPINE, woke: "x", words: "No code" })).toMatch(/^\[step done\] Stuck: X · @EpicTeamHQ .*\. His words: "No code"\./);
    expect(deskLine(t, "done", { repo: "home_repo", spine: SPINE, woke: "x", words: "ok", stateChange: false })).toMatch(/^\[step done\] Note: /);
    expect(ownerNote(t, "done", { repo: "home_repo", spine: SPINE, sha: "abc" })).toContain("dispatch T83-S5's next run at once");
    expect(ownerNote({ ...t, row: undefined, ask: "T83-A7" }, "done", { repo: "home_repo", spine: SPINE })).toContain("treat T83-A7 as done by him");
    expect(ownerNote(t, "todo", { repo: "home_repo", spine: SPINE })).toContain("it is NOT done after all");
    expect(ownerNote(t, "stuck", { repo: "home_repo", spine: SPINE, words: "No code" })).toMatch(/Sam is STUCK on .* His words: "No code"\. .*dispatch T83-S5's next run at once with his words/);
  });

  it("a TEST page never reads as Sam: commit, Decisions row, desk line and wake note say TEST tick (not Sam)", () => {
    const tp = { ...page, title: "TEST steps page" };
    const t = { page: tp, step: "a", title: "TEST step", row: "E87-T1" };
    const row = text(applyStep(TEXT, t, "done", undefined, "2026-11-09")).split("\n").find((l) => l.includes("[step-done"))!;
    expect(row).toContain("TEST tick (not Sam) switched Done");
    expect(row).not.toContain("Sam switched");
    expect(deskLine(t, "done", { repo: "home_repo", spine: SPINE, woke: "x" })).toMatch(/^\[step done\] TEST tick \(not Sam\), Done: /);
    const n = ownerNote(t, "done", { repo: "home_repo", spine: SPINE });
    expect(n).toMatch(/^TEST tick \(not Sam\) switched Done/);
    expect(n).toContain("This is a TEST tick on a TEST page, not Sam: change nothing for it.");
  });
});

describe("T87-S1 routes", () => {
  const app = () => {
    const steps = make();
    const api = new Hono();
    mountSteps(api, steps);
    const root = new Hono();
    root.route("/api", api);
    return { root, steps };
  };
  const register = async (root: Hono, body: Record<string, unknown> = { title: "Your account steps", url: "http://host3:9019/kit/steps/", repo: "home_repo", spine: SPINE }) =>
    root.request("/api/steps/pages", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const post = (root: Hono, token: string, body: unknown) => root.request(`/api/public/steps/${token}/ticks`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "text/plain" } });

  it("register → tick → spine row, desk line, owner woken → reload reads it → untick undoes all three", async () => {
    const { root, steps } = app();
    const r = await register(root);
    expect(r.status).toBe(201);
    const p = (await r.json()) as { id: string; token: string };
    expect(p.id).toMatch(/^sp_[a-f0-9]{8}$/);
    expect(p.token.length).toBeGreaterThanOrEqual(20);
    // the same page registered again keeps its token
    expect(((await (await register(root)).json()) as { token: string }).token).toBe(p.token);
    // the list never shows tokens
    expect(JSON.stringify(await (await root.request("/api/steps/pages")).json())).not.toContain(p.token);

    const g0 = await root.request(`/api/public/steps/${p.token}`);
    expect(g0.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await g0.json()) as { ticks: object }).ticks).toEqual({});

    const t = await post(root, p.token, { step: "x-epicteam", done: true, title: "X · @EpicTeamHQ", row: "T83-S5" });
    expect(t.status).toBe(200);
    const tj = (await t.json()) as { spine: string; change: { status: string }; ticks: Record<string, unknown> };
    // answered at once, saved in the console and filing to the repo; the filer writes, tells and wakes after.
    expect(tj).toMatchObject({ spine: "saved", state: "done", done: true, change: { status: "saved" } });
    expect(Object.keys(tj.ticks)).toEqual(["x-epicteam"]);
    expect(commits).toHaveLength(0);
    await steps.drain();
    expect(((await (await root.request(`/api/public/steps/${p.token}`)).json()) as { changes: Record<string, unknown> }).changes["x-epicteam"]).toMatchObject({ status: "filed", sha: "sha1", wake: "sent", wakeRun: "run_x" });
    expect(fs.readFileSync(path.join(repo, SPINE), "utf8")).toContain(`[step-done ${p.id}/x-epicteam]`);
    expect(commits[0]).toBe("Step done: X · @EpicTeamHQ on Your account steps (T83-S5) (Sam, via steps page)");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ world: "home" });
    expect(told[0].text).toMatch(/^\[step done\] Done: X · @EpicTeamHQ on Your account steps/);
    expect(woken).toEqual([{ mid: "ms_1", note: expect.stringContaining("dispatch T83-S5's next run at once") }]);

    // a reload reads the tick from the spine
    expect(((await (await root.request(`/api/public/steps/${p.token}`)).json()) as { ticks: object }).ticks).toEqual({ "x-epicteam": { at: "2026-11-09" } });
    // a second tick changes nothing and tells nobody
    expect(((await (await post(root, p.token, { step: "x-epicteam", done: true })).json()) as { spine: string }).spine).toBe("same");
    expect(told).toHaveLength(1);

    const u = (await (await post(root, p.token, { step: "x-epicteam", done: false, title: "X · @EpicTeamHQ", row: "T83-S5" })).json()) as { spine: string; ticks: object };
    expect(u).toMatchObject({ spine: "saved", ticks: {} });
    await steps.drain();
    expect(fs.readFileSync(path.join(repo, SPINE), "utf8")).toBe(TEXT);
    expect(told[1].text).toMatch(/^\[step done\] Back to not started: /);

    // Stuck with his words: saved, told, woken with the words; the reload shows them
    const st = (await (await post(root, p.token, { step: "x-epicteam", state: "stuck", comment: "The code never came", title: "X · @EpicTeamHQ", row: "T83-S5" })).json()) as { state: string; steps: object };
    expect(st).toMatchObject({ state: "stuck", steps: { "x-epicteam": { state: "stuck", words: "The code never came" } } });
    await steps.drain();
    expect(told[2].text).toMatch(/^\[step done\] Stuck: .*His words: "The code never came"/);
    expect(woken[2].note).toContain('His words: "The code never came"');
    // a note alone keeps the state
    const nt = (await (await post(root, p.token, { step: "x-epicteam", comment: "Tried again" })).json()) as { state: string; notes: Record<string, unknown[]> };
    expect(nt.state).toBe("stuck");
    expect(nt.notes["x-epicteam"]).toEqual([{ at: expect.stringMatching(/^\d{4}-\d\d-\d\d$/), words: "Tried again" }]);
    await steps.drain();
    expect(told[3].text).toMatch(/^\[step done\] Note: /);
    const g = (await (await root.request(`/api/public/steps/${p.token}`)).json()) as { steps: object; notes: object };
    expect(g.steps).toEqual({ "x-epicteam": { state: "stuck", at: "2026-11-09", words: "The code never came" } });
    expect(woken[1].note).toContain("NOT done after all");
  });

  it("refuses a wrong token, a bad step, a bad code, a page outside the repo, and a tick storm", async () => {
    const { root } = app();
    const p = (await (await register(root)).json()) as { token: string };
    expect((await post(root, "x".repeat(24), { step: "a", done: true })).status).toBe(404);
    expect((await post(root, p.token, { step: "../a", done: true })).status).toBe(400);
    expect((await post(root, p.token, { step: "a", done: "yes" })).status).toBe(400);
    expect((await post(root, p.token, { step: "a", state: "maybe" })).status).toBe(400);
    expect((await post(root, p.token, { step: "a" })).status).toBe(400);
    expect((await post(root, p.token, { step: "a", done: true, row: "E83 S5; rm" })).status).toBe(400);
    expect((await register(root, { title: "t", url: "http://x/", repo: "home_repo", spine: "../etc/passwd" })).status).toBe(400);
    expect((await register(root, { title: "t", url: "http://x/", repo: "home_repo", spine: "docs/spines/none.md" })).status).toBe(404);
    expect((await register(root, { title: "t", url: "http://x/", repo: "other", spine: SPINE })).status).toBe(404);
    let last = 0;
    for (let i = 0; i < STEP_WRITES_PER_MIN + 1; i++) last = (await post(root, p.token, { step: "a", done: i % 2 === 0 })).status;
    expect(last).toBe(429);
  });

  it("the session route takes Sam's session only, never an agent token", async () => {
    const { root, steps } = app();
    const p = steps.register({ title: "t", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    const call = () => root.request(`/api/steps/pages/${p.id}/ticks`, { method: "POST", body: JSON.stringify({ step: "a", done: true }) });
    const agent = await runWithAuth({ mode: "on", identity: { kind: "token", tenant: "home", tokenId: "t", label: "seat" } }, call);
    expect(agent.status).toBe(403);
    const sam = await runWithAuth({ mode: "on", identity: { kind: "session", tenant: "home", userId: "u", email: "j@x", name: "Sam", role: "owner" } as never }, call);
    expect(sam.status).toBe(200);
  });

  it("with nobody to wake, the tick is still saved and the desk says so", async () => {
    const steps = make({ wake: false });
    const p = steps.register({ title: "t", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    const r = await steps.tick(p, { step: "a", done: true });
    expect(r.spine).toBe("saved");
    await steps.drain();
    expect(told[0].text).toContain("nobody woken: the console's cycle is off");
  });
});

describe("T87-S1 access", () => {
  it("the kit files and the token routes need no login; registering and the session route do", () => {
    expect(isOpen("GET", "/steps-kit.js")).toBe(true);
    expect(isOpen("GET", "/steps-kit.css")).toBe(true);
    expect(isOpen("GET", "/api/public/steps/abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(isOpen("POST", "/api/public/steps/abcdefghijklmnopqrstuvwx/ticks")).toBe(true);
    expect(isOpen("POST", "/api/steps/pages")).toBe(false);
    expect(isOpen("POST", "/api/steps/pages/sp_0a1b2c3d/ticks")).toBe(false);
    expect(judge(db, { kind: "none" }, "POST", "/api/steps/pages").allow).toBe(false);
  });

  it("a page on another tailnet host may post its ticks (no cookie is used)", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n.toLowerCase()];
    expect(crossSiteRefusal("POST", "/api/public/steps/abc/ticks", h({ host: "vps-a9-1.tail.example:8750", origin: "http://worker.tail.example:9019", "sec-fetch-site": "cross-site" }))).toBeUndefined();
  });
});
