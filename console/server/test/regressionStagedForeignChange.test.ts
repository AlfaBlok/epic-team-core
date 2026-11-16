import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { cloneDirFor, createCloneWriter, sparseExcluded } from "../src/inbox/writeClone.js";
import { createPresses, judge } from "../src/press/presses.js";
import type { PressWorker } from "../src/press/mount.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * every press is logged with its result; a press is saved before any git write and
 * retried until it lands; the console writes from its own clone, so a stranded change in the shared checkout no longer
 * blocks a press. The regression: 2026-11-07 21:20Z the owner's approve of was left staged in the main server the code repo
 * checkout and every console write after it was refused with "the checkout has uncommitted changes" until 7171dc80.
 */
const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world(o: { clones?: boolean; rows?: { id: string; title: string }[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const rows = o.rows ?? [
    { id: "T72-S1", title: "TEST card one" },
    { id: "T72-S2", title: "TEST card two" },
  ];
  const repo = makeRepo(dir, "home_repo", {
    [SPINE]: spineText(
      "PLAN-0",
      "home_repo",
      rows.map((r) => ({
        ...r,
        status: "review",
        evidence: "[page](https://team.example/audit)",
      })),
    ),
    "docs/spines/other.md": "# other\n",
  });
  const live = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  let worker: PressWorker | undefined;
  const app = createApp(db, {
    read: {
      reposRoot: dir,
      seatsFile: path.join(dir, "seats.json"),
      listThreads: async () => [],
    },
    review: { live: { fetch: live, consoleHosts: [] } },
    presses: { retryMs: [0], onWorker: (w) => (worker = w) },
    ...(o.clones === false ? {} : { writeClones: { root: writeRoot } }),
  });
  const s = createStore(db);
  const m = s.createMilestone({
    title: "home_repo",
    repo: "home_repo",
    path: SPINE,
    owner: "Sam",
    paused: false,
  });
  const p = s.createPersona({
    name: "Delivery Manager",
    remit: "run",
    skills: [],
    model: "opus",
    mayWrite: true,
  });
  s.createAssignment({
    milestoneId: m.id,
    personaId: p.id,
    cadence,
    enabled: true,
  });
  const req = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
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
  /** The cards once their links were checked (the first read checks them in the background). */
  const cards = async () => {
    await req("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    return (await req("GET", "/api/review-items")).json as {
      id: string;
      ref: string;
    }[];
  };
  const originRow = (id: string) =>
    git(repo.bare, "show", `main:${SPINE}`)
      .split("\n")
      .find((l) => l.startsWith(`| ${id} |`));
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  });
  return {
    dir,
    db,
    app,
    req,
    cards,
    repo,
    originRow,
    writeRoot,
    worker: () => worker!,
  };
}

/** 2026-11-07 21:20Z: an approve of another row left staged (not committed) in the shared checkout, in the same spine. */
function strandApprove(dir: string, id: string) {
  const f = path.join(dir, SPINE);
  const text = fs.readFileSync(f, "utf8").replace(new RegExp(`^(\\| ${id} \\|(?:[^|]*\\|){3}) review \\|`, "m"), `$1 done (approved by Sam 2026-11-07) |`);
  fs.writeFileSync(f, text);
  git(dir, "add", SPINE);
  return text;
}

