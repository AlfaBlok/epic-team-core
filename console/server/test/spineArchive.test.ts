import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveEpicCode, archiveRelOf, isArchiveRel, readArchiveOf, sourceRelOf, withArchive } from "../src/adapters/spineArchive.js";
import { rowIn } from "../src/review/rows.js";
import { createSpineFileReader, createWorkFinder } from "../src/scorecards.js";
import { openDb } from "../src/db.js";
import { createPlacements, migratePlacements } from "../src/desk/placements.js";
import { createAfterClose } from "../src/review/afterClose.js";
import { cardFor } from "../src/review/face.js";
import { parseDecisions, withArchiveText } from "../src/book/build.js";
import { deliverablesFor } from "../src/book/deliverables.js";
import type { Store } from "../src/store.js";

/**
 * An epic's finished rows move to `<stem>.archive.md` beside it, ids kept, and every lookup of a row by id finds an
 * archived row the same way as a ledger row.
 */

const HEAD = "| Issue | Role | Owner / Assignment | Title | Status | Depends On | Latest Evidence | Last Verified | Next Action |\n|---|---|---|---|---|---|---|---|---|";
const SPINE = `# EPIC-907: Team runs\n\nSpine ID: t-907\n\n## Done means\n\n- [ ] E907-1 Runs alone\n\n## Issue Ledger\n\nFinished rows: [archive](epic-907.archive.md)\n\n${HEAD}\n| E907-S9 | Ticket worker | run_9 | Still open work | ready | none | none | 2026-11-23 | go |\n\n## Decisions\n\n| Date | Outcome | Decision | Summary | Evidence | Revisit |\n|---|---|---|---|---|---|\n| 2026-11-20 | kept | E907-S1 shipped | x | x | never |\n`;
const ARCHIVE = `# Archive of EPIC-907: finished rows\n\nArchive of: [EPIC-907: Team runs](epic-907.md)\n\n## Issue Ledger\n\n${HEAD}\n| E907-S1 | Ticket worker | run_1 | Old page shipped | done (approved by Sam 2026-11-01) | none | [the page](http://example.test:9000/) | 2026-11-01 | none |\n| E907-S2 | Ticket worker | run_2 | Old fix | superseded by E907-S9 | none | none | 2026-11-02 | none |\n`;

let root: string;
let repo: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-"));
  repo = path.join(root, "app");
  fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs/cards"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "docs/spines/epic-907.md"), SPINE);
  fs.writeFileSync(path.join(repo, "docs/spines/epic-907.archive.md"), ARCHIVE);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("spine archive paths", () => {
  it("names the archive beside its spine and back", () => {
    expect(archiveRelOf("docs/spines/epic-907.md")).toBe("docs/spines/epic-907.archive.md");
    expect(archiveRelOf("docs/spines/epic-907.archive.md")).toBeUndefined();
    expect(isArchiveRel("docs/spines/epic-907.archive.md")).toBe(true);
    expect(sourceRelOf("docs/spines/epic-907.archive.md")).toBe("docs/spines/epic-907.md");
    expect(sourceRelOf("docs/spines/epic-907.md")).toBe("docs/spines/epic-907.md");
    expect(archiveEpicCode(ARCHIVE)).toBe("EPIC-907");
    expect(archiveEpicCode(SPINE)).toBeUndefined();
    expect(withArchive(repo, "docs/spines/epic-907.md")).toEqual(["docs/spines/epic-907.md", "docs/spines/epic-907.archive.md"]);
    expect(withArchive(repo, "docs/spines/other.md")).toEqual(["docs/spines/other.md"]);
    expect(readArchiveOf(path.join(repo, "docs/spines/epic-907.md"))).toBe(ARCHIVE);
  });
});

