import { describe, expect, it } from "vitest";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { workerMessage } from "../src/cycle/workerLaunch.js";
import { STEPS_PAGE_RULE } from "../src/inbox/asks.js";

/** every new steps page for the owner is made with the kit, by the brief rule. */
describe("steps pages on the kit by default", () => {
  it("the rule names the kit, the three controls, the include and the how-to", () => {
    expect(STEPS_PAGE_RULE).toContain("Steps for Sam go out as a steps page on the steps kit (Done / Stuck / note per step), never a text blob");
    expect(STEPS_PAGE_RULE).toContain("`POST /api/steps/pages` {title, url, repo, spine}");
    expect(STEPS_PAGE_RULE).toContain("`steps-token.js`");
    expect(STEPS_PAGE_RULE).toContain("`/steps-kit.js`");
    expect(STEPS_PAGE_RULE).toContain("data-step=");
    expect(STEPS_PAGE_RULE).toContain("docs/steps-kit.md");
  });

  it("the wake's worker brief carries it verbatim", async () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "archivist" },
    } as never);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain("/api/worker-rules"); // the rules are served, not pasted
    expect((await import("../src/cycle/prompts.js")).workerBriefRules().join("\n")).toContain(STEPS_PAGE_RULE);
  });

  it("a console-launched worker's first message carries it", () => {
    const m = workerMessage({ base: "http://c", runId: "run_2", parentRunId: "run_1", ticket: "E901-S1", brief: "do it" });
    expect(m).toContain(STEPS_PAGE_RULE);
  });
});
