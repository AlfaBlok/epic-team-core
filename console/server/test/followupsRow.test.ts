import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { createReview, type ReviewItem } from "../src/review/review.js";
import { closeGoalStatus, parseFollowups, reopenGoalStatus, tickDoneMeans } from "../src/review/followups.js";
import { computeReviewRows } from "../src/review/rows.js";
import { makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * (mockup v2 = docs/status/e48-8-review-flow-mockup.html; acceptance docs/status/e48-8-acceptance.md):
 * the feed grouped by goal; each card knows its Goal › Done-means line › task and what it closes (step / line / goal /
 * ask); its follow-ups are started or parked, never dropped; New iteration counts; a closed goal hides its open items
 * until it is reopened. Temp repos only.
 */
const EPIC = "docs/spines/epic-59.md";
const ASK_EPIC = "docs/spines/epic-41.md";
const LIVE = "https://team.example/audit";
const today = () => new Date().toISOString().slice(0, 10);

const DONE_MEANS = ["## Done means", "", "- [x] E59-1 three audit reports written", "- [ ] E59-2 every high finding fixed, plain summary for you", ""];
let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s24-"));
  repo = makeRepo(tmp, "home_repo", {
    "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
    [EPIC]: spineText(
      "EPIC-959",
      "Security review",
      [
        { id: "E959-S3", title: "Audit: hosted multi-tenant path (E59-2)", status: "review", evidence: `[report](${LIVE})` },
        { id: "E959-S4", title: "Fix F1 + F3", status: "done (approved by Sam 2026-11-02)" },
        { id: "E959-S5", title: "Fix F2 + F4", status: "review", evidence: `[live](${LIVE})` },
        { id: "E959-S6", title: "Fix F5", status: "active" },
        { id: "E959-S7", title: "Plumbing", status: "done (no confirm: covered by E959-S5)", verified: today() },
        { id: "E959-S8", title: "Summary", status: "active (iteration 2, relaunched by Sam 2026-11-02: shorter)" },
      ],
      DONE_MEANS,
    ),
    [ASK_EPIC]: spineText("EPIC-941", "A private team state repo", [{ id: "E941-S2", title: "Acme/team", status: "review", evidence: `[repo](${LIVE})` }]),
  });
  //'s follow-ups (its Next Action cell)
  setNext(EPIC, "E959-S3", "followups: started E959-S4 (F1 + F3), E959-S5 (F2 + F4); start Confirm and fix leads N1-N4 — N1 may write your secret store; park Isolated box per customer — big, can wait; confirm: yes — a report you read");
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setNext(rel: string, id: string, text: string) {
  const f = path.join(repo.dir, rel);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  const cells = lines[i].split(" | ");
  cells[10] = `${text} |`;
  lines[i] = cells.slice(0, 11).join(" | ");
  fs.writeFileSync(f, lines.join("\n"));
  repo.setRow(rel, id, cells[4]); // commit + push
}

function setup() {
  const store = createStore(db);
  const m = store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
  const dm = store.createPersona({ name: "Delivery manager", remit: "d", skills: [], model: "", mayWrite: false });
  store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
  const woke: { instructions?: string }[] = [];
  const cycle = { runNowRequest: async (_id: string, o: { instructions?: string }) => (woke.push(o), { run: { id: "run_new" } }) };
  const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle, live: { fetch: web({ [LIVE]: 200 }).f, consoleHosts: [] } });
  return { store, review, woke };
}
const byRef = async (review: ReturnType<typeof setup>["review"], ref: string) => {
  await review.list({ wait: true });
  return (await review.list()).find((i) => i.ref === ref) as ReviewItem;
};

