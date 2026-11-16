// a key result read live is stamped with the time it was measured, so the screen can show it and grey a stale one.
import { describe, expect, it } from "vitest";
import { applyLiveKeyResults, registerLiveKeyResult, type ScorecardNode, type ScorecardRow } from "../src/scorecards.js";

describe("measuredAt on live key results", () => {
  it("stamps a live read with now and keeps the file's stamp when the read fails", async () => {
    registerLiveKeyResult("e40s55-ok", async () => ({ value: "1 of 5", state: "red" }));
    registerLiveKeyResult("e40s55-down", async () => {
      throw new Error("down");
    });
    const ok: ScorecardRow = { label: "testers", kind: "key-result", state: "unknown", value: "2 of 5", live: { kind: "e40s55-ok" } };
    const down: ScorecardRow = { label: "visits", kind: "key-result", state: "amber", value: "23", live: { kind: "e40s55-down" }, measuredAt: "2026-11-12T18:10Z" };
    const node = { id: "s", kind: "pursuit", name: "s", children: [], rows: [], keyResults: [ok, down] } as unknown as ScorecardNode;
    const before = Date.now();
    await applyLiveKeyResults({ nodes: [node] });
    expect(ok.value).toBe("1 of 5");
    expect(Date.parse(ok.measuredAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(down.measuredAt).toBe("2026-11-12T18:10Z");
  });
});
