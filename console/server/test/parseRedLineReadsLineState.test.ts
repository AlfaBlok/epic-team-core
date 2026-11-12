import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { byMilestonePriority, TIER_SPAN } from "../src/inbox/priority.js";
import { lookupOf, parsePriorities, parseRedLine, RED_LINE_MAX, worldRedLine } from "../src/inbox/jordiPriority.js";
import type { ReadConfig } from "../src/routes/read.js";

/**
 * the Prioritizer writes ONE red line into docs/priorities.json (`redLine`: a sentence and the 3 to 7 rows and
 * asks on it); those items lead every inbox list, above high, each with the red marker; GET /api/red-line serves the band.
 */

const redLine = {
  sentence: "Get customer one paying on EpicTeam this week.",
  why: "You asked for it three times since Sunday.",
  words: "When can I be on the Alpha 9 account of Epic Team?",
  said: "2026-11-09",
  source: "Log/2026-11-09.md#^e-988bd6",
  state: "proposed",
  ask: "E948-A6",
  at: "2026-11-10T07:00:00Z",
  items: [
    { repo: "repo1", ref: "R1-S2", why: "The sign-up page." },
    { repo: "repo1", ref: "E901-A1" },
    { repo: "repo2", ref: "EPIC-902", path: "docs/spines/root.md" },
  ],
};
const file = JSON.stringify({
  version: 1,
  at: "2026-11-10T05:00:00Z",
  items: [
    { repo: "repo1", ref: "R1-S1", level: "high", why: "He asked for it today." },
    { repo: "repo1", ref: "R1-S2", level: "low", why: "Quiet." },
    { repo: "repo1", ref: "EPIC-901", path: "docs/spines/root.md", level: "normal", why: "Normal." },
  ],
  redLine,
});

describe("parseRedLine", () => {
  it("reads the line, its state and items; a missing sentence or no items is no line", () => {
    const r = parseRedLine(file, "repo1")!;
    expect(r).toMatchObject({ sentence: redLine.sentence, state: "proposed", ask: "E948-A6", words: redLine.words });
    expect(r.items.map((i) => i.ref)).toEqual(["R1-S2", "E901-A1", "EPIC-902"]);
    expect(parseRedLine(JSON.stringify({ items: [], redLine: { ...redLine, sentence: " " } }), "repo1")).toBeUndefined();
    expect(parseRedLine(JSON.stringify({ items: [], redLine: { ...redLine, items: [] } }), "repo1")).toBeUndefined();
    expect(parseRedLine(JSON.stringify({ items: [] }), "repo1")).toBeUndefined();
    expect(parseRedLine("{bad", "repo1")).toBeUndefined();
  });
  it("an unknown state reads as proposed; an item with no repo is the file's; at most seven items", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ref: `R1-S${i}` }));
    const r = parseRedLine(JSON.stringify({ redLine: { sentence: "x", state: "maybe", items: many } }), "repo9")!;
    expect(r.state).toBe("proposed");
    expect(r.items).toHaveLength(RED_LINE_MAX);
    expect(r.items[0].repo).toBe("repo9");
  });
});

describe("the red line leads the lists", () => {
  const look = lookupOf(parsePriorities(file, "repo1"), parseRedLine(file, "repo1"));
  it("a row, an ask, an ask whose row is on the line, and an epic's own item carry the red marker; its level stays", () => {
    expect(look({ repo: "repo1", ref: "R1-S2" })).toMatchObject({ level: "low", why: "The sign-up page.", redLine: { sentence: redLine.sentence, state: "proposed", ask: "E948-A6", at: "2026-11-10" } });
    expect(look({ repo: "repo1", code: "E901-A1", path: "docs/spines/root.md" })?.redLine).toBeTruthy();
    expect(look({ repo: "repo1", code: "E901-A9", row: "R1-S2" })?.redLine).toBeTruthy();
    expect(look({ repo: "repo2", path: "docs/spines/root.md" })).toMatchObject({ level: "high", why: redLine.why, words: redLine.words, redLine: { state: "proposed" } });
  });
  it("while proposed, the ask that proposes it leads too; once agreed it is an ordinary ask", () => {
    const at = (state: string) => lookupOf([], parseRedLine(JSON.stringify({ redLine: { ...redLine, state, ask: "E948-A6" } }), "home_repo"));
    expect(at("proposed")({ repo: "home_repo", code: "E948-A6", path: "docs/spines/epic-948.md" })).toMatchObject({ level: "high", why: "Your answer sets the red line: agree, or say it in your words.", redLine: { state: "proposed" } });
    expect(at("proposed")({ repo: "memo", code: "E948-A6" })).toBeUndefined();
    expect(at("agreed")({ repo: "home_repo", code: "E948-A6" })).toBeUndefined();
  });
  it("never by epic number or another repo: the line names a few things, not a whole epic", () => {
    expect(look({ repo: "repo1", code: "E901-A2", path: "docs/spines/root.md" })?.redLine).toBeUndefined();
    expect(look({ repo: "repo2", code: "E902-A1", path: "docs/spines/root.md" })?.redLine).toBeUndefined();
    expect(look({ repo: "repo2", ref: "R1-S2" })).toBeUndefined();
    expect(look({ repo: "repo1", ref: "R1-S1" })?.redLine).toBeUndefined();
  });
  it("an item with a path matches only in that spine (a row code is unique only inside its spine)", () => {
    const f = JSON.stringify({ items: [], redLine: { ...redLine, items: [{ repo: "z", ref: "T1", path: "docs/b.md" }] } });
    const l = lookupOf([], parseRedLine(f, "z"));
    expect(l({ repo: "z", ref: "T1", path: "docs/b.md" })?.redLine).toBeTruthy();
    expect(l({ repo: "z", ref: "T1", path: "./docs/b.md" })?.redLine).toBeTruthy();
    expect(l({ repo: "z", ref: "T1", path: "docs/a.md" })).toBeUndefined();
    expect(l({ repo: "z", ref: "T1" })).toBeUndefined();
  });
  it("sorts the red line first (even a low one), then high, normal and unranked, low", () => {
    const ranks = new Map([["top", 0]]);
    const items = [
      { id: "high", milestoneId: "top", repo: "repo1", ref: "R1-S1" },
      { id: "plain", milestoneId: "top", repo: "repo3" },
      { id: "red-low", milestoneId: "top", repo: "repo1", ref: "R1-S2" },
      { id: "red-ask", milestoneId: "top", repo: "repo1", code: "E901-A1", path: "docs/spines/root.md" },
    ];
    const out = byMilestonePriority(items, ranks, look);
    expect(out.map((i) => i.id)).toEqual(["red-low", "red-ask", "high", "plain"]);
    expect(out.map((i) => i.priority)).toEqual([1, 1, TIER_SPAN + 1, 2 * TIER_SPAN + 1]);
  });
  it("no red line: the levels alone, as in E948-S34", () => {
    const plain = lookupOf(parsePriorities(file, "repo1"));
    expect(plain({ repo: "repo1", ref: "R1-S2" })).toMatchObject({ level: "low" });
    expect(plain({ repo: "repo1", ref: "R1-S2" })?.redLine).toBeUndefined();
  });
});

