import { describe, expect, it } from "vitest";
import { turnStart } from "../src/desk/session.js";

// the desk chat's working timer counts from the turn's server-side start (T3's run), so a reload shows the true elapsed.
describe("T49-S1 turnStart", () => {
  it("is the active run's startedAt while the thread works", () => {
    expect(
      turnStart({
        status: "running",
        activeRunId: "r2",
        runs: [
          { runId: "r2", status: "running", requestedAt: "2026-11-01T10:00:00Z", startedAt: "2026-11-01T10:00:02Z", completedAt: null },
          { runId: "r1", status: "completed", requestedAt: "2026-11-01T09:00:00Z", startedAt: "2026-11-01T09:00:01Z", completedAt: "2026-11-01T09:05:00Z" },
        ],
      }),
    ).toBe("2026-11-01T10:00:02Z");
  });

  it("falls back to the newest unfinished run, and to requestedAt before the run started", () => {
    expect(
      turnStart({
        status: "queued",
        runs: [
          { status: "completed", requestedAt: "2026-11-01T09:00:00Z", completedAt: "2026-11-01T09:05:00Z" },
          { status: "queued", requestedAt: "2026-11-01T10:00:00Z", completedAt: null },
        ],
      }),
    ).toBe("2026-11-01T10:00:00Z");
  });

  it("is undefined when idle or when T3 sent no runs", () => {
    expect(turnStart({ status: "idle", runs: [{ status: "completed", startedAt: "2026-11-01T09:00:00Z", completedAt: "x" }] })).toBeUndefined();
    expect(turnStart({ status: "running" })).toBeUndefined();
  });
});
