import { describe, expect, it } from "vitest";
import { isDoorSafe, isTenantSafe } from "../src/auth/routeScope.js";

// On the social customer site the owner's login is a door (plain) session, judged by TENANT_SAFE and
// DOOR_SAFE. The briefer's state read was on neither, so /marketing got a 403 and drew no Call button at all.
const both = (m: string, p: string) => isTenantSafe(m, p) && isDoorSafe(m, p);

describe("the social briefer's Call reaches the door", () => {
  it("every call route of /api/voice/marketing is on both lists", () => {
    for (const [m, p] of [
      ["GET", "/api/voice/marketing/state"],
      ["GET", "/api/voice/marketing/calls"],
      ["POST", "/api/voice/marketing/calls"],
      ["POST", "/api/voice/marketing/active/end"],
      ["POST", "/api/voice/marketing/calls/vc_1/beat"],
      ["POST", "/api/voice/marketing/calls/vc_1/usage"],
      ["POST", "/api/voice/marketing/calls/vc_1/end"],
      ["POST", "/api/voice/marketing/calls/vc_1/ask"],
      ["POST", "/api/voice/marketing/calls/vc_1/tool"],
      ["POST", "/api/voice/marketing/calls/vc_1/relay"],
      ["GET", "/api/voice/marketing/calls/vc_1/status"],
      ["GET", "/api/voice/marketing/calls/vc_1/ask/a_1"],
    ])
      expect(both(m, p), `${m} ${p}`).toBe(true);
  });
  it("only the briefer: the other own calls stay off the door", () => {
    for (const p of ["/api/voice/strategy/state", "/api/voice/briefing/state", "/api/voice/marketing/secret", "/api/voice/marketing/calls/a/b/end"])
      expect(both("GET", p), p).toBe(false);
  });
});
