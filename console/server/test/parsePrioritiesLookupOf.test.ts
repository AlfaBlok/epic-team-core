import { addCard } from "./reviewFixture.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { byMilestonePriority, TIER_SPAN } from "../src/inbox/priority.js";
import { lookupOf, parsePriorities, worldPriorities } from "../src/inbox/jordiPriority.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { ReadModelHost } from "../src/readModel/host.js";
// example codes (epic numbers from 900 up): a one-digit epic number n reads as 90n
const ex = (n: string | number): string => (/^\d$/.test(String(n)) ? `90${n}` : String(n));
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * the Prioritizer writes the owner's level per open epic and row into
 * docs/priorities.json; the inbox lists sort by it first (high, normal and unranked, low), then by milestone.
 */

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


describe("parsePriorities / lookupOf", () => {
  const file = JSON.stringify({
    version: 1,
    at: "2026-11-10T05:00:00Z",
    items: [
      { repo: "repo1", ref: "EPIC-901", path: "docs/spines/root.md", level: "low", why: "Not what he talks about now." },
      { repo: "repo1", ref: "R1-S1", level: "high", why: "He asked for it today.", words: "get fucking going", said: "2026-11-10", source: "vn_x" },
      { repo: "repo1", ref: "R1-S2", level: "urgent", why: "bad level" },
      { repo: "repo1", ref: "R1-S3", level: "high" },
    ],
  });
  it("keeps good entries, skips a bad level or a missing why, and dates them by the file", () => {
    const e = parsePriorities(file, "repo1");
    expect(e.map((x) => x.ref)).toEqual(["EPIC-901", "R1-S1"]);
    expect(e[1]).toMatchObject({ level: "high", words: "get fucking going", said: "2026-11-10", at: "2026-11-10" });
    expect(parsePriorities("{not json", "repo1")).toEqual([]);
  });
  it("finds a row by its code, else its epic by spine file, never another repo's", () => {
    const look = lookupOf(parsePriorities(file, "repo1"));
    expect(look({ repo: "repo1", ref: "R1-S1", path: "docs/spines/root.md" })?.level).toBe("high");
    expect(look({ repo: "repo1", row: "R1-S1" })?.level).toBe("high");
    expect(look({ repo: "repo1", code: "E901-A1", path: "docs/spines/root.md" })?.level).toBe("low");
    expect(look({ repo: "repo2", ref: "R1-S1", path: "docs/spines/root.md" })).toBeUndefined();
    expect(look({ ref: "R1-S1" })).toBeUndefined();
  });
  it("an ask in the root spine takes its epic's level from its code; a number two epics share matches nothing", () => {
    const look = lookupOf(
      parsePriorities(
        JSON.stringify({
          items: [
            { repo: "home_repo", ref: "EPIC-959", path: "docs/spines/epic-959.md", level: "high", why: "Security first." },
            { repo: "memo", ref: "EPIC-900", path: "docs/a.md", level: "low", why: "a" },
            { repo: "memo", ref: "EPIC-900", path: "docs/b.md", level: "high", why: "b" },
          ],
        }),
        "home_repo",
      ),
    );
    expect(look({ repo: "home_repo", code: "E959-A7", path: "docs/spines/root.md", row: "E959-S13" })?.why).toBe("Security first.");
    expect(look({ repo: "home_repo", code: "E905-A1", path: "docs/spines/root.md" })).toBeUndefined();
    expect(look({ repo: "memo", code: "E900-A1" })).toBeUndefined();
    expect(look({ repo: "memo", code: "E900-A1", path: "docs/b.md" })?.why).toBe("b");
  });
  it("sorts high, then normal and unranked, then low; the milestone order breaks ties; priority carries both", () => {
    const look = lookupOf(parsePriorities(file, "repo1"));
    const ranks = new Map([
      ["top", 0],
      ["two", 1],
    ]);
    const items = [
      { id: "a", milestoneId: "top", repo: "repo1", path: "docs/spines/root.md", code: "E901-A1" },
      { id: "b", milestoneId: "two", repo: "repo2" },
      { id: "c", milestoneId: "two", repo: "repo1", ref: "R1-S1" },
      { id: "d", milestoneId: "top", repo: "repo2" },
    ];
    const out = byMilestonePriority(items, ranks, look);
    expect(out.map((i) => i.id)).toEqual(["c", "d", "b", "a"]);
    expect(out.map((i) => i.priority)).toEqual([TIER_SPAN + 2, 2 * TIER_SPAN + 1, 2 * TIER_SPAN + 2, 3 * TIER_SPAN + 1]); // tier 0 is the red line
    expect(out[0].ownerPriority).toMatchObject({ level: "high", why: "He asked for it today." });
    expect(out[1].ownerPriority).toBeUndefined();
    // without a lookup nothing changes
    expect(byMilestonePriority(items, ranks).map((i) => i.id)).toEqual(["a", "d", "b", "c"]);
  });
});

