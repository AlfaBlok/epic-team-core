import { describe, expect, it } from "vitest";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { workerMessage } from "../src/cycle/workerLaunch.js";
import { VISUAL_FIRST_RULE } from "../src/inbox/asks.js";
import { buildWakePrompt } from "../src/wakePrompt.js";

/** root L-59: pages lead with the punchline and show it in diagrams and boxes, not heavy text. */
describe("visual first (root L-59)", () => {
  it("the rule asks for the one-line answer, then a diagram or boxed summary, and names the check", () => {
    expect(VISUAL_FIRST_RULE).toContain("root L-59");
    expect(VISUAL_FIRST_RULE).toContain("one-line answer");
    expect(VISUAL_FIRST_RULE).toContain("diagram or boxed summary in the first screen");
    expect(VISUAL_FIRST_RULE).toContain("scripts/text_wall_check.py");
    // clean, simple, sophisticated, taken from the skills and checked
    for (const s of ["Clean, simple, sophisticated", "scripts/clean_look_check.py", "--screens", "app-screens.md", "hallmark"]) expect(VISUAL_FIRST_RULE).toContain(s);
  });

  it("every worker brief the manager writes carries it verbatim", () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "archivist" },
    } as never);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain(`"${VISUAL_FIRST_RULE}"`);
  });

  it("a console-launched worker's first message carries it", () => {
    const m = workerMessage({ base: "http://c", runId: "run_2", parentRunId: "run_1", ticket: "E907-S3", brief: "Do it." });
    expect(m).toContain(VISUAL_FIRST_RULE);
  });

  it("the wake's closing step carries it", () => {
    const p = buildWakePrompt({ name: "Delivery Manager", remit: "Run E4.", skills: [], mayWrite: false }, { title: "E4", repo: "Acme/poly-maker", path: "docs/E4.md", owner: "" });
    expect(p).toContain(VISUAL_FIRST_RULE);
  });
});

/** shapes carry the idea; easy calls ship, heavy ones come as one proposal page. */
describe("shapes that mean something, and the proposal page", () => {
  it("names the shapes, never a default grid, and the shape flag of the check", () => {
    for (const s of ["a cycle or wheel as a circle", "a sequence as boxes in one line", "a hierarchy as a tree", "a comparison side by side", "never a default grid of boxes", "--shape cycle|line", "shape misleads"]) expect(VISUAL_FIRST_RULE).toContain(s);
  });
  it("easy calls ship and show live; heavy ones come as one proposal page with every part", () => {
    for (const s of ["Easy calls", "ship to production", "page_shell.py proposal", "the bottom line at the top and the bottom", "mock-ups", "implications", "our recommendation"]) expect(VISUAL_FIRST_RULE).toContain(s);
  });
});

/** the rule names all three diagram skills and the shared shell; a manager's own brief helper reads the rules fresh. */
describe("diagrams by default, one design", () => {
  it("names house-diagram-style, diagram-design, paper-deck and the page shell, and the manager's own reports", async () => {
    for (const s of ["house-diagram-style", "diagram-design", "paper-deck", "scripts/page_shell.py", "chat reports and run summaries", "needs evidence"]) expect(VISUAL_FIRST_RULE).toContain(s);
  });
  it("the worker rules list holds the visual rule, and the dispatch step points a helper at /api/worker-rules", async () => {
    const { workerBriefRules } = await import("../src/cycle/prompts.js");
    expect(workerBriefRules()).toHaveLength(12);
    expect(workerBriefRules()).toContain(VISUAL_FIRST_RULE);
    const text = wakeProtocol({ base: "http://c", run: { id: "run_1" }, assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" }, milestone: { id: "ms_1" }, persona: { id: "p_1", name: "archivist" } } as never);
    expect(text).toContain("http://c/api/worker-rules");
  });
});
