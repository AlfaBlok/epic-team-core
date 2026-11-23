import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { PressWorker } from "../src/press/mount.js";
import { liveRunFor, sentBackCards, type SentBackInput } from "../src/review/sentBack.js";
import type { ReviewGoal } from "../src/review/rows.js";
import type { ClosedCard } from "../src/review/afterClose.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * (the owner 2026-11-22 23:07Z: "Why is it not on my inbox if it doesn't come back to me, then it gets lost ...
 * Why are these things not popping up on my inbox so that I can keep giving input until it gets built?"): a card he
 * sent back stays on his inbox (GET /api/sent-back-cards), marked in progress with its worker, until its next round is
 * back in review; his note on it lands as a Decisions row that says the round is in work, and wakes the owner.
 */
const NOW = new Date("2026-11-22T23:30:00Z");
const goal = (inWork: ReviewGoal["inWork"], o: Partial<ReviewGoal> = {}): ReviewGoal => ({
  key: "home:docs/spines/root.md", code: "EPIC-900", title: "Team", repo: "home", path: "docs/spines/root.md", milestoneId: "ms_1", doneMeans: [], running: [], parked: [], inWork, selfClosed: [], openAsks: [], standalone: true, ...o,
});
const press = (ref: string, o: Partial<ClosedCard> = {}): ClosedCard => ({ key: `review:home:docs/spines/root.md#${ref}`, kind: "review", repo: "home", path: "docs/spines/root.md", ref, title: `Card ${ref} was made.`, outcome: "changes", at: "2026-11-22T21:01:00.000Z", comments: 0, ...o });
const input = (o: Partial<SentBackInput>): SentBackInput => ({ goals: [], inReview: new Set(), presses: [], row: () => undefined, runs: [], now: NOW, ...o });
const row = (status: string, owner = "seat2") => ({ status, owner, title: "row title", iteration: 2 });

