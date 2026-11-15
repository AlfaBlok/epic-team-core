import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { WORKER_FINISH_RULE, ROW_CLOSE_RULE } from "../src/cycle/prompts.js";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { createReview, REVIEW_RULE, relaunchBrief, type ReviewItem } from "../src/review/review.js";
import { computeReviewRows, editRowStatus, evidenceLinks, approveCell, relaunchCell, snoozeCell, DONE_UNREVIEWED, awaitsReview } from "../src/review/rows.js";
import { colorFor } from "../src/adapters/tree.js";
import { makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * the review list is a view of the spines. A card is a ledger row in `review`; its links come
 * from the row's Latest Evidence; Approve / Relaunch / Snooze write the row through the spine writer first, and a write
 * that does not happen changes nothing. Dropping the cache and rebuilding it gives the same list.
 */
const EPIC = "docs/spines/epic-59.md";
const LIVE = "https://team.example/audit";
const DOCS = "https://team.example/docs";

let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s2-"));
  repo = makeRepo(tmp, "home_repo", {
    "docs/spines/root.md": "# EPIC: home_repo\n\nRoot spine: self\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
    [EPIC]: spineText(
      "EPIC-959",
      "Security audits",
      [
        { id: "E959-S1", title: "Security audit: home_repo core", status: "review", evidence: `[audit](${LIVE}) and [notes](../status/e59-s1.md); live abc1234` },
        { id: "E959-S2", title: "Security audit: skill", status: "review (waits Sam)", evidence: `${DOCS} report` },
        { id: "E959-S3", title: "No link yet", status: "review", evidence: "e59.test.ts green" },
        { id: "E959-S4", title: "Fixes", status: "active" },
        { id: "E959-S5", title: "Old", status: "done" },
      ],
      ["## Waiting on", "", "- [ask E959-A5: decide @Sam] Which findings ship first? — options: A / B — since: 2026-11-02", ""],
    ),
    "docs/status/e59-s1.md": "notes\n",
  });
  db = openDb(path.join(tmp, "console.db"));
});
const hosts: { close(): void }[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }>;
function boot(o: { answers?: Record<string, number>; readModel?: boolean } = {}) {
  const w = web(o.answers ?? { [LIVE]: 200, [DOCS]: 200, "https://github.com/Acme/home_repo/blob/main/docs/status/e59-s1.md": 200 });
  const app = createApp(db, {
    read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: w.f, consoleHosts: [] } },
    ...(o.readModel ? { readModel: { mode: "in-process" as const, tickMs: 0, patchTtlMs: 60_000, onHost: (h: { close(): void }) => void hosts.push(h) } } : {}),
  });
  const call: Call = async (method, url, body) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call, w };
}
const milestone = (call: Call) => call("POST", "/api/milestones", { title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md" }).then((r) => r.json);
/** The list once its links were checked (the first read checks them in the background). */
const listed = async (call: Call, q = "") => {
  await call("GET", `/api/review-items${q}`);
  await new Promise((r) => setTimeout(r, 20));
  return (await call("GET", `/api/review-items${q}`)).json as (ReviewItem & { milestoneTitle?: string })[];
};

/** Every table and its row count, to prove a refused write changed nothing in console.db. */
const dbShape = () =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]);

