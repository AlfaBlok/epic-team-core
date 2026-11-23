import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut, type GitOut } from "../src/freshness.js";
import { buildPursuits, createPursuits, doneMeansOf, parsePursuits, worst, type BoardView } from "../src/pursuits.js";

/** The owner's pursuits: a scorecard read from real checks, totems one click away, moving or stalled from git. */

const NOW = Date.parse("2026-11-12T05:00:00Z");
const DAY = 86_400_000;

const FILE = JSON.stringify({
  staleDays: 3,
  said: { source: "Log/x.md#^e-1", words: "the worst thing is the stale" },
  pursuits: [
    {
      id: "live",
      name: "Product live",
      greenWhen: "A stranger signs up and pays.",
      watch: [{ repo: "app", paths: ["docs/plan.md"] }],
      lines: [
        { label: "Healthy", from: "light", product: "p1", light: "The service is healthy" },
        { label: "One payment", from: "light", product: "p1", light: "One real payment went through" },
        { label: "Board", from: "board", product: "p1" },
        { label: "Plan boxes", from: "doneMeans", repo: "app", spine: "docs/plan.md", ids: ["E900-1", "E900-2"] },
      ],
      totems: [
        { label: "Deck", url: "https://example.com/deck" },
        { label: "Social kit", missing: "Only the pictures exist" },
        { label: "Board", url: "/launch" },
        { label: "Bad", url: "javascript:alert(1)" },
      ],
    },
    {
      id: "secrets",
      name: "Secrets kept",
      greenWhen: "Every login is in the vault.",
      watch: [{ repo: "app", paths: ["docs/other.md"] }],
      lines: [
        { label: "Waiting", from: "check", check: "pending" },
        { label: "Old one", from: "check", check: "old" },
      ],
      totems: [],
    },
    { id: "no-green-when", name: "Skipped" },
  ],
  checks: {
    pending: { state: "green", value: "0 waiting", at: "2026-11-12T04:00Z" },
    old: { state: "green", value: "5 of 5", at: "2026-11-01T04:00Z" },
  },
});

const PLAN = "# Plan\n\n## Done means\n\n- [x] E900-1 first\n- [ ] E900-2 second\n- [ ] E900-3 not watched\n\n## Current State\n";

const BOARD: BoardView = {
  checkedAt: "2026-11-12T04:30:00Z",
  products: [
    {
      id: "p1",
      greens: 3,
      total: 4,
      lights: [
        { label: "The service is healthy", state: "green" },
        { label: "One real payment went through on the live account", state: "red", fix: "Pay once with a real card" },
      ],
    },
  ],
};

const fakeGit =
  (log: string): GitOut =>
  async () =>
    log;

describe("pursuits: the file", () => {
  it("keeps pursuits with an id, a name and a green-when line, and drops unsafe totem links", () => {
    const doc = parsePursuits(FILE);
    expect(doc.pursuits.map((p) => p.id)).toEqual(["live", "secrets"]);
    expect(doc.pursuits[0].totems).toEqual([
      { label: "Deck", url: "https://example.com/deck" },
      { label: "Social kit", missing: "Only the pictures exist" },
      { label: "Board", url: "/launch" },
      { label: "Bad", missing: "not made yet" },
    ]);
    expect(parsePursuits("not json").pursuits).toEqual([]);
  });

  it("counts only the named Done-means boxes", () => {
    expect(doneMeansOf(PLAN, ["E900-1", "E900-2"])).toEqual({ done: 1, total: 2, open: ["E900-2"] });
    expect(doneMeansOf(PLAN, [])).toEqual({ done: 1, total: 3, open: ["E900-2", "E900-3"] });
  });

  it("the worst known line sets the colour", () => {
    expect(worst([{ label: "a", state: "green", value: "" }, { label: "b", state: "amber", value: "" }])).toBe("amber");
    expect(worst([{ label: "a", state: "unknown", value: "" }, { label: "b", state: "red", value: "" }])).toBe("red");
    expect(worst([])).toBe("unknown");
  });
});