let tmp: string;
let db: DB;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s34-"));
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

describe("API order with Sam's levels", () => {
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

  it("waiting-on-owner, status items and review items follow docs/priorities.json, each with its why", async () => {
    const call = setup();
    const m1 = (await call("POST", "/api/milestones", { title: "One", repo: "Acme/repo1", path: "docs/spines/root.md" })).json;
    const m2 = (await call("POST", "/api/milestones", { title: "Two", repo: "Acme/repo2", path: "docs/spines/root.md" })).json;
    const rows = (n: string, list: [string, string, string][]) =>
      fs.writeFileSync(
        path.join(tmp, `repo${n}`, "docs/spines/reviews.md"),
        `# EPIC-R${n}: Reviews\n\nParent spine: [root](root.md)\nProject name: [Repo ${n}](https://x.dev/)\nGoal sentence: We want the reviews to work.\n\n## Issue Ledger\n\n| Issue | Title | Status | Latest Evidence | Last Verified | Next Action |\n|---|---|---|---|---|---|\n${list.map(([id, t, d]) => `| ${id} | ${t} | review | https://x.dev/${id} | ${d} | followups: none; confirm: yes |`).join("\n")}\n`,
      );
    for (const [n, ids] of [["1", ["R1-S1", "R1-S2"]], ["2", ["R2-S1"]]] as const) for (const id of ids) addCard(path.join(tmp, `repo${n}`), id, `https://x.dev/${id}`);
    rows("1", [["R1-S1", "r1 old", "2026-11-01"], ["R1-S2", "r1 new", "2026-11-02"]]);
    rows("2", [["R2-S1", "r2", "2026-11-01"]]);
    const codes = async () => ((await call("GET", "/api/waiting-on-owner")).json as { code?: string; state: string }[]).filter((i) => i.state === "open").map((i) => i.code);
    const statusMs = async () => ((await call("GET", "/api/status")).json.items as { milestoneId: string; state: string }[]).filter((i) => i.state === "open").map((i) => i.milestoneId);
    const reviews = async () => {
      await call("GET", "/api/review-items");
      await new Promise((r) => setTimeout(r, 30));
      return (await call("GET", "/api/review-items")).json as { title: string; ownerPriority?: { level: string; why: string } }[];
    };
    // no file yet: the milestone order, as before
    expect(await codes()).toEqual(["E901-A1", "EC-A1", "E902-A1"]);
    expect((await reviews()).map((i) => i.title)).toEqual(["r1 new", "r1 old", "r2"]);

    // the Prioritizer's file (in repo1, the world's home repo): repo2's epic high, repo1's root low, r1 old high
    fs.writeFileSync(
      path.join(tmp, "repo1", "docs/priorities.json"),
      JSON.stringify({
        version: 1,
        at: "2026-11-10T05:00:00Z",
        items: [
          { repo: "repo2", ref: "EPIC-902", path: "docs/spines/root.md", level: "high", why: "He keeps asking for it.", words: "It's time to go", said: "2026-11-10" },
          { repo: "repo1", ref: "EPIC-901", path: "docs/spines/root.md", level: "low", why: "Quiet for two weeks." },
          { repo: "repo1", ref: "R1-S1", level: "high", why: "Named in today's note." },
        ],
      }),
    );
    expect(await codes()).toEqual(["E902-A1", "EC-A1", "E901-A1"]);
    expect(await statusMs()).toEqual([m2.id, m1.id, m1.id]);
    const r = await reviews();
    expect(r.map((i) => i.title)).toEqual(["r1 old", "r1 new", "r2"]);
    expect(r[0].ownerPriority).toMatchObject({ level: "high", why: "Named in today's note." });
    const w = (await call("GET", "/api/waiting-on-owner")).json as { code?: string; ownerPriority?: { level: string; words?: string } }[];
    expect(w.find((i) => i.code === "E902-A1")?.ownerPriority).toMatchObject({ level: "high", words: "It's time to go" });
    const st = (await call("GET", "/api/status")).json.items as { code?: string; ownerPriority?: { level: string } }[];
    expect(st.find((i) => i.code === "E901-A1")?.ownerPriority?.level).toBe("low");
  });

  it("a world reads only the files of the checkouts its milestones track", () => {
    fs.writeFileSync(path.join(tmp, "repo2", "docs/priorities.json"), JSON.stringify({ items: [{ ref: "EPIC-902", path: "docs/spines/root.md", level: "high", why: "x" }] }));
    const store = (repos: string[]) => ({ listMilestones: () => repos.map((repo) => ({ repo })) }) as never;
    expect(worldPriorities(store(["Acme/repo1"]), tmp)).toBeUndefined();
    expect(worldPriorities(store(["Acme/repo2"]), tmp)?.({ repo: "repo2", path: "docs/spines/root.md" })?.level).toBe("high");
  });
});

