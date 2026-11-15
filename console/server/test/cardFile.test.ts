import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { CARD_FIELDS_RULE, createReview, REVIEW_RULE, reviewItemsOf, type ReviewItem } from "../src/review/review.js";
import { ROW_CLOSE_RULE } from "../src/cycle/prompts.js";
import { evidenceProblem, gateProblems, hasVerb, parseCard, plainProblem } from "../src/review/card.js";
import { computeReviewRows } from "../src/review/rows.js";
import { treeOf } from "../src/review/face.js";
import { createAgentWake } from "../src/review/agentWake.js";
import { cardText, makeRepo, PNG_1PX, spineText, web } from "./reviewFixture.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * (the owner 2026-11-03, approved mockup docs/status/e948-s26/real-feed-mockup.html; spec docs/status/e948-s26-card-spec.md):
 * the card fields live in the repo; a row becomes a card only when its fields pass the plain-language gate; the rest goes
 * back to the agents; "completes" is never worked out from title text; two cards never both close one line; no gate bypass.
 * Temp repos only.
 */
const EPIC = "docs/spines/epic-941.md";
const LIVE = "https://team.example/";
const ROOT = "# EPIC: home_repo\n\nProject name: [The team console](https://team.example/)\nRoot spine: self\n\n## Current State\n\nStatus: active\n";

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s26-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DONE_MEANS = ["## Done means", "", "- [x] E41-1 a private team repo", "- [ ] E41-4 the desk hands work to another desk", ""];

function repoWith(rows: Parameters<typeof spineText>[2], cards: Record<string, string> = {}, extra: string[] = DONE_MEANS) {
  const text = spineText("EPIC-941", "Desk home", rows, ["Goal sentence: Give the team desk a home of its own.", "", ...extra]).replace("Project name: [The team console](https://team.example/)\n", "");
  const files: Record<string, string> = { "docs/spines/root.md": ROOT, [EPIC]: text, "docs/cards/shot.png": "" };
  for (const [id, c] of Object.entries(cards)) files[`docs/cards/${id}.md`] = c;
  return makeRepo(tmp, "home_repo", files, { cards: false });
}

function setup() {
  const store = createStore(db);
  const m = store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
  const dm = store.createPersona({ name: "Delivery manager", remit: "d", skills: [], model: "", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const woke: { id: string; instructions?: string; key?: string }[] = [];
  const cycle = { runNowRequest: async (id: string, o: { instructions?: string }, key?: string) => (woke.push({ id, ...o, key }), { run: { id: `run_${woke.length}` } }) };
  const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle, live: { fetch: web({ [LIVE]: 200, "https://team.example/dead": 404, "https://team.example/team/": 200, "https://team.example/team/#tree": 200 }).f, consoleHosts: [] } });
  return { store, m, a, review, woke, cycle };
}
const listed = async (review: ReturnType<typeof setup>["review"], state?: "agents" | "test" | "all") => {
  await review.list({ wait: true, ...(state ? { state } : {}) });
  return review.list(state ? { state } : {});
};

const GOOD = (id: string, o: Parameters<typeof cardText>[1] = {}) => cardText(id, { evidence: LIVE, ...o });

