import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_OFFS_SPINE, readOneOffs, stageOf } from "../src/oneOffs.js";

/** One-offs are rows titled `One-off:` anywhere, plus every row of the One-offs spine, by lifecycle stage. */

const HEAD = "| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |\n|---|---|---|---|---|---|---|---|---|---|---|\n";
const row = (id: string, owner: string, title: string, status: string, date: string, next = "worker") => `| ${id} | Ticket worker | ${owner} | ${title} | ${status} | none | none | main | none | ${date} | ${next} |\n`;
const spine = (h1: string, rows: string) => `# ${h1}\n\n## Issue Ledger\n\n${HEAD}${rows}\n## Decisions\n`;

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneoffs-"));
  fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs/cards"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "docs/spines/epic-938-airbnb.md"),
    spine(
      "EPIC-938: Airbnb acts",
      row("E938-S9", "unassigned", "Message a host from the server", "ready", "2026-11-12") +
        row("E938-S10", "run_4fbd3186-5e48-492f-9224-10a15b916e67 — claimed 2026-11-12T20:21Z, lease until 2026-11-12T22:21Z", "One-off: Airbnb glass dispute, two notes: Write both notes from his voice note (memory Log/2026-11-12.md#^e-5bc524).", "ready", "2026-11-12"),
    ),
  );
  fs.writeFileSync(
    path.join(dir, ONE_OFFS_SPINE),
    spine(
      "EPIC-903: One-offs",
      row("E903-S1", "unassigned", "Renew the passport photo: book a slot", "review", "2026-11-12") +
        row("E903-S2", "unassigned", "Old errand", "done (approved by Sam 2026-10-01)", "2026-10-01") +
        row("E903-S3", "unassigned", "Fresh errand", "done (approved by Sam 2026-11-11)", "2026-11-11") +
        row("E903-S4", "built through E940-S21", "E903-1: every one-off lands on the page", "active", "2026-11-12") +
        row("E903-S5", "unassigned", "Same job twice", "done (folded into E903-S1)", "2026-11-12"),
    ),
  );
  fs.writeFileSync(path.join(dir, "docs/cards/E903-S1.md"), "---\nrow: E903-S1\ntitle: The passport photo slot was booked for Friday.\nevidence: https://example.com/slot\n---\n");
  return dir;
}

describe("one-offs", () => {
  it("reads One-off rows from any epic and every row of the One-offs spine, with stage, epic, card and his note", () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, "docs/voice-notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/voice-notes/index.json"), JSON.stringify({ notes: [{ url: "https://github.com/acme/brain/blob/main/Log/2026-11-12.md" }] }));
    const b = readOneOffs(dir, "app", new Date("2026-11-12T21:00:00Z"));
    expect(b.oneOffs.map((o) => o.id)).toEqual(["E903-S1", "E938-S10", "E903-S3"]);
    const [card, glass, fresh] = b.oneOffs;
    expect(card.stage).toBe("your card");
    expect(card.card).toMatchObject({ title: "The passport photo slot was booked for Friday." });
    expect(card.name).toBe("Renew the passport photo");
    expect(glass).toMatchObject({ stage: "in work", name: "Airbnb glass dispute, two notes", holder: "run_4fbd3186-5e48-492f-9224-10a15b916e67" });
    expect(glass.epic).toMatchObject({ code: "EPIC-938", title: "Airbnb acts", path: "docs/spines/epic-938-airbnb.md" });
    expect(glass.source).toEqual({ ref: "Log/2026-11-12.md#^e-5bc524", url: "https://github.com/acme/brain/blob/main/Log/2026-11-12.md#%5Ee-5bc524" });
    expect(fresh.stage).toBe("delivered");
    // E938-S9 is no one-off; E903-S2 closed over a week ago dropped off; E903-S4 builds the spine itself (titled with
    // its Done-means id) and E903-S5 was folded into another row, so neither shows.
    expect(b.counts).toMatchObject({ "your card": 1, "in work": 1, delivered: 1, filed: 0 });
  });

  it("names each stage from the status cell and the claim", () => {
    expect(stageOf("ready", "unassigned")).toBe("filed");
    expect(stageOf("ready", "run_x — claimed 2026-11-12T20:21Z")).toBe("in work");
    expect(stageOf("active", "")).toBe("in work");
    expect(stageOf("blocked (E901-A2)", "")).toBe("stuck");
    expect(stageOf("review", "")).toBe("your card");
    expect(stageOf("done (approved by Sam)", "")).toBe("delivered");
    expect(stageOf("parked", "")).toBe("parked");
  });

  it("an empty repo has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneoffs-empty-"));
    expect(readOneOffs(dir, "x").oneOffs).toEqual([]);
  });
});
