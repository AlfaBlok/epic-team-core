import { describe, expect, it } from "vitest";
import { homeRepo } from "../src/identity.js";
import { DESK_CHECKOUTS, endpointLines, ownCheckoutLine, SEED_VERSION, updateMessage } from "../src/desk/desk.js";

// the desk writes from its own checkout, never a folder other agents work in (the desk audit, failure 37).
describe("the Team desk writes only in its own checkouts", () => {
  const seed = endpointLines("http://c").join("\n");
  it("tells the desk to sync and write in its own clones, never in ~/github/<repo>", () => {
    expect(seed).toContain(ownCheckoutLine());
    expect(ownCheckoutLine()).toContain(`python3 ${DESK_CHECKOUTS}/${homeRepo()}/scripts/desk_checkout.py sync`);
    expect(ownCheckoutLine()).toContain("never write there");
    expect(SEED_VERSION).toBeGreaterThanOrEqual(56);
    expect(updateMessage("http://c")).toContain(ownCheckoutLine());
  });
  it("runs every script that commits from its own clone and names no shared checkout to write in", () => {
    for (const s of ["desk_note.py send", "his_words.py set", "understood.py write", "x_links.py add", "ticket_context.py write"]) {
      const at = seed.indexOf(s);
      expect(at, s).toBeGreaterThan(-1);
      expect(seed.slice(Math.max(0, seed.lastIndexOf("python3", at)), at), s).toContain(`${DESK_CHECKOUTS}/`);
    }
    expect(seed).not.toMatch(/~\/github\/[a-z_]+\/scripts\/(?!desk_checkout\.py)[a-z_]+\.py/);
    expect(seed).not.toContain("--repo ~/github/");
    expect(seed).not.toContain("~/github/team/desk/voice-passes");
  });
});
