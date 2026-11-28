import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blueprintRel, parseBlueprint, readBlueprint } from "../src/blueprint.js";

// an EpicTeam objective's Blueprint chapter (his 28 Nov 12:47Z words, ^e-497258).
describe("Blueprint chapter", () => {
  it("reads what is being built, its hard truths and its parts", () => {
    const b = parseBlueprint("# Blueprint: X\n\nOne console.\n\n## Hard truths\n- One engine.\n- The repo is the source.\n\n## Blueprint\n- Console: screens.\n", "p.md");
    expect(b).toEqual({ path: "p.md", present: true, what: "One console.", truths: ["One engine.", "The repo is the source."], parts: ["Console: screens."] });
  });
  it("says not present when the file is missing, and refuses an id that is not one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-"));
    expect(readBlueprint(dir, "one-engine")).toEqual({ path: blueprintRel("one-engine"), present: false, truths: [], parts: [] });
    expect(readBlueprint(dir, "../x")).toBeUndefined();
    fs.mkdirSync(path.join(dir, path.dirname(blueprintRel("a"))), { recursive: true });
    fs.writeFileSync(path.join(dir, blueprintRel("a")), "# B\n\n## Hard truths\n- T\n");
    expect(readBlueprint(dir, "a")).toMatchObject({ present: true, truths: ["T"], parts: [] });
    fs.mkdirSync(path.join(dir, "docs/blueprint"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/blueprint/README.md"), "# How it is built\n");
    expect(readBlueprint(dir, "a")?.engine).toEqual({ path: "docs/blueprint/README.md", text: "# How it is built\n" });
    expect(readBlueprint(dir, "none")).toMatchObject({ present: false, engine: { path: "docs/blueprint/README.md" } });
  });
});
