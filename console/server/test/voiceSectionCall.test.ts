import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { focusGreeting, focusPack, pressStep, type InboxCard } from "../src/voice/inbox.js";
import { planOf, strategistLines, worldCallContext } from "../src/voice/worldContext.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// a phone button on an inbox section starts the call holding that section's cards, and presses his own
// button only after his spoken yes. a social world's call starts knowing its campaigns, key results and briefing.

const goal: InboxCard = { kind: "goal", id: "tc_1", title: "Set the testers goal", question: "How many testers by Friday? Options: 1) 5 testers; 2) 10 testers", buttons: ["5 testers", "10 testers", "Answer in words…"] };
const review: InboxCard = { kind: "review", id: "ri_1", code: "E901-S2", title: "The voice call was made.", buttons: ["Mark complete", "Changes wanted…"] };
const ask: InboxCard = { kind: "ask", id: "a_1", code: "E901-A3", title: "Which plan?", buttons: [] };

describe("a section call", () => {
  it("its pack names the section, its cards one by one, and the yes rule; its greeting offers to start", () => {
    const p = focusPack({ section: "Goals to set", cards: [goal, review, ask] }, "1. Acme: 5 testers");
    expect(p).toMatch(/one part of Sam's inbox: Goals to set \(3 cards\)/);
    expect(p).toMatch(/1\. Goal to set: Set the testers goal/);
    expect(p).toMatch(/2\. Review \[E901-S2\]/);
    expect(p).toMatch(/3\. Question \[E901-A3\]/);
    expect(p).toMatch(/only after his spoken yes/);
    expect(p).toMatch(/it's on your screen/);
    expect(p).toMatch(/Ask him which he wants[\s\S]*Do not read its choices aloud|Do not read its choices aloud[\s\S]*Ask him which he wants/);
    expect(p).toMatch(/goes to the desk with ask_the_desk/);
    expect(p).toMatch(/Acme: 5 testers/);
    expect(focusGreeting({ section: "Goals to set", cards: [goal] })).toBe("Goals to set: 1 card. Shall we go through them one by one?");
  });
  it("press_card presses only his listed button, only on his yes, with his words where the button takes them", () => {
    const cards = [goal, review, ask];
    expect(pressStep(cards, 1, { button: "5 testers" }).press).toBeUndefined();
    expect(pressStep(cards, 1, { button: "5 testers", confirmed: true }).press).toMatchObject({ id: "tc_1", kind: "goal", button: "5 testers" });
    expect(pressStep(cards, 1, { button: "Delete it", confirmed: true }).note).toMatch(/not one of his buttons/);
    expect(pressStep(cards, 2, { button: "Changes wanted", confirmed: true }).note).toMatch(/needs his words/);
    expect(pressStep(cards, 2, { button: "changes wanted", words: "make it louder", confirmed: true }).press).toMatchObject({ button: "Changes wanted…", words: "make it louder" });
    expect(pressStep(cards, 2, { number: 3, button: "Yes", confirmed: true }).note).toMatch(/to the desk/);
    expect(pressStep(cards, 0, { button: "Mark complete", confirmed: true }).note).toMatch(/No card is open/);
  });
});

describe("a social world's call's context", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "e42s126-"));
    fs.mkdirSync(path.join(dir, "desk/inbox"), { recursive: true });
    fs.mkdirSync(path.join(dir, "docs/campaigns/c-1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "desk/inbox/2026-11-16-hq-daily-briefing.md"), "---\nfrom: hq\n---\n## New today\n\n- Old one\n");
    fs.writeFileSync(path.join(dir, "desk/inbox/2026-11-17-hq-daily-briefing.md"), "---\nfrom: hq\n---\n## New today worth showing\n\n- **Brief me by voice.** in review\n");
    fs.writeFileSync(path.join(dir, "docs/campaigns/c-1/strategist-daily.md"), "# Strategist's daily take, Acme testers\n\n| Date | 🟢 Worked | 🔴 Did not | ➡ Next try |\n|---|---|---|---|\n| 2026-11-17 | old | old | old |\n| 2026-11-18 | Shorts and Reddit | X drew 27 views | finish the 40 posts |\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spine = "# EPIC-906: Acme testers\n\n## Plan\n\nTen testers from people with the exact pain.\n\n### Goal and numbers\n\n| Step | Today | Goal |\n|---|---|---|\n| Testers | 1 | 10 |\n\n### Who\n\nPeople.\n\n## Issue Ledger\n";
  it("reads each campaign's plan line and key results, the newest briefing and the Strategist's newest line", () => {
    expect(planOf(spine)).toEqual({ line: "Ten testers from people with the exact pain.", numbers: "| Step | Today | Goal |\n| Testers | 1 | 10 |" });
    expect(strategistLines(dir)[0]).toMatch(/2026-11-18: Worked: Shorts and Reddit \| Did not: X drew 27 views \| Next try: finish the 40 posts/);
    const c = worldCallContext({ world: "Acme Social", campaigns: [{ title: "Acme testers", spine, briefing: { day: "2026-11-17", text: "Today: Brief me by voice" } }, { title: "Day in the life", briefing: { day: "2026-11-17", text: "Today: Brief me by voice" } }], repoDir: dir });
    expect(c).toMatch(/telephony helper for this workspace's campaigns/);
    expect(c).toMatch(/1\. Acme testers: Ten testers/);
    expect(c).toMatch(/Testers \| 1 \| 10/);
    expect(c).toMatch(/2\. Day in the life\nKey results: not written in its plan yet/);
    expect(c).toMatch(/Acme testers, Day in the life, 2026-11-17 \(the morning briefing he received\):\nToday: Brief me by voice/);
    expect(c.match(/Brief me by voice/g)).toHaveLength(1);
    expect(worldCallContext({ world: "x", campaigns: [{ title: "A" }] })).toMatch(/No daily briefing is kept/);
  });
});

let tmp: string;
let db: DB;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

describe("a section call through the API", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s124-"));
    const dir = path.join(tmp, "repo1");
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/spines/root.md"), "# EPIC-9901: Spine\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| T1 | Thing | ready |\n");
    git(tmp, "init", "-q", "-b", "main", dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
    db = openDb(path.join(tmp, "console.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it("POST /api/voice/calls {focus} starts with that section's cards and press_card; the tool hands back the press", async () => {
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const minted: any[] = [];
    const mint = async (b: unknown) => (minted.push(b), { value: "ek_test", expires_at: Math.floor(Date.now() / 1000) + 60, session: { id: "sess_1" } });
    const app = createApp(db, { read: readCfg, review: { live: { fetch: ok, consoleHosts: [] } }, voice: { mint } });
    const call = async (method: string, url: string, body?: unknown) => {
      const headers: Record<string, string> = { "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
      const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    expect((await call("POST", "/api/voice/calls", { focus: { section: "x", cards: [{ kind: "nope", id: "1", title: "t" }] } })).status).toBe(400);
    const started = await call("POST", "/api/voice/calls", { focus: { section: "Goals to set", cards: [goal, review] } });
    expect(started.status).toBe(201);
    expect(started.json.greeting).toBe("Goals to set: 2 cards. Shall we go through them one by one?");
    const sess = minted[0].session;
    expect(sess.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["next_card", "read_card", "press_card", "ask_the_desk"]));
    expect(sess.instructions).toMatch(/Goals to set \(2 cards\)/);
    expect(sess.instructions).not.toMatch(/His inbox now/);
    const id = started.json.call.id;
    expect((await call("POST", `/api/voice/calls/${id}/tool`, { name: "next_card" })).json).toMatchObject({ place: "card 1 of 2", id: "tc_1" });
    const pressed = await call("POST", `/api/voice/calls/${id}/tool`, { name: "press_card", args: { button: "10 testers", confirmed: true } });
    expect(pressed.json.press).toMatchObject({ id: "tc_1", kind: "goal", button: "10 testers" });
    // a plain call (his whole inbox) presses too
    await call("POST", `/api/voice/calls/${id}/end`, { reason: "hangup" });
    expect((await call("POST", "/api/voice/calls")).status).toBe(201);
    expect(minted[1].session.tools.map((t: { name: string }) => t.name)).toContain("press_card");
  });
});
