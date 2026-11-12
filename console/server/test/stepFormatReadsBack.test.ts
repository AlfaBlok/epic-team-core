import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth/identity.js";
import { openDb, type DB } from "../src/db.js";
import { parseAsks } from "../src/inbox/asks.js";
import { flipAskLine } from "../src/inbox/spineWrite.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import { board, dueEscalations, goalsOf, inboxFor, readWorld } from "../src/people/inbox.js";
import { answerLine, approveLine, escalateLine, sendBackLine } from "../src/people/lines.js";
import { areaCovers, find, parsePeople } from "../src/people/roster.js";
import { createStore } from "../src/store.js";

/**
 * many humans. A TEST world: the owner the owner, a TEST expert and
 * a TEST analyst; an ask routed to the analyst, escalated by Not sure, answered by the expert with approval, the owner
 * made aware; each TEST human signs in and sees only their own cards and goals.
 */

const PEOPLE = `## People

- @Sam : owner · area: all · alerts: WhatsApp, daily summary 08:00 Mexico City
- @TEST-Marta : expert · area: EPIC-991, tax filings · alerts: email, browser 09:00 to 18:00 Madrid
- @TEST-Leo : analyst · area: books · escalates to: @TEST-Marta after 24 h · alerts: browser
- @TEST-Sofia : made aware · area: tax filings · alerts: weekly email
`;
const ROOT = `# home_repo (TEST)\n\nProject name: TEST\n\n## Current State\n\nStatus: active\n\n${PEOPLE}\n## Waiting on\n\n- nobody\n`;
const A1 = "- [ask E991-A1: decide @TEST-Leo approve by @TEST-Marta aware @Sam since 2026-11-09 row E991-S1] Is the TEST car lease a business cost? — context: twelve TEST payments of 410 euros, no mileage log — options: A) yes | B) no | C) part — recommend: C — unblocks: E991-S1";
const A2 = "- [ask E991-A2: provide @TEST-Leo since 2026-11-01 row E991-S2] Give the TEST supplier names of two receipts. — context: two TEST receipts without a supplier — unblocks: E991-S2";
const A3 = "- [ask E991-A3: decide @Sam since 2026-11-09] May the TEST world keep its books in euros? — context: TEST — options: A) yes | B) no — recommend: A — unblocks: E991-S3";
const A4 = "- [ask E991-A4: decide @Nobody since 2026-11-09] A TEST ask naming someone off the list? — unblocks: none";
const EPIC = (...asks: string[]) =>
  `# EPIC-991: TEST books for the car lease\n\n## Current State\n\nStatus: active\nWaiting on: TEST-Leo: E991-A1, E991-A2; Sam: E991-A3\n\n## Waiting on\n\n${asks.join("\n")}\n`;
const OTHER = "# EPIC-992: TEST social posts\n\n## Current State\n\nStatus: active\n\n## Waiting on\n\n- nobody\n";

