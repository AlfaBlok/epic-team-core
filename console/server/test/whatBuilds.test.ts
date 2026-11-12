import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILDING_FILE, clearBuildingCache, countSpine, parseBuilding, readBuilding, redLineRepos } from "../src/building.js";

/**
 * (the owner, vn_e3e2455d on ROOT-A8, 2026-11-11: "I'm building the memory service, I'm building Epic Team, I'm building Epic Social,
 * I'm building this Flywheel... those are the lists... And then on Epic Social, we have campaigns").
 */
const spine = (title: string, status: string, body = "") =>
  `# ${title}\n\n## Current State\n\nStatus: ${status}\n\n${body}\n`;
const ASK_OPEN = "- [ask E901-A1: approve @Sam since 2026-11-10 row S1] Spend 11 dollars — recommend: yes";
const ASK_SNOOZED = "- [ask E901-A2: decide @Sam since 2026-11-10 row S2] A or B — options: A | B — recommend: A — snoozed until: 2099-01-01";
const ASK_ANSWERED = "- [answered E901-A3 2026-11-10 @Sam] Done thing — answer: APPROVED";
const ASK_OTHER = "- [ask E901-A4: approve @Marta since 2026-11-10 row S3] Hers — recommend: yes";
const LEDGER = [
  "| Row | Owner | Title | Status |",
  "|---|---|---|---|",
  "| E901-S1 | worker | One | review (live abc) |",
  "| E901-S2 | worker | Two | active |",
  "| E901-S3 | worker | Three | `review` |",
].join("\n");

describe("E948-S45 what Sam builds", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    clearBuildingCache();
  });
  const mkRepo = (root: string, name: string, files: Record<string, string>) => {
    const repo = path.join(root, name);
    execFileSync("git", ["init", "-q", repo]);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    }
  };

  it("counts open asks to him (not snoozed, not answered, not someone else's) and rows in review", () => {
    const text = spine("EPIC-901: X", "active", `## Waiting on\n\n${ASK_OPEN}\n${ASK_SNOOZED}\n${ASK_ANSWERED}\n${ASK_OTHER}\n\n## Ledger\n\n${LEDGER}`);
    expect(countSpine(text)).toEqual({ asks: 1, review: 2 });
  });

  it("parses the lists and takes a list's repos from a red line", () => {
    expect(parseBuilding("not json")).toEqual([]);
    expect(parseBuilding(JSON.stringify({ lists: [{ id: "a", name: "A" }, { id: "a", name: "Dup" }, { name: "no id" }] })).map((l) => l.name)).toEqual(["A"]);
    const pr = JSON.stringify({ redLines: [{ name: "Data-product flywheel", items: [{ repo: "obs" }, { repo: "funnels" }, { repo: "obs" }] }] });
    expect(redLineRepos(pr, "data-product flywheel")).toEqual(["obs", "funnels"]);
    expect(redLineRepos(pr, "other")).toEqual([]);
  });

  it("reads the lists, their named campaigns from the spines and what waits on him there", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e48s45-"));
    dirs.push(root);
    mkRepo(root, "home_repo", {
      [BUILDING_FILE]: JSON.stringify({
        lists: [
          { id: "memo", name: "Memo", repos: ["memo"], campaignRepos: ["memo-social"], open: { label: "memo.example.com", url: "https://memo.example.com/" } },
          { id: "flywheel", name: "The Flywheel", redLine: "Data-product flywheel", campaignRepos: [] },
        ],
      }),
      "docs/priorities.json": JSON.stringify({ redLines: [{ name: "Data-product flywheel", items: [{ repo: "obs" }] }] }),
    });
    // memory keeps a spine in docs/, not docs/spines/
    mkRepo(root, "memo", { "docs/launch.md": spine("EPIC-901: Launch", "active", `## Waiting on\n\n${ASK_OPEN}\n\n${LEDGER}`), "docs/notes.md": "# just notes\n" });
    const plan = "\n## Campaign plan\n\nTopics: memory\n";
    mkRepo(root, "memo-social", {
      "docs/spines/root.md": spine("EPIC-900: Memo social", "active") + plan,
      "docs/spines/recruit-testers.md": spine("EPIC-906: Memo testers", "active", `## Waiting on\n\n${ASK_OPEN}`) + plan,
      "docs/spines/old.md": spine("EPIC-911: Old awareness", "superseded") + plan,
      "docs/spines/test.md": spine("EPIC-913: TEST deck proof", "deferred") + plan,
    });
    mkRepo(root, "obs", { "docs/spines/root.md": spine("EPIC-900: Obs", "active", LEDGER) });
    const lists = readBuilding(root);
    expect(lists.map((l) => l.name)).toEqual(["Memo", "The Flywheel"]);
    const [z, f] = lists;
    expect(z.repos).toEqual(["memo", "memo-social"]);
    expect(z.waits).toEqual({ asks: 2, review: 2 });
    expect(z.repoWaits).toEqual({ memo: { asks: 1, review: 2 }, "memo-social": { asks: 1, review: 0 } });
    // the repo itself (root.md), a superseded and a deferred campaign are not named campaigns
    expect(z.campaigns.map((c) => [c.name, c.waits.asks])).toEqual([["Memo testers", 1]]);
    expect(z.open).toEqual({ label: "memo.example.com", url: "https://memo.example.com/" });
    expect(f.repos).toEqual(["obs"]);
    expect(f.waits).toEqual({ asks: 0, review: 2 });
    expect(f.campaigns).toEqual([]);
  });

});