const spine = (n: string) => `# EPIC-990${n}: Spine ${n}

Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Waiting on

- [ask E90${n}-A1: decide @Sam since 2026-10-22 row T1] Question ${n} — unblocks: T1
- [ask E90${n}-A2: decide @Sam since 2026-10-22 row T2] Other ${n} — unblocks: T2

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T1 | Thing | Sam | blocked |
| T2 | Other | Sam | blocked |
`;

let tmp: string;
let db: DB;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s35-"));
  for (const n of ["1", "2"]) {
    const dir = path.join(tmp, `repo${n}`);
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/spines/root.md"), spine(n));
    git(tmp, "init", "-q", "-b", "main", dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
  }
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("API", () => {
  it("GET /api/red-line serves the world's line; waiting-on-owner puts its asks first, marked", async () => {
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const app = createApp(db, { read: readCfg, review: { live: { fetch: ok, consoleHosts: [] } } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return res.json();
    };
    await call("POST", "/api/milestones", { title: "One", repo: "Acme/repo1", path: "docs/spines/root.md" });
    await call("POST", "/api/milestones", { title: "Two", repo: "Acme/repo2", path: "docs/spines/root.md" });
    expect(await call("GET", "/api/red-line")).toEqual({ redLine: null, redLines: [] });
    const codes = async () =>
      ((await call("GET", "/api/waiting-on-owner")) as { code?: string; repo?: string; state: string; ownerPriority?: { redLine?: unknown } }[])
        .filter((i) => i.state === "open")
        .map((i) => `${i.repo}:${i.code}${i.ownerPriority?.redLine ? "!" : ""}`);
    expect(await codes()).toEqual(["repo1:E901-A1", "repo1:E901-A2", "repo2:E902-A1", "repo2:E902-A2"]);
    fs.writeFileSync(
      path.join(tmp, "repo1", "docs/priorities.json"),
      JSON.stringify({ at: "2026-11-10T05:00:00Z", items: [{ repo: "repo1", ref: "EPIC-901", path: "docs/spines/root.md", level: "low", why: "Quiet." }], redLine: { ...redLine, items: [{ repo: "repo2", ref: "E902-A2" }, { repo: "repo1", ref: "E901-A2" }] } }),
    );
    const got = (await call("GET", "/api/red-line")) as { redLine: { sentence: string; items: unknown[] } };
    expect(got.redLine).toMatchObject({ sentence: redLine.sentence, state: "proposed", ask: "E948-A6" });
    expect(got.redLine.items).toHaveLength(2);
    // the red-line asks first (milestone order between them), then the rest; repo1's other ask stays low
    expect(await codes()).toEqual(["repo1:E901-A2!", "repo2:E902-A2!", "repo2:E902-A1", "repo1:E901-A1"]);
    const st = (await call("GET", "/api/status")) as { items: { code?: string; state: string; ownerPriority?: { redLine?: unknown } }[] };
    expect(st.items.filter((i) => i.state === "open").slice(0, 2).map((i) => [i.code, !!i.ownerPriority?.redLine])).toEqual([["E901-A2", true], ["E902-A2", true]]);
  });

  it("a world reads only its own checkouts' line", () => {
    fs.writeFileSync(path.join(tmp, "repo2", "docs/priorities.json"), JSON.stringify({ items: [], redLine }));
    const store = (repos: string[]) => ({ listMilestones: () => repos.map((repo) => ({ repo })) }) as never;
    expect(worldRedLine(store(["Acme/repo1"]), tmp)).toBeUndefined();
    expect(worldRedLine(store(["Acme/repo2"]), tmp)?.sentence).toBe(redLine.sentence);
  });
});
