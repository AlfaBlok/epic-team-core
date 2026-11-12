import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { spinesIndex, type SpinesJson } from "../src/adapters/spines.js";
import { buildTree, subtree, type TreeNode } from "../src/adapters/tree.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

// unique tree keys (all-`draft` ledgers), node view (subtree), Spines page, ad hoc view, track as milestone.
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "EPIC-904-human-ask.md"), "utf8");
const SPINES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "spines-epic4-waiting-on.json"), "utf8")) as SpinesJson;
const EPIC4 = "docs/EPIC-904-DOCTRINE-2.md";
const M4 = { id: "ms_e4", repo: "Acme/epicspine-skill", path: EPIC4, paused: false, title: "EPIC-904" };

let reposRoot: string;
let db: DB | undefined;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const keys = (n: TreeNode): string[] => [n.key, ...n.children.flatMap(keys)];

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-open-spine-"));
  write("epicspine-skill/.git/config", `[remote "origin"]\n\turl = git@github.com:Acme/epicspine-skill.git\n`);
  write(`epicspine-skill/${EPIC4}`, FIXTURE);
});
afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

function setup(runs = { n: 0 }) {
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = {
    reposRoot,
    seatsFile: path.join(reposRoot, "seats.json"),
    listThreads: async () => [],
    spines: async () => (runs.n++, structuredClone(SPINES)),
  };
  const app = createApp(db, { read });
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
}

describe("tree keys", () => {
  it("are unique when every Issue cell is `draft`: row number segments, stable across builds", () => {
    const t = buildTree(reposRoot, M4, SPINES);
    const all = keys(t.root);
    expect(new Set(all).size).toBe(all.length);
    const rows = t.root.children.filter((c) => c.kind === "ticket");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.id === "draft")).toBe(true);
    expect(rows.map((r) => r.key.slice(t.root.key.length + 1))).toEqual(rows.map((_, i) => `#${i + 1}`));
    expect(keys(buildTree(reposRoot, M4, SPINES).root)).toEqual(all);
  });

  it("keep the row id when it is unique, and the row number only for the duplicates", () => {
    write(
      "epicspine-skill/docs/mixed.md",
      "# EPIC-907: Mixed\n\nSpine ID: EPIC-907\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| A-1 | one | done |\n| draft | two | draft |\n| draft | three | active |\n",
    );
    const t = buildTree(reposRoot, { ...M4, path: "docs/mixed.md" });
    expect(t.root.children.map((c) => c.key.slice(t.root.key.length + 1))).toEqual(["A-1", "#2", "#3"]);
    expect(t.root.children.map((c) => c.title)).toEqual(["one", "two", "three"]);
  });
});

