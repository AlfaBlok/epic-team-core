import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRepos, resolveRepo, setRepoAllowlist } from "../src/adapters/repos.js";
import { indexerEnv } from "../src/indexer/launch.js";

// staging's indexer reads the code repo only (CONSOLE_INDEX_REPOS), production's every checkout.
const root = fs.mkdtempSync(path.join(os.homedir(), ".e6s86-repos-"));
for (const n of ["home_repo", "social", "deal-funnels"]) fs.mkdirSync(path.join(root, n, ".git"), { recursive: true });

afterEach(() => setRepoAllowlist(undefined));

describe("CONSOLE_INDEX_REPOS", () => {
  it("unset: every checkout", () => {
    setRepoAllowlist(undefined);
    expect(listRepos(root).map((r) => r.name)).toEqual(["deal-funnels", "home_repo", "social"]);
  });
  it("set: only the named repos are listed or resolved, by name, slug or absolute path", () => {
    expect(setRepoAllowlist(" home_repo , ")).toEqual(["home_repo"]);
    expect(listRepos(root).map((r) => r.name)).toEqual(["home_repo"]);
    expect(resolveRepo(root, "home_repo")?.name).toBe("home_repo");
    expect(resolveRepo(root, "social")).toBeUndefined();
    expect(resolveRepo(root, "Acme/social")).toBeUndefined();
    expect(resolveRepo(root, path.join(root, "deal-funnels"))).toBeUndefined();
  });
  it("the indexer unit gets the setting from the console's env", () => {
    expect(indexerEnv({ dbPath: "/d", reposRoot: "/r" }, 1, { PATH: "/bin", CONSOLE_INDEX_REPOS: "home_repo" }).CONSOLE_INDEX_REPOS).toBe("home_repo");
  });
});

process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
