import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { makeRepo, spineText } from "./reviewFixture.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";

/**
 * the owner opened his campaign link (a milestone of his social world) while his login sat in another of his
 * worlds and saw "no route or id … in this world". A read of another world's id now names that world (404 other_world)
 * when the login belongs to it, so the page switches there; a login outside it still gets the plain 404 cross_tenant.
 */
const MINE = "et-own-0001";
const SOCIAL = "social";
const STRANGER = "es-stranger-0001";
const OUTSIDE = "203.0.113.7";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-otherworld-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  for (const n of [MINE, SOCIAL, STRANGER]) makeRepo(dir, n, { "docs/spines/root.md": spineText("PLAN-0", n, []) });
  const app = createApp(db, { auth: "on", read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  for (const [id, name, skin] of [[MINE, "Own team", "console"], [SOCIAL, "Memo social", "social"], [STRANGER, "A stranger", "social"]])
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, ?, 'internal', ?)").run(id, name, skin, new Date().toISOString());
  const campaign = createStore(db, { tenant: SOCIAL }).createMilestone({ title: "Day in the life", repo: SOCIAL, path: "docs/spines/root.md", owner: "Sam", paused: false });
  const auth = createAuth(db);
  const user = (email: string, worlds: string[]) => {
    let id = "";
    for (const w of worlds) id = auth.addMember({ email, tenant: w, role: "owner" });
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword("correct horse battery"), id);
  };
  const req = async (method: string, url: string, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { method, headers }, { incoming: { socket: { remoteAddress: OUTSIDE } } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const login = async (email: string, tenant: string) => {
    const res = await app.request(
      "/api/access/login",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery", tenant }) },
      { incoming: { socket: { remoteAddress: OUTSIDE } } },
    );
    return (res.headers.get("set-cookie") ?? "").split(";")[0];
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { req, login, user, campaign };
}

describe("a link into another of the login's worlds", () => {
  it("names the world it lives in, for a member of it", async () => {
    const t = setup();
    t.user("owner@example.com", [MINE, SOCIAL]);
    const cookie = await t.login("owner@example.com", MINE);
    const r = await t.req("GET", `/api/milestones/${t.campaign.id}`, { cookie });
    expect(r.status).toBe(404);
    expect(r.json.error).toMatchObject({ code: "other_world", world: SOCIAL, worldName: "Memo social" });
    // in its own world the same id opens
    const there = await t.login("owner@example.com", SOCIAL);
    expect((await t.req("GET", `/api/milestones/${t.campaign.id}`, { cookie: there })).status).toBe(200);
  });

  it("reveals nothing to a login outside that world", async () => {
    const t = setup();
    t.user("stranger@example.com", [STRANGER]);
    const cookie = await t.login("stranger@example.com", STRANGER);
    const r = await t.req("GET", `/api/milestones/${t.campaign.id}`, { cookie });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("cross_tenant");
    expect(JSON.stringify(r.json)).not.toContain(SOCIAL);
  });
});
