import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { SpinesJson, SpineNode } from "../src/adapters/spines.js";
import { childEpicsFor, childVerdict, runStateOf } from "../src/cycle/children.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { buildWakePrompt } from "../src/wakePrompt.js";

/** a standing wake on a spine with children picks up what the owner stamped ready, and nothing else. */
const node = (p: string, status: string, run_state: string, extra: Partial<SpineNode> = {}): SpineNode => ({
  id: p, path: p, title: `T ${p}`, parent: "docs/root.md", status, rollup_status: status, dod: [], children: [], run_state, ...extra,
});
const fixture: SpinesJson = {
  root: "docs/root.md",
  orphans: [],
  mismatches: [],
  nodes: [
    node("docs/root.md", "active", "running", {
      parent: null,
      has_children: true,
      children: ["docs/draft.md", "docs/ready.md", "docs/owned.md", "docs/done.md"],
    }),
    node("docs/draft.md", "draft", "planning"),
    node("docs/ready.md", "ready", "ready"),
    node("docs/owned.md", "active", "running"),
    node("docs/done.md", "done", "finished"),
  ],
};
const owners = (p: string) => (p === "docs/owned.md" ? "Builder" : undefined);
const milestone = { title: "Root", repo: "home_repo", path: "docs/root.md", owner: "" };
const persona = { name: "Delivery Manager", remit: "Deliver.", skills: [], mayWrite: true };

describe("T14-S3 children of a milestone spine", () => {
  it("childEpicsFor reads run_state and the owning persona; verdicts follow the contract", () => {
    const kids = childEpicsFor(fixture, "docs/root.md", owners)!;
    expect(kids.map((c) => [c.path, childVerdict(c)])).toEqual([
      ["docs/draft.md", "planning"],
      ["docs/ready.md", "pickup"],
      ["docs/owned.md", "owned"],
      ["docs/done.md", "finished"],
    ]);
    expect(kids[2].ownedBy).toBe("Builder");
  });

  it("a leaf (no children, or has_children false) has none to steer", () => {
    expect(childEpicsFor(fixture, "docs/ready.md", owners)).toBeUndefined();
    const allDone: SpinesJson = { ...fixture, nodes: fixture.nodes.map((n) => (n.path === "docs/root.md" ? { ...n, has_children: false } : n)) };
    expect(childEpicsFor(allDone, "docs/root.md", owners)).toBeUndefined();
  });

  it("falls back to the Status table when spines.py has no run_state (older skill)", () => {
    expect(["draft", "ready", "active", "blocked", "deferred", "review", "done", "superseded"].map(runStateOf)).toEqual([
      "planning", "ready", "running", "running", "parked", "finished", "finished", "finished",
    ]);
    const old: SpinesJson = {
      ...fixture,
      nodes: fixture.nodes.map(({ run_state: _r, has_children: _h, ...n }) => n),
    };
    expect(childEpicsFor(old, "docs/root.md", owners)!.map(childVerdict)).toEqual(["planning", "pickup", "owned", "finished"]);
  });
});

describe("T14-S3 parent wake prompt", () => {
  const kids = childEpicsFor(fixture, "docs/root.md", owners)!;
  const p = buildWakePrompt(persona, milestone, { writeEnabled: true, writeScope: "spines" }, undefined, undefined, undefined, kids);

  it("picks only the ready child; lists draft as planning, the owned one with its persona, finished as skipped", () => {
    expect(p).toContain("- docs/ready.md — T docs/ready.md — Status: ready (ready) — PICK UP");
    expect(p).toContain("- docs/draft.md — T docs/draft.md — Status: draft (planning) — skip: planning");
    expect(p).toContain("- docs/owned.md — T docs/owned.md — Status: active (running) — owned by Builder: leave it alone");
    expect(p).toContain("- docs/done.md — T docs/done.md — Status: done (finished) — skip: finished");
    expect(p.match(/PICK UP$/gm)).toHaveLength(1);
  });

  it("sets a picked-up child active, binds workers to it, never starts draft rows, caps by seats", () => {
    expect(p).toContain("set its `Status: active` and its `Last attempted:` naming this run");
    expect(p).toContain("`Bound epic: <child path>`");
    expect(p).toContain("A `draft` row is planning: never start it.");
    expect(p).toContain("start only rows with Status `ready`");
    expect(p).toContain("Ready children you could not start (ceiling or no seat) stay `ready` and queued");
    expect(p).toContain("until it returns a null id");
    expect(p).not.toContain("list EVERY unblocked item");
  });

  it("the outcome line lists picked up, left to its persona and skipped as planning", () => {
    expect(p).toContain("`picked up: <paths>`");
    expect(p).toContain("`left to its persona: <path (persona)>`");
    expect(p).toContain("`skipped as planning: <paths>`");
  });

  it("a leaf spine prompt is unchanged", () => {
    const leaf = buildWakePrompt(persona, milestone);
    expect(buildWakePrompt(persona, milestone, undefined, undefined, undefined, undefined, undefined)).toBe(leaf);
    expect(buildWakePrompt(persona, milestone, undefined, undefined, undefined, undefined, [])).toBe(leaf);
    expect(leaf).toContain("list EVERY unblocked item");
    expect(leaf).not.toContain("child epics");
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("T14-S3 wake wiring", () => {
  it("a wake on the parent milestone lists its children with the persona switched on for a child's own milestone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e14s3-"));
    const repo = path.join(root, "home_repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs"));
    for (const n of fixture.nodes) fs.writeFileSync(path.join(repo, n.path), `# ${n.title}\n\n## Current State\nStatus: ${n.status}\n`);
    const db: DB = openDb(path.join(root, "c.db"));
    const app = createApp(db, {
      read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => fixture },
      cycle: { enabled: true, publicUrl: "http://x" },
    });
    cleanup = () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); };
    const store = createStore(db);
    const mk = (title: string, p: string) => store.createMilestone({ title, repo: "home_repo", path: p, owner: "", paused: false });
    const pers = (name: string) => store.createPersona({ name, remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
    const parent = mk("Root", "docs/root.md");
    const dm = store.createAssignment({ milestoneId: parent.id, personaId: pers("Delivery Manager").id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    // The owned child has an enabled persona; the ready child has one switched off (does not count).
    store.createAssignment({ milestoneId: mk("Owned", "docs/owned.md").id, personaId: pers("Builder").id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    store.createAssignment({ milestoneId: mk("Ready", "./docs/ready.md").id, personaId: pers("Idle").id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const res = await app.request(`/api/assignments/${dm.id}/wake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "home" }) });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("docs/ready.md — T docs/ready.md — Status: ready (ready) — PICK UP");
    expect(text).toContain("owned by Builder: leave it alone");
    expect(text).toContain("skip: planning");
    expect(text).not.toContain("owned by Idle");
  });
});

