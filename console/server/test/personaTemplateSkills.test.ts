import { describe, expect, it } from "vitest";
import { listTemplates, parseTemplate, templateDirs } from "../src/personaTemplates.js";

/** a persona template's optional `skills:` frontmatter (epicspine-skill references/personas.md) reaches the template API. */
describe("T53-S2 persona template skills", () => {
  const file = (extra: string) => `---\nname: x\ntemplate: x\nmodel: m\nhost: host1\n${extra}---\n\n## Remit\nr\n\n## Reads\nin\n\n## Writes\nout\n`;

  it("parses an inline or block list; none or empty is []", () => {
    expect(parseTemplate(file(""), "x")!.skills).toEqual([]);
    expect(parseTemplate(file("skills: []\n"), "x")!.skills).toEqual([]);
    expect(parseTemplate(file("skills: [diagram-design, other] # key tools\n"), "x")!.skills).toEqual(["diagram-design", "other"]);
    expect(parseTemplate(file("skills:\n  - diagram-design\n  - 'other'\n"), "x")).toMatchObject({ skills: ["diagram-design", "other"], host: "host1" });
  });

  it("the shipped writer, author and reporter templates declare diagram-design (the writer also branded-shot, T78-S2)", () => {
    const by = Object.fromEntries(listTemplates(templateDirs({})).map((t) => [t.name, t.skills]));
    expect(by.writer).toEqual(["diagram-design", "branded-shot"]); // gave the Writer branded-shot
    expect(by.author).toEqual(["diagram-design"]);
    expect(by.reporter).toEqual(["diagram-design"]);
    expect(by.listener).toEqual([]);
  });
});
