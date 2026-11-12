import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { deskSeed, endpointLines, updateMessage } from "../src/desk/desk.js";
import { milestoneEndpointLines, milestoneSeed, milestoneUpdateMessage } from "../src/desk/milestoneChat.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { intakeSection, intakeSections, packIntakeRunner, packsOn } from "../src/desk/packIntake.js";

// the desks carry the desk intake rule (pack.py <pack> --wake-text) of every repo with a pack on, and say where
// each message landed.
const WAKE = "## Desk intake (pack social): 6 kinds\nKinds: Brief change, Key message, Priority, Idea, Big idea → epic, Feedback on a post.\n";
const BASE = "http://127.0.0.1:18799";
const persona = { name: "Team desk", remit: "Be the desk." };

let tmp: string;
let skill: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e34s10-"));
  for (const repo of ["social", "plain"]) {
    fs.mkdirSync(path.join(tmp, repo), { recursive: true });
    execFileSync("git", ["-C", path.join(tmp, repo), "init", "-q", "-b", "main"]);
  }
  fs.writeFileSync(path.join(tmp, "social", "AGENTS.md"), "# Agents\n\nIntegration policy: main-direct\nPack: `social`\n");
  fs.writeFileSync(path.join(tmp, "plain", "AGENTS.md"), "# Agents\n\nIntegration policy: main-direct\n");
  // A stand-in skill: pack.py prints the wake text for social and fails for any other pack (no intake).
  skill = path.join(tmp, "skill");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skill, "scripts", "pack.py"),
    `import sys\nif sys.argv[1:] == ['social', '--wake-text']:\n    sys.stdout.write(${JSON.stringify(WAKE)})\nelse:\n    sys.exit(1)\n`,
  );
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("E934-S10 packs on and the wake text", () => {
  it("reads the AGENTS.md opt-in like pack.py does", () => {
    expect(packsOn(path.join(tmp, "social"))).toEqual(["social"]);
    expect(packsOn(path.join(tmp, "plain"))).toEqual([]);
    expect(packsOn(path.join(tmp, "missing"))).toEqual([]);
    fs.writeFileSync(path.join(tmp, "plain", "AGENTS.md"), "EpicSpine packs: Social, sales\nPack: social\n");
    expect(packsOn(path.join(tmp, "plain"))).toEqual(["social", "sales"]);
  });

  it("runs pack.py <pack> --wake-text; a pack without intake gives nothing", async () => {
    const run = packIntakeRunner(skill);
    expect(await run("social")).toBe(WAKE.trim());
    expect(await run("sales")).toBeUndefined();
    expect(await run("../evil")).toBeUndefined();
    expect(await packIntakeRunner(path.join(tmp, "no-skill"))("social")).toBeUndefined();
  });

  it("one section per repo with a pack on, naming the repo, its GitHub links and the where-it-landed reply", async () => {
    const run = packIntakeRunner(skill);
    const s = (await intakeSection({ name: "social", path: path.join(tmp, "social"), remote: "Acme/social" }, run))!;
    expect(s.startsWith("## Desk intake: social (pack social)\n")).toBe(true);
    expect(s).toContain("https://github.com/Acme/social/blob/main/<path>#<anchor>");
    expect(s).toContain("states, first, where it landed: the kind, the file and section, the link");
    expect(s).toContain("Big idea → epic");
    expect(s).not.toContain("## Desk intake (pack social)"); // the pack's own heading is replaced by the repo's
    expect(await intakeSection({ name: "plain", path: path.join(tmp, "plain") }, run)).toBeUndefined();
    const all = await intakeSections(
      [
        { name: "plain", path: path.join(tmp, "plain") },
        { name: "social", path: path.join(tmp, "social") },
      ],
      run,
    );
    expect(all!.match(/^## Desk intake: /gm)).toHaveLength(1);
    expect(all).toContain("the repo path with its #anchor (social has no GitHub remote)");
  });
});

describe("E934-S10 the desk prompts carry it", () => {
  const section = "## Desk intake: social (pack social)\nBrief change …";

  it("Team desk: seed and update carry the intake section when a repo has the pack on, nothing otherwise", () => {
    const seed = deskSeed({ persona, publicUrl: BASE, reposRoot: tmp, intake: section });
    expect(seed).toContain(section);
    expect(seed.indexOf(section)).toBeLessThan(seed.indexOf("Reply to this message with one line"));
    expect(deskSeed({ persona, publicUrl: BASE, reposRoot: tmp })).not.toMatch(/^## Desk intake/m);
    expect(updateMessage(BASE, section)).toContain(section);
    expect(updateMessage(BASE)).not.toMatch(/^## Desk intake/m);
  });

  it("Repo desk: seed and update carry the milestone repo's intake section", () => {
    const m = { id: "m1", title: "Memo social", repo: "social" };
    const seed = milestoneSeed({ persona: { name: "Repo desk", remit: "r" }, milestone: m, publicUrl: BASE, repoDir: path.join(tmp, "social"), rel: "docs/spines/root.md", intake: section });
    expect(seed).toContain(section);
    expect(milestoneSeed({ persona: { name: "Repo desk", remit: "r" }, milestone: m, publicUrl: BASE })).not.toMatch(/^## Desk intake/m);
    expect(milestoneUpdateMessage(BASE, m, "r", section)).toContain(section);
  });
});

describe("E934-S10 a pack turned on later still reaches a live thread", () => {
  it("both endpoint lists (seed + every update) tell the desk to read pack.py --wake-text for a repo with a pack on", () => {
    for (const lines of [endpointLines(BASE), milestoneEndpointLines(BASE, { id: "m1" })]) {
      const line = lines.find((l) => l.startsWith("- Desk intake"))!;
      expect(line).toContain("pack.py <name> --wake-text");
      expect(line).toContain("reply first with where it landed");
    }
  });
});

describe("E934-S10 wired in the console", () => {
  it("the Team desk's launch seed carries the social repo's intake (skill dir from the read config)", async () => {
    const launched: string[] = [];
    const t3 = {
      listProjects: async () => [{ id: "p_home_repo", title: "home_repo", workspaceRoot: path.join(tmp, "home_repo"), repositoryIdentity: { displayName: "acme/home_repo" } }],
      listScheduledTasks: async () => [],
      updateScheduledTask: async () => undefined,
      deleteScheduledTask: async () => {},
      runScheduledTaskNow: async () => {},
      launchThread: async (i: { message?: string }) => (launched.push(i.message ?? ""), { threadId: "desk_1" }),
      sendToThread: async () => {},
      readThreadStatus: async () => ({ status: "idle", raw: {} }),
      readThreadMessages: async () => ({ messages: [], nextPosition: null, hasMore: false, archived: false }),
    } as unknown as T3Client;
    const dispatcher: Dispatcher = { pick: async () => ({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" }), done: async () => {} } as Dispatcher;
    const db = openDb(path.join(tmp, "console.db"));
    try {
      const read = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], skillDir: skill };
      const app = createApp(db, { read, cycle: { enabled: true, t3, dispatcher, publicUrl: BASE, runState: async () => undefined } });
      expect((await app.request("/api/desk/messages")).status).toBe(200);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toContain("## Desk intake: social (pack social)");
      expect(launched[0]).toContain("Big idea → epic");
      expect(launched[0]).not.toContain("Desk intake: plain");
    } finally {
      db.close();
    }
  });
});
