import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { createReview, type ReviewItem } from "../src/review/review.js";
import { parseCard } from "../src/review/card.js";
import { addCard, git, makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * a persona's card names who sent it and where it lives (`from:`, `runs:`), and its follow-ups
 * name the goal they belong to (`in:`). Complete writes one commit: on = a `ready` row in that goal quoting his
 * words; off = a `dismissed` Decisions row with his reason. Temp repos only.
 */
const GAPS = "docs/spines/epic-979.md";
const OTHER = "docs/spines/epic-964.md";
const LIVE = "https://team.example/landing/gap-finder/2026-11-08.html";
const today = () => new Date().toISOString().slice(0, 10);
const DECISIONS = ["## Decisions", "", "| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |", "|---|---|---|---|---|---|", "| 2026-11-08 | accepted | seed | seed | seed | — |", ""];

let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e79s1-"));
  repo = makeRepo(
    tmp,
    "home_repo",
    {
      "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
      [GAPS]: spineText("EPIC-979", "Gap finder", [{ id: "E979-G20261108", title: "Gap finder run 8 Nov", status: "review", evidence: `[page](${LIVE})` }]) + DECISIONS.join("\n"),
      [OTHER]: spineText("EPIC-964", "The cycle", [{ id: "E964-S11", title: "Lifecycle page", status: "done (approved by Sam 2026-11-03)" }], ["Goal sentence: We want you to see how your words reach the next round.", ""]) + DECISIONS.join("\n"),
    },
    { cards: false },
  );
  addCard(repo.dir, "E979-G20261108", LIVE, {
    title: "Gap finder found 2 things you asked for more than once that are not done yet.",
    next: [
      'on: Show one voice note going all the way to the next post — asked 4 times — words: "I have been asking for this URL" 8 Nov — in: EPIC-964',
      "off: Count posts per day on the campaign page — in: EPIC-964",
    ],
    extra: [
      "from: Gap finder",
      "from settings: https://team.example/personas?edit=pe_1",
      "from line: It reads your last ten days of voice notes and lists what you asked for twice and still lack.",
      "runs: At the root, across agent team, EpicSpine and SocialApp. Daily at 12:00 UTC on the home_repo root milestone.",
    ],
  });
  execGit("add", "-A");
  execGit("commit", "-q", "-m", "card");
  execGit("push", "-q", "origin", "main");
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const execGit = (...args: string[]) => git(repo.dir, ...args);

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
  return (await review.list()).find((i) => i.ref === "E979-G20261108") as ReviewItem;
};

describe("E979-S1 r2 the card format", () => {
  it("reads in:, words:, on / off and the from fields", () => {
    const c = parseCard(fs.readFileSync(path.join(repo.dir, "docs/cards/E979-G20261108.md"), "utf8"))!;
    expect(c.next[0]).toEqual({ title: "Show one voice note going all the way to the next post", why: "asked 4 times", recommend: "start", target: "EPIC-964", quote: '"I have been asking for this URL" 8 Nov' });
    expect(c.next[1]).toMatchObject({ recommend: "park", target: "EPIC-964" });
    expect(c.from).toEqual({
      name: "Gap finder",
      url: "https://team.example/personas?edit=pe_1",
      line: "It reads your last ten days of voice notes and lists what you asked for twice and still lack.",
      runs: "At the root, across agent team, EpicSpine and SocialApp. Daily at 12:00 UTC on the home_repo root milestone.",
    });
  });

  it("the face names who sent it and the goal of each follow-up in plain words", async () => {
    const { review } = setup();
    const it = await card(review);
    expect(it.verdict?.kind).toBe("card");
    expect(it.face?.from?.name).toBe("Gap finder");
    expect(it.face?.next.map((n) => n.targetName)).toEqual(["We want you to see how your words reach the next round", "We want you to see how your words reach the next round"]);
  });
});

describe("E979-S1 r2 Complete with switches", () => {
  it("on = a ready row in its goal quoting his words; off = a dismissed Decisions row with his reason; one commit; the DM wakes", async () => {
    const { review, woke } = setup();
    const it = await card(review);
    const r = await review.complete(it.id, { start: [0], park: [1], why: ["", "we already count them on the Pipeline"] });
    if ("error" in r) throw new Error(r.message);
    expect(r.item.switched?.on).toEqual([{ ref: "E964-S12", goal: "EPIC-964", title: "Show one voice note going all the way to the next post" }]);
    expect(r.item.switched?.off).toEqual([{ title: "Count posts per day on the campaign page", goal: "EPIC-964", why: "we already count them on the Pipeline" }]);
    const row = repo.rowLine(OTHER, "E964-S12")!;
    expect(row).toContain("| ready |");
    expect(row).toContain('Your words: "I have been asking for this URL" 8 Nov');
    expect(repo.read(OTHER)).toMatch(/\| accepted \| E964-S12 ready on Sam's switch in E979-G20261108/);
    expect(repo.rowLine(GAPS, "E979-G20261108")).toContain(`| done (approved by Sam ${today()}) |`);
    expect(repo.rowLine(GAPS, "E979-G20261108")).toContain("followups: started E964-S12 (in EPIC-964); dismissed 1 (Decisions)");
    expect(repo.read(GAPS)).toMatch(/\| dismissed \| Follow-up for EPIC-964 switched off by Sam in E979-G20261108, never proposed again: Count posts per day on the campaign page \| we already count them on the Pipeline \|/);
    expect(repo.originLog()[0]).toBe("Review E979-G20261108: step complete, 1 switched on, 1 off (Sam, via console)");
    expect(repo.originLog()[1]).toBe("card"); // one commit for both files
    expect(woke).toHaveLength(1);
    expect(woke[0].instructions).toContain("E964-S12 Show one voice note going all the way to the next post (in docs/spines/epic-964.md)");
  });

  it("all off: no row anywhere, a default reason, nobody woken", async () => {
    const { review, woke } = setup();
    const it = await card(review);
    const r = await review.complete(it.id, { start: [], park: [0, 1] });
    if ("error" in r) throw new Error(r.message);
    expect(repo.read(OTHER)).not.toContain("E964-S12");
    expect(repo.read(GAPS).match(/\| dismissed \|/g)).toHaveLength(2);
    expect(repo.read(GAPS)).toContain("| Sam switched it off |");
    expect(woke).toEqual([]);
  });

  it("refuses a follow-up whose goal is not in the repo and changes nothing", async () => {
    fs.writeFileSync(path.join(repo.dir, "docs/cards/E979-G20261108.md"), fs.readFileSync(path.join(repo.dir, "docs/cards/E979-G20261108.md"), "utf8").replace("off: Count posts per day on the campaign page — in: EPIC-964", "off: Something — in: EPIC-999"));
    execGit("commit", "-q", "-am", "bad target");
    execGit("push", "-q", "origin", "main");
    const { review } = setup();
    const it = await card(review);
    const r = await review.complete(it.id, { start: [0], park: [1] });
    expect(r).toMatchObject({ error: 422, code: "followup_goal_missing" });
    expect(repo.rowLine(GAPS, "E979-G20261108")).toContain("| review |");
  });
});
