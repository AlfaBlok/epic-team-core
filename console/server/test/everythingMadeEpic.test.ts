import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpinesJson } from "../src/adapters/spines.js";
import { buildRepoBook, parseGitLog, type Book } from "../src/book/build.js";
import { deliverablesFor, kindOf, readCards, readDocEntries, readNotedPreviews, readPreviews, urlKey, type DeliverableSources } from "../src/book/deliverables.js";
import { bookUrls, bookWithChecks, createLinkChecker, type Fetcher } from "../src/book/links.js";
import { milestoneBook, type MilestoneBook } from "../src/book/milestone.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import { setSites } from "../src/identity.js";
// the suite's private network names one host by address and name (the sites config; ours are set by the hosted layer)
setSites({ tailnetNames: { "10.86.141.63": "worker.tail.example" } });


/** every Epic Book section lists everything made for its epic, from the repo, checked, never dropped. */

const SPINE = "docs/spines/epic-9-demo.md";
const MD = `# EPIC-909: Demo epic

## Goal

We want a demo. Not a deliverable: https://goal.example.net/

## Current State

Status: active
Evidence: [e9-s1](../status/e9-s1-report.md)
Last attempted: 2026-11-02 the deck is live at http://10.86.141.63:8971/ and the site at https://epicspine.dev/demo.

## Waiting on

- [ask E909-A1: approve @Sam since 2026-11-03 row E909-S2] Do you approve the mockup? — http://worker.tail.example:8971/ — context: a deck
- [feedback E909-A0 2026-11-01 @Sam] Pick a direction — http://worker.tail.example:8975/ (round 1 options page)

## Issue Ledger

| Issue | Role | Owner | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | seat | E9-1: the report | done | none | abc1234 | main | [e9-s1](../status/e9-s1-report.md): live https://social.example.com/demo | 2026-11-01 | none |
| E909-S2 | Ticket worker | seat | E9-2: the benefits mockup | review | none | none | main | http://worker.tail.example:8990/ (mockup with two options); PR https://github.com/Acme/home_repo/pull/9 | 2026-11-03 | none |
| E909-S3 | Ticket worker | seat | E9-3: an old page | done | none | none | main | [page](../status/e9-s3-gone.md) · https://tea | 2026-10-30 | none |

## Decisions

| Date | Outcome | Decision | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-11-04 | accepted | the plan | why | [plan](../plans/e9-plan/index.html) · http://localhost:5173/ | never |

## Operating Learnings

- L-1: see https://learnings.example.net/ (not a deliverable)
`;

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s4-"));
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w(SPINE, MD);
  w("docs/status/e9-s1-report.md", "# E909-S1: the demo report, checked live (E9-1)\n");
  w("docs/plans/e9-plan/index.html", "<html><head><title>The demo plan &amp; its options</title></head></html>");
  w("docs/proposals/e9-benefits/index.html", "<title>Benefits proposal</title>");
  w("docs/proposals/e9-benefits/index.md", "Round 1 was at http://worker.tail.example:8975/.\n\nOpen it at **http://worker.tail.example:8990/** (tailnet).\n");
  w("docs/proposals/e90-other/index.html", "<title>Another epic's page</title>");
  w("docs/cards/E909-S2.md", "---\nrow: E909-S2\nspine: epic-9-demo.md\ntitle: The benefits mockup was made with two options.\nevidence: [Open it](https://social.example.com/benefits)\nscreenshot: E909-S2.png\nconfirm: yes\n---\n");
  w("docs/cards/E909-S2.png", "png");
  w(
    "docs/status/previews.json",
    JSON.stringify({ previews: [{ url: "http://worker.tail.example:8971/", dir: "/srv/x/github/home_repo/docs/status/e9-deck", repo: "home_repo", path: "docs/status/e9-deck" }] }),
  );
  return dir;
}

const sources = (dir: string): DeliverableSources => {
  const docEntries = readDocEntries(dir);
  return {
    repoDir: dir,
    repoName: "home_repo",
    remote: "Acme/home_repo",
    spinePath: SPINE,
    markdown: MD,
    number: 9,
    fileDates: new Map([["docs/proposals/e9-benefits/index.html", "2026-11-03T10:00:00.000Z"]]),
    cards: readCards(dir),
    previews: readPreviews(dir),
    docEntries,
    noted: readNotedPreviews(dir, docEntries),
  };
};

