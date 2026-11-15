import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { judge } from "../src/auth/routeScope.js";
import type { Identity } from "../src/auth/identity.js";

/**
 * the owner's objectives in the owner's own worlds: the owner's login on the social site lands in a world of its own,
 * where GET /api/scorecards answered 403 world_scope and the sidebar drew no objective. An owner login in one of the
 * owner's own worlds (plan internal) now reads them; a customer's world, a member, a door session and an agent token
 * still get 403, and nothing else opens.
 */
function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-owner-objectives-"));
  const d = openDb(path.join(dir, "console.db"));
  const at = new Date().toISOString();
  d.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('own-social', 'own', 'social', 'internal', ?)").run(at);
  d.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('customer', 'c', 'console', 'team', ?)").run(at);
  return d;
}
const session = (tenant: string, role: "owner" | "member" = "owner", door?: true): Identity => ({ kind: "session", tenant, userId: "u", email: "e@x", name: "n", role: role as never, ...(door ? { door } : {}) });

describe("the owner's objectives in his own worlds", () => {
  const d = db();
  it("an owner login in his own social world reads the objectives and the pursuits", () => {
    expect(judge(d, session("own-social"), "GET", "/api/scorecards")).toEqual({ allow: true });
    expect(judge(d, session("own-social"), "GET", "/api/pursuits")).toEqual({ allow: true });
  });
  // selecting an objective on the social site shows its Social kit tab, so the kit, its previews and its fonts read there too.
  it("an owner login in his own social world reads an objective's social kit, its previews and fonts", () => {
    expect(judge(d, session("own-social"), "GET", "/api/pursuits/goal-1/kit")).toEqual({ allow: true });
    expect(judge(d, session("own-social"), "GET", "/api/pursuits/goal-1/kit/previews/avatar.webp")).toEqual({ allow: true });
    expect(judge(d, session("own-social"), "GET", "/api/pursuits/goal-1/kit/fonts/serif.woff2")).toEqual({ allow: true });
    expect(judge(d, session("customer"), "GET", "/api/pursuits/goal-1/kit")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social", "owner", true), "GET", "/api/pursuits/goal-1/kit")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social"), "GET", "/api/pursuits/goal-1/kit/other/x.webp")).toMatchObject({ allow: false, status: 403 });
  });
  it("a customer's world, a member, a door login and an agent token stay refused", () => {
    expect(judge(d, session("customer"), "GET", "/api/scorecards")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social", "member"), "GET", "/api/scorecards")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social", "owner", true), "GET", "/api/scorecards")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, { kind: "token", tenant: "own-social", tokenId: "t", label: "x" }, "GET", "/api/scorecards")).toMatchObject({ allow: false, status: 403 });
  });
  it("only the reads open: writes and other routes stay home-world only", () => {
    expect(judge(d, session("own-social"), "POST", "/api/pursuits/order")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social"), "GET", "/api/spine-tree-nope")).toMatchObject({ allow: false, status: 403 });
  });
});
