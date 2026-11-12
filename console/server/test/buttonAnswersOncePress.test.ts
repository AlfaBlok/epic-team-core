import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createSpineWriter, PUSH_RACE_TRIES } from "../src/inbox/spineWrite.js";
import { createPresses } from "../src/press/presses.js";
import type { PressWorker } from "../src/press/mount.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * every review button answers once its press is saved (202, well under 1 s) and the git write
 * runs in the press worker; a repeat press returns the saved press, never a 409; presses on one card land in the order
 * pressed; push races are retried inside the writer. Root cause: docs/status/e72-s3-root-cause.md (22 of 56 presses took
 * over 30 s on the server, max 111 s, because every button waited for fetch, commit and push inside the request).
 */
const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s3-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s3-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const rows = [
    { id: "T73-S1", title: "TEST card one" },
    { id: "T73-S2", title: "TEST card two" },
  ];
  const repo = makeRepo(dir, "home_repo", {
    [SPINE]: spineText(
      "PLAN-0",
      "home_repo",
      rows.map((r) => ({ ...r, status: "review", evidence: "[page](https://team.example/audit)" })),
    ),
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
    const t0 = Date.now();
    const res = await app.request(
      url,
      {
        method,
        headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    const ms = Date.now() - t0;
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, ms, pressId: res.headers.get("x-press-id"), repeat: res.headers.get("x-press-repeat") === "1" };
  };
  const cards = async () => {
    await req("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    return (await req("GET", "/api/review-items")).json as { id: string; ref: string }[];
  };
  const originRow = (id: string) =>
    git(repo.bare, "show", `main:${SPINE}`)
      .split("\n")
      .find((l) => l.startsWith(`| ${id} |`));
  /** Wait until press `id` is no longer landing (the worker runs at once; a test tick helps it along). */
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
  return { dir, db, req, cards, repo, originRow, landed, worker: () => worker! };
}

describe("T72-S3 a button answers once its press is saved; the worker writes it", () => {
  it("approve answers 202 'landing' at once, before any git write; the worker lands it and the press says so", async () => {
    const w = world();
    const [one] = await w.cards();
    const head = git(w.repo.bare, "rev-parse", "main");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`);
    expect(r.status).toBe(202);
    expect(r.json.press).toMatchObject({ state: "landing", message: "Saved, landing…" });
    expect(r.pressId).toBe(r.json.press.id);
    expect(r.ms).toBeLessThan(1_000);
    // nothing was written in the request: origin is where it was when the answer came
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);

    const p = await w.landed(r.pressId!);
    expect(p).toMatchObject({ state: "landed", action: "review approve", target: one.id });
    expect(p.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(p.response.state).toBe("approved");
    // the reply is the press's first try line: 202, in ms
    expect(p.tries[0]).toMatchObject({ status: 202, reason: "saved; the worker writes it" });
    expect(p.tries[0].ms).toBeLessThan(1_000);
    expect(w.originRow(one.ref)).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
    expect((await w.req("GET", "/api/health")).json.presses).toMatchObject({ today: 1, landing: 0, busy: 0, answerFirst: true });
  });

  it("T72-S10: the write's try keeps its steps (lock wait, fetch, commit, push, the whole write), so the log says where the seconds went", async () => {
    const w = world();
    const [one] = await w.cards();
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/complete`, {});
    expect(r.status).toBe(202);
    const p = await w.landed(r.pressId!);
    expect(p.state).toBe("landed");
    const wrote = [...p.tries].reverse().find((t: { steps?: Record<string, number> }) => t.steps);
    expect(wrote, JSON.stringify(p.tries)).toBeTruthy();
    expect(Object.keys(wrote.steps)).toEqual(expect.arrayContaining(["lock", "commit", "push", "write"]));
    for (const v of Object.values(wrote.steps)) expect(v).toBeGreaterThanOrEqual(0);
    expect(wrote.steps.write).toBeGreaterThanOrEqual(wrote.steps.push);
  });

  it("pressing again returns the saved press while it lands; after it landed a repeat takes that landing, never a 409, never a second write", async () => {
    const w = world();
    const [one] = await w.cards();
    const url = `/api/review-items/${encodeURIComponent(one.id)}/approve`;
    const a = await w.req("POST", url);
    // a second press while the first is landing: the same press
    const b = await w.req("POST", url);
    expect(b.status).toBe(202);
    expect(b.pressId).toBe(a.pressId);
    expect(b.repeat).toBe(true);
    const first = await w.landed(a.pressId!);
    // after it landed (the page had timed out, the owner presses again): a new press, answered at once; the route finds the
    // row done and refuses, and the press takes the first one's landing instead of "not in review any more"
    const c = await w.req("POST", url);
    expect(c.status).toBe(202);
    expect(c.pressId).not.toBe(a.pressId);
    const again = await w.landed(c.pressId!);
    expect(again).toMatchObject({ state: "landed", sha: first.sha });
    expect(again.reason).toContain(a.pressId);
    expect(again.response.state).toBe("approved");
    const log = git(w.repo.bare, "log", "--format=%s", "main");
    expect(log.split("\n").filter((l) => l.includes(`Review ${one.ref}`))).toHaveLength(1);
    expect((await w.req("GET", "/api/write-health")).json.today).toMatchObject({ presses: 2, failed: 0 });
  });

  it("a card back in review after its press landed is written again by the next press (not the old landing)", async () => {
    const w = world();
    const [one] = await w.cards();
    const url = `/api/review-items/${encodeURIComponent(one.id)}/snooze`;
    const a = await w.req("POST", url, { hours: 3 });
    expect((await w.landed(a.pressId!)).state).toBe("landed");
    // an agent puts the card back (unsnoozed, in review) in the repo, as the daily press test re-arms its TEST rows
    git(w.repo.dir, "pull", "-q", "--ff-only", "origin", "main");
    w.repo.setRow(SPINE, one.ref, "review", "[page](https://team.example/audit)");
    await w.cards();
    const b = await w.req("POST", url, { hours: 3 });
    expect(b.status).toBe(202);
    const p = await w.landed(b.pressId!);
    expect(p.state).toBe("landed");
    expect(p.sha).not.toBe((await w.req("GET", `/api/presses/${a.pressId}`)).json.sha);
    expect(git(w.repo.bare, "log", "--format=%s", "main").split("\n").filter((l) => l.includes("snoozed until"))).toHaveLength(2);
  });

  it("presses on one card land in the order pressed (Snooze, Unsnooze, Snooze again: three presses, snoozed at the end)", async () => {
    const w = world();
    const [one] = await w.cards();
    const url = `/api/review-items/${encodeURIComponent(one.id)}/snooze`;
    const a = await w.req("POST", url, { hours: 3 });
    const b = await w.req("POST", url, { until: null });
    const c = await w.req("POST", url, { hours: 3 });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(202);
      expect(r.ms).toBeLessThan(1_000);
    }
    expect(new Set([a.pressId, b.pressId, c.pressId]).size).toBe(3);
    for (const r of [a, b, c]) expect((await w.landed(r.pressId!)).state).toBe("landed");
    const log = git(w.repo.bare, "log", "--format=%s", "main").split("\n").filter((l) => l.includes(one.ref));
    expect(log[0]).toMatch(/snoozed until/);
    expect(log[1]).toMatch(/unsnoozed/);
    expect(log[2]).toMatch(/snoozed until/);
    expect(w.originRow(one.ref)).toMatch(/snoozed until/);
  });

  it("a press the route refuses later is answered 202 first, then shows failed with the reason (the card's Not landed)", async () => {
    const w = world();
    await w.cards();
    const r = await w.req("POST", "/api/review-items/rv_nope/approve");
    expect(r.status).toBe(202);
    const p = await w.landed(r.pressId!);
    expect(p).toMatchObject({ state: "failed", httpStatus: 404 });
    expect(p.reason).toMatch(/no row in review/);
    expect(await w.worker().tick()).toBe(0);
  });

  it("presses on two cards both land; a deploy's drain waits for the one being written", async () => {
    const w = world();
    const list = await w.cards();
    const rs = await Promise.all(list.map((c) => w.req("POST", `/api/review-items/${encodeURIComponent(c.id)}/approve`)));
    for (const r of rs) expect(r.status).toBe(202);
    expect(await w.worker().drain(30_000)).toBe(true);
    for (const r of rs) expect((await w.landed(r.pressId!)).state).toBe("landed");
    for (const c of list) expect(w.originRow(c.ref)).toMatch(/\| done \(approved by Sam/);
    expect(w.worker().busy()).toEqual({ inFlight: 0, due: 0 });
  });

  it("a press saved before a restart is written after it (the 202 was already sent)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s3-db-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, "console.db"));
    const presses = createPresses(db);
    const id = presses.open({ action: "review approve", target: "rv_x", who: "Sam", route: "/review-items/rv_x/approve", request: { method: "POST", path: "/api/review-items/rv_x/approve" }, due: true });
    expect(presses.due().map((d) => d.id)).toEqual([id]);
    // a repeat of it is that press, by card, route and body (no key needed)
    expect(presses.repeatOf("rv_x", "/review-items/rv_x/approve", "")?.id).toBe(id);
    expect(presses.repeatOf("rv_x", "/review-items/rv_x/deny", "")).toBeUndefined();
    db.close();
  });
});

