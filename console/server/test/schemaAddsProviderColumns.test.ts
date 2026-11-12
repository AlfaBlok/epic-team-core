import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import { openDb, type DB } from "../src/db.js";
import { modelId, type CycleOptions } from "../src/cycle/service.js";
import type { T3Client, T3Project } from "../src/t3/client.js";
import { envDispatcher, type Dispatcher, type PickArgs, type PickResult } from "../src/t3/dispatcher.js";
import { ensureProviders, PROVIDER_COLUMNS } from "../src/providers/schema.js";
import { providerCostUsd, providerPrice } from "../src/providers/prices.js";
import { DEFAULT_REGISTRY, loadRegistry } from "../src/providers/registry.js";
import { tempCheckout } from "./tempCheckout.js";
// the code repo milestone lives in a temp checkout (finishing a run fetches its origin; never the real one).
const AT = tempCheckout().dir;


// provider + model per persona via the central dispatcher (plan §6b). Default (world pick off) = today.

const PROJECTS: T3Project[] = [
  {
    id: "mcp:agent-team",
    title: "home_repo",
    workspaceRoot: AT,
    repositoryIdentity: { displayName: "acme/home_repo", canonicalKey: "github.com/acme/home_repo" },
  },
];

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  projects: T3Project[] = [...PROJECTS];
  async listProjects() {
    return this.projects;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    this.calls.push({ op: "launchThread", args: input });
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

/** Today's dispatcher (plain pick only) or, with `world`, one that also answers world picks like t3_seat_pool.py. */
class FakeDispatcher implements Dispatcher {
  plain = 0;
  asked: PickArgs[] = [];
  async pick() {
    this.plain++;
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done() {}
}
class WorldDispatcher extends FakeDispatcher {
  async pickFor(a: PickArgs): Promise<PickResult> {
    this.asked.push(a);
    if (a.world === "acme")
      return { seat: "opencode_acme", providerInstanceId: "opencode_acme", provider: "openrouter:acme", model: a.model ?? "claude-sonnet-5-5", priceKey: "openrouter", notional: false };
    return { seat: "seat1", providerInstanceId: "claudeAgent_seat1", provider: a.provider ?? "claude-seat", model: a.model ?? null, priceKey: "claude-seat", notional: true };
  }
}

const REG = {
  classes: {
    "claude-seat": { kind: "seat", world: null, priceKey: "claude-seat", notional: true },
    "openrouter:acme": { kind: "openrouter", world: "acme", instances: ["opencode_acme"], cap: 2, priceKey: "openrouter" },
  },
  worlds: {},
};

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.unstubAllEnvs();
});

function setup(over: Partial<CycleOptions> = {}, dispatcher: Dispatcher = new FakeDispatcher(), appOpts: { tenant?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e21s13-"));
  const regFile = path.join(dir, "providers.json");
  fs.writeFileSync(regFile, JSON.stringify(REG));
  vi.stubEnv("CONSOLE_PROVIDERS_FILE", regFile);
  const db: DB = openDb(path.join(dir, "console.db"));
  const repos = path.join(dir, "repos");
  vi.stubEnv("REPOS_ROOT", repos);
  const t3 = new FakeT3();
  const opts: CycleOptions = { enabled: true, t3, dispatcher, publicUrl: "http://127.0.0.1:18799", seatsFile: path.join(dir, "seats.json"), runState: async () => undefined,
    // these worlds wake to test their providers, as once their isolated boxes exist (the gate's own tests: e59s4)
    worldHold: () => undefined, ...over };
  const app = createApp(db, { cycle: opts, ...appOpts });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const addWorld = (id: string) =>
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(id, id, new Date().toISOString());
  /** A milestone + persona + assignment, moved to `world` before the assignment (it must share their tenant). */
  const seed = async (world = "home", model = "haiku") => {
    const m = (await call("POST", "/api/milestones", { title: `M ${world}`, repo: AT, path: "docs/spines/root.md" })).json;
    const p = (await call("POST", "/api/personas", { name: `reader ${world}`, remit: "read-only", model })).json;
    if (world !== "home") {
      addWorld(world);
      // a world's milestone resolves only to its own checkout under the repos root (never the home world's the code repo)
      fs.mkdirSync(path.join(repos, world, ".git"), { recursive: true });
      resetRepoScans();
      t3.projects.push({ id: `mcp:${world}`, title: world, workspaceRoot: path.join(repos, world), repositoryIdentity: { displayName: world, canonicalKey: `local/${world}` } });
      db.prepare("UPDATE milestones SET tenant_id = ?, repo = ? WHERE id = ?").run(world, world, m.id);
      db.prepare("UPDATE personas SET tenant_id = ? WHERE id = ?").run(world, p.id);
    }
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 } })).json;
    return { m, p, a };
  };
  return { db, t3, dispatcher, call, seed, addWorld };
}