describe("E948-S26 the card file", () => {
  it("parses the fields tolerantly: synonyms, ✓ / ✗ / [x] / no:, one-line lists, quotes, links", () => {
    const c = parseCard(
      [
        "---",
        "Row: E941-S2",
        'What you are marking as complete: "The Team page was split into Focus and Other milestones, so you choose what shows at the top."',
        "The goal of this task: You decide which projects sit at the top.",
        "What was delivered:",
        "- ✓ Your main projects sit under Focus milestones.",
        "  - [ ] Not yet seen on your phone.",
        "  - no: The order is not kept after a restart.",
        "evidence: [Open Team home](https://team.example.com/)",
        "screenshot: e941-s2/focus.png",
        "next: start: Build the health page — it is the point · park: A phone alert",
        "completes: E41-1",
        "confirm: yes — you use it every day",
        "example of: E941-S1",
        "---",
        "notes",
      ].join("\n"),
    )!;
    expect(c.row).toBe("E941-S2");
    expect(c.title).toBe("The Team page was split into Focus and Other milestones, so you choose what shows at the top.");
    expect(c.goal).toBe("You decide which projects sit at the top.");
    expect(c.delivered).toEqual([
      { ok: true, text: "Your main projects sit under Focus milestones." },
      { ok: false, text: "Not yet seen on your phone." },
      { ok: false, text: "The order is not kept after a restart." },
    ]);
    expect([c.evidenceUrl, c.evidenceLabel, c.screenshot]).toEqual(["https://team.example.com/", "Open Team home", "e941-s2/focus.png"]);
    expect(c.next).toEqual([
      { title: "Build the health page", why: "it is the point", recommend: "start" },
      { title: "A phone alert", recommend: "park" },
    ]);
    expect([c.completes, c.confirm, c.exampleOf]).toEqual(["E41-1", { yes: true, why: "you use it every day" }, "E941-S1"]);
    expect(parseCard("# no front matter\n")).toBeUndefined();
    expect(parseCard("---\nrow: X\nnext: none\n---\n")).toMatchObject({ next: [], nextNone: true });
  });
});

describe("E948-S26 the gate (plain words, L-48)", () => {
  it("a title needs a verb: the noun phrases Sam had to read three times fail", () => {
    for (const t of ["The new Focus and Other sections, with a Pin button.", "Your big projects at the top of the sidebar.", "The Notes logo and a page that shows people how to connect."]) expect(hasVerb(t), t).toBe(false);
    for (const t of [
      "The Notes logo and a how to connect page were created for MCP and AI directory listings.",
      "The Team page was split into Focus and Other milestones.",
      "Private chats moved to their own Messages page.",
      "The team built one page per post.",
    ])
      expect(hasVerb(t), t).toBe(true);
    const p = gateProblems({ card: parseCard(GOOD("E941-S2", { title: "The new Focus and Other sections, with a Pin button." }))!, project: "The team console", goalSentence: "Give the team desk a home.", screenshotFound: true });
    expect(p).toContain("the title has no verb: write one full sentence in the past tense");
  });

  it("no ; ( / | outside links, no row codes, no file paths, no approve; length limits; links may hold a slash", () => {
    expect(plainProblem("t", "It works; mostly.", 20)).toMatch(/semicolon/);
    expect(plainProblem("t", "It works (mostly).", 20)).toMatch(/bracket/);
    expect(plainProblem("t", "Laptop/phone both work.", 20)).toMatch(/slash/);
    expect(plainProblem("t", "Fixed as part of E962-S8.", 20)).toMatch(/row code/);
    expect(plainProblem("t", "See docs/status/e948-s26.md for more.", 20)).toBeTruthy();
    expect(plainProblem("t", "Please approve this.", 20)).toMatch(/approve/);
    expect(plainProblem("t", "one two three four five six", 5)).toMatch(/longer than 5/);
    expect(plainProblem("t", "[memo.example.com/connect](https://memo.example.com/connect) is live, with steps for Claude.", 20)).toBeUndefined();
    expect(plainProblem("t", "Open https://memo.example.com/connect and check.", 20)).toBeUndefined();
  });

  it("evidence: missing, GitHub or a dry run goes back as needs evidence", () => {
    const c = (ev: string, more: string[] = []) => parseCard(["---", "row: X", `evidence: ${ev}`, ...more, "---"].join("\n"));
    expect(evidenceProblem(c("https://github.com/Acme/home_repo/issues/9"))).toMatch(/GitHub/);
    expect(evidenceProblem(c("see the status page"))).toMatch(/not a link/);
    expect(evidenceProblem(c("https://social.example.com/x", ["delivered:", "  - ✓ A dry run posted nothing."]))).toMatch(/dry run/);
    expect(evidenceProblem(c("https://social.example.com/x"))).toBeUndefined();
  });
});

