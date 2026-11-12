import { describe, expect, it } from "vitest";
import { parseCard } from "../src/review/card.js";
import { consolePathOf } from "../src/landing.js";

// (the owner: "it's still not clear to me how you navigate to this, and at what level of ux hierarchy this
// belong, and which repo stores its settings, findings, etc"): the Gap finder's runs open under its main-menu page, and a
// persona's card names its page, its instructions file, where its findings are stored and who reads them.

describe("T79-S1 r3 the Gap finder's place", () => {
  it("a /landing/gap-finder/ page opened directly opens under /gap-finder in the console", () => {
    expect(consolePathOf("/landing/gap-finder/")).toBe("/gap-finder");
    expect(consolePathOf("/landing/gap-finder/index.html")).toBe("/gap-finder");
    expect(consolePathOf("/landing/gap-finder/2026-11-08.html")).toBe("/gap-finder/2026-11-08");
    for (const p of ["/landing/gap-finder/runs.json", "/landing/gap-finder/../x.html", "/landing/gap-finder/2026-11.html"]) expect(consolePathOf(p), p).toBeUndefined();
    // the goal graph's pages keep their place
    expect(consolePathOf("/landing/")).toBe("/goal-graph");
  });

  it("the card's from fields carry its page, its instructions, its findings and its readers", () => {
    const c = parseCard(
      [
        "---",
        "row: T79-G20261108",
        "from: Gap finder",
        "from page: /gap-finder",
        "from settings: /milestones/ms_1?tab=personas",
        "from file: [its file](https://github.com/Acme/team/blob/main/state/personas/gap-finder.md)",
        "from findings: Its findings are saved in the home_repo repo, one page a day.",
        "read by: You, the Gap finder on its next run, and the Delivery manager.",
        "---",
      ].join("\n"),
    );
    expect(c?.from).toEqual({
      name: "Gap finder",
      page: "/gap-finder",
      url: "/milestones/ms_1?tab=personas",
      file: "https://github.com/Acme/team/blob/main/state/personas/gap-finder.md",
      stores: "Its findings are saved in the home_repo repo, one page a day.",
      readers: "You, the Gap finder on its next run, and the Delivery manager.",
    });
  });
});
