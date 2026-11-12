import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, spinesPyRunner } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore } from "../src/store.js";
import { milestoneStatus } from "../src/status/compute.js";
import { markIn, notJordi, setStatus, writeOutcome, type MarkInput } from "../src/status/mark.js";
import { OUTCOME_RULE } from "../src/wakePrompt.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/** the owner's Outcome mark, the Ready to mark item, Settle only after the mark. */

const SPINE = `# PLAN-3: Child

Spine ID: PLAN-3
Root spine: self
Integration policy: main-direct

## Goal
Child goal.

## Done means

- [x] E3-1 the thing works
- [x] E3-2 the thing is live

## Current State
Owner: Delivery manager
Status: review
Last attempted: 2026-10-24 built it
Waiting on: none
Next action: Sam marks
Verified at: 2026-10-24

## Outcome

Outcome: The thing works and is live.
Risk: none

| Done means | Evidence |
|---|---|
| E3-1 the thing works | abc1234 |
| E3-2 the thing is live | curl 200 |

## Non-Goals

None.

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-22 | accepted | built it | ok | x | — |
`;

const MARK: MarkInput = {
  verdict: "accomplished",
  sentence: "The thing works and is live.",
  risk: "none",
  note: "checked it myself",
  evidence: [
    { doneMeans: "E3-1 the thing works", evidence: "abc1234" },
    { doneMeans: "E3-2 the thing is live", evidence: "curl 200" },
  ],
};

