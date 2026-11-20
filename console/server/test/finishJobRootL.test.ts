import { describe, expect, it } from "vitest";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { FINISH_THE_JOB_RULE, unblockerRules } from "../src/inbox/asks.js";
import { buildWakePrompt } from "../src/wakePrompt.js";

/** finish the job; a turn never ends offering follow-ups. */
const persona = { name: "Delivery Manager", remit: "Run E4.", skills: [], mayWrite: false };
const milestone = { title: "E4", repo: "Acme/poly-maker", path: "docs/E4.md", owner: "" };

describe("T8-S10 finish the job (root L-16)", () => {
  it("the rule says yes to green/defect/cleanup, no to unrequested nice-to-haves, and keeps ask-tier items as asks", () => {
    expect(FINISH_THE_JOB_RULE).toContain("never end a turn offering follow-ups");
    expect(FINISH_THE_JOB_RULE).toContain("move the goal toward green");
    expect(FINISH_THE_JOB_RULE).toContain("close a known defect");
    expect(FINISH_THE_JOB_RULE).toContain("complete or clean up the work just done");
    expect(FINISH_THE_JOB_RULE).toContain("nice-to-have that unblocks nothing gets one line and is dropped");
    expect(FINISH_THE_JOB_RULE).toContain("ask-tier items stay asks");
  });

  it("every worker brief carries it verbatim, next to the finish and tier rules", async () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "archivist" },
    } as never);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain("verbatim, the worker rules"); // served at /api/worker-rules, not pasted into the wake
    expect(brief).toContain("/api/worker-rules");
    expect((await import("../src/cycle/prompts.js")).workerBriefRules()).toContain(FINISH_THE_JOB_RULE);
  });

  it("the wake's closing step finishes what the wake started before the PATCH", () => {
    const p = buildWakePrompt(persona, milestone);
    const wake = p.slice(p.indexOf("## This wake"), p.indexOf("## Spine state and closing"));
    expect(wake).toContain(`3. Before you PATCH, finish what this wake started: ${FINISH_THE_JOB_RULE}`);
    expect(wake).toContain("4. Finish with one line: `outcome: progressed");
  });

  it("the Unblocker answers an end-of-turn offer by L-16", () => {
    const u = unblockerRules("http://c", "ms_1", "asg_dm").join("\n");
    expect(u).toContain("An ask that is really an end-of-turn offer");
    expect(u).toContain("is answered by root L-16: ANSWER yes with what to do");
    expect(u).toContain("else no, with one line why");
  });
});