describe("E962-S2 rows.ts", () => {
  it("links: http(s) links in the evidence cell, repo files as GitHub pages, bare URLs; once each", () => {
    expect(evidenceLinks(`[audit](${LIVE}) and [notes](../status/e59-s1.md), ${DOCS}, again [x](${LIVE})`, { github: "Acme/home_repo", fileRel: EPIC })).toEqual([
      { url: LIVE, title: "audit" },
      { url: "https://github.com/Acme/home_repo/blob/main/docs/status/e59-s1.md", title: "notes" },
      { url: DOCS, title: DOCS },
    ]);
    expect(evidenceLinks("[notes](../status/x.md)", { fileRel: EPIC })).toEqual([]);
  });

  it("edits only the row's status cell, and refuses a row that left review", () => {
    const text = repo.read(EPIC);
    const e = editRowStatus(text, "E959-S1", approveCell("E959-S1", "2026-11-02"));
    if ("skip" in e) throw new Error(e.skip);
    const before = text.split("\n");
    const after = e.text.split("\n");
    const changed = after.map((l, i) => (l === before[i] ? -1 : i)).filter((i) => i >= 0);
    expect(changed).toHaveLength(1);
    expect(e.after).toContain("| done (approved by Sam 2026-11-02) |");
    expect(e.after).toContain(`[audit](${LIVE})`);
    expect(editRowStatus(text, "E959-S4", approveCell("E959-S4", "2026-11-02"))).toMatchObject({ skip: expect.stringMatching(/not in review/) });
    expect(editRowStatus(text, "E959-S9", approveCell("E959-S9", "2026-11-02"))).toMatchObject({ skip: expect.stringMatching(/not in this spine/) });
    const r = editRowStatus(text, "E959-S1", relaunchCell("E959-S1", "2026-11-02", "make it | shorter (one page)\nplease"));
    expect("skip" in r ? r.skip : r.after).toContain("| active (relaunched by Sam 2026-11-02: make it / shorter [one page] please) |");
    const s = editRowStatus(text, "E959-S2", snoozeCell("E959-S2", "2026-11-09"));
    expect("skip" in s ? s.skip : s.after).toContain("| review (waits Sam) — snoozed until: 2026-11-09 |");
    const back = editRowStatus("skip" in s ? text : s.text, "E959-S2", snoozeCell("E959-S2", undefined));
    expect("skip" in back ? back.skip : back.text).toBe(text);
  });
});

