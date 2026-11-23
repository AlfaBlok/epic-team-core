import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globRe, homeTab, readHomeFile, readHomeWheels, rootOf } from "../src/homeFiles.js";

// History and Pages show every file homed there (the owner's ask).
let root: string;
let home: string;
let camp: string;
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: process.env.D, GIT_COMMITTER_DATE: process.env.D } });
const put = (dir: string, rel: string, text = "x") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir: string, msg: string, date: string) => {
  process.env.D = date;
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "homes-"));
  home = path.join(root, "home-repo");
  camp = path.join(root, "social-repo");
  for (const d of [home, camp]) {
    fs.mkdirSync(d, { recursive: true });
    git(d, "init", "-q");
  }
  put(home, "docs/totems/epicteam.json", JSON.stringify({
    product: "epicteam", name: "EpicTeam",
    wheel: { tabs: [
      { id: "table", label: "Key results", homes: ["docs/reports/*"] },
      { id: "pages", label: "Pages", homes: ["docs/status/*", "docs/pages/*", "docs/landing/*"] },
    ], homes: { repos: ["home-repo"] } },
  }));
  put(home, "docs/totems/social.json", JSON.stringify({
    product: "social", name: "Social",
    wheel: { tabs: [{ id: "history", label: "History", homes: ["docs/outcomes/*", "docs/log/*"] }], homes: { repos: ["social-repo"] } },
  }));
  commit(home, "map", "2026-11-01T00:00:00Z");
  put(home, "docs/status/e907-s3/proof.html", "<html><head><title>Every write has a home</title></head></html>");
  put(home, "docs/status/e907-s3/homes-1280.webp", "img");
  put(home, "docs/status/e907-s3/build.py", "print(1)");
  commit(home, "E907-S3 iteration 2: homes", "2026-11-20T00:00:00Z");
  put(home, "docs/status/2026-11-18-what-runs.md", "# What runs on a schedule\n\nbody");
  put(home, "docs/status/advisor/2026-11-11.md", "no heading");
  put(home, "docs/status/advisor/chart.png", "img");
  commit(home, "E907-S4 advisor notes", "2026-11-21T00:00:00Z");
  put(home, "docs/reports/w47.md", "# A report");
  put(home, "docs/landing/gap-finder/index.html", "<title>Gap finder</title>");
  commit(home, "E907-S5 landing", "2026-11-22T00:00:00Z");
  put(camp, "docs/spines/recruit-testers.md", "# spine");
  put(camp, "docs/log/recruit-testers/2026-W47.md", "# Week 47\n");
  put(camp, "docs/log/root/2026-W46.md", "week");
  put(camp, "docs/outcomes/2026-11-22.jsonl", "{}\n");
  commit(camp, "E907-S6 weekly log", "2026-11-22T10:00:00Z");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const dirOf = (r: string) => ({ "home-repo": home, "social-repo": camp })[r];

describe("homed files per tab", () => {
  it("matches like Python fnmatch: * crosses folders", async () => {
    expect(globRe("docs/status/*").test("docs/status/a/b/c.md")).toBe(true);
    expect(globRe("data/*-daily.md").test("data/kpi-daily.md")).toBe(true);
    expect(globRe("docs/plan/*").test("docs/plans/x")).toBe(false);
    expect(rootOf("docs/status/*")).toBe("docs/status/");
    expect(rootOf("data/*-daily.md")).toBe("data/");
    expect(rootOf("docs/campaign-plan.md")).toBe("docs/");
  });

  it("Pages lists every homed file once, newest first, a page folder as one page with its row", async () => {
    const b = (await homeTab({ wheels: readHomeWheels(home), product: "epicteam", tab: "pages", repoDir: dirOf }))!;
    // build.py is code, never shown; every other homed file is covered.
    expect(b.homed).toBe(6);
    expect(b.covered).toBe(b.homed);
    expect(b.entries.map((e) => e.open)).toEqual([
      "docs/landing/gap-finder/index.html",
      "docs/status/2026-11-18-what-runs.md",
      "docs/status/advisor/",
      "docs/status/advisor/2026-11-11.md",
      "docs/status/e907-s3/proof.html",
    ]);
    const page = b.entries.find((e) => e.row === "E907-S3")!;
    expect(page).toMatchObject({ kind: "page", title: "Every write has a home", files: 2, path: "docs/status/e907-s3" });
    // a file no folder names takes the row of the commit that made it.
    expect(b.entries.find((e) => e.open.endsWith("what-runs.md"))).toMatchObject({ title: "What runs on a schedule", row: "E907-S4", kind: "note" });
    // a folder of pictures takes the words of the commit that made it.
    expect(b.entries.find((e) => e.open === "docs/status/advisor/")).toMatchObject({ kind: "folder", files: 1, title: "Advisor notes" });
  });

  it("History lists the weekly logs with their spine and the outcome files", async () => {
    const b = (await homeTab({ wheels: readHomeWheels(home), product: "social", tab: "history", repoDir: dirOf }))!;
    expect(b.homed).toBe(3);
    expect(b.covered).toBe(3);
    expect(b.entries.find((e) => e.open === "docs/log/recruit-testers/2026-W47.md")).toMatchObject({ spine: "docs/spines/recruit-testers.md", title: "Week 47", row: "E907-S6" });
    expect(b.entries.find((e) => e.open === "docs/log/root/2026-W46.md")?.title).toBe("Root 2026 W46");
    expect(b.entries.some((e) => e.open === "docs/outcomes/2026-11-22.jsonl")).toBe(true);
  });

  it("an unknown tab or product is none", async () => {
    expect(await homeTab({ wheels: readHomeWheels(home), product: "epicteam", tab: "nope", repoDir: dirOf })).toBeNull();
  });
});

