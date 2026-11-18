import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { ReadConfig } from "../src/routes/read.js";
import { addLedgerRow, choosesDraft, mountTreeAdd, readyDecision } from "../src/status/add.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";
import { askedNoRowFor, askedNoRowSection, coveredIds, dedupeAsked, mountAskedNoRow, uncoveredDoneMeans } from "../src/status/askedNoRow.js";
import { citesJordisAsk, selfReadiedLines } from "../src/cycle/selfReady.js";
import { buildWakePrompt, NO_SELF_READY } from "../src/wakePrompt.js";
import { endpointLines, SEED_VERSION } from "../src/desk/desk.js";
import { milestoneEndpointLines, MILESTONE_SEED_VERSION } from "../src/desk/milestoneChat.js";
import type { SpinesJson } from "../src/adapters/spines.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * the owner's ask is ready by default. (1) Add from his page (or the desk / a milestone chat with his words)
 * writes ready, a Done-means line gets a ready row, a Decisions row cites it; "just register it" keeps a draft; an agent's
 * Add stays a draft. (2) A ready Add wakes the Delivery manager. (3) NO_SELF_READY lets an agent ready an item that cites
 * the owner's ask. (4) Open Done-means lines no row covers are listed in the DM wake and on the Team home.
 */

const SPINE = `# EPIC-909: Demo

## Done means

- [x] E9-1 First thing works.
- [ ] E9-2 Second thing works.
- [ ] E9-3 Third thing works.
- [ ] E9-4 Fourth thing works.
- [ ] E9-5 Fifth thing works.

## Current State

Status: active

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | worker | E9-1..2: first two | done | none | none | main | none | 2026-10-20 | none |
| E909-S2 | Ticket worker | unassigned | Second (builds E9-4) | draft | none | none | main | none | 2026-10-20 | wait for ready |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-20 | accepted | x | y | z | never |
`;

describe("E948-S6 (1) Add: pure edits", () => {
  it("a ready row: Status ready, next action dispatch; `covers` puts the Done-means id first in its title", () => {
    const r = addLedgerRow(SPINE, { title: "Snooze", line: "3 days" }, "2026-11-01", { ready: true, covers: "E9-6" });
    if ("skip" in r) throw new Error(r.skip);
    expect(r.id).toBe("E909-S3");
    expect(r.text).toContain("| E909-S3 | Ticket worker | unassigned | E9-6: Snooze: 3 days | ready | none | none | main | none | 2026-11-01 | dispatch (Sam's ask, L-37) |");
    const d = addLedgerRow(SPINE, { title: "Idea" }, "2026-11-01");
    expect(d).toMatchObject({ text: expect.stringContaining("| E909-S3 | Ticket worker | unassigned | Idea | draft |") });
  });

  it("Sam's words choosing a draft: 'just register it', 'as a draft', 'don't do it yet'; 'don't put it in draft' is not", () => {
    for (const t of ["just register it", "Add it as a draft please", "note this but don't do it yet", "Just register the snooze idea"]) expect(choosesDraft(t), t).toBe(true);
    for (const t of ["add snooze to the inbox", "don't put it in draft, go", "sort the drafts list by priority", "this is not yet built, add it"]) expect(choosesDraft(t), t).toBe(false);
  });

  it("the Decisions row names L-37 and quotes him, and counts as citing his ask", () => {
    const d = readyDecision("E9-6 (row E909-S3)", { via: "Team desk", quote: "add snooze to the inbox" }, "2026-11-01");
    expect(d.decision).toBe(`E9-6 (row E909-S3) ready on Sam's ask (L-37, Team desk: "add snooze to the inbox")`);
    expect(citesJordisAsk(`| 2026-11-01 | accepted | ${d.decision} | ${d.summary} | console commit | — |`)).toBe(true);
  });
});

