import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitRun, namesTicket, orphanCommitsIn, orphanSection, sinceFor, ORPHAN_SINCE } from "../src/status/orphanCommits.js";

/**
 * every commit names its ticket. A commit on main whose message names no row/spine code or spine path is an
 * orphan, listed for the Delivery Manager until a spine names its short sha; merges and the console's own writes are
 * exempt by pattern.
 */

describe("namesTicket", () => {
  const ok = (message: string, author = "Acme") => namesTicket({ author, message });
  it("a row, ask, epic, learning or ledger code, or a spine path, names the ticket", () => {
    for (const m of ["E962-S2: review from spine", "M2-41 fix", "EPIC-963 plan", "Answer EPIC-929-A2 later", "E34: Waiting on nobody", "E50/E45: seats", "Root L-48: plain words", "Secrets: SK-1 add", "T901-S1 test", "fix the docs/spines/epic-962-repo-is-the-source.md rows", "E913-S17c: judge", "docs/EPIC_SPINE.md: TAX-A8 feedback done round 2 TAX-A13 (af14531)", "TAX-A9 answered", "ABC-S12 fix", "EPIC.md: tidy", "rows in docs/travel/TRAVEL_SPINE.md", "docs/EPIC-900-ROOT.md: state", "see epic-spine.md"])
      expect(ok(m), m).toBe(true);
  });
  it("no code and no path: an orphan, also when only a trailer or a URL carries something code-like", () => {
    for (const m of ["Setup counts the sign-ins", "Document Memo seat setup outcome", "Roll-up: leaf Waiting on lines say nobody", "Fix it\n\nRun: run_5c3f5010-56cb\nCo-Authored-By: Claude Opus 5.5 <noreply@example.com>", "see https://example.com/E962-S2", "Use GPT-4o for summaries", "Update README.md and notes.md", "Bump UTF-8x handling", "docs/EPIC_SPINE.mdx draft", "Social pack: Benefit column last on posts so positional ledgers keep their Status (2026.11.07.2)"])
      expect(ok(m), m).toBe(false);
  });
  it("merges, reverts and the console's own writes are exempt", () => {
    for (const m of ["Merge branch 'wt/x'", 'Revert "thing"', "Team skills: remove diagram (Sam, via console)", "Stamped ready for delivery (Sam, asking the Team desk)", "Stamped ready for delivery (Sam, his voice note)", "Ask moot: credits are back (console)", "Desk inbox: desk/inbox/2026-11-10-acme-e945-s5-ask-seam-live.md answered", "Desk note from ops: HOST1 load"])
      expect(ok(m), m).toBe(true);
    expect(ok("Post topic 2", "Team desk")).toBe(true);
    expect(ok("anything", "Agent Team Console")).toBe(true);
  });
});