describe("T13-S2 pure edits", () => {
  it("writes ## Outcome in place: Verdict, Outcome, Closed by Sam, Risk, the evidence table; Status done; a Decisions row", () => {
    const out = writeOutcome(SPINE, MARK, "2026-10-25");
    expect(out).toContain(
      [
        "## Outcome",
        "",
        "Verdict: accomplished",
        "Outcome: The thing works and is live.",
        "Closed: 2026-10-25 by Sam (console)",
        "Risk: none",
        "",
        "| Done means | Evidence |",
        "|---|---|",
        "| E3-1 the thing works | abc1234 |",
        "| E3-2 the thing is live | curl 200 |",
        "",
        "## Non-Goals",
      ].join("\n"),
    );
    expect(out.match(/^## Outcome/gm)).toHaveLength(1);
    expect(out).toMatch(/^Status: done$/m);
    expect(out).toContain("| 2026-10-25 | accepted | Sam via console: outcome marked accomplished, Status done | checked it myself | ## Outcome | — |");
  });

  it("inserts ## Outcome after Current State when there is none; Partially leaves Status, Superseded sets it", () => {
    const bare = SPINE.slice(0, SPINE.indexOf("## Outcome")) + SPINE.slice(SPINE.indexOf("## Non-Goals"));
    const out = writeOutcome(bare, { ...MARK, verdict: "partially", evidence: [] }, "2026-10-25");
    expect(out).toContain("Verified at: 2026-10-24\n\n## Outcome\n\nVerdict: partially accomplished\n");
    expect(out).toContain("Risk: none\n\n## Non-Goals");
    expect(out).toMatch(/^Status: review$/m);
    expect(writeOutcome(bare, { ...MARK, verdict: "superseded" }, "2026-10-25")).toMatch(/^Status: superseded$/m);
    expect(setStatus("## Current State\n- **Status:** active\n", "done")).toBe("## Current State\n- **Status:** done\n");
  });

  it("only Sam marks: browser same-origin call, no token, no run id", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(notJordi(h({ "sec-fetch-site": "same-origin" }))).toBeUndefined();
    expect(notJordi(h({}))).toMatch(/only Sam/);
    expect(notJordi(h({ "sec-fetch-site": "cross-site" }))).toMatch(/only Sam/);
    expect(notJordi(h({ "sec-fetch-site": "same-origin", authorization: "Bearer x" }))).toMatch(/token/);
    expect(notJordi(h({ "sec-fetch-site": "same-origin", "x-console-run": "run_1" }))).toMatch(/persona run/);
  });

  it("T14-S7: over plain http (no Sec-Fetch-*) the page's own Origin passes; none, foreign or forged sites do not", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    const IP = { host: "10.104.206.10:8750" };
    // the owner's browser on the tailnet URL sends Origin, never Sec-Fetch-Site
    expect(notJordi(h({ ...IP, origin: "http://10.104.206.10:8750" }))).toBeUndefined();
    // https (the production site): Sec-Fetch-Site same-origin, or its known Origin through the proxy
    expect(notJordi(h({ host: "team.example.com", origin: "https://team.example.com", "sec-fetch-site": "same-origin" }))).toBeUndefined();
    expect(notJordi(h({ host: "127.0.0.1:8750", origin: "https://team.example.com" }))).toBeUndefined();
    // foreign origin, other port, curl with no Origin, opaque origin, a cross-site fetch carrying our Origin text
    expect(notJordi(h({ ...IP, origin: "http://evil.example" }))).toMatch(/only Sam/);
    expect(notJordi(h({ ...IP, origin: "http://10.104.206.10:9999" }))).toMatch(/only Sam/);
    expect(notJordi(h({ ...IP }))).toMatch(/only Sam/);
    expect(notJordi(h({ ...IP, origin: "null" }))).toMatch(/only Sam/);
    expect(notJordi(h({ ...IP, origin: "http://10.104.206.10:8750", "sec-fetch-site": "cross-site" }))).toMatch(/only Sam/);
    // a token or a run header is never the owner, whatever the Origin
    expect(notJordi(h({ ...IP, origin: "http://10.104.206.10:8750", authorization: "Bearer t" }))).toMatch(/token/);
    expect(notJordi(h({ ...IP, origin: "http://10.104.206.10:8750", "x-console-run": "team-desk" }))).toMatch(/persona run/);
    expect(notJordi(h({ ...IP, origin: "http://10.104.206.10:8750", "x-run-id": "run_1" }))).toMatch(/persona run/);
  });

  it("input: verdict required; sentence, risk and evidence default to the spine's Outcome", () => {
    const prev = { verdict: null, sentence: "Old sentence.", risk: "low", evidence: [{ doneMeans: "E3-1", links: ["a", "b"] }], closedAt: null, closedBy: null };
    expect(markIn({ verdict: "done" })).toMatch(/verdict must be/);
    expect(markIn({ verdict: "accomplished" })).toMatch(/outcome sentence/);
    expect(markIn({ verdict: "accomplished", note: 3 })).toMatch(/must be text/);
    expect(markIn({ verdict: "accomplished" }, prev)).toEqual({ verdict: "accomplished", sentence: "Old sentence.", risk: "low", evidence: [{ doneMeans: "E3-1", evidence: "a, b" }] });
    expect(markIn({ verdict: "partially", sentence: " New. ", evidence: [{ doneMeans: "E3-1" }] }, prev)).toMatchObject({ sentence: "New.", evidence: [{ doneMeans: "E3-1", evidence: "" }] });
  });

  it("Ready to mark is a pending item (one open item, flow Needs you); marked or reopened outcomes add none", () => {
    const base = { milestone: { id: "m1", paused: false }, waiting: [], runs: [], assignments: [], doneMeans: { done: 2, total: 2 } };
    const evidence = [{ doneMeans: "E3-1", links: ["x"] }];
    const s = milestoneStatus({ ...base, outcome: { verdict: null, sentence: "x", evidence, risk: null, closedAt: null, closedBy: null } });
    expect(s.outcome.word).toBe("ready_to_mark");
    expect(s.items).toEqual([expect.objectContaining({ id: "ready_to_mark:m1", kind: "ready_to_mark", state: "open", title: expect.stringMatching(/^Review and mark/) })]);
    expect(s.flow.word).toBe("needs_you");
    expect(s.needsYou).toBe(1);
    const marked = milestoneStatus({ ...base, outcome: { verdict: "accomplished", sentence: "x", evidence, risk: null, closedAt: "2026-10-25", closedBy: "Sam (console)" } });
    expect(marked.items).toEqual([]);
  });

  it("personas never mark: the wake rule leaves Verdict to Sam and keeps Status review (NO_SELF_GREEN)", () => {
    expect(OUTCOME_RULE).toMatch(/WITHOUT a `Verdict:` line/);
    expect(OUTCOME_RULE).toMatch(/Only Sam marks the verdict/);
    expect(OUTCOME_RULE).toMatch(/Status: review, never done/);
    expect(OUTCOME_RULE).toMatch(/reopened by <epic>/);
  });
});

// ---------- API, against a real git origin and the real spines.py ----------

const SKILL = [process.env.EPICSPINE_SKILL_DIR, path.join(os.homedir(), "github/epicspine-skill/skill/epic-spine"), path.join(os.homedir(), ".agents/skills/epic-spine")]
  .filter((d): d is string => !!d)
  .find((d) => fs.existsSync(path.join(d, "scripts/spines.py")));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
