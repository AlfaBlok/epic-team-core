import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app stays minimal (docs/design/console.md: one face, Inter; the console's own dark and light tokens). The paper
 * design (warm off-white, a paper serif, the house ink and green) is for the memory product, decks and internal
 * pages only. This check fails when a paper face, a serif class or a paper colour appears in an app screen of
 * either skin. The only places allowed are the internal deck pages listed below.
 * The owner, 2026-11-12: "Let's keep it minimal and elegant and clean and simple."
 */
const SRC = __dirname;

// the internal deck pages (the Epic Book's decks and the big rocks board) and their shared palette, and the two frames
// that show an internal paper page (the memory graph, the gap finder's notes) on a matching ground while it loads.
const ALLOWED = new Set(["lib/deck.ts", "pages/EpicDeck.tsx", "pages/BigRocks.tsx", "pages/GoalGraph.tsx", "pages/GapFinder.tsx"]);

const MARKERS: [string, RegExp][] = [
  ["a paper serif face", /\b(Newsreader|Fraunces)\b/],
  ["a serif face", /\bGeorgia\b|ui-serif|["'\s]serif["'\s,;)]/],
  ["the serif class", /\bfont-serif\b/],
  ["the paper palette", /#(F5F3EE|ECE9E2|E3EFE8|1F5F4A|123D30|f6f1e7|faf8f3|faf7f0|fffdf8|f1ebdf)\b/i],
  ["a paper ground variable", /--paper\b/],
  ["the deck's paper or serif constants", /\b(PAPER|SERIF)\b.*from ["']@\/lib\/deck["']|from ["']@\/lib\/deck["'].*\b(PAPER|SERIF)\b/],
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "assets" ? [] : files(p);
    return /\.(tsx?|css)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}

// the pages the server renders for outsiders of either skin, outside the web build: a tester's voice feedback link
// They follow the same rule (paths from core/console/web/src).
const SERVER_PAGES = ["../../server/src/voiceFeedback.ts"];

/** every paper marker in the app's own source (and the given server pages), as "file:line what". */
export function paperCreep(src = SRC, extra: string[] = src === SRC ? SERVER_PAGES.map((p) => path.join(SRC, p)) : []): string[] {
  const hits: string[] = [];
  for (const f of [...files(src), ...extra]) {
    const rel = path.relative(src, f).split(path.sep).join("/");
    if (ALLOWED.has(rel)) continue;
    fs.readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // comments may name the paper style ("paper is for decks"); only code counts.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/^\s*\*.*$/, "");
        for (const [what, re] of MARKERS) if (re.test(code)) hits.push(`${rel}:${i + 1} ${what}`);
      });
  }
  return hits;
}

describe("no paper design in the app (both skins stay minimal)", () => {
  it("no app screen uses a paper face, a serif or the paper palette", () => {
    expect(paperCreep()).toEqual([]);
  });

  it("the voice feedback page testers open is in the scan and clean", () => {
    for (const p of SERVER_PAGES) expect(fs.existsSync(path.join(SRC, p))).toBe(true);
    expect(paperCreep().filter((h) => h.startsWith("../../server/"))).toEqual([]);
  });

  it("the face list has no serif family", () => {
    const tw = fs.readFileSync(path.join(SRC, "../tailwind.config.js"), "utf8");
    expect(tw).not.toMatch(/serif:\s*\[|Newsreader|Fraunces/);
  });

  it("catches a paper element if one comes back", () => {
    const dir = fs.mkdtempSync(path.join(SRC, "..", "node_modules", ".paper-check-"));
    try {
      fs.writeFileSync(path.join(dir, "Bad.tsx"), 'export const X = () => <h2 className="font-serif" style={{ background: "#F5F3EE" }}>Hi</h2>;\n');
      fs.writeFileSync(path.join(dir, "Ring.tsx"), 'export const R = () => <text style={{ font: "500 1rem Newsreader, Georgia, serif" }}>1</text>;\n');
      fs.writeFileSync(path.join(dir, "Ok.tsx"), "// paper is for decks; Newsreader in a comment is fine\nexport const O = () => <h2 className=\"font-sans\">Hi</h2>;\n");
      fs.writeFileSync(path.join(dir, "page.ts"), 'const css = ":root{--paper:#f6f1e7}h1{font:600 1.9rem/1.2 Georgia,serif}";\n');
      const hits = paperCreep(dir, [path.join(dir, "page.ts")]);
      expect(hits).toContain("Bad.tsx:1 the serif class");
      expect(hits).toContain("Bad.tsx:1 the paper palette");
      expect(hits).toContain("Ring.tsx:1 a paper serif face");
      expect(hits).toContain("page.ts:1 a serif face");
      expect(hits).toContain("page.ts:1 a paper ground variable");
      expect(hits.some((h) => h.startsWith("Ok.tsx"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
