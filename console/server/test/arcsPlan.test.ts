import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpineNode, SpinesJson } from "../src/adapters/spines.js";
import { arcFor, parseArcs, ARCS_FILE } from "../src/deck/arcs.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";

/** each focus project's arc, three epics in order (now, next, after), read from docs/arcs.md and shown on its page. */

const ARCS = `# Arcs

Status: proposal for the owner to change
Format: one section per project.

## Team
Spine: home_repo/docs/spines/root.md
Aim: The team works by itself.
- next · EPIC-941 · Second step.
- now · EPIC-940 · First step.
- after · other/EPIC-903 · Third step, in another repo.

## Broken
Spine: home_repo/docs/spines/epic-922.md
No phases here.
`;

describe("parseArcs and arcFor", () => {
  it("reads each project's phases in now, next, after order; a bare code is the Spine's repo; a section without phases drops", () => {
    const a = parseArcs(ARCS);
    expect(a.status).toBe("proposal for the owner to change");
    expect(a.arcs.map((x) => x.project)).toEqual(["Team"]);
    expect(a.arcs[0].phases.map((p) => [p.place, p.repo, p.code, p.line])).toEqual([
      ["now", "home_repo", "EPIC-940", "First step."],
      ["next", "home_repo", "EPIC-941", "Second step."],
      ["after", "other", "EPIC-903", "Third step, in another repo."],
    ]);
    expect(arcFor(a, "home_repo", "docs/spines/epic-922.md")).toBeNull();
    expect(arcFor(a, "home_repo", "docs/spines/root.md")?.phases[0]).toMatchObject({ title: null, href: null });
  });

});

const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({ id: over.path, parent: null, status: "active", rollup_status: "active", dod: [], children: [], ...over });
const ROOT = "docs/spines/root.md";
const spines: SpinesJson = {
  root: ROOT,
  orphans: [],
  mismatches: [],
  nodes: [
    node({ path: ROOT, title: "home_repo", current_state: { status: "active" } as never }),
    node({ path: "docs/spines/epic-940.md", title: "Lanes and radar", parent: ROOT, goal: "See the lanes.", current_state: { status: "active" } as never }),
    node({ path: "docs/spines/epic-941.md", title: "Radar", parent: ROOT, current_state: { status: "draft" } as never }),
  ],
};

describe("GET /api/milestones/:id/arc", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e940s7-"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/spines"), { recursive: true });
    for (const n of spines.nodes) fs.writeFileSync(path.join(root, "home_repo", n.path), `# ${n.title}\n\n## Current State\n\nStatus: ${n.status}\n`);
    fs.writeFileSync(path.join(root, "home_repo", ARCS_FILE), ARCS);
    resetRepoScans(0);
  });
  afterEach(() => {
    resetRepoScans();
    db?.close();
    db = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = () => {
    db = openDb(path.join(root, "c.db"));
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => spines };
    return createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" }, book: { git: async () => "" } });
  };

  it("answers the project's arc with each epic's title, status and deck; null for a project with no arc", async () => {
    const a = app();
    const s = createStore(db!);
    const top = s.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    const lane = s.createMilestone({ title: "Lanes", repo: "Acme/home_repo", path: "docs/spines/epic-940.md", owner: "", paused: false });
    const r = (await (await a.request(`/api/milestones/${top.id}/arc`)).json()) as { arc: { project: string; fileStatus: string; phases: { place: string; title: string | null; status: string | null; href: string | null }[] } };
    expect(r.arc.project).toBe("Team");
    expect(r.arc.fileStatus).toMatch(/proposal/);
    expect(r.arc.phases.map((p) => [p.place, p.title, p.href])).toEqual([
      ["now", "Lanes and radar", "/deck/home_repo/EPIC-940"],
      ["next", "Radar", "/deck/home_repo/EPIC-941"],
      ["after", null, null],
    ]);
    expect(r.arc.phases[0].status).toBe("active");
    expect(await (await a.request(`/api/milestones/${lane.id}/arc`)).json()).toEqual({ arc: null });
    expect((await a.request("/api/milestones/nope/arc")).status).toBe(404);
  });
});