describe("E990-S3 step 1: the format reads back right", () => {
  it("the People list: four roles, areas, escalation with its time limit, alerts", () => {
    const r = parsePeople(ROOT);
    expect(r.problems).toEqual([]);
    expect(r.people.map((p) => [p.handle, p.role])).toEqual([
      ["Sam", "owner"],
      ["TEST-Marta", "expert"],
      ["TEST-Leo", "analyst"],
      ["TEST-Sofia", "aware"],
    ]);
    expect(find(r, "@test-leo")).toMatchObject({ escalatesTo: "TEST-Marta", escalateAfterHours: 24, area: ["books"], alerts: "browser" });
    expect(find(r, "Sam")!.area).toEqual(["all"]);
  });

  it("a People list it cannot read says the form, an unknown escalation and a missing owner are named", () => {
    const r = parsePeople("## People\n\n- Leo is the analyst\n- @Leo : boss\n- @Ana : analyst · escalates to: @Ghost after 2 d\n");
    expect(r.problems.join("\n")).toMatch(/not a form the tools read/);
    expect(r.problems.join("\n")).toMatch(/role 'boss'/);
    expect(r.problems.join("\n")).toMatch(/@Ghost, who is not on the People list/);
    expect(r.problems.join("\n")).toMatch(/names no owner/);
    expect(find(r, "Ana")!.escalateAfterHours).toBe(48);
    expect(parsePeople("# x\n\n## Current State\n").people).toEqual([]);
  });

  it("an ask names who acts, who approves and who is made aware; answered, awaiting and approved read back", () => {
    const open = parseAsks(EPIC(A1))[0];
    expect(open).toMatchObject({ code: "E991-A1", who: "TEST-Leo", approveBy: "TEST-Marta", aware: ["Sam"], since: "2026-11-09", row: "E991-S1", state: "open" });
    const awaiting = parseAsks(EPIC("- [answered E991-A1 2026-11-10 @TEST-Leo · awaits @TEST-Marta · aware @Sam] Is it? — answer: C"))[0];
    expect(awaiting).toMatchObject({ who: "TEST-Leo", awaits: "TEST-Marta", aware: ["Sam"], state: "answered", answer: "C" });
    expect(awaiting.doneAt).toBeUndefined();
    const ok = parseAsks(EPIC("- [answered E991-A1 2026-11-10 @TEST-Leo · approved @TEST-Marta 2026-11-11 · aware @Sam, @TEST-Sofia] Is it? — answer: C"))[0];
    expect(ok).toMatchObject({ approvedBy: "TEST-Marta", approvedAt: "2026-11-11", aware: ["Sam", "TEST-Sofia"] });
    expect(ok.awaits).toBeUndefined();
    const esc = parseAsks(EPIC("- [ask E991-A1: decide @TEST-Marta aware @Sam escalated by @TEST-Leo since 2026-11-10] Is it? — escalated: @TEST-Leo: depends on the days"))[0];
    expect(esc).toMatchObject({ who: "TEST-Marta", escalatedBy: "TEST-Leo", escalatedNote: "@TEST-Leo: depends on the days", question: "Is it?" });
  });

  it("the owner's own answer keeps the approver waiting and who is made aware", () => {
    const line = "- [ask E991-A5: decide @Sam approve by @TEST-Marta aware @TEST-Sofia since 2026-11-09] TEST? — unblocks: x";
    expect(flipAskLine(line, "yes", "2026-11-10", "Sam")).toBe("- [answered E991-A5 2026-11-10 @Sam · awaits @TEST-Marta · aware @TEST-Sofia] TEST? — unblocks: x — answer: yes");
    // an ask with none of it flips as before, byte for byte
    expect(flipAskLine(A3, "A", "2026-11-10", "Sam")).toBe(A3.replace("[ask E991-A3: decide @Sam since 2026-11-09]", "[answered E991-A3 2026-11-10 @Sam]") + " — answer: A");
  });

  it("goals by area: all, the epic code in either form, the file name, words of the title", () => {
    const g = { code: "EPIC-991", path: "docs/spines/epic-991-books.md", title: "EPIC-991: TEST books for the car lease" };
    expect(areaCovers(["all"], g)).toBe(true);
    expect(areaCovers(["E991"], g)).toBe(true);
    expect(areaCovers(["epic-991-books"], g)).toBe(true);
    expect(areaCovers(["books"], g)).toBe(true);
    expect(areaCovers(["tax filings", "E99"], g)).toBe(false);
  });
});

