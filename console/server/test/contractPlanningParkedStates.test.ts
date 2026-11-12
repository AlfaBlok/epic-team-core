import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, spinesPyRunner, type SpinesJson } from "../src/adapters/spines.js";
import { buildTree, type Tree, type TreeNode } from "../src/adapters/tree.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore, type Assignment } from "../src/store.js";
import { milestoneStatus, paintTree, type StatusInput } from "../src/status/compute.js";
import { currentStatus, writeStamp } from "../src/status/stamp.js";
import { selfReadied, selfReadiedLines } from "../src/cycle/selfReady.js";
import { buildWakePrompt, NO_SELF_READY } from "../src/wakePrompt.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * Planning is a state, not an alarm. Draft = Planning, deferred = Parked: never Stalled, never ready; a spine
 * counts its own rows only; the owner alone stamps ready; the next wake list; NO_SELF_READY.
 */
const spine = (id: string, status: string, rows: string) =>
  `# EPIC: ${id}\n\nSpine ID: ${id}\n\n## Current State\n\nOwner: Delivery manager\nStatus: ${status}\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n${rows}\n## Decisions\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n`;
const RUN_STATE: Record<string, string> = { draft: "planning", deferred: "parked", ready: "ready", active: "running" };
const node = (id: string, file: string, status: string, parent: string | null, children: string[] = []) => ({
  id, path: `docs/spines/${file}`, title: `EPIC: ${id}`, parent, status, rollup_status: status, dod: [], children, run_state: RUN_STATE[status], runnable: ["ready", "active"].includes(status),
});
const FILES: [string, string, string][] = [
  ["DRAFT", "draft.md", "draft"],
  ["DEF", "def.md", "deferred"],
  ["RDY", "rdy.md", "ready"],
  ["ACT", "act.md", "active"],
];
const spinesJson = (rootStatus = "active"): SpinesJson =>
  ({
    root: "docs/spines/root.md",
    nodes: [node("root", "root.md", rootStatus, null, FILES.map(([, f]) => `docs/spines/${f}`)), ...FILES.map(([id, f, st]) => node(id, f, st, "docs/spines/root.md"))],
    orphans: [],
    mismatches: [],
  }) as unknown as SpinesJson;

let reposRoot: string;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const seedFiles = (rootStatus = "active") => {
  write("demo/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/demo.git\n`);
  for (const [id, f, st] of FILES) write(`demo/docs/spines/${f}`, spine(id, st, `| ${id}-1 | First | ready |\n| ${id}-2 | Second | ready |\n`));
  write(
    "demo/docs/spines/root.md",
    spine("root", rootStatus, `${FILES.map(([id, f, st]) => `| [${id}](${f}) | ${id} epic | ${st} |`).join("\n")}\n| R-1 | Own step | ready |\n| R-2 | Own idea | draft |\n`),
  );
};
const find = (n: TreeNode, id: string): TreeNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
const M = { id: "ms_root", repo: "Acme/demo", path: "docs/spines/root.md", paused: false, title: "Root" };

const NOW = Date.parse("2026-10-25T10:00:00Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();
const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: "a1", milestoneId: "m1", personaId: "p1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true, writeEnabled: false, writeScope: "", createdAt: iso(-600),
  nextRunAt: iso(30), nextWakeAt: iso(30), ...over,
});
const leaf = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({ key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children: [], flags: [], ready: true, ...over });
const tree = (status: string, runState: string): Tree => ({
  milestoneId: "m1",
  root: { key: "m1", id: "m1", kind: "spine", title: "m1", status, runState, color: status === "active" ? "blue" : "grey", flags: [], children: [leaf("m1/S1")] },
  counts: { grey: 1, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 1, closed: 0, flagged: 0, source: "spines", warnings: [],
});
const input = (status: string, runState: string, over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: { id: "m1", paused: false }, status, tree: tree(status, runState), waiting: [], runs: [], assignments: [], personaName: () => "Delivery Manager", now: NOW, ...over,
});

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e14s4-"));
});
afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

