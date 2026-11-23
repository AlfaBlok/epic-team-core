import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { personaRows, standingRow, standingRowSection, withRow } from "../src/status/personaRows.js";
import { namesTicket } from "../src/status/orphanCommits.js";
import { checkPost } from "../src/inbox/teamCards.js";

// every persona commit names its row.
function home(catalog: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-rows-"));
  fs.mkdirSync(path.join(dir, "docs/functions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/functions/catalog.json"), JSON.stringify(catalog));
  return dir;
}

const CAT = {
  functions: [
    { id: "console-speed", lives: [{ kind: "persona", name: "Performance", row: "E907-S3" }, { kind: "timer", host: "host1", name: "x" }] },
    { id: "wheel-turns", lives: [{ kind: "persona", name: "Delivery Manager", row: "milestone" }] },
    { id: "unblock", lives: [{ kind: "persona", name: "Unblocker" }] },
  ],
};

describe("standing rows from the catalog", () => {
  it("reads each persona's row; milestone and missing give none", () => {
    const dir = home(CAT);
    expect(personaRows(dir).get("performance")).toBe("E907-S3");
    expect(standingRow(dir, "Performance")).toBe("E907-S3");
    expect(standingRow(dir, "Delivery Manager")).toBeUndefined();
    expect(standingRow(dir, "Unblocker")).toBeUndefined();
    expect(standingRow(undefined, "Performance")).toBeUndefined();
    expect(standingRow("/nonexistent", "Performance")).toBeUndefined();
  });
});

describe("withRow", () => {
  it("puts the row in front of a message that names none, so the orphan list stays empty", () => {
    const msg = "Performance: digest card for the owner's inbox: House: Buy a house: 1 of 3 key results are green";
    expect(namesTicket({ author: "Sam", message: msg })).toBe(false);
    const named = withRow(msg, "E907-S3");
    expect(named).toBe(`E907-S3 ${msg}`);
    expect(namesTicket({ author: "Sam", message: named })).toBe(true);
  });
  it("leaves a message that already names a row or a spine path, or when no row is known", () => {
    expect(withRow("E907-S4 Prioritizer daily wake", "E907-S3")).toBe("E907-S4 Prioritizer daily wake");
    expect(withRow("Monitoring line of docs/spines/root.md", "E907-S3")).toBe("Monitoring line of docs/spines/root.md");
    expect(withRow("The owner answered the digest card tc_1", undefined)).toBe("The owner answered the digest card tc_1");
  });
});

describe("the wake prompt's line", () => {
  it("names the standing row, or the milestone's spine for a per-milestone persona", () => {
    expect(standingRowSection("Performance", "E907-S3", "docs/spines/root.md")).toContain("Your standing row is E907-S3");
    const dm = standingRowSection("Delivery Manager", undefined, "docs/spines/epic-907.md");
    expect(dm).toContain("`docs/spines/epic-907.md`");
    expect(dm).toContain("## Every commit names its row");
  });
});

describe("a team card carries its row", () => {
  const digest = { kind: "digest", by: "Performance", title: "t", scorecard: "buy-house", digest: { greens: 1, total: 3, trend: "first", reasons: [{ text: "r" }] } };
  it("keeps a valid row the persona posts", () => {
    const c = checkPost({ ...digest, row: "E907-S3" });
    expect(c.ok && c.card.row).toBe("E907-S3");
  });
  it("drops a row that is not a row code", () => {
    const c = checkPost({ ...digest, row: "rm -rf" });
    expect(c.ok && c.card.row).toBeUndefined();
  });
});
