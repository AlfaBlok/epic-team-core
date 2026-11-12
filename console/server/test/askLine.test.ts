import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { asksFor, parseAsks } from "../src/inbox/asks.js";
import { deskInboxSection, parseNote } from "../src/desk/inbox.js";
import { askGateProblem } from "../src/inbox/askGate.js";
import {
  citeOf,
  handImprovement,
  improvementNote,
  improvementsOutSection,
  improvementsTakenSection,
  resolveImprovementTarget,
  type HandInput,
  type WorldRow,
} from "../src/inbox/improvement.js";
import { parsePairs } from "../src/voice/cross.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

/**
 * the social product never codes: its
 * persona writes an improvement request, his yes hands it to EpicTeam's desk as one note, EpicTeam answers with its row,
 * the social product sees the state on every wake.
 */

const ASK =
  "- [ask E905-A9: approve @Sam since 2026-11-10 row E905-S3] Improvement request: a link to the campaign page on the site — label: improvement request — to: EpicTeam — campaign: Launch campaign — done means: the site's home links to the campaign page — context: the launch posts point at a page nobody can reach from the site — recommend: yes, a small change on the site — why Sam: it spends EpicTeam's time on SocialApp's campaign — unblocks: E905-S3, the launch posts";

describe("the ask line", () => {
  it("reads the label and its fields apart from the question and the other fields", () => {
    const [a] = parseAsks(`# EPIC-905\n\n## Waiting on\n\n${ASK}\n`);
    expect(a.ask).toBe("approve");
    expect(a.improvement).toEqual({ to: "EpicTeam", campaign: "Launch campaign", doneMeans: "the site's home links to the campaign page" });
    expect(a.question).toBe("Improvement request: a link to the campaign page on the site");
    expect(a.unblocks).toBe("E905-S3, the launch posts");
    expect(a.recommend).toBe("yes, a small change on the site");
  });

  it("without the label (or an Improvement request: lead) the same fields stay words of the question", () => {
    const plain = "- [ask E905-A2: decide @Sam since 2026-11-10] Which day for the post? — to: Friday — options: Thursday | Friday — recommend: Friday — unblocks: E905-S1";
    const [a] = parseAsks(`# EPIC-905\n\n## Waiting on\n\n${plain}\n`);
    expect(a.improvement).toBeUndefined();
    expect(a.question).toBe("Which day for the post? — to: Friday");
  });
});

