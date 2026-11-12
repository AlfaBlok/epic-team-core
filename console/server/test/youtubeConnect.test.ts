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
import { ENABLE_SCOPE, expectedChannels, projectNumberOf, YOUTUBE_SCOPES } from "../src/auth/youtubeConnect.js";

/** The YouTube Allow as one link, on the console's own Google client (fake Google answers). */
const TEAM = "cloud.example.com";
const CLIENT = "123456789012-abc.apps.googleusercontent.com";
const CREDS: CredsOf = async () => ({ clientId: CLIENT, clientSecret: "csecret" });
const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(o: { handle?: string; scopes?: string[]; apiOff?: number; enableStatus?: number; store?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e86s22-"));
  dirs.push(dir);
  const db = openDb(path.join(dir, "console.db"));
  dbs.push(db);
  ensureAuth(db);
  const app = new Hono();
  const api = new Hono();
  const auth = mountAuth(app, api, { db, store: forTenant(db, "home"), mode: "on" });
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
      return ok({ access_token: "yat", refresh_token: "yrt", scope: (o.scopes ?? YOUTUBE_SCOPES).join(" ") });
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
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const stored: { name: string; value: string; note: string }[] = [];
  const env = { NODE_ENV: "test", YOUTUBE_CONNECT_RETRY_MS: "1", CONSOLE_CUSTOMER_HOSTS: `${TEAM}=team`, YOUTUBE_CONNECT_CHANNELS: "samshorts" };
  mountOAuth(api, {
    db,
    auth,
    signup: async () => ({ world: "never" }),
    creds: CREDS,
    fetch: fake,
    env,
    ...(o.store === false ? {} : { storeKey: async (name: string, value: string, note: string) => (stored.push({ name, value, note }), { ok: true as const }) }),
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

describe("the YouTube Allow as one phone link", () => {
  it("helpers: the project number is the client id's prefix; the channel list comes from the env, else the site config", () => {
    expect(projectNumberOf(CLIENT)).toBe("123456789012");
    expect(projectNumberOf("abc.apps.googleusercontent.com")).toBeUndefined();
    expect(expectedChannels({ YOUTUBE_CONNECT_CHANNELS: "" })).toEqual([]);
    expect(expectedChannels({ YOUTUBE_CONNECT_CHANNELS: "@A, b" })).toEqual(["a", "b"]);
  });

  it("start goes to Google with the four YouTube scopes, offline, on the site's registered Google callback", async () => {
    const t = setup();
    const r = await t.req("/api/access/oauth/youtube/start");
    expect(r.status).toBe(302);
    const g = new URL(r.location);
    expect(g.host).toBe("accounts.google.com");
    expect(g.searchParams.get("redirect_uri")).toBe(`https://${TEAM}/api/access/oauth/google/callback`);
    expect(g.searchParams.get("scope")!.split(" ").sort()).toEqual([...YOUTUBE_SCOPES].sort());
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.cookie).toBeTruthy();
  });

  it("not on a customer site: refused, no hop", async () => {
    const t = setup();
    const r = await t.req("/api/access/oauth/youtube/start", undefined, "team.example.com");
    expect(r.status).toBe(400);
  });

  it("the owner's Allow for @SamShorts stores the three keys (names only on the page) and the status says connected", async () => {
    const t = setup();
    expect(JSON.parse((await t.req("/api/access/oauth/youtube/status")).text)).toEqual({ ready: true, connected: false });
    const { back } = await t.allow("/api/access/oauth/youtube/start");
    expect(back.status).toBe(200);
    expect(back.text).toContain("Done: YouTube is connected");
    expect(back.text).not.toContain("yrt");
    expect(back.text).not.toContain("csecret");
    expect(t.stored.map((s) => s.name)).toEqual(["YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET", "YOUTUBE_OAUTH_REFRESH_TOKEN"]);
    expect(t.stored.map((s) => s.value)).toEqual([CLIENT, "csecret", "yrt"]);
    const st = JSON.parse((await t.req("/api/access/oauth/youtube/status")).text);
    expect(st).toMatchObject({ ready: true, connected: true, channel: "@samshorts" });
  });

  it("another channel: refused, its grant taken back, nothing stored", async () => {
    const t = setup({ handle: "someoneelse" });
    const { back } = await t.allow("/api/access/oauth/youtube/start");
    expect(back.status).toBe(409);
    expect(back.text).toContain("That is not the team");
    expect(t.stored).toEqual([]);
    expect(t.calls.some((c) => c.url.endsWith("/revoke") && c.body.includes("yrt"))).toBe(true);
  });

  it("a box left unticked: nothing stored, asked to tick every box", async () => {
    const t = setup({ scopes: YOUTUBE_SCOPES.slice(0, 2) });
    const { back } = await t.allow("/api/access/oauth/youtube/start");
    expect(back.text).toContain("Tick every box");
    expect(t.stored).toEqual([]);
  });

  it("YouTube off in the project: one more Allow switches it on (service.management), takes that back, then stores", async () => {
    const t = setup({ apiOff: 2 });
    const first = await t.allow("/api/access/oauth/youtube/start");
    expect(first.back.text).toContain("One more Allow");
    expect(t.stored).toEqual([]);
    const href = /href="([^"]+enable\?p=[^"]+)"/.exec(first.back.text)![1].replace(/&amp;/g, "&");
    const second = await t.allow(href);
    expect(second.g.searchParams.get("scope")).toBe(ENABLE_SCOPE);
    expect(second.g.searchParams.get("access_type")).toBeNull();
    expect(second.back.text).toContain("Done: YouTube is connected");
    const enable = t.calls.find((c) => c.url.includes("services:batchEnable"))!;
    expect(enable.url).toBe("https://serviceusage.googleapis.com/v1/projects/123456789012/services:batchEnable");
    expect(JSON.parse(enable.body).serviceIds).toEqual(["youtube.googleapis.com", "youtubeanalytics.googleapis.com"]);
    expect(t.calls.filter((c) => c.url.endsWith("/revoke")).length).toBe(1); // the switch-on Allow only
    expect(t.stored.map((s) => s.name)).toContain("YOUTUBE_OAUTH_REFRESH_TOKEN");
  });

  it("switch-on not spread yet: Check again finishes it later", async () => {
    const t = setup({ apiOff: 7 });
    const first = await t.allow("/api/access/oauth/youtube/start");
    const href = /href="([^"]+enable\?p=[^"]+)"/.exec(first.back.text)![1].replace(/&amp;/g, "&");
    const second = await t.allow(href);
    expect(second.back.text).toContain("Check again");
    const fin = /href="([^"]+finish\?p=[^"]+)"/.exec(second.back.text)![1];
    const done = await t.req(fin);
    expect(done.text).toContain("Done: YouTube is connected");
    expect(t.stored.length).toBe(3);
  });

  it("a switch-on by a login with no rights on the project: refused plainly, nothing stored", async () => {
    const t = setup({ apiOff: 1, enableStatus: 403 });
    const first = await t.allow("/api/access/oauth/youtube/start");
    const href = /href="([^"]+enable\?p=[^"]+)"/.exec(first.back.text)![1].replace(/&amp;/g, "&");
    const second = await t.allow(href);
    expect(second.back.text).toContain("refused to switch YouTube on");
    expect(t.stored).toEqual([]);
  });

  it("he cancels on Google's screen: nothing changed, no sign-in error page", async () => {
    const t = setup();
    const start = await t.req("/api/access/oauth/youtube/start");
    const state = new URL(start.location).searchParams.get("state");
    const back = await t.req(`/api/access/oauth/google/callback?error=access_denied&state=${state}`, start.cookie);
    expect(back.text).toContain("Nothing changed");
    expect(t.stored).toEqual([]);
  });

  it("no key store on this console: says so, stores nothing", async () => {
    const t = setup({ store: false });
    const { back } = await t.allow("/api/access/oauth/youtube/start");
    expect(back.status).toBe(503);
  });
});
