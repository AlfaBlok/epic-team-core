import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createTeamState, READ_ONLY_BOOT, teamRepoWrites } from "../src/team/teamState.js";

// A local source boot (no NODE_ENV) on a server whose repos root holds the real team checkout must never commit or push
// to it; only the production unit (NODE_ENV=production) or an explicit CONSOLE_TEAM_WRITE=1 writes.
describe("team repo writes only from the production boot", () => {
  it("decides from the environment", () => {
    expect(teamRepoWrites({ NODE_ENV: "production" })).toBe(true);
    expect(teamRepoWrites({})).toBe(false);
    expect(teamRepoWrites({ NODE_ENV: "development" })).toBe(false);
    expect(teamRepoWrites({ NODE_ENV: "production", CONSOLE_STAGING: "1" })).toBe(false);
    expect(teamRepoWrites({ NODE_ENV: "production", CONSOLE_TEAM_WRITE: "0" })).toBe(false);
    expect(teamRepoWrites({ CONSOLE_TEAM_WRITE: "1" })).toBe(true);
    expect(teamRepoWrites({ VITEST: "true" })).toBe(true);
  });

  it("a read-only team state never calls the writer and leaves the checkout untouched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-ro-"));
    const repo = path.join(root, "team");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const calls: string[] = [];
    const writer = {
      edit: async () => (calls.push("edit"), { status: "written" as const }),
      scaffold: async () => (calls.push("scaffold"), { status: "written" as const }),
    };
    const db = openDb(":memory:");
    const team = createTeamState({ db, reposRoot: root, writer, readOnly: true, placements: { list: () => [], restore: () => 0 } as never });
    const r = await team.sync();
    expect(calls).toEqual([]);
    for (const v of Object.values(r)) expect(String(v)).toContain(READ_ONLY_BOOT.split(" (")[0]);
    expect(fs.readdirSync(repo)).toEqual([".git"]);
  });
});