describe("E948-S24 followups in the row", () => {
  it("parses started, start / park suggestions, confirm and completes", () => {
    const f = parseFollowups("worker; followups: started E959-S4 (F1 + F3), E959-S5; start Leads N1-N4 — N1 matters; park Boxes — can wait; propose Docs; confirm: yes — you read it; completes: E59-2");
    expect(f.started).toEqual([{ ref: "E959-S4", covers: "F1 + F3" }, { ref: "E959-S5" }]);
    expect(f.suggested).toEqual([
      { title: "Leads N1-N4", why: "N1 matters", recommend: "start" },
      { title: "Boxes", why: "can wait", recommend: "park" },
      { title: "Docs", recommend: "start" },
    ]);
    expect(f.confirm).toEqual({ yes: true, why: "you read it" });
    expect(f.completes).toBe("E59-2");
    expect(parseFollowups("Next steps: started E901-S1").started).toEqual([{ ref: "E901-S1" }]);
    expect(parseFollowups("followups: none")).toEqual({ started: [], suggested: [] });
  });

  it("ticks a Done-means line and closes a goal's Status", () => {
    const t = "## Done means\n\n- [ ] E59-2 every high\n\n## Current State\n\nStatus: active\n";
    expect(tickDoneMeans(t, "E59-2")).toContain("- [x] E59-2 every high");
    expect(tickDoneMeans(t, "E59-9")).toBeUndefined();
    expect(closeGoalStatus(t, "2026-11-02")).toContain("Status: done (closed by Sam 2026-11-02)");
  });

  it("E963-S12: closing a goal writes the Verdict and Outcome the commit gate needs; a worker's sentence is kept; reopen takes them out", () => {
    const withSentence = "# G\n\nGoal sentence: Sam has a brief.\n\n## Outcome\n\nOutcome: a brief is live.\nRisk: none\n\n## Current State\n\nStatus: review\n";
    const c = closeGoalStatus(withSentence, "2026-11-04")!;
    expect(c).toContain("Status: done (closed by Sam 2026-11-04)");
    expect(c).toContain("Verdict: accomplished\n");
    expect(c).toContain("Outcome: a brief is live.\n");
    expect(c).toContain("Closed: 2026-11-04 by Sam (closed on the console's review list)");
    expect(c.match(/^Outcome:/gm)).toHaveLength(1);
    const none = closeGoalStatus("# G\n\nGoal sentence: Sam has a brief.\n\n## Current State\n\nStatus: review\n", "2026-11-04")!;
    expect(none).toMatch(/## Outcome\n\nVerdict: accomplished\nOutcome: Sam has a brief\. .*\nClosed: 2026-11-04 by Sam .*\n\n## Current State/);
    const back = reopenGoalStatus(c, "2026-11-05")!;
    expect(back).toContain("Status: active (reopened by Sam 2026-11-05)");
    expect(back).not.toMatch(/^(Verdict|Closed):/m);
    expect(back).toContain("Outcome: a brief is live.");
  });
});

describe("E948-S24 the card knows where it sits (acceptance 3)", () => {
  it("Goal › Done-means line › task with its tag; started rows with their state; suggestions", () => {
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const p = computeReviewRows(store, tmp);
    const s3 = p.rows.find((r) => r.ref === "E959-S3")!;
    // its title names, but only an explicit `completes:` ties a card to a line
    expect(s3.line).toBeUndefined();
    expect(s3.tag).toBe("step");
    expect(s3.started?.map((s) => [s.ref, s.state, s.covers])).toEqual([
      ["E959-S4", "live", "F1 + F3"],
      ["E959-S5", "live", "F2 + F4"],
    ]);
    expect(s3.suggested?.map((s) => s.recommend)).toEqual(["start", "park"]);
    expect(s3.confirmWhy).toBe("a report you read");
    expect(p.rows.find((r) => r.ref === "E941-S2")?.tag).toBe("step"); // no `completes:`, so a task, never the goal
    const g = p.goals!.find((x) => x.code === "EPIC-959")!;
    expect(g).toMatchObject({ title: "Security review", standalone: false });
    expect(g.doneMeans.map((d) => [d.id, d.met])).toEqual([
      ["E59-1", true],
      ["E59-2", false],
    ]);
    expect(g.running.map((x) => x.ref)).toEqual(["E959-S6"]);
    // acceptance 5: a step with nothing to confirm is one timeline line, never a card
    expect(g.selfClosed.map((x) => [x.ref, x.why])).toEqual([["E959-S7", "covered by E959-S5"]]);
    expect(p.rows.some((r) => r.ref === "E959-S7")).toBe(false);
    // acceptance 9: a row sent back shows as "iteration 2 in work" under its goal
    expect(g.inWork).toEqual([{ ref: "E959-S8", title: "Summary", iteration: 2, words: "shorter", since: "2026-11-02" }]);
  });

  it("two open cards completing one line: all but the last read as a step together with the other; only the last closes it", async () => {
    setNext(EPIC, "E959-S3", "followups: completes: E59-2; confirm: yes — a report");
    setNext(EPIC, "E959-S5", "followups: completes: E59-2; confirm: yes — live fix");
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const rows = computeReviewRows(store, tmp).rows;
    // is the epic's last open line, but other parts of the goal are still open: neither card closes the goal (E948-S53),
    // the last one meets the line
    expect(["E959-S3", "E959-S5"].map((ref) => { const r = rows.find((x) => x.ref === ref)!; return [r.tag, r.lineWith, r.face?.closesGoal]; })).toEqual([
      ["step", ["E959-S5"], false],
      ["line", ["E959-S3"], false],
    ]);
    const { review } = setup();
    const s3 = await byRef(review, "E959-S3");
    const r = await review.complete(s3.id);
    if ("error" in r) throw new Error(r.message);
    expect(repo.read(EPIC)).toContain("- [ ] E59-2"); // a step: the line stays open
    expect((await byRef(review, "E959-S5")).tag).toBe("line"); // now the last card; other parts still open, so not the goal
  });

  it("the last open piece completes the goal only with an explicit completes (never worked out)", () => {
    for (const [id, st] of [["E959-S5", "done (approved by Sam 2026-11-02)"], ["E959-S6", "done (approved by Sam 2026-11-02)"], ["E959-S8", "superseded"]] as const) repo.setRow(EPIC, id, st);
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    expect(computeReviewRows(store, tmp).rows.find((r) => r.ref === "E959-S3")?.tag).toBe("step");
    setNext(EPIC, "E959-S3", "followups: completes: goal; confirm: yes — the report");
    expect(computeReviewRows(store, tmp).rows.find((r) => r.ref === "E959-S3")?.tag).toBe("goal");
  });
});

describe("E948-S24 Complete: every suggestion started or parked, never dropped (acceptance 1, 7)", () => {
  it("start 1, park 1: one commit with the row done and two new rows; the DM is woken for the started one", async () => {
    const { review, woke } = setup();
    const s3 = await byRef(review, "E959-S3");
    const r = await review.complete(s3.id, { start: [0], park: [1] });
    if ("error" in r) throw new Error(r.message);
    expect(r.item.followupRows).toEqual([
      { ref: "E959-S9", title: "Confirm and fix leads N1-N4", status: "ready" },
      { ref: "E959-S10", title: "Isolated box per customer", status: "draft" },
    ]);
    expect(repo.rowLine(EPIC, "E959-S3")).toContain(`| done (approved by Sam ${today()}) |`);
    expect(repo.rowLine(EPIC, "E959-S9")).toMatch(/\| ready \| E959-S3 \|/);
    expect(repo.rowLine(EPIC, "E959-S10")).toMatch(/\| draft \| E959-S3 \|/);
    expect(repo.rowLine(EPIC, "E959-S3")).toContain("followups: started E959-S4 (F1 + F3), E959-S5 (F2 + F4), E959-S9, E959-S10");
    expect(repo.originLog()[0]).toBe("Review E959-S3: step complete, 1 started, 1 parked (Sam, via console)");
    expect(woke).toHaveLength(1);
    expect(woke[0].instructions).toContain("E959-S9 Confirm and fix leads N1-N4");
    // the parked one is counted on the goal
    expect((await review.goals()).find((g) => g.code === "EPIC-959")!.parked.map((x) => x.ref)).toEqual(["E959-S10"]);
  });

  it("refuses a pick that drops a suggestion; Approve (no pick) parks them all and wakes nobody", async () => {
    const { review, woke } = setup();
    const s3 = await byRef(review, "E959-S3");
    const bad = await review.complete(s3.id, { start: [0] });
    expect(bad).toMatchObject({ error: 422, code: "followups_incomplete" });
    expect(repo.rowLine(EPIC, "E959-S3")).toContain("| review |");
    const r = await review.approve(s3.id);
    if ("error" in r) throw new Error(r.message);
    expect(r.item.followupRows?.map((x) => x.status)).toEqual(["draft", "draft"]);
    expect(woke).toEqual([]);
  });

  it("a card that completes a line ticks it; the last open line closes the goal", async () => {
    const { review } = setup();
    fs.writeFileSync(path.join(repo.dir, EPIC), repo.read(EPIC).replace("- [ ] E59-2 every high finding fixed, plain summary for you", "- [ ] E59-2 every high finding fixed, plain summary for you\n- [ ] E59-3 a second open line"));
    setNext(EPIC, "E959-S5", "followups: completes: E59-2; confirm: yes — live fix");
    const s5 = await byRef(review, "E959-S5");
    expect(s5.tag).toBe("line");
    const r = await review.complete(s5.id);
    if ("error" in r) throw new Error(r.message);
    expect(repo.read(EPIC)).toContain("- [x] E59-2 every high");
    expect(repo.read(EPIC)).toContain("Status: active");
    expect(repo.originLog()[0]).toBe("Review E959-S5: E59-2 met (Sam, via console)");
    setNext(ASK_EPIC, "E941-S2", "followups: completes: goal; confirm: yes — your ask");
    const a = await byRef(review, "E941-S2");
    expect(a.face?.closesGoal).toBe(true);
    const ra = await review.complete(a.id);
    if ("error" in ra) throw new Error(ra.message);
    expect(repo.read(ASK_EPIC)).toContain(`Status: done (closed by Sam ${today()})`);
  });
});

describe("E948-S24 closing a goal hides its open items until it is reopened (acceptance 6)", () => {
  it("feed, counts and goals drop every item of a closed goal; reopening brings them back; nothing is deleted", async () => {
    const { review } = setup();
    const before = (await review.list({ state: "feed" })).map((i) => i.ref).sort();
    expect(before).toEqual(["E941-S2", "E959-S3", "E959-S5"]);
    fs.writeFileSync(path.join(repo.dir, EPIC), repo.read(EPIC).replace("Status: active", "Status: done (closed by Sam 2026-11-02)"));
    expect((await review.list({ state: "feed" })).map((i) => i.ref)).toEqual(["E941-S2"]);
    expect((await review.goals()).map((g) => g.code)).toEqual(["EPIC-941"]);
    expect(repo.read(EPIC)).toContain("| E959-S6 |"); // still in the spine
    // listed under Closed goals with what it hides; Reopen writes Status back to active in one commit
    const closed = await review.closedGoals();
    expect(closed.map((g) => [g.code, g.hidden])).toEqual([["EPIC-959", ["E959-S3", "E959-S5", "E959-S6", "E959-S8"]]]);
    repo.setRow(EPIC, "E959-S6", "active"); // commit the close (a worker or the console did it)
    const r = await review.reopen(closed[0].key);
    if ("error" in r) throw new Error(r.message);
    expect(repo.read(EPIC)).toContain(`Status: active (reopened by Sam ${today()})`);
    expect(repo.originLog()[0]).toBe("Goal EPIC-959: reopened (Sam, via console)");
    expect((await review.list({ state: "feed" })).map((i) => i.ref).sort()).toEqual(before);
    expect(await review.closedGoals()).toEqual([]);
  });
});

// E948-S69 (the owner 2026-11-13, vn_9e6f5fa4: "when we have decisions, then the buttons need to be the decisions ... what
// I'm clicking is what's the next step"): a decision button closes the card with his pick written on the row.
describe("E948-S69 a decision button writes his pick", () => {
  it("Yes: plan it starts every next step as a plan, and the row says what he chose", async () => {
    const { review, woke } = setup();
    const s3 = await byRef(review, "E959-S3");
    const r = await review.complete(s3.id, { start: [0, 1], park: [], choice: "Yes: plan it" });
    if ("error" in r) throw new Error(r.message);
    expect(r.item.followupRows?.map((x) => [x.title, x.status])).toEqual([
      ["Plan: Confirm and fix leads N1-N4", "ready"],
      ["Plan: Isolated box per customer", "ready"],
    ]);
    expect(repo.rowLine(EPIC, "E959-S3")).toContain(`| done (approved by Sam ${today()}, chose Yes: plan it) |`);
    expect(repo.originLog()[0]).toBe('Review E959-S3: Sam chose "Yes: plan it", step complete, 2 started, 0 parked (Sam, via console)');
    expect(woke).toHaveLength(1);
  });

  it("No: park it parks every next step, wakes nobody, and the row says No", async () => {
    const { review, woke } = setup();
    const s3 = await byRef(review, "E959-S3");
    const r = await review.complete(s3.id, { park: [0, 1], choice: "No: park it" });
    if ("error" in r) throw new Error(r.message);
    expect(r.item.followupRows?.map((x) => x.status)).toEqual(["draft", "draft"]);
    expect(repo.rowLine(EPIC, "E959-S3")).toContain(`| done (approved by Sam ${today()}, chose No: park it) |`);
    expect(woke).toEqual([]);
  });

  it("a decision with no next step starts its plan as a new ready row; brackets and pipes in a pick are made safe", async () => {
    const { review, woke } = setup();
    const s5 = await byRef(review, "E959-S5");
    const r = await review.complete(s5.id, { choice: "Yes: plan it (now) | x", plan: "Plan: build the used-car price lookup for Spain" });
    if ("error" in r) throw new Error(r.message);
    expect(r.item.followupRows).toEqual([{ ref: expect.stringMatching(/^E959-S\d+$/), title: "Plan: build the used-car price lookup for Spain", status: "ready" }]);
    expect(repo.rowLine(EPIC, "E959-S5")).toContain(`done (approved by Sam ${today()}, chose Yes: plan it now x)`);
    expect(woke).toHaveLength(1);
  });

  it("a choice that keeps or closes what is live makes no row (16 Nov: 'Do: Is this …? (you chose Yes: keep it)')", async () => {
    const { review, woke } = setup();
    const s5 = await byRef(review, "E959-S5");
    const r = await review.complete(s5.id, { choice: "Yes: keep it", plan: "Do: Is this the stop you wanted" });
    if ("error" in r) throw new Error(r.message);
    expect(r.item.followupRows ?? []).toEqual([]);
    expect(repo.rowLine(EPIC, "E959-S5")).toContain(`chose Yes: keep it)`);
    expect(woke).toEqual([]);
  });
});
