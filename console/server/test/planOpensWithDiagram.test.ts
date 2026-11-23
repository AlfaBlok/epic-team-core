import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { checkLive, createReview } from "../src/review/review.js";
import { diagramFirst, isPlan, PLAN_DIAGRAM_PREFIX, planShapeProblem, visibleWords } from "../src/review/pageShape.js";
import { cardText, makeRepo, spineText } from "./reviewFixture.js";

/**
 * (the owner's voice note vn_c23abab6 on a plan card: "when you tell me a plan, I expect to see a diagram ... the
 * idea is always a diagram. It's not a gigantic paragraph"): a plan card whose evidence page opens without a drawn diagram
 * goes back to the agents as "needs evidence"; boxes of text or a table are not a diagram. Temp repos only.
 */
const bar = '<div data-page-parent="EPIC-946"><a href="x">&uarr; Pages</a><span>E907-S3 keeps this page</span></div>';
const head = '<header class="ps-head"><h1>The testers plan in one breath</h1></header><p class="ps-punch">We show it working once a day and offer a free month.</p>';
const drawn = `<!doctype html><html><body data-page-shell>${bar}${head}<figure class="ps-diagram"><svg viewBox="0 0 10 10"><text>${"label ".repeat(200)}</text></svg></figure><details><summary>Details</summary><p>${"word ".repeat(300)}</p></details></body></html>`;
const drawnThenWall = drawn.replace("<details>", `<p>${"word ".repeat(320)}</p><details>`);
const tableFirst = `<!doctype html><html><body data-page-shell>${bar}${head}<table><tr><td>Day 1</td><td>${"Journey word ".repeat(50)}</td></tr></table><div class="cards"><div class="card">a</div></div><svg></svg></body></html>`;
const proseFirst = `<!doctype html><html><body>${bar}${head}<p>${"word ".repeat(120)}</p><svg></svg></body></html>`;