describe("orphan commits on main (temp repo)", () => {
  let tmp: string;
  let origin: string;
  let repo: string;
  const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
  const commit = (msg: string, file = "src.txt") => {
    fs.appendFileSync(path.join(repo, file), `${msg}\n`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", msg]);
    git(repo, ["push", "-q", "origin", "HEAD:main"]);
    git(repo, ["fetch", "-q", "origin"]);
    return git(repo, ["rev-parse", "HEAD"]);
  };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e63s7-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    repo = path.join(tmp, "r");
    git(tmp, ["clone", "-q", origin, repo]);
    git(repo, ["checkout", "-q", "-b", "main"]);
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/spines/root.md"), "# EPIC-901: r\n\n## Issue Ledger\n\n| ID | Status | Latest Evidence |\n|---|---|---|\n| E901-S1 | done | none |\n");
    commit("E901-S1: seed", "docs/spines/root.md");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("lists a commit that names no ticket, skips named and exempt ones, and drops it once a spine names its sha", async () => {
    const since = "2000-01-01T00:00:00Z";
    commit("E901-S1: named work");
    const orphan = commit("tweak the thing");
    commit("Team skills: add x (Sam, via console)");
    let list = await orphanCommitsIn(gitRun(), repo, since);
    expect(list.map((c) => c.sha)).toEqual([orphan]);
    expect(list[0]).toMatchObject({ author: "t", message: "tweak the thing" });
    // the Delivery Manager attributes it: the row names the short sha
    const spine = path.join(repo, "docs/spines/root.md");
    fs.writeFileSync(spine, fs.readFileSync(spine, "utf8").replace("| E901-S1 | done | none |", `| E901-S1 | done | commit ${orphan.slice(0, 7)} |`));
    commit("E901-S1: name the orphan commit", "docs/spines/root.md");
    list = await orphanCommitsIn(gitRun(), repo, since);
    expect(list).toEqual([]);
  });

  it("counts only commits since the floor (the rule's go-live) and at most 7 days back", async () => {
    commit("old orphan");
    expect(await orphanCommitsIn(gitRun(), repo, new Date(Date.now() + 3_600_000).toISOString())).toEqual([]);
    expect(sinceFor(Date.parse("2026-11-04T00:00:00Z"), ORPHAN_SINCE)).toBe(new Date(ORPHAN_SINCE).toISOString());
    expect(sinceFor(Date.parse("2026-12-01T00:00:00Z"), ORPHAN_SINCE)).toBe("2026-11-24T00:00:00.000Z");
  });
});

describe("the Delivery Manager's wake section", () => {
  it("names each commit and says how to attribute it; none = no section", () => {
    expect(orphanSection([])).toBeUndefined();
    const s = orphanSection([{ milestoneId: "m", milestoneTitle: "M", repo: "home_repo", sha: "a".repeat(40), short: "aaaaaaa", author: "Acme", date: "2026-11-03T07:00:00Z", subject: "tweak the thing" }])!;
    expect(s).toMatch(/^## Commits that name no ticket\n/);
    expect(s).toContain("- home_repo aaaaaaa 2026-11-03T07:00Z Acme: tweak the thing");
    expect(s).toMatch(/short sha in that row's Latest Evidence/);
  });
});

describe("app: GET /orphan-commits and the Delivery Manager's wake", () => {
  it("the repo's home milestone lists the orphan; its Delivery Manager's wake carries the section", async () => {
    const { createApp } = await import("../src/app.js");
    const { openDb } = await import("../src/db.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e63s7-app-"));
    const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
    const origin = path.join(tmp, "o.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const repo = path.join(tmp, "team");
    git(tmp, ["clone", "-q", origin, repo]);
    git(repo, ["checkout", "-q", "-b", "main"]);
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/spines/root.md"), "# EPIC-901: team\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n");
    fs.writeFileSync(path.join(repo, "docs/spines/epic-902.md"), "# EPIC-902: child\n\n## Current State\n\nStatus: active\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "EPIC-901: seed"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "tweak the thing"]);
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["fetch", "-q", "origin"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    const prev = process.env.CONSOLE_ORPHAN_SINCE;
    process.env.CONSOLE_ORPHAN_SINCE = "2000-01-01T00:00:00Z";
    const db = openDb(path.join(tmp, "c.db"));
    try {
      const t3 = {
        listProjects: async () => [],
        listScheduledTasks: async () => [],
        updateScheduledTask: async () => {},
        deleteScheduledTask: async () => {},
        runScheduledTaskNow: async () => {},
        launchThread: async () => ({ threadId: "thread_1" }),
        sendToThread: async () => {},
        readThreadStatus: async () => ({ status: "idle", raw: {} }),
      };
      const app = createApp(db, {
        read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
        browser: { browserUrl: "http://127.0.0.1:9" },
        cycle: { enabled: true, t3: t3 as any, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as any, publicUrl: "http://console.test" },
      });
      const call = async (method: string, url: string, body?: unknown) => {
        const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : undefined };
      };
      const child = (await call("POST", "/api/milestones", { title: "Child", repo: "team", path: "docs/spines/epic-902.md" })).json;
      const home = (await call("POST", "/api/milestones", { title: "Team", repo: "team", path: "docs/spines/root.md" })).json;
      const r = await call("GET", "/api/orphan-commits");
      expect(r.json).toMatchObject({ total: 1, items: [{ milestoneId: home.id, repo: "team", sha, short: sha.slice(0, 7), subject: "tweak the thing" }] });
      const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "sonnet" })).json;
      const mk = async (m: any) => (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
      const onHome = await mk(home);
      const onChild = await mk(child);
      const wake = async (a: any) => (await call("POST", `/api/assignments/${a.id}/wake?format=json`, {})).json.prompt as string;
      const p = await wake(onHome);
      expect(p).toContain("## Commits that name no ticket");
      expect(p).toContain(`- team ${sha.slice(0, 7)} `);
      expect(await wake(onChild)).not.toContain("Commits that name no ticket");
    } finally {
      db.close();
      if (prev === undefined) delete process.env.CONSOLE_ORPHAN_SINCE;
      else process.env.CONSOLE_ORPHAN_SINCE = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
