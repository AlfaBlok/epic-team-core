import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { listDocs } from "../src/adapters/repos.js";
import {
  cachedRunner,
  docsFromSpines,
  parseSpinesJson,
  pickerDocs,
  resolveSkillDir,
  spinesPyRunner,
  type SpinesJson,
  type SpinesRunner,
} from "../src/adapters/spines.js";
import type { ReadConfig } from "../src/routes/read.js";
import { makeFixtureRoot } from "./fixtures.js";

/** spines.py --json for the fixture the infra repo checkout: root → child, E5 ticket as a leaf, one orphan. */
const FIXTURE: SpinesJson = {
  root: "docs/EPIC-900-VPS-FLEET.md",
  nodes: [
    {
      id: "EPIC-900",
      path: "docs/EPIC-900-VPS-FLEET.md",
      title: "EPIC-900: VPS fleet",
      type: "root",
      parent: null,
      status: "active",
      rollup_status: "blocked",
      dod: [
        { id: "DOD-1", text: "a", done: true },
        { id: "DOD-2", text: "b", done: false },
      ],
      children: ["tickets/E905-fleet-observatory.md"],
    },
    {
      id: "E5",
      path: "tickets/E905-fleet-observatory.md",
      title: "E5: Fleet Observatory",
      type: "leaf",
      parent: "docs/EPIC-900-VPS-FLEET.md",
      status: "ready",
      rollup_status: "ready",
      dod: [{ id: "E5-1", text: "x", done: false }],
      children: [],
    },
  ],
  orphans: [{ path: "docs/one-logger/E4-ONE-LOGGER.md", title: "E4 ONE LOGGER", reason: "not reachable from the root" }],
  mismatches: [],
};

