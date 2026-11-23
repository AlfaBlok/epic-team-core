import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PICKUP_AFTER_MIN, PICKUP_MAX_ROUNDS, createPickup, pickupBrief, pickupPlan, reopenedCell, teamCloseRefusal, type PickupDeps } from "../src/review/pickup.js";
import type { SentBackCard } from "../src/review/sentBack.js";
import { pressWords, type ClosedCard } from "../src/review/afterClose.js";
import type { EditInput, SpineWrite } from "../src/inbox/spineWrite.js";
import { spineText } from "./reviewFixture.js";

/**
 * (the owner 2026-11-23 00:29Z): "Closed by the team, it should not be possible ... I don't
 * want the things to stay in the inbox when I've already responded. What I want them is to come back properly, and have
 * a fallback mechanism so that if things get lost, they get picked up."
 */
const NOW = new Date("2026-11-23T01:00:00Z");
const card = (ref: string, o: Partial<SentBackCard> = {}): SentBackCard => ({ id: `rv_${ref}`, ref, repo: "home_repo", path: "docs/spines/root.md", milestoneId: "ms_1", title: `Card ${ref} was made.`, state: "waiting", iteration: 2, since: "2026-11-23T00:00:00Z", ...o });

describe("only his press closes a card he sent back", () => {
  const sent = "active (iteration 5, relaunched by Sam 2026-11-22: Where is the kernel thing)";
  it("refuses every way the team closed one: no confirm, a fold, superseded, parked, fed an ask", () => {
    for (const next of ["done (no confirm: its next steps run)", "done (folded into E907-S9)", "superseded (by E907-S9)", "parked", "done (fed E907-A3)", "deferred", "dropped"])
      expect(teamCloseRefusal(sent, next, "Sam"), next).toMatch(/only his press closes it/);
  });
  it("allows the round to go on or come back to him, and his own close", () => {
    for (const next of ["review", "active (iteration 5, relaunched by Sam 2026-11-22: Where is the kernel thing)", "blocked (E907-A3)", "monitoring until 2026-11-24T10:00Z", "done (approved by Sam 2026-11-23)", "superseded (denied by Sam 2026-11-23: no)", "parked by Sam 2026-11-23"])
      expect(teamCloseRefusal(sent, next, "Sam"), next).toBeUndefined();
  });
  it("a move to another list is not a close: the ticket lives on there", () => {
    expect(teamCloseRefusal(sent, "moved (to one-offs OO-S2)", "Sam")).toBeUndefined();
  });
  it("a row he never sent back closes as before", () => {
    expect(teamCloseRefusal("active", "done (no confirm: plumbing)", "Sam")).toBeUndefined();
    expect(teamCloseRefusal("review", "done (approved by Sam 2026-11-23)", "Sam")).toBeUndefined();
  });
});

describe("pickupPlan: what the console does with each card he sent back", () => {
  it("a card the team closed is reopened at once; one with nobody on it starts after 15 minutes, and waits for its manager before", () => {
    const plan = pickupPlan(
      [
        card("A-1", { state: "closed_by_team", why: "done (no confirm: x)", since: "2026-11-22T21:01:00Z" }),
        card("A-2", { since: "2026-11-23T00:40:00Z" }),
        card("A-3", { since: "2026-11-23T00:50:00Z" }),
        card("A-4", { state: "in_progress" }),
      ],
      NOW,
    );
    expect(plan.map((p) => [p.card.ref, p.what])).toEqual([["A-1", "reopen"], ["A-2", "start"], ["A-3", "hold"]]);
    expect(plan[2].dueAt).toBe("2026-11-23T01:05:00.000Z");
    expect(PICKUP_AFTER_MIN).toBe(15);
  });
  it("a round that came back as an ask, or one on a timed check still ahead, is left alone; a check that is past is picked up", () => {
    const plan = pickupPlan(
      [
        card("B-1", { status: "blocked (E907-A3: his pick)" }),
        card("B-2", { checkAt: "2026-11-23T05:00Z" }),
        card("B-3", { checkAt: "2026-11-22T05:00Z" }),
      ],
      NOW,
    );
    expect(plan.map((p) => p.card.ref)).toEqual(["B-3"]);
  });
  it("the oldest answer first; a row that keeps only a date counts from that day's start", () => {
    const plan = pickupPlan([card("C-1", { since: "2026-11-22T10:00:00Z" }), card("C-2", { since: "2026-11-10" })], NOW);
    expect(plan.map((p) => p.card.ref)).toEqual(["C-2", "C-1"]);
    expect(plan.every((p) => p.what === "start")).toBe(true);
  });
});

