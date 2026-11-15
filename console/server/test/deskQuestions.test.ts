import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { isOpen } from "../src/auth/routeScope.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";
import { createSteps } from "../src/steps/steps.js";
import { createDeskQuestions, deskQuestionsSection, mountDeskQuestions, OPEN_PER_PAGE, WAKE_RETRY_MS } from "../src/steps/deskQuestions.js";

// a Mac agent asks the Team desk mid-ticket by its ticket page's token, the Delivery manager is woken and
// answers with one call, the agent polls the answer and goes on; the ticket stays open, never marked stuck.

const SPINE = "docs/spines/security.md";

describe("Mac ticket questions to the Team desk", () => {
  let db: DB;
  let clock: number;
  let told: { world: string; text: string; id: string }[];
  let wakes: { mid: string; note: string }[];
  let wakeAnswer: () => { runId: string } | { error: string };
  let repo: string;

  beforeEach(() => {
    db = openDb(":memory:");
    clock = Date.parse("2026-11-12T19:00:00Z");
    told = [];
    wakes = [];
    wakeAnswer = () => ({ runId: `run_${wakes.length}` });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "e907s3-"));
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, SPINE), "# EPIC-907: test\n");
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const setup = (ms: string | null = "ms_sec") => {
    const milestone = ms ?? undefined;
    const steps = createSteps({ db, pump: false, fileDelayMs: 0, writer: {} as SpineWriter, repoDir: () => repo, milestoneFor: async () => milestone });
    const q = createDeskQuestions({
      db,
      byToken: (t) => steps.byToken(t),
      milestoneFor: async () => milestone,
      wake: async (mid, note) => {
        wakes.push({ mid, note });
        return wakeAnswer();
      },
      tell: async (world, text, id) => {
        told.push({ world, text, id });
        return true;
      },
      base: "http://console.test:8750",
      now: () => clock,
    });
    const api = new Hono();
    mountDeskQuestions(api, q);
    const app = new Hono();
    app.route("/api", api);
    const p = steps.register({ title: "Laptop ticket E907-S3: the key swap", url: "http://worker:9196/t/E907-S3/", repo: "team1", spine: SPINE, by: "an agent" });
    const post = (body: unknown, token = p.token) =>
      app.request(`/api/public/steps/${token}/questions`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
    const poll = (id: string, token = p.token) => app.request(`/api/public/steps/${token}/questions/${id}`);
    const answer = (id: string, a: string) => app.request(`/api/steps/questions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: a }) });
    return { app, p, q, post, poll, answer, steps };
  };

  it("asks by the ticket token: a desk line naming ticket and row, the Delivery manager woken with the one answer call", async () => {
    const { post } = setup();
    const r = await post({ question: 'ssh says the host key of host1 changed: is the new "ED25519" key expected?', row: "E907-S3" });
    expect(r.status).toBe(201);
    const b = (await r.json()) as { question: { id: string; state: string; row: string }; poll: string; pollEverySeconds: number; pollForMinutes: number };
    expect(b.question.id).toMatch(/^q_[a-f0-9]{12}$/);
    expect(b.question.state).toBe("open");
    expect(b.question.row).toBe("E907-S3");
    expect(b.pollEverySeconds).toBe(15);
    expect(b.pollForMinutes).toBe(20);
    expect(b.poll).toMatch(new RegExp(`^/api/public/steps/[\\w-]+/questions/${b.question.id}$`));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].mid).toBe("ms_sec");
    expect(wakes[0].note).toContain("ASKS THE TEAM DESK");
    expect(wakes[0].note).toContain(`http://console.test:8750/api/steps/questions/${b.question.id}/answer`);
    expect(wakes[0].note).toContain("row E907-S3");
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain("Laptop ticket E907-S3");
    expect(told[0].text).toContain("(row E907-S3)");
    expect(told[0].text).toContain("the Delivery manager was woken (run run_1)");
    expect(told[0].text).not.toContain('"ED25519"'); // the words stay one line with no double quote inside
  });

  it("the poll reads open, then the answer the persona gave with one call; the ticket's steps are untouched", async () => {
    const { post, poll, answer, steps, p } = setup();
    const { question } = (await (await post({ question: "Which key file do I delete?" })).json()) as { question: { id: string } };
    const open = (await (await poll(question.id)).json()) as { question: { state: string; next: string } };
    expect(open.question.state).toBe("open");
    expect(open.question.next).toContain("poll again in 15 s");
    const a = await answer(question.id, "Delete only ~/.ssh/id_old and keep id_ed25519; then go on with part 3.");
    expect(a.status).toBe(200);
    const got = (await (await poll(question.id)).json()) as { question: { state: string; answer: string; next: string } };
    expect(got.question.state).toBe("answered");
    expect(got.question.answer).toContain("keep id_ed25519");
    expect(got.question.next).toBe("go on with the ticket using this answer");
    expect(told.at(-1)!.text).toMatch(/^✅ Answered q_/);
    // asking never ticks the ticket: no step is stuck or done
    expect(Object.keys((steps.view(p) as { steps: Record<string, unknown> }).steps)).toHaveLength(0);
    // the same answer again is fine, a different one is refused
    expect((await answer(question.id, "Delete only ~/.ssh/id_old and keep id_ed25519; then go on with part 3.")).status).toBe(200);
    expect((await answer(question.id, "something else")).status).toBe(409);
  });

  it("a wake that started no run is tried again by a poll after the retry gap, and the wake prompt lists it", async () => {
    wakeAnswer = () => ({ error: "already running" });
    const { post, poll, q } = setup();
    const { question, woke } = (await (await post({ question: "Is the server's new host key fingerprint SHA256:abc right?", row: "E907-S3" })).json()) as { question: { id: string }; woke: string };
    expect(woke).toContain("the wake is waiting (already running)");
    await poll(question.id);
    expect(wakes).toHaveLength(1); // inside the gap: no second wake
    clock += WAKE_RETRY_MS;
    wakeAnswer = () => ({ runId: "run_late" });
    const r = (await (await poll(question.id)).json()) as { question: { wake: string } };
    expect(wakes).toHaveLength(2);
    expect(r.question.wake).toBe("woken");
    const s = deskQuestionsSection(q.listOpen(["ms_sec"]), "http://console.test:8750", clock)!;
    expect(s).toContain("## Mac ticket questions waiting for an answer (1)");
    expect(s).toContain(question.id);
    expect(s).toContain("row E907-S3");
    expect(s).toContain("asked 3 min ago");
    expect(s).toContain("http://console.test:8750/api/steps/questions/<id>/answer");
    expect(deskQuestionsSection(q.listOpen(["ms_other"]), "x")).toBeUndefined();
  });

  it("refuses a wrong token, another page's question, an empty question, a bad row and a flood", async () => {
    const { post, poll, steps } = setup();
    expect((await post({ question: "hello there" }, "x".repeat(24))).status).toBe(404);
    expect((await post({ question: "" })).status).toBe(400);
    expect((await post({ question: "fine words", row: "not a row" })).status).toBe(400);
    const other = steps.register({ title: "Other ticket", url: "http://worker:9196/t/E908-S1/", repo: "team1", spine: SPINE, by: "an agent" });
    const { question } = (await (await post({ question: "first question" })).json()) as { question: { id: string } };
    expect((await poll(question.id, other.token)).status).toBe(404);
    // a retried POST of the same words answers the same question
    const again = (await (await post({ question: "first question" })).json()) as { question: { id: string } };
    expect(again.question.id).toBe(question.id);
    for (let i = 1; i < OPEN_PER_PAGE; i++) expect((await post({ question: `question ${i}` })).status).toBe(201);
    expect((await post({ question: "one too many" })).status).toBe(429);
  });

  it("no milestone holds the spine: the desk still gets the line, nobody is woken", async () => {
    const { post } = setup(null);
    const r = (await (await post({ question: "Who owns this?" })).json()) as { woke: string };
    expect(wakes).toHaveLength(0);
    expect(r.woke).toContain("nobody to wake");
    expect(told).toHaveLength(1);
  });

  it("the ask and the poll are open by the token; the list and the answer need console auth", () => {
    const t = "a".repeat(24);
    expect(isOpen("POST", `/api/public/steps/${t}/questions`)).toBe(true);
    expect(isOpen("GET", `/api/public/steps/${t}/questions/q_0123456789ab`)).toBe(true);
    expect(isOpen("POST", "/api/steps/questions/q_0123456789ab/answer")).toBe(false);
    expect(isOpen("GET", "/api/steps/questions")).toBe(false);
  });
});

