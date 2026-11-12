import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createSteps, isSpine } from "../src/steps/steps.js";

// a steps page (a laptop ticket) can belong to a spine outside docs/spines/, as other worlds keep them
// (tax-assist-research: docs/EPIC_SPINE.md, docs/<epic>.md); still refused outside the repo or when the file is no spine.
const ROOT = "# Tax matter archive\n\nSpine Type: root\nRoot spine: self\n\n## Current State\nStatus: active\n";
const CHILD = "# PLAN-7: books\n\nRoot spine: [root](EPIC_SPINE.md)\n\n## Issue Ledger\n";

let db: DB;
let repo: string;
let outside: string;
beforeEach(() => {
  db = openDb(":memory:");
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "e96s6-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "e96s6-out-"));
  fs.mkdirSync(path.join(repo, "docs/epicbooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/EPIC_SPINE.md"), ROOT);
  fs.writeFileSync(path.join(repo, "docs/epicbooks/epic-7.md"), CHILD);
  fs.writeFileSync(path.join(repo, "docs/HOLDED_RETRIEVAL.md"), "# How we read Holded\n\nSome notes.\n");
  fs.writeFileSync(path.join(outside, "spine.md"), ROOT);
  fs.symlinkSync(path.join(outside, "spine.md"), path.join(repo, "docs/link.md"));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const steps = () =>
  createSteps({
    db,
    repoDir: (n: string) => (n === "tax-assist-research" ? repo : undefined),
    writer: {} as never,
    milestoneFor: async () => undefined,
    pump: false,
  });
const reg = (spine: string) => steps().register({ title: "Laptop ticket TAX-A11", url: "http://host3:9196/t/TAX-A11/", repo: "tax-assist-research", spine, by: "agent" });
const code = (f: () => unknown) => {
  try {
    f();
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

describe("T96-S6 steps pages for spines outside docs/spines", () => {
  it("knows a spine by its Current State or its spine header lines", () => {
    expect(isSpine(ROOT)).toBe(true);
    expect(isSpine(CHILD)).toBe(true);
    expect(isSpine("# Notes\n\nSome text.\n\n## Later\nRoot spine: x\n")).toBe(false);
  });

  it("registers the root spine and a child spine anywhere in the repo", () => {
    expect(reg("docs/EPIC_SPINE.md")).toMatchObject({ repo: "tax-assist-research", spine: "docs/EPIC_SPINE.md" });
    expect(reg("./docs/epicbooks/epic-7.md").spine).toBe("docs/epicbooks/epic-7.md");
  });

  it("still refuses a path outside the repo, a symlink out of it, a missing file and a file that is no spine", () => {
    expect(code(() => reg("../etc/passwd.md"))).toBe(400);
    expect(code(() => reg("/etc/x.md"))).toBe(400);
    expect(code(() => reg("docs/./EPIC_SPINE.md"))).toBe(400);
    expect(code(() => reg("docs/EPIC_SPINE.txt"))).toBe(400);
    expect(code(() => reg("docs/link.md"))).toBe(400);
    expect(code(() => reg("docs/none.md"))).toBe(404);
    expect(code(() => reg("docs/HOLDED_RETRIEVAL.md"))).toBe(400);
  });
});
