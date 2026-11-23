import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceDataDir } from "../src/workspaceData.js";

describe("workspaceDataDir", () => {
  it("a checkout with no pointer is its own data folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-"));
    expect(workspaceDataDir(root)).toBe(root);
    expect(workspaceDataDir(undefined)).toBeUndefined();
  });
  it("a pointer sends writes to the data checkout next to it", () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-"));
    const home = path.join(top, "home");
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.mkdirSync(path.join(top, "team-data", "docs"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "workspace-data.json"), JSON.stringify({ repo: "sam/team-data", checkout: "team-data" }));
    expect(workspaceDataDir(home)).toBe(path.join(top, "team-data"));
  });
  it("a pointer whose checkout is missing, or a bad name, keeps the checkout itself", () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-"));
    const home = path.join(top, "home");
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "workspace-data.json"), JSON.stringify({ repo: "x/y", checkout: "../escape" }));
    expect(workspaceDataDir(home)).toBe(home);
    fs.writeFileSync(path.join(home, "docs", "workspace-data.json"), JSON.stringify({ repo: "x/y", checkout: "missing" }));
    expect(workspaceDataDir(home)).toBe(home);
  });
});
