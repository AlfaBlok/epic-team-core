import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { makeRepo, spineText } from "./reviewFixture.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";
import { homeRepo, socialProduct } from "../src/identity.js";

/**
 * the owner opened the social product and its sidebar listed the home world's objectives (28 Nov). The engine is one: an owner login in his own social world reads only the
 * objectives of the social product (named "<product>: …"); the home world still reads every objective, and a world of
 * his in another skin reads none of the home world's.
 */
const SOCIAL = "own-social";
const OTHER = "own-other";
const OUTSIDE = "203.0.113.7";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-social-objectives-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const line = { label: "One thing", from: "check", check: "k" };
  makeRepo(dir, homeRepo(), {
    "docs/spines/root.md": spineText("PLAN-0", homeRepo(), []),
    "docs/pursuits.json": JSON.stringify({
      pursuits: [
        { id: "team-understand", name: "Team: Get the team to understand me", greenWhen: "x", lines: [line] },
        { id: "social-launch", name: `${socialProduct()}: Launch ${socialProduct()}`, greenWhen: "x", lines: [line] },
        { id: "house", name: "House: Buy a house", greenWhen: "x", lines: [line] },
      ],
    }),
  });
  for (const n of [SOCIAL, OTHER]) makeRepo(dir, n, { "docs/spines/root.md": spineText("PLAN-0", n, []) });
  const app = createApp(db, { auth: "on", read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  for (const [id, skin] of [[SOCIAL, "social"], [OTHER, "console"]])
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, ?, 'internal', ?)").run(id, id, skin, new Date().toISOString());
  const auth = createAuth(db);
  let uid = "";
  for (const w of [SOCIAL, OTHER]) uid = auth.addMember({ email: "owner@example.com", tenant: w, role: "owner" });
  db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword("correct horse battery"), uid);
  const env = { incoming: { socket: { remoteAddress: OUTSIDE } } };
  const login = async (tenant: string) =>
    ((await app.request("/api/access/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery", tenant }) }, env)).headers.get("set-cookie") ?? "").split(";")[0];
  const get = async (url: string, cookie: string) => {
    const res = await app.request(url, { headers: { cookie } }, env);
    return { status: res.status, json: (await res.json()) as { nodes?: { name: string }[]; pursuits?: { name: string }[] } };
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { login, get };
}

describe("the social world reads only its own product's objectives", () => {
  it("lists only the social product's objective on the scorecards and the pursuits", async () => {
    const t = setup();
    const cookie = await t.login(SOCIAL);
    const cards = await t.get("/api/scorecards", cookie);
    expect(cards.status).toBe(200);
    expect(cards.json.nodes?.map((n) => n.name)).toEqual([`${socialProduct()}: Launch ${socialProduct()}`]);
    const ps = await t.get("/api/pursuits", cookie);
    expect(ps.status).toBe(200);
    expect(ps.json.pursuits?.map((p) => p.name)).toEqual([`${socialProduct()}: Launch ${socialProduct()}`]);
  });
  it("a world of his in another skin reads none of the home world's objectives", async () => {
    const t = setup();
    const cookie = await t.login(OTHER);
    const cards = await t.get("/api/scorecards", cookie);
    expect(cards.status).toBe(200);
    expect(cards.json.nodes).toEqual([]);
  });
});
