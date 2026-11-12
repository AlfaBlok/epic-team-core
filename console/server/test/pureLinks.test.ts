import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { parseAsks } from "../src/inbox/asks.js";
import { settledNote } from "../src/inbox/asker.js";
import { closingAnswer, exactLinks, findSettles, guarded, isDecline, namesAsSame, settleLine, sitesOf, type Judge, type SettleSource } from "../src/inbox/settles.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * one answer closes many. Fixtures are read-only copies of this week's real duplicates in the code repo's
 * spines (2026-11-09): the X sign-in asked three ways (the last two written by the hourly
 * signed-in check), and the Stripe asks.
 */

// docs/spines/red-browse-the-web-at-will-with-reliable.md, as first written (git history, 2026-11-09)
const E86_A1 =
  "- [ask E986-A1: do @Sam since 2026-11-09 row E986-S1] Sign back in to X as @MemoAgent on your Mac, then do one sync with five sites, about 3 minutes. — context: the team's browser is fixed (X now loads; Instagram, TikTok, LinkedIn and signed-in X go only through your Mac), but X dropped the @MemoAgent login at 05:48Z after one test read from our server in Germany, so the X tools are stopped, and Instagram, TikTok and LinkedIn were never synced. — impact: the team reads and acts signed in on X (@MemoAgent and @SocialAppHQ), Instagram, TikTok, LinkedIn and Airbnb without asking you again; the X tools restart by themselves. — recommend: do it now for X; add Instagram, TikTok and LinkedIn once the E983-A7 steps made them (one sync can carry all five). — why Sam: only you can sign in on your Mac. — steps: in Chrome (example.com profile) sign in to X as @MemoAgent, keep @SocialAppHQ in the account switcher, sign in to Instagram, TikTok, LinkedIn and Airbnb; console → Browser auth → Sync, type `*.x.com, *.instagram.com, *.tiktok.com, *.linkedin.com, *.airbnb.com`, paste the command into Terminal; say done. — unblocks: E86-2, E86-4";
const E86_A2 =
  "- [ask E986-A2: do @Sam since 2026-11-09] The team's browser is signed out of x.com. Sign in to x.com as @MemoAgent in Chrome (example.com (Default) profile), then on the console's Browser auth page press Sync for *.x.com and run the command it gives you on your Mac. — context: raised by an API caller through the console API; the console wrote this line (E962-S4) — same step as E986-A1 (one sync with the five sites carries the X sign-in and the *.x.com sync): answering E986-A1 answers this one too (merged by Epic Spine health 2026-11-09, one question for Sam)";
const E86_A3 =
  "- [ask E986-A3: do @Sam since 2026-11-09] The team's browser is signed out of airbnb.com. Sign in to airbnb.com in Chrome (example.com (Default) profile), then on the console's Browser auth page press Sync for *.airbnb.com and run the command it gives you on your Mac. — context: raised by an API caller through the console API; the console wrote this line (E962-S4) — same step as E986-A1 (one sync with the five sites carries the Airbnb sign-in and the *.airbnb.com sync): answering E986-A1 answers this one too (merged by Epic Spine health 2026-11-09, one question for Sam)";
// docs/spines/epic-946-epic-social-launch.md (git history)
const E46_A8 =
  "- [ask E946-A8: do @Sam since 2026-11-04 row E946-S13] Paste the new one-off $10 Stripe link for testers? See the new screens here: http://worker.tail.example:8823/index.html — context: both the page and the posts promise $10 once for the month, and the console no longer offers the old monthly link, so a picked tester has no way to pay until the new link exists — impact: an agent puts the link into the console and deploys — recommend: make it before 7 Nov 14:00 UTC — why Sam: agents may not use the Memo Stripe key — steps: 1) in Stripe on the Memo account, open the product Epic Social tester and add a price: one-off, 10.00 USD; 4) paste the https://buy.stripe.com/ link as your answer (it is not a secret) — unblocks: E946-S5 (first paying tester)";
