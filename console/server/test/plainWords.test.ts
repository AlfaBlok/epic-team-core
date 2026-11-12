import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpineNode, SpinesJson } from "../src/adapters/spines.js";
import { type Book } from "../src/book/build.js";
import { milestoneBook, plain, type MilestoneBook } from "../src/book/milestone.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";

/** the Epic Book per milestone: plain narrative from Goal, Done means, Current State; the plan tree; GET /api/book/:key. */

const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({
  id: over.path,
  parent: null,
  status: "active",
  rollup_status: "active",
  dod: [],
  children: [],
  ...over,
});

const ROOT = "docs/spines/root.md";
const spines: SpinesJson = {
  root: ROOT,
  orphans: [],
  mismatches: [],
  nodes: [
    node({
      path: ROOT,
      title: "home_repo",
      goal: "Run a small team of **AI employees** on the VPS that push a milestone forward on their own.\n\nModel (from voice notes): personas are not accounts.",
      current_state: {
        status: "active",
        phase: "M0..M4 done; M6 active",
        last_attempted: "2026-11-01 05:05Z DM (run_2d89b5ad-aaaa): all rows landed. Live f8e0f60.",
        next_action: "Sam answers E922-A1 (two logins)",
        waiting_on: "none",
      } as never,
      done_means: [
        { id: "DOD-1", text: "T3 server runs as a service on host1. Closed 2026-10-14 via D-8 restart proxy.", done: true },
        { id: "DOD-2", text: "Three personas run unattended", done: false },
      ],
    }),
    node({ path: "docs/spines/epic-40.md", title: "EPIC-940: Lanes and radar", parent: ROOT, current_state: { status: "active", next_action: "build lanes" } as never }),
    node({
      path: "docs/spines/epic-22.md",
      title: "EPIC-922: Two worlds live",
      parent: ROOT,
      current_state: { status: "active", waiting_on: "Sam: E922-A1" } as never,
      ...({ waiting_on: [{ code: "E922-A1", who: "Sam", question: "Log in once on each site", state: "open" }] } as object),
    }),
    node({ path: "docs/spines/epic-41.md", title: "EPIC-941: Sub of 40", parent: "docs/spines/epic-40.md" }),
    node({ path: "docs/spines/epic-16.md", title: "EPIC-916: Clean trees", parent: ROOT, status: "done" }),
    node({ path: "docs/spines/epic-34.md", title: "EPIC-934: Social skin", parent: ROOT, status: "draft" }),
  ],
};

describe("E947-S1 plain words", () => {
  it("keeps the first paragraph, drops markdown, run ids and hashes, cuts at a sentence end", () => {
    expect(plain("Run a **team** of [agents](x.md) (run_2d89b5ad-aaaa) live at f8e0f60.\n\nModel: more")).toBe("Run a team of agents live at.");
    expect(plain("none")).toBe("none");
    expect(plain(null)).toBeNull();
    const long = `${"First sentence is here and fine. ".repeat(3)}${"word ".repeat(80)}`;
    expect(plain(long, 120)).toBe("First sentence is here and fine. First sentence is here and fine. First sentence is here and fine.");
    expect(plain("word ".repeat(80), 50)!.endsWith("…")).toBe(true);
    expect(plain("2026-10-31 E940-S2 and EPIC-947 stay")).toBe("2026-10-31 E940-S2 and EPIC-947 stay");
  });
});

