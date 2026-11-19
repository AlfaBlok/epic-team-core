import { describe, expect, it } from "vitest";
import { failedWakesAction, failedWakesQuestion, openFailedWakesAsk, wakeStreak } from "../src/cycle/failedWakes.js";
import { askLine } from "../src/inbox/raise.js";
import type { Run } from "../src/store.js";

/** 3 failed wakes in a row of one persona = one inbox card; the next wake that works takes it out. */
let i = 0;
const run = (outcome: Run["outcome"], extra: Partial<Run> = {}): Run =>
  ({ id: `r${++i}`, assignmentId: "a", kind: "wake", outcome, summary: outcome === "failed" ? "T3 turn failed (Provider error: Insufficient context allowance)" : "ok", startedAt: `2026-11-19T0${i % 10}:00:00.000Z`, endedAt: "2026-11-19T10:00:00Z", ...extra }) as Run;

describe("wakeStreak", () => {
  it("three failed wakes in a row (newest first) are a streak; two are not", () => {
    expect(wakeStreak([run("failed"), run("failed"), run("progressed")])).toBeUndefined();
    const s = wakeStreak([run("failed"), run("failed"), run("failed"), run("progressed")]);
    expect(s?.state).toBe("failed");
    expect(s && s.state === "failed" && s.runs).toHaveLength(3);
  });
  it("skips, deferred, stopped, running and child runs do not break or count", () => {
    const s = wakeStreak([
      run("failed"),
      run("idle", { summary: "skipped: nothing new since r0 (x)" }),
      run("deferred"),
      run("running", { endedAt: undefined }),
      run("progressed", { parentRunId: "p" }),
      run("failed"),
      run("stopped"),
      run("failed"),
    ]);
    expect(s?.state).toBe("failed");
  });
  it("a newest wake that worked is ok (the card comes out)", () => {
    expect(wakeStreak([run("monitoring"), run("failed"), run("failed"), run("failed")])).toEqual({ state: "ok" });
  });
});

describe("the card", () => {
  it("is a stable question found again in the spine once raised, the error in its recommend", () => {
    const q = failedWakesQuestion("Delivery Manager", "Team unattended");
    expect(q).toBe(failedWakesQuestion("Delivery Manager", "Team unattended"));
    const runs = [run("failed"), run("failed"), run("failed")];
    const line = askLine("E907-A1", { question: q, proposedAction: failedWakesAction(runs), askedBy: "the console's failed-wakes watch", kind: "decide" }, "2026-11-19");
    expect(line).toContain("Insufficient context allowance");
    const spine = `# E907: x\n\n## Waiting on\n\n${line}\n`;
    expect(openFailedWakesAsk(spine, q)).toBe("E907-A1");
    expect(openFailedWakesAsk(spine, failedWakesQuestion("Writer", "Team unattended"))).toBeUndefined();
  });
});