describe("E990-S3 step 4: the line edits", () => {
  it("answer: awaiting the approver; approve: approved with the date; send back: open again with the note", () => {
    const a = answerLine(A1.slice(0), "TEST-Leo", "C) half, 50 percent", "2026-11-10");
    expect(a).toEqual({ line: expect.stringMatching(/^- \[answered E991-A1 2026-11-10 @TEST-Leo · awaits @TEST-Marta · aware @Sam\] Is the TEST car lease .* — answer: C\) half, 50 percent$/) });
    const line = (a as { line: string }).line;
    expect(approveLine(line, "TEST-Leo", "2026-11-11")).toEqual({ refused: "the answer waits on @TEST-Marta, not @TEST-Leo" });
    expect(approveLine(line, "test-marta", "2026-11-11")).toEqual({ line: line.replace("· awaits @TEST-Marta", "· approved @TEST-Marta 2026-11-11") });
    const back = sendBackLine(line, "TEST-Marta", "ask Sam how many days", "2026-11-11");
    expect(back).toEqual({ line: expect.stringMatching(/^- \[ask E991-A1: decide @TEST-Leo approve by @TEST-Marta aware @Sam since 2026-11-11\] Is the TEST car lease .* — sent back: @TEST-Marta: ask Sam how many days \(was: C\) half, 50 percent\)$/) });
    expect(parseAsks(EPIC((back as { line: string }).line))[0]).toMatchObject({ state: "open", who: "TEST-Leo", approveBy: "TEST-Marta" });
    expect(answerLine(A1, "TEST-Marta", "x", "2026-11-10")).toEqual({ refused: "the ask names @TEST-Leo, not @TEST-Marta" });
  });

  it("not sure: the ask goes up with its code, keeps who is aware, drops an approver who now answers, restarts the clock", () => {
    const e = escalateLine(A1, "TEST-Leo", "TEST-Marta", "depends on how often Sam drives it for work", "2026-11-10");
    expect(e).toEqual({ line: expect.stringMatching(/^- \[ask E991-A1: decide @TEST-Marta aware @Sam escalated by @TEST-Leo since 2026-11-10 row E991-S1\] Is the TEST car lease .* — escalated: @TEST-Leo: depends on how often Sam drives it for work$/) });
    expect(escalateLine(A1, "TEST-Marta", "Sam", "x")).toEqual({ refused: "the ask names @TEST-Leo, not @TEST-Marta" });
  });
});

// ---------- the world on disk, then the console ----------

let tmp: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
const dbs: DB[] = [];
const EPIC_REL = "docs/spines/epic-991-books.md";