describe("pursuits: the scorecard and the motion", () => {
  const read = (log: string, board: BoardView | null = BOARD) =>
    buildPursuits(parsePursuits(FILE), { board, spineText: (_r, f) => (f === "docs/plan.md" ? PLAN : undefined), repoDir: () => "/repo", git: fakeGit(log), now: NOW });

  it("reads lights, the board and Done-means boxes into green, amber and red lines", async () => {
    const t = Math.floor((NOW - DAY) / 1000);
    const body = await read(`${t}\tShip the checkout`);
    const live = body.pursuits[0];
    expect(live.lines).toEqual([
      { label: "Healthy", state: "green", value: "yes" },
      { label: "One payment", state: "red", value: "not yet", note: "Pay once with a real card" },
      { label: "Board", state: "amber", value: "3 of 4 lights", note: "the launch board, every light a real check" },
      { label: "Plan boxes", state: "amber", value: "1 of 2 done", note: "open: E900-2" },
    ]);
    expect(live.state).toBe("red");
    expect([live.greens, live.total]).toEqual([1, 4]);
    expect(body.said?.words).toContain("stale");
    expect(body.boardAt).toBe("2026-11-12T04:30:00Z");
  });

  it("a deciding key result that is green turns the whole objective green", async () => {
    const doc = parsePursuits(JSON.stringify({ staleDays: 3, pursuits: [{ id: "house", name: "Acme: Buy a place", greenWhen: "Bought.", watch: [], lines: [
      { label: "A place was bought", from: "check", check: "bought", decides: true },
      { label: "Satisfaction", from: "check", check: "sat" },
    ] }], checks: { bought: { state: "red", value: "not yet", at: "2026-11-12T04:00Z" }, sat: { state: "red", value: "negative", at: "2026-11-12T04:00Z" } } }));
    const o = { board: null, spineText: () => undefined, repoDir: () => undefined, git: fakeGit(""), now: NOW };
    expect((await buildPursuits(doc, o)).pursuits[0].state).toBe("red");
    doc.checks.bought.state = "green";
    expect((await buildPursuits(doc, o)).pursuits[0].state).toBe("green");
  });

  it("a check older than the stale window is not trusted", async () => {
    const body = await read("");
    const secrets = body.pursuits[1];
    expect(secrets.lines[0]).toEqual({ label: "Waiting", state: "green", value: "0 waiting" });
    expect(secrets.lines[1].state).toBe("unknown");
    expect(secrets.lines[1].value).toContain("checked too long ago");
  });

  it("moving when a real commit touched it within the window, skipping claims and desk notes", async () => {
    const recent = Math.floor((NOW - 2 * 3600_000) / 1000);
    const old = Math.floor((NOW - 2 * DAY) / 1000);
    const body = await read(`${recent}\tClaim E900-S1: run_x (lease until …)\n${recent}\tDesk note from a world\n${old}\tE900-S1: payment page built`);
    expect(body.pursuits[0].motion).toBe("moving");
    expect(body.pursuits[0].lastMove).toEqual({ at: new Date(old * 1000).toISOString(), repo: "app", subject: "E900-S1: payment page built" });
  });

  it("stalled when only bookkeeping, or nothing, changed in three days", async () => {
    const recent = Math.floor((NOW - 3600_000) / 1000);
    const old = Math.floor((NOW - 4 * DAY) / 1000);
    const body = await read(`${recent}\tClaim E900-S2: run_y\n${recent}\tReview gate: card fixed\n${old}\tE900-S2: plan written`);
    expect(body.pursuits[0].motion).toBe("stalled");
    const none = await read("");
    expect(none.pursuits[0].motion).toBe("unknown");
  });

  it("in a repo two objectives watch, a commit moves only the objective whose epic it names", async () => {
    const doc = parsePursuits(JSON.stringify({ staleDays: 3, pursuits: [
      { id: "a", name: "A: one", greenWhen: "x", watch: [{ repo: "team", paths: ["docs"] }], epics: [{ repo: "team", spine: "docs/a.md" }], lines: [] },
      { id: "b", name: "B: two", greenWhen: "y", watch: [{ repo: "team", paths: ["docs"] }], epics: [{ repo: "team", spine: "docs/b.md" }], lines: [] },
    ] }));
    const recent = Math.floor((NOW - 3600_000) / 1000);
    const older = Math.floor((NOW - 7200_000) / 1000);
    const spineText = (_r: string, f: string) => (f === "docs/a.md" ? "# EPIC-907: A\n" : f === "docs/b.md" ? "# EPIC-908: B\n" : undefined);
    const body = await buildPursuits(doc, { board: null, spineText, repoDir: () => "/repo", git: fakeGit(`${recent}\tE908-S4: B work\n${older}\tE907-S2: A work`), now: NOW });
    expect(body.pursuits[0].lastMove?.subject).toBe("E907-S2: A work");
    expect(body.pursuits[1].lastMove?.subject).toBe("E908-S4: B work");
  });

  it("without a launch board the light lines say so instead of guessing", async () => {
    const body = await read("", null);
    expect(body.pursuits[0].lines[0]).toMatchObject({ state: "unknown", value: "not read yet" });
  });
});

