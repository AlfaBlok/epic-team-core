// @vitest-environment jsdom
// each key result says when it was measured; one older than a day, or never measured, is greyed as stale.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ScorecardRow } from "@/api/pursuit-types";
import { KeyResultSheet, krAnswer, krMeasured } from "@/components/goalSets";

afterEach(cleanup);
const NOW = Date.parse("2026-11-16T06:00:00Z");

describe("krMeasured", () => {
  it("a row its check reads is measured, never 'nothing measures this yet'", () => {
    const m = krMeasured({ source: "scripts/kr_measures.py" });
    expect(m.never).toBe(false);
    expect(m.stale).toBe(false);
    expect(m.words).toContain("read by scripts/kr_measures.py");
  });
  it("names the hours since its measure and stays fresh inside a day", () => {
    expect(krMeasured({ measuredAt: "2026-11-16T03:00:00Z" }, NOW)).toEqual({ words: "measured 3 h ago", stale: false, never: false });
  });
  it("is stale past a day", () => {
    const m = krMeasured({ measuredAt: "2026-11-13T18:10:00Z" }, NOW);
    expect(m.stale).toBe(true);
    expect(m.words).toBe("stale: measured 2 days ago");
  });
  it("says nothing measures it when it has no stamp", () => {
    expect(krMeasured({}, NOW)).toEqual({ words: "nothing measures this yet", stale: true, never: true });
  });
});

describe("KeyResultSheet stale rows", () => {
  it("greys a stale key result and counts it", () => {
    const fresh = new Date(Date.now() - 3600_000).toISOString();
    const krs: ScorecardRow[] = [
      { label: "Call is out", kind: "key-result", state: "green", value: "out on both", measuredAt: fresh },
      { label: "Each tester gets a reply", kind: "key-result", state: "unknown", value: "I don't know" },
    ];
    render(<KeyResultSheet krs={krs} setId="set-1" />);
    const items = screen.getAllByTestId("kr-item");
    expect(items[0].getAttribute("data-stale")).toBe("0");
    expect(items[1].getAttribute("data-stale")).toBe("1");
    expect(items[1].className).toMatch(/grayscale/);
    expect(screen.getByTestId("kr-summary").textContent).toMatch(/1 stale, greyed/);
    expect(screen.getAllByTestId("kr-measured").map((e) => e.textContent)).toContain("nothing measures this yet");
  });
});

describe("krAnswer counts a ready ticket as work", () => {
  it("a key result with a ready row is not 'nothing working on it'", () => {
    const r = { label: "A home", kind: "key-result", state: "red", value: "0", work: [{ code: "E907-S3", repo: "home", kind: "ticket", status: "ready" }] } as ScorecardRow;
    expect(krAnswer([r])).not.toContain("nothing working");
    expect(krAnswer([{ ...r, work: [] }])).toContain("nothing working on it");
  });
});
