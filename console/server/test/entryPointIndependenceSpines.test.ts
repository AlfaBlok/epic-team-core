import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReviewItem } from "../src/review/review.js";
import { addCard, git, makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * the Team home is built from the spines alone. Another clone (another host, a T3
 * thread, a subagent) only edits spines and pushes; the console's ls-remote poll pulls it and the three feeds the owner sees
 * agree with each other and with the spine: `/api/review-items` (Done, waiting for your review), `/api/waiting-on-owner`
 * (Blocked, waiting on you) and `/api/counts` (badge, sidebar). After the milestone is registered nobody writes to the
 * console API: every call the test makes is a GET. Temp repos only.
 *
 * Cases: a row moved to `review` with a relative evidence link, a new coded ask, the ask answered, the row reopened.
 * A relative `docs/...` link resolves to its GitHub page; since L-47 a GitHub page alone is not a card (the row goes back
 * to the agents), so the row's card file carries the live evidence page and the relative link stays the row's write-up.
 */
const EPIC = "docs/spines/epic-9.md";
const LIVE = "https://team.example/e9-s2-proof";
const GH = "https://github.com/Acme/home_repo/blob/main/docs/status/e9-s2.md";
const ASK = "- [ask T9-A1: decide @Sam since 2026-11-03 row T9-S3] Ship the page with one logger or two? — options: one | two — recommend: one";

let tmp: string;
let db: DB;
const hosts: { close(): void }[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s10-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function boot() {
  const w = web({ [LIVE]: 200, [GH]: 200 });
  const app = createApp(db, {
    read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: w.f, consoleHosts: [] } },
    freshness: { enabled: true, pollMs: 100 },
    readModel: { mode: "in-process" as const, tickMs: 50, patchTtlMs: 60_000, onHost: (h: { close(): void }) => void hosts.push(h) },
  });
  const writes: string[] = [];
  const call = async (method: string, url: string, body?: unknown) => {
    if (method !== "GET") writes.push(`${method} ${url}`);
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call, writes };
}
type Call = ReturnType<typeof boot>["call"];

/** What the owner's Team home shows, read from the three feeds only. */
async function home(call: Call, mid: string) {
  // the first read checks the evidence links in the background; the second has them
  await call("GET", "/api/review-items");
  await new Promise((r) => setTimeout(r, 20));
  const cards = ((await call("GET", "/api/review-items")).json as ReviewItem[]).map((i) => i.ref);
  const agents = ((await call("GET", "/api/review-items?state=agents")).json as ReviewItem[]).map((i) => ({ ref: i.ref, kind: i.verdict.kind, links: i.links.map((l) => l.url) }));
  const waiting = (await call("GET", `/api/waiting-on-owner?milestoneId=${mid}`)).json as { code?: string; state: string; answer?: string }[];
  const asks = waiting.filter((i) => i.state === "open").map((i) => i.code);
  const answered = waiting.filter((i) => i.state === "answered").map((i) => i.code);
  const counts = (await call("GET", "/api/counts")).json as { needsYou: number | null; review: number; milestones: Record<string, { review?: number; needsYou?: number | null }> };
  return { cards, agents, asks, answered, counts };
}

/** Poll the feeds until `ok` holds (the console pulls on its own), for at most `ms`; returns the last view and how long. */
async function until(call: Call, mid: string, ok: (h: Awaited<ReturnType<typeof home>>) => boolean, ms = 20_000) {
  const t0 = Date.now();
  let h = await home(call, mid);
  while (!(ok(h) && agrees(h, mid)) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 100));
    h = await home(call, mid);
  }
  return { h, tookMs: Date.now() - t0 };
}

const agrees = (h: Awaited<ReturnType<typeof home>>, mid: string) =>
  h.counts.review === h.cards.length &&
  (h.counts.milestones[mid]?.review ?? 0) === h.cards.length &&
  h.counts.needsYou === h.asks.length &&
  (h.counts.milestones[mid]?.needsYou ?? 0) === h.asks.length;

