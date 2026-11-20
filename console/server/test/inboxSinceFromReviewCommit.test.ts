import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { entryFromLog, inboxSince, inboxSinceOf, keepInboxSinceIn, resetInboxSince } from "../src/review/inboxSince.js";
import { ensureReviewInboxSince } from "../src/review/review.js";

// (vn_7c5aa36e, "how old is the card in minutes, hours, days, weeks"): a review card's age counts from when the
// row went to review, never from a later restamp of the row.
const HEAD = "| ID | Owner | Lease | Title | Status | Evidence | Last verified |\n|---|---|---|---|---|---|---|\n";
const row = (status: string, verified: string, evidence = "none") => `| T1-S1 | Ticket worker | unassigned | A thing | ${status} | ${evidence} | ${verified} |\n`;

describe("inboxSince", () => {
  let dir: string;
  beforeEach(() => {
    resetInboxSince();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-since-"));
    fs.mkdirSync(path.join(dir, "docs"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
  });
  afterEach(() => {
    keepInboxSinceIn(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const commit = (text: string, at: string) => {
    fs.writeFileSync(path.join(dir, "docs/e.md"), `# E\n${HEAD}${text}| T1-S2 | x | y | other | active | none | 2026-10-01 |\n`);
    const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["-C", dir, "add", "-A"], { env });
    execFileSync("git", ["-C", dir, "commit", "-qm", "x"], { env });
  };

  it("is the commit that turned the row to review; a restamp keeps it", async () => {
    commit(row("ready", "2026-10-20"), "2026-10-20T08:00:00Z");
    commit(row("active", "2026-10-20"), "2026-10-20T09:00:00Z");
    commit(row("review", "2026-10-21", "https://a.example"), "2026-10-21T14:05:00Z");
    commit(row("review", "2026-10-25", "https://b.example"), "2026-10-25T09:00:00Z"); // restamp
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
  });

  it("a row that left review and came back counts from its return", async () => {
    commit(row("review", "2026-10-21"), "2026-10-21T14:05:00Z");
    commit(row("active (iteration 2)", "2026-10-22"), "2026-10-22T10:00:00Z");
    commit(row("review (iteration 2)", "2026-10-23"), "2026-10-23T11:30:00Z");
    commit(row("review — snoozed until: 2026-10-30", "2026-10-24"), "2026-10-24T08:00:00Z");
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review — snoozed until: 2026-10-30")).toBe("2026-10-23T11:30:00.000Z");
  });

  it("a row added straight in review counts from that commit; another row or path answers nothing", async () => {
    commit(row("review", "2026-10-21"), "2026-10-21T14:05:00Z");
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
    expect(await inboxSince(dir, "docs/e.md", "T1-S9", "review")).toBeUndefined();
    expect(await inboxSince(dir, "../x.md", "T1-S1", "review")).toBeUndefined();
  });

  it("reads each spine once per change, not once per card (a list read ~13 MB of spines per call)", async () => {
    commit(row("review", "2026-10-21"), "2026-10-21T14:05:00Z");
    const abs = path.join(dir, "docs/e.md");
    const reads = vi.spyOn(fs, "readFileSync");
    try {
      const of = () => reads.mock.calls.filter((c) => c[0] === abs).length;
      expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
      await inboxSince(dir, "docs/e.md", "T1-S1", "review");
      await inboxSince(dir, "docs/e.md", "T1-S2", "active");
      expect(of()).toBe(1);
      // the row moves on: the changed file is read again and the new line is looked up
      commit(row("active (iteration 2)", "2026-10-22"), "2026-10-22T10:00:00Z");
      commit(row("review (iteration 2)", "2026-10-23"), "2026-10-23T11:30:00Z");
      expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review (iteration 2)")).toBe("2026-10-23T11:30:00.000Z");
      expect(of()).toBe(2);
    } finally {
      reads.mockRestore();
    }
  });

  // After a release the memory is empty, and each inbox list waited its whole 1.5 s budget while git found
  // every card's time again (the phone's first sections at 2.4 to 4.6 s). The times are kept in the console's database.
  it("a time found once outlives a restart: the stored one is used while the row's line is the same, without git", async () => {
    const db = openDb(":memory:");
    ensureReviewInboxSince(db);
    commit(row("review", "2026-10-21"), "2026-10-21T14:05:00Z");
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
    expect(db.prepare("SELECT at FROM review_inbox_since").all()).toEqual([{ at: "2026-10-21T14:05:00.000Z" }]);
    resetInboxSince(); // a restart: the memory is empty
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true }); // git can no longer answer
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
  });

  it("a changed row line looks again; a git failure is not stored and is asked again after a restart", async () => {
    const kept = new Map<string, { line: string; at: string | null }>();
    keepInboxSinceIn({ get: (k) => kept.get(k), put: (k, line, at) => void kept.set(k, { line, at }) });
    commit(row("review", "2026-10-21"), "2026-10-21T14:05:00Z");
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
    commit(row("active (iteration 2)", "2026-10-22"), "2026-10-22T10:00:00Z");
    commit(row("review (iteration 2)", "2026-10-23"), "2026-10-23T11:30:00Z");
    resetInboxSince();
    expect(await inboxSince(dir, "docs/e.md", "T1-S1", "review (iteration 2)")).toBe("2026-10-23T11:30:00.000Z");
    expect([...kept.values()].map((v) => v.at)).toEqual(["2026-10-23T11:30:00.000Z"]);
    // no git at all: nothing answers, nothing is stored, the next list asks git again
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-since-bare-"));
    try {
      fs.mkdirSync(path.join(bare, "docs"));
      fs.writeFileSync(path.join(bare, "docs/e.md"), `# E\n${HEAD}${row("review", "2026-10-21")}`);
      kept.clear();
      expect(await inboxSince(bare, "docs/e.md", "T1-S1", "review")).toBeUndefined();
      expect(kept.size).toBe(0);
      execFileSync("git", ["-C", bare, "init", "-q"]);
      const env = { ...process.env, GIT_COMMITTER_DATE: "2026-10-21T14:05:00Z", GIT_AUTHOR_DATE: "2026-10-21T14:05:00Z", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      execFileSync("git", ["-C", bare, "add", "-A"], { env });
      execFileSync("git", ["-C", bare, "commit", "-qm", "x"], { env });
      expect(await inboxSince(bare, "docs/e.md", "T1-S1", "review")).toBeUndefined(); // until the next start, no git again
      resetInboxSince();
      expect(await inboxSince(bare, "docs/e.md", "T1-S1", "review")).toBe("2026-10-21T14:05:00.000Z");
      expect(kept.size).toBe(1);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("inboxSinceOf waits at most its budget and answers what it has", async () => {
    const slow = () => new Promise<string | undefined>((r) => setTimeout(() => r("2026-10-21T00:00:00Z"), 500));
    const fast = async () => "2026-10-22T00:00:00Z";
    const rows = [{ id: "a", repoDir: dir, path: "docs/e.md", ref: "T1-S1", status: "review" }];
    expect((await inboxSinceOf(rows, 50, slow)).size).toBe(0);
    expect((await inboxSinceOf(rows, 50, fast)).get("a")).toBe("2026-10-22T00:00:00Z");
  });
});

describe("entryFromLog", () => {
  it("skips commits that keep the status word", () => {
    const log = [
      "C 1761000000",
      "-| A-1 | o | l | t | review | e | 2026-10-25 |",
      "+| A-1 | o | l | t | review | e2 | 2026-10-26 |",
      "C 1760000000",
      "-| A-1 | o | l | t | active | e | 2026-10-20 |",
      "+| A-1 | o | l | t | review | e | 2026-10-21 |",
    ].join("\n");
    expect(entryFromLog(log, "A-1", 4, "review")).toBe(new Date(1760000000 * 1000).toISOString());
    expect(entryFromLog(log, "A-2", 4, "review")).toBeUndefined();
  });
  it("an older line from before the table gained a column still reads its status; an adjacent title never does", () => {
    const grown = ["C 1760000000", "-| A-1 | o | t | active | e |", "+| A-1 | o | t | held | e |"].join("\n");
    expect(entryFromLog(grown, "A-1", 5, "held", 7)).toBe(new Date(1760000000 * 1000).toISOString());
    const title = ["C 1761000000", "+| A-1 | o | l | Review inbox cards | active | e | d |"].join("\n");
    expect(entryFromLog(title, "A-1", 4, "review", 7)).toBeUndefined();
  });
});
