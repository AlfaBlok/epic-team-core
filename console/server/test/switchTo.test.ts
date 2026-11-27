import { describe, expect, it } from "vitest";
import { pickObjective, SWITCH_TOOL, switchAnswer, switchRule } from "../src/voice/switchTo.js";
import { levelName } from "../src/voice/levelCall.js";

/** another partner comes onto the same call with its package; his screen gets its name. Never a hang-up. */

const cards = [
  { id: "buy-flat", name: "Home: Buy a flat" },
  { id: "alignment", name: "Acme: Get the team to understand me" },
  { id: "launch-acme", name: "Acme: Launch Acme" },
  { id: "notes", name: "Notes: Launch Notes" },
];
const o = {
  home: "Team desk partner",
  cards: async () => cards,
  pack: async (c: { id: string; name: string }) => `# This call's level: the objective "${c.name}"\n- Testers who finished onboarding (red): now 41%, target 80%`,
  deskPack: async () => "# His objectives, in his order (4)",
  objectiveName: levelName,
};

describe("switch_to: load another partner on the spot", () => {
  it("finds the objective he names: by number, whole name, the words after the product, or shared words", () => {
    expect(pickObjective(cards, "2")?.id).toBe("alignment");
    expect(pickObjective(cards, "Acme: Launch Acme")?.id).toBe("launch-acme");
    expect(pickObjective(cards, "Launch Acme")?.id).toBe("launch-acme");
    expect(pickObjective(cards, "the flat objective")?.id).toBe("buy-flat");
    expect(pickObjective(cards, "team understanding me")?.id).toBe("alignment");
    expect(pickObjective(cards, "a pony")).toBeUndefined();
  });

  it("switching loads the package into the call and names its manager for his screen", async () => {
    const r = await switchAnswer("Launch Acme", o);
    expect(r.name).toBe("Launch Acme manager");
    expect(r.objective).toBe("Acme: Launch Acme");
    expect(r.result).toMatch(/^SWITCHED: you are now the Launch Acme manager/);
    expect(r.result).toContain("now 41%, target 80%");
  });

  it("a merged objective's name on his screen leaves out its (with: …) part", async () => {
    const r = await switchAnswer("Launch", { ...o, cards: async () => [{ id: "l", name: "Acme: Launch Acme (with: Acme: Finish the migration, Acme: Get the browser …)" }] });
    expect(r.name).toBe("Launch Acme manager");
    expect(r.objective).toContain("(with:");
  });

  it('"desk" brings the call\'s own partner back with the overview; an unknown name asks which one', async () => {
    const back = await switchAnswer("desk", o);
    expect(back.name).toBe("Team desk partner");
    expect(back.objective).toBeUndefined();
    expect(back.result).toContain("His objectives, in his order");
    const none = await switchAnswer("a pony", o);
    expect(none.name).toBe("");
    expect(none.result).toMatch(/^NOT SWITCHED/);
    expect(none.result).toContain("2. Acme: Get the team to understand me");
  });

  it("the rule says it in one line, switches on this call, and never hangs up to hand over", () => {
    const r = switchRule("Team desk manager");
    expect(r).toContain("Switching to the <objective> manager");
    expect(r).toContain("everything we said stays on this call");
    expect(r).toMatch(/Never hang up to hand over/);
    expect(SWITCH_TOOL.name).toBe("switch_to");
    expect(SWITCH_TOOL.parameters.required).toEqual(["to"]);
  });
});
