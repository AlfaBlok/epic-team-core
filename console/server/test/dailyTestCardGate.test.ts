import { describe, expect, it } from "vitest";
import { cardFile, REOPEN_ROW, TEST_ROWS } from "../src/press/dailyTest.js";
import { gateProblems, parseCard } from "../src/review/card.js";

// the daily press test's TEST cards pass the review gate's card checks, its deep link and look line included
describe("daily press test cards", () => {
  for (const r of [...TEST_ROWS, REOPEN_ROW]) {
    it(`${r.ref} passes the gate`, () => {
      const card = parseCard(cardFile(r));
      expect(card?.evidenceUrl).toMatch(/\?focus=/);
      expect(card?.look).toBeTruthy();
      expect(gateProblems({ card, project: "EpicTeam", goalSentence: "Every button he presses works.", screenshotFound: true })).toEqual([]);
    });
  }
});