const E46_A21 =
  "- [ask E946-A21: do @Sam since 2026-11-08 row E946-S13] Paste the new one-off $10 Stripe link for testers (lowest priority of these asks: not needed while the testers posts are held) — context: the testers page and posts promise $10 once for the month, the console no longer offers the old monthly link, the first picked tester cannot pay until the link exists, and agents may not use the Memo Stripe key — impact: an agent puts the link into the console (stripeTesters.ts ONE_OFF_LINK) and deploys — recommend: do it before you lock the launch — why Sam: the Memo Stripe account is yours and agents may not use its key — steps: 1) in Stripe on the Memo account open the product Epic Social tester and add a price: one-off, 10.00 USD; 4) paste the https://buy.stripe.com/ link as your answer (not a secret) — unblocks: E946-S5";
// docs/spines/epic-981-… (git history)
const E81_A4 =
  "- [ask E981-A4: do @Sam since 2026-11-09 row E981-S6] Create Epic Team's own Stripe account and put its test-mode key in the secret store, so we can make the €49 a month checkout and test it with a test card. — context: you said yes to €49 a month on the customer's own AI key (E981-A3), but Epic Team has no Stripe account or key of its own — recommend: yes, a restricted test key — why Sam: only you can open a Stripe account in the company's name — unblocks: E981-S6";
const E83_A7 =
  "- [ask E983-A7: do @Sam since 2026-11-09 row E983-S3] Do your account steps on one page, about 25 minutes: make the Instagram, TikTok and LinkedIn accounts for SocialApp. — context: the accounts do not exist yet — recommend: do them in one sitting — why Sam: only you can make accounts in your name — unblocks: E983-S3";

const spineOf = (...lines: string[]) => `# EPIC-986: Browse the web\n\n## Current State\n\nStatus: active\nWaiting on: Sam: E986-A1, E986-A2, E986-A3\n\n## Waiting on\n\n${lines.join("\n")}\n`;

/** WaitingItems as the inbox gives them, from the fixture lines (repo `the code repo`). */
function items(repo: string, ...lines: string[]): WaitingItem[] {
  return parseAsks(spineOf(...lines)).map((a, n) => ({
    id: `wj_${repo}_${a.code}`,
    source: "ask",
    repo,
    code: a.code ?? undefined,
    row: a.row ?? undefined,
    who: a.who,
    state: a.state === "open" ? "open" : "answered",
    question: a.question,
    ...(a.contextText ? { contextText: a.contextText } : {}),
    ...(a.steps ? { steps: a.steps } : {}),
    ...(a.recommend ? { recommendation: a.recommend } : {}),
    ...(a.impact ? { impact: a.impact } : {}),
    ...(a.unblocks ? { unblocks: a.unblocks } : {}),
    ask: a.ask,
    milestoneId: "ms_x",
    milestoneTitle: "x",
    path: "docs/spines/x.md",
    line: a.line ?? n,
    title: a.question,
    contextLinks: [],
    owner: { kind: "none", label: "" },
    decidable: false,
  }));
}
const srcOf = (it: WaitingItem, words: string, answerKind: SettleSource["answerKind"] = "answer"): SettleSource => ({
  kind: "ask",
  itemId: it.id,
  repo: it.repo,
  code: it.code,
  row: it.row,
  ask: it.ask,
  question: it.question,
  detail: [it.contextText, it.steps, it.recommendation, it.impact].filter(Boolean).join(" — "),
  answerKind,
  words,
  label: `${it.repo}/${it.code}`,
  link: "https://github.com/Acme/home_repo/blob/abc1234/docs/spines/x.md?plain=1#L9",
});

