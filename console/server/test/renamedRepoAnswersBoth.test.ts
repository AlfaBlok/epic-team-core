import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addRepoRename, checkoutName, repoAliases, repoKey, resetRepoRenames, sameRepo } from "../src/adapters/repoNames.js";
import { resetRepoScans, resolveRepo } from "../src/adapters/repos.js";
import { matchProject, type T3Project } from "../src/t3/client.js";

// the team's code repo is renamed to the team's code repo on GitHub; the console takes both names.
describe("T89-S2: a renamed repo answers to both names", () => {
  // the suite's own rename (a hosted layer adds its real ones at load: hosted/identity.ts)
  resetRepoRenames();
  addRepoRename("Acme/home_repo", "Acme/new-team");
  afterEach(() => {
    delete process.env.CONSOLE_REPO_RENAMES;
    resetRepoScans();
  });

  it("gives the old and the new name, as slug, URL or bare name, one key", () => {
    for (const a of ["Acme/home_repo", "acme/HOME_REPO", "https://github.com/Acme/home_repo.git", "git@github.com:Acme/new-team.git", "Acme/new-team/"])
      expect(repoKey(a)).toBe("acme/new-team");
    expect(repoKey("home_repo")).toBe("new-team");
    expect(sameRepo("Acme/home_repo", "Acme/new-team")).toBe(true);
    expect(sameRepo("home_repo", "new-team")).toBe(true);
    expect(sameRepo("Acme/home_repo", "Acme/ops")).toBe(false);
    expect(sameRepo("Acme/home_repo_social", "Acme/home_repo")).toBe(false);
    expect(sameRepo(undefined, "Acme/home_repo")).toBe(false);
    expect(sameRepo("refused:Acme/home_repo", "Acme/new-team")).toBe(false);
    expect(repoAliases("Acme/new-team")).toEqual(["Acme/new-team", "Acme/home_repo"]);
    expect(repoAliases("home_repo")).toEqual(["home_repo", "new-team"]);
    expect(repoAliases("Acme/ops")).toEqual(["Acme/ops"]);
  });

  it("keeps the old checkout folder for either name (step A renames no folder)", () => {
    expect(checkoutName("Acme/new-team")).toBe("home_repo");
    expect(checkoutName("Acme/home_repo")).toBe("home_repo");
    expect(checkoutName("new-team")).toBe("home_repo");
    expect(checkoutName("Acme/ops.git")).toBe("ops");
  });

  it("takes more renames from CONSOLE_REPO_RENAMES", () => {
    process.env.CONSOLE_REPO_RENAMES = "Acme/old-thing=Acme/new-thing, junk";
    expect(sameRepo("Acme/old-thing", "acme/new-thing")).toBe(true);
    expect(checkoutName("Acme/new-thing")).toBe("old-thing");
    expect(sameRepo("Acme/home_repo", "Acme/new-team")).toBe(true);
  });

  it("resolves a milestone under either name to the home_repo checkout, before and after the remote moves", () => {
    resetRepoScans(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e89s2-"));
    try {
      const cfg = (slug: string) => `[remote "origin"]\n\turl = https://github.com/${slug}.git\n`;
      fs.mkdirSync(path.join(root, "home_repo", ".git"), { recursive: true });
      fs.mkdirSync(path.join(root, "ops", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "ops", ".git", "config"), cfg("Acme/ops"));
      const at = path.join(root, "home_repo");
      for (const remote of ["Acme/home_repo", "Acme/new-team"]) {
        fs.writeFileSync(path.join(at, ".git", "config"), cfg(remote));
        for (const name of ["Acme/home_repo", "Acme/new-team", "acme/new-team", "home_repo", "new-team"]) expect(resolveRepo(root, name)?.path, `${name} with origin ${remote}`).toBe(at);
        expect(resolveRepo(root, "Acme/ops")?.name).toBe("ops");
      }
      expect(resolveRepo(root, "Acme/new-team")?.remote).toBe("Acme/new-team");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the T3 project whichever name its identity or the milestone carries", () => {
    const projects = (key: string): T3Project[] => [
      { id: "infra", title: "ops", workspaceRoot: "/srv/agent/github/ops", repositoryIdentity: { canonicalKey: "github.com/acme/ops" } },
      { id: "team", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { canonicalKey: `github.com/${key}` } },
    ];
    for (const key of ["acme/home_repo", "acme/new-team"])
      for (const repo of ["Acme/home_repo", "Acme/new-team", "home_repo", "new-team"]) expect(matchProject(projects(key), repo)?.id, `${repo} vs ${key}`).toBe("team");
    expect(matchProject(projects("acme/new-team"), "Acme/ops")?.id).toBe("infra");
  });
});