describe("E948-S6 (3) NO_SELF_READY: an item readied on Sam's ask is not flagged", () => {
  const diff = (extra: string) =>
    [
      "commit aaa",
      "diff --git a/docs/e.md b/docs/e.md",
      "+++ b/docs/e.md",
      "@@ -5 +5 @@",
      "-| E909-S2 | Ticket worker | unassigned | Second | draft | none |",
      "+| E909-S2 | Ticket worker | unassigned | Second | ready | none |",
      ...extra.split("\n").filter(Boolean),
    ].join("\n");
  it("readied without a citation: flagged (as before)", () => {
    expect(selfReadiedLines(diff(""))).toEqual(["docs/e.md: | E909-S2 | Ticket worker | unassigned | Second | ready | none |"]);
  });
  it("same commit adds a Decisions row naming Sam + L-37 (or quoting him): not flagged", () => {
    expect(selfReadiedLines(diff("@@ -20 +21 @@\n+| 2026-11-01 | accepted | E909-S2 ready on Sam's word (L-37) | y | z | never |"))).toEqual([]);
    expect(selfReadiedLines(diff(`@@ -20 +21 @@\n+| 2026-11-01 | accepted | E909-S2 ready: Sam in the desk, "build the second thing" | y | z | never |`))).toEqual([]);
  });
  it("the readied row vouching for itself, a citation in another file or another commit: still flagged", () => {
    const self = ["commit aaa", "+++ b/docs/e.md", "@@ -5 +5 @@", "-| E909-S2 | Sam asked (L-37) | draft |", "+| E909-S2 | Sam asked (L-37) | ready |"].join("\n");
    expect(selfReadiedLines(self)).toHaveLength(1);
    expect(selfReadiedLines(diff("+++ b/docs/other.md\n@@ -1 +1 @@\n+| d | Sam asked (L-37) |"))).toHaveLength(1);
    expect(selfReadiedLines(diff("commit bbb\n+++ b/docs/e.md\n@@ -20 +21 @@\n+| d | Sam asked (L-37) |"))).toHaveLength(1);
    expect(selfReadiedLines(diff("@@ -20 +21 @@\n+| 2026-11-01 | accepted | readied, the team thinks it is good | y |"))).toHaveLength(1);
  });
  it("the wake prompt says ready comes from Sam's ask with a Decisions row citing it", () => {
    expect(NO_SELF_READY).toMatch(/on your own idea/);
    expect(NO_SELF_READY).toMatch(/His ask is his ready stamp \(root L-37\)/);
    expect(NO_SELF_READY).toMatch(/Decisions row that names Sam and L-37/);
    const p = buildWakePrompt({ name: "Delivery Manager", remit: "r", skills: [] }, { title: "t", repo: "r", path: "p", owner: "" });
    expect(p).toContain(NO_SELF_READY);
  });
  it("the desk and milestone chat seeds pass his words (chat) and keep drafts for 'just register it' (versions raised)", () => {
    const desk = endpointLines("http://c").join("\n");
    expect(desk).toMatch(/READY by default/);
    expect(desk).toMatch(/"chat":"<his words from his message, verbatim>","matched":"new: /);
    expect(desk).toMatch(/"draft":true` only when he says so/);
    expect(desk).not.toMatch(/drafts only/);
    expect(SEED_VERSION).toBeGreaterThanOrEqual(15);
    const mc = milestoneEndpointLines("http://c", { id: "ms_1" }).join("\n");
    expect(mc).toMatch(/READY by default/);
    expect(mc).not.toMatch(/drafts only/);
    expect(MILESTONE_SEED_VERSION).toBeGreaterThanOrEqual(7);
  });
});

describe("E948-S6 (4) asked, no row yet", () => {
  it("rows citing an id, a range (E9-1..2, E9-1..E9-3, E9-1–3) or a list (2) cover it; S-row ids and dates do not", () => {
    const t = (cell: string) => coveredIds(`## Issue Ledger\n\n| Issue | Title |\n|---|---|\n| E909-S7 | ${cell} |\n`);
    expect([...t("E9-1..3: x")]).toEqual(["E9-1", "E9-2", "E9-3"]);
    expect([...t("E9-1..E9-3")]).toEqual(["E9-1", "E9-2", "E9-3"]);
    expect([...t("E9-2–3")]).toEqual(["E9-2", "E9-3"]);
    expect([...t("E9-1/2 and E9-4")]).toEqual(["E9-1", "E9-2", "E9-4"]);
    expect([...t("E9-1, 2 done 2026-10-20")]).toEqual(["E9-1", "E9-2"]);
    expect([...t("depends on E909-S3")]).toEqual([]);
  });
  it("open lines with no row: ticked and covered ones are left out", () => {
    expect(uncoveredDoneMeans(SPINE)).toEqual([
      { id: "E9-3", text: "Third thing works." },
      { id: "E9-5", text: "Fifth thing works." },
    ]);
  });
  it("only runnable spines of the milestone's tree count; the DM wake section asks for a row each", () => {
    const node = (p: string, status: string, children: string[] = [], runnable?: boolean) =>
      ({ id: p, path: p, title: p.toUpperCase(), parent: null, status, rollup_status: status, dod: [], children, ...(runnable === undefined ? {} : { runnable }) }) as SpinesJson["nodes"][number];
    const spines: SpinesJson = { root: "root.md", orphans: [], mismatches: [], nodes: [node("root.md", "active", ["a.md", "b.md"]), node("a.md", "draft"), node("b.md", "review", [], true)] };
    const files: Record<string, string> = { "/r/root.md": SPINE, "/r/a.md": SPINE, "/r/b.md": SPINE.replace("E9-5 Fifth", "E9-6 Sixth") };
    const items = askedNoRowFor({ id: "ms_1", title: "Demo" }, "/r", "root.md", spines, (f) => files[f]);
    expect(items.map((i) => `${i.path} ${i.id}`)).toEqual(["root.md E9-3", "root.md E9-5", "b.md E9-3", "b.md E9-6"]);
    const s = askedNoRowSection(items)!;
    expect(s).toMatch(/^## Asked, no row yet/);
    expect(s).toMatch(/Plan a row for each/);
    expect(s).toContain("- root.md E9-5: Fifth thing works.");
    expect(askedNoRowSection([])).toBeUndefined();
  });
  it("the Team home list keeps each line once, under the milestone whose own spine it is", async () => {
    const i = (milestoneId: string, p: string) => ({ milestoneId, milestoneTitle: milestoneId, path: p, spineTitle: p, id: "E9-3", text: "x" });
    const out = dedupeAsked([
      { repoDir: "/r", rel: "root.md", items: [i("root", "root.md"), i("root", "child.md")] },
      { repoDir: "/r", rel: "child.md", items: [i("child", "child.md")] },
    ]);
    expect(out.map((x) => `${x.milestoneId}:${x.path}`)).toEqual(["root:root.md", "child:child.md"]);
    const api = new Hono();
    let calls = 0;
    let t = 0;
    mountAskedNoRow(api, { list: async () => (calls++, { items: out, partial: calls === 1 }), now: () => t });
    expect(await (await api.request("/asked-no-row")).json()).toEqual({ items: out, total: out.length, partial: true });
    t = 6_000; // a partial list (a cold spines read) is kept 5 s only
    expect(await (await api.request("/asked-no-row")).json()).toEqual({ items: out, total: out.length });
    t = 50_000;
    await api.request("/asked-no-row");
    expect(calls).toBe(2); // a full one is memoized for a minute
  });
});

describe("E948-S6 (1) the Team desk and a milestone chat add on Sam's words", () => {
  const mount = (o: { said?: string; chatSaid?: boolean; wake?: () => Promise<{ runId: string } | { error: string }> } = {}) => {
    let text = SPINE;
    const commits: { msg: string; body: string }[] = [];
    const wakes: string[] = [];
    const spine = {
      edit: async (i: { edit: (t: string, d: string) => { text: string; msg: string; body: string } | { skip: string } }) => {
        const out = i.edit(text, "2026-11-01");
        if ("skip" in out) return { status: "skipped" as const, reason: out.skip };
        text = out.text;
        commits.push({ msg: out.msg, body: out.body });
        return { status: "written" as const, sha: "abc1234" };
      },
    } as unknown as SpineWriter;
    const m = { id: "ms_1", title: "Demo", repo: "demo", path: "docs/spines/epic.md", owner: "", paused: false } as never;
    const api = new Hono();
    mountTreeAdd(api, {
      store: { getMilestone: () => m } as never,
      spine,
      locate: async () => ({ repoDir: "/r", rel: "docs/spines/epic.md" }),
      treePaths: async () => new Set(),
      invalidate: () => undefined,
      deskAsk: async (chat) => (o.said?.includes(chat) ? { text: o.said, at: "2026-11-01T10:00:00Z" } : "chat is not in Sam's newest desk message"),
      chatSaid: async (header, chat) => header === "repo-desk:ms_1" && !!o.chatSaid && chat.length > 3,
      wake: async (_m, instructions) => (wakes.push(instructions), o.wake ? o.wake() : { runId: "run_dm" }),
      wakeWaitMs: 50,
    });
    const add = async (body: unknown, headers: Record<string, string>) => (await api.request("/milestones/ms_1/tree/add", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json();
    return { add, text: () => text, commits, wakes };
  };
  const DESK = { "x-console-run": "team-desk" };

  it("the desk with his words from his newest message: ready, quoted in Decisions, the DM woken", async () => {
    const t = mount({ said: "add snooze to the inbox please" });
    const r = await t.add({ kind: "done_means", title: "Snooze", chat: "add snooze to the inbox" }, DESK);
    expect(r).toMatchObject({ id: "E9-6", rowId: "E909-S3", ready: true, wake: { runId: "run_dm" } });
    expect(t.text()).toContain(`E9-6 (row E909-S3) ready on Sam's ask (L-37, Team desk: "add snooze to the inbox please")`);
    expect(t.commits[0].body).toContain("ready on Sam's ask (L-37, Team desk)");
    expect(t.wakes[0]).toMatch(/Sam added E9-6 \(row E909-S3\) under docs\/spines\/epic.md from the console, ready on his ask \(L-37\)/);
  });

  it("a slow wake does not hold the Add: the answer comes once the spine is written, the wake goes on", async () => {
    let finish: (v: { runId: string }) => void = () => undefined;
    const t = mount({ said: "add snooze to the inbox please", wake: () => new Promise((r) => (finish = r)) });
    const t0 = Date.now();
    const r = await t.add({ kind: "done_means", title: "Snooze", chat: "add snooze to the inbox" }, DESK);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ id: "E9-6", rowId: "E909-S3", ready: true });
    expect(r.wake).toBeUndefined();
    expect(t.wakes).toHaveLength(1);
    finish({ runId: "run_late" });
  });

  it("the desk: words not his, or 'just register it' in his message: a draft, no wake", async () => {
    const t = mount({ said: "just register it: snooze for later" });
    const matched = "new: read E907-S3 and E907-S4, neither wants a snooze";
    expect(await t.add({ kind: "row", title: "Snooze", chat: "snooze for later", matched }, DESK)).toMatchObject({ ready: false, draftWhy: "Sam said to just register it" });
    expect(await t.add({ kind: "row", title: "Other", chat: "something he never said", matched }, DESK)).toMatchObject({ ready: false, draftWhy: expect.stringMatching(/not Sam's ask/) });
    expect(t.wakes).toEqual([]);
  });

  it("the desk files his words as a new row only after saying no ticket holds them", async () => {
    const t = mount({ said: "add snooze to the inbox" });
    const refused = await t.add({ kind: "row", title: "Snooze", chat: "add snooze to the inbox" }, DESK);
    expect(refused.error.code).toBe("match_first");
    expect(refused.error.message).toMatch(/voice_passes\.py match/);
    expect((await t.add({ kind: "row", title: "Snooze", chat: "add snooze to the inbox", matched: "it is the snooze one" }, DESK)).error.code).toBe("match_first");
    expect(await t.add({ kind: "row", title: "Snooze", chat: "add snooze to the inbox", matched: "new: read E907-S3 and E907-S4, neither wants a snooze" }, DESK)).toMatchObject({ ready: true });
    // a Done-means line, the console page and a milestone chat keep their own paths
    expect(await t.add({ kind: "done_means", title: "Snooze", chat: "add snooze to the inbox" }, DESK)).not.toHaveProperty("error");
  });

  it("a milestone chat with his words from its thread: ready; without them, or with a run id: a draft", async () => {
    const t = mount({ chatSaid: true });
    expect(await t.add({ kind: "row", title: "Sort", chat: "sort by priority" }, { "x-console-run": "repo-desk:ms_1" })).toMatchObject({ ready: true });
    expect(await t.add({ kind: "row", title: "Sort 2" }, { "x-console-run": "repo-desk:ms_1" })).toMatchObject({ ready: false });
    expect(await t.add({ kind: "row", title: "Sort 3", chat: "sort by priority" }, { "x-console-run": "repo-desk:ms_1", "x-run-id": "run_1" })).toMatchObject({ ready: false });
  });
});

// ---------- (1) + (2) through the API, real git ----------

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

describe("E948-S6 Add through the API", () => {
  let tmp: string;
  let origin: string;
  let db: DB;
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s6-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", "-q", origin, seed);
    git(seed, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(seed, "docs/spines/epic.md"), SPINE);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    git(tmp, "clone", "-q", origin, path.join(tmp, "demo"));
  });
  afterEach(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const SAM = { "sec-fetch-site": "same-origin" }; // the console page in his browser (the Mark wall)
  const boot = (o: { dm?: boolean } = {}) => {
    db = openDb(path.join(tmp, "console.db"));
    const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read });
    const store = createStore(db);
    const m = store.createMilestone({ title: "Demo", repo: "Acme/demo", path: "docs/spines/epic.md", owner: "", paused: false });
    if (o.dm) {
      const p = store.createPersona({ name: "Delivery Manager", remit: "run it", skills: [], model: "opus", mayWrite: true });
      store.createAssignment({ personaId: p.id, milestoneId: m.id, cadence: { type: "interval", everyMinutes: 60 } as never, enabled: true });
    }
    const add = async (body: unknown, headers: Record<string, string> = SAM) => {
      const res = await app.request(`/api/milestones/${m.id}/tree/add`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    return { add, m, app };
  };
  const onOrigin = () => git(origin, "show", "main:docs/spines/epic.md");
  const lastCommit = () => git(origin, "log", "-1", "--format=%B", "main");

  it("Sam's row is ready, with a Decisions row citing L-37; the commit body says so", async () => {
    const { add } = boot();
    const r = await add({ kind: "row", title: "Priority sort", line: "inbox by milestone priority" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "row", id: "E909-S3", ready: true });
    const text = onOrigin();
    expect(text).toMatch(/\| E909-S3 \| Ticket worker \| unassigned \| Priority sort: inbox by milestone priority \| ready \| .* \| dispatch \(Sam's ask, L-37\) \|/);
    expect(text).toContain("| accepted | E909-S3 ready on Sam's ask (L-37, console page) |");
    expect(lastCommit()).toMatch(/^Add ready row E909-S3 to epic.md \(Sam's ask, via console\)/);
    expect(lastCommit()).toContain(`ready on Sam's ask (L-37, console page)`);
    expect(lastCommit()).not.toContain("only Sam stamps ready");
    // The console's own commit is not a run's: and its Decisions row would clear it anyway.
    expect(selfReadiedLines(git(origin, "log", "-1", "-p", "--unified=0", "--format=commit %H", "main"))).toEqual([]);
  });

  it("Sam's Done-means line gets a ready row covering it, so it is never 'asked, no row yet'", async () => {
    const { add } = boot();
    const r = await add({ kind: "done_means", title: "Snooze a waiting item", line: "3 days / 1 week / 1 month" });
    expect(r.json).toMatchObject({ id: "E9-6", rowId: "E909-S3", ready: true });
    const text = onOrigin();
    expect(text).toContain("- [ ] E9-6 Snooze a waiting item: 3 days / 1 week / 1 month");
    expect(text).toMatch(/\| E909-S3 \| Ticket worker \| unassigned \| E9-6: Snooze a waiting item: 3 days \/ 1 week \/ 1 month \| ready \|/);
    expect(text).toContain("E9-6 (row E909-S3) ready on Sam's ask (L-37, console page)");
    expect(uncoveredDoneMeans(text).map((u) => u.id)).not.toContain("E9-6");
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Add ready Done-means line E9-6 + row E909-S3 to epic.md (Sam's ask, via console)");
  });

  it("'Just register it (draft)': today's draft, no row, no Decisions row, no wake", async () => {
    const { add } = boot({ dm: true });
    const r = await add({ kind: "done_means", title: "Maybe later", draft: true });
    expect(r.json).toMatchObject({ id: "E9-6", ready: false, draftWhy: expect.stringMatching(/just register it/) });
    expect(r.json.rowId).toBeUndefined();
    expect(r.json.wake).toBeUndefined();
    const text = onOrigin();
    expect(text).toContain("- [ ] E9-6 Maybe later");
    expect(text).not.toContain("E909-S3");
    expect(text).not.toContain("L-37");
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Add draft Done-means line E9-6 to epic.md (via console)");
  });

  it("an agent's Add (run id, token, desk without his words) stays a draft", async () => {
    const { add } = boot();
    const a = await add({ kind: "row", title: "Agent idea" }, { "x-run-id": "run_1" });
    expect(a.json).toMatchObject({ ready: false, draftWhy: expect.stringMatching(/agent's Add/) });
    expect(onOrigin()).toMatch(/\| E909-S3 \| Ticket worker \| unassigned \| Agent idea \| draft \|/);
    const d = await add({ kind: "row", title: "Desk idea" }, { "x-console-run": "team-desk" });
    expect(d.json).toMatchObject({ ready: false, draftWhy: expect.stringMatching(/no words of Sam's/) });
    const n = await add({ kind: "row", title: "No origin" }, {});
    expect(n.json.ready).toBe(false);
    expect((await add({ kind: "row", title: "x", draft: "yes" })).status).toBe(400);
  });

  it("a ready Add wakes the Delivery manager the way the Approvals tab does (cycle off in tests: it says why)", async () => {
    const { add } = boot({ dm: true });
    const r = await add({ kind: "row", title: "Wake it" });
    expect(r.json.ready).toBe(true);
    expect(r.json.wake).toEqual({ error: expect.stringMatching(/cycle is off/) });
    const d = await add({ kind: "row", title: "Quiet", draft: true });
    expect(d.json.wake).toBeUndefined();
  });

  it("GET /api/asked-no-row answers a list (empty without spines.py), never an error", async () => {
    const { app } = boot();
    const res = await app.request("/api/asked-no-row");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0 });
  });
});

describe("E948-S6 (4) the Delivery manager's wake lists what was asked with no row", () => {
  const cycleSetup = (persona: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s6-wake-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/epic.md"), SPINE);
    const db = openDb(path.join(dir, "c.db"));
    const store = createStore(db);
    const t3 = {
      listProjects: async () => [{ id: "proj", title: "home_repo", workspaceRoot: repo }],
      listScheduledTasks: async () => [],
      updateScheduledTask: async () => undefined,
      deleteScheduledTask: async () => {},
      runScheduledTaskNow: async () => {},
      launchThread: async () => ({ threadId: "thread_1" }),
      sendToThread: async () => {},
      readThreadStatus: async () => ({ status: "idle", raw: {} }),
    };
    const disp = { pick: async () => ({ seat: "seat1", providerInstanceId: "p" }), done: async () => {}, status: async () => ({ name: "pool", capacity: 2, available: 1 }) };
    const cycle = createCycle(db, store, {
      enabled: true,
      t3: t3 as never,
      dispatcher: disp,
      publicUrl: "http://x",
      treeTodo: async () => "## To do",
      repoDir: () => repo,
      askedNoRow: async () => askedNoRowSection([{ milestoneId: "m", milestoneTitle: "M", path: "docs/epic.md", spineTitle: "E", id: "E9-3", text: "Third thing works." }]),
    });
    const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
    const p = store.createPersona({ name: persona, remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
    return { cycle, a, done: () => (cycle.stop(), db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
  };
  it("in the Delivery manager's wake; not in another persona's", async () => {
    const dm = cycleSetup("Delivery Manager");
    const w = await dm.cycle.wake(dm.a.id, { threadId: "thread_1" });
    expect(w.prompt).toContain("## Asked, no row yet");
    expect(w.prompt).toContain("- docs/epic.md E9-3: Third thing works.");
    dm.done();
    const other = cycleSetup("Writer");
    const o = await other.cycle.wake(other.a.id, { threadId: "thread_1" });
    expect(o.prompt).not.toContain("Asked, no row yet");
    other.done();
  });
});