let fx: ReturnType<typeof makeFixtureRoot>;
let tmp: string;
beforeEach(() => {
  fx = makeFixtureRoot();
  fx.write("ops/docs/one-logger/E4-ONE-LOGGER.md", "# E4 ONE LOGGER\n\n## Definition Of Done\n\n- [x] one\n- [ ] two\n");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-spines-"));
});
afterEach(() => {
  fx.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake skill dir whose scripts/spines.py runs `body` (Python). */
function fakeSkill(body: string): string {
  const dir = path.join(tmp, `skill-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "spines.py"), body);
  return dir;
}

describe("spines.py adapter", () => {
  it("parses the contract and rejects other shapes", () => {
    expect(parseSpinesJson(JSON.stringify(FIXTURE))).toEqual(FIXTURE);
    expect(parseSpinesJson(JSON.stringify({ ...FIXTURE, mismatches: undefined })).mismatches).toEqual([]);
    expect(() => parseSpinesJson("{}")).toThrow(/shape/);
    expect(() => parseSpinesJson(JSON.stringify({ ...FIXTURE, nodes: [{ path: 1 }] }))).toThrow(/node/);
    expect(() => parseSpinesJson("not json")).toThrow();
  });

  it("picker list: nodes in tree order with depth, then orphans flagged with the reason, then tickets", () => {
    const repo = path.join(fx.root, "ops");
    const docs = docsFromSpines(repo, FIXTURE, listDocs(repo));
    expect(docs.map((d) => [d.path, d.kind, d.depth, d.orphan])).toEqual([
      ["docs/EPIC-900-VPS-FLEET.md", "spine", 0, undefined],
      ["tickets/E905-fleet-observatory.md", "spine", 1, undefined],
      ["docs/one-logger/E4-ONE-LOGGER.md", "spine", undefined, "not reachable from the root"],
      // E5 is a node, so it is not repeated as a ticket.
      ["tickets/E1-inventory-health-baseline.md", "ticket", undefined, undefined],
      ["tickets/VH-T10-watchdog-alert-delivery.md", "ticket", undefined, undefined],
    ]);
    expect(docs[0]).toEqual({
      path: "docs/EPIC-900-VPS-FLEET.md",
      kind: "spine",
      title: "EPIC-900: VPS fleet",
      status: "active",
      rollupStatus: "blocked",
      dod: { done: 1, total: 2 },
      via: "spines",
      depth: 0,
      parent: null,
      type: "root",
    });
    expect(docs[1]).toMatchObject({ status: "ready", parent: "docs/EPIC-900-VPS-FLEET.md", dod: { done: 0, total: 1 } });
    expect(docs[1].rollupStatus).toBeUndefined(); // same as status
    expect(docs[2]).toMatchObject({ title: "E4 ONE LOGGER", dod: { done: 1, total: 2 }, via: "spines" }); // DoD read locally
    expect(docs.every((d) => d.via === "spines")).toBe(true);
  });

  it("runs the real script path: python3 <skill>/scripts/spines.py --json --repo <dir>", async () => {
    const skill = fakeSkill(
      `import sys\nassert sys.argv[1:3] == ["--json", "--repo"], sys.argv\nprint(${JSON.stringify(JSON.stringify(FIXTURE))})\n`,
    );
    const run = spinesPyRunner(skill, { timeoutMs: 25_000 }); // the 10 s default is tight on a loaded host
    expect(await run(path.join(fx.root, "ops"))).toEqual(FIXTURE);
    const docs = await pickerDocs(path.join(fx.root, "ops"), run);
    expect(docs.filter((d) => d.orphan).map((d) => d.path)).toEqual(["docs/one-logger/E4-ONE-LOGGER.md"]);
  }, 30_000); // spawns python3

  it("falls back to path rules when spines.py fails, prints garbage, times out, or is missing", async () => {
    const repo = path.join(fx.root, "ops");
    const fallback = listDocs(repo).map((d) => ({ ...d, via: "fallback" }));
    const failing = [
      spinesPyRunner(fakeSkill("import sys\nsys.exit(2)\n")),
      spinesPyRunner(fakeSkill("print('hello')\n")),
      spinesPyRunner(fakeSkill("import time\ntime.sleep(5)\n"), { timeoutMs: 300 }),
      spinesPyRunner(path.join(tmp, "missing")),
    ];
    for (const run of failing) expect(await pickerDocs(repo, run)).toEqual(fallback);
    expect(await pickerDocs(repo, undefined)).toEqual(fallback);
  }, 30_000); // spawns python3 four times

  it("resolves the skill dir from EPICSPINE_SKILL_DIR (symlinks followed), else the default locations", () => {
    const skill = fakeSkill("");
    const link = path.join(tmp, "epic-spine-link");
    fs.symlinkSync(skill, link);
    expect(resolveSkillDir({ EPICSPINE_SKILL_DIR: link }, fx.root)).toBe(fs.realpathSync(skill));
    expect(resolveSkillDir({ EPICSPINE_SKILL_DIR: path.join(tmp, "nope") }, fx.root)).toBeUndefined();
    const home = path.join(tmp, "home");
    expect(resolveSkillDir({}, home)).toBeUndefined();
    fs.mkdirSync(path.join(home, ".agents/skills/epic-spine/scripts"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents/skills/epic-spine/scripts/spines.py"), "");
    expect(resolveSkillDir({}, home)).toBe(fs.realpathSync(path.join(home, ".agents/skills/epic-spine")));
    fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(skill, path.join(home, ".claude/skills/epic-spine")); // ~/.claude wins over ~/.agents
    expect(resolveSkillDir({}, home)).toBe(fs.realpathSync(skill));
  });

  // The installed skill (the main server: ~/.claude/skills/epic-spine); skipped where EpicSpine is not installed.
  const installed = resolveSkillDir(process.env);
  it.skipIf(!installed)("runs the installed spines.py and reads its output per the contract", async () => {
    const version = fs.readFileSync(path.join(installed!, "VERSION"), "utf8").trim();
    console.log(`spines.py from ${installed} (VERSION ${version})`);
    fx.write("ops/docs/spines/root.md", "# Root\n\nSpine ID: ROOT\n\n## Current State\n\nStatus: active\n");
    const out = await spinesPyRunner(installed!, { timeoutMs: 25_000 })(path.join(fx.root, "ops"));
    expect(Array.isArray(out.nodes) && Array.isArray(out.orphans)).toBe(true);
    const listed = [...out.nodes.map((n) => n.path), ...out.orphans.map((o) => o.path)];
    expect(listed.every((p) => !path.isAbsolute(p))).toBe(true);
    expect(listed.length).toBeGreaterThan(0);
  }, 30_000);

  it("caches per repo for the TTL; failures are not cached", async () => {
    let calls = 0;
    let fail = true;
    const logs: string[] = [];
    const run = cachedRunner(async () => {
      calls++;
      if (fail) throw new Error("boom");
      return FIXTURE;
    }, 30_000, () => 0, (m) => logs.push(m));
    await expect(run("/a")).rejects.toThrow("boom");
    fail = false;
    await run("/a");
    await run("/a");
    await run("/b");
    expect(calls).toBe(3);
    expect(logs).toEqual(["spines.py failed for /a: boom"]);
  });
});

describe("GET /api/repos/:name/docs via spines.py", () => {
  let dbDir: string;
  let db: DB;
  const appWith = (spines?: SpinesRunner) => {
    const cfg: ReadConfig = { reposRoot: fx.root, seatsFile: path.join(fx.root, "seats.json"), listThreads: async () => [], spines };
    return createApp(db, { read: cfg });
  };
  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-spines-db-"));
    db = openDb(path.join(dbDir, "c.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("lists nodes + orphans + tickets; falls back to path rules on failure", async () => {
    const ok = await (await appWith(async () => FIXTURE).request("/api/repos/ops/docs")).json();
    expect(ok.map((d: any) => `${d.via}:${d.kind}:${d.path}${d.orphan ? ` (orphan: ${d.orphan})` : ""}`)).toEqual([
      "spines:spine:docs/EPIC-900-VPS-FLEET.md",
      "spines:spine:tickets/E905-fleet-observatory.md",
      "spines:spine:docs/one-logger/E4-ONE-LOGGER.md (orphan: not reachable from the root)",
      "spines:ticket:tickets/E1-inventory-health-baseline.md",
      "spines:ticket:tickets/VH-T10-watchdog-alert-delivery.md",
    ]);
    const res = await appWith(async () => {
      throw new Error("spines.py missing");
    }).request("/api/repos/ops/docs");
    expect(res.status).toBe(200);
    const fb = await res.json();
    expect(fb.every((d: any) => d.via === "fallback")).toBe(true);
    expect(fb.map((d: any) => d.path)).toContain("docs/EPIC-900-VPS-FLEET.md");
    expect(fb.map((d: any) => d.path)).not.toContain("docs/one-logger/E4-ONE-LOGGER.md"); // path rules miss it
  });
});