describe("E990-S2 pure: the links", () => {
  const all = items("home_repo", E86_A1, E86_A2, E86_A3, E46_A8, E46_A21, E81_A4, E83_A7);
  const by = (code: string) => all.find((i) => i.code === code)!;

  it("names the same step: the duplicate the hourly check wrote says so", () => {
    expect(namesAsSame(E86_A2, "E986-A1")).toBe(true);
    expect(namesAsSame("same step as home_repo/E986-A1", "E986-A1", "home_repo")).toBe(true);
    expect(namesAsSame("E986-A1 answers this one too", "E986-A1")).toBe(true);
    // a code that only starts the same never matches, nor a mere mention
    expect(namesAsSame("same step as E986-A12", "E986-A1")).toBe(false);
    expect(namesAsSame("once the E986-A1 steps are done", "E986-A1")).toBe(false);
  });

  it("E986-A2 and E986-A3 link strongly to E986-A1; the Stripe and account asks do not", () => {
    const src = srcOf(by("E986-A1"), "done");
    expect(exactLinks(src, by("E986-A2")).map((l) => l.kind)).toEqual(expect.arrayContaining(["names-same", "same-site"]));
    expect(exactLinks(src, by("E986-A3")).map((l) => l.kind)).toContain("names-same");
    expect(exactLinks(src, by("E981-A4"))).toEqual([]);
    // shares sites (Instagram, TikTok, LinkedIn) but nothing strong: only a candidate for the model
    expect(exactLinks(src, by("E983-A7")).every((l) => l.kind === "same-site")).toBe(true);
  });

  it("the Stripe link asks are the same row and nearly the same question, and they are money", () => {
    const src = srcOf(by("E946-A8"), "https://buy.stripe.com/test_123");
    expect(exactLinks(src, by("E946-A21")).map((l) => l.kind)).toEqual(expect.arrayContaining(["same-row", "same-site"]));
    expect(guarded(by("E946-A21"))).toMatch(/money/);
    expect(guarded(by("E981-A4"))).toMatch(/money/);
    expect(guarded(by("E986-A2"))).toBeUndefined();
    expect(sitesOf(E86_A2)).toEqual(new Set(["x.com"]));
  });

  it("a no, a not yet or feedback is a decline", () => {
    expect(isDecline("deny", "")).toBeTruthy();
    expect(isDecline("feedback", "why MemoAgent?")).toBeTruthy();
    expect(isDecline("answer", "No, wait for the rename")).toBeTruthy();
    expect(isDecline("answer", "not yet")).toBeTruthy();
    expect(isDecline("answer", "done")).toBeUndefined();
    expect(isDecline("approve", "")).toBeUndefined();
  });
});

