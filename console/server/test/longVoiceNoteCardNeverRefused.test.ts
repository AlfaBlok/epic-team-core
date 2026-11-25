import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { HIS_WORDS_MAX } from "../src/hisWords.js";
import { RELAUNCH_MAX } from "../src/review/review.js";
import { COMMENT_MAX } from "../src/review/afterClose.js";
import { ANSWER_MAX } from "../src/steps/deskQuestions.js";
import { RUN_NOW_NOTE_MAX } from "../src/cycle/routes.js";
import type { PressWorker } from "../src/press/mount.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * Card feedback once refused the owner's long voice note (about 9,000 characters) at a 4,000 character limit. Every word he says on a card is taken, however long: feedback (Changes wanted), Decline's reason
 * and a comment on a closed card each land whole in the spine write (the cell quotes them short, the commit keeps every word); only a body past HIS_WORDS_MAX (200,000) is refused.
 */
const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
/** a TEST repo (TEST_REPO): its feedback is written like any card's, and nobody is woken. */
const DECISIONS = ["## Decisions", "", "| Date | Outcome | Decision | Summary | Evidence | Revisit |", "|---|---|---|---|---|---|", ""].join("\n");
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s93-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s93-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const rows = [
    { id: "E907-S3", title: "TEST card one" },
    { id: "E907-S4", title: "TEST card two" },
    { id: "E907-S5", title: "TEST card three" },
  ];
  const repo = makeRepo(dir, "e48-feedback-test", {
    [SPINE]: spineText("EPIC-900", "e48-feedback-test", rows.map((r) => ({ ...r, status: "review", evidence: "[page](https://team.example/audit)" }))) + "\n" + DECISIONS,
  });
  const live = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  let worker: PressWorker | undefined;
  const app = createApp(db, {
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: live, consoleHosts: [] } },
    presses: { retryMs: [0], onWorker: (w) => (worker = w), answerFirst: true },
    writeClones: { root: writeRoot },
  });
  const s = createStore(db);
  const m = s.createMilestone({ title: "e48-feedback-test", repo: "e48-feedback-test", path: SPINE, owner: "Sam", paused: false });
  const p = s.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: true });
  const req = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(
      url,
      { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, pressId: res.headers.get("x-press-id") };
  };
  const cards = async () => {
    await req("GET", "/api/review-items?state=test");
    await new Promise((r) => setTimeout(r, 30));
    return (await req("GET", "/api/review-items?state=test")).json as { id: string; ref: string; repo: string; path: string; title: string; milestoneId?: string }[];
  };
  const origin = () => git(repo.bare, "show", `main:${SPINE}`);
  const originRow = (id: string) => origin().split("\n").find((l) => l.startsWith(`| ${id} |`));
  const landed = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const p = (await req("GET", `/api/presses/${id}`)).json;
      if (p.state !== "landing") return p;
      if (i % 10 === 9) await worker!.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`press ${id} still landing`);
  };
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  });
  return { db, req, cards, repo, origin, originRow, landed, milestone: m, worker: () => worker! };
}

/** the spine write's commit: the row's cell quotes his words short, the commit body (the repo's record) keeps every word. */
const said = (w: ReturnType<typeof world>) => git(w.repo.bare, "log", "-1", "--format=%B", "main");
/** a voice note's worth of words, about 9,000 characters, with a marker at its very end. */
const longWords = (end: string) => `${"I want this to be clear and simple for the testers, and calm on the phone. ".repeat(120)}${end}`;