describe("E948-S26 what becomes a card (decided from the spine)", () => {
  it("cards, closes itself, needs evidence, card needs rewriting: only cards are listed and counted", async () => {
    repoWith(
      [
        { id: "E941-S1", title: "card", status: "review", evidence: LIVE },
        { id: "E941-S2", title: "no confirm", status: "review", evidence: LIVE, next: "followups: none" },
        { id: "E941-S3", title: "GitHub only", status: "review", evidence: LIVE },
        { id: "E941-S4", title: "Cluster F (violation 8 + grey runs monitoring, desk_placement, ask_memory): Unblocker rubric settings", status: "review", evidence: LIVE },
        { id: "E941-S5", title: "an example", status: "review", evidence: LIVE },
        { id: "E941-S6", title: "dead link", status: "review", evidence: LIVE },
        { id: "E941-S7", title: "no card file", status: "review", evidence: LIVE },
      ],
      {
        "E941-S1": GOOD("E941-S1"),
        "E941-S2": GOOD("E941-S2").replace("confirm: yes\n", ""),
        "E941-S3": GOOD("E941-S3", { evidence: "https://github.com/Acme/home_repo/blob/main/docs/status/x.md" }),
        "E941-S4": GOOD("E941-S4", { title: "Cluster F (violation 8 + grey runs monitoring, desk_placement, ask_memory): Unblocker rubric settings and run-reported state into the repo" }),
        "E941-S5": GOOD("E941-S5", { extra: ["example of: E941-S1"] }),
        "E941-S6": GOOD("E941-S6", { evidence: "https://team.example/dead" }),
      },
    );
    const { review } = setup();
    expect((await listed(review)).map((i) => i.ref)).toEqual(["E941-S1"]);
    const agents = await listed(review, "agents");
    expect(agents.map((i) => [i.ref, i.verdict.kind])).toEqual([
      ["E941-S2", "closes-itself"],
      ["E941-S3", "needs-evidence"],
      ["E941-S4", "needs-rewriting"],
      ["E941-S5", "closes-itself"],
      ["E941-S6", "needs-evidence"],
      ["E941-S7", "needs-rewriting"],
    ]);
    expect(agents.find((i) => i.ref === "E941-S4")!.verdict.problems).toEqual(expect.arrayContaining(["the title has no verb: write one full sentence in the past tense", "the title has a semicolon, a bracket or a pipe"]));
    // the count is the cards (badge = sidebar = header)
    expect(reviewItemsOf(db, createStore(db), tmp).map((i) => i.ref)).toEqual(["E941-S1"]);
  });

  it("no gate bypass: Mark complete, New iteration and Snooze refuse a row that is not a card, and nothing is written", async () => {
    const repo = repoWith([{ id: "E941-S4", title: "Cluster F", status: "review", evidence: LIVE }], { "E941-S4": GOOD("E941-S4", { title: "Cluster F (violation 8): settings into the repo" }) });
    const { review, woke } = setup();
    const [row] = computeReviewRows(createStore(db), tmp).rows;
    expect(row.verdict.kind).toBe("needs-rewriting");
    const before = repo.read(EPIC);
    for (const r of [await review.complete(row.id), await review.relaunch(row.id, "words"), await review.snooze(row.id, "2026-12-01")]) expect(r).toMatchObject({ error: 409, code: "not_a_card" });
    expect(repo.read(EPIC)).toBe(before);
    expect(woke).toEqual([]);
  });

  it("a test goal (TEST repo, T9xx row) is on no production list or count; its buttons still work by id", async () => {
    const t = makeRepo(tmp, "e48-8-acceptance-test", { "docs/spines/root.md": ROOT + "Goal sentence: Check the buttons.\n" + spineText("EPIC-901", "x", [{ id: "T901-S1", status: "review", evidence: LIVE }]).split("## Issue Ledger")[1].replace(/^/, "## Issue Ledger") });
    void t;
    const { store, review } = setup();
    store.createMilestone({ title: "test", repo: "e48-8-acceptance-test", path: "docs/spines/root.md", owner: "", paused: false });
    expect((await listed(review)).map((i) => i.ref)).toEqual([]);
    const test = await listed(review, "test");
    expect(test.map((i) => [i.ref, i.verdict.kind])).toEqual([["T901-S1", "test"]]);
    const r = await review.complete(test[0].id);
    expect("item" in r, JSON.stringify(r)).toBe(true);
  });
});

