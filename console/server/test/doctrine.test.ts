import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { doctrineFor, doctrineLookup, fixtureRunner, parseSpinesJson, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import { readConfigFromEnv, type ReadConfig } from "../src/routes/read.js";
import { makeFixtureRoot } from "./fixtures.js";

const FIXTURE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "spines-doctrine2.json");
const D2: SpinesJson = parseSpinesJson(fs.readFileSync(FIXTURE_FILE, "utf8"));
const EPIC4 = "docs/EPIC-904-DOCTRINE-2.md";

describe("doctrineFor (console contract mapping)", () => {
  it("maps every field; root taken from parent: null, not a hardcoded path", () => {
    expect(doctrineFor(D2, EPIC4)).toEqual({
      goal: "Every epic states its goal and how it serves its parent, so humans and agents read one plan top-down.",
      serves: "Gives EPIC-900 a tree whose every node explains itself, which the console and the agents both read.",
      servesChain: [{ path: "docs/EPIC-900-OPERATING-SYSTEM.md", title: "EPIC-900: EpicSpine operating system" }],
      children: [
        { path: "docs/EPIC-903-EPIC-LOG.md", title: "EPIC-903: Epic log", status: "done", contributes: "Discovers the epic tree that the doctrine fields hang on." },
        { path: "docs/EPIC-905-CONSOLE-OVERVIEW.md", title: "EPIC-905: Console overview", status: "ready" }, // no sentence → no contributes
      ],
      doneMeans: D2.nodes[1].done_means,
      pages: D2.nodes[1].pages,
      missingSections: [],
      size: { lines: 120, long_cells: 3 },
    });
  });

  it("walks the serves chain up to the root, each ancestor with its own serves; ./ paths match", () => {
    const d = doctrineFor(D2, "./docs/EPIC-903-EPIC-LOG.md")!;
    expect(d.serves).toBe("Discovers the epic tree that the doctrine fields hang on.");
    expect(d.servesChain).toEqual([
      { path: EPIC4, title: "EPIC-904: Doctrine 2", serves: "Gives EPIC-900 a tree whose every node explains itself, which the console and the agents both read." },
      { path: "docs/EPIC-900-OPERATING-SYSTEM.md", title: "EPIC-900: EpicSpine operating system" },
    ]);
    expect(doctrineFor(D2, "docs/EPIC-905-CONSOLE-OVERVIEW.md")).toEqual({
      servesChain: expect.any(Array),
      missingSections: ["goal", "serves"],
    });
  });

  it("guards against parent cycles and dangling parents", () => {
    const node = (p: string, parent: string | null) => ({ id: p, path: p, title: p, parent, status: "active", rollup_status: "active", dod: [], children: [], serves: `s-${p}` });
    const cyc: SpinesJson = { root: null, nodes: [node("a.md", "b.md"), node("b.md", "c.md"), node("c.md", "a.md")], orphans: [], mismatches: [] };
    expect(doctrineFor(cyc, "a.md")!.servesChain!.map((x) => x.path)).toEqual(["b.md", "c.md"]);
    const dangling: SpinesJson = { root: null, nodes: [node("a.md", "gone.md")], orphans: [], mismatches: [] };
    expect(doctrineFor(dangling, "a.md")).toEqual({ serves: "s-a.md" });
  });

  it("today's shape (no doctrine fields) and absent nodes give nothing", () => {
    const today: SpinesJson = {
      root: "docs/EPIC-900-X.md",
      nodes: [{ id: "EPIC-900", path: "docs/EPIC-900-X.md", title: "EPIC-900", type: "root", parent: null, status: "active", rollup_status: "active", dod: [], children: [] }],
      orphans: [],
      mismatches: [],
    };
    expect(doctrineFor(today, "docs/EPIC-900-X.md")).toBeUndefined();
    expect(doctrineFor(D2, "docs/nope.md")).toBeUndefined();
    // null goal/serves are omitted, not rendered
    const nulls = { ...today, nodes: [{ ...today.nodes[0], goal: null, serves: null }] };
    expect(doctrineFor(nulls, "docs/EPIC-900-X.md")).toBeUndefined();
  });

  it("lookup: failure → undefined; slow run → answers within softMs from the last good output", async () => {
    expect(await doctrineLookup(async () => { throw new Error("boom"); })("/r", EPIC4)).toBeUndefined();
    let slow = false;
    const run: SpinesRunner = () => (slow ? new Promise((r) => setTimeout(() => r(D2), 2_000)) : Promise.resolve(D2));
    const look = doctrineLookup(run, 50);
    expect((await look("/r", EPIC4))?.goal).toMatch(/^Every epic/);
    slow = true;
    const t = Date.now();
    expect((await look("/r", EPIC4))?.goal).toMatch(/^Every epic/); // last good
    expect(await look("/other", EPIC4)).toBeUndefined(); // no last good for that repo
    expect(Date.now() - t).toBeLessThan(1_500);
  });
});

