import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { createReview, type ReviewItem } from "../src/review/review.js";
import { parseCard } from "../src/review/card.js";
import { parkProposedGoal, readyProposedGoal, stateStatus } from "../src/review/followups.js";
import { addCard, git, makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * a proposer persona's run is ONE
 * card on Team home, its proposed new goals are its switches (`new:`), so no separate approval card repeats it.
 * On readies the draft goal and wakes the Delivery manager; off parks it for good. Temp repos only.
 */
const OWN = "docs/spines/epic-76.md";
const DRAFT = "docs/spines/epic-81.md";
const LIVE = "https://team.example/";
const today = () => new Date().toISOString().slice(0, 10);
const DECISIONS = ["## Decisions", "", "| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |", "|---|---|---|---|---|---|", "| 2026-11-08 | accepted | seed | seed | seed | — |", ""];
const draftText = () =>
  spineText(
    "EPIC-981",
    "Living decks",
    [{ id: "E981-S1", title: "Living decks first step", status: "draft", next: "Sam switches it on" }],
    ["Waiting on: Sam switches it on in the Input reviewer's card", "Approved work: none", "Next action: Sam switches it on", "", "Goal sentence: What you say in a voice note shows up in the deck within a day.", ""],
  ).replace("Status: active", "Status: draft") + DECISIONS.join("\n");

let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e76s23-"));
  repo = makeRepo(
    tmp,
    "home_repo",
    {
      "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
      [OWN]: spineText("EPIC-976", "Goal graph quality", [{ id: "E76-I20261109", title: "Input reviewer run 9 Nov", status: "review", evidence: `[home](${LIVE})` }]) + DECISIONS.join("\n"),
      [DRAFT]: draftText(),
    },
    { cards: false },
  );
  addCard(repo.dir, "E76-I20261109", LIVE, {
    title: "Input reviewer checked your newest voice note and proposed one new goal.",
    next: ['on: Keep the decks alive with what you say — nothing in the team does it yet — words: "these documents really stay alive" 8 Nov — new: EPIC-981 — also: Prioritizer'],
    extra: ["from: Input reviewer", "from line: It checks that each new voice note became goals, and proposes one when a request got lost.", "runs: Daily at 13:30 Madrid on the home_repo root."],
  });
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "-q", "-m", "card");
  git(repo.dir, "push", "-q", "origin", "main");
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
  const store = createStore(db);
  const m = store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
  const dm = store.createPersona({ name: "Delivery manager", remit: "d", skills: [], model: "", mayWrite: false });
  store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
  const woke: { instructions?: string }[] = [];
  const cycle = { runNowRequest: async (_id: string, o: { instructions?: string }) => (woke.push(o), { run: { id: "run_new" } }) };
  const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle, live: { fetch: web({ [LIVE]: 200 }).f, consoleHosts: [] } });
  return { review, woke };
}
const card = async (review: ReturnType<typeof setup>["review"]) => {
  await review.list({ wait: true });
  return (await review.list()).find((i) => i.ref === "E76-I20261109") as ReviewItem;
};

describe("E976-S2/S3 r2 a proposer's card", () => {
  it("reads new: as a drafted goal and also: as the other personas that proposed it", () => {
    const c = parseCard(fs.readFileSync(path.join(repo.dir, "docs/cards/E76-I20261109.md"), "utf8"))!;
    expect(c.next[0]).toEqual({
      title: "Keep the decks alive with what you say",
      why: "nothing in the team does it yet",
      recommend: "start",
      target: "EPIC-981",
      quote: '"these documents really stay alive" 8 Nov',
      kind: "new",
      also: ["Prioritizer"],
    });
    expect(c.from?.name).toBe("Input reviewer");
  });

  it("the face is a card from the Input reviewer whose switch names the proposed goal", async () => {
    const { review } = setup();
    const it = await card(review);
    expect(it.verdict?.kind).toBe("card");
    expect(it.face?.from?.name).toBe("Input reviewer");
    expect(it.face?.next[0]).toMatchObject({ kind: "new", target: "EPIC-981", also: ["Prioritizer"], targetName: "What you say in a voice note shows up in the deck within a day" });
  });
});

describe("E976-S2/S3 r2 switching a proposed goal", () => {
  it("on: the draft goal turns ready with its rows, a Decisions row, one commit, the Delivery manager is woken", async () => {
    const { review, woke } = setup();
    const it = await card(review);
    const r = await review.complete(it.id, { start: [0], park: [] });
    if ("error" in r) throw new Error(r.message);
    const g = repo.read(DRAFT);
    expect(stateStatus(g)).toBe("ready");
    expect(g).toContain("Next action: dispatch a Delivery Manager on it");
    expect(g).toContain(`Approved work: all of it (Sam switched it on in E76-I20261109 ${today()})`);
    expect(g).toContain("Waiting on: none");
    expect(repo.rowLine(DRAFT, "E981-S1")).toContain("| ready |");
    expect(g).toMatch(/\| accepted \| EPIC-981 ready on Sam's switch in E76-I20261109/);
    expect(repo.rowLine(OWN, "E76-I20261109")).toContain(`| done (approved by Sam ${today()}) |`);
    expect(r.item.switched?.on).toEqual([{ ref: "EPIC-981", goal: "EPIC-981", title: "Keep the decks alive with what you say" }]);
    expect(repo.originLog()[1]).toBe("card");
    expect(woke).toHaveLength(1);
    expect(woke[0].instructions).toContain("the new goal EPIC-981");
    expect(woke[0].instructions).toContain("dispatch a Delivery Manager on it");
  });

  it("off: the goal is deferred with his reason there and in the card's own goal, nobody woken", async () => {
    const { review, woke } = setup();
    const it = await card(review);
    const r = await review.complete(it.id, { start: [], park: [0], why: ["decks change too often for this"] });
    if ("error" in r) throw new Error(r.message);
    const g = repo.read(DRAFT);
    expect(stateStatus(g)).toBe(`deferred (switched off by Sam ${today()})`);
    expect(g).toMatch(/\| dismissed \| EPIC-981 switched off by Sam in E76-I20261109, never proposed again: Keep the decks alive with what you say \| decks change too often for this \|/);
    expect(repo.read(OWN)).toMatch(/\| dismissed \| Proposed goal EPIC-981 switched off by Sam in E76-I20261109, never proposed again/);
    expect(repo.rowLine(DRAFT, "E981-S1")).toContain("| draft |");
    expect(woke).toEqual([]);
  });

  it("a goal that is no longer a draft is left alone", () => {
    const t = draftText().replace("Status: draft", "Status: active");
    expect(readyProposedGoal(t, "EPIC-981", { title: "x", from: { ref: "E76-I1", rel: OWN } }, "2026-11-09")).toEqual({ text: t, already: "active" });
    expect(parkProposedGoal(t, "EPIC-981", { title: "x", from: { ref: "E76-I1", rel: OWN } }, "2026-11-09")).toEqual({ text: t, already: "active" });
  });
});