describe("E990-S2 pure: what one answer closes", () => {
  const all = items("home_repo", E86_A1, E86_A2, E86_A3, E46_A8, E46_A21, E81_A4, E83_A7);
  const by = (code: string) => all.find((i) => i.code === code)!;

  it("no model: his done on E986-A1 closes E986-A2 and E986-A3 (strong links); E983-A7 is only a maybe; Stripe untouched", async () => {
    const r = await findSettles(srcOf(by("E986-A1"), "done"), all);
    expect(r.close.map((m) => m.code).sort()).toEqual(["home_repo/E986-A2", "home_repo/E986-A3"]);
    expect(r.maybe.map((m) => m.code)).toEqual(["home_repo/E983-A7"]);
    expect(r.maybe[0].reason).toMatch(/^only the same site .*not checked$/);
    expect(r.checked).toBe(0);
    expect(settleLine(r)).toBe("your answer also closed home_repo/E986-A2, home_repo/E986-A3. maybe also settles: home_repo/E983-A7");
  });

  it("with the model: its yes closes and its reason is kept, its no drops a weak link and keeps a strong one as a maybe", async () => {
    const asked: string[] = [];
    const judge: Judge = async (_s, c) => {
      asked.push(c.code!);
      return c.code === "E986-A2" ? { settles: true, reason: "the same X sign-in and sync" } : { settles: false, reason: "another site" };
    };
    const r = await findSettles(srcOf(by("E986-A1"), "done"), all, judge);
    expect(asked.sort()).toEqual(["E983-A7", "E986-A2", "E986-A3"]);
    expect(r.close).toEqual([expect.objectContaining({ code: "home_repo/E986-A2", reason: "the same X sign-in and sync", check: { settles: true, reason: "the same X sign-in and sync" } })]);
    expect(r.maybe.map((m) => m.code)).toEqual(["home_repo/E986-A3"]);
    expect(r.maybe[0].reason).toMatch(/^the check said no: another site/);
  });

  it("never a money ask by inference: the Stripe link pasted on E946-A8 leaves E946-A21 open as a maybe, even on a model yes", async () => {
    const r = await findSettles(srcOf(by("E946-A8"), "https://buy.stripe.com/test_123"), all, async () => ({ settles: true, reason: "the same link" }));
    expect(r.close).toEqual([]);
    expect(r.maybe.map((m) => m.code)).toContain("home_repo/E946-A21");
    expect(r.maybe.find((m) => m.code === "home_repo/E946-A21")!.reason).toMatch(/it is about money/);
  });

  it("never on a decline: his no on E986-A1 closes nothing, the duplicates come back as maybes", async () => {
    for (const [kind, words] of [["answer", "No, wait until I renamed it"], ["feedback", "Why MemoAgent? We moved to MemoMemory"], ["deny", ""]] as const) {
      const r = await findSettles(srcOf(by("E986-A1"), words, kind), all, async () => ({ settles: true, reason: "same" }));
      expect(r.close).toEqual([]);
      expect(r.maybe.map((m) => m.code)).toEqual(expect.arrayContaining(["home_repo/E986-A2", "home_repo/E986-A3"]));
    }
  });

  it("a model that fails: only strong links close, and the error is kept", async () => {
    const r = await findSettles(srcOf(by("E986-A1"), "done"), all, async () => {
      throw new Error("the console has no OPENAI_API_KEY");
    });
    expect(r.close.map((m) => m.code).sort()).toEqual(["home_repo/E986-A2", "home_repo/E986-A3"]);
    expect(r.judgeError).toMatch(/OPENAI_API_KEY/);
  });

  it("other repos count (the world), asks for someone else, answered or decided ones never", async () => {
    const other = items("social", E86_A2.replace("same step as E986-A1", "same step as home_repo/E986-A1").replace("E986-A2", "EPIC-900-A22"));
    const notJordi = items("home_repo", E86_A3.replace("@Sam", "@Ops").replace("E986-A3", "E986-A9"));
    const answered = { ...by("E986-A2"), id: "wj_done", state: "answered" as const };
    const r = await findSettles(srcOf(by("E986-A1"), "done"), [...other, ...notJordi, answered, by("E986-A1")]);
    expect(r.close.map((m) => m.code)).toEqual(["social/EPIC-900-A22"]);
    expect(r.maybe).toEqual([]);
  });

  it("the closing answer quotes him, links where he said it and says why", () => {
    const m = { itemId: "x", code: "home_repo/E986-A2", links: [], reason: "the same X sign-in and sync" };
    expect(closingAnswer(srcOf(by("E986-A1"), "done — synced all five"), m)).toBe(
      "via home_repo/E986-A1: “done - synced all five” [where he said it](https://github.com/Acme/home_repo/blob/abc1234/docs/spines/x.md?plain=1#L9). One answer closes many: the same X sign-in and sync",
    );
    expect(settledNote({ closed: ["home_repo/E986-A2"], maybe: ["home_repo/E983-A7"], label: "home_repo/E986-A1" })).toMatch(
      /^ The same answer also closed home_repo\/E986-A2 .* It may also settle home_repo\/E983-A7: judge each against his words/,
    );
    expect(settledNote({ closed: [], maybe: [], label: "x" })).toBe("");
  });
});

// ---------- end to end: the console's answer path, two repos of one world ----------

let tmp: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const REL = "docs/spines/root.md";
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
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
  return () => git(origin, ["show", `main:${REL}`]);
}

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e90s2-"));
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function boot(settle?: { judge?: Judge }) {
  const db = openDb(path.join(tmp, "console.db"));
  dbs.push(db);
  const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const t3 = { listProjects: async () => [], listScheduledTasks: async () => [], launchThread: async () => ({ threadId: "t" }), sendToThread: async () => {}, readThreadStatus: async () => ({ status: "idle", raw: {} }) };
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    answers: { retryMs: [] },
    ...(settle ? { settle } : {}),
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { db, call };
}

