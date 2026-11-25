import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ledgerLines } from "../src/review/rows.js";
import { createWorkFinder } from "../src/scorecards.js";
import { setTicketIndex, ticketIndex } from "../src/tickets/ticketIndex.js";

// a goal's rows are looked up again only when a file that holds their code changed (text or index blob).
const LEDGER = (rows: string[]) => `## Issue Ledger\n\n| ID | Owner | Task | Status |\n|---|---|---|---|\n${rows.join("\n")}\n`;

describe("the work finder keeps the answers a change did not touch", () => {
  const before = ticketIndex();
  afterEach(() => {
    setTicketIndex(before);
    vi.restoreAllMocks();
  });

  it("an edit to one spine looks up only the codes that spine holds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-finder-"));
    const files: Record<string, string> = {
      "docs/spines/a.md": `# EPIC-901: A\n\n${LEDGER(["| E901-S1 | w | One | ready |"])}`,
      "docs/spines/b.md": `# EPIC-902: B\n\n${LEDGER(["| E902-S1 | w | Two | ready |"])}`,
    };
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    for (const k of Object.keys(files)) fs.writeFileSync(path.join(dir, k), files[k]);
    const blobs: Record<string, string> = { "docs/spines/a.md": "a1", "docs/spines/b.md": "b1" };
    let version = 0;
    setTicketIndex({
      lines: () => [],
      holds: () => true,
      refresh: async () => {},
      version: () => String(version),
      blob: (abs) => blobs[path.relative(dir, abs)] ?? "",
      tickets: () => [],
      stats: () => undefined,
    });
    const rowReads: string[] = [];
    const read = Object.assign((_repo: string, rel: string) => files[rel], {
      rows: (_repo: string, rel: string) => (rowReads.push(rel), ledgerLines(files[rel] ?? "")),
    });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const find = createWorkFinder(() => dir, read);
    expect(find("app", "E901-S1")).toMatchObject({ status: "ready" });
    expect(find("app", "E902-S1")).toMatchObject({ status: "ready" });
    expect(rowReads).toEqual(["docs/spines/a.md", "docs/spines/b.md"]);

    // b changes (text and blob), the index is rebuilt: a's answer is kept, b's is read again
    files["docs/spines/b.md"] = files["docs/spines/b.md"].replace("| Two | ready |", "| Two | review |");
    blobs["docs/spines/b.md"] = "b2";
    version++;
    now += 2_000;
    rowReads.length = 0;
    expect(find("app", "E901-S1")).toMatchObject({ status: "ready" });
    expect(find("app", "E902-S1")).toMatchObject({ status: "review" });
    expect(rowReads).toEqual(["docs/spines/b.md"]);

    // only a's blob moves (its rows rebuilt while its text is the same): a is read again
    blobs["docs/spines/a.md"] = "a2";
    now += 2_000;
    rowReads.length = 0;
    find("app", "E901-S1");
    find("app", "E902-S1");
    expect(rowReads).toEqual(["docs/spines/a.md"]);

    // a new spine that names E901-S1 drops its answer (the first file in list order still wins)
    files["docs/spines/c.md"] = `# EPIC-903: C\n\nSee E901-S1.\n`;
    fs.writeFileSync(path.join(dir, "docs/spines/c.md"), files["docs/spines/c.md"]);
    blobs["docs/spines/c.md"] = "c1";
    now += 2_000;
    rowReads.length = 0;
    expect(find("app", "E901-S1")).toMatchObject({ status: "ready" });
    find("app", "E902-S1");
    expect(rowReads).toEqual(["docs/spines/a.md"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
