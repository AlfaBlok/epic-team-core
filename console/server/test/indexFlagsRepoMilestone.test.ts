import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { SEED_VERSION, deskSeed, endpointLines, updateMessage } from "../src/desk/desk.js";
import { createRepoIndex, noMilestoneText, type RepoScan } from "../src/desk/repoIndex.js";
import { createStore } from "../src/store.js";

/** a repo with no milestone: the index flags it, and the desk says so in one line and offers to add it. */

const BASE = "http://console.test";
const NOW = Date.parse("2026-11-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const SCANS: Record<string, ReturnType<RepoScan> extends Promise<infer R> ? R : never> = {
  main: [
    { name: "inbox", remote: "Acme/inbox", last: daysAgo(2), subject: "x", summary: "Sam's inbox.", spine: "docs/spines/root.md" },
    { name: "nectary", remote: "nectary-dev/nectary", last: daysAgo(119), subject: "y", summary: "A funding protocol for open-source repos.", spine: "docs/PLAN-0-NECTARY.md" },
    { name: "bare", remote: "Acme/bare", last: daysAgo(3), subject: "z", summary: "", spine: "" },
  ],
  worker: [{ name: "nectary", remote: "nectary-dev/nectary", last: daysAgo(119), subject: "y", summary: "", spine: null }],
};

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e41s3-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const boot = () => {
  const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read: readCfg, repoIndex: { scan: async (h) => SCANS[h] } });
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { "X-Console-Run": "team-desk", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined };
  };
};