describe("pursuits: from a real checkout", () => {
  it("reads the home repo's file and its git history", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pursuits-"));
    const home = path.join(root, "home_repo");
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", home, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q");
    const file = JSON.parse(FILE);
    file.pursuits[0].watch = [{ repo: "home_repo", paths: ["docs/plan.md"] }];
    file.pursuits[0].lines[3].repo = "home_repo";
    fs.writeFileSync(path.join(home, "docs/pursuits.json"), JSON.stringify(file));
    fs.writeFileSync(path.join(home, "docs/plan.md"), PLAN);
    git("add", ".");
    git("commit", "-qm", "E900-S1: plan written");
    try {
      const svc = createPursuits({ reposRoot: root, board: () => BOARD, git: gitOut(10_000), home: "home_repo" });
      const body = await svc.get();
      expect(body.pursuits[0].motion).toBe("moving");
      expect(body.pursuits[0].lastMove?.subject).toBe("E900-S1: plan written");
      expect(body.pursuits[0].lines[3].value).toBe("1 of 2 done");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pursuits: a social kit inside the console", () => {
  it("a pursuit's kit folder gives its kit.json, previews and fonts, and nothing outside them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pursuits-kit-"));
    const home = path.join(root, "home_repo");
    const kitDir = path.join(home, "docs/brand/social-kit/live");
    fs.mkdirSync(path.join(kitDir, "previews"), { recursive: true });
    fs.mkdirSync(path.join(home, "docs/brand/social-kit/fonts"), { recursive: true });
    fs.mkdirSync(path.join(home, ".git"));
    const file = JSON.parse(FILE);
    file.pursuits[0].kit = { dir: "docs/brand/social-kit/live", files: "http://files.example/live/assets/" };
    file.pursuits.push({ id: "bad", name: "Bad", greenWhen: "Never.", kit: { dir: "../outside" } });
    fs.writeFileSync(path.join(home, "docs/pursuits.json"), JSON.stringify(file));
    fs.writeFileSync(path.join(kitDir, "kit.json"), JSON.stringify({ id: "live", name: "Live", tagline: "Agents that post for you." }));
    fs.writeFileSync(path.join(kitDir, "previews/banner-x.webp"), "WEBP");
    fs.writeFileSync(path.join(home, "docs/brand/social-kit/fonts/funnel-sans.woff2"), "WOFF");
    try {
      const svc = createPursuits({ reposRoot: root, board: () => BOARD, git: gitOut(10_000), home: "home_repo" });
      const id = file.pursuits[0].id as string;
      const body = await svc.get();
      expect(body.pursuits[0].kit).toBe(true);
      expect(body.pursuits.find((p) => p.id === "bad")?.kit).toBeUndefined();
      expect(svc.kit(id)).toEqual({ pursuit: { id, name: file.pursuits[0].name }, kit: { id: "live", name: "Live", tagline: "Agents that post for you." }, files: "http://files.example/live/assets/" });
      expect(svc.kit("bad")).toBeNull();
      expect(svc.kitFile(id, "previews", "banner-x.webp")?.type).toBe("image/webp");
      expect(svc.kitFile(id, "fonts", "funnel-sans.woff2")?.body.toString()).toBe("WOFF");
      expect(svc.kitFile(id, "previews", "../kit.json")).toBeNull();
      expect(svc.kitFile(id, "previews", "kit.json")).toBeNull();
      expect(svc.kitFile(id, "fonts", "banner-x.webp")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pursuits: a kit preview missing on disk is read from git", () => {
  it("a checkout without media (sparse) still serves the committed preview", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pursuits-kit-git-"));
    const home = path.join(root, "home_repo");
    const kitDir = path.join(home, "docs/kits/live");
    fs.mkdirSync(path.join(kitDir, "previews"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", home, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q");
    const file = JSON.parse(FILE);
    file.pursuits[0].kit = { dir: "docs/kits/live" };
    fs.writeFileSync(path.join(home, "docs/pursuits.json"), JSON.stringify(file));
    fs.writeFileSync(path.join(kitDir, "kit.json"), JSON.stringify({ id: "live", name: "Live" }));
    fs.writeFileSync(path.join(kitDir, "previews/banner-x.webp"), "WEBP-IN-GIT");
    git("add", ".");
    git("commit", "-qm", "kit");
    fs.rmSync(path.join(kitDir, "previews/banner-x.webp"));
    try {
      const svc = createPursuits({ reposRoot: root, board: () => BOARD, git: gitOut(10_000), home: "home_repo" });
      const id = file.pursuits[0].id as string;
      expect(svc.kitFile(id, "previews", "banner-x.webp")?.body.toString()).toBe("WEBP-IN-GIT");
      expect(svc.kitFile(id, "previews", "nothing-here.webp")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