describe("GET /api/milestones/:id doctrine", () => {
  let fx: ReturnType<typeof makeFixtureRoot>;
  let dbDir: string;
  let db: DB;
  beforeEach(() => {
    fx = makeFixtureRoot();
    fx.write("epicspine-skill/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/epicspine-skill.git\n`);
    fx.write(`epicspine-skill/${EPIC4}`, "# EPIC-904: Doctrine 2\n\n## Current State\n\nStatus: active\n\n## Definition Of Done\n\n- [x] a\n- [ ] b\n");
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-doctrine-db-"));
    db = openDb(path.join(dbDir, "c.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fx.cleanup();
  });
  const appWith = (spines?: SpinesRunner) => {
    const cfg: ReadConfig = { reposRoot: fx.root, seatsFile: path.join(fx.root, "seats.json"), listThreads: async () => [], spines };
    return createApp(db, { read: cfg });
  };
  const getMs = async (app: ReturnType<typeof createApp>, repo: string, p: string) => {
    const created = await (
      await app.request("/api/milestones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "m", repo, path: p, owner: "Sam" }) })
    ).json();
    const res = await app.request(`/api/milestones/${created.id}`);
    expect(res.status).toBe(200);
    return res.json();
  };

  it("adds doctrine from the fixture runner; existing derived fields unchanged", async () => {
    const without = await getMs(appWith(undefined), "Acme/epicspine-skill", EPIC4);
    const m = await getMs(appWith(fixtureRunner(FIXTURE_FILE)), "Acme/epicspine-skill", EPIC4);
    expect(without.doctrine).toBeUndefined();
    expect(m.doctrine.children.map((c: any) => c.path)).toEqual(["docs/EPIC-903-EPIC-LOG.md", "docs/EPIC-905-CONSOLE-OVERVIEW.md"]);
    // nonGreen (tree, now on the detail too) differs: with a runner the tree comes from spines.py.
    // docTitle (the spine's own title): spines.py node title, else the file's H1 (same text here).
    const { doctrine, id, createdAt, nonGreen, ...rest } = m;
    const { id: _i, createdAt: _c, nonGreen: _n, ...restWithout } = without;
    expect(m.docTitle).toBe("EPIC-904: Doctrine 2");
    expect(rest).toEqual(restWithout);
    expect(m).toMatchObject({ status: "active", dod: { done: 1, total: 2 } });
  });

  it("spines failure, node absent, unreadable file: no doctrine, still 200", async () => {
    const failing = appWith(async () => { throw new Error("spines.py missing"); });
    expect((await getMs(failing, "Acme/epicspine-skill", EPIC4)).doctrine).toBeUndefined();
    const ok = appWith(fixtureRunner(FIXTURE_FILE));
    expect((await getMs(ok, "ops", "docs/EPIC-900-VPS-FLEET.md")).doctrine).toBeUndefined();
    expect((await getMs(ok, "nope", EPIC4)).docError).toMatch(/repo nope/);
  });

  it("CONSOLE_SPINES_FIXTURE replaces the spines.py runner", async () => {
    const cfg = readConfigFromEnv({ CONSOLE_SPINES_FIXTURE: FIXTURE_FILE, EPICSPINE_SKILL_DIR: "/nonexistent", REPOS_ROOT: fx.root, CONSOLE_GH: "0" });
    expect((await cfg.spines!("/anything")).root).toBe("docs/EPIC-900-OPERATING-SYSTEM.md");
  });
});
