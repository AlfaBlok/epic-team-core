import { describe, expect, it } from "vitest";
import { parseDod } from "../src/dod.js";

describe("parseDod", () => {
  it("reads checklist items under a Definition Of Done heading", () => {
    const md = [
      "# Epic",
      "- [ ] not in dod",
      "## Definition Of Done",
      "",
      "- [x] M2-1 Generic model",
      "- [ ] M2-2 Cycle: wake → pick",
      "  continuation line is ignored",
      "* [X] star bullet",
      "1. [ ] numbered",
      "- plain bullet is ignored",
      "### Sub-section",
      "- [ ] nested heading still counts",
      "## Open Questions",
      "- [ ] after the section",
    ].join("\n");
    expect(parseDod(md)).toEqual({
      done: 2,
      total: 5, tracked: true,
      items: [
        { text: "M2-1 Generic model", checked: true },
        { text: "M2-2 Cycle: wake → pick", checked: false },
        { text: "star bullet", checked: true },
        { text: "numbered", checked: false },
        { text: "nested heading still counts", checked: false },
      ],
    });
  });

  it("accepts Acceptance headings, any case, and multiple sections", () => {
    const md = "### Acceptance criteria\n- [x] a\n# Other\n- [ ] no\n## definition of done (M1)\n- [ ] b\n";
    expect(parseDod(md)).toEqual({
      done: 1,
      total: 2, tracked: true,
      items: [
        { text: "a", checked: true },
        { text: "b", checked: false },
      ],
    });
  });

  it("ignores fenced code and returns empty when there is no section", () => {
    const md = "## Acceptance\n```\n- [x] in code\n## not a heading\n```\n- [ ] real\n";
    expect(parseDod(md).items).toEqual([{ text: "real", checked: false }]);
    expect(parseDod("# Title\n- [x] nope\n")).toEqual({ done: 0, total: 0, items: [] });
    expect(parseDod("")).toEqual({ done: 0, total: 0, items: [] });
  });

  it("handles CRLF line endings", () => {
    expect(parseDod("## Acceptance\r\n- [x] one\r\n").items).toEqual([{ text: "one", checked: true }]);
  });

  it("reads Exit Test / Exit criteria / Success criteria / Done when sections", () => {
    for (const h of ["## Exit Test (\"in control\")", "### Exit criteria", "## Success criteria", "## Done when", "## M2 exit criteria"])
      expect(parseDod(`${h}\n- [x] a\n- [ ] b\n`)).toEqual({ done: 1, total: 2, tracked: true, items: [{ text: "a", checked: true }, { text: "b", checked: false }] });
    expect(parseDod("## Parked (until the exit test passes)\n- x\n")).toEqual({ done: 0, total: 0, items: [] });
  });

  it("returns top-level list items as untracked criteria when there are no checkboxes", () => {
    const md = "## Exit Test\n\nAll five hold:\n\n1. **CPU**: low\n   continuation\n2. **Disk**: ok\n   - nested is ignored\n- bullet\n\nEarliest pass: soon.\n## Rules\n- not dod\n";
    expect(parseDod(md)).toEqual({
      done: 0,
      total: 0,
      tracked: false,
      items: [
        { text: "**CPU**: low", checked: null, id: "1" },
        { text: "**Disk**: ok", checked: null, id: "2" },
        { text: "bullet", checked: null },
      ],
    });
    // Checkboxes anywhere win: plain items are then ignored.
    expect(parseDod("## Exit Test\n1. plain\n## Acceptance\n- [ ] box\n")).toEqual({ done: 0, total: 1, tracked: true, items: [{ text: "box", checked: false }] });
  });

  it("PLAN-2 Exit Test numbered list: untracked, numbers kept as ids, markdown left for the UI", () => {
    const md = '## Exit Test ("in control")\n\n1. **CPU**: <= 1.5 cores\n2. **Disk**: root <= 60%\n3) **Memory**: limits\n10. **Last**\n';
    const d = parseDod(md);
    expect(d).toEqual({
      done: 0,
      total: 0,
      tracked: false,
      items: [
        { text: "**CPU**: <= 1.5 cores", checked: null, id: "1" },
        { text: "**Disk**: root <= 60%", checked: null, id: "2" },
        { text: "**Memory**: limits", checked: null, id: "3" },
        { text: "**Last**", checked: null, id: "10" },
      ],
    });
  });

  it("checkbox items are tracked: true; no criteria leaves tracked absent", () => {
    expect(parseDod("## Acceptance\n- [x] a\n").tracked).toBe(true);
    expect(parseDod("# Nothing\n").tracked).toBeUndefined();
  });
});
