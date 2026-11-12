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
