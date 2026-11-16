import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryFromLog, inboxSince, inboxSinceOf, resetInboxSince } from "../src/review/inboxSince.js";

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
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
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
});