describe("sentBackCards: what he sent back and is not back in review", () => {
  it("a row the spine says he sent back is listed with his words, its round and the live worker on it", () => {
    const out = sentBackCards(
      input({
        goals: [goal([{ ref: "E907-S14", title: "Every request lands on one row", iteration: 7, words: "I don't know what you're talking about", since: "2026-11-22" }])],
        row: () => row("active (iteration 7, relaunched by Sam 2026-11-22: I don't know what you're talking about)"),
        runs: [{ id: "run_abc", outcome: "running", clientRequestId: "E907-S14-run_parent", milestoneId: "ms_1", personaId: "pe_1", host: "host1", startedAt: "2026-11-22T22:52:00Z" }],
        personaName: () => "Ticket worker",
      }),
    );
    expect(out).toEqual([
      expect.objectContaining({ ref: "E907-S14", repo: "home", state: "in_progress", iteration: 7, words: "I don't know what you're talking about", worker: { run: "run_abc", persona: "Ticket worker", host: "host1", startedAt: "2026-11-22T22:52:00Z", live: true } }),
    ]);
  });

  it("nobody on it: it still shows, as waiting for a worker; an unexpired claim counts as a worker, an expired one does not", () => {
    const goals = [goal([{ ref: "A-1", title: "a", iteration: 2, since: "2026-11-22" }, { ref: "A-2", title: "b", iteration: 2, since: "2026-11-22" }, { ref: "A-3", title: "c", iteration: 3, since: "2026-11-22" }, { ref: "A-4", title: "an agent's own iteration", iteration: 2 }])];
    const owners: Record<string, string> = {
      "A-1": "unassigned",
      "A-2": "run_live — claimed 2026-11-22T22:00Z, lease until 2026-11-23T00:00Z",
      "A-3": "run_old — claimed 2026-11-22T10:00Z, lease until 2026-11-22T12:00Z",
    };
    const out = sentBackCards(input({ goals, row: (_r, _p, ref) => row("active (iteration 2)", owners[ref]) }));
    const by = Object.fromEntries(out.map((c) => [c.ref, c]));
    expect(by["A-1"]).toMatchObject({ state: "waiting" });
    expect(by["A-1"].worker).toBeUndefined();
    expect(by["A-2"]).toMatchObject({ state: "in_progress", worker: { run: "run_live", leaseUntil: "2026-11-23T00:00Z", live: false } });
    expect(by["A-3"]).toMatchObject({ state: "waiting" });
    // a bare iteration number with no word of his and no press is not a card he sent back
    expect(by["A-4"]).toBeUndefined();
  });

  it("his press gives the card its own title and minute; a row whose status lost the marker is still listed from the press", () => {
    const out = sentBackCards(
      input({
        goals: [goal([{ ref: "A-1", title: "row words", iteration: 2, since: "2026-11-22" }])],
        presses: [press("A-1", { title: "The page was made clearer.", at: "2026-11-22T22:51:00.000Z" }), press("A-9", { at: "2026-11-22T20:00:00.000Z" })],
        row: (_r, _p, ref) => (ref === "A-9" ? row("active (worker started)") : row("active (iteration 2, relaunched by Sam 2026-11-22: x)")),
      }),
    );
    expect(out.map((c) => [c.ref, c.title, c.since, c.state])).toEqual([
      ["A-1", "The page was made clearer.", "2026-11-22T22:51:00.000Z", "waiting"],
      ["A-9", "Card A-9 was made.", "2026-11-22T20:00:00.000Z", "waiting"],
    ]);
  });

  it("the team closed it after he sent it back (no confirm, a fold that itself closed): found as closed by the team with why, for 3 days; a move or a fold out of this spine is not a close", () => {
    const out = sentBackCards(
      input({
        presses: [press("E907-S90"), press("OLD-1", { at: "2026-11-18T10:00:00.000Z" }), press("F-2", { at: "2026-11-22T08:32:00.000Z" }), press("M-1"), press("X-1")],
        row: (_r, _p, ref) =>
          ref === "F-2" ? row("done (folded into E907-S90)") : ref === "M-1" ? row("moved (to one-offs OO-S2)") : ref === "X-1" ? row("done (folded into other-repo E907-S39)") : ref === "E907-S90" || ref === "OLD-1" ? row("done (no confirm: its next steps run: E907-S13 live in review)") : undefined,
      }),
    );
    expect(out.map((c) => [c.ref, c.state, c.why])).toEqual([
      ["E907-S90", "closed_by_team", "done (no confirm: its next steps run: E907-S13 live in review)"],
      ["F-2", "closed_by_team", "done (folded into E907-S90)"],
    ]);
  });

  it("folded into a row still being worked on: in progress as that row (its worker); into one back in review or closed by him: not listed", () => {
    const status: Record<string, string> = {
      "F-1": "done (folded into G-1)",
      "G-1": "active (iteration 3)",
      "F-2": "done (folded into G-2: one card)",
      "G-2": "review",
      "F-3": "done (folded into G-3)",
      "G-3": "done (approved by Sam 2026-11-22)",
      "F-4": "done (folded into F-1)",
    };
    const out = sentBackCards(
      input({
        presses: [press("F-1"), press("F-2"), press("F-3"), press("F-4", { at: "2026-11-22T20:00:00.000Z" })],
        row: (_r, _p, ref) => row(status[ref] ?? "active"),
        runs: [{ id: "run_g1", outcome: "running", clientRequestId: "G-1-run_parent", parentRunId: "run_parent", personaId: "pe_1", host: "host1" }],
        personaName: () => "Delivery Manager",
      }),
    );
    expect(out.map((c) => [c.ref, c.state, c.continuesIn, c.worker?.run, c.worker?.persona])).toEqual([
      ["F-1", "in_progress", "G-1", "run_g1", undefined],
      ["F-4", "in_progress", "G-1", "run_g1", undefined],
    ]);
  });

  it("a row he dropped or parked by his own word is his decision, not lost; a row waiting on a timed check says until when", () => {
    const out = sentBackCards(
      input({
        presses: [press("D-1"), press("D-2"), press("M-1")],
        row: (_r, _p, ref) => row({ "D-1": "superseded (dropped by Sam 2026-11-20, his note)", "D-2": "deferred (parked by Sam 18 Nov)", "M-1": "waiting (monitoring a timed check until 2026-11-23T08:30Z, run_x)" }[ref]!),
      }),
    );
    expect(out.map((c) => [c.ref, c.state, c.checkAt])).toEqual([["M-1", "waiting", "2026-11-23T08:30Z"]]);
  });

  it("back in review, or closed by his own press afterwards: no longer listed (it is his card again, or his decision)", () => {
    const out = sentBackCards(
      input({
        goals: [goal([{ ref: "R-1", title: "stale view", iteration: 2 }])],
        inReview: new Set(["home:R-1", "home:R-2"]),
        presses: [press("R-2"), press("R-3"), press("R-4"), press("R-5"), press("T-1", { repo: "e67-feedback-test" }), press("K-1", { outcome: "approved" })],
        row: (_r, _p, ref) => row({ "R-3": "review (iteration 3)", "R-4": "done (approved by Sam 2026-11-22)", "R-5": "superseded (denied by Sam 2026-11-22: no)" }[ref] ?? "active"),
      }),
    );
    expect(out).toEqual([]);
  });

  it("newest send-back first", () => {
    const out = sentBackCards(
      input({
        goals: [goal([{ ref: "A-1", title: "a", iteration: 2, since: "2026-11-10" }, { ref: "A-2", title: "b", iteration: 2, since: "2026-11-22" }])],
        presses: [press("A-3", { at: "2026-11-22T23:19:00.000Z" })],
        row: () => row("active (iteration 2)"),
      }),
    );
    expect(out.map((c) => c.ref)).toEqual(["A-3", "A-2", "A-1"]);
  });

  it("liveRunFor matches the row a run opens with, in the same milestone, and only while it runs", () => {
    const runs = [
      { id: "r1", outcome: "progressed", clientRequestId: "E907-S2-run_x" },
      { id: "r2", outcome: "running", summary: "E907-S21 something else" },
      { id: "r3", outcome: "running", summary: "E907-S2 iteration 2: his answer", milestoneId: "ms_other" },
      { id: "r4", outcome: "running", summary: "E907-S2 iteration 2: his answer", milestoneId: "ms_1" },
    ];
    expect(liveRunFor(runs, "E907-S2", "ms_1")?.id).toBe("r4");
    expect(liveRunFor(runs.slice(0, 2), "E907-S2", "ms_1")).toBeUndefined();
  });
});

