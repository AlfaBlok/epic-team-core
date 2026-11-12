import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { byMilestonePriority, LINE_SPAN, TIER_SPAN } from "../src/inbox/priority.js";
import { lookupOf, parsePriorities, parseRedLine, parseRedLines, RED_LINES_MAX, worldRedLines } from "../src/inbox/jordiPriority.js";
import type { ReadConfig } from "../src/routes/read.js";

/**
 * `redLines` holds several named lines in order; each
 * item is marked with its line's name, the first line's items lead, then the second's, all above high.
 */

const first = {
  name: "Memo's first tester",
  sentence: "Get Memo's first real tester signed up and using it every day.",
  state: "agreed",
  ask: "E948-A6",
  at: "2026-11-10T07:10:00Z",
  items: [
    { repo: "repo1", ref: "R1-S2" },
    { repo: "repo1", ref: "E901-A1" },
    { repo: "repo1", ref: "R1-S3" },
  ],
};
const second = {
  name: "Data-product flywheel",
  target: "2026-11-30",
  sentence: "By 30 November, two or three data products run on their own.",
  why: "You called it a separate red line on 10 Nov.",
  words: "It's a separate red line, but it's category red line.",
  said: "2026-11-10",
  source: "Log/2026-11-10.md#^e-b4e093",
  state: "proposed",
  ask: "E948-A8",
  at: "2026-11-10T17:00:00Z",
  items: [
    { repo: "repo2", ref: "E902-A1" },
    { repo: "repo2", ref: "R2-S1" },
    { repo: "repo1", ref: "R1-S2" },
  ],
};
const file = JSON.stringify({
  at: "2026-11-10T05:00:00Z",
  items: [{ repo: "repo1", ref: "R1-S1", level: "high", why: "He asked for it today." }],
  redLines: [first, second],
});

describe("parseRedLines", () => {
  it("reads every named line in order, with its target; parseRedLine is the first", () => {
    const lines = parseRedLines(file, "home_repo");
    expect(lines.map((l) => [l.name, l.state, l.ask])).toEqual([
      ["Memo's first tester", "agreed", "E948-A6"],
      ["Data-product flywheel", "proposed", "E948-A8"],
    ]);
    expect(lines[1]).toMatchObject({ target: "2026-11-30", words: second.words, repo: "home_repo" });
    expect(parseRedLine(file, "home_repo")?.name).toBe("Memo's first tester");
  });
  it("still reads the E948-S35 `redLine` (an object or a list); a broken line or a repeated name is skipped", () => {
    expect(parseRedLines(JSON.stringify({ redLine: first }), "r").map((l) => l.name)).toEqual(["Memo's first tester"]);
    expect(parseRedLines(JSON.stringify({ redLine: [first, second] }), "r")).toHaveLength(2);
    expect(parseRedLines(JSON.stringify({ redLines: [{ ...first, items: [] }, second, { ...second, sentence: "Other." }] }), "r").map((l) => l.name)).toEqual(["Data-product flywheel"]);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...first, name: `Line ${i}` }));
    expect(parseRedLines(JSON.stringify({ redLines: many }), "r")).toHaveLength(RED_LINES_MAX);
    expect(parseRedLines("{bad", "r")).toEqual([]);
  });
});