describe("the ask as spines.py gives it", () => {
  it("spines.py glues the fields into the question; the file's own line reads them apart (production path)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e101s8-spines-"));
    try {
      fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
      fs.writeFileSync(path.join(dir, "docs/spines/root.md"), `# EPIC-905\n\n## Waiting on\n\n${ASK}\n`);
      // the entry as spines.py --json printed it for the TEST world e77-test-b (2026-11-11)
      const entry = {
        code: "E905-A9", who: "Sam", ask: "approve",
        question: "Improvement request: a link to the campaign page on the site — label: improvement request — to: EpicTeam — campaign: Launch campaign — done means: the site's home links to the campaign page",
        steps: null, options: [], recommend: "yes, a small change on the site", unblocks: "E905-S3, the launch posts", effort: null,
        context: "the launch posts point at a page nobody can reach from the site", impact: null, risk: null, why: "it spends EpicTeam's time on SocialApp's campaign",
        since: "2026-11-10", row: "E905-S3", state: "open", answer: null, outcome: null, superseded_by: null,
      };
      const [a] = asksFor(dir, "docs/spines/root.md", [entry]);
      expect(a.improvement).toEqual({ to: "EpicTeam", campaign: "Launch campaign", doneMeans: "the site's home links to the campaign page" });
      expect(a.question).toBe("Improvement request: a link to the campaign page on the site");
      expect(a.line).toBe(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const input = (over: Partial<HandInput> = {}): HandInput => ({
  fromWorld: "soc",
  replyTo: "Acme/soc-campaign",
  repo: "soc-campaign",
  code: "E905-A9",
  question: "Improvement request: a link to the campaign page on the site",
  improvement: { to: "EpicTeam", campaign: "Launch campaign", doneMeans: "the site's home links to the campaign page" },
  unblocks: "E905-S3, the launch posts",
  answer: "APPROVED",
  approvedOn: "2026-11-10",
  toWorld: "home",
  ...over,
});

describe("the note", () => {
  it("is a desk note the inbox reads, of kind improvement-request, naming the ask, campaign, done means and his approval", () => {
    const n = improvementNote(input());
    expect(n.rel).toBe("desk/inbox/2026-11-10-soc-improvement-e905-a9.md");
    const note = parseNote(n.rel, n.text)!;
    expect(note).toMatchObject({
      from: "soc",
      about: "Improvement request: a link to the campaign page on the site",
      replyTo: "Acme/soc-campaign",
      status: "open",
      kind: "improvement-request",
      ask: "soc-campaign/E905-A9",
      request: "open",
      campaign: "Launch campaign",
      doneMeans: "the site's home links to the campaign page",
    });
    expect(note.body).toMatch(/^Sam approved this improvement request on 2026-11-10 on his card E905-A9 \(soc\)\.$/m);
    expect(note.body).toContain("desk_note.py reply <this note> --request taken --row <your row code>");
    // his own words, when he wrote more than APPROVED, travel with it
    expect(parseNote(n.rel, improvementNote(input({ answer: "yes, before Friday" })).text)!.body).toContain('His words: "yes, before Friday"');
  });

  it("hands it once: a second yes finds the note already there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e101s8-hand-"));
    try {
      const writes: string[] = [];
      const writer = {
        scaffold: async (o: { repoDir: string; scaffold: (d: string) => Promise<{ ok: true; files: string[] } | { ok: false; error: string }> }) => {
          const r = await o.scaffold(o.repoDir);
          if (!r.ok) return { status: "skipped" as const, reason: r.error };
          writes.push(...r.files);
          return { status: "written" as const, sha: "abc1234" };
        },
      };
      const first = await handImprovement(input(), { checkout: dir, policyPath: "docs/spines/root.md" }, writer as never);
      expect(first).toMatchObject({ state: "handed", rel: "desk/inbox/2026-11-10-soc-improvement-e905-a9.md", sha: "abc1234" });
      const again = await handImprovement(input({ approvedOn: "2026-11-11" }), { checkout: dir, policyPath: "docs/spines/root.md" }, writer as never);
      expect(again).toMatchObject({ state: "already", rel: "desk/inbox/2026-11-10-soc-improvement-e905-a9.md" });
      expect(writes).toEqual(["desk/inbox/2026-11-10-soc-improvement-e905-a9.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which desk builds it", () => {
  const worlds: WorldRow[] = [
    { id: "home", skin: "console", plan: "internal", owner: "Sam", paused: 0 },
    { id: "soc", skin: "social", plan: "internal", owner: "Sam", paused: 0 },
    { id: "acme", skin: "console", plan: "customer", owner: "Ana", paused: 0 },
    { id: "old", skin: "console", plan: "internal", owner: "Sam", paused: 1 },
  ];
  const pairs = parsePairs("home:soc");
  it("EpicTeam is the paired EpicTeam world; a world id is that world", () => {
    expect(resolveImprovementTarget("EpicTeam", "soc", worlds, pairs)).toBe("home");
    expect(resolveImprovementTarget("home", "soc", worlds, pairs)).toBe("home");
  });
  it("never another owner's world, a paused one, itself, or an unknown one", () => {
    expect(resolveImprovementTarget("acme", "soc", worlds, pairs)).toMatchObject({ error: expect.stringMatching(/one owner's worlds/) });
    expect(resolveImprovementTarget("old", "soc", worlds, pairs)).toMatchObject({ error: expect.stringMatching(/paused/) });
    expect(resolveImprovementTarget("soc", "soc", worlds, pairs)).toMatchObject({ error: expect.stringMatching(/itself/) });
    expect(resolveImprovementTarget("nowhere", "soc", worlds, pairs)).toMatchObject({ error: expect.stringMatching(/no world/) });
    expect(resolveImprovementTarget("EpicTeam", "soc", worlds, parsePairs(""))).toMatchObject({ error: expect.stringMatching(/no EpicTeam desk paired/) });
  });
});

describe("the wake sections", () => {
  const n = improvementNote(input());
  const open = parseNote(n.rel, n.text)!;
  it("the builder's Delivery Manager is told to make one row and answer taken with its code, never to ask him again", () => {
    const s = deskInboxSection([open], "home_repo")!;
    expect(s).toContain("An **improvement request** note");
    expect(s).toContain("Do not ask him again");
    expect(s).toContain("--request taken --row <row code>");
  });
  it("the asker sees each request it handed and its state, until done or declined", () => {
    const taken = { ...open, request: "taken", row: "E909-S4", status: "answered" };
    const s = improvementsOutSection("soc", [{ world: "home", repo: "home_repo", note: taken }])!;
    expect(s).toMatch(/^## Improvement requests out \(1 waiting/);
    expect(s).toContain("- soc-campaign/E905-A9 → home (home_repo:desk/inbox/2026-11-10-soc-improvement-e905-a9.md): a link to the campaign page on the site: **taken**, its row E909-S4");
    expect(improvementsOutSection("soc", [{ world: "home", repo: "home_repo", note: { ...taken, request: "done" } }])).toBeUndefined();
    // another world's requests are not this world's
    expect(improvementsOutSection("social", [{ world: "home", repo: "home_repo", note: taken }])).toBeUndefined();
  });
  it("the builder keeps the ones it took until it tells the sender done", () => {
    const s = improvementsTakenSection([{ ...open, request: "taken", row: "E909-S4", status: "answered" }])!;
    expect(s).toContain("desk_note.py done");
    expect(s).toContain("row E909-S4");
    expect(improvementsTakenSection([open])).toBeUndefined();
  });
});

// ---------- end to end: his yes on the console hands the note to the other world's repo ----------

let tmp: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const REL = "docs/spines/root.md";
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM, p: process.env.CONSOLE_DESK_PAIRS };
const dbs: DB[] = [];

function makeRepo(name: string, text: string) {
  const origin = path.join(tmp, `${name}.git`);
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), text);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(tmp, ["clone", "-q", origin, path.join(tmp, name)]);
  return (rel: string) => {
    try {
      return git(origin, ["show", `main:${rel}`]);
    } catch {
      return undefined;
    }
  };
}

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  process.env.CONSOLE_DESK_PAIRS = "home:soc";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e101s8-"));
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s], ["CONSOLE_DESK_PAIRS", saved.p]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function boot() {
  const db = openDb(path.join(tmp, "console.db"));
  dbs.push(db);
  const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const t3 = { listProjects: async () => [], listScheduledTasks: async () => [], launchThread: async () => ({ threadId: "t" }), sendToThread: async () => {}, readThreadStatus: async () => ({ status: "idle", raw: {} }) };
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    answers: { retryMs: [] },
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { db, call };
}

describe("end to end: Sam approves SocialApp's improvement request", () => {
  const TEAM = "# Root: home_repo\n\n## Current State\n\nStatus: active\nWaiting on: nobody\n";
  const SOC = (line: string) => `# EPIC-905: Launch campaign\n\n## Current State\n\nStatus: active\nWaiting on: Sam: E905-A9\n\n## Waiting on\n\n${line}\n`;

  async function setup(line = ASK) {
    const team = makeRepo("home_repo", TEAM);
    const soc = makeRepo("soc-campaign", SOC(line));
    const { db, call } = boot();
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES ('home', 'home', ?)").run(now);
    db.prepare("INSERT INTO tenants (id, name, skin, created_at) VALUES ('soc', 'Soc', 'social', ?)").run(now);
    await call("POST", "/api/milestones", { title: "Team", repo: "Acme/home_repo", path: REL });
    const ms = (await call("POST", "/api/milestones", { title: "Launch campaign", repo: "Acme/soc-campaign", path: REL })).json;
    db.prepare("UPDATE milestones SET tenant_id = 'soc' WHERE id = ?").run(ms.id);
    const item = ((await call("GET", "/api/waiting-on-owner")).json as WaitingItem[]).find((i) => i.code === "E905-A9")!;
    return { team, soc, call, db, ms, item };
  }

  it("his card reads as an improvement request; his yes drops one note in EpicTeam's desk inbox and records where", async () => {
    const { team, soc, call, ms, item } = await setup();
    expect(item.improvement).toEqual({ to: "EpicTeam", campaign: "Launch campaign", doneMeans: "the site's home links to the campaign page" });
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "approve", text: "", milestoneId: ms.id, wake: false });
    expect(r.status).toBe(201);
    expect(r.json.spine).toMatchObject({ status: "written" });
    expect(soc(REL)).toMatch(/^- \[answered E905-A9 \d{4}-\d{2}-\d{2} @Sam\] Improvement request: .* — answer: APPROVED$/m);
    const day = new Date().toISOString().slice(0, 10);
    const rel = `desk/inbox/${day}-soc-improvement-e905-a9.md`;
    const note = parseNote(rel, team(rel) ?? "");
    expect(note).toMatchObject({ from: "soc", kind: "improvement-request", ask: "soc-campaign/E905-A9", request: "open", campaign: "Launch campaign", status: "open" });
    expect(git(path.join(tmp, "home_repo.git"), ["log", "-1", "--format=%s", "main"])).toBe("Desk note from soc: improvement request E905-A9 approved by Sam (console)");
    const resp = (await call("GET", `/api/owner-responses?itemId=${item.id}`)).json[0];
    expect(resp.item.improvementHanded).toBe(`home_repo:${rel}`);
    // only that one file in EpicTeam's repo
    expect(git(path.join(tmp, "home_repo.git"), ["show", "--name-only", "--format=", "main"])).toBe(rel);
  });

  it("changes wanted hands nothing", async () => {
    const { team, call, ms, item } = await setup();
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "feedback", text: "ask for the footer link too", milestoneId: ms.id, wake: false });
    expect(r.status).toBe(201);
    expect(git(path.join(tmp, "home_repo.git"), ["log", "--format=%s", "main"])).toBe("seed");
    expect(team("desk/inbox")).toBeUndefined();
  });

  it("a to: that names no world of his is refused on the answer, his yes still written", async () => {
    const { call, db, ms, item } = await setup(ASK.replace("to: EpicTeam", "to: acme"));
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "approve", text: "", milestoneId: ms.id, wake: false });
    expect(r.json.spine).toMatchObject({ status: "written" });
    const resp = (await call("GET", `/api/owner-responses?itemId=${item.id}`)).json[0];
    expect(resp.item.improvementError).toMatch(/no world "acme"/);
    expect(git(path.join(tmp, "home_repo.git"), ["log", "--format=%s", "main"])).toBe("seed");
    // fixed in the world's settings, Retry hands it (a written answer is otherwise never delivered again)
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('acme', 'Acme', ?)").run(new Date().toISOString());
    const team = (await call("GET", "/api/milestones")).json.find((m: { title: string }) => m.title === "Team");
    db.prepare("UPDATE milestones SET tenant_id = 'acme' WHERE id = ?").run(team.id);
    const again = await call("POST", `/api/owner-responses/${resp.id}/deliver`);
    expect(again.status).toBe(200);
    expect(again.json.item.improvementHanded).toMatch(/^home_repo:desk\/inbox\/.*-soc-improvement-e905-a9\.md$/);
    expect(again.json.item.improvementError).toBeUndefined();
    expect((await call("POST", `/api/owner-responses/${resp.id}/deliver`)).status).toBe(409);
  });
});

