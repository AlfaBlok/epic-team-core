// the screens' ticket rows come from the ticket index (scripts/ticket_index.py), mounted read-only. Built for
// real here: the index must hold exactly the rows the console's own parse (ledgerLines) reads, file by file, and follow
// a new commit. TICKET_INDEX_PARITY_DB=<a built index.db> also compares every file of every checkout it holds.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerLines } from "../src/review/rows.js";
import { createTicketIndex, refSha } from "../src/tickets/ticketIndex.js";

const SCRIPT = path.resolve(__dirname, "../../../../scripts/ticket_index.py");
const git = (d: string, ...a: string[]) =>
  execFileSync("git", ["-C", d, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

const SPINE = [
  "# EPIC-907: Fixture",
  "",
  "## Issue Ledger",
  "",
  "| Issue | Owner | Title | Status | Latest Evidence | Next Action |",
  "|---|---|---|---|---|---|",
  "| E907-S1 | run_abc1234 | Build **it** [page](http://example.com/p) | review (card) | [live](http://example.com/live) | worker |",
  "| [E907-S2](../x.md) | — | A \\| pipe in a cell | ready | — | — |",
  "| E907-S3 | — | Done one | done (approved by Sam 2026-11-24) | — | — |",
  "",
  "### Sub heading stays in the ledger",
  "",
  "| ID | Owner | Task | State |",
  "|---|---|---|---|",
  "| E907-S4 | w | Under a sub heading | blocked |",
  "",
  "```",
  "| E907-S5 | w | In a fence | ready |",
  "```",
  "",
  "## Decisions",
  "",
  "| Date | By | What | Status |",
  "|---|---|---|---|",
  "| 2026-11-24 | x | Not a ledger | done |",
  "",
  "## Backlog",
  "",
  "| Row | Title | Status |",
  "| :--- | --- | --- |",
  "| E907-S6 | Spaces | queued |",
  "",
].join("\n");

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-index-"));
  const repo = path.join(tmp, "app");
  fs.mkdirSync(path.join(repo, "docs", "spines"), { recursive: true });
  git(tmp, "init", "-q", "-b", "main", repo);
  fs.writeFileSync(path.join(repo, "docs", "spines", "epic-907.md"), SPINE);
  fs.writeFileSync(path.join(repo, "EPIC.md"), "# EPIC-901: Root\n\n## Child epics\n\n| ID | Title | Status |\n|---|---|---|\n| EPIC-907 | [Fixture](docs/spines/epic-907.md) | active |\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "one");
  const db = path.join(tmp, "index.db");
  const build = () => execFileSync("python3", [SCRIPT, "build", "--dir", repo], { env: { ...process.env, TICKET_INDEX_DB: db, TICKET_INDEX_PAGE: path.join(tmp, "page") }, encoding: "utf8" });
  return { tmp, repo, db, build };
}

const plain = (rows: ReturnType<typeof ledgerLines>) => rows.map((r) => ({ line: r.line, id: r.id, cells: r.cells, headers: r.headers, col: r.col }));

// the builder lives beside the console in the team repo (a core-only checkout has none)
describe.skipIf(!fs.existsSync(SCRIPT))("the ticket index, mounted read-only", () => {
  it("holds exactly the rows the console's own parse reads, file by file", () => {
    const f = fixture();
    f.build();
    const index = createTicketIndex({ file: f.db, script: SCRIPT });
    for (const rel of ["docs/spines/epic-907.md", "EPIC.md"]) {
      const abs = path.join(f.repo, rel);
      expect(plain(index.lines(abs))).toEqual(plain(ledgerLines(fs.readFileSync(abs, "utf8"))));
    }
    expect(index.lines(path.join(f.repo, "docs/spines/epic-907.md")).map((r) => r.id)).toEqual(["E907-S1", "E907-S2", "E907-S3", "E907-S4", "E907-S6"]);
    expect(index.stats()?.lines).toBe(6);
  });

  it("follows a new commit: a row moved to review reads so once the index is rebuilt", async () => {
    const f = fixture();
    f.build();
    const index = createTicketIndex({ file: f.db, script: SCRIPT, freshMs: 0 });
    const abs = path.join(f.repo, "docs/spines/epic-907.md");
    const status = () => {
      const r = index.lines(abs).find((x) => x.id === "E907-S2")!;
      return r.cells[r.col.status];
    };
    expect(status()).toBe("ready");
    fs.writeFileSync(abs, SPINE.replace("| A \\| pipe in a cell | ready |", "| A \\| pipe in a cell | review (card) |"));
    git(f.repo, "commit", "-qam", "two");
    await index.refresh(f.repo);
    expect(status()).toBe("review (card)");
    expect(index.version()).toMatch(/:/);
  });

  it("reads the commit a ref names from the files under .git, loose or packed", () => {
    const f = fixture();
    const head = git(f.repo, "rev-parse", "HEAD").trim();
    expect(refSha(f.repo, "HEAD")).toBe(head);
    git(f.repo, "pack-refs", "--all");
    expect(refSha(f.repo, "HEAD")).toBe(head);
    expect(refSha(f.repo, "main")).toBe(head);
  });

  it("answers GET /api/tickets' query from the tickets table", () => {
    const f = fixture();
    f.build();
    const w = new Database(f.db);
    const ins = w.prepare("INSERT INTO tickets (repo, id, world, epic, spine, title, state, status, owner, dispatched, kr, his_words, made, last_moved) VALUES (?, ?, 'home', 'EPIC-907', 'docs/spines/epic-907.md', ?, ?, ?, '', 0, '[\"k1\"]', '[]', '2026-11-24T10:00Z', '2026-11-24T10:00Z')");
    ins.run("app", "E907-S1", "Build it", "review", "review (card)");
    ins.run("app", "E907-S3", "Done one", "done", "done");
    w.close();
    const index = createTicketIndex({ file: f.db, script: SCRIPT });
    expect(index.tickets().map((t) => t.id)).toEqual(["E907-S1", "E907-S3"]);
    expect(index.tickets({ open: true }).map((t) => [t.id, t.kr])).toEqual([["E907-S1", ["k1"]]]);
    expect(index.tickets({ state: "done" }).map((t) => t.id)).toEqual(["E907-S3"]);
  });

  it("is empty, never a crash, while no index file exists", () => {
    const index = createTicketIndex({ file: path.join(os.tmpdir(), "no-such-index.db"), script: "/nonexistent.py" });
    expect(index.lines("/nowhere/docs/x.md")).toEqual([]);
    expect(index.tickets()).toEqual([]);
    expect(index.stats()).toBeUndefined();
  });

  const parityDb = process.env.TICKET_INDEX_PARITY_DB;
  it.skipIf(!parityDb)("every file of a real index reads the same as the console's parse (TICKET_INDEX_PARITY_DB)", () => {
    const d = new Database(parityDb!, { readonly: true });
    const files = d.prepare("SELECT dir, path, blob FROM ledger_files").all() as { dir: string; path: string; blob: string }[];
    const q = d.prepare("SELECT line, id, cells, headers FROM ledger WHERE dir = ? AND path = ? ORDER BY line");
    const bad: string[] = [];
    for (const f of files) {
      const text = execFileSync("git", ["-C", f.dir, "cat-file", "-p", f.blob], { encoding: "utf8", maxBuffer: 1 << 28 });
      const a = JSON.stringify(ledgerLines(text).map((r) => [r.line, r.id, r.cells, r.headers]));
      const b = JSON.stringify((q.all(f.dir, f.path) as { line: number; id: string; cells: string; headers: string }[]).map((r) => [r.line, r.id, JSON.parse(r.cells), JSON.parse(r.headers)]));
      if (a !== b) bad.push(`${f.dir}:${f.path}`);
    }
    expect(bad).toEqual([]);
  }, 900_000);
});