describe("T72-S1 regression 2026-11-07: a staged foreign change in the shared checkout never blocks a press", () => {
  it("approve lands through the console's own clone; the stranded change is kept byte for byte; the log and write-health show it", async () => {
    const w = world();
    const list = await w.cards();
    const two = list.find((c) => c.ref === "T72-S2")!;
    const stranded = strandApprove(w.repo.dir, "T72-S1");
    const before = git(w.repo.dir, "diff", "--cached");

    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(two.id)}/approve`);
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("approved");
    // landed on origin, from the clone (the shared checkout still holds the stranded change, untouched)
    expect(w.originRow("T72-S2")).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
    expect(w.originRow("T72-S1")).toContain("| review |");
    expect(fs.readFileSync(path.join(w.repo.dir, SPINE), "utf8")).toBe(stranded);
    expect(git(w.repo.dir, "diff", "--cached")).toBe(before);
    expect(fs.existsSync(path.join(cloneDirFor(w.writeRoot, w.repo.dir), ".git"))).toBe(true);

    // the press log: one press, landed on the first try
    const p = (await w.req("GET", `/api/presses/${r.pressId}`)).json;
    expect(p).toMatchObject({
      action: "review approve",
      target: two.id,
      state: "landed",
      result: "ok",
      attempts: 1,
    });
    expect(p.landedAt).toBeTruthy();
    expect(p.tries[0].ms).toBeGreaterThanOrEqual(0);
    const h = (await w.req("GET", "/api/write-health")).json;
    expect(h.today).toMatchObject({ presses: 1, ok: 1, failed: 0 });
    // same file: the shared checkout cannot follow without touching the stranded change, so it waits (and says so)
    expect(h.clones.enabled).toBe(true);
    expect(h.clones.lagging.map((l: any) => l.dir)).toEqual([w.repo.dir]);
    expect((await w.req("GET", "/api/health")).json.presses).toMatchObject({
      today: 1,
      failed24h: 0,
      landing: 0,
    });
  });

  it("a stranded change in another file: the press lands and the shared checkout fast-forwards around it", async () => {
    const w = world();
    const list = await w.cards();
    fs.writeFileSync(path.join(w.repo.dir, "docs/spines/other.md"), "# other, staged by someone\n");
    git(w.repo.dir, "add", "docs/spines/other.md");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(list[0].id)}/approve`);
    expect(r.status).toBe(200);
    expect(git(w.repo.dir, "rev-parse", "HEAD")).toBe(git(w.repo.bare, "rev-parse", "main"));
    expect(git(w.repo.dir, "diff", "--cached", "--name-only")).toBe("docs/spines/other.md");
    expect((await w.req("GET", "/api/write-health")).json.clones.lagging).toEqual([]);
  });

  it("old path (CONSOLE_WRITE_CLONE=off): the press is saved, answered 'landing', and lands on retry once the checkout is clean", async () => {
    const w = world({ clones: false });
    const list = await w.cards();
    const two = list.find((c) => c.ref === "T72-S2")!;
    strandApprove(w.repo.dir, "T72-S1");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(two.id)}/approve`);
    expect(r.status).toBe(202);
    expect(r.json.press).toMatchObject({
      state: "landing",
      message: "Saved, landing…",
    });
    expect(r.json.press.reason).toMatch(/uncommitted changes/);
    const id = r.json.press.id;
    expect((await w.req("GET", `/api/presses/${id}`)).json).toMatchObject({
      state: "landing",
      result: "queued",
      attempts: 1,
    });
    expect(w.originRow("T72-S2")).toContain("| review |");

    // still stranded: the worker tries again and it waits again (never success before it lands)
    await w.worker().tick();
    expect((await w.req("GET", `/api/presses/${id}`)).json).toMatchObject({
      state: "landing",
      attempts: 2,
    });

    // the Team desk commits or drops the stranded change (7171dc80): the next try lands
    git(w.repo.dir, "reset", "-q");
    git(w.repo.dir, "checkout", "--", SPINE);
    await w.worker().tick();
    const p = (await w.req("GET", `/api/presses/${id}`)).json;
    expect(p).toMatchObject({
      state: "landed",
      result: "retried",
      attempts: 3,
    });
    expect(p.response.state).toBe("approved");
    expect(w.originRow("T72-S2")).toMatch(/\| done \(approved by Sam/);
    expect((await w.req("GET", "/api/write-health")).json.today).toMatchObject({
      presses: 1,
      retried: 1,
      failed: 0,
    });
  });
});

describe("T72-S1 press log", () => {
  it("a refused press is logged as failed with its reason and never replayed", async () => {
    const w = world();
    await w.cards();
    const r = await w.req("POST", "/api/review-items/rv_nope/approve");
    expect(r.status).toBe(404);
    const p = (await w.req("GET", `/api/presses/${r.pressId}`)).json;
    expect(p).toMatchObject({
      state: "failed",
      result: "failed",
      httpStatus: 404,
    });
    expect(p.reason).toMatch(/no row in review/);
    expect(await w.worker().tick()).toBe(0);
    const h = (await w.req("GET", "/api/write-health")).json;
    expect(h.today).toMatchObject({ presses: 1, failed: 1, failureRate: 1 });
    expect(h.lastFailures[0].id).toBe(r.pressId);
    expect((await w.req("GET", "/api/health")).json.presses.failed24h).toBe(1);
  });

  it("a retried press with the same Idempotency-Key gets the first press back, not a second write", async () => {
    const w = world();
    const list = await w.cards();
    const a = await w.req("POST", `/api/review-items/${encodeURIComponent(list[0].id)}/snooze`, { hours: 3 }, { "idempotency-key": "k-72" });
    expect(a.status).toBe(200);
    const b = await w.req("POST", `/api/review-items/${encodeURIComponent(list[0].id)}/snooze`, { hours: 3 }, { "idempotency-key": "k-72" });
    expect(b.status).toBe(200);
    expect(b.json.snoozedUntil).toBe(a.json.snoozedUntil);
    expect((await w.req("GET", "/api/presses")).json).toHaveLength(1);
  });

  it("a press cut off by a restart is due again at the next start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-db-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, "console.db"));
    const presses = createPresses(db);
    const id = presses.open({
      action: "review approve",
      target: "rv_x",
      who: "Sam",
      route: "/review-items/rv_x/approve",
      request: { method: "POST", path: "/api/review-items/rv_x/approve" },
    });
    expect(presses.due()).toEqual([]);
    db.close();
    const db2 = openDb(path.join(dir, "console.db"));
    let worker: PressWorker | undefined;
    createApp(db2, {
      read: {
        reposRoot: dir,
        seatsFile: path.join(dir, "seats.json"),
        listThreads: async () => [],
      },
      presses: { onWorker: (w) => (worker = w) },
    });
    expect(worker).toBeDefined();
    expect(
      createPresses(db2)
        .due()
        .map((d) => d.id),
    ).toEqual([id]);
    db2.close();
  });

  it("an answer's press follows its job: queued, then landed (retried) or failed with the job's reason", () => {
    const db = openDb(":memory:");
    const presses = createPresses(db);
    const a = presses.open({
      action: "ask answer",
      target: "it_1",
      who: "Sam",
      route: "/waiting-on-owner/it_1/respond",
    });
    presses.link(a, "jr_1");
    presses.answerJob("jr_1", {
      state: "pending",
      attempts: 1,
      error: "git push failed",
    });
    expect(presses.get(a)).toMatchObject({
      state: "landing",
      result: "queued",
      reason: "git push failed",
    });
    presses.answerJob("jr_1", { state: "done", attempts: 2, sha: "abc1234" });
    expect(presses.get(a)).toMatchObject({
      state: "landed",
      result: "retried",
      sha: "abc1234",
    });
    const b = presses.open({
      action: "ask answer",
      target: "it_2",
      who: "Sam",
      route: "/waiting-on-owner/it_2/respond",
      ref: "jr_2",
    });
    presses.answerJob("jr_2", {
      state: "failed",
      attempts: 5,
      error: "the ask is not in the spine any more",
    });
    expect(presses.get(b)).toMatchObject({
      state: "failed",
      reason: "the ask is not in the spine any more",
    });
    db.close();
  });

  it("a repeated press of the same answer (same key, the stored answer comes back) follows the same job: both land", () => {
    const db = openDb(":memory:");
    const presses = createPresses(db);
    const a = presses.open({
      action: "ask feedback",
      target: "it_1",
      who: "Sam",
      route: "/r",
      ref: "jr_9",
    });
    const b = presses.open({
      action: "ask feedback",
      target: "it_1",
      who: "Sam",
      route: "/r",
      ref: "jr_9",
    });
    presses.answerJob("jr_9", { state: "done", attempts: 1, sha: "abc" });
    expect([presses.get(a)?.state, presses.get(b)?.state]).toEqual(["landed", "landed"]);
    db.close();
  });

  it("at start, the presses of an answer job that ended while nothing listened take its end (production 2026-11-07 23:31Z: one answer pressed three times)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-rec-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, "console.db"));
    const presses = createPresses(db);
    db.prepare(
      "INSERT INTO jordi_responses (id, item_id, kind, text, delivery, created_at, job_state, job_attempts, spine_sha) VALUES ('jr_x', 'it_x', 'feedback', 'w', 'sent', ?, 'done', 1, 'cca0918')",
    ).run(new Date().toISOString());
    const a = presses.open({ action: "ask feedback", target: "it_x", who: "Sam", route: "/r", ref: "jr_x" });
    const b = presses.open({ action: "ask feedback", target: "it_x", who: "Sam", route: "/r", ref: "jr_x" });
    createApp(db, { read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
    expect([presses.get(a), presses.get(b)].map((p) => [p?.state, p?.sha])).toEqual([
      ["landed", "cca0918"],
      ["landed", "cca0918"],
    ]);
    db.close();
  });

  it("judge: 2xx and a landed write whose wake failed are landed; 5xx and checkout trouble retry; the rest is refused", () => {
    expect(judge(200, { item: { sha: "abc" } })).toEqual({
      kind: "landed",
      sha: "abc",
    });
    expect(
      judge(502, {
        error: {
          code: "wake_failed",
          message: "done, but the wake failed",
          item: { sha: "abc" },
        },
      }),
    ).toMatchObject({ kind: "landed", sha: "abc" });
    expect(
      judge(502, {
        error: { code: "spine_write_failed", message: "git push failed" },
      }).kind,
    ).toBe("retry");
    expect(
      judge(409, {
        error: {
          code: "spine_write_skipped",
          message: "not written: the checkout has uncommitted changes (M docs/x.md)",
        },
      }).kind,
    ).toBe("retry");
    expect(
      judge(409, {
        error: {
          code: "spine_write_skipped",
          message: "not written: local main is diverged from origin/main",
        },
      }).kind,
    ).toBe("retry");
    expect(
      judge(409, {
        error: { code: "not_in_review", message: "T-1 is not live yet" },
      }).kind,
    ).toBe("refused");
    expect(judge(404, { error: { code: "not_found", message: "no row in review" } }).kind).toBe("refused");
  });

  it("gives up after the limit and says so (failed, counted)", () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const db = openDb(":memory:");
    const presses = createPresses(db, {
      now: () => t,
      retryMs: [1000],
      giveUpMs: 10_000,
    });
    const id = presses.open({
      action: "review approve",
      target: "rv_x",
      who: "Sam",
      route: "/r",
      request: { method: "POST", path: "/api/r" },
    });
    expect(
      presses.settle(id, {
        verdict: { kind: "retry", reason: "git push failed" },
        status: 502,
        ms: 5,
        retry: true,
      }).state,
    ).toBe("landing");
    t += 20_000;
    const p = presses.settle(id, {
      verdict: { kind: "retry", reason: "git push failed" },
      status: 502,
      ms: 5,
      retry: true,
    });
    expect(p).toMatchObject({ state: "failed", result: "failed" });
    expect(p.reason).toMatch(/still not landed after 2 tries/);
    expect(presses.health(1).failed24h).toBe(1);
    db.close();
  });
});

describe("T72-S1 own clone", () => {
  it("is made once, cleaned of leftovers before each write, and falls back to the shared checkout when it cannot be made", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-clone-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n" }, { cards: false });
    const writeRoot = path.join(root, "_write");
    const logs: string[] = [];
    const w = createCloneWriter(createSpineWriter(), {
      checkTtlMs: 0, // this test changes the clone between writes: the full check before every write
      root: writeRoot,
      log: (m) => logs.push(m),
    });
    const edit = (text: string) =>
      w.edit({
        repoDir: repo.dir,
        path: "a.md",
        label: "t",
        edit: () => ({ text, msg: "edit a", body: "b" }),
      });
    expect((await edit("a1\n")).status).toBe("written");
    const clone = w.cloneOf(repo.dir)!;
    expect(clone).toBe(cloneDirFor(writeRoot, repo.dir));
    expect(git(clone, "config", "user.email")).toBe("t@t"); // the shared checkout's identity came along
    // a leftover in the clone (a write cut off by a restart) is dropped before the next write
    fs.writeFileSync(path.join(clone, "a.md"), "junk\n");
    fs.writeFileSync(path.join(clone, "stray.md"), "x\n");
    expect((await edit("a2\n")).status).toBe("written");
    expect(git(repo.bare, "show", "main:a.md")).toBe("a2");
    expect(fs.existsSync(path.join(clone, "stray.md"))).toBe(false);
    expect(fs.readFileSync(path.join(repo.dir, "a.md"), "utf8")).toBe("a2\n"); // the shared checkout followed
    expect(logs.join("\n")).toMatch(/cleaned leftovers/);

    // no origin: no clone can be made, the write goes to the shared checkout as before (and is counted)
    const lone = path.join(root, "lone");
    fs.mkdirSync(lone);
    git(lone, "init", "-q", "-b", "main");
    expect(
      (
        await w.edit({
          repoDir: lone,
          path: "x.md",
          label: "t",
          edit: () => ({ text: "x\n", msg: "m", body: "b" }),
        })
      ).reason,
    ).toMatch(/no origin remote/);
    expect(w.fallbacks().map((f) => f.dir)).toEqual([lone]);
  });

  it("a leftover that only appended lines origin already has (the old path's stranded desk chat copy) is kept as a diff and restored, so the shared checkout follows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-heal-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "team", { "desk/chat/day.md": "# day\n- a\n" }, { cards: false });
    const writeRoot = path.join(root, "_write");
    const w = createCloneWriter(createSpineWriter(), {
      checkTtlMs: 0, // this test changes the clone between writes: the full check before every write
      root: writeRoot,
      log: () => {},
    });
    // the old path appended "- b" in the shared checkout and never committed it (production 2026-11-07 22:29Z)
    fs.appendFileSync(path.join(repo.dir, "desk/chat/day.md"), "- b\n");
    // the clone writes the newer copy (with "- b" and more) to origin
    expect(
      (
        await w.edit({
          repoDir: repo.dir,
          path: "desk/chat/day.md",
          label: "chat",
          edit: () => ({
            text: "# day\n- a\n- b\n- c\n",
            msg: "chat",
            body: "b",
          }),
        })
      ).status,
    ).toBe("written");
    expect(git(repo.dir, "rev-parse", "HEAD")).toBe(git(repo.bare, "rev-parse", "main"));
    expect(fs.readFileSync(path.join(repo.dir, "desk/chat/day.md"), "utf8")).toBe("# day\n- a\n- b\n- c\n");
    expect(w.lagging()).toEqual([]);
    const kept = fs.readdirSync(path.join(writeRoot, "_healed"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(writeRoot, "_healed", kept[0]), "utf8")).toContain("+- b");

    // a line origin does not have is real work: kept, and the shared checkout waits
    fs.appendFileSync(path.join(repo.dir, "desk/chat/day.md"), "- mine\n");
    expect(
      (
        await w.edit({
          repoDir: repo.dir,
          path: "desk/chat/day.md",
          label: "chat",
          edit: () => ({
            text: "# day\n- a\n- b\n- c\n- d\n",
            msg: "chat",
            body: "b",
          }),
        })
      ).status,
    ).toBe("written");
    expect(fs.readFileSync(path.join(repo.dir, "desk/chat/day.md"), "utf8")).toContain("- mine");
    expect(w.lagging().map((l) => l.dir)).toEqual([repo.dir]);
  });

  it("CONSOLE_WRITE_CLONE=off (enabled: false) writes in the shared checkout and makes no clone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-off-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n" }, { cards: false });
    const w = createCloneWriter(createSpineWriter(), {
      checkTtlMs: 0, // this test changes the clone between writes: the full check before every write
      root: path.join(root, "_write"),
      enabled: false,
    });
    expect(
      (
        await w.edit({
          repoDir: repo.dir,
          path: "a.md",
          label: "t",
          edit: () => ({ text: "b\n", msg: "m", body: "b" }),
        })
      ).status,
    ).toBe("written");
    expect(w.cloneOf(repo.dir)).toBeUndefined();
    expect(fs.existsSync(path.join(root, "_write"))).toBe(false);
  });
});

describe("T72-S1 caps (ops PLAN-2-A44)", () => {
  it("borrows the shared checkout's objects, never auto-gcs, leaves evidence out of its tree, and widens for a write there", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-caps-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(
      root,
      "r1",
      {
        "AGENTS.md": "a\n",
        "docs/a.md": "a\n",
        "docs/status/card.md": "card\n",
        "docs/status/assets/shot.png": "x",
        "docs/proposals/p/mock.md": "m\n",
        "research/paper.PDF": "%PDF\n",
        "research/notes.md": "n\n",
      },
      { cards: false },
    );
    const writeRoot = path.join(root, "_write");
    const w = createCloneWriter(createSpineWriter(), { root: writeRoot, log: () => {}, checkTtlMs: 0 });
    const edit = (rel: string, text: string) =>
      w.edit({ repoDir: repo.dir, path: rel, label: "t", edit: () => ({ text, msg: `edit ${rel}`, body: "b" }) });
    expect((await edit("docs/a.md", "a1\n")).status).toBe("written");
    const clone = w.cloneOf(repo.dir)!;
    const alt = fs.readFileSync(path.join(clone, ".git/objects/info/alternates"), "utf8").trim();
    expect(fs.realpathSync(alt)).toBe(fs.realpathSync(path.join(repo.dir, ".git/objects")));
    expect(git(clone, "config", "gc.auto")).toBe("0");
    expect(git(clone, "config", "maintenance.auto")).toBe("false");
    const has = (rel: string) => fs.existsSync(path.join(clone, rel));
    expect(["AGENTS.md", "docs/a.md", "research/notes.md"].every(has)).toBe(true);
    expect(["docs/status/card.md", "docs/status/assets/shot.png", "docs/proposals/p/mock.md", "research/paper.PDF"].some(has)).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");

    // a write to an excluded tracked file and to a new file under an excluded dir: widened, written, pushed
    expect((await edit("docs/status/card.md", "card2\n")).status).toBe("written");
    expect((await edit("docs/proposals/q/new.md", "new\n")).status).toBe("written");
    expect(git(repo.bare, "show", "main:docs/status/card.md")).toBe("card2");
    expect(git(repo.bare, "show", "main:docs/proposals/q/new.md")).toBe("new");
    expect(has("docs/status/assets/shot.png")).toBe(false);
    expect(fs.readFileSync(path.join(repo.dir, "docs/status/card.md"), "utf8")).toBe("card2\n"); // shared followed

    // a clone that lost its borrowed objects is made again
    fs.writeFileSync(path.join(clone, ".git/objects/info/alternates"), path.join(root, "gone") + "\n");
    expect((await edit("docs/a.md", "a2\n")).status).toBe("written");
    expect(git(repo.bare, "show", "main:docs/a.md")).toBe("a2");
    expect(fs.realpathSync(fs.readFileSync(path.join(clone, ".git/objects/info/alternates"), "utf8").trim())).toBe(
      fs.realpathSync(path.join(repo.dir, ".git/objects")),
    );
  });

  it("a clone made before the caps gets them on its next write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s1-old-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n", "docs/status/s.png": "x" }, { cards: false });
    const writeRoot = path.join(root, "_write");
    const dir = cloneDirFor(writeRoot, repo.dir);
    fs.mkdirSync(writeRoot, { recursive: true });
    git(writeRoot, "clone", "-q", repo.bare, dir); // the pre-cap full clone
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    const w = createCloneWriter(createSpineWriter(), { root: writeRoot, log: () => {}, checkTtlMs: 0 });
    expect((await w.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text: "b\n", msg: "m", body: "b" }) })).status).toBe("written");
    expect(git(dir, "config", "gc.auto")).toBe("0");
    expect(fs.existsSync(path.join(dir, "docs/status/s.png"))).toBe(false);
    expect(git(repo.bare, "show", "main:a.md")).toBe("b");
  });

  it("sparseExcluded names the paths the sparse set leaves out", () => {
    expect(sparseExcluded("docs/status/x.md")).toBe(true);
    expect(sparseExcluded("/docs/proposals/a/b.md")).toBe(true);
    expect(sparseExcluded("research/a.Pdf")).toBe(true);
    expect(sparseExcluded("docs/spines/root.md")).toBe(false);
    expect(sparseExcluded("docs/statusboard.md")).toBe(false);
  });
});

describe("a failed origin read is retried before a write falls back", () => {
  it("git failing once on `remote get-url origin` (a busy host after a restart) no longer sends the write to the shared checkout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-origin-retry-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "team", { "a.md": "a\n" }, { cards: false });
    // a git on PATH that fails the first origin read only, as production's did at 04:22Z and 07:24Z on 2026-11-16
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const flag = path.join(root, "failed-once");
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *"remote get-url origin"*) if [ ! -e ${flag} ]; then : > ${flag}; echo "fatal: transient" >&2; exit 128; fi;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    cleanup.push(() => void (process.env.PATH = oldPath));
    const logs: string[] = [];
    const w = createCloneWriter(createSpineWriter(), { checkTtlMs: 0, root: path.join(root, "_write"), log: (m) => logs.push(m), originRetryMs: [10] });
    const r = await w.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text: "a1\n", msg: "edit a", body: "b" }) });
    expect(r.status).toBe("written");
    expect(fs.existsSync(flag)).toBe(true);
    expect(w.fallbacks()).toEqual([]);
    expect(git(repo.bare, "show", "main:a.md")).toBe("a1");
    expect(logs.join("\n")).toMatch(/origin URL read on try 2 \(before: fatal: transient\)/);
  });

  it("an origin that keeps failing falls back with git's own reason, never 'no origin remote'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-origin-fail-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "team", { "a.md": "a\n" }, { cards: false });
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *"remote get-url origin"*) echo "fatal: busy" >&2; exit 128;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    cleanup.push(() => void (process.env.PATH = oldPath));
    const w = createCloneWriter(createSpineWriter(), { checkTtlMs: 0, root: path.join(root, "_write"), log: () => {}, originRetryMs: [5, 5] });
    await w.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text: "a1\n", msg: "edit a", body: "b" }) });
    expect(w.fallbacks().map((f) => f.reason)).toEqual(["the shared checkout's origin URL could not be read after 3 tries: fatal: busy"]);
  });
});