describe("E948-S26 completes: never worked out from the title (the E941-S2 bug)", () => {
  it("a title naming a Done-means line is a task; only an explicit completes on the last open line closes the goal", async () => {
    repoWith([{ id: "E941-S2", title: "Focus milestones (E41-5) and the team state repo (E41-4 hand-off mentioned)", status: "review", evidence: LIVE }], { "E941-S2": GOOD("E941-S2") });
    const { review } = setup();
    const [c] = await listed(review);
    expect([c.tag, c.line, c.face?.closesGoal]).toEqual(["step", undefined, false]);
  });

  it("explicit completes on the last open line is case C; two cards on one line: only the last closes it", async () => {
    repoWith(
      [
        { id: "E941-S5", title: "a", status: "review", evidence: LIVE },
        { id: "E941-S6", title: "b", status: "review", evidence: LIVE },
        { id: "E941-S7", title: "c", status: "done" },
        { id: "E941-S8", title: "d", status: "draft (parked by Sam)" },
      ],
      { "E941-S5": GOOD("E941-S5", { completes: "E41-4" }), "E941-S6": GOOD("E941-S6", { completes: "E41-4" }) },
    );
    const { review } = setup();
    const cards = await listed(review);
    // E948-S53: another card of the goal still waits for his review, so neither closes the goal yet; both meet the line
    expect(cards.map((i) => [i.ref, i.tag, i.face?.closesGoal])).toEqual([
      ["E941-S5", "step", false],
      ["E941-S6", "line", false],
    ]);
  });
});

describe("E948-S53 a card never offers to close a goal that still has open parts", () => {
  const ROWS = (other: string) => [
    { id: "E941-S5", title: "a", status: "review", evidence: LIVE },
    { id: "E941-S6", title: "b", status: other },
  ];

  it("completes: goal while another part is worked on: card needs rewriting, never his card", async () => {
    repoWith(ROWS("active"), { "E941-S5": GOOD("E941-S5", { completes: "goal" }) });
    const { review } = setup();
    const all = await listed(review, "all");
    const c = all.find((i) => i.ref === "E941-S5")!;
    expect(c.verdict.kind).toBe("needs-rewriting");
    expect(c.verdict.problems?.join(" ")).toContain("still open (E941-S6)");
    expect([c.tag, c.face?.closesGoal]).toEqual(["step", false]);
    expect((await listed(review)).map((i) => i.ref)).not.toContain("E941-S5");
  });

  it("completes: goal with only parked parts left: closes the goal at once, the parked part named on the face", async () => {
    repoWith(ROWS("draft (parked by Sam 2026-11-12)"), { "E941-S5": GOOD("E941-S5", { completes: "goal" }) });
    const { review } = setup();
    const [c] = await listed(review);
    expect([c.ref, c.verdict.kind, c.tag, c.face?.closesGoal]).toEqual(["E941-S5", "card", "goal", true]);
    expect(c.face?.openInGoal.map((o) => o.ref)).toEqual(["E941-S6"]);
  });

  it("completes: goal when every other part is done: closes the goal", async () => {
    repoWith(ROWS("done"), { "E941-S5": GOOD("E941-S5", { completes: "goal" }) });
    const { review } = setup();
    const [c] = await listed(review);
    expect([c.tag, c.face?.closesGoal, c.face?.openInGoal]).toEqual(["goal", true, []]);
  });

  it("the last open Done-means line with other parts still active meets the line and leaves the goal open", async () => {
    repoWith(ROWS("ready"), { "E941-S5": GOOD("E941-S5", { completes: "E41-4" }) });
    const { review } = setup();
    const [c] = await listed(review);
    expect([c.verdict.kind, c.tag, c.face?.closesGoal]).toEqual(["card", "line", false]);
  });
});

