import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createReview } from "../src/review/review.js";
import { outcomeKind } from "../src/inbox/routes.js";
import { parseAskLog, repeatOf } from "../src/inbox/askRepeat.js";
import { fold, parseEvents } from "../src/asks/askLog.js";
import { DUPLICATE_ANSWER, duplicateWords, isDuplicate, sameOpenProblem, sameQuestion, traceDuplicate, traceLine, withTrace } from "../src/inbox/duplicate.js";
import { oneQuestionOneCard, type ReviewRow } from "../src/review/rows.js";
import { makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * E948-S139 (the owner's voice note, 24 Nov 20:37Z): "Give me a button. That's it Duplicate or already answered ... I will be
 * marking to you and then hopefully you will be able to trace back which was the two". One tap on any inbox card closes it
 * as answered, names the card it repeats, wakes the owner and feeds the ask gate's repeat memory.
 */
describe("Duplicate or already answered: the words and the trace", () => {
  it("the button's words, with or without his note, are recognised", () => {
    expect(duplicateWords()).toBe(DUPLICATE_ANSWER);
    expect(duplicateWords("  asked on Monday ")).toBe("duplicate or already answered. asked on Monday");
    expect(isDuplicate("Duplicate or already answered. same as the sidebar card")).toBe(true);
    expect(isDuplicate("Yes")).toBe(false);
    expect(isDuplicate(undefined)).toBe(false);
  });

  it("traces the earlier card by its words, never itself; an answered one wins a tie", () => {
    const cands = [
      { ref: "E940-S52", question: "Should the sidebar show every project with its unread count?", repo: "acme", on: "2026-11-20", answer: "Yes, every project" },
      { ref: "E940-S58", question: "Should the sidebar show every project with its unread count?", repo: "acme", open: true },
      { ref: "E907-A3", question: "Do you approve paying for a second WhatsApp number?", repo: "acme", on: "2026-11-21", answer: "yes" },
    ];
    const hit = traceDuplicate({ question: "Does the sidebar show each project with an unread count?", ref: "E940-S58", repo: "acme" }, cands);
    expect(hit?.cand.ref).toBe("E940-S52");
    expect(traceLine(hit)).toBe('repeats: E940-S52 in acme, answered 2026-11-20 "Yes, every project" ("Should the sidebar show every project with its unread count?")');
    // nothing alike: the owner traces it
    expect(traceDuplicate({ question: "Which hotel in Frankfurt?" }, cands)).toBeUndefined();
    expect(traceLine(undefined)).toBe("repeats: not found by its words, its owner traces the earlier card");
    // an open one is named as still open
    expect(traceLine({ cand: cands[1] })).toMatch(/^repeats: E940-S58 in acme, still open/);
  });

  it("the answer gets the trace once", () => {
    const t = withTrace("duplicate or already answered", { cand: { ref: "E907-A3", question: "q", on: "2026-11-21" } });
    expect(t).toBe('duplicate or already answered — repeats: E907-A3, answered 2026-11-21 ("q")');
    expect(withTrace(t, undefined)).toBe(t);
  });

  it("on an approve ask the tap closes it as answered, never a new round of feedback", () => {
    const ask = { source: "ask" as const, ask: "approve" as const };
    expect(outcomeKind(ask, "answer", "duplicate or already answered")).toBe("answer");
    expect(outcomeKind(ask, "answer", "please change the title")).toBe("feedback");
  });
});

describe("the ask gate's repeat memory holds the next card like it (the asks log, no second memory)", () => {
  const events = [
    { ev: "open", id: "card:acme:E940-S58", at: "2026-11-24T21:00:00.000Z", kind: "card", what: "The sidebar shows every project with its unread count", row: "E940-S58", repo: "acme" },
    { ev: "try", id: "card:acme:E940-S58", at: "2026-11-24T21:00:00.000Z", how: "answer", words: "duplicate or already answered — repeats: E940-S52" },
    { ev: "close", id: "card:acme:E940-S58", at: "2026-11-24T21:00:00.000Z", how: "answered" },
  ];
  const text = events.map((e) => JSON.stringify(e)).join("\n");

  it("a closed duplicate card is a prior answer the gate reads", () => {
    const prior = parseAskLog(text);
    expect(prior).toHaveLength(1);
    expect(prior[0]).toMatchObject({ row: "E940-S58", answer: "duplicate or already answered — repeats: E940-S52", on: "2026-11-24" });
    // a later ask in the same words on the same row is held as already answered
    const again = repeatOf({ question: "Does the sidebar show every project with its unread count?", row: "E940-S58", repo: "acme", since: "2026-11-25" }, prior);
    expect(again?.prior.row).toBe("E940-S58");
  });

  it("is never counted as an ask he was asked", () => {
    const v = fold(parseEvents(text), "2026-11-24T22:00:00.000Z");
    expect(v.rows).toHaveLength(0);
  });
});

describe("a review card closed as Duplicate or already answered", () => {
  let tmp: string;
  const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s139-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("closes the row with his words, adds a Decisions line naming the card it repeats, wakes the owner and logs it", async () => {
    const EPIC = "docs/spines/epic-40.md";
    const LIVE = "https://team.example/sidebar";
    const decisions = ["## Decisions", "", "| Date | Outcome | Decision | Summary | Evidence | Revisit |", "|---|---|---|---|---|---|", ""];
    const repo = makeRepo(tmp, "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nRoot spine: self\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
      [EPIC]: spineText(
        "PLAN-40",
        "Sidebar",
        [
          { id: "T40-S52", title: "The sidebar shows every project with its unread count", status: "review", evidence: `[sidebar](${LIVE})` },
          { id: "T40-S58", title: "Each project in the sidebar now lists how many messages are unread", status: "review", evidence: `[sidebar](${LIVE})` },
        ],
        decisions,
      ),
    });
    const db = openDb(path.join(tmp, "console.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const dm = store.createPersona({ name: "Delivery manager", remit: "d", skills: [], model: "", mayWrite: false });
    store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const woke: string[] = [];
    const logged: { ref: string; words: string }[] = [];
    const review = createReview(db, {
      store,
      reposRoot: tmp,
      writer: createSpineWriter(),
      cycle: { runNowRequest: async (_id: string, o: { instructions?: string }) => (woke.push(o.instructions ?? ""), { run: { id: "run_new" } }) },
      live: { fetch: web({ [LIVE]: 200 }).f, consoleHosts: [] },
      onDuplicate: () => (d) => void logged.push(d),
    });
    await review.list({ wait: true });
    const s58 = (await review.list()).find((i) => i.ref === "T40-S58")!;
    expect(s58).toBeDefined();
    const r = await review.deny(s58.id, "same as the other sidebar card", { duplicate: true });
    expect("error" in r ? r : r.item).toMatchObject({ state: "denied" });
    const today = new Date().toISOString().slice(0, 10);
    const line = repo.rowLine(EPIC, "T40-S58")!;
    expect(line).toContain(`superseded (denied by Sam ${today}: duplicate or already answered. same as the other sidebar card`);
    const text = repo.read(EPIC);
    expect(text).toMatch(/\| T40-S58 closed by Sam: Duplicate or already answered: "same as the other sidebar card" \|/);
    expect(text).toContain("repeats: T40-S52");
    expect(woke[0]).toContain("Fold the two: keep his words from both");
    expect(woke[0]).toContain("repeats: T40-S52");
    expect(logged[0]).toMatchObject({ ref: "T40-S58" });
    expect(logged[0].words).toMatch(/^duplicate or already answered\. same as the other sidebar card — repeats: T40-S52/);
    // the other card stays in review
    expect(repo.rowLine(EPIC, "T40-S52")).toContain("| review |");
    db.close();
  });
});

describe("one question, one card: merged before he sees it", () => {
  it("nearly the same words are one question; the same topic asked differently is not", () => {
    expect(sameQuestion("Do you approve a second WhatsApp number for the Team desk?", "Do you approve a second WhatsApp number for the Team desk now?")).toBe(true);
    expect(sameQuestion("Do you approve a second WhatsApp number for the Team desk?", "Which phone should the other desk use for its chats?")).toBe(false);
    expect(sameOpenProblem("E907-A3", "2026-11-20T10:00Z")).toBe("it asks the same as E907-A3, still open since 2026-11-20: one question, one card. Fold it into E907-A3 with the owner's words from both, then drop this one");
  });

  it("the newer review card of the same question goes back to its agents; the older stays his card", () => {
    const row = (ref: string, verifiedAt: string, title: string, repo = "acme") =>
      ({ id: ref, ref, title, repo, path: "docs/spines/x.md", status: "review", links: [], closes: {}, verifiedAt, verdict: { kind: "card" }, face: { title, decision: "Is it right? We recommend yes." } }) as unknown as ReviewRow;
    const a = row("E940-S52", "2026-11-20", "The sidebar shows every project with its unread count.");
    const b = row("E940-S58", "2026-11-22", "The sidebar shows every project with its unread count now.");
    const c = row("E940-S60", "2026-11-23", "The phone app opens on the newest chat without hanging.");
    const d = row("E940-S61", "2026-11-23", "The sidebar shows every project with its unread count.", "other");
    oneQuestionOneCard([b, a, c, d]);
    expect(a.verdict.kind).toBe("card");
    expect(b.verdict).toMatchObject({ kind: "needs-rewriting", reason: "card needs rewriting" });
    expect(b.verdict.problems?.[0]).toMatch(/^it asks the same as E940-S52's card/);
    expect(c.verdict.kind).toBe("card");
    // another repo's card is its own owner's question
    expect(d.verdict.kind).toBe("card");
  });
});
