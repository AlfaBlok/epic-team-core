import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { briefingDecision, mountBriefing, objectiveEpic, withBriefingWords } from "../src/briefing.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { tempCheckout } from "./helpers/gitRepo.js";

// His briefing (the owner, 16 Nov: "it gives me at some point a briefing where it's telling me, these are your
// objectives and key results, one by one. And I can just talk about it"): what he says on one objective is filed on it,
// his words file and one Decisions line on its epic quoting him whole, in one commit.

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const OBJ = JSON.stringify({ pursuits: [{ id: "team-browser", name: "EpicTeam: team browser fully operational", epics: [{ repo: "other", spine: "docs/x.md" }, { repo: "home_repo", spine: "docs/spines/epic-7.md" }] }, { id: "far", name: "Far: one", epics: [{ repo: "other", spine: "docs/x.md" }] }] }, null, 2) + "\n";
const WORDS = JSON.stringify({ version: 2, objectives: [{ id: "team-browser", name: "EpicTeam: team browser fully operational", after: { words: "old", said: "2026-11-10T00:00Z" } }] }, null, 2) + "\n";
const EPIC = "# EPIC-907: Browser\n\n## Current State\nStatus: active\n\n## Decisions\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n| 2026-11-10 | accepted | older | x | y | z |\n\n## Operating Learnings\n";
const CAMPAIGN = "# Get testers\n\n## Decisions\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n| 2026-11-10 | accepted | older | x | y | z |\n";

describe("the pieces", () => {
  const a = { kind: "objective" as const, id: "team-browser", name: "EpicTeam: team browser fully operational", words: "Reddit is the one | that matters.", note: "vn_ab12cd34", by: "Sam", at: "2026-11-16T09:00:00Z" };
  it("the objective's epic is its first in the home repo", () => {
    expect(objectiveEpic(OBJ, "team-browser", "home_repo")).toEqual({ name: "EpicTeam: team browser fully operational", repo: "home_repo", spine: "docs/spines/epic-7.md" });
    expect(objectiveEpic(OBJ, "far", "home_repo")?.repo).toBe("other");
    expect(objectiveEpic(OBJ, "nope", "home_repo")).toBeUndefined();
  });
  it("his words: newest words and the briefing list, newest first", () => {
    const r = withBriefingWords(WORDS, a);
    if ("skip" in r) throw new Error(r.skip);
    const o = JSON.parse(r.text).objectives[0];
    expect(o.after).toMatchObject({ words: "Reddit is the one | that matters.", via: "Briefing", source: "Briefing, voice note vn_ab12cd34" });
    expect(o.briefing[0]).toEqual({ words: "Reddit is the one | that matters.", said: "2026-11-16T09:00:00Z", note: "vn_ab12cd34" });
  });
  it("the Decisions line quotes him whole, a pipe kept out of the table", () => {
    const row = briefingDecision(a, "docs/his-words.json");
    expect(row.startsWith("| 2026-11-16 | his words | Sam on “EpicTeam: team browser fully operational” in his briefing (voice note vn_ab12cd34")).toBe(true);
    expect(row).toContain("“Reddit is the one / that matters.”");
    expect(row.split(" | ")).toHaveLength(6);
  });
});

describe("the route writes the repo", () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s115-"));
    const co = tempCheckout(root, "home_repo", { "docs/pursuits.json": OBJ, "docs/his-words.json": WORDS, "docs/spines/epic-7.md": EPIC, "docs/spines/get-testers.md": CAMPAIGN });
    cleanup = () => {
      co.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    };
    const api = new Hono();
    mountBriefing(api, {
      writer: createSpineWriter(),
      reposRoot: root,
      repo: "home_repo",
      milestone: (id) => (id === "ms_1" ? { id, title: "Get testers", repo: "home_repo", path: "docs/spines/get-testers.md" } : undefined),
      who: () => "Sam",
      now: () => new Date("2026-11-16T09:00:00Z"),
    });
    const post = (body: unknown) => api.request("/briefing/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { co, post };
  };

  it("an objective: his words file and its epic's Decisions line, one commit", async () => {
    const { co, post } = setup();
    const r = await post({ kind: "objective", id: "team-browser", words: "Reddit first. (voice note vn_ab12cd34, https://x/vn)" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { filed: string[] }).filed).toEqual(["docs/his-words.json", "home_repo:docs/spines/epic-7.md"]);
    expect(JSON.parse(co.onMain("docs/his-words.json")).objectives[0].briefing[0].note).toBe("vn_ab12cd34");
    expect(co.onMain("docs/spines/epic-7.md")).toContain("| 2026-11-16 | his words | Sam on “EpicTeam: team browser fully operational” in his briefing (voice note vn_ab12cd34, 2026-11-16T09:00:00Z): “Reddit first.");
    expect(co.log()[0]).toBe("Briefing: Sam's words on “EpicTeam: team browser fully operational”");
    expect(co.log()).toHaveLength(2);
  });

  it("a campaign: a Decisions line on its own spine", async () => {
    const { co, post } = setup();
    expect((await post({ kind: "campaign", id: "ms_1", name: "Get testers", words: "Push Reddit." })).status).toBe(200);
    expect(co.onMain("docs/spines/get-testers.md")).toContain("Sam on “Get testers” in his briefing (typed, 2026-11-16T09:00:00Z): “Push Reddit.”");
  });

  it("refuses what it cannot file", async () => {
    const { post } = setup();
    expect((await post({ kind: "objective", id: "team-browser", words: "" })).status).toBe(400);
    expect((await post({ kind: "objective", id: "nope", words: "x" })).status).toBe(404);
    expect((await post({ kind: "campaign", id: "ms_9", words: "x" })).status).toBe(404);
  });
});
