import { describe, expect, it } from "vitest";
import { deskInboxSection, FULL_NOTES_MAX, type DeskNote } from "../src/desk/inbox.js";
import { childLines } from "../src/wakePrompt.js";

/**
 * smaller wakes: the home Delivery Manager's wake was
 * 235,050 characters on 20 Nov, 131,080 of them its 136 open desk notes in full. The wake now carries a few notes in
 * full, one line for the next ones and a count with the command that lists the rest.
 */
const note = (i: number, extra: Partial<DeskNote> = {}): DeskNote => ({
  file: `desk/inbox/2026-11-${String(10 + (i % 10)).padStart(2, "0")}-w-note-${String(i).padStart(3, "0")}.md`,
  from: "social",
  about: `Note ${i}: something the other world asked about, in one plain line of about eighty characters`,
  replyTo: "acme/social",
  status: "open",
  body: "A paragraph of the note's body. ".repeat(60),
  ...extra,
} as DeskNote);

describe("the desk inbox in a wake stays small", () => {
  it("136 open notes fit in under 12,000 characters, urgent first, the rest counted with the list command", () => {
    const notes = Array.from({ length: 136 }, (_, i) => note(i, i === 90 ? { urgent: true } : {}));
    const s = deskInboxSection(notes, "home_repo")!;
    expect(s.length).toBeLessThan(12_000);
    expect(s).toContain("## Desk inbox (136 open notes from other worlds)");
    const first = s.indexOf("- **URGENT** ");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(s.indexOf("note-000.md"));
    expect((s.match(/\n  > /g) ?? []).length).toBeGreaterThan(0);
    expect(s).toMatch(/…and \d+ more open notes: `python3 <[^>]+ checkout>\/scripts\/desk_note\.py list <this checkout>`/);
  });
  it("a few notes are all shown in full", () => {
    const s = deskInboxSection([note(1), note(2)], "home_repo")!;
    expect(s).not.toContain("more open note");
    expect(s.split("\n  > ").length).toBeGreaterThan(2);
    expect(FULL_NOTES_MAX).toBeGreaterThanOrEqual(2);
  });
});

describe("finished child epics are one line", () => {
  it("lists live children and counts finished ones", () => {
    const c = (path: string, status: string, runState: string) => ({ path, title: path, status, runState }) as never;
    const lines = childLines([c("docs/spines/a.md", "active", "running"), c("docs/spines/b.md", "done", "finished"), c("docs/spines/c.md", "superseded", "finished")]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("docs/spines/a.md");
    expect(lines[1]).toBe("- 2 finished children (b, c): skip: finished");
  });
});
