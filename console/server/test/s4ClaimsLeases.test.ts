import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { WORKER_FINISH_RULE } from "../src/cycle/prompts.js";
import { openDb, type DB } from "../src/db.js";
import { gitOut } from "../src/freshness.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { createLeases } from "../src/review/leases.js";
import { claimOf, computeReviewRows } from "../src/review/rows.js";
import { dispatchRule } from "../src/wakePrompt.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * a claim is written in the row by the EpicSpine `spines.py --claim`; the console shows the holder,
 * a lease the holder's commits keep renewing stays, and one that ran out gives the row back to ready through the spine
 * writer (one commit). Temp repos only.
 */
const EPIC = "docs/spines/epic-9.md";
let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;
const T0 = Date.parse("2026-11-02T22:00:00Z");
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e63s3-"));
  repo = makeRepo(tmp, "home_repo", {
    "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n",
    [EPIC]: spineText("PLAN-9", "Things", [
      { id: "T9-S1", status: "active" },
      { id: "T9-S2", status: "active" },
      { id: "T9-S3", status: "ready" },
      { id: "T9-S4", status: "review" },
    ]),
  });
  setOwner("T9-S1", "run_A — claimed 2026-11-02T20:00Z, lease until 2026-11-02T21:00Z");
  setOwner("T9-S2", "run_B — claimed 2026-11-02T20:00Z, lease until 2026-11-02T21:00Z");
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setOwner(id: string, owner: string) {
  const f = path.join(repo.dir, EPIC);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  const cells = lines[i].split(" | ");
  cells[2] = owner;
  lines[i] = cells.join(" | ");
  fs.writeFileSync(f, lines.join("\n"));
  git(repo.dir, "commit", "-q", "-am", `Claim ${id}: test`, "--date", "2026-11-02T20:00:00Z");
  git(repo.dir, "push", "-q", "origin", "main");
}

/** what `spines.py --claim` writes: Owner `<by> — claimed …`, Status `active`, subject `Claim <row>: <by> (lease until …)`. */
function claimRow(id: string, by: string, from?: string) {
  const f = path.join(repo.dir, EPIC);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  const cells = lines[i].split(" | ");
  if (from) {
    // the status it had before the claim, in a commit that does not name the row (a naming commit renews the lease)
    cells[4] = from;
    lines[i] = cells.join(" | ");
    fs.writeFileSync(f, lines.join("\n"));
    git(repo.dir, "commit", "-q", "-am", "set up a monitoring row", "--date", "2026-11-02T19:00:00Z");
  }
  cells[2] = `${by} — claimed 2026-11-02T20:00Z, lease until 2026-11-02T21:00Z`;
  cells[4] = "active";
  lines[i] = cells.join(" | ");
  fs.writeFileSync(f, lines.join("\n"));
  git(repo.dir, "commit", "-q", "-am", `Claim ${id}: ${by} (lease until 2026-11-02T21:00Z)`, "--date", "2026-11-02T20:00:00Z");
  git(repo.dir, "push", "-q", "origin", "main");
}