function makeRepo(files: Record<string, string>) {
  const origin = path.join(tmp, "home_repo.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), text);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);
  fs.mkdirSync(path.join(tmp, "repos"), { recursive: true });
  git(tmp, ["clone", "-q", origin, path.join(tmp, "repos", "home_repo")]);
  return (rel: string) => git(origin, ["show", `main:${rel}`]);
}

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e90s3-"));
  resetRepoScans();
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("E990-S3 steps 2 and 3, read from the world: inboxes, goals, the board, the time limit", () => {
  it("each person's lists, the goals they see, who is blocked on whom", () => {
    makeRepo({ "docs/spines/root.md": ROOT, [EPIC_REL]: EPIC(A1, A2, A3, A4), "docs/spines/epic-992-social.md": OTHER });
    const w = readWorld([{ name: "home_repo", path: path.join(tmp, "repos", "home_repo") }]);
    expect(w.rosterRepo).toBe("home_repo");
    const leo = find(w.roster, "TEST-Leo")!;
    const marta = find(w.roster, "TEST-Marta")!;
    const sam = find(w.roster, "Sam")!;
    expect(inboxFor(w, leo).answer.map((c) => c.code)).toEqual(["E991-A2", "E991-A1"]); // oldest first
    expect(inboxFor(w, marta).answer).toEqual([]);
    expect(inboxFor(w, sam).answer.map((c) => c.code)).toEqual(["E991-A3"]);
    // the analyst sees the books goal (area), not the social one; the owner sees all
    expect(goalsOf(w, leo).map((g) => g.code)).toEqual(["EPIC-991"]);
    expect(goalsOf(w, find(w.roster, "TEST-Sofia")!).map((g) => g.code)).toEqual([]);
    expect(goalsOf(w, sam).length).toBe(3);
    const b = board(w);
    expect(b.people.find((p) => p.handle === "TEST-Leo")).toMatchObject({ asks: 2, approvals: 0, oldestSince: "2026-11-01" });
    expect(b.unknown).toEqual([{ who: "Nobody", cards: ["home_repo/E991-A4"] }]);
    // the time limit: since 1 Nov waits past Leo's 24 h on 3 Nov; since 9 Nov not yet on 9 Nov 12:00
    const due = dueEscalations(w, Date.parse("2026-11-09T12:00:00Z"));
    expect(due.map((d) => [d.card.code, d.from, d.to])).toEqual([["E991-A2", "TEST-Leo", "TEST-Marta"]]);
  });
});

describe("E990-S3 end to end (CONSOLE_AUTH=on): two TEST humans sign in, each sees only their cards", () => {
  function boot() {
    const db = openDb(path.join(tmp, "console.db"));
    dbs.push(db);
    const app = createApp(db, {
      auth: "on",
      browser: { browserUrl: "http://127.0.0.1:9" },
      read: { reposRoot: path.join(tmp, "repos"), seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
      answers: { retryMs: [] },
    });
    createStore(db, { tenant: "home" }).createMilestone({ title: "TEST", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
    const auth = createAuth(db);
    const owner = auth.createSession(auth.addMember({ email: "sam-test@example.com", tenant: "home", role: "owner" }), "home").id;
    const req = async (method: string, url: string, o: { cookie?: string; body?: unknown } = {}) => {
      const headers: Record<string, string> = {};
      if (o.cookie) headers.cookie = `console_session=${o.cookie}`;
      if (o.body !== undefined) headers["content-type"] = "application/json";
      const res = await app.request(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, { incoming: { socket: { remoteAddress: "203.0.113.9" } } });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return { status: res.status, json, headers: res.headers, text };
    };
    /** The owner invites, the TEST human sets a password from the link and signs in: their session cookie. */
    const signIn = async (handle: string, email: string) => {
      const inv = await req("POST", "/api/people/invite", { cookie: owner, body: { handle, email } });
      expect(inv.status).toBe(201);
      const token = new URL(inv.json.setupPath, "http://x").searchParams.get("setup")!;
      expect((await req("POST", "/api/access/setup", { body: { token, password: "TEST-password-123456" } })).status).toBeLessThan(300);
      const r = await req("POST", "/api/access/login", { body: { email, password: "TEST-password-123456" } });
      expect(r.status).toBe(200);
      return /console_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")![1];
    };
    return { db, req, owner, signIn };
  }

  it("routed, escalated, answered, approved, the owner made aware; the person login reaches nothing else", async () => {
    const onOrigin = makeRepo({ "docs/spines/root.md": ROOT, [EPIC_REL]: EPIC(A1, A2, A3), "docs/spines/epic-992-social.md": OTHER });
    const { req, owner, signIn } = boot();
    const leo = await signIn("TEST-Leo", "test-leo@example.com");
    const marta = await signIn("TEST-Marta", "test-marta@example.com");

    // someone off the list is refused; only the owner invites
    expect((await req("POST", "/api/people/invite", { cookie: owner, body: { handle: "TEST-Ghost", email: "g@example.com" } })).status).toBe(404);
    expect((await req("POST", "/api/people/invite", { cookie: leo, body: { handle: "TEST-Sofia", email: "s@example.com" } })).status).toBe(403);

    // step 2: the analyst sees only their goal and their own inbox; nothing else of the world
    expect((await req("GET", "/api/people/goals", { cookie: leo })).json.goals.map((g: any) => g.code)).toEqual(["EPIC-991"]);
    expect((await req("GET", "/api/milestones", { cookie: leo })).status).toBe(403);
    expect((await req("GET", "/api/waiting-on-owner", { cookie: leo })).json.error.code).toBe("person_scope");
    const page = await req("GET", "/", { cookie: leo });
    expect([page.status, page.headers.get("location")]).toEqual([302, "/people"]);
    expect((await req("GET", "/people", { cookie: leo })).text).toContain("Your inbox");
    expect((await req("GET", "/api/people/board", { cookie: leo })).status).toBe(403);
    expect((await req("GET", "/api/people/inbox?handle=TEST-Marta", { cookie: leo })).status).toBe(403);

    // step 3: two TEST humans each see only their cards
    const leoBox = (await req("GET", "/api/people/inbox", { cookie: leo })).json;
    expect(leoBox.person.handle).toBe("TEST-Leo");
    expect(leoBox.answer.map((c: any) => c.code)).toEqual(["E991-A2", "E991-A1"]);
    expect((await req("GET", "/api/people/inbox", { cookie: marta })).json.answer).toEqual([]);
    // the owner sees anyone's inbox and the board
    expect((await req("GET", "/api/people/inbox?handle=TEST-Leo", { cookie: owner })).json.answer.length).toBe(2);
    expect((await req("GET", "/api/people/board", { cookie: owner })).json.people.find((p: any) => p.handle === "TEST-Leo")).toMatchObject({ asks: 2 });
    // nobody acts on someone else's card
    expect((await req("POST", "/api/people/asks/home_repo/E991-A1/answer", { cookie: marta, body: { text: "yes" } })).status).toBe(409);

    // step 4: Not sure sends it to the expert, with the note
    const ns = await req("POST", "/api/people/asks/home_repo/E991-A1/not-sure", { cookie: leo, body: { note: "depends on how often Sam drives it for work" } });
    expect([ns.status, ns.json.to]).toEqual([200, "TEST-Marta"]);
    expect(onOrigin(EPIC_REL)).toMatch(/^- \[ask E991-A1: decide @TEST-Marta aware @Sam escalated by @TEST-Leo since \d{4}-\d\d-\d\d row E991-S1\] .* — escalated: @TEST-Leo: depends on how often Sam drives it for work$/m);
    // Current State says who is blocked on whom: the code moved from the analyst to the expert
    expect(onOrigin(EPIC_REL)).toContain("Waiting on: TEST-Leo: E991-A2; Sam: E991-A3; TEST-Marta: E991-A1\n");
    const mBox = (await req("GET", "/api/people/inbox", { cookie: marta })).json;
    expect(mBox.answer).toEqual([expect.objectContaining({ code: "E991-A1", escalatedBy: "TEST-Leo" })]);
    expect((await req("GET", "/api/people/inbox", { cookie: leo })).json.answer.map((c: any) => c.code)).toEqual(["E991-A2"]);

    // the expert answers it; the owner, made aware, sees it under Know and presses Seen
    expect((await req("POST", "/api/people/asks/home_repo/E991-A1/answer", { cookie: marta, body: { text: "C) 50 percent if he drives it for clients most days" } })).status).toBe(200);
    expect(onOrigin(EPIC_REL)).toMatch(/^- \[answered E991-A1 \d{4}-\d\d-\d\d @TEST-Marta · aware @Sam\] .* — answer: C\) 50 percent if he drives it for clients most days$/m);
    expect(onOrigin(EPIC_REL)).toContain("Waiting on: TEST-Leo: E991-A2; Sam: E991-A3\n"); // answered, no approver: off the line
    const know = (await req("GET", "/api/people/inbox", { cookie: owner })).json.know;
    expect(know).toEqual([expect.objectContaining({ code: "E991-A1", who: "TEST-Marta", answer: "C) 50 percent if he drives it for clients most days" })]);
    await req("POST", "/api/people/asks/home_repo/E991-A1/seen", { cookie: owner });
    expect((await req("GET", "/api/people/inbox", { cookie: owner })).json.know[0].seen).toBe(true);

    // two-step approval: the analyst answers's twin with an approver; the expert sends it back, then approves
    const fs2 = path.join(tmp, "seed");
    git(fs2, ["pull", "-q", "origin", "main"]);
    const A5 = "- [ask E991-A5: decide @TEST-Leo approve by @TEST-Marta aware @Sam since 2026-11-09 row E991-S2] Book the two TEST receipts under office costs? — unblocks: E991-S2";
    fs.writeFileSync(path.join(fs2, EPIC_REL), fs.readFileSync(path.join(fs2, EPIC_REL), "utf8").replace("## Waiting on\n\n", `## Waiting on\n\n${A5}\n`));
    git(fs2, ["commit", "-qam", "TEST ask E991-A5"]);
    git(fs2, ["push", "-q", "origin", "main"]);
    git(path.join(tmp, "repos", "home_repo"), ["pull", "-q", "origin", "main"]);
    expect((await req("POST", "/api/people/asks/home_repo/E991-A5/answer", { cookie: leo, body: { text: "yes, office costs" } })).status).toBe(200);
    expect((await req("GET", "/api/people/inbox", { cookie: marta })).json.approve.map((c: any) => c.code)).toEqual(["E991-A5"]);
    expect(onOrigin(EPIC_REL)).toMatch(/Waiting on: TEST-Leo: E991-A2; Sam: E991-A3; TEST-Marta: E991-A5\n/); // awaits the approver
    expect((await req("POST", "/api/people/asks/home_repo/E991-A5/approve", { cookie: leo })).status).toBe(409); // never their own
    expect((await req("POST", "/api/people/asks/home_repo/E991-A5/send-back", { cookie: marta, body: { note: "one is a meal, not an office cost" } })).status).toBe(200);
    expect((await req("GET", "/api/people/inbox", { cookie: leo })).json.answer.map((c: any) => c.code)).toContain("E991-A5");
    await req("POST", "/api/people/asks/home_repo/E991-A5/answer", { cookie: leo, body: { text: "one office, one meal" } });
    expect((await req("POST", "/api/people/asks/home_repo/E991-A5/approve", { cookie: marta })).status).toBe(200);
    expect(onOrigin(EPIC_REL)).toMatch(/^- \[answered E991-A5 \d{4}-\d\d-\d\d @TEST-Leo · approved @TEST-Marta \d{4}-\d\d-\d\d · aware @Sam\] .* — answer: one office, one meal$/m);
    expect(onOrigin(EPIC_REL)).toContain("Waiting on: TEST-Leo: E991-A2; Sam: E991-A3\n");
    expect((await req("GET", "/api/people/inbox", { cookie: owner })).json.know.map((c: any) => c.code)).toContain("E991-A5");

    // the time limit: (since 1 Nov) waited past Leo's 24 h: the owner's sweep passes it to the expert
    const due = await req("POST", "/api/people/escalate-due", { cookie: owner });
    expect(due.json.escalated).toEqual([expect.objectContaining({ card: "home_repo/E991-A2", from: "TEST-Leo", to: "TEST-Marta", status: "written" })]);
    expect(onOrigin(EPIC_REL)).toMatch(/^- \[ask E991-A2: provide @TEST-Marta escalated by @TEST-Leo since \d{4}-\d\d-\d\d row E991-S2\] .* — escalated: @TEST-Leo: no answer within 24 h, passed on by the time limit$/m);

    // under shadow (production today) a caller with no credential is the owner, as on every other page
    // removed after: the TEST logins leave the world
    expect((await req("DELETE", "/api/people/logins/TEST-Leo", { cookie: owner })).json.removed).toBe(1);
    expect((await req("GET", "/api/people/inbox", { cookie: leo })).status).toBe(401);
  });
});

describe("E990-S3 under CONSOLE_AUTH=shadow (production today)", () => {
  it("a browser with no session is the owner (board, Know); a person login is still kept to its own inbox", async () => {
    makeRepo({ "docs/spines/root.md": ROOT, [EPIC_REL]: EPIC(A1, A2, A3), "docs/spines/epic-992-social.md": OTHER });
    const db = openDb(path.join(tmp, "console.db"));
    dbs.push(db);
    const app = createApp(db, {
      auth: "shadow",
      browser: { browserUrl: "http://127.0.0.1:9" },
      read: { reposRoot: path.join(tmp, "repos"), seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
      answers: { retryMs: [] },
    });
    createStore(db, { tenant: "home" }).createMilestone({ title: "TEST", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
    const get = async (url: string, cookie?: string) => {
      const r = await app.request(url, { headers: { ...(cookie ? { cookie: `console_session=${cookie}` } : {}), "x-forwarded-for": "198.51.100.7" } });
      return { status: r.status, json: await r.json().catch(() => undefined) };
    };
    const me = await get("/api/people");
    expect(me.json.me).toMatchObject({ handle: "Sam", owner: true });
    expect((await get("/api/people/board")).status).toBe(200);
    const auth = createAuth(db);
    const u = auth.addMember({ email: "test-leo@example.com", tenant: "home", role: "member" });
    db.prepare("UPDATE memberships SET handle = 'TEST-Leo' WHERE user_id = ?").run(u);
    const leo = auth.createSession(u, "home").id;
    expect((await get("/api/people/inbox", leo)).json.person.handle).toBe("TEST-Leo");
    expect((await get("/api/people/board", leo)).status).toBe(403);
    expect((await get("/api/milestones", leo)).status).toBe(403);
  });
});
