import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { asksFor, fromSpinesEntry, parseAsks, snoozedNow, unglueSnooze } from "../src/inbox/asks.js";
import { applySnooze } from "../src/inbox/spineWrite.js";
import { snoozeDate } from "../src/inbox/routes.js";
import type { ReadConfig } from "../src/routes/read.js";

/** Snooze a waiting ask (3 days / 1 week / 1 month): the date is written on its spine line; hidden and uncounted until then. */

const ASK = "- [ask T9-A3: decide @Sam since 2026-10-22 row T6] Pick the launch date — context: the shop opens soon — recommend: Monday — unblocks: T6";
const SPINE = `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Waiting on

${ASK}
- [ask T9-A4: provide @Sam since 2026-10-22 row T7] Share the staging URL — unblocks: T7

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T6 | Launch | Sam | blocked |
| T7 | Staging | Sam | blocked |
`;

describe("snooze field on the ask line", () => {
  it("parsed into snoozedUntil; question and other fields untouched", () => {
    const [a] = parseAsks(SPINE.replace(ASK, `${ASK} — snoozed until: 2099-01-08`));
    expect(a).toMatchObject({ code: "T9-A3", question: "Pick the launch date", unblocks: "T6", recommend: "Monday", snoozedUntil: "2099-01-08", state: "open" });
    expect(parseAsks(SPINE)[0].snoozedUntil).toBeUndefined();
  });
  it("a spines.py entry: snoozed_until read; a field it glued the snooze onto is cleaned", () => {
    expect(fromSpinesEntry({ code: "T9-A3", ask: "decide", question: "Pick", state: "open", snoozed_until: "2099-01-08" })!.snoozedUntil).toBe("2099-01-08");
    const glued = unglueSnooze(fromSpinesEntry({ code: "T9-A3", ask: "decide", question: "Pick", unblocks: "T6 — snoozed until: 2099-01-08", state: "open" })!);
    expect(glued.unblocks).toBe("T6");
    expect(unglueSnooze({ ...glued, question: "Pick — snoozed until: 2099-01-08" }).question).toBe("Pick");
  });
  it("asksFor: the file as it is now decides the snooze, not an older spines.py output", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s3-file-"));
    try {
      const entry = { code: "T9-A3", who: "Sam", ask: "decide", question: "Pick the launch date", unblocks: "T6", state: "open", row: "T6" };
      put("docs/a.md", SPINE, dir);
      expect(asksFor(dir, "docs/a.md", [{ ...entry, snoozed_until: "2099-01-08" }])[0].snoozedUntil).toBeUndefined();
      put("docs/a.md", SPINE.replace(ASK, `${ASK} — snoozed until: 2099-01-08`), dir);
      expect(asksFor(dir, "docs/a.md", [{ ...entry, unblocks: "T6 — snoozed until: 2099-01-08" }])[0]).toMatchObject({ snoozedUntil: "2099-01-08", unblocks: "T6" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("snoozedNow: only a day still ahead hides it", () => {
    expect(snoozedNow("2026-11-04", "2026-11-01")).toBe(true);
    expect(snoozedNow("2026-11-01", "2026-11-01")).toBe(false);
    expect(snoozedNow(undefined, "2026-11-01")).toBe(false);
  });
  it("applySnooze adds, replaces and removes the one field; unsnooze gives the original line back", () => {
    const t = { id: "x", source: "ask" as const, question: "Pick the launch date", code: "T9-A3", row: "T6" };
    const on = applySnooze(SPINE, t, "2099-01-08");
    expect(on.how).toBe("snooze");
    const text1 = (on as { text: string }).text;
    expect(text1).toContain(`${ASK} — snoozed until: 2099-01-08\n`);
    const again = applySnooze(text1, t, "2099-02-01") as { text: string };
    expect(again.text).toContain(`${ASK} — snoozed until: 2099-02-01\n`);
    expect(again.text).not.toContain("2099-01-08");
    expect(applySnooze(again.text, t, "2099-02-01").how).toBe("same");
    const off = applySnooze(again.text, t, undefined) as { text: string };
    expect(off.text).toBe(SPINE);
    expect(applySnooze(SPINE, { ...t, code: "T9-A9", question: "nope" }, "2099-01-08").how).toBe("missing");
    const answered = SPINE.replace(ASK, "- [answered T9-A3 2026-10-23 @Sam] Pick the launch date — answer: Monday");
    expect(applySnooze(answered, t, "2099-01-08").how).toBe("not_open");
  });
  it("snoozeDate: 3 days / 1 week / 1 month from today (UTC)", () => {
    const now = Date.parse("2026-11-01T22:00:00Z");
    expect([3, 7, 30].map((d) => snoozeDate(d, now))).toEqual(["2026-11-04", "2026-11-08", "2026-12-01"]);
  });
});

let tmp: string;
let origin: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (rel: string, text: string, dir: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s3-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  put("docs/spines/root.md", SPINE, seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  repo = path.join(tmp, "inbox");
  git(tmp, "clone", "-q", origin, repo);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("API: POST /waiting-on-owner/:id/snooze", () => {
  let db: DB;
  afterEach(() => db?.close());
  const setup = () => {
    db = openDb(path.join(tmp, "console.db"));
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read: readCfg });
    return async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
  };

  it("snooze 1 week: line written + pushed, item stays open but leaves the count; unsnooze round-trips the line", async () => {
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const list = async () => (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    const needsYou = async () => (await call("GET", `/api/milestones/${m.id}/status`)).json.needsYou;
    expect(await needsYou()).toBe(2);
    const ask = (await list()).find((i) => i.code === "T9-A3");

    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { days: 7, milestoneId: m.id });
    expect(r.status).toBe(200);
    const until = snoozeDate(7);
    expect(r.json).toMatchObject({ id: ask.id, snoozedUntil: until, spine: { status: "written" } });
    expect(git(origin, "show", "main:docs/spines/root.md")).toContain(`${ASK} — snoozed until: ${until}`);
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe(`Snooze T9-A3 until ${until} (Sam, via console)`);
    const snoozed = (await list()).find((i) => i.code === "T9-A3");
    expect(snoozed).toMatchObject({ id: ask.id, state: "open", snoozedUntil: until, question: "Pick the launch date", unblocks: "T6" });
    expect(await needsYou()).toBe(1);

    // Same snooze again: no new commit, still 200.
    const head = git(origin, "rev-parse", "main");
    expect((await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { until, milestoneId: m.id })).status).toBe(200);
    expect(git(origin, "rev-parse", "main")).toBe(head);

    const u = await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { until: null, milestoneId: m.id });
    expect(u.status).toBe(200);
    expect(u.json.snoozedUntil).toBeNull();
    expect(git(origin, "show", "main:docs/spines/root.md")).toBe(SPINE.trim());
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Unsnooze T9-A3 (Sam, via console)");
    expect((await list()).find((i) => i.code === "T9-A3").snoozedUntil).toBeUndefined();
    expect(await needsYou()).toBe(2);
  });

  it("T48-S21: 3 hours writes a UTC minute on the line; the ask leaves the count until then", async () => {
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A3");
    const before = Date.now();
    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { hours: 3, milestoneId: m.id });
    expect(r.status).toBe(200);
    expect(r.json.snoozedUntil).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    expect(Math.abs(Date.parse(r.json.snoozedUntil) - before - 3 * 3_600_000)).toBeLessThan(120_000);
    expect(git(origin, "show", "main:docs/spines/root.md")).toContain(`${ASK} — snoozed until: ${r.json.snoozedUntil}`);
    expect(((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A3").snoozedUntil).toBe(r.json.snoozedUntil);
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.needsYou).toBe(1);
    expect((await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { hours: 5, milestoneId: m.id })).status).toBe(400);
  });

  it("T48-S21: a minute already passed shows the ask again and counts it", async () => {
    put("docs/spines/root.md", SPINE.replace(ASK, `${ASK} — snoozed until: 2020-01-01T10:00Z`), repo);
    git(repo, "commit", "-qam", "old snooze");
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A3");
    expect(ask.snoozedUntil).toBeUndefined();
    expect(ask.unblocks).toBe("T6");
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.needsYou).toBe(2);
  });

  it("a date already passed shows the ask again and counts it", async () => {
    put("docs/spines/root.md", SPINE.replace(ASK, `${ASK} — snoozed until: 2020-01-01`), repo);
    git(repo, "commit", "-qam", "old snooze");
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A3");
    expect(ask.snoozedUntil).toBeUndefined();
    expect(ask.question).toBe("Pick the launch date");
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.needsYou).toBe(2);
  });

  it("refuses bad bodies and unknown items", async () => {
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A3");
    expect((await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { days: 5 })).status).toBe(400);
    expect((await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, {})).status).toBe(400);
    expect((await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { until: "2020-01-01" })).status).toBe(400);
    expect((await call("POST", `/api/waiting-on-owner/wj_nope/snooze`, { days: 3 })).status).toBe(404);
  });
});