describe("a plan opens with a diagram", () => {
  it("counts a drawn picture before about 80 words, never a table or boxes of text", () => {
    expect(diagramFirst(drawn)).toBe(true);
    expect(diagramFirst(tableFirst)).toBe(false);
    expect(diagramFirst(proseFirst)).toBe(false);
    expect(diagramFirst(`<body>${head}<img src="plan.webp" alt="the plan"></body>`)).toBe(true);
    expect(diagramFirst(`<body>${head}<pre>Stranger ──▶ sees it ──▶ tester</pre></body>`)).toBe(true);
    expect(diagramFirst("plain text, not a page")).toBeUndefined();
  });
  it("keeps a plan to a few words: a drawing's labels and a folded details never count", () => {
    expect(visibleWords(drawn)).toBeLessThan(40);
    expect(planShapeProblem(drawn)).toBe("");
    expect(planShapeProblem(drawnThenWall)).toMatch(/shows 3\d\d words/);
    expect(planShapeProblem(tableFirst)).toMatch(new RegExp(`^${PLAN_DIAGRAM_PREFIX}:`));
  });
  it("knows a plan card by its words", () => {
    expect(isPlan("A one-page plan was made so you can say the strategy in one breath.")).toBe(true);
    expect(isPlan(undefined, "Give you a roadmap for the week.")).toBe(true);
    expect(isPlan("The page was planned and built.", "You can open the page.")).toBe(false);
    // a card that mentions a plan in passing is not a plan card
    expect(isPlan("Your personal goal was checked on every tab and its plan written.", "The goal page shows only its own work, with a plan.")).toBe(false);
    expect(isPlan("The testers page was trimmed to tester work and got a plan.")).toBe(false);
    expect(isPlan("The Plan tab now opens on every objective.")).toBe(false);
  });
  it("checkLive reports the diagram on page-host pages only", async () => {
    const serve = (body: string) => (async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const at = (body: string, url = "http://pages.example:9483/") => checkLive(url, undefined, { fetch: serve(body), pageHosts: () => ["pages.example"] });
    expect(await at(drawn)).toMatchObject({ ok: true, plan: "" });
    expect((await at(tableFirst)).plan).toMatch(new RegExp(`^${PLAN_DIAGRAM_PREFIX}`));
    expect((await at(tableFirst, "https://product.example/")).plan).toBeUndefined();
  });
});

describe("the review gate holds a plan card without a diagram", () => {
  let tmp: string;
  let db: DB;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s96-"));
    db = openDb(path.join(tmp, "console.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const PAGE = "http://pages.example:9483/";
  const ROOT = "# EPIC: home_repo\n\nProject name: [The team console](https://team.example/)\nRoot spine: self\n\n## Current State\n\nStatus: active\n";
  async function verdictFor(title: string, body: string) {
    const text = spineText("EPIC-946", "Launch", [{ id: "E946-S1", title: "x", status: "review", evidence: PAGE }], ["Goal sentence: Get the first testers.", ""]).replace("Project name: [The team console](https://team.example/)\n", "");
    makeRepo(tmp, "home_repo", { "docs/spines/root.md": ROOT, "docs/spines/epic-946.md": text, "docs/cards/shot.png": "", "docs/cards/E946-S1.md": cardText("E946-S1", { evidence: PAGE, title }) }, { cards: false });
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const page = (async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle: { runNowRequest: async () => ({ run: { id: "r" } }) }, live: { fetch: page, consoleHosts: [], pageHosts: () => ["pages.example"] } });
    await review.list({ wait: true, state: "all" });
    return (await review.list({ state: "all" })).find((i) => i.ref === "E946-S1")!.verdict;
  }
  it("sends a plan card whose page opens with a table back as needs evidence", async () => {
    const v = await verdictFor("A testers plan was made for you.", tableFirst);
    expect(v.problems).toBeUndefined();
    expect(v.kind).toBe("needs-evidence");
    expect(v.reason).toMatch(new RegExp(`^${PLAN_DIAGRAM_PREFIX}`));
  });
  it("lets a plan card with a drawn diagram through", async () => {
    expect((await verdictFor("A testers plan was made for you.", drawn)).kind).toBe("card");
  });
  it("sends a plan card whose page is a wall of words under its diagram back", async () => {
    expect((await verdictFor("A testers plan was made for you.", drawnThenWall)).reason).toMatch(/few words/);
  });
  it("re-checks a page held on its shape after recheckMs, so a fixed page clears the gate; a clean verdict is kept", async () => {
    const text = spineText("EPIC-946", "Launch", [{ id: "E946-S1", title: "x", status: "review", evidence: PAGE }], ["Goal sentence: Get the first testers.", ""]).replace("Project name: [The team console](https://team.example/)\n", "");
    makeRepo(tmp, "home_repo", { "docs/spines/root.md": ROOT, "docs/spines/epic-946.md": text, "docs/cards/shot.png": "", "docs/cards/E946-S1.md": cardText("E946-S1", { evidence: PAGE, title: "A testers plan was made for you." }) }, { cards: false });
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    let body = drawnThenWall;
    let fetches = 0;
    const page = (async () => (fetches++, new Response(body, { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    let t = Date.parse("2026-11-22T12:00:00Z");
    const review = createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle: { runNowRequest: async () => ({ run: { id: "r" } }) }, live: { fetch: page, consoleHosts: [], pageHosts: () => ["pages.example"] }, now: () => new Date(t), recheckMs: 60_000 });
    const verdict = async () => {
      await review.list({ wait: true, state: "all" });
      return (await review.list({ state: "all" })).find((i) => i.ref === "E946-S1")!.verdict;
    };
    expect((await verdict()).reason).toMatch(/few words/);
    body = drawn; // the page is fixed after its first check
    t += 30_000; // inside recheckMs: the held verdict stands, no new fetch
    const before = fetches;
    expect((await verdict()).kind).toBe("needs-evidence");
    expect(fetches).toBe(before);
    t += 31_000; // past recheckMs: checked again, the fixed page clears
    expect((await verdict()).kind).toBe("card");
    const cleared = fetches;
    t += 10 * 60_000; // a clean ok verdict is known: never fetched again
    body = tableFirst;
    expect((await verdict()).kind).toBe("card");
    expect(fetches).toBe(cleared);
  });
  it("never holds a card that is not a plan on this rule", async () => {
    expect((await verdictFor("The test page was built so you can check it.", tableFirst)).kind).toBe("card");
  });
});