describe("E947-S4 everything made for an epic", () => {
  let dir: string;
  beforeEach(() => {
    dir = fixture();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("gathers asks (open and answered), ledger cells, Current State, decisions, cards and the epic's own pages; skips the rest", () => {
    const made = deliverablesFor(sources(dir));
    const urls = made.map((d) => d.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "http://worker.tail.example:8971/", // deck, written by IP and by name: one item
        "https://epicspine.dev/demo",
        "http://worker.tail.example:8975/",
        "http://worker.tail.example:8990/",
        "https://social.example.com/demo",
        "https://social.example.com/benefits",
        "https://github.com/Acme/home_repo/blob/main/docs/status/e9-s1-report.md",
        "https://github.com/Acme/home_repo/blob/main/docs/status/e9-s3-gone.md",
        "https://github.com/Acme/home_repo/blob/main/docs/cards/E909-S2.png",
        "https://github.com/Acme/home_repo/tree/main/docs/plans/e9-plan",
      ]),
    );
    // not deliverables: the goal and learnings, a PR, localhost, a URL cut short in the spine, another epic's page
    for (const bad of ["goal.example.net", "learnings.example.net", "/pull/9", "localhost", "https://tea", "e90-other"]) expect(urls.join(" ")).not.toContain(bad);
    expect(urls.filter((u) => urlKey(u) === urlKey("http://10.86.141.63:8971/"))).toHaveLength(1);
    // the proposal folder its preview serves is one item: the preview, with the folder as fallback
    expect(urls.filter((u) => u.includes("e9-benefits"))).toEqual([]);
    const benefits = made.find((d) => d.url === "http://worker.tail.example:8990/")!;
    expect(benefits).toMatchObject({ label: "Benefits proposal", kind: "mockup", servePath: "home_repo/docs/proposals/e9-benefits", repoUrl: "https://github.com/Acme/home_repo/tree/main/docs/proposals/e9-benefits", date: "2026-11-03", row: "E909-S2" });
  });

  it("labels each plainly and says what kind it is", () => {
    const made = deliverablesFor(sources(dir));
    const by = (u: string) => made.find((d) => d.url === u)!;
    expect(by("https://github.com/Acme/home_repo/blob/main/docs/status/e9-s1-report.md")).toMatchObject({ label: "The demo report, checked live (E9-1)", kind: "evidence", date: "2026-11-01" });
    expect(by("https://github.com/Acme/home_repo/tree/main/docs/plans/e9-plan")).toMatchObject({ label: "The demo plan & its options", kind: "proposal", date: "2026-11-04" });
    expect(by("https://social.example.com/benefits")).toMatchObject({ label: "The benefits mockup was made with two options.", row: "E909-S2" });
    expect(by("https://github.com/Acme/home_repo/blob/main/docs/cards/E909-S2.png").label).toBe("Screenshot: The benefits mockup was made with two options.");
    expect(by("http://worker.tail.example:8971/")).toMatchObject({ kind: "deck", servePath: "home_repo/docs/status/e9-deck" });
    expect(by("http://worker.tail.example:8975/")).toMatchObject({ label: "Round 1 options page", kind: "proposal", row: "E909-A0" });
    expect(kindOf("https://social.example.com/", "Epic Social live")).toBe("live page");
    expect(kindOf("http://worker.tail.example:8000/", "Something")).toBe("preview");
  });

  it("trims a glob or a check off a link and a tag off a label", async () => {
    const { plainLabel } = await import("../src/book/deliverables.js");
    const md = "## Current State\n\nStatus: active\nLast attempted: 2026-11-02 the social pages https://epicspine.dev/social/** and the page http://worker.tail.example:47707/index.html (curl 200 2026-11-02).\n";
    const made = deliverablesFor({ ...sources(dir), markdown: md, number: undefined, cards: [] });
    expect(made.map((d) => d.url)).toEqual(expect.arrayContaining(["https://epicspine.dev/social/", "http://worker.tail.example:47707/index.html"]));
    expect(made.find((d) => d.url.includes("47707"))!.label).toBe("A page on worker, port 47707, index.html");
    expect(plainLabel("[home_repo + skill] Draft board")).toBe("Draft board");
    const steps = deliverablesFor({ ...sources(dir), markdown: "## Waiting on\n\n- [ask E909-A3: approve @Sam row E909-S4] Make the payment link? — steps: 3) open it, 4) paste the https://buy.example.net/x into the box\n", number: undefined, cards: [] });
    expect(steps.find((d) => d.url === "https://buy.example.net/x")!.label).toBe("Make the payment link?");
  });

  it("is newest first, undated last, and marks a repo page that is gone instead of dropping it", () => {
    const made = deliverablesFor(sources(dir));
    const dates = made.map((d) => d.date ?? "");
    expect(dates).toEqual([...dates].sort().reverse());
    expect(made.find((d) => d.url.endsWith("e9-s3-gone.md"))!.check).toMatchObject({ state: "gone" });
  });

  it("a stopped preview the registry never saw finds its folder from that folder's own notes", () => {
    const s = { ...sources(dir), previews: [] };
    const made = deliverablesFor(s);
    expect(made.find((d) => d.url === "http://worker.tail.example:8990/")!.servePath).toBe("home_repo/docs/proposals/e9-benefits");
    // "Round 1 was at …:8975" is a mention, not where that folder is served
    expect(made.find((d) => d.url === "http://worker.tail.example:8975/")!.servePath).toBeUndefined();
  });

  it("the book carries it per epic, and a milestone's book has one section per epic with each link's last check", () => {
    const spines: SpinesJson = {
      root: SPINE,
      orphans: [],
      mismatches: [],
      nodes: [{ id: SPINE, path: SPINE, title: "EPIC-909: Demo epic", parent: null, status: "active", rollup_status: "active", dod: [], children: [] }],
    };
    const repo = buildRepoBook({ name: "home_repo", path: dir, remote: "Acme/home_repo" }, spines, parseGitLog(""), undefined, { previews: readPreviews(dir) });
    const book: Book = { builtAt: "2026-11-04T10:00:00Z", repos: [repo], counts: repo.counts };
    expect(repo.epics[0].made!.length).toBeGreaterThan(8);
    const links = { get: (u: string) => (u.includes(":8975") ? { state: "not running" as const, at: "2026-11-04T10:00:00Z", detail: "ECONNREFUSED" } : undefined) };
    const mb = milestoneBook(book, { id: "m1", repoName: "home_repo", path: SPINE }, { links })!;
    expect(mb.made.map((m) => [m.code, m.depth])).toEqual([["EPIC-909", 0]]);
    expect(mb.made[0].items.find((d) => d.url.includes(":8975"))!.check).toMatchObject({ state: "not running" });
    const slim = bookWithChecks(book, links);
    expect(slim.repos[0].epics[0].made!.find((d) => d.url.includes(":8975"))!.check!.state).toBe("not running");
    expect(book.repos[0].epics[0].made!.find((d) => d.url.includes(":8975"))!.check).toBeUndefined(); // stored book untouched
    expect(bookUrls(book).some((u) => u.startsWith("https://github.com/"))).toBe(false); // repo files are checked on disk
  });
});