describe("the stored view (read model) carries Sam's levels too", () => {
  it("GET /api/status from the refresher's view: levels and order from docs/priorities.json", async () => {
    const two = (n: string) => spine(n);
    fs.writeFileSync(path.join(tmp, "repo2", "docs/spines/root.md"), two("2"));
    // the refresher reads a checkout's remote to name it
    for (const n of ["1", "2"]) git(path.join(tmp, `repo${n}`), "remote", "add", "origin", `https://github.com/Acme/repo${n}.git`);
    let host: ReadModelHost | undefined;
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read: readCfg, browser: { browserUrl: "http://127.0.0.1:9" }, readModel: { mode: "in-process", tickMs: 0, onHost: (h) => (host = h) } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return res.json();
    };
    await call("POST", "/api/milestones", { title: "One", repo: "Acme/repo1", path: "docs/spines/root.md" });
    await call("POST", "/api/milestones", { title: "Two", repo: "Acme/repo2", path: "docs/spines/root.md" });
    fs.writeFileSync(
      path.join(tmp, "repo1", "docs/priorities.json"),
      JSON.stringify({ at: "2026-11-10T05:00:00Z", items: [{ repo: "repo2", ref: "EPIC-902", path: "docs/spines/root.md", level: "high", why: "He keeps asking.", words: "go", said: "2026-11-10", source: "x" }] }),
    );
    git(path.join(tmp, "repo1"), "add", "-A");
    git(path.join(tmp, "repo1"), "commit", "-q", "-m", "priorities");
    try {
      await host!.refresher!.tick();
      await host!.refresher!.idle();
      const st = (await call("GET", "/api/status")) as { items: { code?: string; state: string; ownerPriority?: { level: string } }[] };
      const open = st.items.filter((i) => i.state === "open");
      expect(open[0]).toMatchObject({ code: "E902-A1", ownerPriority: { level: "high" } });
    } finally {
      await host?.refresher?.idle();
      host?.close();
    }
  });
});
