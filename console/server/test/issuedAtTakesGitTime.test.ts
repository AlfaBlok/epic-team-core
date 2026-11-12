import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitFirstAdded, issuedAt } from "../src/inbox/waiting.js";

// a card shows how long ago it was issued, to the minute where git knows it.
describe("issuedAt", () => {
  it("takes a git time on the since day (±14 h), else keeps the day", () => {
    expect(issuedAt("2026-10-21", "2026-10-21T14:05:00Z")).toBe("2026-10-21T14:05:00Z");
    expect(issuedAt("2026-10-21", "2026-10-20T22:00:00Z")).toBe("2026-10-20T22:00:00Z"); // written in CET late evening
    expect(issuedAt("2026-10-21", "2026-10-25T09:00:00Z")).toBe("2026-10-21");
    expect(issuedAt("2026-10-21", undefined, "2026-10-21T16:30:00Z")).toBe("2026-10-21T16:30:00Z");
    expect(issuedAt("2026-10-21")).toBe("2026-10-21");
    expect(issuedAt(null, "2026-10-21T16:30:00Z")).toBe("2026-10-21T16:30:00Z");
    expect(issuedAt(undefined)).toBeUndefined();
  });
});

describe("gitFirstAdded", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const commit = (text: string, at: string) => {
    fs.writeFileSync(path.join(dir, "docs/e.md"), text);
    const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["-C", dir, "add", "-A"], { env });
    execFileSync("git", ["-C", dir, "commit", "-qm", "x"], { env });
  };

  it("is the commit that added the coded line, not a later edit of it (snooze)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "e48s11-"));
    fs.mkdirSync(path.join(dir, "docs"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    commit("# E\n", "2026-10-20T08:00:00Z");
    commit("# E\n- [ask T1-A1: decide @Sam since 2026-10-21] Which?\n", "2026-10-21T14:05:00Z");
    commit("# E\n- [ask T1-A1: decide @Sam since 2026-10-21 snooze 2026-10-30] Which?\n", "2026-10-23T09:00:00Z");
    expect(await gitFirstAdded(dir, "docs/e.md", "[ask T1-A1:")).toBe("2026-10-21T14:05:00.000Z");
    expect(await gitFirstAdded(dir, "docs/e.md", "[ask T1-A2:")).toBeUndefined();
    expect(await gitFirstAdded(dir, "../outside.md", "[ask T1-A1:")).toBeUndefined();
  });
});
