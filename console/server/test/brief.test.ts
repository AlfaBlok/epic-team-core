import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { REPO_IS_SOURCE_RULE } from "../src/inbox/asks.js";

/** root L-45 and the brief every wake and worker gets say the same: the repo is the only source. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/spines/root.md");

describe("T62-S3 the repo-is-the-source rule in the wake and worker brief", () => {
  it("every wake carries it under the repo rules, and every worker brief carries it verbatim", async () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "archivist" },
    } as never);
    const repoRules = text.slice(text.indexOf("A. Repo rules"), text.indexOf("B. Child workers"));
    expect(repoRules).toContain(REPO_IS_SOURCE_RULE);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain("/api/worker-rules"); // the rules are served, not pasted
    expect((await import("../src/cycle/prompts.js")).workerBriefRules().join("\n")).toContain(REPO_IS_SOURCE_RULE);
    expect(REPO_IS_SOURCE_RULE).toMatch(/Decisions and state go into the spine, never only into the console's API or DB/);
  });

  it("AGENTS.md carries it verbatim, so a T3 thread or a native subagent in this repo has it too (E62-6, T62-S10)", () => {
    const agents = fs.readFileSync(path.resolve(path.dirname(ROOT), "../../AGENTS.md"), "utf8");
    expect(agents).toContain(REPO_IS_SOURCE_RULE);
  });

  it("root L-45 says the same", () => {
    const l45 = fs.readFileSync(ROOT, "utf8").split("\n").find((l) => l.startsWith("- L-45 "));
    expect(l45).toBeDefined();
    expect(l45).toMatch(/repo is the only source of work state and decisions/);
    expect(l45).toMatch(/console\.db is only a cache rebuilt from it/);
    expect(REPO_IS_SOURCE_RULE).toContain("L-45");
  });
});
