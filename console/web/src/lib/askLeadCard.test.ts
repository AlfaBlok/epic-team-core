import { describe, expect, it } from "vitest";
import { askLead, askLeadUrl, cardBody, cardHeading, plainMarkdown, projectLabel, splitSteps } from "@/lib/askLead";

// a short heading, the ask as body, a Do card's numbered steps.
describe("the card's parts", () => {
  it("drops the page link an ask opens with and keeps a short heading", () => {
    const q = "http://worker.tail.example:9019/kit/steps/#youtube-memomemory-name : You do: two small fixes on Memory's YouTube channel in YouTube Studio, about 2 minutes. Cards: 6d.";
    expect(cardHeading({ question: q })).toBe("Two small fixes on Memory's YouTube channel in YouTube Studio");
    expect(askLeadUrl({ question: q })).toBe("http://worker.tail.example:9019/kit/steps/#youtube-memomemory-name");
    expect(cardBody({ question: q }, cardHeading({ question: q }))).toMatch(/^Two small fixes on Memory's YouTube channel in YouTube Studio, about 2 minutes/);
  });
  it("a short one-sentence ask is the heading alone, the Why never in it", () => {
    const q = "You decide: build the console as in round 2? Why: you asked to see it first.";
    expect(cardHeading({ question: q })).toBe("Build the console as in round 2?");
    expect(cardBody({ question: q }, cardHeading({ question: q }))).toBeUndefined();
  });
  it("reads numbered steps and the done looks like line", () => {
    const s = splitSteps("1) Open the app. 2) Sign in as ops. — done looks like: the account page shows.");
    expect(s).toEqual({ list: ["Open the app.", "Sign in as ops."], done: "The account page shows." });
  });
  it("names a project once", () => {
    expect(projectLabel("home_repo · home_repo")).toBe("home_repo");
    expect(projectLabel("whatgpt_v3 · EPIC-900")).toBe("whatgpt_v3 · EPIC-900");
  });
  // E948-S160 (the owner on E995-A10, 22 Nov): its title showed raw [link](url) text.
  it("a markdown link the ask opens with is the card's link, never raw text in its heading", () => {
    const q = "[dashboard.exa.ai/team-settings](https://dashboard.exa.ai/team-settings) : You give, urgent: your Exa team ID, about 1 minute. Why: it is the only thing Exa's form still needs ([the filled form](http://host1.example:9666/))";
    const h = cardHeading({ question: q });
    expect(h).toBe("Your Exa team ID, about 1 minute");
    expect(h).not.toMatch(/\[|\]\(/);
    expect(askLeadUrl({ question: q })).toBe("https://dashboard.exa.ai/team-settings");
    expect(askLead({ ask: "provide", question: q })).toMatchObject({ kind: "give", own: true });
  });
  it("reads 1 … · 2 … steps as numbered lines", () => {
    expect(splitSteps("1 open https://a.b/c in Chrome · 2 copy the team ID shown there · 3 paste it in the answer box and press Send")?.list).toEqual([
      "open https://a.b/c in Chrome",
      "copy the team ID shown there",
      "paste it in the answer box and press Send",
    ]);
  });
  it("a markdown link inside a heading reads as its label", () => {
    expect(cardHeading({ question: "You give: the code from [the Exa page](https://dashboard.exa.ai/x) here. Why: the form needs it." })).toBe("The code from the Exa page here");
    expect(plainMarkdown("**Open** `dashboard` [here](https://a.b/c_(d))")).toBe("Open dashboard here");
  });
});
