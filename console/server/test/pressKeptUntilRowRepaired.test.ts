import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { KEPT_MESSAGE, type PressWorker } from "../src/press/mount.js";
import { createPresses, judge } from "../src/press/presses.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * a row the console can read two ways (cells out of line with its header, not the one stray empty cell
 * the console mends) never loses his press and never leaves it waiting on the 15-minute repair timer. The press is kept
 * in the outbox (the card says so), the row's owner is woken the same minute, and the press lands by itself on the
 * next try after the row is repaired.
 */
const SPINE = "docs/spines/root.md";
const cadence = { type: "interval" as const, everyMinutes: 60 };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

class FakeT3 {
  sent: string[] = [];
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/nowhere/home_repo" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(i: { prompt?: string }) {
    this.sent.push(String(i?.prompt ?? ""));
    return { threadId: "thread_1" };
  }
  async sendToThread(_t: string, text: string) {
    this.sent.push(String(text ?? ""));
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s209-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s209-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const repo = makeRepo(dir, "home_repo", {
    [SPINE]: spineText("PLAN-0", "home_repo", [{ id: "T73-S1", title: "TEST card one", status: "review", evidence: "[page](https://team.example/audit)" }]),
  });
  const live = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const t3 = new FakeT3();
  let worker: PressWorker | undefined;
  const app = createApp(db, {
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: live, consoleHosts: [] } },
    presses: { retryMs: [0], heldRetryMs: 0, onWorker: (w) => (worker = w), answerFirst: true },
    writeClones: { root: writeRoot },
    cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
  });
  const s = createStore(db);
  const m = s.createMilestone({ title: "home_repo", repo: "home_repo", path: SPINE, owner: "Sam", paused: false });
  const p = s.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  const a = s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: true });
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(
      url,
      { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) },
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
  /** Wait until press `id` satisfies `ok`, ticking the outbox worker as the timer would. */
  const until = async (id: string, ok: (p: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const p = (await req("GET", `/api/presses/${id}`)).json;
      if (ok(p)) return p;
      if (i % 4 === 3) await worker!.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`press ${id} never got there: ${JSON.stringify((await req("GET", `/api/presses/${id}`)).json)}`);
  };
  /** the owner's wakes: the runs the console started for the Delivery manager with instructions. */
  const wakes = () =>
    (db.prepare("SELECT * FROM runs WHERE assignment_id = ?").all(a.id) as Record<string, unknown>[]).map((r) => JSON.stringify(r)).filter((r) => r.includes("Row flag"));
  /** Rewrite T73-S1's line on origin (as a hand edit pushed by someone else). */
  const editRow = (f: (cells: string[]) => string[]) => {
    const lines = repo.read(SPINE).split("\n");
    const i = lines.findIndex((l) => l.startsWith("| T73-S1 |"));
    lines[i] = f(lines[i].split(" | ")).join(" | ");
    fs.writeFileSync(path.join(repo.dir, SPINE), lines.join("\n"));
    git(repo.dir, "commit", "-q", "-am", "T73-S1 hand edit");
    git(repo.dir, "push", "-q", "origin", "main");
  };
  const origin = () => git(repo.bare, "show", `main:${SPINE}`);
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  });
  return { db, m, repo, req, until, wakes, editRow, origin, t3 };
}

