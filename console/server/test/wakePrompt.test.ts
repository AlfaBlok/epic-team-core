import { describe, expect, it, vi } from "vitest";
import { buildWakePrompt, maxWorkersFromEnv, OUTCOME_RULE } from "../src/wakePrompt.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

const milestone = { title: "Fleet Observatory", repo: "/srv/x/infra", path: "tickets/E5.md", owner: "Sam" };
const persona = { name: "steward", remit: "Do the REMIT_MARKER thing.", skills: ["epic-spine", "gh"], mayWrite: false };

describe("buildWakePrompt", () => {
  it("injects persona remit, skills and the milestone pointer", () => {
    const p = buildWakePrompt(persona, milestone);
    expect(p).toContain("You are steward");
    expect(p).toContain("Do the REMIT_MARKER thing.");
    expect(p).toContain("- Repo: /srv/x/infra");
    expect(p).toContain("- Spine / ticket: tickets/E5.md");
    expect(p).toContain("- Title: Fleet Observatory");
    expect(p).toContain("- Owner: Sam");
    expect(p).toContain("## Skills\nYour team skills (installed on this seat; open one by its name when the task fits):\n- `epic-spine`\n- `gh`");
    expect(p).toMatch(/outcome: progressed: <step done>, next <step> \| blocked: .* \| idle: no step ready/);
  });

  it("applies the mayWrite rule", () => {
    const ro = buildWakePrompt(persona, milestone);
    expect(ro).toContain("Read-only");
    expect(ro).toContain("Needs Sam");
    expect(ro).toContain("diagnose-only");
    // the persona flag alone no longer opens writes; the assignment does.
    expect(buildWakePrompt({ ...persona, mayWrite: true }, milestone)).toContain("Read-only");
    const rw = buildWakePrompt(persona, milestone, { writeEnabled: true, writeScope: "git only" });
    expect(rw).not.toContain("Read-only");
    expect(rw).toContain("You may write, ONLY within this scope: git only");
  });

  it("M2-35a: questions go to the spine as coded asks; Needs Sam is the fallback", () => {
    const ro = buildWakePrompt(persona, milestone);
    expect(ro).toContain("coded ask in the spine");
    expect(ro).toContain("only if you cannot write the spine");
  });

  it("is generic: no persona- or milestone-specific text beyond the inputs", () => {
    const p = buildWakePrompt({ name: "A", remit: "R", skills: [], mayWrite: false }, { title: "T", repo: "o/r", path: "s.md", owner: "" });
    for (const word of ["infra", "steward", "E5", "health", "relay", "Owner:", "## Skills"]) expect(p).not.toContain(word);
  });
});

describe("M2-12 spine state + outcome rules", () => {
  it("asks for Current State every wake and ## Outcome before closing", () => {
    const p = buildWakePrompt(persona, milestone);
    expect(p).toContain("At the end of every wake, update `## Current State`");
    expect(p).toMatch(/`Last attempted:`, `Result:`, `Evidence:`, `Waiting on:`, `Next action:`, `Verified at:`\) before you PATCH the run/);
    expect(p).toContain("Before you tick the last Done-means box or ask for closure, write `## Outcome`");
    expect(p).toContain("Put the outcome sentence in your run summary.");
  });

  it("closing rule is NO_SELF_GREEN-compatible: outcome + review, never done", () => {
    expect(OUTCOME_RULE).toContain("## Outcome");
    expect(OUTCOME_RULE).toMatch(/Status: review/);
    expect(OUTCOME_RULE).toMatch(/never done \/ closed/);
    expect(OUTCOME_RULE).toMatch(/Delivery manager or Sam verifies/);
    expect(OUTCOME_RULE).not.toMatch(/set Status: done|then close/i);
  });

  it("T6-S14 / T13-S7: dispatches every ready row, one worker each, pick until null id; a blocked row never stops the others", () => {
    const p = buildWakePrompt(persona, milestone);
    expect(p).not.toContain("find the next unblocked item");
    expect(p).toContain("list EVERY unblocked item");
    expect(p).toContain("an open ask blocks only the rows it names; a blocked row never stops the others");
    expect(p).toContain("one worker per row: run `$EPICSPINE_DISPATCHER pick` for each worker until it returns a null id");
    expect(p).toContain("several workers may share a seat, and `available` in `status` counts eligible seats, never a number of workers");
    expect(p).not.toMatch(/free seats|at most 2|up to the dispatcher/);
    expect(p).toContain("the ready rows still queued with their reason");
  });

  it("T13-S7: ceiling of 10 child workers per milestone, 10 s between launches, queued reasons", () => {
    const p = buildWakePrompt(persona, milestone);
    expect(p).toContain("Run at most 10 child workers at once for this milestone (count its child runs still `running`) and pause 10 s between launches");
    expect(p).toContain("`queued: worker ceiling 10`");
    expect(p).toContain("`N ready rows queued: no seat with headroom (<pick reason>)`");
    expect(buildWakePrompt(persona, milestone, undefined, undefined, undefined, 4)).toContain("at most 4 child workers");
  });

  it("T13-S7: CONSOLE_MAX_WORKERS_PER_MILESTONE default 10, valid integers only", () => {
    expect(maxWorkersFromEnv(undefined)).toBe(10);
    expect(maxWorkersFromEnv("3")).toBe(3);
    expect(maxWorkersFromEnv("0")).toBe(10);
    expect(maxWorkersFromEnv("abc")).toBe(10);
  });
});
