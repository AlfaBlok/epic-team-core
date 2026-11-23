// @vitest-environment jsdom
// History and Pages show every file homed there (the owner's ask).
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { HomeEntry } from "@/api/pages-types";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { HomeFilesList } from "@/components/wheelPages";
import { historyFilesOf } from "@/pages/social/History";
import { indexScorecards } from "@/lib/scorecards";
import { homeFilesOf, homeFileUrl, placeHomeFiles } from "@/lib/wheelPages";

const node = (id: string, spines: string[]): ScorecardNode => ({ id, kind: "pursuit", name: id, greens: 0, total: 0, spines, rows: [], children: [] }) as unknown as ScorecardNode;
const SETS = {
  nodes: [node("understand", ["home-repo:docs/spines/epic-907.md"]), node("testers", ["social-repo:docs/spines/recruit-testers.md"])],
  spineInfo: {
    "home-repo:docs/spines/epic-907.md": { repo: "home-repo", path: "docs/spines/epic-907.md", code: "EPIC-907", codes: ["E907-S3", "E907-S9"] },
    "social-repo:docs/spines/recruit-testers.md": { repo: "social-repo", path: "docs/spines/recruit-testers.md", code: "EPIC-908", codes: ["E907-S8"] },
  },
} as unknown as ScorecardsBody;

const e = (open: string, more: Partial<HomeEntry> = {}): HomeEntry => ({ id: `home-repo:${open}`, repo: "home-repo", path: open, open, title: open, kind: "note", files: 1, ...more });
const ENTRIES: HomeEntry[] = [
  e("docs/status/e907-s3/proof.html", { kind: "page", row: "E907-S3", date: "2026-11-23T01:00:00Z", title: "Every write has a home" }),
  e("docs/status/2026-11-18-what-runs.md", { row: "E907-S7", date: "2026-11-18T00:00:00Z" }),
  e("docs/status/advisor/", { kind: "folder", date: "2026-11-11T00:00:00Z" }),
];

describe("homed files on the objective's Pages tab", () => {
  const ix = indexScorecards(SETS);
  it("an objective shows the files its rows made; the rest are named as on none", () => {
    expect(homeFilesOf(ENTRIES, ix, "understand").map((x) => x.open)).toEqual(["docs/status/e907-s3/proof.html"]);
    const { by, notPlaced } = placeHomeFiles(ENTRIES, ix);
    expect(by.get("understand")?.length).toBe(1);
    // nothing is lost: placed plus not placed is every entry.
    expect([...by.values()].flat().length + notPlaced.length).toBe(ENTRIES.length);
  });
  it("a weekly log goes by its spine", () => {
    const log: HomeEntry = { ...e("docs/log/recruit-testers/2026-W47.md"), repo: "social-repo", spine: "docs/spines/recruit-testers.md" };
    expect(homeFilesOf([log], ix, "testers")).toHaveLength(1);
  });
  it("a file whose spine no tree holds goes to the objective the console stamped on it", () => {
    const older: HomeEntry[] = [e("docs/status/e907-s3b/", { kind: "folder", row: "E907-S4", objective: "understand", placedBy: "epic" }), e("docs/status/gap-finder/a.md", { objective: "nope" })];
    const { by, notPlaced } = placeHomeFiles(older, ix);
    expect(by.get("understand")?.map((x) => x.open)).toEqual(["docs/status/e907-s3b/"]);
    expect(notPlaced.map((x) => x.open)).toEqual(["docs/status/gap-finder/a.md"]);
    expect(homeFilesOf(older, ix, "understand")).toHaveLength(1);
    // a file in a tree stays where the tree puts it, whatever it is stamped with.
    expect(homeFilesOf([{ ...ENTRIES[0], objective: "testers" }], ix, "testers")).toHaveLength(0);
  });
  it("opens read-only through the console", () => {
    expect(homeFileUrl({ repo: "home-repo", open: "docs/status/advisor/" })).toBe("/api/homes/file/home-repo/docs/status/advisor/");
    expect(homeFileUrl({ repo: "home-repo", open: "docs/status/a b.md" })).toBe("/api/homes/file/home-repo/docs/status/a%20b.md");
  });
  it("lists every entry newest first, each a link that opens it", () => {
    render(
      <MemoryRouter>
        <HomeFilesList entries={ENTRIES} title="Pages and notes kept in the repo" empty="none" testId="t" />
      </MemoryRouter>,
    );
    const rows = screen.getAllByTestId("t-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Every write has a home");
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("/api/homes/file/home-repo/docs/status/e907-s3/proof.html");
    expect(screen.getByTestId("t").getAttribute("data-count")).toBe("3");
  });
});

describe("homed files on a campaign's History", () => {
  const logs: HomeEntry[] = [
    { ...e("docs/log/recruit-testers/2026-W47.md"), repo: "social-repo", spine: "docs/spines/recruit-testers.md" },
    { ...e("docs/log/root/2026-W47.md"), repo: "social-repo", spine: "docs/spines/root.md" },
    { ...e("docs/outcomes/2026-11-22.jsonl"), repo: "social-repo" },
    { ...e("docs/log/x-awareness/2026-W47.md"), repo: "social-repo", spine: "docs/spines/x-awareness.md" },
    { ...e("docs/log/root/2026-W47.md"), repo: "other-repo", spine: "docs/spines/root.md" },
  ];
  it("a campaign shows its own logs first and every other file of its repo after, never another repo's", () => {
    const { own, rest } = historyFilesOf(logs, "acme/social-repo", "docs/spines/recruit-testers.md");
    expect(own.map((x) => x.open)).toEqual(["docs/log/recruit-testers/2026-W47.md"]);
    expect(rest.map((x) => x.open)).toEqual(["docs/log/root/2026-W47.md", "docs/outcomes/2026-11-22.jsonl", "docs/log/x-awareness/2026-W47.md"]);
  });
  it("the repo's History with no campaign shows every one of its files", () => {
    expect(historyFilesOf(logs, "social-repo", undefined).own).toHaveLength(4);
  });
});
