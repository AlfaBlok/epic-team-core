import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { parseDod } from "../src/dod.js";
import { dodFor, type SpineNode, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import type { ReadConfig } from "../src/routes/read.js";
import { makeFixtureRoot } from "./fixtures.js";

const P = "docs/one-logger/E4-ONE-LOGGER.md";
const node = (over: Partial<SpineNode>): SpineNode => ({
  id: "PLAN-4", path: P, title: "PLAN-4: ONE LOGGER", parent: null, status: "active", rollup_status: "active", dod: [], children: [], ...over,
});
const json = (n: SpineNode): SpinesJson => ({ root: n.path, nodes: [n], orphans: [], mismatches: [] });
const items = (n: number, done = 0) => Array.from({ length: n }, (_, i) => ({ id: `E4-${i + 1}`, text: `item ${i + 1}`, done: i < done }));
const EMPTY = { done: 0, total: 0, items: [] };

describe("dodFor (spines.py node → milestone dod)", () => {
  it("done_means wins, with ids; tracked", () => {
    expect(dodFor(json(node({ done_means: items(6, 2), dod: items(3) })), P, EMPTY)).toEqual({
      done: 2,
      total: 6,
      tracked: true,
      items: items(6, 2).map((i) => ({ text: i.text, checked: i.done, id: i.id })),
    });
  });

  it("falls back to dod when done_means is absent or empty; neither → undefined (markdown parse stands)", () => {
    expect(dodFor(json(node({ dod: items(3, 1) })), P, EMPTY)).toMatchObject({ done: 1, total: 3 });
    expect(dodFor(json(node({ done_means: [], dod: items(3, 3) })), P, EMPTY)).toMatchObject({ done: 3, total: 3 });
    expect(dodFor(json(node({ done_means: [], dod: [] })), P, EMPTY)).toBeUndefined();
    expect(dodFor(json(node({ done_means: items(2) })), "docs/other.md", EMPTY)).toBeUndefined();
  });

  it("old spine: the same list read locally keeps its tracked/ids semantics", () => {
    const untracked = parseDod("## Exit Test\n\n1. a\n2. b\n");
    expect(dodFor(json(node({ dod: items(2), done_means: items(2) })), P, untracked)).toBe(untracked);
    const checked = parseDod("## Definition Of Done\n\n- [x] M4-1 a\n- [ ] M4-2 b\n");
    expect(dodFor(json(node({ dod: items(2, 1), done_means: items(2, 1) })), P, checked)).toBe(checked);
  });
});

describe("parseDod: ## Done means (markdown fallback)", () => {
  it("reads a Done means checklist and prefers it over a DoD heading", () => {
    const md = "# PLAN-4: X\n\n## Done means\n\nIntro.\n\n- [ ] E4-1 one\n- [x] E4-2 two\n\n## Definition Of Done\n\n- [ ] old\n";
    expect(parseDod(md)).toEqual({ done: 1, total: 2, tracked: true, items: [{ text: "E4-1 one", checked: false }, { text: "E4-2 two", checked: true }] });
  });

  it("without Done means items the DoD headings still count; a sentence heading is not one", () => {
    expect(parseDod("## Done means\n\nTBD.\n\n## Acceptance\n\n- [x] a\n")).toMatchObject({ done: 1, total: 1 });
    expect(parseDod("## Notes on what done means\n\n- [ ] x\n").total).toBe(0);
  });
});

describe("GET /api/milestones/:id dod from spines.py", () => {
  let fx: ReturnType<typeof makeFixtureRoot>;
  let dbDir: string;
  let db: DB;
  beforeEach(() => {
    fx = makeFixtureRoot();
    fx.write("poly-maker/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/poly-maker.git\n`);
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-dm-db-"));
    db = openDb(path.join(dbDir, "c.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fx.cleanup();
  });
  const get = async (spines: SpinesRunner | undefined, md: string, title = "poly-maker · EPIC: E4 ONE LOGGER — the market is observed once") => {
    fx.write(`poly-maker/${P}`, md);
    const app = createApp(db, { read: { reposRoot: fx.root, seatsFile: path.join(fx.root, "seats.json"), listThreads: async () => [], spines } as ReadConfig });
    const created = await (
      await app.request("/api/milestones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, repo: "poly-maker", path: P, owner: "Sam" }) })
    ).json();
    const one = await (await app.request(`/api/milestones/${created.id}`)).json();
    const list = await (await app.request("/api/milestones")).json();
    return { one, listed: list.find((m: { id: string }) => m.id === created.id) };
  };
  // A Doctrine-2 body whose list the markdown parser cannot read (prose only), so the count must come from spines.py.
  const D2 = "# PLAN-4: ONE LOGGER\n\n## Current State\n\nStatus: active\n\n## Done means\n\nSee the six outcomes in the E4 page.\n";

  it("done_means → dod 6, shape.dod true, docTitle; detail and list agree; the stored title is untouched", async () => {
    const { one, listed } = await get(async () => json(node({ done_means: items(6), dod: items(6) })), D2);
    for (const m of [one, listed]) {
      expect(m.dod).toMatchObject({ done: 0, total: 6, tracked: true });
      expect(m.shape.dod).toBe(true);
      expect(m.docTitle).toBe("PLAN-4: ONE LOGGER");
      expect(m.title).toBe("poly-maker · EPIC: E4 ONE LOGGER — the market is observed once");
    }
    expect(one.verdict).toBeDefined();
  });

  it("spines.py unavailable → markdown fallback reads ## Done means; docTitle from the file's H1", async () => {
    const md = "# PLAN-4: ONE LOGGER\n\n## Done means\n\n- [ ] E4-1 a\n- [x] E4-2 b\n";
    const { one } = await get(async () => { throw new Error("spines.py missing"); }, md);
    expect(one.dod).toMatchObject({ done: 1, total: 2, tracked: true });
    expect(one.shape.dod).toBe(true);
    expect(one.docTitle).toBe("PLAN-4: ONE LOGGER");
  });

  it("old spine regression: untracked Exit Test stays tracked:false with numeric ids; same title → no docTitle", async () => {
    const md = "# PLAN-2: Control\n\n## Exit Test\n\n1. **CPU** ok\n2. **Disk** ok\n";
    const { one } = await get(async () => json(node({ title: "PLAN-2: Control", dod: items(2), done_means: items(2) })), md, "PLAN-2: Control");
    expect(one.dod).toEqual({ done: 0, total: 0, tracked: false, items: [{ text: "**CPU** ok", checked: null, id: "1" }, { text: "**Disk** ok", checked: null, id: "2" }] });
    expect(one.shape.dod).toBe(true);
    expect(one.docTitle).toBeUndefined();
  });
});
