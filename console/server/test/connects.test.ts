import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { forTenant } from "../src/store.js";
import { ensureAuth } from "../src/auth/schema.js";
import { mountAuth } from "../src/auth/gate.js";
import { mountOAuth, type CredsOf } from "../src/auth/oauth.js";
import type { ConnectSpec } from "../src/auth/connects.js";
import { YOUTUBE_SCOPES } from "../src/auth/youtubeConnect.js";

/** One-button connects (auth/connects.ts) on the console's own Google client (fake Google answers). */
const TEAM = "cloud.example.com";
const CLIENT = "123456789012-abc.apps.googleusercontent.com";
const CREDS: CredsOf = async () => ({ clientId: CLIENT, clientSecret: "csecret" });
const MAIL = ["https://example.test/auth/gmail.readonly"];
const CONNECTS: ConnectSpec[] = [
  { id: "sam-youtube", provider: "google", title: "Connect Sam YouTube", what: "Posts Sam's Shorts.", account: "owner@example.com", channel: { name: "Sam", handle: "@SamShorts", id: "UC1" }, scopes: YOUTUBE_SCOPES, keys: { clientId: "YT_ID", clientSecret: "YT_SECRET", refreshToken: "YT_REFRESH" }, check: "youtube-channel" },
  { id: "sam-mail", provider: "google", title: "Connect Sam mail", what: "Reads Sam's mail.", account: "owner@example.com", scopes: MAIL, keys: { clientId: "M_ID", clientSecret: "M_SECRET", refreshToken: "M_REFRESH" } },
];
const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(o: { handle?: string; scopes?: string[]; apiOff?: number; enableStatus?: number; store?: boolean; email?: string; mode?: "on" | "off" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-connects-"));
  dirs.push(dir);
  const db = openDb(path.join(dir, "console.db"));
  dbs.push(db);
  ensureAuth(db);
  const app = new Hono();
  const api = new Hono();
  const auth = mountAuth(app, api, { db, store: forTenant(db, "home"), mode: o.mode ?? "on" });
  const calls: { url: string; body: string }[] = [];
  let apiOff = o.apiOff ?? 0;
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? String(init.body) : "";
    calls.push({ url: u, body });
    if (u.endsWith("/token")) {
      const b = new URLSearchParams(body);
      if (b.get("grant_type") === "refresh_token") return ok({ access_token: "yat2" });
      return ok({ access_token: "yat", refresh_token: "yrt", scope: (o.scopes ?? [...YOUTUBE_SCOPES, ...MAIL]).join(" ") });
    }
    if (u.includes("/youtube/v3/channels")) {
      if (apiOff > 0) {
        apiOff--;
        return ok({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }], details: [{ reason: "SERVICE_DISABLED" }] } }, 403);
      }
      return ok({ items: [{ snippet: { customUrl: `@${o.handle ?? "SamShorts"}`, title: "Sam" } }] });
    }
    if (u.includes("services:batchEnable")) return ok({ name: "operations/x" }, o.enableStatus ?? 200);
    if (u.endsWith("/revoke")) return ok({});
    if (u.endsWith("/v1/userinfo")) return ok({ email: o.email ?? "owner@example.com" });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const stored: { name: string; value: string; note: string }[] = [];
  const keys = new Set<string>();
  const env = { NODE_ENV: "test", YOUTUBE_CONNECT_RETRY_MS: "1", CONSOLE_CUSTOMER_HOSTS: `${TEAM}=team`, YOUTUBE_CONNECT_CHANNELS: "samshorts" };
  mountOAuth(api, {
    db,
    auth,
    signup: async () => ({ world: "never" }),
    creds: CREDS,
    fetch: fake,
    env,
    connects: CONNECTS,
    hasKey: async (n: string) => keys.has(n),
    ...(o.store === false ? {} : { storeKey: async (name: string, value: string, note: string) => (stored.push({ name, value, note }), keys.add(name), { ok: true as const }) }),
  });
  app.route("/api", api);
  const req = async (url: string, cookie?: string, host = TEAM) => {
    const res = await app.request(url, { headers: { host, "x-forwarded-host": host, "x-forwarded-proto": "https", ...(cookie ? { cookie } : {}) } });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get("location") ?? "", cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("console_oauth=") && c !== "console_oauth=") };
  };
  /** Follow a hop to Google and come back with a code, as the phone does after Allow. */
  const allow = async (startUrl: string) => {
    const start = await req(startUrl);
    const g = new URL(start.location);
    const back = await req(`/api/access/oauth/google/callback?code=c1&state=${g.searchParams.get("state")}`, start.cookie);
    return { g, back };
  };
  return { db, req, allow, calls, stored };
}

