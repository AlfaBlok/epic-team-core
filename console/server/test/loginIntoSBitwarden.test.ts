import { describe, expect, it } from "vitest";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { buildWakePrompt, LOGIN_RULE } from "../src/wakePrompt.js";

/** every new login goes into his Bitwarden at creation. */
describe("T83-S13 every new login into Sam's Bitwarden at creation", () => {
  it("the rule names the tool, the moment and the hand-over guard", () => {
    expect(LOGIN_RULE).toContain("scripts/bw_login.py new");
    expect(LOGIN_RULE).toContain("before its sign-up is submitted");
    expect(LOGIN_RULE).toContain("Never give Sam a login");
    expect(LOGIN_RULE).toContain("state: queued");
    expect(LOGIN_RULE).not.toMatch(/password=|BW_PASSWORD/);
  });

  it("every persona wake and every worker brief carries it", () => {
    const p = buildWakePrompt({ name: "Delivery Manager", remit: "Run E4.", skills: [] }, { title: "E4", repo: "Acme/home_repo", path: "docs/E4.md", owner: "" });
    expect(p).toContain(LOGIN_RULE);
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "archivist" },
    } as never);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain("these ten rules");
    expect(brief).toContain(`"${LOGIN_RULE}"`);
  });
});
