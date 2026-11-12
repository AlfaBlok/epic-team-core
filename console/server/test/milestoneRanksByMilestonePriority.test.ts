import { addCard } from "./reviewFixture.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { byMilestonePriority, milestoneRanks } from "../src/inbox/priority.js";
import type { ReadConfig } from "../src/routes/read.js";
// example codes (epic numbers from 900 up): a one-digit epic number n reads as 90n
const ex = (n: string | number): string => (/^\d$/.test(String(n)) ? `90${n}` : String(n));

/** "Blocked, waiting on you" and "Done, waiting for your review" follow milestone priority (sidebar order). */

const spine = (n: string) => `# EPIC-${ex(n)}: Spine ${n}

Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Waiting on

- [ask E${ex(n)}-A1: decide @Sam since 2026-10-22 row T1] Question ${n} — unblocks: T1

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T1 | Thing | Sam | blocked |
`;

describe("milestoneRanks / byMilestonePriority", () => {
  const m = (id: string, createdAt: string, extra: { bigRoot?: number; settledAt?: string } = {}) => ({ id, createdAt, ...extra });
  it("big roots by position first, then the rest in created order, settled last", () => {
    const ranks = milestoneRanks([m("a", "1", { settledAt: "x" }), m("b", "2"), m("c", "3", { bigRoot: 2 }), m("d", "4", { bigRoot: 1 }), m("e", "5")]);
    expect([...ranks.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id)).toEqual(["d", "c", "b", "e", "a"]);
  });
  it("an item two milestones list ranks with the better one", () => {
    const ranks = new Map([
      ["root", 8],
      ["top", 0],
    ]);
    expect(byMilestonePriority([{ id: "x", milestoneId: "other" }, { id: "y", milestoneId: "root", alsoIn: ["top"] }], ranks)).toEqual([
      { id: "y", milestoneId: "root", alsoIn: ["top"], priority: 1 },
      { id: "x", milestoneId: "other" },
    ]);
  });
  it("stable: ties keep today's order; unknown milestones go last", () => {
    const ranks = new Map([
      ["top", 0],
      ["p20", 19],
    ]);
    const items = [
      { id: "1", milestoneId: "p20" },
      { id: "2" },
      { id: "3", milestoneId: "top" },
      { id: "4", milestoneId: "p20" },
      { id: "5", milestoneId: "top" },
    ];
    expect(byMilestonePriority(items, ranks).map((i) => i.id)).toEqual(["3", "5", "1", "4", "2"]);
  });
});