describe("one-button connects", () => {
  it("lists each connect with its account, channel, plain scope names and the button on the customer site", async () => {
    expect((await setup().req("/api/connects", undefined, "team.example.com")).status).toBe(401);
    const t = setup({ mode: "off" });
    const r = await t.req("/api/connects", undefined, "team.example.com");
    const j = JSON.parse(r.text) as { connects: { id: string; account: string; connected: boolean; startUrl: string; gives: string[]; channel?: { handle: string } }[] };
    expect(j.connects.map((c) => c.id)).toEqual(["sam-youtube", "sam-mail"]);
    expect(j.connects[0]).toMatchObject({ account: "owner@example.com", connected: false, startUrl: `https://${TEAM}/api/access/oauth/connect/sam-youtube/start`, channel: { handle: "@SamShorts" } });
    expect(j.connects[0].gives).toContain("upload videos");
  });

  it("the button on the console's own address hops to the customer site that carries Google's callback", async () => {
    const t = setup();
    const r = await t.req("/api/access/oauth/connect/sam-youtube/start", undefined, "team.example.com");
    expect(r.status).toBe(302);
    expect(r.location).toBe(`https://${TEAM}/api/access/oauth/connect/sam-youtube/start`);
  });

  it("start opens Google's consent with the client, the YouTube scopes, offline, and the named account as the hint", async () => {
    const t = setup();
    const r = await t.req("/api/access/oauth/connect/sam-youtube/start");
    expect(r.status).toBe(302);
    const g = new URL(r.location);
    expect(g.searchParams.get("client_id")).toBe(CLIENT);
    expect(g.searchParams.get("login_hint")).toBe("owner@example.com");
    expect(g.searchParams.get("prompt")).toBe("consent");
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("scope")!.split(" ").sort()).toEqual([...YOUTUBE_SCOPES].sort());
    expect(g.searchParams.get("redirect_uri")).toBe(`https://${TEAM}/api/access/oauth/google/callback`);
  });

  it("Allow on the right channel stores the keys under the connect's names and the card says Connected", async () => {
    const t = setup({ handle: "SamShorts", mode: "off" });
    const { back } = await t.allow("/api/access/oauth/connect/sam-youtube/start");
    expect(back.status).toBe(200);
    expect(back.text).toContain("Back to the inbox");
    expect(back.text).not.toContain("yrt");
    expect(t.stored.map((s) => s.name)).toEqual(["YT_ID", "YT_SECRET", "YT_REFRESH"]);
    const j = JSON.parse((await t.req("/api/connects", undefined, "team.example.com")).text);
    expect(j.connects[0].connected).toBe(true);
    expect(j.connects[1].connected).toBe(false);
  });

  it("the wrong channel names the exact account and channel to pick, stores nothing", async () => {
    const t = setup({ handle: "other" });
    const { back } = await t.allow("/api/access/oauth/connect/sam-youtube/start");
    expect(back.status).toBe(409);
    expect(back.text).toContain("owner@example.com");
    expect(back.text).toContain("@SamShorts");
    expect(t.stored).toEqual([]);
  });

  it("a plain connect: openid email added, the named account checked, then stored", async () => {
    const t = setup();
    const start = await t.req("/api/access/oauth/connect/sam-mail/start");
    expect(new URL(start.location).searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", ...MAIL]);
    const { back } = await t.allow("/api/access/oauth/connect/sam-mail/start");
    expect(back.status).toBe(200);
    expect(t.stored.map((s) => s.name)).toEqual(["M_ID", "M_SECRET", "M_REFRESH"]);
  });

  it("a plain connect with another Google account: refused, grant taken back", async () => {
    const t = setup({ email: "other@example.com" });
    const { back } = await t.allow("/api/access/oauth/connect/sam-mail/start");
    expect(back.status).toBe(409);
    expect(back.text).toContain("pick owner@example.com");
    expect(t.stored).toEqual([]);
    expect(t.calls.some((c) => c.url.endsWith("/revoke"))).toBe(true);
  });

  it("an unknown connect id: refused", async () => {
    const t = setup();
    expect((await t.req("/api/access/oauth/connect/nope/start")).status).toBe(400);
  });
});