describe("Mac ticket questions through the whole console", () => {
  it("a ticket page asks, the desk line lands, the Delivery Manager's wake lists it, one call answers, the poll reads it", async () => {
    const { createApp } = await import("../src/app.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e907s3-app-"));
    const repo = path.join(tmp, "team");
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/spines/root.md"), "# EPIC-901: team\n\n## Current State\n\nStatus: active\n");
    const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "EPIC-901: seed"]]) execFileSync("git", args, { cwd: repo, env: ENV });
    const db = openDb(path.join(tmp, "c.db"));
    try {
      const t3 = {
        listProjects: async () => [],
        listScheduledTasks: async () => [],
        updateScheduledTask: async () => {},
        deleteScheduledTask: async () => {},
        runScheduledTaskNow: async () => {},
        launchThread: async () => ({ threadId: "thread_1" }),
        sendToThread: async () => {},
        readThreadStatus: async () => ({ status: "idle", raw: {} }),
      };
      const app = createApp(db, {
        read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
        browser: { browserUrl: "http://127.0.0.1:9" },
        cycle: { enabled: true, t3: t3 as any, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as any, publicUrl: "http://console.test" },
      });
      const call = async (method: string, url: string, body?: unknown) => {
        const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : undefined };
      };
      const home = (await call("POST", "/api/milestones", { title: "Team", repo: "team", path: "docs/spines/root.md" })).json;
      const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "sonnet" })).json;
      const a = (await call("POST", "/api/assignments", { milestoneId: home.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
      const page = await call("POST", "/api/steps/pages", { title: "Laptop ticket E901-S1: test", url: "http://127.0.0.1:9/t/E901-S1/", repo: "team", spine: "docs/spines/root.md" });
      expect(page.json).toMatchObject({ token: expect.any(String) });
      const asked = await call("POST", `/api/public/steps/${page.json.token}/questions`, { question: "The page shows a different host key: go on?", row: "E901-S1" });
      expect(asked.status).toBe(201);
      const id = asked.json.question.id as string;
      // the question is open in the team's list; the Delivery Manager's wake carries it with the answer call
      expect((await call("GET", "/api/steps/questions")).json.open.map((q: { id: string }) => q.id)).toEqual([id]);
      const runs = (await call("GET", `/api/runs?assignmentId=${a.id}`)).json;
      const woke = (Array.isArray(runs) ? runs : runs.runs ?? []).find((r: { instructions?: string }) => r.instructions?.includes(id));
      expect(woke).toBeTruthy();
      expect(woke.instructions).toContain("http://console.test/api/steps/questions/");
      const w = await call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
      expect(w.json.prompt).toContain("## Mac ticket questions waiting for an answer (1)");
      expect(w.json.prompt).toContain(id);
      const ans = await call("POST", `/api/steps/questions/${id}/answer`, { answer: "Yes: the server's key was rotated today (E907-S3); accept it and go on." });
      expect(ans.status).toBe(200);
      const polled = await call("GET", `/api/public/steps/${page.json.token}/questions/${id}`);
      expect(polled.json.question).toMatchObject({ state: "answered", answer: expect.stringContaining("accept it and go on") });
      expect((await call("GET", "/api/steps/questions")).json.open).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
