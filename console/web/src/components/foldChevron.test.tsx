// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import fs from "node:fs";
import path from "node:path";
import { FoldChevron } from "@/components/foldChevron";

/**
 * The owner (22 Nov: card headings unfold on click "but nothing shows it"): one shared chevron on every
 * foldable heading, right when closed, down when open, the state on aria-expanded.
 */
afterEach(cleanup);

function Fold() {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      <FoldChevron open={open} />
      A card heading
    </button>
  );
}

describe("the shared fold chevron", () => {
  it("is hidden from screen readers and turns when its heading opens (aria-expanded says the state)", () => {
    render(<Fold />);
    const btn = screen.getByRole("button", { name: "A card heading" });
    const chev = screen.getByTestId("fold-chevron");
    expect(chev.getAttribute("aria-hidden")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(chev.dataset.open).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(chev.dataset.open).toBe("true");
  });

  it("inside a <summary> it leaves the state to the <details> (no data-open)", () => {
    render(
      <details>
        <summary>
          <FoldChevron /> Details
        </summary>
      </details>,
    );
    expect(screen.getByTestId("fold-chevron").hasAttribute("data-open")).toBe(false);
  });

  it("points right closed and turns down open, with a short rotate, and every <summary> gets it by itself", () => {
    const css = fs.readFileSync(path.join(__dirname, "../polish.css"), "utf8");
    expect(css).toMatch(/\.fold-chevron, summary:not\(:has\(\.fold-chevron\)\)::before \{/);
    expect(css).toMatch(/\.fold-chevron\[data-open="true"\][^{]*details\[open\] > summary:not\(:has\(\.fold-chevron\)\)::before \{ transform: rotate\(90deg\); \}/);
    expect(css).toMatch(/summary::-webkit-details-marker \{ display: none; \}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.fold-chevron, summary::before \{ transition: none; \}/);
  });

  it("is the one fold mark in the app: every file with a fold button uses it, no hand-made open/closed chevron pair", () => {
    // a menu (aria-haspopup) or a button that opens a box is not a fold heading
    const NOT_A_FOLD = new Set(["WordsBox.tsx", "tabFold.tsx", "cardFeedback.tsx", "Pipeline.tsx"]);
    const roots = [path.join(__dirname, ".."), path.join(__dirname, "../../../../../hosted/console/web/src")];
    const files: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) files.push(p);
      }
    };
    roots.forEach(walk);
    const missing: string[] = [];
    const pairs: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (/\?\s*<ChevronDown[^>]*\/>\s*:\s*<ChevronRight/.test(src)) pairs.push(path.basename(f));
      if (NOT_A_FOLD.has(path.basename(f))) continue;
      if (/aria-expanded=/.test(src) && !/<FoldChevron\b/.test(src)) missing.push(path.basename(f));
    }
    expect(pairs).toEqual([]);
    expect(missing).toEqual([]);
  });
});