describe("opening a homed file", () => {
  const open = (repo: string, rel: string) => readHomeFile({ wheels: readHomeWheels(home), repo, rel, repoDir: dirOf(repo) });
  it("serves a page sandboxed, a note as readable text and a folder as its list", async () => {
    const p = open("home-repo", "docs/status/e907-s3/proof.html");
    expect(p).toMatchObject({ status: 200, type: "text/html; charset=utf-8", sandbox: true });
    const n = open("home-repo", "docs/status/2026-11-18-what-runs.md");
    expect(n.status).toBe(200);
    expect(String((n as { body: string }).body)).toContain("What runs on a schedule");
    const f = open("home-repo", "docs/status/advisor/");
    expect(String((f as { body: string }).body)).toContain('href="chart.png"');
    expect(open("home-repo", "docs/status/e907-s3/homes-1280.webp")).toMatchObject({ status: 200, type: "image/webp" });
  });
  it("refuses code, files no tab homes and paths that climb out", async () => {
    expect(open("home-repo", "docs/status/e907-s3/build.py").status).toBe(404);
    expect(open("home-repo", "docs/totems/epicteam.json").status).toBe(404);
    expect(open("home-repo", "docs/status/../../etc/passwd").status).toBe(400);
    expect(open("home-repo", "docs/status/%2e%2e/x").status).toBe(404);
  });
});

describe("GET /api/homes (the console routes)", () => {
  it("is open to the owner's other world in the route judge (the handler still answers only his two worlds)", async () => {
    const { isTenantSafe } = await import("../src/auth/routeScope.js");
    expect(isTenantSafe("GET", "/api/homes/all/history")).toBe(true);
    expect(isTenantSafe("GET", "/api/homes/file/social-repo/docs/log/root/2026-W47.md")).toBe(true);
    expect(isTenantSafe("POST", "/api/homes/all/history")).toBe(false);
  });
  it("answers a tab's entries and opens a homed file, refusing others", async () => {
    const { createApp } = await import("../src/app.js");
    const { openDb } = await import("../src/db.js");
    const { homeRepo } = await import("../src/identity.js");
    // the console reads the map from its home repo, whatever this build names it.
    if (homeRepo() !== "home-repo" && !fs.existsSync(path.join(root, homeRepo()))) fs.symlinkSync(home, path.join(root, homeRepo()));
    const db = openDb(path.join(root, "c.db"));
    try {
      const app = createApp(db, {
        read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => { throw new Error("none"); } },
        browser: { browserUrl: "http://127.0.0.1:9" },
        readModel: { mode: "in-process", tickMs: 0, drift: { everyMs: 3600_000, firstAfterMs: 3600_000, confirmAfterMs: 0, alert: true } },
      } as Parameters<typeof createApp>[1]);
      const tab = await app.request("/api/homes/epicteam/pages");
      expect(tab.status).toBe(200);
      const body = (await tab.json()) as { homed: number; covered: number; entries: { open: string }[] };
      expect(body).toMatchObject({ homed: 6, covered: 6 });
      const all = (await (await app.request("/api/homes/all/history")).json()) as { homed: number };
      expect(all.homed).toBe(3);
      const page = await app.request("/api/homes/file/home-repo/docs/status/e907-s3/proof.html");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("sandbox");
      expect(await page.text()).toContain("Every write has a home");
      expect((await app.request("/api/homes/file/home-repo/docs/status/e907-s3/build.py")).status).toBe(404);
      expect((await app.request("/api/homes/epicteam/nope")).status).toBe(404);
    } finally {
      db.close();
    }
  }, 60_000);
});