let tmp: string;
let db: DB;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s5-"));
  for (const n of ["1", "2"]) {
    const dir = path.join(tmp, `repo${n}`);
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/spines/root.md"), spine(n));
    // repo1's root has a child spine, tracked as its own milestone too (the code repo's tree holds, the owner's top root).
    if (n === "1") fs.writeFileSync(path.join(dir, "docs/spines/root.md"), `${spine(n)}| [EPIC-C](child.md) | Child | none | active |\n`);
    if (n === "1") fs.writeFileSync(path.join(dir, "docs/spines/child.md"), spine("C").replace("Integration policy", "Parent spine: root.md\nIntegration policy"));
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

describe("API order", () => {
  const setup = () => {
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const app = createApp(db, { read: readCfg, review: { live: { fetch: ok, consoleHosts: [] } } });
    return async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
  };

  it("waiting-on-owner, status items and review items: the top milestone's first; ties keep their order", async () => {
    const call = setup();
    const m1 = (await call("POST", "/api/milestones", { title: "One", repo: "Acme/repo1", path: "docs/spines/root.md" })).json;
    const m2 = (await call("POST", "/api/milestones", { title: "Two", repo: "Acme/repo2", path: "docs/spines/root.md" })).json;
    // review cards are spine rows in review (a spine beside each root, its parent).
    const rows = (n: string, list: [string, string, string][]) =>
      fs.writeFileSync(
        path.join(tmp, `repo${n}`, "docs/spines/reviews.md"),
        `# EPIC-R${n}: Reviews\n\nParent spine: [root](root.md)\nProject name: [Repo ${n}](https://x.dev/)\nGoal sentence: We want the reviews to work.\n\n## Issue Ledger\n\n| Issue | Title | Status | Latest Evidence | Last Verified | Next Action |\n|---|---|---|---|---|---|\n${list.map(([id, t, d]) => `| ${id} | ${t} | review | https://x.dev/${id} | ${d} | followups: none; confirm: yes |`).join("\n")}\n`,
      );
    // each row's card file
    for (const [n, ids] of [["1", ["R1-S1", "R1-S2"]], ["2", ["R2-S1"]]] as const) for (const id of ids) addCard(path.join(tmp, `repo${n}`), id, `https://x.dev/${id}`);
    rows("1", [["R1-S1", "r1 old", "2026-11-01"], ["R1-S2", "r1 new", "2026-11-02"]]);
    rows("2", [["R2-S1", "r2", "2026-11-01"]]);

    const codes = async () => ((await call("GET", "/api/waiting-on-owner")).json as { code?: string; state: string }[]).filter((i) => i.state === "open").map((i) => i.code);
    const statusMs = async () => ((await call("GET", "/api/status")).json.items as { milestoneId: string; state: string }[]).filter((i) => i.state === "open").map((i) => i.milestoneId);
    const reviews = async () => {
      await call("GET", "/api/review-items");
      await new Promise((r) => setTimeout(r, 30)); // the first read checks the links
      return ((await call("GET", "/api/review-items")).json as { title: string }[]).map((i) => i.title);
    };

    // No big roots: created order (One, then Two); review items of one milestone most recently verified first.
    expect(await codes()).toEqual(["E901-A1", "EC-A1", "E902-A1"]);
    expect(await statusMs()).toEqual([m1.id, m1.id, m2.id]);
    expect(await reviews()).toEqual(["r1 new", "r1 old", "r2"]);

    // Two becomes the owner's top milestone: its cards lead every list.
    expect((await call("PATCH", `/api/milestones/${m2.id}`, { bigRoot: 1 })).status).toBe(200);
    expect(await codes()).toEqual(["E902-A1", "E901-A1", "EC-A1"]);
    expect(await statusMs()).toEqual([m2.id, m1.id, m1.id]);
    expect(await reviews()).toEqual(["r2", "r1 new", "r1 old"]);
  });

  it("a child spine's ask, listed under its parent's milestone too, follows the child's milestone when that one is on top", async () => {
    const call = setup();
    const root = (await call("POST", "/api/milestones", { title: "Root", repo: "Acme/repo1", path: "docs/spines/root.md" })).json;
    const two = (await call("POST", "/api/milestones", { title: "Two", repo: "Acme/repo2", path: "docs/spines/root.md" })).json;
    const child = (await call("POST", "/api/milestones", { title: "Child", repo: "Acme/repo1", path: "docs/spines/child.md" })).json;
    const waiting = async () => ((await call("GET", "/api/waiting-on-owner")).json as { code?: string; state: string; priority?: number }[]).filter((i) => i.state === "open");
    const status = async () => ((await call("GET", "/api/status")).json.items as { code?: string; state: string; priority?: number }[]).filter((i) => i.state === "open");
    expect((await waiting()).map((i) => i.code)).toEqual(["E901-A1", "EC-A1", "E902-A1"]);
    expect((await status()).map((i) => i.code)).toEqual(["E901-A1", "EC-A1", "E902-A1"]);
    expect((await call("PATCH", `/api/milestones/${child.id}`, { bigRoot: 1 })).status).toBe(200);
    expect((await waiting()).map((i) => [i.code, i.priority])).toEqual([["EC-A1", 1], ["E901-A1", 2], ["E902-A1", 3]]);
    expect((await status()).map((i) => [i.code, i.priority])).toEqual([["EC-A1", 1], ["E901-A1", 2], ["E902-A1", 3]]);
    void root;
    void two;
  });
});