describe("T14-S4 contract: Planning and Parked are states, not alarms", () => {
  // One draft, one deferred, one ready without a persona, one active (no persona either): only the last two are Stalled.
  const FIX = { draft: input("draft", "planning"), deferred: input("deferred", "parked"), ready: input("ready", "ready"), active: input("active", "running") };

  it("draft → planning, deferred → parked, with no pending item; ready / active without a persona → Stalled (an alarm)", () => {
    const s = Object.fromEntries(Object.entries(FIX).map(([k, v]) => [k, milestoneStatus(v)]));
    expect(s.draft.flow.word).toBe("planning");
    expect(s.deferred.flow.word).toBe("parked");
    expect(s.draft.items).toEqual([]);
    expect(s.deferred.items).toEqual([]);
    expect(s.draft.needsYou + s.deferred.needsYou).toBe(0);
    for (const k of ["ready", "active"] as const) {
      expect(s[k].flow.word).toBe("stalled");
      expect(s[k].items.map((i) => i.kind)).toEqual(["stalled"]);
      expect(s[k].needsYou).toBe(0); // Stalled is an alarm, never in the Team badge
    }
  });

  it("planning / parked never produce a pending item, whatever the schedule or persona state", () => {
    for (const [st, rs] of [["draft", "planning"], ["deferred", "parked"]]) {
      for (const assignments of [[], [assignment()], [assignment({ enabled: false, nextWakeAt: undefined })]]) {
        const s = milestoneStatus(input(st, rs, { assignments }));
        expect(s.items).toEqual([]);
        expect(s.flow.word).toBe(rs);
      }
    }
    // Without spines.py run_state (older skill): the Status word decides.
    expect(milestoneStatus(input("draft", "", { tree: undefined })).flow.word).toBe("planning");
    expect(milestoneStatus(input("deferred", "", { tree: undefined })).flow.word).toBe("parked");
  });

  it("an open coded ask still needs Sam on a Planning epic (asks are not produced by the state)", () => {
    const ask = { id: "wj_1", source: "ask", state: "open", code: "M1-A1", milestoneId: "m1", milestoneTitle: "M1", title: "S1", ask: "decide", question: "Q?", contextLinks: [], owner: { kind: "none", label: "" }, decidable: false } as never;
    const s = milestoneStatus(input("draft", "planning", { waiting: [ask] }));
    expect(s.flow.word).toBe("needs_you");
    expect(s.items.map((i) => i.kind)).toEqual(["ask"]);
  });
});

describe("T14-S4 tree: rows in a draft / deferred spine are never ready; a spine counts its own rows only", () => {
  it("only rows of runnable spines are 'ready · nobody on it'", () => {
    seedFiles();
    const t = buildTree(reposRoot, M, spinesJson());
    expect(find(t.root, "DRAFT-1")!.ready).toBeUndefined();
    expect(find(t.root, "DEF-1")!.ready).toBeUndefined();
    expect(find(t.root, "RDY-1")!.ready).toBe(true);
    expect(find(t.root, "ACT-1")!.ready).toBe(true);
    expect(find(t.root, "R-1")!.ready).toBe(true);
    expect(find(t.root, "R-2")!.ready).toBeUndefined();
    // A draft root: none of its rows (nor its children's) are ready.
    seedFiles("draft");
    const d = buildTree(reposRoot, M, spinesJson("draft"));
    const ready: string[] = [];
    const walk = (n: TreeNode) => (n.ready && ready.push(n.id), n.children.forEach(walk));
    walk(d.root);
    expect(ready).toEqual([]);
  });

  it("the root's total equals its own rows (+ one roll-up line per child); no double count with a child's tree", () => {
    seedFiles();
    const t = buildTree(reposRoot, M, spinesJson());
    const total = (x: Tree) => Object.values(x.counts).reduce((a, b) => a + b, 0);
    // root + 4 child epic lines + R-1 + R-2; the children's 8 rows are not here.
    expect(total(t)).toBe(1 + 4 + 2);
    expect(t.planning).toBe(2); // DRAFT and R-2
    expect(t.parked).toBe(1); // DEF
    // Each child, as its own milestone, counts its own two rows: the sum over milestones counts every row once.
    const kids = FILES.map(([, f]) => buildTree(reposRoot, { ...M, id: `ms_${f}`, path: `docs/spines/${f}` }, spinesJson()));
    for (const k of kids) expect(total(k)).toBe(1 + 2);
    const rows = (x: Tree) => {
      const ids: string[] = [];
      const walk = (n: TreeNode, top: boolean) => {
        if (n.kind === "ticket") ids.push(n.id);
        if (top || n.kind !== "spine") n.children.forEach((c) => walk(c, false));
      };
      walk(x.root, true);
      return ids;
    };
    const all = [t, ...kids].flatMap(rows);
    expect(all.length).toBe(new Set(all).size);
    expect(all.length).toBe(2 + 8);
    // paintTree keeps the same scope.
    expect(total(paintTree(t, []))).toBe(7);
  });
});

