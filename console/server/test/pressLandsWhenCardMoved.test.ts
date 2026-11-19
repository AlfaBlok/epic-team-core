import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { LEFT_REVIEW, type PressWorker } from "../src/press/mount.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * a press of the owner's lands even when its card moved under it. Five of his presses failed in the 24 h to
 * 19 Nov 19:47Z: three Snoozes on cards with no ask line, one Snooze on a review card whose row had left review, one
 * answer on an ask another had replaced three minutes before. One press test per case.
 */
const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
const CONSOLE_LINE = "the console wrote this line";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world(extra: string[] = [], o: { answers?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s23-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s23-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const repo = makeRepo(dir, "home_repo", {
    [SPINE]: spineText("PLAN-0", "home_repo", [{ id: "T73-S1", title: "TEST card one", status: "review", evidence: "[page](https://team.example/audit)" }], extra),
  });
  const live = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  let worker: PressWorker | undefined;
  const app = createApp(db, {
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: live, consoleHosts: [] } },
    presses: { retryMs: [0], onWorker: (w) => (worker = w), answerFirst: true },
    writeClones: { root: writeRoot },
    // as on the server: an answer is saved from the stored view at once, and its job writes it
    ...(o.answers ? { readModel: { mode: "in-process" as const, tickMs: 0 }, answers: { ack: "saved" as const, retryMs: [30, 30] } } : {}),
  });
  const s = createStore(db);
  const m = s.createMilestone({ title: "home_repo", repo: "home_repo", path: SPINE, owner: "Sam", paused: false });
  const p = s.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: true });
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
  /** Wait until press `id` is no longer landing. */
  const landed = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const p = (await req("GET", `/api/presses/${id}`)).json;
      if (p.state !== "landing") return p;
      if (i % 10 === 9) await worker!.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`press ${id} still landing`);
  };
  const items = async () => (await req("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
  const origin = () => git(repo.bare, "show", `main:${SPINE}`);
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  });
  return { db, m, repo, req, landed, items, origin };
}

describe("a press lands even when its card moved under it", () => {
  it("a Snooze on a card with no ask line is kept by the console and hides the card (18 Nov 20:34Z: 3 failed)", async () => {
    const w = world(["Waiting on: Sam to pick the colour of the launch page", ""]);
    const card = (await w.items()).find((i) => i.source === "heuristic" && i.state === "open" && !i.gate);
    expect(card, JSON.stringify(await w.items())).toBeTruthy();
    const head = git(w.repo.bare, "rev-parse", "main");

    const r = await w.req("POST", `/api/waiting-on-owner/${card.id}/snooze`, { days: 3, milestoneId: w.m.id });
    expect(r.status).toBe(202);
    const p = await w.landed(r.pressId!);
    expect(p, JSON.stringify(p)).toMatchObject({ state: "landed", action: "ask snooze" });
    expect(p.response).toMatchObject({ id: card.id, kept: "console" });
    // nothing written to the spine (there is no ask line); the card carries the date, so the inbox hides it until then
    expect(git(w.repo.bare, "rev-parse", "main")).toBe(head);
    expect((await w.items()).find((i) => i.id === card.id)?.snoozedUntil).toBe(p.response.snoozedUntil);

    // Unsnooze puts it back
    const u = await w.req("POST", `/api/waiting-on-owner/${card.id}/snooze`, { until: null, milestoneId: w.m.id });
    expect((await w.landed(u.pressId!)).state).toBe("landed");
    expect((await w.items()).find((i) => i.id === card.id)?.snoozedUntil).toBeUndefined();
  });

  it("a Snooze on a card whose row left review lands and says so, never a failed press (18 Nov 20:47Z)", async () => {
    const w = world();
    await w.req("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    const [one] = (await w.req("GET", "/api/review-items")).json as { id: string; ref: string }[];
    // the row leaves review in the repo before his press is written
    w.repo.setRow(SPINE, one.ref, "done (no confirm: shipped)");
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(one.id)}/snooze`, { hours: 3 });
    expect(r.status).toBe(202);
    const p = await w.landed(r.pressId!);
    expect(p, JSON.stringify(p)).toMatchObject({ state: "landed", action: "review snooze" });
    expect(p.response).toMatchObject({ moot: true, message: LEFT_REVIEW });
    expect(p.reason).toContain(LEFT_REVIEW);
    expect((await w.req("GET", "/api/write-health")).json.failed24h).toBe(0);
  });

  it("an answer on an ask that was replaced lands on the ask that replaced it; the replaced line names it (19 Nov 15:37Z)", async () => {
    const A3 = `- [ask T9-A3: decide @Sam since 2026-10-22 row T73-S1] Put the 16 stuck posts back in the plan? — context: ${CONSOLE_LINE} from the posts page — recommend: Yes — options: Yes | No — unblocks: T73-S1`;
    const A4 = `- [ask T9-A4: decide @Sam since 2026-10-22 row T73-S1] Put the 17 stuck posts back in the plan? — context: ${CONSOLE_LINE} from the posts page — recommend: Yes — options: Yes | No — unblocks: T73-S1`;
    const w = world(["Waiting on: Sam: T9-A3; Sam: T9-A4", "", "## Waiting on", "", A3, A4, ""], { answers: true });
    const old = (await w.items()).find((i) => i.code === "T9-A3");
    expect(old).toBeTruthy();
    // the card he is looking at is replaced: the console takes T9-A3 out, naming T9-A4
    const ret = await w.req("POST", "/api/needs-owner/retire", { milestoneId: w.m.id, path: SPINE, code: "T9-A3", why: "replaced by T9-A4, which names every post still stuck" });
    expect(ret.status, JSON.stringify(ret.json)).toBe(200);
    expect(w.origin()).toMatch(/^- \[superseded T9-A3 \d{4}-\d{2}-\d{2} by T9-A4\] Put the 16 stuck posts/m);

    // his answer, pressed on the old card a moment later
    const r = await w.req("POST", `/api/waiting-on-owner/${old.id}/respond`, { kind: "answer", text: "Yes, go", milestoneId: w.m.id, wake: false });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    const p = await w.landed(r.pressId!);
    expect(p, JSON.stringify(p)).toMatchObject({ state: "landed" });
    const text = w.origin();
    expect(text).toMatch(/^- \[answered T9-A4 \d{4}-\d{2}-\d{2} @Sam\] Put the 17 stuck posts.* — answer: Yes, go$/m);
    expect(text).toMatch(/^- \[superseded T9-A3 /m);
    expect(git(w.repo.bare, "log", "-1", "--format=%s", "main")).toContain("his answer to T9-A3, which T9-A4 replaced");
  });
});
