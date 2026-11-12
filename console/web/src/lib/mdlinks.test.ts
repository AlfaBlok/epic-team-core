import { describe, expect, it } from "vitest";
import { hasInlineLinks, linkSegments, safeHref } from "@/lib/mdlinks";

const base = { remote: "Acme/epicspine-skill", path: "docs/PLAN-4-DOCTRINE-2.md" };
const blob = "https://github.com/Acme/epicspine-skill/blob/HEAD/";

describe("safeHref (T6-S3)", () => {
  it("keeps http/https, refuses other schemes and protocol-relative", () => {
    expect(safeHref("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(safeHref("http://x.io/a?b=1#c")).toBe("http://x.io/a?b=1#c");
    for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "mailto:a@example.com", "vbscript:x", "file:///etc/passwd", "//evil.com/x", "java\tscript:alert(1)", " javascript:alert(1)"])
      expect(safeHref(bad, base), bad).toBeUndefined();
  });

  it("resolves repo-relative targets against the spine's folder, `/` against the repo root", () => {
    expect(safeHref("doctrine/evidence/a.png", base)).toBe(`${blob}docs/doctrine/evidence/a.png`);
    expect(safeHref("./root/x.md#part", base)).toBe(`${blob}docs/root/x.md#part`);
    expect(safeHref("../README.md", base)).toBe(`${blob}README.md`);
    expect(safeHref("/skill/SKILL.md", base)).toBe(`${blob}skill/SKILL.md`);
    expect(safeHref("#outcome", base)).toBe(`${blob}docs/PLAN-4-DOCTRINE-2.md#outcome`);
  });

  it("refuses paths escaping the repo, and relative targets without a remote", () => {
    expect(safeHref("../../etc/passwd", base)).toBeUndefined();
    expect(safeHref("docs/a.md")).toBeUndefined();
    expect(safeHref("docs/a.md", { remote: "not a remote" })).toBeUndefined();
  });
});

describe("linkSegments (T6-S3)", () => {
  it("turns Markdown links into labelled links and keeps surrounding text", () => {
    expect(linkSegments("[evidence](root/dod-evidence-2026-10-24.md): 61 lines", base)).toEqual([
      { text: "evidence", href: `${blob}docs/root/dod-evidence-2026-10-24.md` },
      { text: ": 61 lines" },
    ]);
    expect(linkSegments("see [PR](https://github.com/o/r/pull/3) and ![shot](a.png)", base)).toEqual([
      { text: "see " },
      { text: "PR", href: "https://github.com/o/r/pull/3" },
      { text: " and " },
      { text: "shot", href: `${blob}docs/a.png` },
    ]);
  });

  it("links bare URLs, leaving trailing punctuation as text", () => {
    expect(linkSegments("live at https://team.example.com/x. done")).toEqual([
      { text: "live at " },
      { text: "https://team.example.com/x", href: "https://team.example.com/x" },
      { text: ". done" },
    ]);
  });

  it("an unsafe target keeps only its label as text; HTML stays literal text", () => {
    expect(linkSegments("[click](javascript:alert(1)) <img src=x onerror=alert(1)>", base)).toEqual([
      { text: "click <img src=x onerror=alert(1)>" },
    ]);
    expect(linkSegments("[x](data:text/html,hi) <script>alert(1)</script>")).toEqual([{ text: "x <script>alert(1)</script>" }]);
  });

  it("hasInlineLinks: Markdown links or an embedded URL; a lone URL / sha / path is left to evidenceLink", () => {
    expect(hasInlineLinks("[a](b.md)")).toBe(true);
    expect(linkSegments("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([{ text: "Foo", href: "https://en.wikipedia.org/wiki/Foo_(bar)" }]);
    expect(hasInlineLinks("deployed, see https://x.io")).toBe(true);
    expect(hasInlineLinks("https://x.io/a")).toBe(false);
    expect(hasInlineLinks("0891cbb")).toBe(false);
    expect(hasInlineLinks("docs/a.md")).toBe(false);
  });
});