describe("E947-S1 GET /api/book/:key", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s1-"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/spines"), { recursive: true });
    for (const n of spines.nodes) fs.writeFileSync(path.join(root, "home_repo", n.path), `# ${n.title}\n\n## Current State\n\nStatus: ${n.status}\n`);
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

  it("answers a milestone's book by id and by repo name: narrative, plan tree, counts", async () => {
    const a = app();
    const m = createStore(db!).createMilestone({ title: "home_repo · home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    createStore(db!).createMilestone({ title: "EPIC-940", repo: "Acme/home_repo", path: "docs/spines/epic-40.md", owner: "", paused: false });
    const res = await a.request(`/api/book/${m.id}`);
    expect(res.status).toBe(200);
    const { book } = (await res.json()) as { book: MilestoneBook };
    expect(book.milestone).toMatchObject({ id: m.id, code: "root", path: ROOT, title: "home_repo" }); // the spine's title, not the stored one
    expect(book.narrative.goal).toBe("Run a small team of AI employees on the VPS that push a milestone forward on their own.");
    expect(book.narrative.goals).toEqual([
      { id: "DOD-1", done: true, text: "T3 server runs as a service on host1. Closed 2026-10-14 via D-8 restart proxy." },
      { id: "DOD-2", done: false, text: "Three personas run unattended" },
    ]);
    expect(book.narrative.whereWeAre).toEqual([
      "1 of 2 goals met.",
      "5 epics under it: 2 moving, 1 waiting on someone, 1 parked, 1 done.",
      "M0..M4 done; M6 active",
      "Last step: 2026-11-01 05:05Z DM: all rows landed. Live.",
    ]);
    expect(book.narrative.next).toEqual([
      { text: "Sam answers E922-A1 (two logins)" },
      { code: "EPIC-922", stuck: true, text: "Two worlds live: waiting on Sam (E922-A1)" },
      { code: "EPIC-940", text: "Lanes and radar: build lanes" },
    ]);
    expect(book.tree.map((n) => [n.code, n.depth, n.state])).toEqual([
      ["root", 0, "moving"],
      ["EPIC-940", 1, "moving"],
      ["EPIC-922", 1, "stuck"],
      ["EPIC-941", 2, "moving"],
      ["EPIC-916", 1, "done"],
      ["EPIC-934", 1, "parked"],
    ]);
    expect(book.counts).toEqual({ moving: 2, stuck: 1, parked: 1, done: 1 });

    // the repo name opens its root milestone (a stable, readable URL); a sub-milestone is cut at its own spine
    const byName = (await (await a.request("/api/book/home_repo")).json()) as { book: MilestoneBook };
    expect(byName.book.milestone.id).toBe(m.id);
    const sub = createStore(db!).listMilestones().find((x) => x.path.endsWith("epic-40.md"))!;
    const s = (await (await a.request(`/api/book/${sub.id}`)).json()) as { book: MilestoneBook };
    expect(s.book.tree.map((n) => [n.code, n.depth, n.parent])).toEqual([
      ["EPIC-940", 0, null],
      ["EPIC-941", 1, "docs/spines/epic-40.md"],
    ]);
    expect((await a.request("/api/book/nope")).status).toBe(404);
  });

  it("books are home's: another world's milestone, by id or repo name, is a 404; GET /milestones/:id names its world", async () => {
    const a = app();
    db!.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run("social", "social", new Date().toISOString());
    const z = createStore(db!, { tenant: "social" }).createMilestone({ title: "Memo social", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    expect((await a.request(`/api/book/${z.id}`)).status).toBe(404);
    expect((await a.request("/api/book/home_repo")).status).toBe(404);
    const m = createStore(db!).createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    expect(((await (await a.request("/api/book/home_repo")).json()) as { book: MilestoneBook }).book.milestone.id).toBe(m.id);
    expect(((await (await a.request(`/api/milestones/${m.id}`)).json()) as { world: string }).world).toBe("home");
  });

  it("GET /api/book keeps its shape: the per-milestone fields stay on the server", async () => {
    const a = app();
    const v = (await (await a.request("/api/book")).json()) as { book: Book };
    const e = v.book.repos[0].epics[0];
    expect(e.code).toBe("root");
    expect("doneMeans" in e || "result" in e || "phase" in e).toBe(false);
  });

  it("a milestone whose spine is not in the book is null", () => {
    const book: Book = { builtAt: "x", repos: [], counts: { moving: 0, stuck: 0, parked: 0, done: 0 } };
    expect(milestoneBook(book, { id: "m", repoName: "home_repo", path: ROOT })).toBeNull();
  });
});