describe("one kind: hand-made and console-made requests read the same", () => {
  // a social world repo's note of 2026-11-11 (the code repo desk/inbox/2026-11-11-a social world repo-improvement-request-memomemory-about-10.md)
  const HAND =
    "---\nfrom: social\nabout: Improvement request: @MemoMemory about 10 X posts a day and a pin action (social EPIC-900-A27, E900-S62)\nreply-to: acme-ai/social\nstatus: answered\nanswered: acme-ai/social:desk/inbox/2026-11-11-home-re-x.md\n---\nSam 2026-11-11: \"there are like short snippets\"\n";

  it("reads a note without kind: as an improvement request when its about says so, naming its ask", () => {
    const n = parseNote("desk/inbox/hand.md", HAND)!;
    expect(n).toMatchObject({ kind: "improvement-request", ask: "social/EPIC-900-A27", status: "answered" });
    expect(parseNote("a.md", "---\nfrom: a\nabout: Re: Improvement request: x\n---\n")!.kind).toBe("improvement-request");
    expect(parseNote("b.md", "---\nfrom: a\nabout: Console suite red\n---\n")!.kind).toBeUndefined();
  });

  it("lists a hand-answered request as answered, pointing at its answer, not as waiting", () => {
    const out = improvementsOutSection("social", [{ world: "home", repo: "home_repo", note: parseNote("desk/inbox/hand.md", HAND)! }])!;
    expect(out).toContain("social/EPIC-900-A27 → home");
    expect(out).toContain("**answered** (by hand");
    expect(out).not.toContain("not answered yet");
  });

  it("holds an improvement request that does not cite Sam's words, even with a why Sam: reason", () => {
    const today = "2026-11-11";
    const gated = (line: string) => askGateProblem(parseAsks(`## Waiting on\n${line}`)[0]);
    const base = `- [ask E905-A9: approve @Sam since ${today} row E905-S3] Improvement request: a pin action — label: improvement request — to: EpicTeam — campaign: Launch — why Sam: it spends money on EpicTeam's time`;
    expect(gated(base)).toMatch(/improvement request that does not cite Sam's words/);
    expect(gated(`${base} — context: Sam said "we should have pinned tweets" on WhatsApp`)).toBeUndefined();
    expect(gated(`${base} — context: his voice note vn_90e52231`)).toBeUndefined();
    // an ordinary approve ask keeps the old rule: a tier reason carries it
    expect(gated(`- [ask E905-A8: approve @Sam since ${today}] Buy the domain — why Sam: it costs money`)).toBeUndefined();
  });

  it("carries the words the ask cites in the note's approved:", () => {
    expect(citeOf(["a pin", 'Sam said "we should have pinned tweets"'])).toBe('"we should have pinned tweets"');
    expect(citeOf(["Memo Log/2026-11-10.md#^e-449504"])).toBe("Log/2026-11-10.md#^e-449504");
    const n = parseNote("x.md", improvementNote(input({ cites: '"we should have pinned tweets"' })).text)!;
    expect(n.body).toBeTruthy();
    expect(improvementNote(input({ cites: '"we should have pinned tweets"' })).text).toMatch(/^approved: Sam 2026-11-10 on card E905-A9, citing "we should have pinned tweets"$/m);
  });
});