describe("E990-S2 end to end: answering E986-A1 on the console", () => {
  const MAIN = spineOf(E86_A1, E86_A2, E86_A3, E81_A4);
  const OTHER = `# EPIC-900: Memo social\n\n## Current State\n\nStatus: active\nWaiting on: Sam: EPIC-900-A22, EPIC-900-A23\n\n## Waiting on\n\n${E86_A2.replace("E986-A2", "EPIC-900-A22").replace("same step as E986-A1", "same step as home_repo/E986-A1")}\n${E46_A21.replace("E946-A21", "EPIC-900-A23")}\n`;

  it("closes the duplicates in both repos with his words and a link, leaves the rest open, and says so in one line", async () => {
    const mainOnOrigin = makeRepo("home_repo", MAIN);
    const otherOnOrigin = makeRepo("social", OTHER);
    const asked: string[] = [];
    const { call } = boot({
      judge: async (_s, c) => {
        asked.push(c.code!);
        return { settles: /x\.com|airbnb/.test(c.question), reason: /x\.com/.test(c.question) ? "the same X sign-in and sync" : "the Airbnb sign-in rides on the same five-site sync" };
      },
    });
    const m1 = (await call("POST", "/api/milestones", { title: "Team", repo: "Acme/home_repo", path: REL })).json;
    await call("POST", "/api/milestones", { title: "Memo social", repo: "Acme/social", path: REL });
    const open = (await call("GET", "/api/waiting-on-owner")).json as WaitingItem[];
    const a1 = open.find((i) => i.code === "E986-A1")!;
    expect(a1).toBeTruthy();
    const r = await call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "done, synced all five", milestoneId: m1.id, wake: false });
    expect(r.status).toBe(201);
    expect(r.json.spine).toMatchObject({ status: "written" });

    const main = mainOnOrigin();
    expect(main).toMatch(/^- \[answered E986-A1 \d{4}-\d{2}-\d{2} @Sam\] Sign back in to X .* — answer: done, synced all five$/m);
    expect(main).toMatch(/^- \[answered E986-A2 \d{4}-\d{2}-\d{2} @Sam\] The team's browser is signed out of x\.com\..* — answer: via home_repo\/E986-A1: “done, synced all five”.* One answer closes many: the same X sign-in and sync$/m);
    expect(main).toMatch(/^- \[answered E986-A3 \d{4}-\d{2}-\d{2} @Sam\] The team's browser is signed out of airbnb\.com\..* — answer: via home_repo\/E986-A1: “done, synced all five”/m);
    expect(main).toMatch(/^- \[ask E981-A4: do @Sam/m); // Stripe: no link, untouched
    expect(main).toContain("Waiting on: nobody\n"); // the three E86 codes left Current State's field
    const other = otherOnOrigin();
    expect(other).toMatch(/^- \[answered EPIC-900-A22 \d{4}-\d{2}-\d{2} @Sam\] .* — answer: via home_repo\/E986-A1: “done, synced all five”/m);
    expect(other).toMatch(/^- \[ask EPIC-900-A23: do @Sam/m); // money, never by inference (and no link to)
    expect(other).toContain("Waiting on: Sam: EPIC-900-A23\n");
    expect(asked.sort()).toEqual(["E986-A2", "E986-A3", "EPIC-900-A22"]);
    // each close is its own commit, saying where his answer came from
    expect(git(path.join(tmp, "social.git"), ["log", "-1", "--format=%s", "main"])).toBe("Answer EPIC-900-A22: answered by Sam's answer to home_repo/E986-A1 (one answer closes many)");

    // the one line he reads, on the response (card, desk)
    const resp = (await call("GET", `/api/owner-responses?itemId=${a1.id}`)).json[0];
    expect(resp.settles.line).toBe("your answer also closed home_repo/E986-A2, home_repo/E986-A3, social/EPIC-900-A22");
    expect(resp.settles.closed.map((c: any) => c.write.status)).toEqual(["written", "written", "written"]);
    // the inbox no longer shows them
    const after = (await call("GET", "/api/waiting-on-owner")).json as WaitingItem[];
    expect(after.filter((i) => i.state === "open").map((i) => i.code).sort()).toEqual(["E981-A4", "EPIC-900-A23"]);
  });

  it("off by default: without settle the answer closes only its own ask", async () => {
    const mainOnOrigin = makeRepo("home_repo", MAIN);
    const { call } = boot();
    const m1 = (await call("POST", "/api/milestones", { title: "Team", repo: "Acme/home_repo", path: REL })).json;
    const a1 = ((await call("GET", "/api/waiting-on-owner")).json as WaitingItem[]).find((i) => i.code === "E986-A1")!;
    await call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "done", milestoneId: m1.id, wake: false });
    const main = mainOnOrigin();
    expect(main).toMatch(/^- \[ask E986-A2: do @Sam/m);
    expect((await call("GET", `/api/owner-responses?itemId=${a1.id}`)).json[0].settles).toBeUndefined();
  });
});
