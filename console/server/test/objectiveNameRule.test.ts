import { describe, expect, it } from "vitest";
import { OBJECTIVE_NAME_RULE, objectivesBlock, objectivesRule } from "../src/objectives.js";
import { endpointLines } from "../src/desk/desk.js";

/** the owner: "They have to be short and they need to be well clear": one naming rule, read by every worker, wake and the desk. */
describe("objective name rule", () => {
  it("says Product: short goal, 2 to 6 plain words starting with a capital, no two alike", () => {
    expect(OBJECTIVE_NAME_RULE).toContain("`Product: short goal`");
    expect(OBJECTIVE_NAME_RULE).toContain("2 to 6 plain words");
    // the goal after the colon and every key result start with a capital ("Acme: Get 5 testers")
    expect(OBJECTIVE_NAME_RULE).toContain("`Acme: Get 5 testers`");
    expect(OBJECTIVE_NAME_RULE).toContain("every key result line starts with a capital letter");
    expect(OBJECTIVE_NAME_RULE).toContain("no two names alike");
  });
  it("rides in the worker rule, every wake's objectives block and the desk's standing rules", () => {
    expect(objectivesRule()).toContain(OBJECTIVE_NAME_RULE);
    const block = objectivesBlock({ nodes: [{ id: "a", kind: "pursuit", name: "Acme: 5 testers", headline: "Acme: 5 testers", rank: 1, greens: 0, total: 1 }] });
    expect(block).toContain(OBJECTIVE_NAME_RULE);
    expect(block).toContain("1. 🔴 Acme: 5 testers");
    expect(endpointLines("http://c").join("\n")).toContain(OBJECTIVE_NAME_RULE);
  });
});
