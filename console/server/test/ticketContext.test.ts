import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_BRIEF_STEP, HIS_NOTES_RULE } from "../src/cycle/prompts.js";
import { CONTEXT_HEAD, contextMissing, contextSection, readTicketContext } from "../src/cycle/ticketContext.js";
import { workerMessage } from "../src/cycle/workerLaunch.js";
import { endpointLines, SEED_VERSION } from "../src/desk/desk.js";

// every new ticket keeps the desk's lookup (docs/context/<row>.md) and every worker brief opens with it
const SIDECAR = [
  "# Context to read first: T-9",
  "",
  "Built 2026-11-22T09:36Z by scripts/ticket_context.py (E907-S3) from the lookup made when the ticket was filed.",
  'Looked up: "TEST: where to stay in Tenerife"',
  "Read these before you plan.",
  "",
  "1. **topic** 1.00 · Now, 2026-11-22: TEST Tenerife is off for now [open](x)",
  "2. **ticket** 0.09 · HD-S37 (house_decision, done): TEST a hills visit plan [open](y)",
].join("\n");

describe("ticket context", () => {
  it("turns a sidecar into the brief's opening section: heading, when, the scored list only", () => {
    const s = contextSection(SIDECAR, "docs/context/T-9.md");
    expect(s.split("\n")[0]).toBe(`## ${CONTEXT_HEAD} (docs/context/T-9.md)`);
    expect(s).toContain("Built 2026-11-22T09:36Z when the ticket was filed");
    expect(s).toContain("1. **topic** 1.00");
    expect(s).toContain("2. **ticket** 0.09");
    expect(s).not.toContain("Looked up");
  });
  it("reads the row's sidecar from its checkout, and refuses a row id that is a path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
    fs.mkdirSync(path.join(dir, "docs/context"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/context/T-9.md"), SIDECAR);
    expect(readTicketContext(dir, "T-9")).toContain("TEST Tenerife is off");
    expect(readTicketContext(dir, "T-10")).toBeUndefined();
    expect(readTicketContext(dir, "../../etc/passwd")).toBeUndefined();
    expect(contextMissing("T-10", "abnb-agent")).toContain("ticket_context.py brief T-10 --repo ~/github/abnb-agent");
  });
  it("opens the console's own worker message with it, once", () => {
    const context = contextSection(SIDECAR, "docs/context/T-9.md");
    const m = workerMessage({ base: "http://c", runId: "run_1", parentRunId: "run_0", ticket: "T-9", brief: "TEST brief", context });
    expect(m.indexOf(CONTEXT_HEAD)).toBeLessThan(m.indexOf("TEST brief"));
    const again = workerMessage({ base: "http://c", runId: "run_1", parentRunId: "run_0", ticket: "T-9", brief: `${context}\nTEST brief`, context });
    expect(again.split(`## ${CONTEXT_HEAD}`).length).toBe(2);
  });
  it("the desk keeps its lookup on a new row right after the Add, and its seed moved so live desks hear it", () => {
    expect(endpointLines("http://c").join("\n")).toContain("ticket_context.py write <new row>");
    expect(SEED_VERSION).toBeGreaterThanOrEqual(48);
  });
  it("the dispatch step and the worker rule both name it", () => {
    expect(CONTEXT_BRIEF_STEP("http://c")).toContain("/api/ticket-context");
    expect(HIS_NOTES_RULE).toContain(CONTEXT_HEAD);
    expect(HIS_NOTES_RULE).toContain("docs/context/<row>.md");
  });
});
