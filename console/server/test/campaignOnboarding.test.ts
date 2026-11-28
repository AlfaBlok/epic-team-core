import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ONBOARDING_PLANS_DIR, onboardingSection, onboardingText } from "../src/voice/campaignOnboarding.js";
import { levelKnows, type LevelCard } from "../src/voice/levelCall.js";

/**
 * The owner's voice note: campaign onboarding in phases, a briefing call, our research, then a second
 * call that pitches the campaign. The objective's own Call reads docs/plans/campaign-onboarding/<id>.md and walks it.
 */
let dir = "";
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});
function home(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-onboarding-"));
  fs.mkdirSync(path.join(dir, ONBOARDING_PLANS_DIR), { recursive: true });
  for (const [id, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, ONBOARDING_PLANS_DIR, `${id}.md`), t);
  return dir;
}
const card = (id: string, name: string): LevelCard => ({ id, name, light: "red", krs: "0 of 1", stands: "stands", keyResults: [] }) as unknown as LevelCard;

describe("campaign onboarding on the objective's call", () => {
  it("reads the objective's file and gives the call the three-phase rule once", () => {
    const d = home({ "acme-launch": "# Acme\nPhase now: 3, the pitch.\n## Pitch\n1. What we found", "acme-voice": "# Acme Voice\nPhase now: 1" });
    const s = onboardingSection(d, ["acme-launch", "acme-voice", "acme-launch"]);
    expect(s).toContain("## Campaign onboarding: brief, research, pitch");
    expect(s.match(/three phases/g)?.length).toBe(1);
    expect(s).toContain("Phase now: 3, the pitch.");
    expect(s).toContain("# Acme Voice");
    expect(s).toContain("one slide at a time");
    expect(s).toContain("do we run it for a week");
    expect(s).toContain("lead with the plays we propose");
    expect(s).toContain("Never ask him back what the brief already settled");
    expect(s).toContain("we agree on this call, we do it for seven days, we measure");
  });

  it("says nothing when no objective has a file, or the id is not an objective id", () => {
    const d = home({});
    expect(onboardingSection(d, ["acme-launch"])).toBe("");
    expect(onboardingSection(undefined, ["acme-launch"])).toBe("");
    expect(onboardingText(d, "../secrets")).toBe("");
  });

  it("lands in what the level's call knows, after the plan", () => {
    const d = home({ "acme-launch": "Phase now: 3, the pitch." });
    const k = levelKnows({ level: "objective", name: "Acme: Launch Acme", objectives: [{ card: card("acme-launch", "Acme: Launch Acme") }], asks: [], plan: "## The plan: x", onboarding: onboardingSection(d, ["acme-launch"]) });
    expect(k.indexOf("## The plan: x")).toBeLessThan(k.indexOf("## Campaign onboarding"));
    expect(k).toContain("Phase now: 3, the pitch.");
  });
});
