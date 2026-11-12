import { execFile } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { BROKER_HOST_ENV, quietBrokerHost } from "./helpers.js";
import { openDb, type DB } from "../src/db.js";
import { forTenant } from "../src/store.js";
import { createAuth, hashPassword, SESSION_COOKIE, type AuthMode } from "../src/auth/identity.js";
import { createGateway, gatewayConfigFromEnv, privateBind } from "../src/gateway/gateway.js";
import { cliRunner, type FaceRunner } from "../src/gateway/dispatcherFace.js";

// the agent gateway (token only, D4) and the dispatcher's HTTP face for tenant boxes (plan §2, §6b).

const A = "home";
const B = "social";
const cadence = { type: "interval" as const, everyMinutes: 60 };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ADAPTER = `python3 ${REPO}/m0/dispatcher/t3_seat_pool.py --broker ${REPO}/m0/broker/broker.py`;
const CLIENT = path.join(REPO, "m0/dispatcher/gateway_client.py");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

/** world picks ask the console's credits first; these tests use a stub console whose worlds all have the gate off. */
let creditsStub: Server;
let creditsUrl = "";
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      creditsStub = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ gate: false, unlimited: false, balanceMc: 0 })));
      creditsStub.listen(0, "127.0.0.1", () => {
        creditsUrl = `http://127.0.0.1:${(creditsStub.address() as AddressInfo).port}`;
        resolve();
      });
    }),
);
afterAll(() => new Promise<void>((resolve) => creditsStub.close(() => resolve())));

