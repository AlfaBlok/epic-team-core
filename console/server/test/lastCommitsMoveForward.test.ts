import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLastCommits } from "../src/cycle/lastCommits.js";
import { headSha } from "../src/gitRefs.js";

// the roll-up check asks when any child of a spine last moved; a HEAD move answers every kept question with one git log
const sh = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "sam@example.com", GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "sam@example.com" } });
const commit = (dir: string, file: string, when: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${file} ${when}\n`);
  sh(dir, "add", file);
  execFileSync("git", ["-C", dir, "commit", "-qm", `touch ${file}`], { env: { ...process.env, GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "sam@example.com", GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "sam@example.com", GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
};

describe("last commit of a spine's children, kept across HEAD moves", () => {
  it("answers like git log -1, with one spawn per HEAD move instead of one per question", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lastcommits-"));
    sh(dir, "init", "-q", "-b", "main");
    commit(dir, "docs/spines/a.md", "2026-01-01T10:00:00Z");
    commit(dir, "docs/spines/b.md", "2026-01-02T10:00:00Z");
    commit(dir, "tickets/t1.md", "2026-01-03T10:00:00Z");
    const calls: string[][] = [];
    const git = (d: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve(execFileSync("git", ["-C", d, ...args], { encoding: "utf8" }));
    };
    const last = createLastCommits(git, headSha);
    const plain = (paths: string[]) => execFileSync("git", ["-C", dir, "log", "-1", "--format=%cI", "--", ...paths], { encoding: "utf8" }).trim() || undefined;
    const qs = [["docs/spines/a.md"], ["docs/spines/b.md", "tickets"], ["docs/spines/c.md"]];
    for (const q of qs) expect(await last(dir, q)).toBe(plain(q));
    expect(calls).toHaveLength(3);
    for (const q of qs) await last(dir, q);
    expect(calls).toHaveLength(3); // same HEAD: kept

    commit(dir, "tickets/t2.md", "2026-01-05T10:00:00Z");
    commit(dir, "docs/spines/c.md", "2026-01-06T10:00:00Z");
    calls.length = 0;
    for (const q of qs) expect(await last(dir, q)).toBe(plain(q));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--name-only");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