describe("several lines lead the lists", () => {
  const look = lookupOf(parsePriorities(file, "repo1"), parseRedLines(file, "home_repo"));
  it("each item carries its own line's name and place; an item on both lines takes the first", () => {
    expect(look({ repo: "repo1", ref: "R1-S3" })?.redLine).toMatchObject({ name: "Memo's first tester", line: 0, state: "agreed" });
    expect(look({ repo: "repo2", code: "E902-A1" })).toMatchObject({ level: "high", why: second.why, words: second.words, redLine: { name: "Data-product flywheel", line: 1, state: "proposed" } });
    expect(look({ repo: "repo1", ref: "R1-S2" })?.redLine).toMatchObject({ name: "Memo's first tester", line: 0 });
    expect(look({ repo: "repo1", ref: "R1-S1" })).toMatchObject({ level: "high" });
    expect(look({ repo: "repo1", ref: "R1-S1" })?.redLine).toBeUndefined();
  });
  it("an ask coded like an epic (`EPIC-905-A1`, with its spine) is an ask, not an epic", () => {
    const f = JSON.stringify({ redLines: [{ ...second, items: [{ repo: "deal-funnels", ref: "EPIC-905-A1", path: "docs/spines/e5.md" }] }] });
    const l = lookupOf([], parseRedLines(f, "home_repo"));
    expect(l({ repo: "deal-funnels", code: "EPIC-905-A1", path: "docs/spines/e5.md" })?.redLine).toMatchObject({ name: "Data-product flywheel" });
    expect(l({ repo: "deal-funnels", path: "docs/spines/e5.md" })).toBeUndefined();
    expect(l({ repo: "airbnb-observatory", code: "EPIC-905-A1", path: "docs/spines/e5.md" })).toBeUndefined();
  });
  it("a ranked item on a line: its level stays, the why is the line item's own", () => {
    const f = JSON.stringify({ items: [{ repo: "repo1", ref: "R1-S2", level: "low", why: "Quiet.", words: "w", said: "2026-11-01", source: "s" }], redLines: [{ ...first, items: [{ repo: "repo1", ref: "R1-S2", why: "The sign-up page." }, ...first.items.slice(1)] }] });
    const l = lookupOf(parsePriorities(f, "repo1"), parseRedLines(f, "home_repo"));
    const got = l({ repo: "repo1", ref: "R1-S2" })!;
    expect(got).toMatchObject({ level: "low", why: "The sign-up page.", redLine: { name: "Memo's first tester" } });
    expect(got.words).toBeUndefined();
    expect(l({ repo: "repo1", ref: "E901-A1" })?.why).toBe(first.sentence);
  });
  it("the proposed line's own ask leads with it; the agreed line's ask is an ordinary one", () => {
    expect(look({ repo: "home_repo", code: "E948-A8" })?.redLine).toMatchObject({ name: "Data-product flywheel", line: 1 });
    expect(look({ repo: "home_repo", code: "E948-A6" })).toBeUndefined();
  });
  it("sorts the first line, then the second, then high and the rest; a line's items keep the milestone order", () => {
    const ranks = new Map([["a", 0], ["b", 1]]);
    const items = [
      { id: "high", milestoneId: "a", repo: "repo1", ref: "R1-S1" },
      { id: "fly-a", milestoneId: "b", repo: "repo2", code: "E902-A1" },
      { id: "fly-b", milestoneId: "a", repo: "repo2", ref: "R2-S1" },
      { id: "plain", milestoneId: "a", repo: "repo3" },
      { id: "zen", milestoneId: "b", repo: "repo1", ref: "R1-S3" },
    ];
    const out = byMilestonePriority(items, ranks, look);
    expect(out.map((i) => i.id)).toEqual(["zen", "fly-b", "fly-a", "high", "plain"]);
    expect(out.map((i) => i.priority)).toEqual([2, LINE_SPAN + 1, LINE_SPAN + 2, TIER_SPAN + 1, 2 * TIER_SPAN + 1]);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s36-"));
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
  it("GET /api/red-line serves every line (redLine stays the first); the asks of both lines lead, in line order", async () => {
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const app = createApp(db, { read: readCfg, review: { live: { fetch: ok, consoleHosts: [] } } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return res.json();
    };
    await call("POST", "/api/milestones", { title: "One", repo: "Acme/repo1", path: "docs/spines/root.md" });
    await call("POST", "/api/milestones", { title: "Two", repo: "Acme/repo2", path: "docs/spines/root.md" });
    fs.writeFileSync(
      path.join(tmp, "repo1", "docs/priorities.json"),
      JSON.stringify({
        at: "2026-11-10T05:00:00Z",
        items: [],
        redLines: [
          { ...first, items: [{ repo: "repo2", ref: "E902-A2" }] },
          { ...second, items: [{ repo: "repo1", ref: "E901-A1" }, { repo: "repo2", ref: "E902-A1" }] },
        ],
      }),
    );
    const got = (await call("GET", "/api/red-line")) as { redLine: { name: string }; redLines: { name: string; items: unknown[] }[] };
    expect(got.redLine.name).toBe("Memo's first tester");
    expect(got.redLines.map((l) => [l.name, l.items.length])).toEqual([["Memo's first tester", 1], ["Data-product flywheel", 2]]);
    const open = ((await call("GET", "/api/waiting-on-owner")) as { code?: string; repo?: string; state: string; ownerPriority?: { redLine?: { name?: string } } }[])
      .filter((i) => i.state === "open")
      .map((i) => `${i.repo}:${i.code}:${i.ownerPriority?.redLine?.name ?? "-"}`);
    expect(open).toEqual(["repo2:E902-A2:Memo's first tester", "repo1:E901-A1:Data-product flywheel", "repo2:E902-A1:Data-product flywheel", "repo1:E901-A2:-"]);
    const store = (repos: string[]) => ({ listMilestones: () => repos.map((repo) => ({ repo })) }) as never;
    expect(worldRedLines(store(["Acme/repo2"]), tmp)).toEqual([]);
  });
});