/** A broker home like test_broker.py's: usage fixture, roomy meminfo, seats.json with no reservations. */
function brokerHome(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "e21s14-broker-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "seats"));
  fs.writeFileSync(path.join(home, "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 12000000 kB\n");
  const usage = (five: number) => ({
    five_hour: { utilization: five, resets_at: "2099-01-01T00:00:00Z", locked_reason: null },
    seven_day: null,
    limits: [{ kind: "session", group: "session", percent: five, resets_at: "2099-01-01T00:00:00Z", is_active: true }],
  });
  fs.writeFileSync(path.join(home, "fixture.json"), JSON.stringify({ seat1: usage(20), seat2: usage(60) }));
  const seat = (n: string) => ({ providerInstanceId: `claudeAgent_${n}`, reservations: [], in_flight: 0 });
  fs.writeFileSync(path.join(home, "seats", "seats.json"), JSON.stringify({ beat: 0, seats: { seat1: seat("seat1"), seat2: seat("seat2") } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SEAT_BROKER_HOME: path.join(home, "seats"), DISPATCH_MEMINFO: path.join(home, "meminfo"), SEAT_BROKER_USAGE_FIXTURE: path.join(home, "fixture.json"), ...quietBrokerHost(home), CREDITS_URL: creditsUrl, ...extra };
  for (const k of ["SEAT_POOL_BROKER", "BROKER_MAX_TOTAL", "DISPATCH_MEM_FLOOR_MB", "PROVIDERS_FILE", "CONSOLE_AGENT_TOKEN_DIR", ...BROKER_HOST_ENV]) if (!(k in extra)) delete env[k];
  return env;
}
const cli = (env: NodeJS.ProcessEnv) => cliRunner(ADAPTER, env);
const parse = (s: string) => JSON.parse(s);

function world(mode: AuthMode = "off", dispatcher?: FaceRunner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e21s14-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(B, B, new Date().toISOString());
  const seed = (t: string) => {
    const s = forTenant(db, t);
    const m = s.createMilestone({ title: `milestone-${t}`, repo: `repo-${t}`, path: "docs/x.md", owner: "Sam", paused: false });
    const p = s.createPersona({ name: `persona-${t}`, remit: "r", skills: [], model: "opus", mayWrite: false });
    const as = s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: false });
    const run = s.createRun({ assignmentId: as.id, outcome: "idle", summary: `summary-${t}` });
    return { milestone: m.id, persona: p.id, assignment: as.id, run: run.id };
  };
  const a = seed(A);
  const b = seed(B);
  const app = createApp(db, { auth: mode, browser: { browserUrl: "http://127.0.0.1:9" } });
  const auth = createAuth(db);
  const tokA = auth.createToken({ tenant: A, label: "home box" }).token;
  const tokB = auth.createToken({ tenant: B, label: "social box" }).token;
  const gateway = createGateway({ db, fetch: app.fetch, dispatcher });
  const call = async (method: string, url: string, o: { token?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await gateway(new Request(`http://127.0.0.1:8760${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  /** The main port, as today: a loopback caller with no token. */
  const main = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(
      url,
      { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    return { status: res.status, json: await res.json().catch(() => undefined) };
  };
  return { db, app, auth, a, b, tokA, tokB, gateway, call, main };
}

describe("token only (D4)", () => {
  it("refuses no token, a bad or revoked token, cookies and run headers; never looks at the peer", async () => {
    const w = world("on");
    expect((await w.call("GET", "/api/milestones")).json.error.code).toBe("token_required");
    expect((await w.call("GET", "/api/health")).status).toBe(401); // nothing is open on the gateway
    expect((await w.call("GET", "/api/milestones", { headers: { "x-run-id": "run_x", "x-console-run": "run_x" } })).status).toBe(401);
    expect((await w.call("GET", "/api/milestones", { token: "at_not-a-real-token" })).json.error.code).toBe("bad_token");
    expect((await w.call("GET", "/api/milestones", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    // a real the home world owner session cookie, alone or with a valid token, is refused
    const uid = w.auth.addMember({ email: "sam@example.com", tenant: A, role: "owner" });
    w.db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword("correct horse battery"), uid);
    const sid = w.auth.createSession(uid, A).id;
    const cookie = `${SESSION_COOKIE}=${sid}`;
    expect((await w.call("GET", "/api/milestones", { headers: { cookie } })).json.error.code).toBe("token_only");
    expect((await w.call("GET", "/api/milestones", { token: w.tokB, headers: { cookie } })).json.error.code).toBe("token_only");
    const id = w.auth.listTokens(B)[0].id;
    expect((await w.call("GET", "/api/milestones", { token: w.tokB })).status).toBe(200);
    w.auth.revokeToken(B, id);
    expect((await w.call("GET", "/api/milestones", { token: w.tokB })).json.error.code).toBe("bad_token");
  });

  it("forwards no cookie or forwarded-for and never returns Set-Cookie", async () => {
    const seen: Headers[] = [];
    const w = world("off");
    const gw = createGateway({
      db: w.db,
      fetch: (req) => {
        seen.push(req.headers);
        return new Response("{}", { headers: { "set-cookie": "console_session=x", "content-type": "application/json" } });
      },
    });
    const res = await gw(new Request("http://127.0.0.1:8760/api/milestones", { headers: { authorization: `Bearer ${w.tokB}`, "x-forwarded-for": "203.0.113.7" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen[0].get("x-forwarded-for")).toBeNull();
    expect(seen[0].get("cookie")).toBeNull();
  });
});

describe("world scoping (whatever CONSOLE_AUTH the main port has)", () => {
  for (const mode of ["off", "shadow", "on"] as AuthMode[])
    it(`main port ${mode}: a token sees only its world; another world's id is 404`, async () => {
      const w = world(mode);
      const list = await w.call("GET", "/api/milestones", { token: w.tokB });
      expect(list.status).toBe(200);
      expect(list.json.map((m: any) => m.id)).toEqual([w.b.milestone]);
      expect((await w.call("GET", "/api/personas", { token: w.tokB })).json.map((p: any) => p.id)).toEqual([w.b.persona]);
      expect((await w.call("GET", `/api/milestones/${w.a.milestone}`, { token: w.tokB })).status).toBe(404);
      expect((await w.call("GET", `/api/runs/${w.a.run}`, { token: w.tokB })).status).toBe(404);
      const patched = await w.call("PATCH", `/api/runs/${w.a.run}`, { token: w.tokB, body: { outcome: "error", summary: "hijack" } });
      expect(patched.status).toBe(404);
      expect(forTenant(w.db, A).getRun(w.a.run)?.summary).toBe(`summary-${A}`);
      // own world works: read, PATCH, create (stamped with the token's world)
      expect((await w.call("GET", `/api/runs/${w.b.run}`, { token: w.tokB })).status).toBe(200);
      expect((await w.call("PATCH", `/api/runs/${w.b.run}`, { token: w.tokB, body: { summary: "box wake done" } })).status).toBe(200);
      expect(forTenant(w.db, B).getRun(w.b.run)?.summary).toBe("box wake done");
      const created = await w.call("POST", "/api/runs", { token: w.tokB, body: { assignmentId: w.b.assignment, outcome: "idle", summary: "from the box" } });
      expect(created.status).toBe(201);
      expect((w.db.prepare("SELECT tenant_id AS t FROM runs WHERE id = ?").get(created.json.id) as any).t).toBe(B);
      const me = await w.call("GET", "/api/me", { token: w.tokB });
      expect(me.json.identity).toMatchObject({ kind: "token", tenantId: B });
      // the home world's token is scoped too: no a social world repo rows, even with the main port off
      expect((await w.call("GET", "/api/milestones", { token: w.tokA })).json.map((m: any) => m.id)).toEqual([w.a.milestone]);
      expect((await w.call("GET", `/api/milestones/${w.b.milestone}`, { token: w.tokA })).status).toBe(404);
    });

  it("only agent routes: platform routes, token admin and login are not on the gateway", async () => {
    const w = world("off");
    for (const [m, u] of [
      ["GET", "/api/access/tokens"],
      ["POST", "/api/access/tokens"],
      ["POST", "/api/access/login"],
      ["GET", "/api/access/events"],
      ["GET", "/api/secrets"],
      ["POST", "/api/secrets"], // world-safe on the main port, not on the gateway
      ["POST", "/api/secrets/check"],
      ["POST", "/api/waiting-on-owner/wj_x/secret"],
      ["GET", "/api/hosts"],
      ["POST", `/api/milestones/${w.b.milestone}/mark`],
      ["GET", "/login"],
      ["GET", "/"],
    ])
      expect((await w.call(m, u, { token: w.tokA, body: m === "GET" ? undefined : {} })).status, `${m} ${u}`).toBe(404);
  });

  it("the main port is unchanged: loopback without a token is home legacy trust and sees every world (auth off)", async () => {
    const w = world("off");
    const r = await w.main("GET", "/api/milestones");
    expect(r.status).toBe(200);
    expect(r.json.map((m: any) => m.id).sort()).toEqual([w.a.milestone, w.b.milestone].sort());
  });
});

describe("dispatcher HTTP face == CLI, one reservation store", () => {
  it("status, pick, done answer exactly what the CLI answers for the token's world (twin homes)", async () => {
    const h1 = brokerHome();
    const h2 = brokerHome();
    const w = world("off", cli(h1));
    const viaCli = cli(h2);
    const steps: [string, () => Promise<{ status: number; text: string }>, string[]][] = [
      ["status", () => w.call("GET", "/api/dispatcher/status", { token: w.tokB }), ["status", "--world", B]],
      ["pick", () => w.call("POST", "/api/dispatcher/pick", { token: w.tokB, body: { persona: "p1", world: A } }), ["pick", "--world", B, "--persona", "p1"]],
      ["status", () => w.call("GET", "/api/dispatcher/status", { token: w.tokB }), ["status", "--world", B]],
      ["done", () => w.call("POST", "/api/dispatcher/done", { token: w.tokB, body: { id: "seat1" } }), ["done", "seat1"]],
      ["status", () => w.call("GET", "/api/dispatcher/status", { token: w.tokB }), ["status", "--world", B]],
      ["pick", () => w.call("POST", "/api/dispatcher/pick", { token: w.tokB, body: { model: "claude-sonnet-5-5", from: "box-memo-social" } }), ["pick", "--world", B, "--model", "claude-sonnet-5-5", "--from", "box-memo-social"]],
    ];
    for (const [name, http, args] of steps) {
      const h = await http();
      const c = await viaCli(args);
      expect(h.status, name).toBe(200);
      expect(h.text, name).toBe(c.trim());
    }
    expect(parse((await viaCli(["status", "--world", B]))).world).toBe(B);
    expect(fs.readFileSync(path.join(h1.SEAT_BROKER_HOME!, "seats.json"), "utf8").length).toBeGreaterThan(0);
    // the stored reservations match too
    const seats = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(Object.entries(parse(fs.readFileSync(path.join(env.SEAT_BROKER_HOME!, "seats.json"), "utf8")).seats).map(([k, v]: any) => [k, v.in_flight]));
    expect(seats(h1)).toEqual(seats(h2));
  });

  it("a gateway pick and a CLI pick share the store: no double booking", async () => {
    const h = brokerHome({ BROKER_MAX_TOTAL: "1" });
    const w = world("off", cli(h));
    const viaCli = cli(h);
    const p = await w.call("POST", "/api/dispatcher/pick", { token: w.tokB });
    expect(p.json.id).toBe("seat1");
    const refused = parse(await viaCli(["pick"]));
    expect(refused.id).toBeNull();
    expect(refused.reason).toMatch(/ceiling 1/);
    expect(parse(await viaCli(["status"])).open).toBe(1);
    expect((await w.call("POST", "/api/dispatcher/pick", { token: w.tokA })).json.id).toBeNull(); // the gateway sees the same ceiling
    expect((await w.call("POST", "/api/dispatcher/done", { token: w.tokB, body: { id: "seat1" } })).json).toEqual({ ok: true });
    expect(parse(await viaCli(["status"])).open).toBe(0);
    expect(parse(await viaCli(["pick"])).id).toBe("seat1");
    // the CLI's reservation is not the box's to release
    expect((await w.call("POST", "/api/dispatcher/done", { token: w.tokB, body: { id: "seat1" } })).json.error.code).toBe("not_picked");
    expect(parse(await viaCli(["status"])).open).toBe(1);
  });

  it("a world releases only its own picks; stale picks are not re-released; arguments are plain ids", async () => {
    const calls: string[][] = [];
    const run: FaceRunner = async (args) => {
      calls.push(args);
      return args[0] === "pick" ? '{"id": "seat2", "via": "t3_delegate_task", "providerInstanceId": "claudeAgent_seat2"}\n' : '{"ok": true}\n';
    };
    const w = world("off", run);
    expect((await w.call("POST", "/api/dispatcher/pick", { token: w.tokA, body: { world: B } })).json.id).toBe("seat2");
    expect(calls[0]).toEqual(["pick", "--world", A]); // the token's world, never the body's
    expect((await w.call("POST", "/api/dispatcher/done", { token: w.tokB, body: { id: "seat2" } })).json.error.code).toBe("not_picked");
    expect(calls).toHaveLength(1);
    expect((await w.call("POST", "/api/dispatcher/done", { token: w.tokA, body: { id: "seat2", failed: true } })).json).toEqual({ ok: true });
    expect(calls[1]).toEqual(["done", "seat2", "--fail"]);
    expect((await w.call("POST", "/api/dispatcher/done", { token: w.tokA, body: { id: "seat2" } })).status).toBe(404); // already released
    // a pick older than the stores' 20 min window was released by them: ok, no CLI call
    w.db.prepare("INSERT INTO gateway_picks (tenant_id, instance, picked_at) VALUES (?, 'seat1', ?)").run(B, new Date(Date.now() - 30 * 60_000).toISOString());
    expect((await w.call("POST", "/api/dispatcher/done", { token: w.tokB, body: { id: "seat1" } })).json).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    for (const bad of ["--fail", "-x", "a b", "x;rm -rf /", ""])
      expect((await w.call("POST", "/api/dispatcher/pick", { token: w.tokB, body: { persona: bad || 5 } })).status, bad).toBe(400);
    expect((await w.call("GET", "/api/dispatcher/pick", { token: w.tokB })).status).toBe(405);
    expect((await w.call("GET", "/api/dispatcher/status")).status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  it("no dispatcher configured: 503; a broken dispatcher: 502, never a made-up answer", async () => {
    const w = world("off");
    expect((await w.call("GET", "/api/dispatcher/status", { token: w.tokB })).status).toBe(503);
    const w2 = world("off", async () => "not json");
    expect((await w2.call("POST", "/api/dispatcher/pick", { token: w2.tokB })).status).toBe(502);
    expect(w2.db.prepare("SELECT COUNT(*) AS n FROM gateway_picks").get()).toEqual({ n: 0 });
  });
});

describe("real socket + the box's thin client", () => {
  const listen = (fetch: (r: Request) => Promise<Response>) =>
    new Promise<string>((resolve) => {
      const s = serve({ fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
      cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
    });
  const client = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) =>
      execFile("python3", [CLIENT, ...args], { env, timeout: 30_000 }, (e, out, err) => resolve({ code: e ? Number((e as any).code ?? 1) : 0, out, err })),
    );

  it("a loopback call without a token is refused (no tailnet/loopback trust); the thin client picks through the gateway like the CLI", async () => {
    const h1 = brokerHome();
    const h2 = brokerHome();
    const logs: string[] = [];
    for (const k of ["log", "warn", "error", "info"] as const) vi.spyOn(console, k).mockImplementation((...a) => void logs.push(a.join(" ")));
    const w = world("off", cli(h1));
    const url = await listen(w.gateway);
    expect((await fetch(`${url}/api/milestones`)).status).toBe(401);
    expect((await fetch(`${url}/api/milestones`, { headers: { cookie: "console_session=x", authorization: `Bearer ${w.tokB}` } })).status).toBe(401);
    expect((await fetch(`${url}/api/milestones`, { headers: { authorization: `Bearer ${w.tokB}` } })).status).toBe(200);

    const tokenFile = path.join(h1.HOME!, "token");
    fs.writeFileSync(tokenFile, w.tokB + "\n", { mode: 0o600 });
    const env = { ...process.env, AGENT_GATEWAY_URL: url, AGENT_TOKEN_FILE: tokenFile };
    const viaCli = cli(h2);
    for (const [args, cliArgs] of [
      [["status"], ["status", "--world", B]],
      [["pick", "--world", "home", "--persona", "p1", "--from", "box-memo-social"], ["pick", "--world", B, "--persona", "p1", "--from", "box-memo-social"]],
      [["status"], ["status", "--world", B]],
      [["done", "seat1"], ["done", "seat1"]],
    ] as const) {
      const r = await client(env, ...args);
      expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
      expect(r.out.trim()).toBe((await viaCli([...cliArgs])).trim());
      expect(r.out + r.err).not.toContain(w.tokB);
    }
    const refused = await client({ ...env, AGENT_TOKEN_FILE: "", AGENT_TOKEN: "at_wrong" }, "pick");
    expect(parse(refused.out)).toEqual({ id: null, reason: expect.stringMatching(/^gateway 401 bad_token/), retryable: false, retry_after_s: null });
    const down = await client({ ...env, AGENT_GATEWAY_URL: "http://127.0.0.1:9" }, "pick");
    expect(parse(down.out).id).toBeNull();
    expect((await client(env, "done", "seat2")).code).toBe(1); // not picked by this world

    // tokens are never logged or stored raw
    for (const l of logs) expect(l).not.toContain(w.tokB);
    const dump = JSON.stringify(
      ["auth_events", "agent_tokens", "gateway_picks"].map((t) => w.db.prepare(`SELECT * FROM ${t}`).all()),
    );
    expect(dump).not.toContain(w.tokB);
    expect(dump).not.toContain(w.tokA);
  });
});

describe("config: off by default, loopback/tailnet only", () => {
  it("CONSOLE_GATEWAY_PORT unset = no gateway; a public bind or the console's own port is refused", () => {
    expect(gatewayConfigFromEnv({})).toBeUndefined();
    expect(gatewayConfigFromEnv({ CONSOLE_GATEWAY_PORT: "8760" })).toEqual({ host: "127.0.0.1", port: 8760, dispatcherCmd: undefined });
    expect(gatewayConfigFromEnv({ CONSOLE_GATEWAY_PORT: "8760", CONSOLE_GATEWAY_HOST: "100.64.0.10", EPICSPINE_DISPATCHER: "x" })).toEqual({ host: "100.64.0.10", port: 8760, dispatcherCmd: "x" });
    expect(gatewayConfigFromEnv({ CONSOLE_GATEWAY_PORT: "8760", CONSOLE_GATEWAY_DISPATCHER: "y", EPICSPINE_DISPATCHER: "x" })?.dispatcherCmd).toBe("y");
    for (const host of ["0.0.0.0", "::", "203.0.113.7", "10.0.0.5", "team.example.com"])
      expect(() => gatewayConfigFromEnv({ CONSOLE_GATEWAY_PORT: "8760", CONSOLE_GATEWAY_HOST: host }), host).toThrow(/not loopback or tailnet/);
    expect(() => gatewayConfigFromEnv({ CONSOLE_GATEWAY_PORT: "8750" })).toThrow(/differ/);
    expect(() => gatewayConfigFromEnv({ CONSOLE_GATEWAY_PORT: "nope" })).toThrow(/port number/);
    expect(["127.0.0.1", "::1", "localhost", "100.64.0.1", "fd7a:115c:a1e0::1"].every(privateBind)).toBe(true);
    expect(["100.128.0.1", "100.63.255.255", "fd7a:115c:a1e1::1"].some(privateBind)).toBe(false);
  });
});