describe("E948-S26 the card face", () => {
  it("project from the root spine, the epic's goal sentence, K of M tasks done, the tree, the screenshot", async () => {
    repoWith(
      [
        { id: "E941-S1", title: "repo", status: "done (approved by Sam 2026-11-01)" },
        { id: "E941-S2", title: "focus", status: "review", evidence: LIVE },
        { id: "E941-S3", title: "index", status: "review", evidence: LIVE },
        { id: "E941-S4", title: "endpoints", status: "ready" },
        { id: "E941-S9", title: "old", status: "superseded" },
      ],
      { "E941-S2": GOOD("E941-S2", { extra: ["name: Focus milestones and the team repo", "after: Next the team desk places your next idea."] }) },
      ["## Plain names", "", "- E941-S1: A private team repo was made.", "- E941-S4: the desk can do everything the console does", ""],
    );
    const { review } = setup();
    const [c] = await listed(review);
    expect(c.face).toMatchObject({
      project: { name: "The team console", url: "https://team.example/" },
      goal: { text: "Give the team desk a home of its own", code: "EPIC-941" },
      tasks: { done: 1, total: 4 },
      title: "The test page was built so you can open it and check it.",
      evidence: { url: LIVE },
      screenshot: "docs/cards/shot.png",
      after: "Next the team desk places your next idea.",
      closesGoal: false,
    });
    expect(c.face!.tree).toEqual([
      { mark: "done", text: "A private team repo was made." },
      { mark: "progress", text: "1 other task is in progress or waiting for your check" },
      { mark: "this", text: "This task: Focus milestones and the team repo" },
      { mark: "next", text: "Next: the desk can do everything the console does" },
    ]);
    const shot = await review.screenshot(c.id);
    expect(shot?.type).toBe("image/png");
    expect(fs.readFileSync(shot!.abs)).toEqual(PNG_1PX);
  });

  it("the tree: at most 4 lines besides the goal, counts when tasks have no plain name", () => {
    const t = treeOf(
      [
        { ref: "A1", status: "done" },
        { ref: "A2", status: "done" },
        { ref: "A3", status: "review", name: "The messages page" },
        { ref: "A4", status: "active" },
        { ref: "A5", status: "review" },
        { ref: "A6", status: "draft" },
        { ref: "A7", status: "ready" },
      ],
      "A5",
      "the post page",
    );
    expect(t.tasks).toEqual({ done: 2, total: 7 });
    expect(t.lines).toEqual([
      { mark: "done", text: "2 earlier tasks are done." },
      { mark: "progress", text: "The messages page", sub: "waiting for your check · 1 more in progress" },
      { mark: "this", text: "This task: the post page" },
      { mark: "next", text: "2 more tasks are planned" },
    ]);
  });

  it("GET /api/review-items lists the face; the screenshot route serves the image; ?state=agents names what to fix", async () => {
    repoWith([{ id: "E941-S2", title: "focus", status: "review", evidence: LIVE }, { id: "E941-S3", title: "x", status: "review", evidence: LIVE }], { "E941-S2": GOOD("E941-S2") });
    const app = createApp(db, { read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] }, review: { live: { fetch: web({ [LIVE]: 200 }).f, consoleHosts: [] } } });
    const call = async (url: string) => app.request(url);
    await (await app.request("/api/milestones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md" }) })).text();
    await (await call("/api/review-items")).text();
    await new Promise((r) => setTimeout(r, 30));
    const list = (await (await call("/api/review-items")).json()) as ReviewItem[];
    expect(list.map((i) => i.ref)).toEqual(["E941-S2"]);
    const img = await call(`/api/review-items/${list[0].id}/screenshot`);
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/png"]);
    const agents = (await (await call("/api/review-items?state=agents")).json()) as ReviewItem[];
    expect(agents.map((i) => [i.ref, i.verdict.kind])).toEqual([["E941-S3", "needs-rewriting"]]);
    expect((await (await call("/api/counts")).json()).review).toBe(1);
  });
});