describe("a press on a row read two ways is kept, its owner told, and it lands after the repair", () => {
  it("judge keeps a press the route refused for a row out of its columns; any other 409 is still refused", () => {
    expect(judge(409, { error: { code: "spine_write_skipped", message: "not written: row E907-S2 has 13 cells but its header has 11; nothing written until it is repaired (scripts/ledger_rows.py repair)" } })).toMatchObject({ kind: "held" });
    expect(judge(409, { error: { code: "spine_write_skipped", message: "not written: row E907-S2 is not in review any more" } })).toMatchObject({ kind: "refused" });
  });

  it("a kept press is tried every minute, never failed at the normal 48 h, and lands on the try after the repair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s209-unit-"));
    const db = openDb(path.join(dir, "console.db"));
    cleanup.push(() => (db.close(), fs.rmSync(dir, { recursive: true, force: true })));
    let t = Date.parse("2026-11-25T10:00:00Z");
    const p = createPresses(db, { now: () => t });
    const id = p.open({ action: "review approve", target: "rv_1", who: "Sam", route: "/review-items/rv_1/approve", request: { method: "POST", path: "/api/review-items/rv_1/approve" }, due: true });
    const why = "not written: row T73-S1 has 13 cells but its header has 11; nothing written until it is repaired";
    let s = p.settle(id, { verdict: { kind: "held", reason: why }, status: 409, ms: 5, retry: true });
    expect(s).toMatchObject({ state: "landing", held: why, heldAt: "2026-11-25T10:00:00.000Z", nextAt: "2026-11-25T10:01:00.000Z" });
    // two days later the row is still broken: still kept (a normal press would have failed at 48 h)
    t += 50 * 3600_000;
    s = p.settle(id, { verdict: { kind: "held", reason: why }, status: 409, ms: 5, retry: true });
    expect(s.state).toBe("landing");
    expect(Date.parse(s.nextAt!) - t).toBe(5 * 60_000);
    // repaired: the next try lands, and the press says it was kept
    t += 60_000;
    s = p.settle(id, { verdict: { kind: "landed", sha: "abc1234" }, status: 200, ms: 5, retry: true });
    expect(s).toMatchObject({ state: "landed", sha: "abc1234", held: why });
  });

  it("an ambiguous row: his press is kept at once, the owner is woken the same minute, and it lands right after the repair with no timer", async () => {
    const w = world();
    await w.req("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    const [one] = (await w.req("GET", "/api/review-items")).json as { id: string; ref: string }[];
    expect(one?.ref).toBe("T73-S1");
    const whole = w.origin().split("\n").find((l) => l.startsWith("| T73-S1 |"))!;
    // two extra cells with words in them: no one way to read the row, so the console may not guess
    w.editRow((c) => [...c.slice(0, 6), "a stray claim", "a second stray", ...c.slice(6)]);

    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`);
    expect(r.status).toBe(202);
    const kept = await w.until(r.pressId!, (p) => !!p.held);
    expect(kept, JSON.stringify(kept)).toMatchObject({ state: "landing", action: "review approve" });
    expect(kept.held).toMatch(/row T73-S1 has \d+ cells but its header has \d+/);
    // nothing written yet, nothing failed
    expect(w.origin()).not.toMatch(/done \(approved by/);
    expect((await w.req("GET", "/api/write-health")).json.failed24h).toBe(0);

    // the row's owner was flagged the same minute (its Delivery manager woken with the row and the repair step)
    for (let i = 0; i < 100 && !w.wakes().length; i++) await new Promise((res) => setTimeout(res, 20));
    const wake = w.wakes();
    expect(wake.length).toBe(1);
    expect(wake[0]).toContain("T73-S1");
    expect(wake[0]).toContain("ledger_rows.py repair");

    // a repeat press while it is kept gets the same press back, with the card's kept line
    const again = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/approve`);
    expect(again.status).toBe(202);
    expect(again.json.press).toMatchObject({ id: r.pressId, message: KEPT_MESSAGE });

    // the owner repairs the row; the kept press lands on its next try, with no repair timer involved
    w.editRow(() => whole.split(" | "));
    const done = await w.until(r.pressId!, (p) => p.state !== "landing");
    expect(done, JSON.stringify(done)).toMatchObject({ state: "landed", result: "retried" });
    const line = w.origin().split("\n").find((l) => l.startsWith("| T73-S1 |"))!;
    expect(line).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
    expect(line.split(" | ").length).toBe(whole.split(" | ").length);
    // one wake for the row, not one per try
    expect(w.wakes().length).toBe(1);
  });
});