describe("T14-S4 NO_SELF_READY", () => {
  it("is in every wake prompt, next to NO_SELF_GREEN", () => {
    const p = buildWakePrompt({ name: "DM", remit: "r", skills: [] }, { title: "T", repo: "r", path: "p", owner: "" });
    expect(p).toContain(NO_SELF_READY);
    // ready comes from the owner, his ask included (cited in Decisions); never an agent's own idea.
    expect(NO_SELF_READY).toMatch(/Never change a spine's or a row's Status from draft to ready on your own idea: ready comes from Sam/);
  });

  it("finds Status lines and ledger rows a diff turns from draft to ready, nothing else", () => {
    const diff = [
      "diff --git a/docs/spines/x.md b/docs/spines/x.md",
      "+++ b/docs/spines/x.md",
      "@@ -5 +5 @@",
      "-Status: draft",
      "+Status: ready",
      "@@ -20,2 +20,2 @@",
      "-| X-1 | Ready the deck | draft |",
      "+| X-1 | Ready the deck | ready |",
      "-| X-2 | Two | ready |",
      "+| X-2 | Two | done |",
      "@@ -30 +30 @@",
      "-Status: ready",
      "+Status: draft",
      "@@ -40 +40 @@",
      "-Next action: draft it",
      "+Next action: ready it",
    ].join("\n");
    expect(selfReadiedLines(diff)).toEqual(["docs/spines/x.md: Status: ready", "docs/spines/x.md: | X-1 | Ready the deck | ready |"]);
  });
});

// ---------- API: stamp (the owner only), next wake, self-readied, against a real git origin ----------

const SKILL = [process.env.EPICSPINE_SKILL_DIR, path.join(os.homedir(), "github/epicspine-skill/skill/epic-spine"), path.join(os.homedir(), ".agents/skills/epic-spine")]
  .filter((d): d is string => !!d)
  .find((d) => fs.existsSync(path.join(d, "scripts/spines.py")));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

describe("T14-S4 stamp edits", () => {
  it("draft → ready with a Decisions row; ready → draft; refuses any other status", () => {
    const text = spine("X", "draft", "| X-1 | One | ready |\n");
    const out = writeStamp(text, "ready", "2026-10-25") as string;
    expect(currentStatus(out)).toBe("ready");
    expect(out).toMatch(/\| 2026-10-25 \| accepted \| stamped ready by Sam 2026-10-25 \|/);
    const back = writeStamp(out, "draft", "2026-10-26") as string;
    expect(currentStatus(back)).toBe("draft");
    expect(back).toMatch(/moved back to Planning \(draft\) by Sam 2026-10-26/);
    expect(writeStamp(spine("X", "active", ""), "ready", "d")).toEqual({ skip: expect.stringMatching(/only a Planning \(draft\) epic is stamped ready/) });
    expect(writeStamp(text, "draft", "d")).toEqual({ skip: expect.stringMatching(/only a ready epic moves back/) });
  });
});