const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
const DECISIONS = ["## Decisions", "", "| Date | Outcome | Decision | Summary | Evidence | Revisit |", "|---|---|---|---|---|---|", ""].join("\n");
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-sentback-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-sentback-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const ev = "[page](https://team.example/audit)";
  const repo = makeRepo(dir, "home_repo", {
    [SPINE]:
      spineText("EPIC-900", "home_repo", [
        { id: "E907-S1", title: "The kernel page", status: "active (iteration 5, relaunched by Sam 2026-11-22: Where is the kernel thing, make it clearer)", evidence: ev },
        { id: "E907-S2", title: "Queued for a worker", status: "ready (iteration 2, relaunched by Sam 2026-11-21: shorter please)", evidence: ev },
        { id: "E907-S3", title: "Back with him", status: "review (iteration 2)", evidence: ev },
        { id: "E907-S4", title: "Never sent back", status: "active", evidence: ev },
      ]) +
      "\n" +
      DECISIONS,
  });
  let worker: PressWorker | undefined;
  const app = createApp(db, {
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch, consoleHosts: [] } },
    presses: { retryMs: [0], onWorker: (w) => (worker = w), answerFirst: true },
    writeClones: { root: writeRoot },
  });
  const s = createStore(db);
  const m = s.createMilestone({ title: "home_repo", repo: "home_repo", path: SPINE, owner: "Sam", paused: false });
  const p = s.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  const a = s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: true });
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, pressId: res.headers.get("x-press-id") };
  };
  const landed = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const pr = (await req("GET", `/api/presses/${id}`)).json;
      if (pr.state !== "landing") return pr;
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
  return { req, landed, repo, store: s, milestone: m, assignment: a, origin: () => git(repo.bare, "show", `main:${SPINE}`) };
}

describe("GET /api/sent-back-cards and his note on a card in work", () => {
  it("lists the rows he sent back (any worked-on status), never one back in review or one he never sent back; a running worker marks it in progress", async () => {
    const w = world();
    const first = (await w.req("GET", "/api/sent-back-cards")).json;
    expect(first.map((c: any) => [c.ref, c.state, c.iteration])).toEqual([
      ["E907-S1", "waiting", 5],
      ["E907-S2", "waiting", 2],
    ]);
    expect(first[0]).toMatchObject({ repo: "home_repo", path: SPINE, milestoneId: w.milestone.id, words: "Where is the kernel thing, make it clearer", since: "2026-11-22" });
    // a worker starts on the row: the card says who
    w.store.createRun({ assignmentId: w.assignment.id, milestoneId: w.milestone.id, kind: "wake", outcome: "running", summary: "E907-S1 iteration 5: the kernel page, clearer", clientRequestId: "E907-S1-run_parent" } as never);
    const second = (await w.req("GET", "/api/sent-back-cards")).json;
    expect(second[0]).toMatchObject({ ref: "E907-S1", state: "in_progress", worker: { persona: "Delivery Manager", live: true } });
    expect(second[1]).toMatchObject({ ref: "E907-S2", state: "waiting" });
  });

  it("his note on a card in work lands as a Decisions row that says the round is in work; the row's status is untouched", async () => {
    const w = world();
    const [one] = (await w.req("GET", "/api/sent-back-cards")).json;
    const before = w.origin().split("\n").find((l) => l.startsWith("| E907-S1 |"));
    const c = await w.req("POST", "/api/closed-cards/comment", { kind: "review", repo: one.repo, path: one.path, ref: one.ref, title: one.title, milestoneId: one.milestoneId, text: "Also show the wheel on the phone", stage: "in_work", via: "voice" });
    expect(c.status).toBe(202);
    expect(await w.landed(c.pressId!)).toMatchObject({ state: "landed", action: "review comment" });
    const text = w.origin();
    expect(text).toMatch(/\| comment \| Sam's note on row E907-S1 while its next round is in work \(voice\): "Also show the wheel on the phone" \|/);
    expect(text).not.toMatch(/after he closed it/);
    expect(text.split("\n").find((l) => l.startsWith("| E907-S1 |"))).toBe(before);
    // still on his inbox after the note
    expect((await w.req("GET", "/api/sent-back-cards")).json.map((x: any) => x.ref)).toContain("E907-S1");
  });
});