/** The feeds agree with each other: the badge is the card list, the red count is the open asks. */
function agree(h: Awaited<ReturnType<typeof home>>, mid: string) {
  expect(h.counts.review).toBe(h.cards.length);
  expect(h.counts.milestones[mid]?.review ?? 0).toBe(h.cards.length);
  expect(h.counts.needsYou).toBe(h.asks.length);
  expect(h.counts.milestones[mid]?.needsYou ?? 0).toBe(h.asks.length);
}

describe("T62-S10 entry-point independence: spines and a push are the whole contract", () => {
  it("review row, new ask, answered ask, reopened row: the three feeds follow the spine and agree, with no API write", async () => {
    const repo = makeRepo(tmp, "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| PLAN-9 | Things; [epic](epic-9.md) | active |\n",
      [EPIC]: spineText(
        "PLAN-9",
        "Things",
        [
          { id: "T9-S1", status: "done", evidence: "old" },
          { id: "T9-S2", title: "Build the proof page", status: "active" },
          { id: "T9-S3", title: "Pick the logger", status: "active" },
        ],
        ["Waiting on: nobody", ""],
      ),
      "docs/status/e9-s2.md": "write-up\n",
    });
    git(repo.dir, "fetch", "-q", "origin");
    git(repo.dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
    const { call, writes } = boot();
    const m = (await call("POST", "/api/milestones", { title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md" })).json;
    writes.length = 0; // registering the milestone is setup; from here on the console is only read

    // "the worker server": its own clone of origin; every step below is a spine edit and a push, nothing else
    const other = path.join(tmp, "_vps3");
    git(tmp, "clone", "-q", repo.bare, other);
    git(other, "config", "user.email", "t@t");
    git(other, "config", "user.name", "t");
    const f = path.join(other, EPIC);
    const edit = (from: string | RegExp, to: string) => {
      const before = fs.readFileSync(f, "utf8");
      const after = before.replace(from, to);
      expect(after).not.toBe(before);
      fs.writeFileSync(f, after);
    };
    const push = (msg: string) => {
      git(other, "add", "-A");
      git(other, "commit", "-q", "-m", msg);
      git(other, "push", "-q", "origin", "main");
    };

    const start = await home(call, m.id);
    expect(start).toMatchObject({ cards: [], asks: [], answered: [] });
    agree(start, m.id);

    // 1. a row moved to review with a relative evidence link (and its card file with the live proof page)
    edit("| T9-S2 | Ticket worker | seat2 | Build the proof page | active | none | none | main | none |", "| T9-S2 | Ticket worker | seat2 | Build the proof page | review | none | none | main | [write-up](../status/e9-s2.md) |");
    addCard(other, "T9-S2", LIVE);
    push("T9-S2 to review (from host3)");
    const s1 = await until(call, m.id, (h) => h.cards.includes("T9-S2"));
    expect(s1.h.cards).toEqual(["T9-S2"]);
    const card = ((await call("GET", "/api/review-items")).json as ReviewItem[])[0];
    expect(card.links.map((l) => l.url)).toEqual([LIVE]);
    agree(s1.h, m.id);

    // 1b. the same relative link with no card file: resolved to its GitHub page, and (L-47) sent back to the agents
    edit("| T9-S3 | Ticket worker | seat2 | Pick the logger | active | none | none | main | none |", "| T9-S3 | Ticket worker | seat2 | Pick the logger | review | none | none | main | [write-up](../status/e9-s2.md) |");
    push("T9-S3 to review with only a write-up (from host3)");
    const s1b = await until(call, m.id, (h) => h.agents.some((a) => a.ref === "T9-S3"));
    expect(s1b.h.cards).toEqual(["T9-S2"]);
    expect(s1b.h.agents.find((a) => a.ref === "T9-S3")).toMatchObject({ links: [GH] });
    expect(s1b.h.agents.find((a) => a.ref === "T9-S3")?.kind).not.toBe("card");
    agree(s1b.h, m.id);
    edit("| T9-S3 | Ticket worker | seat2 | Pick the logger | review |", "| T9-S3 | Ticket worker | seat2 | Pick the logger | blocked |");
    push("T9-S3 blocked on its ask");

    // 2. a new coded ask in `## Waiting on` (and Current State names it)
    edit("Waiting on: nobody\n", `Waiting on: Sam: T9-A1\n\n## Waiting on\n\n${ASK}\n`);
    push("T9-A1 raised (from host3)");
    const s2 = await until(call, m.id, (h) => h.asks.includes("T9-A1") && !h.agents.some((a) => a.ref === "T9-S3"));
    expect(s2.h.asks).toEqual(["T9-A1"]);
    expect(s2.h.cards).toEqual(["T9-S2"]);
    agree(s2.h, m.id);

    // 3. the ask answered in the spine: it leaves Blocked and the red count
    edit(/^- \[ask T9-A1: decide @Sam since 2026-11-03 row T9-S3\] (.*)$/m, "- [answered T9-A1 2026-11-03 @Sam] Ship the page with one logger or two? — answer: one");
    edit("Waiting on: Sam: T9-A1\n", "Waiting on: nobody\n");
    push("T9-A1 answered (from host3)");
    const s3 = await until(call, m.id, (h) => !h.asks.includes("T9-A1"));
    expect(s3.h.asks).toEqual([]);
    expect(s3.h.answered).toEqual(["T9-A1"]);
    expect(s3.h.cards).toEqual(["T9-S2"]);
    agree(s3.h, m.id);

    // 4. the review row reopened: the card leaves, badge and sidebar with it
    edit("| T9-S2 | Ticket worker | seat2 | Build the proof page | review |", "| T9-S2 | Ticket worker | seat2 | Build the proof page | active (reopened 2026-11-03: one more page) |");
    push("T9-S2 reopened (from host3)");
    const s4 = await until(call, m.id, (h) => !h.cards.includes("T9-S2"));
    expect(s4.h).toMatchObject({ cards: [], asks: [], answered: ["T9-A1"] });
    agree(s4.h, m.id);

    // the whole contract was the spine and the push: the console was only read
    expect(writes).toEqual([]);
    // each push was seen well inside's 2 minutes (here the poll is 100 ms; production polls every 20 s)
    for (const s of [s1, s1b, s2, s3, s4]) expect(s.tookMs).toBeLessThan(20_000);
  }, 120_000);

  it("a row Sam acted on that comes back to review (a new iteration done, pushed from anywhere) shows again at once, not after the patch TTL", async () => {
    const repo = makeRepo(tmp, "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| PLAN-9 | Things; [epic](epic-9.md) | active |\n",
      [EPIC]: spineText("PLAN-9", "Things", [
        { id: "T9-S2", title: "Build the proof page", status: "review", evidence: `[proof](${LIVE})` },
        { id: "T9-S3", title: "Other open step", status: "active" },
      ]),
    });
    git(repo.dir, "fetch", "-q", "origin");
    git(repo.dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
    const { call } = boot();
    const m = (await call("POST", "/api/milestones", { title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md" })).json;
    const first = await until(call, m.id, (h) => h.cards.includes("T9-S2"));
    expect(first.h.cards).toEqual(["T9-S2"]);
    const [card] = (await call("GET", "/api/review-items")).json as ReviewItem[];
    // the owner's press: the row is written done and the card leaves at once (the read model's patch)
    expect((await call("POST", `/api/review-items/${card.id}/approve`)).status).toBe(200);
    expect((await home(call, m.id)).cards).toEqual([]);

    // another clone puts the row back in review (the next iteration is live) inside the patch's 60 s TTL
    const other = path.join(tmp, "_vps3");
    git(tmp, "clone", "-q", repo.bare, other);
    const f = path.join(other, EPIC);
    const text = fs.readFileSync(f, "utf8");
    const back = text.replace(/\| T9-S2 \| Ticket worker \| seat2 \| Build the proof page \| done \(approved by Sam [^|]*\) \|/, "| T9-S2 | Ticket worker | seat2 | Build the proof page | review |");
    expect(back).not.toBe(text);
    fs.writeFileSync(f, back);
    git(other, "commit", "-q", "-am", "T9-S2 back to review (from host3)");
    git(other, "push", "-q", "origin", "main");
    const again = await until(call, m.id, (h) => h.cards.includes("T9-S2"), 10_000);
    expect(again.h.cards).toEqual(["T9-S2"]);
    agree(again.h, m.id);
  }, 60_000);
});
