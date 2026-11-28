import { describe, expect, it } from "vitest";
import { boardOpening, campaignOpening, cut, objectiveOpening, PREPARED_RULE, sayable } from "../src/voice/prepared.js";
import { greetingOf, GREETING_LEAD, withGreeting } from "../src/voice/voice.js";
import { objectiveCallInstructions } from "../src/voice/levelCall.js";

/** every call of his phone directory opens prepared, on its own status and our proposal. */

const card = (over: Partial<Parameters<typeof objectiveOpening>[0]> = {}) => ({
  id: "acme-launch",
  name: "Acme: Launch Acme",
  light: "red",
  krs: "1 of 3 key results green",
  stands: "not moved today",
  keyResults: [
    { label: "Site live", state: "green", value: "yes", target: "yes", tickets: [] },
    { label: "Testers using it daily", state: "red", value: "0", target: "5", tickets: ["E907-S3"] },
    { label: "Posts a day", state: "red", value: "1", target: "3", tickets: [] },
  ],
  ...over,
});

describe("prepared call openings ", () => {
  it("an objective's manager opens on its status and proposes work on the red key result nothing moves", () => {
    const o = objectiveOpening(card());
    expect(o).toMatch(/^Hi \w+, the Launch Acme manager here\. Where we stand: 1 of 3 key results green; the first not green is 'Testers using it daily', now 0 against 5\./);
    expect(o).toContain("Our proposal: we open work this week on 'Posts a day', since nothing moves it yet. Shall we start there?");
    expect(o).not.toContain('"');
  });

  it("a ready pitch is the proposal; else his first open question, without codes", () => {
    expect(objectiveOpening(card(), { onboarding: "## The pitch (phase 3)\n1. What we found: x" })).toContain("Our proposal: I walk you through the one-week plan we prepared");
    const k = card({ keyResults: [{ label: "Testers", state: "red", value: "0", target: "5", tickets: ["E907-S3"] }] });
    expect(objectiveOpening(k, { open: ["Does Sam keep the prices? (card E907-S4)"] })).toContain("Our proposal: we settle one open question first: does Sam keep the prices? Shall we start there?");
  });

  it("a campaign's manager reads its spine's Status and Next action", () => {
    const o = campaignOpening("Acme testers", ["Status: 3 testers, none daily (see [page](http://x)).", "Next action: send the voice-note welcome to the 16 mails (E907-S5)."]);
    expect(o).toBe(`Hi ${o.split(" ")[1].replace(",", "")}, the Acme testers manager here. Where we stand: 3 testers, none daily (see page). Our proposal: send the voice-note welcome to the 16 mails. Shall we start there?`);
  });

  it("the board counts green, names the two reddest, and starts with the first", () => {
    const o = boardOpening([{ name: "House: Buy a house", light: "red" }, { name: "Acme: Launch Acme", light: "red" }, { name: "Cars: Launch the car bots", light: "green" }, { name: "X: Y", light: "red" }], "Team desk partner");
    expect(o).toContain("your Team desk partner here, on the board of your 3 objectives".replace("3", "4"));
    expect(o).toContain("1 green; the reddest are Buy a house and Launch Acme");
    expect(o).toMatch(/Shall we start with Buy a house\?$/);
  });

  it("the prepared line replaces the call's greeting, read back as the greeting", () => {
    const ins = `${objectiveCallInstructions("Acme: Launch Acme")}\n${PREPARED_RULE}`;
    const line = objectiveOpening(card());
    const out = withGreeting(ins, line);
    expect(greetingOf(out)).toBe(line);
    expect(out.split(GREETING_LEAD).length).toBe(2);
    expect(withGreeting(ins, undefined)).toBe(ins);
    expect(PREPARED_RULE).toMatch(/never ask any of them again/);
  });

  it("a manager with its own name greets by it", () => {
    expect(objectiveOpening(card(), { person: "Ana" })).toMatch(/^Hi \w+, Ana here, the Launch Acme manager\. Where we stand/);
    expect(boardOpening([{ name: "A: B", light: "red" }], "Team desk partner", "Lea")).toMatch(/^Hi \w+, Lea here, your Team desk partner, on the board of your 1 objectives/);
  });

  it("the folded objectives are not in the manager's name", () => {
    expect(objectiveOpening(card({ name: "Hub: Launch Hub (with: Hub: Finish the move, Hub: Get…" }))).toMatch(/^Hi \w+, the Launch Hub manager here\./);
  });

  it("spoken words: no links, codes or cut words", () => {
    expect(sayable("see [the page](https://a.b) E907-S3 run_abc-1 now")).toBe("see the page now");
    expect(cut("one two three four five", 12)).toBe("one two");
  });
});
