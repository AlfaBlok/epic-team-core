import { describe, expect, it } from "vitest";
import { mainButtonLabel } from "./review";

// E979-G20261113 iteration 2 (the owner 2026-11-14, vn_78c963b6): "It should be start ... the count, start the 6. And if I
// switch one off, start 5. Mark complete is ambiguous." The main button names what the press does.
const sw = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Follow-up ${i + 1}`, target: "EPIC-906", recommend: "start" as const }));
const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Step ${i + 1}`, recommend: "start" as const }));

describe("mainButtonLabel", () => {
  it("a card of six switches reads Start 6, Start 5 after one is off, never Mark complete", () => {
    expect(mainButtonLabel({ next: sw(6) }, [true, true, true, true, true, true])).toBe("Start 6");
    expect(mainButtonLabel({ next: sw(6) }, [true, false, true, true, true, true])).toBe("Start 5");
    expect(mainButtonLabel({ next: sw(6) }, [true, false, true, true, true, true])).not.toMatch(/mark complete/i);
  });
  it("every switch off reads Close, start nothing", () => {
    expect(mainButtonLabel({ next: sw(3) }, [false, false, false])).toBe("Close, start nothing");
    expect(mainButtonLabel({ next: sw(2), closesGoal: true }, [false, false])).toBe("Close the goal, start nothing");
  });
  it("switches that close the goal say so", () => {
    expect(mainButtonLabel({ next: sw(2), closesGoal: true }, [true, true])).toBe("Start 2, close the goal");
  });
  it("next steps with Start now / Park count what starts", () => {
    // E948-S83: the same words as the switches, never Mark complete
    expect(mainButtonLabel({ next: steps(6) }, [true, true, true, true, true, true])).toBe("Start 6");
    expect(mainButtonLabel({ next: steps(6) }, [true, true, false, true, true, true])).toBe("Start 5");
    expect(mainButtonLabel({ next: steps(2) }, [false, false])).toBe("Close, start nothing");
    expect(mainButtonLabel({ next: steps(1), closesGoal: true }, [true])).toBe("Start 1, close the goal");
  });
  it("no card with follow-ups reads Mark complete, whatever is switched", () => {
    for (const next of [sw(3), steps(3)]) for (const on of [[true, true, true], [true, false, true], [false, false, false]]) for (const closesGoal of [false, true])
      expect(mainButtonLabel({ next, closesGoal }, on)).not.toMatch(/mark complete/i);
  });
  it("a finished task with no next step stays Mark complete", () => {
    expect(mainButtonLabel({}, [])).toBe("Mark complete");
    expect(mainButtonLabel({ next: [], closesGoal: true }, [])).toBe("Mark complete, close the goal");
  });
});