describe("E948-S26 the agents are told (DM woken once per new item, never a switched-off one)", () => {
  it("one wake per new item; the same items again wake nobody; a new item wakes again", async () => {
    repoWith([{ id: "E941-S3", title: "x", status: "review", evidence: LIVE }], {});
    const { store, review, woke, cycle } = setup();
    const gate = createAgentWake({ db, store, agents: () => review.list({ state: "agents", wait: true }), cycle });
    expect(await gate.sweep()).toHaveLength(1);
    expect(woke[0].instructions).toMatch(/E941-S3 .*card needs rewriting: it has no card file/);
    expect(await gate.sweep()).toEqual([]);
    expect(woke).toHaveLength(1);
  });

  it("a switched-off Delivery manager is never woken (L-10)", async () => {
    repoWith([{ id: "E941-S3", title: "x", status: "review", evidence: LIVE }], {});
    const { store, a, review, woke, cycle } = setup();
    store.updateAssignment(a.id, { enabled: false });
    const gate = createAgentWake({ db, store, agents: () => review.list({ state: "agents", wait: true }), cycle });
    expect(await gate.sweep()).toEqual([]);
    expect(woke).toEqual([]);
  });
});

describe("E948-S26 the rules every worker gets", () => {
  it("REVIEW_RULE and the worker finish rule ask for the card fields, with the good and the bad example", () => {
    for (const r of [REVIEW_RULE, ROW_CLOSE_RULE]) {
      expect(r).toContain(CARD_FIELDS_RULE);
      expect(r).toContain("docs/cards/<row>.md");
    }
    expect(CARD_FIELDS_RULE).toMatch(/Good \(the Notes connect card\)/);
    expect(CARD_FIELDS_RULE).toMatch(/Bad \(never again\): "Cluster F/);
  });
});

describe("E963-S8 a row that closes itself is written done in the spine at once", () => {
  it("the gate sets it `done (no confirm: <why>)` through the spine writer; cards and rows needing work stay in review", async () => {
    const r = repoWith(
      [
        { id: "E941-S1", title: "card", status: "review", evidence: LIVE },
        { id: "E941-S2", title: "no confirm", status: "review", evidence: LIVE, next: "followups: none" },
        { id: "E941-S3", title: "GitHub only", status: "review", evidence: LIVE },
        { id: "E941-S5", title: "an example", status: "review", evidence: LIVE },
      ],
      {
        "E941-S1": GOOD("E941-S1"),
        "E941-S2": GOOD("E941-S2").replace("confirm: yes\n", ""),
        "E941-S3": GOOD("E941-S3", { evidence: "https://github.com/Acme/home_repo/blob/main/docs/status/x.md" }),
        "E941-S5": GOOD("E941-S5", { extra: ["example of: E941-S1"] }),
      },
    );
    const { store, review, woke, cycle } = setup();
    const gate = createAgentWake({ db, store, agents: () => review.list({ state: "agents", wait: true }), closeSelf: () => review.closeSelf(), cycle });
    await gate.sweep();
    const cell = (id: string) => r.rowLine(EPIC, id)!.split(" | ")[4];
    expect(cell("E941-S2")).toBe("done (no confirm: nothing for Sam to open and judge)");
    expect(cell("E941-S5")).toBe("done (no confirm: an example made for E941-S1: that feature's card is the one card)");
    expect(cell("E941-S1")).toBe("review");
    expect(cell("E941-S3")).toBe("review");
    // pushed on main, one commit per row, named so does not flag it
    const subjects = execFileSync("git", ["-C", path.join(tmp, "_origins", "home_repo.git"), "log", "--format=%s", "main"], { encoding: "utf8" }).split("\n");
    expect(subjects).toEqual(expect.arrayContaining(["Close E941-S2: done (no confirm), nothing for Sam to judge (console)", "Close E941-S5: done (no confirm), nothing for Sam to judge (console)"]));
    // the Delivery manager is told only of what still needs it
    expect(woke).toHaveLength(1);
    expect(woke[0].instructions).toContain("E941-S3");
    expect(woke[0].instructions).not.toContain("E941-S2");
    // the feed and the spine agree: the closed rows are a timeline line, never in review
    expect((await listed(review, "agents")).map((i) => i.ref)).toEqual(["E941-S3"]);
    expect(await review.closeSelf()).toEqual([]);
  });

  it("a refused write is retried later, not every minute", async () => {
    const r = repoWith([{ id: "E941-S2", title: "no confirm", status: "review", evidence: LIVE, next: "followups: none" }], { "E941-S2": GOOD("E941-S2").replace("confirm: yes\n", "") });
    const { review } = setup();
    fs.writeFileSync(path.join(tmp, "home_repo", "dirty.txt"), "x"); // uncommitted change: the writer refuses
    expect(await review.closeSelf()).toMatchObject([{ ref: "E941-S2", status: "skipped" }]);
    expect(await review.closeSelf()).toEqual([]);
    expect(r.rowLine(EPIC, "E941-S2")!.split(" | ")[4]).toBe("review");
  });
});

describe("E943-S7 one page, one card (Sam 2026-11-08: \"I feel this approval was asked TWICE\")", () => {
  const PREVIEW = "https://team.example/team/";
  it("two cards on one page from one branch: only the freshest stays a card, the other goes back to fold into it", async () => {
    repoWith(
      [
        { id: "E941-S6", title: "home page", status: "review", evidence: LIVE, verified: "2026-11-06", branch: "epicspine-skill branch wt/pages d9ea0a5 (not merged)" },
        { id: "E941-S7", title: "real screens", status: "review", evidence: PREVIEW, verified: "2026-11-06", branch: "epicspine-skill branch wt/pages d9ea0a5 (not merged)" },
        { id: "E941-S8", title: "the tree", status: "review", evidence: `${PREVIEW}#tree`, verified: "2026-11-08", branch: "epicspine-skill branch wt/pages bfc667e (not merged)" },
        { id: "E941-S9", title: "same page, own branch", status: "review", evidence: PREVIEW, verified: "2026-11-08", branch: "home_repo branch wt/other" },
        { id: "E941-S10", title: "same page, on main", status: "review", evidence: PREVIEW, verified: "2026-11-08", branch: "main" },
      ],
      {
        "E941-S6": GOOD("E941-S6"),
        "E941-S7": GOOD("E941-S7", { evidence: PREVIEW }),
        "E941-S8": GOOD("E941-S8", { evidence: `${PREVIEW}#tree` }),
        "E941-S9": GOOD("E941-S9", { evidence: PREVIEW }),
        "E941-S10": GOOD("E941-S10", { evidence: PREVIEW }),
      },
    );
    const { review } = setup();
    expect((await listed(review)).map((i) => i.ref)).toEqual(["E941-S6", "E941-S8", "E941-S9", "E941-S10"]);
    const s7 = (await listed(review, "agents")).find((i) => i.ref === "E941-S7")!;
    expect(s7.verdict.kind).toBe("needs-rewriting");
    expect(s7.verdict.problems?.[0]).toMatch(/same page as E941-S8's card.*folded into E941-S8/);
  });
  it("every worker is told: one page, one card", () => {
    expect(CARD_FIELDS_RULE).toMatch(/One page, one card/);
  });
});