/** validate_spine.py messages (errors + warnings) of one file. */
const validate = (file: string): string[] => {
  let out: string;
  try {
    out = execFileSync("python3", [path.join(SKILL!, "scripts/validate_spine.py"), "--json", file], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "[]");
  }
  const [r] = JSON.parse(out) as { errors: string[]; warnings: string[] }[];
  return [...r.errors, ...r.warnings];
};

describe.skipIf(!SKILL)("T13-S2 API (git + spines.py)", () => {
  let tmp: string;
  let origin: string;
  let repo: string;
  let db: DB;
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s2-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", "-q", origin, seed);
    git(seed, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(seed, "docs/spines/epic-3.md"), SPINE);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    repo = path.join(tmp, "demo");
    git(tmp, "clone", "-q", origin, repo);
  });
  afterEach(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const setup = () => {
    db = openDb(path.join(tmp, "console.db"));
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], spines: cachedRunner(spinesPyRunner(SKILL!, { timeoutMs: 50_000 })) };
    const app = createApp(db, { read: readCfg });
    const m = createStore(db).createMilestone({ title: "Child", repo: "demo", path: "docs/spines/epic-3.md", owner: "", paused: false });
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    return { call, m };
  };
  const SAM = { "Sec-Fetch-Site": "same-origin" };

  it("ready to mark → item; persona call refused; settle 409; Sam's mark writes + pushes; then settle", async () => {
    const { call, m } = setup();
    const before = validate(path.join(repo, "docs/spines/epic-3.md"));
    const st = (await call("GET", `/api/milestones/${m.id}/status`)).json;
    expect(st.outcome.word).toBe("ready_to_mark");
    expect(st.items.map((i: { kind: string }) => i.kind)).toEqual(["ready_to_mark"]);
    expect((await call("GET", "/api/status")).json.items.some((i: { id: string }) => i.id === `ready_to_mark:${m.id}`)).toBe(true);

    // Settle refused before the mark.
    const early = await call("POST", `/api/milestones/${m.id}/settle`);
    expect(early.status).toBe(409);
    expect(early.json.error).toMatchObject({ code: "not_accomplished", details: { outcome: "ready_to_mark" } });

    // A persona (curl with its run / token, no browser) cannot mark.
    expect((await call("POST", `/api/milestones/${m.id}/mark`, { verdict: "accomplished" })).status).toBe(403);
    expect((await call("POST", `/api/milestones/${m.id}/mark`, { verdict: "accomplished" }, { ...SAM, "X-Console-Run": "run_1" })).status).toBe(403);
    expect((await call("POST", `/api/milestones/${m.id}/mark`, { verdict: "accomplished" }, { ...SAM, Authorization: "Bearer t" })).status).toBe(403);
    expect((await call("POST", `/api/milestones/${m.id}/mark`, { verdict: "nope" }, SAM)).status).toBe(400);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");

    // the owner marks: evidence defaults to the spine's table.
    const r = await call("POST", `/api/milestones/${m.id}/mark`, { verdict: "accomplished", note: "verified on the phone" }, SAM);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ verdict: "accomplished", path: "docs/spines/epic-3.md", sha: expect.any(String) });
    expect(r.json.status.outcome.word).toBe("accomplished");
    expect(r.json.status.items).toEqual([]);
    const text = fs.readFileSync(path.join(repo, "docs/spines/epic-3.md"), "utf8");
    expect(text).toMatch(/^Verdict: accomplished$/m);
    expect(text).toMatch(/^Closed: \d{4}-\d\d-\d\d by Sam \(console\)$/m);
    expect(text).toContain("| E3-2 the thing is live | curl 200 |");
    expect(text).toMatch(/^Status: done$/m);
    expect(text).toMatch(/\| accepted \| Sam via console: outcome marked accomplished, Status done \| verified on the phone \|/);
    expect(git(repo, "log", "-1", "--format=%s", "origin/main")).toBe("Outcome marked accomplished (Sam, via console)");
    // validate_spine.py: nothing new (a done spine with a usable Outcome).
    expect(validate(path.join(repo, "docs/spines/epic-3.md")).filter((x) => !before.includes(x))).toEqual([]);

    // the mark settled it (personas stop waking); Settle stays idempotent, Unsettle works.
    expect(r.json.settled).toBe(true);
    const ok = await call("POST", `/api/milestones/${m.id}/settle`);
    expect(ok.status).toBe(200);
    expect(ok.json.settledAt).toBeTruthy();
    const un = await call("POST", `/api/milestones/${m.id}/unsettle`);
    expect(un.status).toBe(200);
    expect(un.json.settledAt).toBeFalsy();
  }, 120_000);
});
