import fs from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CALL_POSTS, isDoorSafe, isTenantSafe, judge } from "../src/auth/routeScope.js";

/**
 * The call page's lookup POST was once on none of the call doors, so from the owner's login on the social site every
 * lookup (the posts board, switch_to) came back 403 world_scope. Every POST a call's page sends on its call is on one
 * shared list, and that list holds every one routes.ts mounts.
 */
describe("every call route a page sends is on the call doors", () => {
  it("CALL_POSTS holds every POST routes.ts mounts under /calls/:cid/", () => {
    const routes = fs.readFileSync(new URL("../src/voice/routes.ts", import.meta.url), "utf8");
    const mounted = [...routes.matchAll(/api\.post\(\s*`\$\{prefix\}\/calls\/:cid\/([a-z-]+)`/g)].map((m) => m[1]);
    expect(mounted).toContain("lookup");
    const listed = CALL_POSTS.split("|");
    for (const r of mounted) expect(listed, r).toContain(r);
  });

  it("the social briefer call's lookup reaches the door and a customer world's owner", () => {
    for (const p of ["/api/voice/marketing/calls/vc_1/lookup", "/api/objectives/o_1/voice/calls/vc_1/lookup", "/api/voice/marketing/calls/warm", "/api/objectives/o_1/voice/calls/warm"]) {
      expect(isTenantSafe("POST", p), p).toBe(true);
      expect(isDoorSafe("POST", p), p).toBe(true);
    }
  });

  it("the owner's social site login (an owner session in the social world) gets every lookup", () => {
    const db = new Database(":memory:");
    const him = { kind: "session", tenant: "w-social", userId: "u1", email: "owner-social@example.com", name: "Sam", role: "owner" } as any;
    // the page-open link: refused, his call waited for a fresh link at every press
    expect(judge(db as any, him, "POST", "/api/voice/marketing/calls/warm").allow).toBe(true);
    for (const p of ["lookup", "relay", "tool", "beat", "end"]) {
      const v = judge(db as any, him, "POST", `/api/voice/marketing/calls/vc_1/${p}`);
      expect(v.allow, `${p}: ${JSON.stringify(v)}`).toBe(true);
    }
    // the guard still holds what it held: another part of the console stays off
    expect(judge(db as any, him, "POST", "/api/voice/marketing/calls/vc_1/secret").allow).toBe(false);
  });
});