describe("E947-S4 link checker", () => {
  it("tailnet refused = not running, 404 = gone, 5xx elsewhere = down, HEAD refused retried with GET; the console's own hosts are not fetched; once per ttl", async () => {
    let t = 1_000_000;
    const calls: string[] = [];
    const fetcher: Fetcher = async (u, init) => {
      calls.push(`${init.method} ${u}`);
      if (u.includes(":8975")) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (u.includes("gone")) return { status: 404 };
      if (u.includes("broken")) return { status: 502 };
      if (u.includes("nohead")) return { status: init.method === "HEAD" ? 405 : 200 };
      return { status: 200 };
    };
    const c = createLinkChecker({ fetch: fetcher, now: () => t, ttlMs: 1000 });
    const urls = ["http://worker.tail.example:8975/", "https://x.example.net/gone", "https://x.example.net/broken", "https://x.example.net/nohead", "https://epicspine.dev/", "https://team.example.com/book", "http://10.86.141.63:8975/"];
    expect(await c.run(urls)).toBe(5);
    expect(c.get("http://worker.tail.example:8975/")).toMatchObject({ state: "not running", detail: "ECONNREFUSED" });
    expect(c.get("http://10.86.141.63:8975")!.state).toBe("not running");
    expect(c.get("https://x.example.net/gone")!.state).toBe("gone");
    expect(c.get("https://x.example.net/broken")!.state).toBe("down");
    expect(c.get("https://x.example.net/nohead")!.state).toBe("ok");
    expect(c.get("https://team.example.com/book")).toBeUndefined();
    expect(calls.some((x) => x.includes("example.com"))).toBe(false);
    expect(await c.run(urls)).toBe(0);
    t += 1000;
    expect(await c.run(urls)).toBe(5);
  });
});

describe("E947-S4 GET /api/book/:key and /api/book", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s4-api-"));
    const repo = fixture();
    fs.renameSync(repo, path.join(root, "home_repo"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    resetRepoScans(0);
  });
  afterEach(() => {
    resetRepoScans();
    db?.close();
    db = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves each epic's list in the milestone's book and in the whole Epic Book", async () => {
    db = openDb(path.join(root, "c.db"));
    const spines: SpinesJson = {
      root: SPINE,
      orphans: [],
      mismatches: [],
      nodes: [{ id: SPINE, path: SPINE, title: "EPIC-909: Demo epic", parent: null, status: "active", rollup_status: "active", dod: [], children: [] }],
    };
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => spines };
    const a = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" }, book: { git: async () => "" } });
    const m = createStore(db).createMilestone({ title: "Demo", repo: "Acme/home_repo", path: SPINE, owner: "", paused: false });
    const { book } = (await (await a.request(`/api/book/${m.id}`)).json()) as { book: MilestoneBook };
    expect(book.made[0]).toMatchObject({ code: "EPIC-909", depth: 0 });
    expect(book.made[0].items.some((d) => d.url === "http://worker.tail.example:8990/")).toBe(true);
    const all = (await (await a.request("/api/book")).json()) as { book: Book };
    expect(all.book.repos[0].epics[0].made!.length).toBe(book.made[0].items.length);
  });
});