describe("the reopened row and the round's brief", () => {
  it("the row reads active with his send-back, his words and what was undone, in one table cell", () => {
    const cell = reopenedCell({ iteration: 7, since: "2026-11-22T21:01:54Z", words: "Where is the kernel (the page) | now" }, "done (no confirm: its next steps run)", "2026-11-23", "Sam");
    expect(cell).toBe('active (iteration 7, reopened by the console 2026-11-23: the team had closed it without his press, it read "done [no confirm: its next steps run]"; relaunched by Sam 2026-11-22: Where is the kernel [the page] / now)');
    expect(teamCloseRefusal(cell, "done (no confirm: again)", "Sam")).toBeDefined();
  });
  it("the brief names the row, his words and that the worker never closes it", () => {
    const b = pickupBrief(card("E907-S1", { words: "make it clearer", continuesIn: "E907-S9" }), { reopened: true, afterMin: 15, owner: "Sam" });
    expect(b).toContain("row E907-S1");
    expect(b).toContain('"make it clearer"');
    expect(b).toContain("only his press closes a card he sent back");
    expect(b).toContain("folded into E907-S9");
    expect(b).toContain("Never close, fold or park this row yourself");
    expect(b).toContain("card_notes.py words E907-S1");
  });
  it("his words come from the press he made", () => {
    expect(pressWords(JSON.stringify({ method: "POST", path: "/x", body: JSON.stringify({ feedback: " not this " }) }))).toBe("not this");
    expect(pressWords(JSON.stringify({ body: { feedback: "as object" } }))).toBe("as object");
    expect(pressWords("not json")).toBeUndefined();
    expect(pressWords(null)).toBeUndefined();
  });
});

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

