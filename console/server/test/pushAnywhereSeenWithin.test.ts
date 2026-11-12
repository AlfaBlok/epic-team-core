import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { FRESHNESS_POLL_MS } from "../src/routes/freshness.js";
import type { ReviewItem } from "../src/review/review.js";
import { git, GIT_ENV, makeRepo, spineText, web, addCard } from "./reviewFixture.js";

/**
 * a push from anywhere shows in the console with no agent API call. Another clone (another
 * host, a T3 thread) pushes a row into review; the console's ls-remote poll sees main move, pulls its checkout and the
 * read model re-reads it: the card is listed. Temp repos only.
 */
const EPIC = "docs/spines/epic-9.md";
const LIVE = "https://team.example/x";
let tmp: string;
let db: DB;
const hosts: { close(): void }[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e63s1-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("T63-S1 a push from anywhere is seen within 60 s", () => {
  it("polls every 5 min by default (T6-S58; was 20 s)", () => {
    expect(FRESHNESS_POLL_MS).toBe(5 * 60_000);
  });

  it("another clone pushes a row to review: the console pulls and lists the card, nobody calls its API", async () => {
    const repo = makeRepo(tmp, "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n",
      [EPIC]: spineText("PLAN-9", "Things", [{ id: "T9-S1", status: "active", evidence: `[x](${LIVE})` }]),
    });
    git(repo.dir, "fetch", "-q", "origin");
    git(repo.dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
    const w = web({ [LIVE]: 200 });
    const app = createApp(db, {
      read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
      review: { live: { fetch: w.f, consoleHosts: [] } },
      freshness: { enabled: true, pollMs: 100 },
      readModel: { mode: "in-process" as const, tickMs: 50, patchTtlMs: 60_000, onHost: (h: { close(): void }) => void hosts.push(h) },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    await call("POST", "/api/milestones", { title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md" });
    expect((await call("GET", "/api/review-items?state=feed")).json).toEqual([]);

    // "the worker server": its own clone of origin, a worker sets the row to review and pushes
    const other = path.join(tmp, "_vps3");
    git(tmp, "clone", "-q", repo.bare, other);
    const f = path.join(other, EPIC);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("| T9-S1 | Ticket worker | seat2 | T9-S1 work | active |", "| T9-S1 | Ticket worker | seat2 | T9-S1 work | review |"));
    addCard(other, "T9-S1", LIVE); // the worker writes the row's card file with it
    git(other, "add", "docs/cards");
    git(other, "commit", "-q", "-am", "T9-S1 to review (from host3)");
    git(other, "push", "-q", "origin", "main");
    void GIT_ENV;

    const t0 = Date.now();
    let refs: string[] = [];
    while (Date.now() - t0 < 20_000) {
      refs = ((await call("GET", "/api/review-items?state=feed")).json as ReviewItem[]).map((i) => i.ref ?? "");
      if (refs.includes("T9-S1")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(refs).toEqual(["T9-S1"]);
    expect(repo.rowLine(EPIC, "T9-S1")).toContain("| review |"); // the console's checkout was pulled
  }, 30_000);
});