describe("a long voice note on a card is never refused", () => {
  it("every card route takes his words up to 200,000 characters", () => {
    expect(HIS_WORDS_MAX).toBe(200_000);
    for (const max of [RELAUNCH_MAX, COMMENT_MAX, ANSWER_MAX, RUN_NOW_NOTE_MAX]) expect(max).toBe(HIS_WORDS_MAX);
  });

  it("feedback of 9,000 characters lands whole in the row (it was refused at 4,000)", async () => {
    const w = world();
    const one = (await w.cards()).find((c) => c.ref === "E907-S3")!;
    const words = longWords("THE-LAST-WORDS-OF-THE-FEEDBACK");
    expect(words.length).toBeGreaterThan(8_900);
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/relaunch`, { feedback: words });
    const p = await w.landed(r.pressId!);
    expect(p.state, JSON.stringify(p.reason ?? p.response)).toBe("landed");
    expect(said(w)).toContain("THE-LAST-WORDS-OF-THE-FEEDBACK");
  });

  it("a Decline reason of 9,000 characters lands whole", async () => {
    const w = world();
    const two = (await w.cards()).find((c) => c.ref === "E907-S4")!;
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(two.id)}/deny`, { reason: longWords("THE-LAST-WORDS-OF-THE-DECLINE") });
    expect((await w.landed(r.pressId!)).state).toBe("landed");
    expect(said(w)).toContain("THE-LAST-WORDS-OF-THE-DECLINE");
  });

  it("a comment of 9,000 characters on a closed card lands whole", async () => {
    const w = world();
    const three = (await w.cards()).find((c) => c.ref === "E907-S5")!;
    expect((await w.landed((await w.req("POST", `/api/review-items/${encodeURIComponent(three.id)}/approve`)).pressId!)).state).toBe("landed");
    const c = await w.req("POST", "/api/closed-cards/comment", { kind: "review", repo: three.repo, path: three.path, ref: three.ref, title: three.title, milestoneId: w.milestone.id, text: longWords("THE-LAST-WORDS-OF-THE-COMMENT"), via: "voice" });
    expect((await w.landed(c.pressId!)).state).toBe("landed");
    expect(said(w)).toContain("THE-LAST-WORDS-OF-THE-COMMENT");
  });

  it("only a body past 200,000 characters is refused, and nothing is written", async () => {
    const w = world();
    const one = (await w.cards()).find((c) => c.ref === "E907-S3")!;
    const head = git(w.repo.bare, "rev-parse", "main");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/relaunch`, { feedback: "x".repeat(HIS_WORDS_MAX + 1) });
    const p = await w.landed(r.pressId!);
    expect(p.state).toBe("failed");
    expect(p.httpStatus).toBe(400);
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);
  });
});

/**
 * an audit of the desk found the owner's card notes answered "the card did not take it" (a Changes wanted on a row that had
 * moved on, a field the route would not take) and his words reached the desk only as a side copy, or were written as "his
 * comment after he closed it". A card never refuses his note: it lands on the card's row as his note on that card.
 */
describe("a card never refuses his note", () => {
  it("Changes wanted on a row that already moved on lands on that row as his note on its card, never 'after he closed it'", async () => {
    const w = world();
    const one = (await w.cards()).find((c) => c.ref === "E907-S3")!;
    // the row leaves review first (his close), then his Changes wanted arrives on the card still on his screen
    expect((await w.landed((await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`)).pressId!)).state).toBe("landed");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/relaunch`, { feedback: "i sent the vn, but it was nearly 2h, can you see it in logs? MOVED-ON-WORDS" });
    const p = await w.landed(r.pressId!);
    expect(p.state, JSON.stringify(p.reason ?? p.response)).toBe("landed");
    const row = w.origin().split("\n").find((l) => l.includes("MOVED-ON-WORDS"))!;
    expect(row).toBeTruthy();
    expect(row).toMatch(/note on row E907-S3 on its card/);
    expect(row).not.toMatch(/after he closed it/);
    expect(said(w)).toMatch(/note on its card/);
  });

  it("a note whose card title is past 400 characters lands (the title is cut, his words are not refused)", async () => {
    const w = world();
    const three = (await w.cards()).find((c) => c.ref === "E907-S5")!;
    const title = `after Sam sends the forms, track each answer ${"and the programs ".repeat(40)}`;
    expect(title.length).toBeGreaterThan(600);
    const c = await w.req("POST", "/api/closed-cards/comment", { kind: "review", repo: three.repo, path: three.path, ref: three.ref, title, milestoneId: w.milestone.id, text: "can i see the forms and the programs? LONG-TITLE-WORDS", via: "voice", stage: "on_card" });
    const p = await w.landed(c.pressId!);
    expect(p.state, JSON.stringify(p.reason ?? p.response)).toBe("landed");
    expect(said(w)).toContain("LONG-TITLE-WORDS");
    expect(w.originRow("E907-S5")).toMatch(/review/);
  });
});