describe("E41-5 the index flags a repo with no milestone", () => {
  it("noMilestone true with its root spine; false once a milestone joins; the line says `no milestone` and the offer", async () => {
    const store = createStore(db);
    store.createMilestone({ title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md", owner: "", paused: false });
    const idx = createRepoIndex({ db, store, scan: async (h) => SCANS[h], publicUrl: BASE, now: () => NOW });
    await idx.refresh();
    const e = Object.fromEntries(idx.entries().map((r) => [r.name, r]));
    expect(e.inbox).toMatchObject({ noMilestone: false, spine: "docs/spines/root.md" });
    expect(e.nectary).toMatchObject({ noMilestone: true, spine: "docs/PLAN-0-NECTARY.md", hosts: ["main", "worker"] });
    expect(e.bare.noMilestone).toBe(true);
    expect(e.bare.spine).toBeUndefined();
    const md = idx.markdown();
    expect(md).toContain("**nectary** (nectary-dev/nectary): A funding protocol for open-source repos.");
    expect(md).toContain("· no milestone (root spine docs/PLAN-0-NECTARY.md): offer to add it");
    expect(md).toContain("**bare** (Acme/bare)");
    expect(md).toContain("· no milestone (no spine yet): offer to add it");
    expect(noMilestoneText({})).toMatch(/^no milestone/);
  });

  it("another world's milestone still counts as a milestone (no offer for it)", async () => {
    const store = createStore(db);
    const m = store.createMilestone({ title: "Nectary", repo: "nectary-dev/nectary", path: "docs/PLAN-0-NECTARY.md", owner: "", paused: false });
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, owner_handle, owner_name, created_at) VALUES ('social', 'Memo social', 'social', 'j', 'J', ?)").run(new Date().toISOString());
    db.prepare("UPDATE milestones SET tenant_id = 'social' WHERE id = ?").run(m.id);
    const idx = createRepoIndex({ db, store, scan: async (h) => SCANS[h], publicUrl: BASE, now: () => NOW });
    await idx.refresh();
    expect(idx.entries().find((r) => r.name === "nectary")!.noMilestone).toBe(false);
  });

  it("served on /api/desk/repos (json flag); the desk's milestone create through the existing route clears it", async () => {
    const call = boot();
    // the app's own index: refresh in the background, then read what it stored
    expect((await call("POST", "/api/desk/repos/refresh")).status).toBe(202);
    let json: any;
    for (let i = 0; i < 50; i++) {
      json = (await call("GET", "/api/desk/repos?format=json")).json;
      if (json?.repos?.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(json.repos.find((r: any) => r.name === "nectary")).toMatchObject({ noMilestone: true, spine: "docs/PLAN-0-NECTARY.md" });
    expect((await call("GET", "/api/desk/repos")).text).toContain("no milestone (root spine docs/PLAN-0-NECTARY.md): offer to add it");

    // the owner said yes: the desk calls the console's existing milestone create with the entry's remote and spine
    const created = await call("POST", "/api/milestones", { title: "nectary · PLAN-0", repo: "nectary-dev/nectary", path: "docs/PLAN-0-NECTARY.md" });
    expect(created.status).toBe(201);
    const after = (await call("GET", "/api/desk/repos?format=json")).json.repos.find((r: any) => r.name === "nectary");
    expect(after.noMilestone).toBe(false);
    expect(after.milestones[0]).toMatchObject({ id: created.json.id, title: "nectary · PLAN-0" });
  });
});

describe("E41-5 the desk's instruction text", () => {
  it("endpoint list: one-line notice, the offer, nothing created before Sam's yes, then the existing create routes", () => {
    const text = endpointLines(BASE).join("\n");
    const rule = text.split("\n").find((l) => l.includes("- Repo with no milestone:"))!;
    expect(rule).toBeDefined();
    expect(rule).toContain("`no milestone`");
    expect(rule).toContain("`noMilestone: true`");
    expect(rule).toContain("say so in one line");
    expect(rule).toContain("Add it as a milestone?");
    expect(rule).toContain("Create nothing until Sam says yes in his own message here");
    expect(rule).toContain(`POST ${BASE}/api/milestones -H`);
    expect(rule).toContain(`POST ${BASE}/api/milestones/bootstrap -H`);
    expect(rule).toContain("X-Console-Run: team-desk");
    expect(rule).toContain("if he says no, do not offer it again");
  });

  it("seed and update carry it; seed version moved past T41-S1's", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(9);
    const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: BASE, reposRoot: "/x" });
    expect(seed).toContain("A repo it lists with `no milestone`: tell Sam in one line and offer to add it as a milestone");
    expect(seed).toContain("Repo with no milestone");
    const upd = updateMessage(BASE);
    expect(upd.startsWith(`[team-desk update] v${SEED_VERSION}`)).toBe(true);
    expect(upd).toContain("a repo with no milestone: say so in one line and offer to add it, created only after Sam says yes");
    expect(upd).toContain("Repo with no milestone");
  });

  it("the scanner reports the root spine (AGENTS.md's, else docs/spines/root.md, else EPIC.md, else none)", () => {
    const root = path.join(tmp, "root");
    const mk = (name: string, files: Record<string, string>) => {
      const r = path.join(root, name);
      fs.mkdirSync(path.join(r, ".git"), { recursive: true });
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
        fs.writeFileSync(path.join(r, rel), text);
      }
    };
    mk("a", { "AGENTS.md": "Root spine: docs/PLAN-0-A.md\n", "docs/PLAN-0-A.md": "# A\n" });
    mk("b", { "docs/spines/root.md": "# B\n" });
    mk("c", { "EPIC.md": "# C\n" });
    mk("d", { "README.md": "# D\n" });
    mk("e", { "AGENTS.md": "Root spine: docs/missing.md\n", "EPIC.md": "# E\n" });
    const out = JSON.parse(execFileSync("python3", ["-I", path.resolve(__dirname, "../scripts/repo_index.py"), JSON.stringify({ root })], { encoding: "utf8" }));
    expect(Object.fromEntries(out.repos.map((r: any) => [r.name, r.spine]))).toEqual({ a: "docs/PLAN-0-A.md", b: "docs/spines/root.md", c: "EPIC.md", d: "", e: "EPIC.md" });
  });
});