describe.skipIf(!SKILL)("T14-S4 API (git + spines.py)", () => {
  let origin: string;
  let repo: string;
  let db: DB;
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    origin = path.join(reposRoot, "origin.git");
    git(reposRoot, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(reposRoot, "seed");
    git(reposRoot, "clone", "-q", origin, seed);
    git(seed, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(seed, "docs/spines/epic-5.md"), spine("PLAN-5", "draft", "| E5-1 | First | ready |\n"));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    repo = path.join(reposRoot, "demo");
    git(reposRoot, "clone", "-q", origin, repo);
  });
  afterEach(() => {
    db?.close();
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const setup = () => {
    db = openDb(path.join(reposRoot, "console.db"));
    const readCfg: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [], spines: cachedRunner(spinesPyRunner(SKILL!, { timeoutMs: 50_000 })) };
    const app = createApp(db, { read: readCfg });
    const store = createStore(db);
    const m = store.createMilestone({ title: "Five", repo: "demo", path: "docs/spines/epic-5.md", owner: "", paused: false });
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    return { call, m, store };
  };
  const SAM = { "Sec-Fetch-Site": "same-origin" };

  it("Planning epic: next wake lists nothing; persona stamp refused (403); Sam stamps ready → listed with persona + time; moves back", async () => {
    const { call, m, store } = setup();
    const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: false, host: "host1" });
    store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.flow.word).toBe("planning");
    expect((await call("GET", "/api/next-wake")).json.items).toEqual([]);

    // Personas never stamp: no browser, a run id, a token.
    expect((await call("POST", `/api/milestones/${m.id}/stamp`, { to: "ready" })).status).toBe(403);
    expect((await call("POST", `/api/milestones/${m.id}/stamp`, { to: "ready" }, { ...SAM, "X-Console-Run": "run_1" })).status).toBe(403);
    expect((await call("POST", `/api/milestones/${m.id}/stamp`, { to: "ready" }, { ...SAM, Authorization: "Bearer t" })).status).toBe(403);
    expect((await call("POST", `/api/milestones/${m.id}/stamp`, { to: "go" }, SAM)).status).toBe(400);
    expect((await call("POST", `/api/milestones/${m.id}/stamp`, { to: "ready", path: "docs/other.md" }, SAM)).status).toBe(400);
    expect((await call("POST", `/api/milestones/${m.id}/stamp`, { to: "draft" }, SAM)).status).toBe(409); // not ready yet
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");

    const r = await call("POST", `/api/milestones/${m.id}/stamp`, { to: "ready" }, SAM);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ to: "ready", path: "docs/spines/epic-5.md", sha: expect.any(String) });
    const text = fs.readFileSync(path.join(repo, "docs/spines/epic-5.md"), "utf8");
    expect(text).toMatch(/^Status: ready$/m);
    expect(text).toMatch(/stamped ready by Sam \d{4}-\d\d-\d\d/);
    expect(git(repo, "log", "-1", "--format=%s", "origin/main")).toBe("Stamped ready for delivery (Sam, via console)");

    const nw = (await call("GET", `/api/next-wake?milestoneId=${m.id}`)).json.items;
    expect(nw).toEqual([
      expect.objectContaining({ kind: "epic", title: "Five", milestoneId: m.id, persona: "Delivery Manager", at: expect.any(String) }),
      expect.objectContaining({ kind: "row", id: "E5-1", persona: "Delivery Manager" }),
    ]);
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.flow.word).not.toBe("planning");

    const back = await call("POST", `/api/milestones/${m.id}/stamp`, { to: "draft" }, SAM);
    expect(back.status).toBe(201);
    expect(fs.readFileSync(path.join(repo, "docs/spines/epic-5.md"), "utf8")).toMatch(/^Status: draft$/m);
    expect((await call("GET", "/api/next-wake")).json.items).toEqual([]);
  }, 120_000);

  it("a finished run whose own commit readied a draft spine is flagged self-readied", async () => {
    const { call, m, store } = setup();
    const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    const run = store.createRun({ assignmentId: a.id, milestoneId: m.id, startedAt: new Date(Date.now() - 60_000).toISOString(), outcome: "running", summary: "waking" } as never);
    const f = path.join(repo, "docs/spines/epic-5.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("Status: draft", "Status: ready"));
    git(repo, "commit", "-qam", `PLAN-5: go\n\nRun: ${run.id}`);
    expect((await call("PATCH", `/api/runs/${run.id}`, { outcome: "progressed", summary: "outcome: progressed: did it", endedAt: new Date().toISOString() })).status).toBe(200);
    let flagged: string[] | undefined;
    for (let i = 0; i < 100 && !flagged; i++) {
      await new Promise((r) => setTimeout(r, 100));
      flagged = store.getRun(run.id)?.selfReadied;
    }
    expect(flagged).toEqual(["docs/spines/epic-5.md: Status: ready"]);
    // Another run's commit is not this run's.
    expect(await selfReadied(repo, "run_other", new Date(Date.now() - 60_000).toISOString())).toEqual([]);
  }, 120_000);
});