describe("a row by id: the ledger first, then the archive", () => {
  it("rowIn reads an archived row by its epic's path", () => {
    expect(rowIn(repo, "docs/spines/epic-907.md", "E907-S1")).toMatchObject({ title: "Old page shipped", status: "done (approved by Sam 2026-11-01)" });
    expect(rowIn(repo, "docs/spines/epic-907.md", "E907-S9")).toMatchObject({ status: "ready" });
    expect(rowIn(repo, "docs/spines/epic-907.md", "E907-S7")).toBeUndefined();
  });

  it("the ledger wins for a row in both (a row brought back)", () => {
    fs.writeFileSync(path.join(repo, "docs/spines/epic-907.md"), SPINE.replace("| E907-S9 |", "| E907-S1 | Ticket worker | run_1 | Old page shipped | review | none | none | 2026-11-23 | go |\n| E907-S9 |"));
    expect(rowIn(repo, "docs/spines/epic-907.md", "E907-S1")?.status).toBe("review");
    const find = createWorkFinder(() => repo, createSpineFileReader(() => repo));
    expect(find("app", "E907-S1")).toMatchObject({ status: "review", path: "docs/spines/epic-907.md" });
  });

  it("a key result's work finds an archived row green, under its own epic; the epic itself is never the archive", () => {
    const find = createWorkFinder(() => repo, createSpineFileReader(() => repo));
    expect(find("app", "E907-S1")).toMatchObject({ kind: "ticket", title: "Old page shipped", status: "done", state: "green", epicCode: "EPIC-907", path: "docs/spines/epic-907.archive.md" });
    expect(find("app", "E907-S2")).toMatchObject({ state: "green", epicCode: "EPIC-907" });
    expect(find("app", "E907-S9")).toMatchObject({ state: "amber", path: "docs/spines/epic-907.md" });
    expect(find("app", "EPIC-907")).toMatchObject({ kind: "epic", title: "Team runs", path: "docs/spines/epic-907.md" });
  });

  it("a desk placement on an archived finished row still reads delivered, and a new one can be placed on it", () => {
    const db = openDb(":memory:");
    migratePlacements(db);
    const pl = createPlacements({ db, reposRoot: root });
    pl.place({ repo: "app", path: "docs/spines/epic-907.md", kind: "row", itemId: "E907-S1" });
    pl.place({ repo: "app", path: "docs/spines/epic-907.md", kind: "row", itemId: "E907-S9" });
    expect(pl.list().map((p) => [p.itemId, p.state])).toEqual([["E907-S1", "delivered"], ["E907-S9", "placed"]]);
    expect(() => pl.place({ repo: "app", path: "docs/spines/epic-907.md", kind: "row", itemId: "E907-S7" })).toThrow(/not in/);
  });

  it("a card of an archived row is found by its epic's spine name", () => {
    const cards = [{ rel: "docs/cards/E907-S1.md", fields: { row: "E907-S1", spine: "epic-907.md" } }] as Parameters<typeof cardFor>[4];
    expect(cardFor(repo, "docs/spines/epic-907.archive.md", "E907-S1", [], cards)?.rel).toBe("docs/cards/E907-S1.md");
    expect(cardFor(repo, "docs/spines/epic-907.md", "E907-S1", [], cards)?.rel).toBe("docs/cards/E907-S1.md");
  });

  it("the epic's Book page still lists what an archived row made", () => {
    const base = { repoDir: repo, repoName: "app", spinePath: "docs/spines/epic-907.md", number: 907, cards: [], fileDates: new Map(), docEntries: [], previews: [], notedPreviews: new Map() };
    const made = (markdown: string) => deliverablesFor({ ...base, markdown } as Parameters<typeof deliverablesFor>[0]).map((d) => d.url);
    expect(made(SPINE)).not.toContain("http://example.test:9000/");
    expect(made(withArchiveText(SPINE, ARCHIVE))).toContain("http://example.test:9000/");
    // older decisions moved to the archive read like the epic's own
    const withDecisions = `${ARCHIVE}\n## Decisions\n\n| Date | Outcome | Decision | Summary | Evidence | Revisit |\n|---|---|---|---|---|---|\n| 2026-10-01 | kept | An old call | why | x | never |\n`;
    expect(parseDecisions(withDecisions).map((d) => d.decision)).toEqual(["An old call"]);
  });
});

describe("a closed card of an archived row still takes his comment", () => {
  const store = { listMilestones: () => [{ id: "ms_1", repo: "Acme/app", path: "docs/spines/epic-907.md" }], listAssignments: () => [], getPersona: () => undefined } as unknown as Store;
  it("writes his words as a Decisions row in the epic's spine", async () => {
    const edits: { path: string; out: string }[] = [];
    const writer = {
      edit: async (e: { repoDir: string; path: string; edit: (t: string, d: string) => { text: string } | { skip: string } }) => {
        const r = e.edit(fs.readFileSync(path.join(e.repoDir, e.path), "utf8"), "2026-11-23");
        if ("skip" in r) return { status: "skipped", reason: r.skip };
        edits.push({ path: e.path, out: r.text });
        return { status: "written", sha: "abc1234" };
      },
    };
    const a = createAfterClose({ store, reposRoot: root, writer: writer as never, who: () => "Sam" });
    const out = await a.comment({ kind: "review", repo: "app", path: "docs/spines/epic-907.md", ref: "E907-S2", text: "this one still matters" });
    expect(out).toMatchObject({ sha: "abc1234" });
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe("docs/spines/epic-907.md");
    expect(edits[0].out).toMatch(/row E907-S2 after he closed it: "this one still matters"/);
    const missing = await a.comment({ kind: "review", repo: "app", path: "docs/spines/epic-907.md", ref: "E907-S7", text: "x" });
    expect(missing).toMatchObject({ error: 404 });
  });
});