describe("T63-S3/S4 claims and leases", () => {
  it("reads the claim from the Owner cell", () => {
    expect(claimOf("run_A — claimed 2026-11-02T20:00Z, lease until 2026-11-02T21:00Z")).toEqual({ by: "run_A", at: "2026-11-02T20:00Z", until: "2026-11-02T21:00Z" });
    expect(claimOf("seat2")).toBeUndefined();
  });

  it("an expired lease with no commit naming the row goes back to ready; one the holder's commits renewed stays", async () => {
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    // run_B keeps working: a commit naming at 21:50Z renews its 1 h lease to 22:50Z
    fs.writeFileSync(path.join(repo.dir, "x.txt"), "work");
    git(repo.dir, "add", "x.txt");
    const env = { ...process.env, GIT_COMMITTER_DATE: "2026-11-02T21:50:00Z", GIT_AUTHOR_DATE: "2026-11-02T21:50:00Z" };
    require("node:child_process").execFileSync("git", ["commit", "-q", "-m", "T9-S2: step two"], { cwd: repo.dir, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git(repo.dir, "push", "-q", "origin", "main");
    const leases = createLeases({ store: () => store, reposRoot: tmp, writer: createSpineWriter(), git: gitOut(), now: () => T0 });
    const v = await leases.view();
    expect(v.map((c) => [c.ref, c.by, c.expired, c.liveUntil])).toEqual([
      ["T9-S1", "run_A", true, "2026-11-02T21:00Z"],
      ["T9-S2", "run_B", false, "2026-11-02T22:50Z"],
    ]);
    const done = await leases.sweep();
    expect(done.map((d) => [d.ref, d.status])).toEqual([["T9-S1", "written"]]);
    expect(repo.rowLine(EPIC, "T9-S1")).toContain("| unassigned (lease of run_A expired 2026-11-02T22:00Z: re-dispatch) | T9-S1 work | ready |");
    expect(repo.rowLine(EPIC, "T9-S2")).toContain("run_B — claimed");
    expect(repo.originLog()[0]).toBe("Lease expired T9-S1: run_A (back to ready, re-dispatch)");
    expect(await leases.sweep()).toEqual([]); // once
  });

  it("an expired lease gives the row back the status it had when claimed: review stays review, monitoring stays monitoring", async () => {
    claimRow("T9-S4", "run_C");
    claimRow("T9-S3", "run_D", "monitoring (check 2026-11-20)");
    expect(repo.rowLine(EPIC, "T9-S4")).toContain("| active |");
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const leases = createLeases({ store: () => store, reposRoot: tmp, writer: createSpineWriter(), git: gitOut(), now: () => T0 });
    const done = await leases.sweep();
    expect(done.map((d) => [d.ref, d.status])).toEqual([
      ["T9-S1", "written"],
      ["T9-S2", "written"],
      ["T9-S3", "written"],
      ["T9-S4", "written"],
    ]);
    expect(repo.rowLine(EPIC, "T9-S4")).toContain("| unassigned (lease of run_C expired 2026-11-02T22:00Z: back to review) | T9-S4 work | review |");
    expect(repo.rowLine(EPIC, "T9-S3")).toContain("| unassigned (lease of run_D expired 2026-11-02T22:00Z: back to monitoring) | T9-S3 work | monitoring (check 2026-11-20) |");
    // a claim made with no status before it (the fixture's own claim commits) still goes back to ready
    expect(repo.rowLine(EPIC, "T9-S1")).toContain("| T9-S1 work | ready |");
    expect(repo.originLog()).toContain("Lease expired T9-S4: run_C (back to review, as claimed)");
  });

  it("the console shows the holder: GET /api/claims and the goal header's running rows", async () => {
    const app = createApp(db, { read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] } });
    await app.request("/api/milestones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md" }) });
    const claims = (await (await app.request("/api/claims")).json()) as { ref: string; by: string }[];
    expect(claims.map((c) => [c.ref, c.by])).toEqual([
      ["T9-S1", "run_A"],
      ["T9-S2", "run_B"],
    ]);
    repo.setRow(EPIC, "T9-S3", "review", "[x](https://team.example/x)");
    const p = computeReviewRows(createStore(db), tmp);
    expect(p.goals?.[0].running.map((r) => [r.ref, r.holder])).toEqual([
      ["T9-S1", "run_A"],
      ["T9-S2", "run_B"],
    ]);
  });

  it("workers claim before work; the dispatcher never starts a second worker on a held row", () => {
    expect(WORKER_FINISH_RULE).toContain("spines.py --claim <row> --by <your run id>");
    expect(WORKER_FINISH_RULE).toContain("exit 3 = someone else holds it");
    expect(dispatchRule(4)).toContain("claimed …, lease until");
    expect(dispatchRule(4)).toContain("Role is `Mac agent`");
  });
});