const PROVIDER_KEYS = ["provider", "providerInstance", "model", "priceKey", "notional"];

describe("schema", () => {
  it("adds the provider columns and provider_threads, idempotently, all NULL for today's rows", () => {
    const t = setup();
    for (const [table, col] of PROVIDER_COLUMNS)
      expect((t.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name), `${table}.${col}`).toContain(col);
    const before = JSON.stringify(t.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all());
    ensureProviders(t.db);
    ensureProviders(t.db);
    expect(JSON.stringify(t.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all())).toBe(before);
    expect(t.db.prepare("SELECT default_provider, default_model FROM tenants").all()).toEqual([{ default_provider: null, default_model: null }]);
    expect(t.db.pragma("user_version", { simple: true })).toBe(24);
  });
});

describe("registry", () => {
  it("a missing file is the seat pool only; a file adds its classes and always keeps claude-seat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e21s13-reg-"));
    try {
      expect(loadRegistry(path.join(dir, "none.json"))).toEqual(DEFAULT_REGISTRY);
      const f = path.join(dir, "p.json");
      fs.writeFileSync(f, JSON.stringify({ classes: { "openrouter:acme": REG.classes["openrouter:acme"] } }));
      const r = loadRegistry(f);
      expect(Object.keys(r.classes).sort()).toEqual(["claude-seat", "openrouter:acme"]);
      expect(r.classes["openrouter:acme"]).toMatchObject({ world: "acme", notional: false, priceKey: "openrouter" });
      fs.writeFileSync(f, "{");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(loadRegistry(f)).toEqual(DEFAULT_REGISTRY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pick, world pick off (default): today's behaviour", () => {
  it("plain pick, the persona's model, and the run stamped with the seat pool", async () => {
    const t = setup({}, new WorldDispatcher()); // even a dispatcher that could answer world picks gets a plain pick
    const d = t.dispatcher as WorldDispatcher;
    const { a } = await t.seed();
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(201);
    expect(d.plain).toBe(1);
    expect(d.asked).toEqual([]);
    expect(t.t3.ops("launchThread")[0].args.modelSelection).toEqual({ instanceId: "claudeAgent_seat2", model: modelId("haiku") });
    const run = (await t.call("GET", `/api/runs/${r.json.id}`)).json;
    expect(run).toMatchObject({ seat: "seat2", provider: "claude-seat", providerInstance: "claudeAgent_seat2", model: "claude-haiku-5-5", priceKey: "claude-seat", notional: true });
  });

  it("a wake sent into the home thread is stamped with what the thread was launched on", async () => {
    const t = setup();
    const { a } = await t.seed();
    const r1 = (await t.call("POST", `/api/assignments/${a.id}/run-now`)).json;
    await t.call("PATCH", `/api/runs/${r1.id}`, { outcome: "idle", summary: "ok", endedAt: new Date().toISOString() });
    const r2 = (await t.call("POST", `/api/assignments/${a.id}/run-now`)).json;
    expect(t.t3.ops("launchThread")).toHaveLength(1);
    expect(t.t3.ops("sendToThread")[0].args.threadId).toBe("thread_1");
    expect((await t.call("GET", `/api/runs/${r2.id}`)).json).toMatchObject({ providerInstance: "claudeAgent_seat2", model: "claude-haiku-5-5" });
  });

  it("runs nobody stamped (posted by agents, pre-S13 rows) answer exactly as before: no provider keys", async () => {
    const t = setup();
    const { a } = await t.seed();
    const run = (await t.call("POST", "/api/runs", { assignmentId: a.id, outcome: "idle", summary: "posted", endedAt: new Date().toISOString() })).json;
    for (const k of PROVIDER_KEYS) expect(run).not.toHaveProperty(k);
    for (const k of PROVIDER_KEYS) expect((await t.call("GET", "/api/runs")).json[0]).not.toHaveProperty(k);
  });
});

describe("pick, world pick on", () => {
  it("asks for the persona's world, override and model, launches on what the dispatcher picked, stamps it", async () => {
    const t = setup({ providerPick: true }, new WorldDispatcher());
    const d = t.dispatcher as WorldDispatcher;
    const { a, p } = await t.seed("social", "opus");
    await t.call("PUT", "/api/tenants/social/provider", { defaultProvider: "claude-seat", defaultModel: "sonnet" });
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(201);
    expect(d.plain).toBe(0);
    expect(d.asked).toEqual([{ world: "social", persona: p.id, provider: "claude-seat", model: "claude-opus-5-5" }]);
    expect(t.t3.ops("launchThread")[0].args.modelSelection).toEqual({ instanceId: "claudeAgent_seat1", model: "claude-opus-5-5" });
    expect((await t.call("GET", `/api/runs/${r.json.id}`)).json).toMatchObject({ provider: "claude-seat", providerInstance: "claudeAgent_seat1", model: "claude-opus-5-5", notional: true });
  });

  it("a fixture API-type world gets its instance; the run is priced for real (not notional)", async () => {
    const t = setup({ providerPick: true }, new WorldDispatcher());
    const { a, p } = await t.seed("acme", "sonnet");
    expect((await t.call("PUT", `/api/personas/${p.id}/provider`, { provider: "openrouter:acme" })).status).toBe(200);
    const r = (await t.call("POST", `/api/assignments/${a.id}/run-now`)).json;
    expect((t.dispatcher as WorldDispatcher).asked[0]).toMatchObject({ world: "acme", provider: "openrouter:acme" });
    expect(t.t3.ops("launchThread")[0].args.modelSelection).toEqual({ instanceId: "opencode_acme", model: "claude-sonnet-5-5" });
    expect((await t.call("GET", `/api/runs/${r.id}`)).json).toMatchObject({ provider: "openrouter:acme", providerInstance: "opencode_acme", priceKey: "openrouter", notional: false });
  });

  it("a dispatcher without world picks gets a plain pick (today's broker contract)", async () => {
    const t = setup({ providerPick: true });
    const { a } = await t.seed();
    await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect((t.dispatcher as FakeDispatcher).plain).toBe(1);
    expect(t.t3.ops("launchThread")[0].args.modelSelection).toEqual({ instanceId: "claudeAgent_seat2", model: "claude-haiku-5-5" });
  });

  it("a refused world pick is no_seat with the dispatcher's reason", async () => {
    const d = new WorldDispatcher();
    d.pickFor = async () => ({ seat: null, reason: "provider openrouter:acme at capacity (2 per instance)" });
    const t = setup({ providerPick: true }, d);
    const { a } = await t.seed();
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(JSON.stringify(r.json)).toContain("at capacity");
  });
});

describe("routes", () => {
  it("lists a world's providers: shared classes plus its own, never another world's", async () => {
    const t = setup();
    t.addWorld("acme");
    t.addWorld("social");
    expect((await t.call("GET", "/api/providers?world=acme")).json.classes.map((c: any) => c.id)).toEqual(["claude-seat", "openrouter:acme"]);
    const z = (await t.call("GET", "/api/providers?world=social")).json;
    expect(z.classes.map((c: any) => c.id)).toEqual(["claude-seat"]);
    expect(z.prices.map((p: any) => p.priceKey)).toContain("openrouter");
    expect((await t.call("GET", "/api/providers?world=nope")).status).toBe(404);
  });

  it("world default: set, validated against the registry, cleared with null", async () => {
    const t = setup();
    t.addWorld("social");
    expect((await t.call("GET", "/api/tenants/home/provider")).json).toEqual({ tenantId: "home", defaultProvider: null, defaultModel: null });
    const ok = await t.call("PUT", "/api/tenants/social/provider", { defaultProvider: "claude-seat", defaultModel: "sonnet" });
    expect(ok.json).toEqual({ tenantId: "social", defaultProvider: "claude-seat", defaultModel: "claude-sonnet-5-5" });
    const bad = await t.call("PUT", "/api/tenants/social/provider", { defaultProvider: "openrouter:acme" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("unknown_provider");
    expect((await t.call("PUT", "/api/tenants/social/provider", { defaultProvider: "" })).status).toBe(400);
    expect((await t.call("PUT", "/api/tenants/social/provider", { defaultProvider: null })).json.defaultProvider).toBeNull();
    expect((await t.call("PUT", "/api/tenants/nope/provider", {})).status).toBe(404);
  });

  it("persona override: effective = override > world default > seat pool; model goes to the persona", async () => {
    const t = setup();
    const { p } = await t.seed("acme", "haiku");
    expect((await t.call("GET", `/api/personas/${p.id}/provider`)).json).toEqual({
      personaId: p.id,
      world: "acme",
      provider: null,
      model: "haiku",
      effective: { provider: "claude-seat", model: "claude-haiku-5-5" },
    });
    await t.call("PUT", "/api/tenants/acme/provider", { defaultProvider: "openrouter:acme" });
    expect((await t.call("GET", `/api/personas/${p.id}/provider`)).json.effective.provider).toBe("openrouter:acme");
    const set = (await t.call("PUT", `/api/personas/${p.id}/provider`, { provider: "claude-seat", model: "opus" })).json;
    expect(set).toMatchObject({ provider: "claude-seat", model: "opus", effective: { provider: "claude-seat", model: "claude-opus-5-5" } });
    expect((await t.call("GET", `/api/personas/${p.id}`)).json.model).toBe("opus");
    expect((await t.call("PUT", `/api/personas/${p.id}/provider`, { model: "opus" })).status).toBe(400);
  });

  it("a scoped console (one world) answers 404 for another world's persona and tenant", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e21s13-"));
    const db = openDb(path.join(dir, "console.db"));
    try {
      db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('acme', 'acme', ?)").run(new Date().toISOString());
      const now = new Date().toISOString();
      db.prepare("INSERT INTO personas (id, name, remit, skills, model, may_write, created_at, tenant_id) VALUES ('per_x', 'x', 'r', '[]', 'haiku', 0, ?, 'acme')").run(now);
      const app = createApp(db, { tenant: "home" });
      expect((await app.request("/api/personas/per_x/provider")).status).toBe(404);
      expect((await app.request("/api/tenants/acme/provider")).status).toBe(404);
      expect((await app.request("/api/providers?world=acme")).status).toBe(404);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("price lookup per provider and model", async () => {
    const t = setup();
    expect((await t.call("GET", "/api/providers/price?priceKey=openrouter&model=opus")).json).toMatchObject({ model: "claude-opus-5-5", priceKey: "openrouter", notional: false, input: 4, output: 20 });
    expect((await t.call("GET", "/api/providers/price?model=haiku")).json).toMatchObject({ priceKey: "claude-seat", notional: true });
    expect((await t.call("GET", "/api/providers/price?priceKey=nope&model=opus")).status).toBe(404);
  });
});

describe("prices", () => {
  it("seats are notional at list price, API providers are real; unknown provider or model has no price", () => {
    expect(providerPrice("claude-seat", "claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10, notional: true });
    expect(providerPrice(undefined, "claude-sonnet-5-5")).toMatchObject({ priceKey: "claude-seat", notional: true });
    expect(providerPrice("anthropic-api", "claude-opus-5-5")).toMatchObject({ input: 4, notional: false });
    expect(providerPrice("nope", "claude-opus-5-5")).toBeUndefined();
    expect(providerPrice("openrouter", "gpt-x")).toBeUndefined();
    const c = providerCostUsd("openrouter", "claude-haiku-5-5", { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 });
    expect(c).toEqual({ usd: 0.6, priceKey: "openrouter", notional: false });
  });
});

describe("envDispatcher", () => {
  it("plain pick sends only `pick`; pickFor sends --world/--persona/--provider/--model and maps the answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e21s13-disp-"));
    try {
      const script = path.join(dir, "d.py");
      fs.writeFileSync(
        script,
        'import json,sys\nprint(json.dumps({"id":"seat1","via":"t3_delegate_task","providerInstanceId":"claudeAgent_seat1","provider":"claude-seat","model":"m:"+",".join(sys.argv[1:]),"priceKey":"claude-seat","notional":True}))\n',
      );
      const d = envDispatcher(`python3 ${script}`)!;
      expect(await d.pick()).toEqual({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" });
      expect(await d.pickFor!({ world: "social", persona: "per_1", model: "claude-opus-5-5" })).toEqual({
        seat: "seat1",
        providerInstanceId: "claudeAgent_seat1",
        provider: "claude-seat",
        model: "m:pick,--world,social,--persona,per_1,--model,claude-opus-5-5",
        priceKey: "claude-seat",
        notional: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