describe("T72-S3 the writer", () => {
  it(`a push refused because origin moved on is rebased and pushed again, up to ${PUSH_RACE_TRIES} times`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s3-race-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const repo = makeRepo(dir, "race", { "a.md": "a0\n", "b.md": "b0\n" });
    // another writer: a side clone that pushes to b.md just before each of our first three pushes
    const side = path.join(dir, "side");
    execFileSync("git", ["clone", "-q", repo.bare, side]);
    git(side, "config", "user.email", "s@s");
    git(side, "config", "user.name", "side");
    const count = path.join(dir, "count");
    fs.writeFileSync(count, "0");
    const hook = path.join(repo.dir, ".git", "hooks", "pre-push");
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\nn=$(cat ${count})\nif [ "$n" -lt 3 ]; then\n  echo $((n+1)) > ${count}\n  cd ${side} && git pull -q --rebase origin main && echo "b$n" >> b.md && git commit -qam "side $n" && git push -q origin HEAD:main\nfi\nexit 0\n`,
    );
    fs.chmodSync(hook, 0o755);
    const w = createSpineWriter();
    const r = await w.edit({ repoDir: repo.dir, path: "a.md", label: "a", edit: () => ({ text: "a1\n", msg: "a: one", body: "test" }) });
    expect(r.status, r.reason).toBe("written");
    expect(fs.readFileSync(count, "utf8").trim()).toBe("3");
    expect(git(repo.bare, "show", "main:a.md")).toBe("a1");
    expect(git(repo.bare, "show", "main:b.md")).toContain("b2");
  });
});
