// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { askLead, firstSentence, reviewLead } from "@/lib/askLead";
import { LeadBand } from "@/components/askLead";

/**
 * every inbox card opens with one big line by kind.
 */
describe("T48-S44 the lead line", () => {
  it("uses the ask's own lead line and its Why when it opens that way", () => {
    const l = askLead({ ask: "approve", question: "You approve: spend $11 a month on a Mexico proxy. Why: Reddit blocks our server address." });
    expect(l).toMatchObject({ kind: "approve", verb: "You approve", what: "Spend $11 a month on a Mexico proxy", why: "Reddit blocks our server address.", own: true });
    expect(askLead({ ask: "unknown", question: "You do: one tap in Bitwarden" })).toMatchObject({ kind: "do", own: true });
    expect(askLead({ ask: "provide", question: "You give: the Stripe key" })).toMatchObject({ kind: "give", verb: "You give" });
  });

  it("derives the line from the kind and the first sentence, without saying the verb twice", () => {
    const l = askLead({ ask: "approve", question: "Approve about $11/month for a Mexico proxy? It unblocks posting.", impact: "Posting starts this week. More words." });
    expect(l).toMatchObject({ kind: "approve", what: "About $11/month for a Mexico proxy", why: "Posting starts this week.", own: false });
    expect(askLead({ ask: "do", question: "Do: move the wallet funds — context: it was exposed" }).what).toBe("Move the wallet funds");
  });

  it("a decision between short options reads A or B", () => {
    expect(askLead({ ask: "decide", question: "Which logger?", options: ["one logger", "two loggers"] }).what).toBe("Which logger: one logger or two loggers");
    expect(askLead({ ask: "decide", question: "Ship with one logger or two?", options: ["one", "two"] }).what).toBe("Ship with one logger or two?");
  });

  it("the why falls back to impact, then why him, then context", () => {
    expect(askLead({ ask: "approve", question: "X", whyYou: "Only you hold the card." }).why).toBe("Only you hold the card.");
    expect(askLead({ ask: "approve", question: "X", contextText: "It came up today." }).why).toBe("It came up today.");
    expect(askLead({ ask: "approve", question: "X" }).why).toBeUndefined();
  });

  it("a review card reads You check, its goal as the why", () => {
    expect(reviewLead({ title: "The inbox cards open with one big line.", taskGoal: "We want each card read in seconds." })).toMatchObject({
      kind: "check",
      verb: "You check",
      why: "We want each card read in seconds.",
    });
  });

  it("first sentence stops at the sentence or the field dash and stays one line", () => {
    expect(firstSentence("One thing. Two things.")).toBe("One thing.");
    expect(firstSentence("e.g. 3.5 tools work")).toBe("e.g. 3.5 tools work");
    expect(firstSentence("a ".repeat(200)).length).toBeLessThanOrEqual(161);
  });

  it("the band shows the verb, the line, Why and a do card's one tap to its step", () => {
    render(
      <MemoryRouter>
        <LeadBand lead={askLead({ ask: "do", question: "Do one tap in Bitwarden", impact: "The team can save your logins." })} action={{ url: "https://example.test/steps", label: "Open the step" }} />
      </MemoryRouter>,
    );
    const band = screen.getByTestId("ask-lead");
    expect(band.getAttribute("data-kind")).toBe("do");
    expect(within(band).getByTestId("ask-lead-line").textContent).toBe("You do: One tap in Bitwarden");
    expect(within(band).getByTestId("ask-lead-why").textContent).toBe("Why: The team can save your logins.");
    expect(within(band).getByTestId("ask-lead-step").getAttribute("href")).toBe("https://example.test/steps");
    // strong contrast: the line is near-black on a light tint, never muted grey
    expect(within(band).getByTestId("ask-lead-line").className).toMatch(/text-gray-950/);
    expect(within(band).getByTestId("ask-lead-line").className).toMatch(/text-\[19px\]/);
  });
});
