import { describe, expect, it } from "vitest";
import { askLeadUrl, cardBody, cardHeading, projectLabel, splitSteps } from "@/lib/askLead";

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
});
