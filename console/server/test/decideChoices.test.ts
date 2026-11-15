import { describe, expect, it } from "vitest";
import { parseAsks } from "../src/inbox/asks.js";
import { askGateProblem } from "../src/inbox/askGate.js";
import { actionOf, decideButtonsProblem, decideChoices } from "../src/inbox/decideChoices.js";

/**
 * E948-S69 iteration 2 (the owner on E946-A31, 2026-11-13, vn_11f06422: "It's still happening that I'm getting decide cards
 * with no decide options. Just now, only ask feedback."): every Decide card shows choices as buttons.
 */
const E46_A31 =
  "- [ask E946-A31: decide @Sam since 2026-11-12 row E946-S28] Agree this plan for the testers and start the three-day experiment tomorrow, Friday 13 Nov? " +
  "The team recommends yes. https://example.com/plan.html — context: you said on WhatsApp at 22:19 UTC \"let's agree on a plan\" — " +
  "options: yes as it stands; yes with changes said in the page's feedback box; no — recommend: yes as it stands — unblocks: E946-S28";
const ask = (line: string) => parseAsks(`## Waiting on\n\n${line}\n`)[0];

describe("E948-S69 every Decide card has choices", () => {
  it("reads options written with semicolons as that many options (E946-A31 came as one, its card showed only feedback)", () => {
    const a = ask(E46_A31);
    expect(a.options).toEqual(["yes as it stands", "yes with changes said in the page's feedback box", "no"]);
    expect(decideChoices(a)).toEqual({ options: a.options, recommend: "yes as it stands", derived: false });
  });

  it("a decide ask with no options gets Yes, <the action> and No from its question, the team's pick marked", () => {
    const a = ask(E46_A31.replace(/ — options:[^—]*/, "").replace(/ — recommend:[^—]*/, ""));
    expect(a.options).toEqual([]);
    expect(decideChoices(a)).toEqual({ options: ["Yes, agree this plan for the testers", "No"], recommend: "Yes, agree this plan for the testers", derived: true });
    expect(decideButtonsProblem(a)).toBeUndefined();
    expect(askGateProblem(a) ?? "").not.toMatch(/option buttons/);
  });

  it("drops the yes or no lead from the button and keeps it short", () => {
    expect(actionOf("Should we build the used-car lookup now?")).toBe("build the used-car lookup now");
    expect(actionOf("Do we post the testers call on Reddit, X and YouTube this week?")).toBe("post the testers call on Reddit");
    expect(decideChoices({ ask: "decide", question: "You decide: Should we keep the old page?", recommend: "no, drop it" })).toEqual({ options: ["Yes, keep the old page", "No"], recommend: "No", derived: true });
  });

  it("an either-or question gets its two choices", () => {
    expect(decideChoices({ ask: "decide", question: "You decide: Friday or Monday? context", recommend: "Monday, more replies" })).toEqual({ options: ["Friday", "Monday"], recommend: "Monday", derived: true });
  });

  it("a pick question names its choices: those are the buttons, never Yes and No (E997-A8)", () => {
    const q = "You decide: which do we sell first, A Acme Social as your marketing function, B Acme Books with a liability clause, or C outreach by smart emails? We recommend A. http://x/";
    expect(decideChoices({ ask: "decide", question: q })).toEqual({
      options: ["A Acme Social as your marketing function", "B Acme Books with a liability clause", "C outreach by smart emails"],
      recommend: "A Acme Social as your marketing function",
      derived: true,
    });
    expect(decideChoices({ ask: "decide", question: "Which channel do we use first?" }).options).toEqual([]);
    expect(decideButtonsProblem({ ask: "decide", question: "Which channel do we use first?" })).toMatch(/no option buttons/);
  });

  it("a decide ask with no options and no question fails the check (gate rule 7)", () => {
    const a = ask("- [ask X-A2: decide @Sam since 2026-11-13 row X-S1] Pick the launch channel for the testers call — context: you said \"pick a channel\" (vn_11f06422) — unblocks: X-S1");
    expect(decideChoices(a).options).toEqual([]);
    expect(decideButtonsProblem(a)).toMatch(/would show no option buttons/);
    expect(askGateProblem(a)).toMatch(/would show no option buttons/);
  });

  it("no question but a recommendation: Yes to it, or No; older decide asks are not held, the sweep names them", () => {
    expect(decideChoices({ ask: "decide", question: "Pick the launch date", recommend: "Monday, more replies" })).toEqual({ options: ["Yes, Monday", "No"], recommend: "Yes, Monday", derived: true });
    expect(askGateProblem({ ask: "decide", question: "Pick the launch date", since: "2026-11-12" }) ?? "").not.toMatch(/option buttons/);
  });

  it("answered decide asks and other kinds are not checked", () => {
    expect(decideButtonsProblem({ ask: "decide", state: "answered", question: "Pick one" })).toBeUndefined();
    expect(decideButtonsProblem({ ask: "approve", question: "The plan" })).toBeUndefined();
  });

  it("long options between semicolons (E997-A8) and options between spaced slashes (another world's ask) are that many", () => {
    expect(ask("- [ask X-A5: decide @Sam since 2026-11-13] Which? — options: A: sell Acme Social first, we build the lead count and bring the first 10 testers; B: sell Acme Books first, we restart it for a second company and get the clause checked; C: build outreach as the product, we ask for a sending domain and send rights").options).toHaveLength(3);
    expect(ask("- [ask X-A6: decide @Sam since 2026-11-13] Drop it? — options: yes as shown (no giveaway, the question rides the posts) / no (run the giveaway as the page shows)").options).toEqual(["yes as shown (no giveaway, the question rides the posts)", "no (run the giveaway as the page shows)"]);
  });

  it("lettered and dotted lists still read as before", () => {
    expect(ask("- [ask X-A3: decide @Sam since 2026-11-13] Which? — options: (a) yes, done; (b) no, say what").options).toEqual(["(a) yes, done", "(b) no, say what"]);
    expect(ask("- [ask X-A4: decide @Sam since 2026-11-13] Which? — options: A posts · B people").options).toEqual(["A posts", "B people"]);
  });
});
