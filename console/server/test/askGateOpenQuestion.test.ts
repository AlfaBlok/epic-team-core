import { describe, expect, it } from "vitest";
import { askGateProblem } from "../src/inbox/askGate.js";
import { parseAsks } from "../src/inbox/asks.js";
import { askLine } from "../src/inbox/raise.js";

// the desk's open question "where did your Altamira video request go?" was refused twice as re-stating him,
// because its next step said "File the task from your answer": the answer it waits for, not an earlier one.
const viaApi = (question: string, proposedAction: string) => {
  const a = parseAsks(`## Waiting on\n${askLine("X-A1", { question, proposedAction, askedBy: "a persona" }, "2000-01-01")}`).map(({ since: _old, ...x }) => x)[0];
  return askGateProblem(a);
};
const HIS = `"i asked for some task about my altamira video, haven't seen anythign about it was it lost????"`;

describe("an open question that quotes his words reaches him", () => {
  it("passes the two asks the desk was refused on 24 Nov", () => {
    expect(viaApi(`Tell me how you think about the Altamira video task you asked for: what you asked, roughly when, and where you said it. Talk for a few minutes in a voice note. Why: your chat message today said ${HIS}.`, "File the task from your answer as one ready row, linked to the PatronBTC video project, and say where it landed; if it was lost, add the case to the lost-request checks.")).toBeUndefined();
    expect(viaApi(`Tell me how you think about the Altamira video task: what you want done, and where you first asked for it. Talk for a few minutes in a voice note. Why: your chat today said ${HIS} and no task about it is in your notes or tickets of the last 14 days.`, "File the task from your answer as one ready row, linked to your Altamira2050 PatronBTC video project, and trace where the first request was lost.")).toBeUndefined();
    expect(viaApi(`Where did your request go? Why: your chat today said ${HIS}.`, "Once your answer is in, file it ready; with your decision on this card we start.")).toBeUndefined();
  });

  it("still holds an ask that cites his earlier answer", () => {
    expect(viaApi(`Close the two Idealista asks. Why: your answer of 10 November said ${HIS}.`, "Act on your answer.")).toMatch(/re-states something Sam already decided/);
    expect(viaApi(`Close the two Idealista asks with your 10 November decision. Why: ${HIS}`, "yes")).toMatch(/re-states/);
    expect(viaApi(`Close the asks. Why: ${HIS}`, "As your earlier answer says, close them.")).toMatch(/re-states/);
  });
});

describe("acting on his earlier answer is still a re-statement", () => {
  it("holds 'act on your answer'", () => {
    expect(viaApi(`Close the asks? Why: ${HIS}`, "Act on your answer and close them.")).toMatch(/re-states/);
  });
});