describe("node view", () => {
  it("subtree re-roots the tree with its own counts", () => {
    const t = buildTree(reposRoot, M4, SPINES);
    const row1 = t.root.children.find((c) => c.title.startsWith("1. Define the doctrine"))!;
    const s = subtree(t, row1.key)!;
    expect(s.root).toBe(row1);
    expect(s.counts).toMatchObject({ red: 1 });
    expect(s.nonGreen).toBe(1);
    expect(subtree(t, t.root.key)!.counts).toEqual(t.counts);
    expect(subtree(t, "nope")).toBeUndefined();
  });

  it("GET /milestones/:id/tree?nodeKey= and /waiting-on-owner?nodeKey= scope to one row; red rows stay distinct items", async () => {
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "EPIC-904", repo: "Acme/epicspine-skill", path: EPIC4 })).json;
    const tree = (await call("GET", `/api/milestones/${m.id}/tree`)).json;
    expect(tree).toMatchObject({ repo: "epicspine-skill", tracked: { [EPIC4]: m.id } });
    const row1 = tree.root.children.find((c: TreeNode) => c.title.startsWith("1. Define the doctrine"));
    const sub = (await call("GET", `/api/milestones/${m.id}/tree?nodeKey=${encodeURIComponent(row1.key)}`)).json;
    expect(sub.root.key).toBe(row1.key);
    expect(sub.counts.red).toBe(1);
    expect((await call("GET", `/api/milestones/${m.id}/tree?nodeKey=nope`)).status).toBe(404);

    const scoped = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}&nodeKey=${encodeURIComponent(row1.key)}`)).json;
    expect(scoped.map((i: any) => [i.source, i.ask, i.question])).toEqual([["ask", "approve", "Approve the doctrine page and enforcement plan (steps 1+2) as one?"]]);
    expect(scoped[0].contextLinks[0]).toEqual({ label: "approval page", url: "http://main.tail.example:36879/index.html" });
    const all = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.nodeKey)).size).toBe(all.length);
  });
});

describe("Spines page and ad hoc view", () => {
  it("lists a repo's spines with color, rollup and open asks; marks tracked ones after Track as milestone", async () => {
    const call = setup();
    const r = await call("GET", "/api/repos/epicspine-skill/spines");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ repo: "epicspine-skill", remote: "Acme/epicspine-skill", refreshing: false });
    const e4 = r.json.nodes.find((n: any) => n.path === EPIC4);
    expect(e4).toMatchObject({ status: "active", color: "blue", rollup: "active", depth: 1, openAsks: 1 });
    expect(e4.milestoneId).toBeUndefined();
    expect(r.json.nodes.find((n: any) => n.depth === 0)).toMatchObject({ path: "docs/EPIC-900-OPERATING-SYSTEM.md", openAsks: 0 });
    expect((await call("GET", "/api/repos/nope/spines")).status).toBe(404);

    // Track as milestone = the existing create API with repo + path.
    const m = (await call("POST", "/api/milestones", { title: e4.title, repo: "Acme/epicspine-skill", path: EPIC4 })).json;
    const again = (await call("GET", "/api/repos/epicspine-skill/spines")).json;
    expect(again.nodes.find((n: any) => n.path === EPIC4).milestoneId).toBe(m.id);
  });

  it("opens any spine untracked: tree + its waiting-on-Sam items with matching node keys", async () => {
    const call = setup();
    const t = await call("GET", `/api/spine-tree?repo=epicspine-skill&path=${encodeURIComponent(EPIC4)}`);
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ repo: "epicspine-skill", tracked: {}, source: "spines" });
    const row1 = t.json.root.children.find((c: TreeNode) => c.title.startsWith("1. Define the doctrine"));
    const items = (await call("GET", `/api/waiting-on-owner?repo=epicspine-skill&path=${encodeURIComponent(EPIC4)}&nodeKey=${encodeURIComponent(t.json.root.key)}`)).json as any[];
    const ask = items.find((i) => i.source === "ask");
    expect(ask).toMatchObject({ ask: "approve", nodeKey: row1.key, recommendation: "approve, with both small answers yes" });
    const sub = await call("GET", `/api/spine-tree?repo=epicspine-skill&path=${encodeURIComponent(EPIC4)}&nodeKey=${encodeURIComponent(row1.key)}`);
    expect(sub.json.root.key).toBe(row1.key);
    expect((await call("GET", "/api/spine-tree?repo=epicspine-skill")).status).toBe(400);
    // Nothing was stored: the global inbox stays empty.
    expect((await call("GET", "/api/waiting-on-owner")).json).toEqual([]);
  });

  it("spinesIndex answers from cache and refreshes in the background once stale", async () => {
    let n = 0;
    let t = 0;
    let release!: () => void;
    const run = async () => {
      n++;
      if (n > 1) await new Promise<void>((r) => (release = r));
      return { ...structuredClone(SPINES), root: `r${n}` };
    };
    const idx = spinesIndex(run, 1_000, () => t);
    expect((await idx("/repo")).value.root).toBe("r1");
    t = 500;
    expect(await idx("/repo")).toMatchObject({ refreshing: false, value: { root: "r1" } });
    t = 2_000;
    expect(await idx("/repo")).toMatchObject({ refreshing: true, value: { root: "r1" } });
    expect(await idx("/repo")).toMatchObject({ refreshing: true });
    expect(n).toBe(2);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await idx("/repo")).toMatchObject({ refreshing: false, value: { root: "r2" } });
  });
});
