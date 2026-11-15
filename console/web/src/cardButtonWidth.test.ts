import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CARD_BUTTON, CARD_LINK, CardButton } from "@/components/ui/cardButton";

/**
 * The owner, 2026-11-12, phone at 390 px: "Mark complete" broken letter by letter (Mar / k / co / mpl / ete) beside
 * "Not yet" (N / ot / ye / t), then "I'm not gonna press another card until I'm shown buttons that look normal."
 * Every card button in both skins goes through one component, CardButton, whose label stays on one line at its
 * natural width with a 44 px phone tap target. These checks fail when a card button can wrap again.
 * A real-browser check at 390, 360 and 412 px backs this up in the release evidence.
 */
const SRC = __dirname;
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");
const CARD_FILES = ["components/review.tsx", "components/waiting.tsx", "components/askSet.tsx"];

describe("a card button keeps its label on one line at 390 px", () => {
  it("CardButton never wraps, never shrinks, never breaks inside a word, and is 44 px tall on a phone", () => {
    for (const c of ["whitespace-nowrap", "shrink-0", "max-w-full", "[overflow-wrap:normal]", "[word-break:normal]", "max-sm:min-h-11"])
      expect(CARD_BUTTON.split(" "), c).toContain(c);
    expect(CARD_BUTTON).not.toMatch(/\bflex-1\b|whitespace-normal|break-all|break-words/);
    const html = renderToStaticMarkup(createElement(CardButton, null, "Mark complete, start 1"));
    expect(html).toMatch(/data-card-button=""/);
    expect(html).toMatch(/whitespace-nowrap/);
    expect(html).toMatch(/max-sm:min-h-11/);
  });

  it("a caller's class cannot turn wrapping back on", () => {
    const html = renderToStaticMarkup(createElement(CardButton, { className: "h-7 text-xs" }, "Unsnooze"));
    expect(html).toMatch(/whitespace-nowrap/);
    expect(html).not.toMatch(/whitespace-normal/);
  });

  it("the polish sheet lets badges in a card wrap, never a button (the root of the letter-by-letter break)", () => {
    const css = read("polish.css");
    const rules = css.split("}").filter((r) => /white-space:\s*normal/.test(r) && /whitespace-nowrap/.test(r));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) for (const sel of r.split("{")[0].split(/,(?![^(]*\))/)) expect(sel, sel).toMatch(/:not\(button, a, \[data-card-button\]\)/);
  });

  it("every small button in the card files is a CardButton (only the held post's described choices stack on purpose)", () => {
    for (const f of CARD_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/flex-1 sm:flex-none/);
      expect(src, f).not.toMatch(/CARD_BUTTON/);
      // a small Button in a card file must say why it is not a card button (outside a card: the wake button)
      const small = [...src.matchAll(/<Button size="sm"[^>]*>/g)].map((m) => m[0]);
      for (const tag of small) expect(tag, `${f}: ${tag}`).toMatch(/data-testid="wake-now"/);
    }
  });

  it("the green link is its own line (above the buttons), a full tap target on a phone", () => {
    expect(CARD_LINK).not.toMatch(/basis-full|ml-1/);
    expect(CARD_LINK).toMatch(/max-sm:min-h-11/);
  });
});
