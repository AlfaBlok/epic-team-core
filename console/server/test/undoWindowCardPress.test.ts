import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createAnswerJobs } from "../src/inbox/answerJobs.js";
import { reopenCell } from "../src/review/rows.js";
import { undoHoldMs, UNDO_MAX_MS } from "../src/press/presses.js";
import type { PressWorker } from "../src/press/mount.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * after a card closes, the floating "Saved" note offers Add a last thought and
 * Bring it back; every closed card stays findable on Team home with Add comment. Server side: a card press sent with
 * x-undo-ms waits that long before it is written (Bring it back inside it writes nothing and wakes nobody); after it
 * landed, Bring it back sets the row back to review; Add comment writes a Decisions row (never the answered line) and
 * wakes the owner; Recently closed lists what landed.
 */
const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
const DECISIONS = ["## Decisions", "", "| Date | Outcome | Decision | Summary | Evidence | Revisit |", "|---|---|---|---|---|---|", ""].join("\n");
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s18-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s18-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const rows = [
    { id: "T18-S1", title: "TEST card one" },
    { id: "T18-S2", title: "TEST card two" },
  ];
  const repo = makeRepo(dir, "home_repo", {
    [SPINE]: spineText("EPIC-900", "home_repo", rows.map((r) => ({ ...r, status: "review", evidence: "[page](https://team.example/audit)" }))) + "\n" + DECISIONS,
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
  const m = s.createMilestone({ title: "home_repo", repo: "home_repo", path: SPINE, owner: "Sam", paused: false });
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
    await req("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    return (await req("GET", "/api/review-items")).json as { id: string; ref: string; repo: string; path: string; title: string; milestoneId?: string }[];
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

describe("undo window: a card press waits before it is written", () => {
  it("x-undo-ms holds the press; Bring it back inside it writes nothing; it never lands later", async () => {
    const w = world();
    const [one] = await w.cards();
    const head = git(w.repo.bare, "rev-parse", "main");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`, undefined, { "x-undo-ms": "400" });
    expect(r.status).toBe(202);
    expect(r.json.press).toMatchObject({ state: "landing", undoMs: 400 });
    // a worker tick inside the window writes nothing
    await w.worker().tick();
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);
    const u = await w.req("POST", `/api/presses/${r.pressId}/undo`);
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ undone: true, press: { state: "undone", result: "undone" } });
    await new Promise((res) => setTimeout(res, 500));
    await w.worker().tick();
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);
    expect(w.originRow(one.ref)).toMatch(/\| review \|/);
    // an undone press is not a failure
    expect((await w.req("GET", "/api/write-health")).json.today).toMatchObject({ failed: 0 });
    // the card is still a card
    expect((await w.cards()).map((c) => c.id)).toContain(one.id);
  });

  it("without Bring it back the held press lands once its window is over", async () => {
    const w = world();
    const [one] = await w.cards();
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`, undefined, { "x-undo-ms": "150" });
    const p = await w.landed(r.pressId!);
    expect(p.state).toBe("landed");
    expect(w.originRow(one.ref)).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
    // too late to undo the press: 409 landed (the card then brings the row back through /review-items/reopen)
    const u = await w.req("POST", `/api/presses/${r.pressId}/undo`);
    expect(u.status).toBe(409);
    expect(u.json.error.code).toBe("landed");
  });

  it("a press without the header (the daily press test, agents) is written at once, as before", async () => {
    const w = world();
    const [one] = await w.cards();
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`);
    expect(r.json.press.undoMs).toBeUndefined();
    expect((await w.landed(r.pressId!)).state).toBe("landed");
  });

  it("the window is capped", () => {
    expect(undoHoldMs("8000")).toBe(8000);
    expect(undoHoldMs("999999")).toBe(UNDO_MAX_MS);
    expect(undoHoldMs("-3")).toBe(0);
    expect(undoHoldMs(undefined)).toBe(0);
    expect(undoHoldMs("x")).toBe(0);
  });
});

describe("Bring it back after the press landed", () => {
  for (const [what, body] of [
    ["approve", undefined],
    ["deny", { reason: "not now" }],
  ] as const) {
    it(`${what}: the row goes back to review and the card is in the inbox again`, async () => {
      const w = world();
      const [one] = await w.cards();
      const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/${what}`, body);
      expect((await w.landed(r.pressId!)).state).toBe("landed");
      expect(w.originRow(one.ref)).not.toMatch(/\| review \|/);
      const b = await w.req("POST", "/api/review-items/reopen", { repo: one.repo, path: one.path, ref: one.ref, title: one.title });
      expect(b.status).toBe(202);
      const p = await w.landed(b.pressId!);
      expect(p).toMatchObject({ state: "landed", action: "review bring back" });
      expect(w.originRow(one.ref)).toMatch(/\| review \|/);
      expect(git(w.repo.bare, "log", "-1", "--format=%s", "main")).toBe(`Review ${one.ref}: brought back to review (Sam, via console)`);
    });
  }

  it("Bring it back sent while the close is still on its way lands after it (same card, press order)", async () => {
    const w = world();
    const [one] = await w.cards();
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`, undefined, { "x-undo-ms": "300" });
    const b = await w.req("POST", "/api/review-items/reopen", { id: one.id, repo: one.repo, path: one.path, ref: one.ref });
    expect(b.status).toBe(202);
    expect((await w.landed(r.pressId!)).state).toBe("landed");
    expect((await w.landed(b.pressId!)).state).toBe("landed");
    expect(w.originRow(one.ref)).toMatch(/\| review \|/);
  });

  it("a row his press did not close is left alone (409, nothing written)", async () => {
    const w = world();
    const [one] = await w.cards();
    const head = git(w.repo.bare, "rev-parse", "main");
    const b = await w.req("POST", "/api/review-items/reopen", { repo: one.repo, path: one.path, ref: one.ref });
    const p = await w.landed(b.pressId!);
    expect(p.state).toBe("failed");
    expect(p.reason).toMatch(/not closed by Sam's press/);
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);
  });

  it("reopenCell reads only his press's statuses", () => {
    const f = reopenCell("X-1");
    expect(f("done (approved by Sam 2026-11-10)")).toBe("review");
    expect(f("superseded (denied by Sam 2026-11-10: not now)")).toBe("review");
    expect(f("active (iteration 2, relaunched by Sam 2026-11-10: more)")).toBe("review");
    expect(f("done (approved by Sam 2026-11-10) — snoozed until: 2026-11-12")).toBe("review");
    expect(f("done (no confirm: plumbing)")).toEqual({ skip: expect.stringMatching(/not closed/) });
    expect(f("done (approved by the daily press test 2026-11-10)")).toEqual({ skip: expect.any(String) });
    expect(f("ready")).toEqual({ skip: expect.any(String) });
  });
});

describe("Add comment on a closed card", () => {
  it("writes one Decisions row quoting him (the row's status is untouched), answered at once, and lists the card under Recently closed", async () => {
    const w = world();
    const [one] = await w.cards();
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`);
    expect((await w.landed(r.pressId!)).state).toBe("landed");
    const status = w.originRow(one.ref);
    const list = (await w.req("GET", "/api/closed-cards")).json;
    expect(list).toEqual([expect.objectContaining({ kind: "review", repo: one.repo, path: one.path, ref: one.ref, outcome: "approved", comments: 0 })]);
    const c = await w.req("POST", "/api/closed-cards/comment", { kind: "review", repo: one.repo, path: one.path, ref: one.ref, title: one.title, milestoneId: w.milestone.id, text: "Also | add the phone view\nplease" });
    expect(c.status).toBe(202);
    const p = await w.landed(c.pressId!);
    expect(p).toMatchObject({ state: "landed", action: "review comment" });
    const text = w.origin();
    expect(text).toMatch(new RegExp(`\\| \\d{4}-\\d{2}-\\d{2} \\| comment \\| Sam's comment on row ${one.ref} after he closed it: "Also / add the phone view please" \\|`));
    expect(w.originRow(one.ref)).toBe(status);
    expect(git(w.repo.bare, "log", "-1", "--format=%s", "main")).toBe(`${one.ref}: Sam's comment after closing it (via console)`);
    // a TEST repo wakes nobody (the code repo here is not a TEST repo name, so the wake was tried: no cycle in this console)
    expect(p.response.wakeError).toMatch(/cycle is off/);
    expect((await w.req("GET", "/api/closed-cards")).json[0]).toMatchObject({ ref: one.ref, comments: 1 });
    // a TEST repo's cards are listed only on ?state=test (the code repo is not one)
    expect((await w.req("GET", "/api/closed-cards?state=test")).json).toEqual([]);
  });

  it("refuses a ref the spine does not hold, a path outside the repo, and empty words; nothing written", async () => {
    const w = world();
    const head = git(w.repo.bare, "rev-parse", "main");
    for (const [body, code] of [
      [{ kind: "review", repo: "home_repo", path: SPINE, ref: "T18-S9", text: "x" }, 404],
      [{ kind: "review", repo: "another-world", path: SPINE, ref: "T18-S1", text: "x" }, 404],
      [{ kind: "review", repo: "home_repo", path: "../x.md", ref: "T18-S1", text: "x" }, 400],
      [{ kind: "review", repo: "home_repo", path: SPINE, ref: "T18-S1", text: "  " }, 400],
    ] as const) {
      const c = await w.req("POST", "/api/closed-cards/comment", body);
      const p = await w.landed(c.pressId!);
      expect(p.state, JSON.stringify(body)).toBe("failed");
      expect(p.httpStatus).toBe(code);
    }
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);
  });
});

describe("answer jobs: hold and cancel", () => {
  it("a held answer runs after its window; cancel inside it deletes the stored answer and runs nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s18-jobs-"));
    const db = openDb(path.join(dir, "console.db"));
    cleanup.push(() => (db.close(), fs.rmSync(dir, { recursive: true, force: true })));
    const ran: string[] = [];
    const jobs = createAnswerJobs({ db, step: async (id) => (ran.push(id), { state: "done" }), log: () => {} });
    const add = (id: string) =>
      db.prepare("INSERT INTO jordi_responses (id, item_id, item, kind, text, delivery, created_at, job_state, job_attempts) VALUES (?, 'i', '{}', 'answer', 'x', 'queued', ?, 'pending', 0)").run(id, new Date().toISOString());
    add("a");
    add("b");
    jobs.schedule("a", 60);
    jobs.schedule("b", 60);
    expect(jobs.cancel("b")).toBe(true);
    expect(db.prepare("SELECT id FROM jordi_responses WHERE id = 'b'").get()).toBeUndefined();
    expect(ran).toEqual([]);
    await jobs.idle();
    expect(ran).toEqual(["a"]);
    // after it ran: no cancel
    expect(jobs.cancel("a")).toBe(false);
  });
});