/** a console with one goal, its Delivery Manager, a spine on disk and a work queue that records what it is handed. */
function world(rows: { id: string; status: string }[], cards: SentBackCard[], o: { asks?: ClosedCard[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-pickup-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "home_repo");
  fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  const file = path.join(dir, "docs/spines/root.md");
  fs.writeFileSync(file, spineText("EPIC-900", "home_repo", rows));
  const commits: string[] = [];
  const writer = {
    edit: async (i: EditInput): Promise<SpineWrite> => {
      const e = i.edit(fs.readFileSync(path.join(i.repoDir, i.path), "utf8"), "2026-11-23");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.writeFileSync(path.join(i.repoDir, i.path), e.text);
      commits.push(e.msg);
      return { status: "written", sha: "abc1234" };
    },
  };
  type R = { id: string; outcome: string; clientRequestId: string; startedAt: string; endedAt?: string | null; parentRunId?: string | null; assignmentId: string };
  const runs: R[] = [];
  const launched: { assignment: string; ticket: string; title?: string; brief: string; clientRequestId: string }[] = [];
  const woken: { assignment: string; instructions: string; key: string }[] = [];
  let now = NOW;
  const deps: PickupDeps = {
    store: {
      listMilestones: () => [{ id: "ms_1", repo: "home_repo", path: "docs/spines/root.md" }],
      listAssignments: () => [{ id: "as_worker", personaId: "pe_w" }, { id: "as_dm", personaId: "pe_dm" }],
      getPersona: (id: string) => ({ name: id === "pe_dm" ? "Delivery Manager" : "Ticket worker" }),
      listRuns: (f: { assignmentId?: string; since?: string }) => runs.filter((r) => (!f.assignmentId || r.assignmentId === f.assignmentId) && (!f.since || r.startedAt >= f.since)),
    } as unknown as PickupDeps["store"],
    reposRoot: root,
    list: async () => cards,
    recent: () => o.asks ?? [],
    writer,
    launch: async (assignment, i) => {
      const prev = runs.find((r) => r.clientRequestId === i.clientRequestId);
      if (prev) return { run: prev, replayed: true };
      launched.push({ assignment, ...i });
      const run: R = { id: `run_${runs.length + 1}`, outcome: "deferred", clientRequestId: i.clientRequestId, startedAt: now.toISOString(), parentRunId: "run_wake", assignmentId: assignment };
      runs.push(run);
      return { run, replayed: false };
    },
    wake: async (assignment, w, key) => void woken.push({ assignment, instructions: w.instructions, key }),
    cancel: (id) => void Object.assign(runs.find((r) => r.id === id)!, { outcome: "idle", endedAt: now.toISOString() }),
    now: () => now,
    log: () => undefined,
  };
  return { pickup: createPickup(deps), launched, woken, runs, commits, spine: () => fs.readFileSync(file, "utf8"), at: (iso: string) => (now = new Date(iso)) };
}

describe("the fallback: an answer of his nobody worked gets its round from the console", () => {
  it("a card the team closed after he sent it back is set back to active with his words, and its round is handed to the queue", async () => {
    const w = world(
      [{ id: "E907-S1", status: "done (no confirm: its next steps run)" }],
      [card("E907-S1", { state: "closed_by_team", why: "done (no confirm: its next steps run)", status: "done (no confirm: its next steps run)", iteration: 7, since: "2026-11-22T21:01:54Z", words: "Where is the kernel thing" })],
    );
    const rep = await w.pickup.tick();
    expect(rep.reopened).toEqual(["E907-S1"]);
    expect(rep.started).toEqual(["E907-S1"]);
    expect(w.spine()).toContain("| active (iteration 7, reopened by the console 2026-11-23: the team had closed it without his press");
    expect(w.spine()).toContain("relaunched by ");
    expect(w.spine()).toContain("Where is the kernel thing) |");
    expect(w.commits[0]).toMatch(/^E907-S1: reopened by the console/);
    // the Delivery Manager's assignment, one run, named so Hosts and the sent-back list see it is this row's worker
    expect(w.launched).toEqual([expect.objectContaining({ assignment: "as_dm", ticket: "E907-S1", clientRequestId: "E907-S1-pickup-20261122-1", title: "Sent back by you: Card E907-S1 was made." })]);
    expect(w.launched[0].brief).toContain("the team then closed it without his press");
  });

  it("a row he closed himself meanwhile is never reopened", async () => {
    const w = world([{ id: "E907-S1", status: "done (approved by Sam 2026-11-23)" }], [card("E907-S1", { state: "closed_by_team", status: "done (no confirm: x)" })]);
    const rep = await w.pickup.tick();
    expect(rep.reopened).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.spine()).toContain("done (approved by Sam 2026-11-23)");
  });

  it("a ticket that was only moved to another list is never reopened", async () => {
    const w = world([{ id: "E907-S1", status: "moved (to one-offs OO-S2)" }], [card("E907-S1", { state: "closed_by_team", status: "moved (to one-offs OO-S2)" })]);
    const rep = await w.pickup.tick();
    expect(rep.reopened).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.spine()).toContain("moved (to one-offs OO-S2)");
  });

  it("nobody on it for 15 minutes: started once; while it is queued or running nothing more is started", async () => {
    const w = world([{ id: "E907-S2", status: "active (iteration 2, relaunched by Sam 2026-11-23: shorter)" }], [card("E907-S2", { since: "2026-11-23T00:40:00Z", words: "shorter" })]);
    expect((await w.pickup.tick()).started).toEqual(["E907-S2"]);
    await w.pickup.tick();
    await w.pickup.tick();
    expect(w.launched.length).toBe(1);
    expect(w.launched[0].brief).toContain("no worker and no new round followed within 15 minutes");
  });

  it("a queued round whose card is no longer waiting is taken out of the queue, and a row that keeps only the day gets no second round", async () => {
    const cards = [card("E907-S2", { since: "2026-11-23T00:40:00Z" })];
    const w = world([{ id: "E907-S2", status: "active (iteration 2, relaunched by Sam 2026-11-23: shorter)" }], cards);
    await w.pickup.tick();
    expect(w.launched.map((l) => l.clientRequestId)).toEqual(["E907-S2-pickup-20261123-1"]);
    // his press ages out and the row keeps only the day: the same send-back, the same key, no second run
    cards[0] = card("E907-S2", { since: "2026-11-23" });
    await w.pickup.tick();
    expect(w.launched.length).toBe(1);
    // the card came back to his review: it is no longer listed, so its queued round is cancelled
    cards.length = 0;
    const rep = await w.pickup.tick();
    expect(rep.cancelled).toEqual(["E907-S2"]);
    expect(w.runs[0].outcome).toBe("idle");
  });

  it("inside the first 15 minutes its manager may still start it: the console holds, and says when it will start it", async () => {
    const w = world([{ id: "E907-S2", status: "active (iteration 2, relaunched by Sam 2026-11-23: shorter)" }], [card("E907-S2", { since: "2026-11-23T00:50:00Z" })]);
    await w.pickup.tick();
    expect(w.launched).toEqual([]);
    expect(w.pickup.waiting()).toEqual([expect.objectContaining({ ref: "E907-S2", startsAt: "2026-11-23T01:05:00.000Z", why: "its manager's first 15 minutes after your answer. The console starts it by itself at 01:05Z." })]);
  });

  it("a round that ended without coming back gets another after 15 minutes, three at most, then the row is named as stuck", async () => {
    const w = world([{ id: "E907-S2", status: "active (iteration 2, relaunched by Sam 2026-11-22: shorter)" }], [card("E907-S2", { since: "2026-11-22T10:00:00Z" })]);
    for (let n = 1; n <= PICKUP_MAX_ROUNDS; n++) {
      await w.pickup.tick();
      expect(w.launched.length).toBe(n);
      const end = new Date(NOW.getTime() + n * 3600_000);
      Object.assign(w.runs[n - 1], { outcome: "failed", endedAt: end.toISOString() });
      w.at(new Date(end.getTime() + 5 * 60_000).toISOString());
      await w.pickup.tick();
      expect(w.launched.length).toBe(n); // 5 minutes after it ended: not yet
      w.at(new Date(end.getTime() + 16 * 60_000).toISOString());
    }
    const rep = await w.pickup.tick();
    expect(w.launched.map((l) => l.clientRequestId)).toEqual(["E907-S2-pickup-20261122-1", "E907-S2-pickup-20261122-2", "E907-S2-pickup-20261122-3"]);
    expect(rep.stuck).toEqual(["E907-S2"]);
    expect(w.pickup.waiting()[0].why).toContain("It needs its manager");
  });

  it("an ask he answered whose owner never ran afterwards gets that wake, once it is 15 minutes old; one whose owner ran is left alone", async () => {
    const ask = (ref: string, at: string): ClosedCard => ({ key: `ask:home_repo:docs/spines/root.md#${ref}`, kind: "ask", repo: "home_repo", path: "docs/spines/root.md", ref, title: "Your pick?", outcome: "answered", at, comments: 0 });
    const w = world([], [], { asks: [ask("E907-A1", "2026-11-23T00:30:00Z"), ask("E907-A2", "2026-11-23T00:55:00Z")] });
    const rep = await w.pickup.tick();
    expect(rep.woken).toEqual(["E907-A1"]);
    expect(w.woken[0]).toEqual(expect.objectContaining({ assignment: "as_dm", key: "pickup:ask:home_repo:E907-A1:202611230030" }));
    w.runs.push({ id: "run_wake2", outcome: "progressed", clientRequestId: "x", startedAt: "2026-11-23T00:56:00Z", assignmentId: "as_dm" });
    w.at("2026-11-23T01:20:00Z");
    expect((await w.pickup.tick()).woken).toEqual([]);
  });
});
