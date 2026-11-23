import { describe, expect, it, vi } from "vitest";
import { deepLinkPossible, deepLinkProblem, gateProblems, isDeepLink, parseCard } from "../src/review/card.js";
import { cardText } from "./reviewFixture.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * E948-S180 (the owner 22 Nov: "I would rather you did like a URL where you show me. You lead my attention to
 * what you want to show me"): a card's evidence link lands on the one section, row or number meant, and one plain line on
 * the card says what to look at. A bare link to one of our own pages is held: card needs rewriting.
 */
const HUB = ["host1.example.com"];
const G = { project: "The team console", goalSentence: "Give the team desk a home.", screenshotFound: true, ownHosts: HUB };
const card = (evidence: string, look?: string) => parseCard(cardText("E941-S2", { evidence, ...(look ? { extra: [`look: ${look}`] } : {}) }))!;

describe("E948-S180 the evidence link points at the thing", () => {
  it("knows our own pages from someone else's, and a file from a page", () => {
    expect(deepLinkPossible("http://host1.example.com:9874/", HUB)).toBe(true);
    expect(deepLinkPossible("https://team.example.com/sets/bitwarden")).toBe(true);
    expect(deepLinkPossible("https://x.com/a/status/1", HUB)).toBe(false);
    expect(deepLinkPossible("http://host1.example.com:9874/shot.webp", HUB)).toBe(false);
    expect(deepLinkPossible("https://team.example.com/api/voice/notes/vn_1/audio")).toBe(false);
    expect(isDeepLink("http://host1.example.com:9874/#loose")).toBe(true);
    expect(isDeepLink("https://team.example.com/sets/bitwarden?tab=kr&focus=loose-tickets")).toBe(true);
    expect(isDeepLink("https://team.example.com/sets/bitwarden?tab=kr")).toBe(false);
  });

  it("holds a bare link to our page: point the link at the thing", () => {
    expect(deepLinkProblem("http://host1.example.com:9874/", HUB)).toMatch(/^point the link at the thing/);
    expect(deepLinkProblem("https://team.example.com/sets/bitwarden")).toMatch(/^point the link at the thing/);
    const p = gateProblems({ card: card("[Every task has a goal](http://host1.example.com:18996/)", "The three loose tickets, in the yellow box"), ...G });
    expect(p.join(" ")).toMatch(/point the link at the thing/);
  });

  it("passes a deep link with its look line, and holds one without the line", () => {
    const good = card("[The three loose tickets](https://team.example.com/sets/bitwarden?focus=tickets-without-key-result)", "The three tickets that hang under no key result");
    expect(good.look).toBe("The three tickets that hang under no key result");
    expect(gateProblems({ card: good, ...G })).toEqual([]);
    const noLook = card("[The three loose tickets](https://team.example.com/sets/bitwarden?focus=tickets-without-key-result)");
    expect(gateProblems({ card: noLook, ...G }).join(" ")).toMatch(/the look line is missing/);
    expect(gateProblems({ card: card("[Loose](http://host1.example.com:9874/#loose)", "Loose tickets; see the box"), ...G }).join(" ")).toMatch(/the look line has a semicolon/);
  });

  it("takes someone else's page as it is, with no look line needed", () => {
    expect(gateProblems({ card: card("[The post](https://x.com/a/status/1)"), ...G })).toEqual([]);
    expect(gateProblems({ card: card("[The audit](https://team.example/audit)"), ...G })).toEqual([]);
  });
});

describe("E948-S180 pointing the link inside its page keeps the quality check", () => {
  it("a look line and a #id or focus= on the evidence link change no word the check judged", async () => {
    const { qcSeenCard } = await import("../src/review/qc.js");
    const old = 'row: X\nevidence: "[Open](http://h:9814/)"\nscreenshot: a\n';
    expect(qcSeenCard('row: X\nevidence: "[Open](http://h:9814/?focus=The%20gaps)"\nlook: The gaps box\nscreenshot: a\n')).toContain(old);
    expect(qcSeenCard('row: X\nevidence: "[Open](http://h:9814/#gaps)"\nlook: The gaps box\nscreenshot: a\n')).toContain(old);
    expect(qcSeenCard("evidence: http://h/a?tab=k&focus=x\nlook: y\n")).toContain("evidence: http://h/a?tab=k\n");
    expect(qcSeenCard('row: X\nevidence: "[Open](http://h:9815/#gaps)"\n')).not.toContain(old);
    // a card that carries an about line too: the check saw it with that line
    const withAbout = 'about: a topic\nrow: X\nevidence: "[Open](http://h:9814/)"\n';
    expect(qcSeenCard('about: a topic\nrow: X\nevidence: "[Open](http://h:9814/?focus=x)"\nlook: The box\n')).toContain(withAbout);
  });
});
