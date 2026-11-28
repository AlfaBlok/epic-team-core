import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boardManager, facePath, faceUrl, managerByName, managerOfObjective, readManagers, teamLine } from "../src/voice/managers.js";

// the people he calls by name and face: "pass me to <name>" on a call.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "managers-"));
fs.mkdirSync(path.join(home, "docs/personas"), { recursive: true });
fs.writeFileSync(path.join(home, "docs/personas/face-alex.webp"), "x");
fs.writeFileSync(
  path.join(home, "docs/personas/managers.json"),
  JSON.stringify({
    managers: [
      { id: "sam", name: "Sam", role: "board" },
      { id: "alex", name: "Alex", role: "campaign", objective: "launch-acme", face: "docs/personas/face-alex.webp" },
      { id: "lucia", name: "Lucía", role: "campaign", objective: "market-bolt", face: "../../etc/passwd" },
      { id: "Bad Id", name: "X", role: "campaign" },
    ],
  }),
);

describe("the people he calls", () => {
  const all = readManagers(home);
  it("reads the list, dropping a broken entry", () => {
    expect(all.map((m) => m.id)).toEqual(["sam", "alex", "lucia"]);
    expect(readManagers(undefined)).toEqual([]);
    expect(readManagers(path.join(home, "nowhere"))).toEqual([]);
  });
  it("finds a manager by the name he says, accents or not", () => {
    expect(managerByName(all, "pass me to Alex please")?.objective).toBe("launch-acme");
    expect(managerByName(all, "Lucia")?.objective).toBe("market-bolt");
    expect(managerByName(all, "sam")?.role).toBe("board");
    expect(managerByName(all, "Acme: Launch Acme")).toBeUndefined();
  });
  it("serves a face only from docs/personas", () => {
    const alex = managerOfObjective(all, "launch-acme");
    expect(faceUrl(alex)).toBe("/api/managers/alex/face");
    expect(facePath(home, alex)).toBe(path.join(home, "docs/personas/face-alex.webp"));
    expect(facePath(home, managerOfObjective(all, "market-bolt"))).toBeUndefined();
    expect(boardManager(all)?.name).toBe("Sam");
  });
  it("tells the call the team by name", () => {
    const line = teamLine(all, (id) => (id === "launch-acme" ? "Acme: Launch Acme" : undefined), true);
    expect(line).toContain("Sam is the board manager, over all his objectives (you start as him)");
    expect(line).toContain("Alex is the campaign manager of Acme: Launch Acme");
    expect(line).toContain("Lucía is the campaign manager of market-bolt");
    expect(teamLine([], () => undefined, true)).toBe("");
  });
});