describe("E962-S2 the review list is the spine", () => {
  it("a card per row in review: title from the row, links from its evidence; no link = pending; what Approve closes", async () => {
    const { call } = boot();
    const m = await milestone(call);
    const list = await listed(call);
    expect(list.map((i) => i.ref)).toEqual(["E959-S1", "E959-S2"]);
    const s1 = list[0];
    expect(s1).toMatchObject({ title: "Security audit: home_repo core", state: "review", repo: "home_repo", path: EPIC, milestoneId: m.id, commit: "abc1234", createdAt: "2026-11-02" });
    // the card's one evidence link, never the row's GitHub write-ups
    expect(s1.links.map((l) => l.url)).toEqual([LIVE]);
    expect(s1.closes).toEqual({ row: "E959-S1", epic: "EPIC-959", openRows: ["E959-S2", "E959-S3", "E959-S4"], openAsks: ["E959-A5"] });
    // a row with no card fields is not a card: it goes back to the agents, never to "not live yet"
    expect(((await call("GET", "/api/review-items?state=pending")).json as ReviewItem[]).map((i) => i.ref)).toEqual([]);
    const agents = (await call("GET", "/api/review-items?state=agents")).json as ReviewItem[];
    expect(agents.map((i) => [i.ref, i.verdict.kind])).toEqual([["E959-S3", "needs-rewriting"]]);
    // the count is the live cards (not live yet has its own section)
    expect((await call("GET", "/api/counts")).json.review).toBe(2);
    // Nothing of it is stored as work state: no review_items, only the live check cache.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('review_items','review_links')").all()).toEqual([]);
  });

  it("a link that does not answer keeps its card off the list: it goes back to the agents as needs evidence", async () => {
    const { call } = boot({ answers: { [DOCS]: 200 } });
    await milestone(call);
    expect((await listed(call)).map((i) => i.ref)).toEqual(["E959-S2"]);
    const agents = await listed(call, "?state=agents");
    expect(agents.map((i) => [i.ref, i.verdict.kind])).toEqual([
      ["E959-S1", "needs-evidence"],
      ["E959-S3", "needs-rewriting"],
    ]);
    expect(agents[0].verdict.reason).toMatch(/does not open/);
  });

  it("drop the cache and rebuild it: the same list", async () => {
    const a = boot({ readModel: true });
    await milestone(a.call);
    const before = await listed(a.call);
    expect(before).toHaveLength(2);
    db.exec("DROP TABLE read_model; DROP TABLE review_live;");
    const b = boot({ readModel: true });
    const after = await listed(b.call);
    const strip = (l: ReviewItem[]) => l.map((i) => ({ ...i, checkedAt: undefined, links: i.links.map((x) => ({ ...x, checkedAt: undefined })) }));
    expect(strip(after)).toEqual(strip(before));
    expect(computeReviewRows(createStore(db), tmp)).toEqual(computeReviewRows(createStore(db), tmp));
  });

  it("Approve writes the row done (approved by Sam <date>) in a pushed commit; the card leaves at once", async () => {
    const { call } = boot({ readModel: true });
    await milestone(call);
    const [s1] = await listed(call);
    const r = await call("POST", `/api/review-items/${s1.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: "approved", ref: "E959-S1" });
    expect(r.json.sha).toMatch(/^[0-9a-f]{7,}$/);
    const today = new Date().toISOString().slice(0, 10);
    expect(repo.rowLine(EPIC, "E959-S1")).toContain(`| done (approved by Sam ${today}) |`);
    expect(repo.originLog()[0]).toBe("Review E959-S1: step complete (Sam, via console)");
    expect((await call("GET", "/api/review-items")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S2"]);
    expect((await call("GET", "/api/counts")).json.review).toBe(1);
    // Twice: the row is no longer in review.
    expect((await call("POST", `/api/review-items/${s1.id}/approve`)).status).toBe(404);
  });

  it("Snooze writes ` — snoozed until:` on the row; Unsnooze takes it off; each a commit", async () => {
    const { call } = boot();
    await milestone(call);
    const s2 = (await listed(call)).find((i) => i.ref === "E959-S2")!;
    const sn = await call("POST", `/api/review-items/${s2.id}/snooze`, { until: "2099-01-01" });
    expect(sn.status).toBe(200);
    expect(sn.json.snoozedUntil).toBe("2099-01-01");
    expect(repo.rowLine(EPIC, "E959-S2")).toContain("| review (waits Sam) — snoozed until: 2099-01-01 |");
    expect(repo.originLog()[0]).toBe("Review E959-S2: snoozed until 2099-01-01 (Sam, via console)");
    expect((await call("GET", "/api/review-items")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S1"]);
    expect((await call("GET", "/api/review-items?state=snoozed")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S2"]);
    const un = await call("POST", `/api/review-items/${s2.id}/snooze`, { until: null });
    expect(un.status).toBe(200);
    expect(repo.rowLine(EPIC, "E959-S2")).toContain("| review (waits Sam) |");
    expect(repo.originLog()[0]).toBe("Review E959-S2: unsnoozed (Sam, via console)");
    expect((await call("GET", "/api/review-items")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S1", "E959-S2"]);
  });

  // E948-S83 iteration 2 (the owner 2026-11-14 23:38Z: "There should always be one button which is to park"): Park is a month's
  // snooze written as parked, so the commit and the spine's Decisions say what he pressed; Bring it back takes it off.
  it("Park writes a month on the row as parked, out of the list; Bring it back puts it back", async () => {
    const { call } = boot();
    await milestone(call);
    const s2 = (await listed(call)).find((i) => i.ref === "E959-S2")!;
    expect((await call("POST", `/api/review-items/${s2.id}/snooze`, { days: 30, park: true, extra: 1 })).status).toBe(400);
    const p = await call("POST", `/api/review-items/${s2.id}/snooze`, { days: 30, park: true });
    expect(p.status).toBe(200);
    expect(p.json.snoozedUntil).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    expect(Date.parse(p.json.snoozedUntil) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(repo.rowLine(EPIC, "E959-S2")).toContain(`| review (waits Sam) — snoozed until: ${p.json.snoozedUntil} |`);
    expect(repo.originLog()[0]).toBe(`Review E959-S2: parked until ${p.json.snoozedUntil} (Sam, via console)`);
    expect(execFileSync("git", ["-C", repo.bare, "log", "--format=%b", "-1", "main"], { encoding: "utf8" })).toMatch(/Sam parked "[^"]+" with the card's Park button: it left the inbox until \S+ and comes back by itself; the row stays in review, nothing was decided/);
    expect((await call("GET", "/api/review-items")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S1"]);
    const back = await call("POST", `/api/review-items/${s2.id}/snooze`, { until: null, park: true });
    expect(back.status).toBe(200);
    expect(repo.rowLine(EPIC, "E959-S2")).toContain("| review (waits Sam) |");
    expect(repo.originLog()[0]).toBe("Review E959-S2: brought back (Sam, via console)");
  });

  it("a refused or failed spine write changes nothing: the row and the list stay; the press is saved and says it is landing (E972-S1)", async () => {
    const { call } = boot();
    await milestone(call);
    const [s1] = await listed(call);
    // the press log (presses) is the one table a press that has not landed writes: it is the outbox, not the decision
    const shape = () => dbShape().filter(([name]) => name !== "presses");
    const before = shape();
    const line = repo.rowLine(EPIC, "E959-S1");
    // Refused: the checkout has an uncommitted change. Before a 409 and the press was lost; now it is saved and retried.
    fs.writeFileSync(path.join(repo.dir, "scratch.txt"), "wip");
    const r = await call("POST", `/api/review-items/${s1.id}/approve`);
    expect(r.status).toBe(202);
    expect(r.json.press).toMatchObject({ state: "landing" });
    expect(r.json.press.reason).toMatch(/uncommitted changes.*nothing changed/);
    expect((await call("POST", `/api/review-items/${s1.id}/snooze`, { days: 3 })).status).toBe(202);
    fs.rmSync(path.join(repo.dir, "scratch.txt"));
    // Failed: the push is refused (origin gone): saved and landing too, never shown as done.
    fs.renameSync(repo.bare, `${repo.bare}.away`);
    const f = await call("POST", `/api/review-items/${s1.id}/approve`);
    expect(f.status).toBe(202);
    expect(f.json.press.reason).toMatch(/spine write failed/);
    fs.renameSync(`${repo.bare}.away`, repo.bare);
    expect(repo.rowLine(EPIC, "E959-S1")).toBe(line);
    expect(shape()).toEqual(before);
    expect((await call("GET", "/api/review-items")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S1", "E959-S2"]);
  });

  it("E948-S26 (one flat list): a row marked backlog that passes the gate is a card like any other, in the count", async () => {
    repo.setRow(EPIC, "E959-S4", "review — backlog since: 2026-11-02", `[audit](${LIVE})`);
    const { call } = boot();
    await milestone(call);
    expect((await listed(call)).map((i) => i.ref)).toEqual(["E959-S1", "E959-S2", "E959-S4"]);
    const b = (await listed(call, "?state=backlog")) as (ReviewItem & { backlogSince?: string })[];
    expect(b.map((i) => [i.ref, i.backlogSince])).toEqual([["E959-S4", "2026-11-02"]]);
    expect((await call("GET", "/api/counts")).json.review).toBe(3);
    // Approve still closes it
    expect((await call("POST", `/api/review-items/${b[0].id}/approve`)).status).toBe(200);
    expect(repo.rowLine(EPIC, "E959-S4")).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
  });

  it("(b) a finished row written straight to `done` without Sam stays a card until he marks it; marked or exempt rows do not", async () => {
    repo.setRow(EPIC, "E959-S4", "done", `[fix](${LIVE})`); // agent closed it itself: caught
    repo.setRow(EPIC, "E959-S5", "done (no confirm: plumbing, covered by E959-S1)", `[x](${LIVE})`); // declared: not a card
    const { call } = boot();
    await milestone(call);
    const cards = await listed(call);
    expect(cards.map((i) => [i.ref, !!(i as ReviewItem & { doneUnreviewed?: boolean }).doneUnreviewed])).toEqual([
      ["E959-S1", false],
      ["E959-S2", false],
      ["E959-S4", true],
    ]);
    // done before DONE_UNREVIEWED_SINCE (old rules), or with no live result: not caught
    expect(computeReviewRows({ listMilestones: () => [] } as never, tmp).rows).toEqual([]);
    const s4 = cards.find((i) => i.ref === "E959-S4")!;
    expect((await call("POST", `/api/review-items/${s4.id}/approve`)).status).toBe(200);
    expect(repo.rowLine(EPIC, "E959-S4")).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
    expect((await call("GET", "/api/review-items")).json.map((i: ReviewItem) => i.ref)).toEqual(["E959-S1", "E959-S2"]);
  });

  it("(b) an old done row (verified before 2026-11-02) or one with no link is not caught", () => {
    const text = spineText("EPIC-909", "x", [
      { id: "E909-S1", status: "done", evidence: `[a](${LIVE})`, verified: "2026-10-30" },
      { id: "E909-S2", status: "done", evidence: "tests green", verified: "2026-11-03" },
      { id: "E909-S3", status: "done (fed E909-A1)", evidence: `[a](${LIVE})`, verified: "2026-11-03" },
      { id: "E909-S4", status: "done", evidence: `[a](${LIVE})`, verified: "2026-11-03" },
      // a sibling folded into the row that keeps the card (root L-51) is closed, never a second card
      { id: "E909-S5", status: "done (folded into E909-S4)", evidence: `[a](${LIVE})`, verified: "2026-11-03" },
    ]);
    fs.writeFileSync(path.join(repo.dir, "docs/spines/epic-9.md"), text);
    const ms = [{ id: "ms_1", repo: "Acme/home_repo", path: "docs/spines/root.md" }];
    const rows = computeReviewRows({ listMilestones: () => ms } as never, tmp).rows.filter((r) => r.path.endsWith("epic-9.md"));
    expect(rows.map((r) => [r.ref, r.doneUnreviewed])).toEqual([["E909-S4", true]]);
  });

  it("E948-S32: `done (folded into <row>)` and `done (fed <ask>)` are closed without a card and green in the tree", () => {
    for (const st of ["done (folded into E947-S4)", "done (fed E948-A3)", "done (folded into E947-S4, no confirm: one card)"]) {
      expect(DONE_UNREVIEWED(st)).toBe(false);
      expect(awaitsReview(st)).toBe(false);
      expect(colorFor(st).color).toBe("green");
    }
    expect(DONE_UNREVIEWED("done")).toBe(true);
  });

  it("a row reopened or closed in the spine leaves the list by itself (the card is the row)", async () => {
    const { call } = boot();
    await milestone(call);
    expect((await listed(call)).map((i) => i.ref)).toEqual(["E959-S1", "E959-S2"]);
    repo.setRow(EPIC, "E959-S1", "active");
    repo.setRow(EPIC, "E959-S2", "done (fed E959-A5)");
    expect((await call("GET", "/api/review-items")).json).toEqual([]);
  });

  it("the run PATCH `review` and POST /api/review-items are hints: nothing is stored", async () => {
    const { call } = boot();
    const m = await milestone(call);
    const p = (await call("POST", "/api/personas", { name: "Delivery manager", remit: "runs it" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    const run = (await call("POST", "/api/runs", { assignmentId: a.id, summary: "w" })).json;
    const done = await call("PATCH", `/api/runs/${run.id}`, { outcome: "progressed", summary: "live", endedAt: new Date().toISOString(), review: { url: "https://x.dev/", ref: "E959-S9" } });
    expect(done.status).toBe(200);
    const h = await call("POST", "/api/review-items", { title: "x", liveUrl: "https://x.dev/", milestoneId: m.id });
    expect(h.status).toBe(202);
    expect(h.json.message).toMatch(/read from the spine/);
    expect((await listed(call)).map((i) => i.ref)).toEqual(["E959-S1", "E959-S2"]);
  });
});

describe("E967-S1 Deny", () => {
  it("writes the row superseded (denied by Sam <date>: his words) and commits; nobody is woken; a second press changes nothing", async () => {
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const woke: string[] = [];
    const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle: { runNowRequest: async (id: string) => (woke.push(id), { run: { id: "x" } }) }, live: { fetch: web({ [LIVE]: 200, [DOCS]: 200 }).f, consoleHosts: [] } });
    await review.list({ wait: true });
    const s2 = (await review.list()).find((i) => i.ref === "E959-S2")!;
    const r = await review.deny(s2.id, "not needed (any more)");
    expect("error" in r ? r : r.item).toMatchObject({ state: "denied" });
    const today = new Date().toISOString().slice(0, 10);
    expect(repo.rowLine(EPIC, "E959-S2")).toContain(`| superseded (denied by Sam ${today}: not needed [any more]) |`);
    expect(repo.originLog()[0]).toBe("Review E959-S2: denied (Sam, via console)");
    expect(woke).toEqual([]);
    expect(await review.deny(s2.id, "again")).toMatchObject({ error: 404 });
  });
});

describe("E962-S2 Relaunch", () => {
  it("writes the row active (relaunched by Sam <date>: his words), then wakes the Delivery manager", async () => {
    const store = createStore(db);
    const m = store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const dm = store.createPersona({ name: "Delivery manager", remit: "d", skills: [], model: "", mayWrite: false });
    const dmA = store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const woke: { id: string; instructions?: string; by?: string }[] = [];
    const cycle = {
      runNowRequest: async (id: string, o: { instructions?: string; instructionsBy?: string }) => {
        woke.push({ id, instructions: o.instructions, by: o.instructionsBy });
        return { run: { id: "run_new" } };
      },
    };
    const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle, live: { fetch: web({ [LIVE]: 200, [DOCS]: 200 }).f, consoleHosts: [] } });
    await review.list({ wait: true });
    const s2 = (await review.list()).find((i) => i.ref === "E959-S2")!;
    const r = await review.relaunch(s2.id, "split the report by severity");
    expect("error" in r ? r : r.item).toMatchObject({ state: "relaunched" });
    const today = new Date().toISOString().slice(0, 10);
    expect(repo.rowLine(EPIC, "E959-S2")).toContain(`| active (iteration 2, relaunched by Sam ${today}: split the report by severity) |`);
    expect(repo.originLog()[0]).toBe("Review E959-S2: relaunched (Sam, via console)");
    expect(woke).toHaveLength(1);
    expect(woke[0]).toMatchObject({ id: dmA.id, by: "Sam" });
    expect(woke[0].instructions).toContain("split the report by severity");
    expect(woke[0].instructions).toContain(`row E959-S2 in ${EPIC}`);
  });

  it("no persona to wake: nothing is written", async () => {
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle: { runNowRequest: async () => ({ run: { id: "x" } }) }, live: { fetch: web({ [DOCS]: 200 }).f, consoleHosts: [] } });
    const s2 = (await review.list({ state: "all" })).find((i) => i.ref === "E959-S2")!;
    expect(await review.relaunch(s2.id, "again")).toMatchObject({ error: 422 });
    expect(repo.rowLine(EPIC, "E959-S2")).toContain("| review (waits Sam) |");
  });

  it("the brief names the row, its file, the live link and L-34", () => {
    const b = relaunchBrief({ title: "Book", ref: "E940-S2", path: "docs/spines/epic-40.md", liveUrl: "https://team.example.com/book", links: [{ url: "https://team.example.com/book", title: "Book" }] }, "faster", "abc1234");
    expect(b).toMatch(/Sam reviewed "Book" \(E940-S2\).*https:\/\/team\.example\.com\/book.*His words, the brief: faster.*row E940-S2 in docs\/spines\/epic-40\.md.*abc1234.*L-34.*Latest Evidence/);
  });
});

describe("E962-S2 rules agents get", () => {
  it("workers put the live link in the row's evidence; nobody sends `review` on the PATCH", () => {
    for (const rule of [REVIEW_RULE, ROW_CLOSE_RULE]) {
      expect(rule).toContain("L-43");
      // every worker writes the card fields; one good and one bad example
      expect(rule).toContain("docs/review-cards.md");
      expect(rule).toContain("confirm: yes");
      expect(rule).toContain("https://notes.example.com/connect");
      expect(rule).toContain("Cluster F");
    }
    expect(REVIEW_RULE).toContain("Latest Evidence");
    expect(REVIEW_RULE).toContain("L-45");
    expect(REVIEW_RULE).not.toMatch(/"review": \{"url"/);
    expect(WORKER_FINISH_RULE).toBeTruthy();
  });
});
