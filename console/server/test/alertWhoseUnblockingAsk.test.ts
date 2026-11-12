import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { parseMonitoring } from "../src/adapters/monitoring.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { createAuth, currentAuth, runWithAuth, type AuthContext } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { ensureAuth } from "../src/auth/schema.js";
import { openDb, type DB } from "../src/db.js";
import type { LocatedAsk } from "../src/inbox/asks.js";
import { askItemId } from "../src/inbox/waiting.js";
import { applyPatch } from "../src/readModel/views.js";
import { createStore, type Assignment, type Milestone } from "../src/store.js";
import { actAs, mountAlertActions } from "../src/status/alertActions.js";
import { milestoneStatus, type StatusInput } from "../src/status/compute.js";
import { alertState, askLookupIn, monitorAlerts, monitorAlertSection, refKey, type ResolvedAsk } from "../src/status/monitorAlert.js";
import type { StatusView } from "../src/status/routes.js";

/**
 * a monitor alert the owner can act on, or one that stays quiet. the owner, 2026-11-02: a social world repo's red "Stopped"
 * card (always-on Reddit, unblocked by the code repo/, which he had snoozed until 2026-11-04) counted as Needs you
 * and had no button.
 */

const NOW = Date.parse("2026-11-02T15:00:00Z");
const iso = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children, flags: [], ...over,
});
const tree = (id: string, asks: Record<string, LocatedAsk[]> = {}): Tree => ({
  milestoneId: id, root: node(id, { kind: "spine", status: "active", color: "blue" }, [node(`${id}/S1`, { ready: true })]),
  counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [], asks,
});
const assignment: Assignment = {
  id: "a1", milestoneId: "zs", personaId: "p1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true, writeEnabled: false, writeScope: "", createdAt: iso(-100), nextRunAt: iso(1), nextWakeAt: iso(1),
};
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: { id: "zs", paused: false }, status: "active", tree: tree("zs"), waiting: [], runs: [], assignments: [assignment], personaName: () => "Delivery Manager", now: NOW, ...over,
});

// a social world repo's line as it reads since a77bf25 (2026-11-02).
const LINE = "always-on Reddit stopped: replies and DMs go out only while Sam's laptop egress is online, waits on home_repo/E946-A4, the Mexico proxy since 2026-10-27T15:39Z · next check 2026-11-04T09:00Z";
const E46A4: ResolvedAsk = {
  code: "E946-A4", repo: "home_repo", state: "open", question: "Approve about $11/month for a Mexico proxy?", milestoneId: "e46", milestoneTitle: "EPIC-946",
  href: "https://team.example.com/milestones/e46?tab=waiting", id: "wj_e46a4", world: "home", card: { ask: "approve", question: "Approve about $11/month for a Mexico proxy?", path: "docs/spines/epic-946.md", line: 40 },
};
const snoozedAsk: ResolvedAsk = { ...E46A4, snoozedUntil: "2026-11-04" };
const asks = (a: ResolvedAsk) => new Map([[refKey({ repo: "home_repo", code: "E946-A4" }), a]]);

describe("E908-S36 (a) an alert whose every unblocking ask is snoozed follows the snooze", () => {
  it("E946-A4 snoozed until 2026-11-04: no Needs you, one snoozed item with the quiet line, not counted", () => {
    const st = milestoneStatus(input({ monitoring: parseMonitoring(LINE), monitorAsks: asks(snoozedAsk) }));
    expect(st.needsYou).toBe(0);
    expect(st.flow.word).not.toBe("needs_you");
    const [a] = st.items;
    expect(a.kind).toBe("monitor_alert");
    expect(a.state).toBe("snoozed");
    expect(a.snoozedUntil).toBe("2026-11-04");
    expect(a.monitor?.next).toBe("Waits on home_repo/E946-A4, snoozed by you until 2026-11-04");
    expect(st.reasons.some((r) => r.startsWith("monitor alert follows your snooze, not counted"))).toBe(true);
    // Not the Delivery Manager's defect either: it names an open ask.
    expect(st.reasons.some((r) => r.includes("names no open ask"))).toBe(false);
  });

  it("when the snooze ends the same alert is counted again (Needs you, open, the ask's card on it)", () => {
    const st = milestoneStatus(input({ monitoring: parseMonitoring(LINE), monitorAsks: asks(E46A4) }));
    expect(st.flow.word).toBe("needs_you");
    expect(st.needsYou).toBe(1);
    expect(st.items[0].state).toBe("open");
    expect(st.items[0].monitor?.asks[0].card?.ask).toBe("approve");
    expect(st.flow.reason).toBe("1 monitor alert");
  });

  it("two asks: counted while one of them is not snoozed; snoozed until the first snooze ends when both are", () => {
    expect(alertState([snoozedAsk, { ...E46A4, code: "E946-A5" }])).toBe("open");
    const both = milestoneStatus(input({
      monitoring: [{ what: "Reddit stopped: waits on home_repo/E946-A4 and home_repo/E946-A5", nextCheckAt: iso(40) }],
      monitorAsks: new Map([["home_repo/E946-A4", { ...snoozedAsk, snoozedUntil: "2026-11-09" }], ["home_repo/E946-A5", { ...snoozedAsk, code: "E946-A5", snoozedUntil: "2026-11-04" }]]),
    }));
    expect(both.items[0].state).toBe("snoozed");
    expect(both.items[0].snoozedUntil).toBe("2026-11-04");
  });

  it("the Delivery Manager's wake section leaves a snoozed alert out", () => {
    const alerts = monitorAlerts(parseMonitoring(LINE), NOW, () => snoozedAsk);
    expect(monitorAlertSection(alerts, NOW)).toBeUndefined();
    expect(monitorAlertSection(monitorAlerts(parseMonitoring(LINE), NOW, () => E46A4), NOW)).toContain("## Monitoring alerts");
  });
});

describe("E908-S36 (c) an alert with no open ask is the Delivery Manager's, never Needs you", () => {
  it("no ask named: an alarm item, needsYou 0, the defect reason for the DM", () => {
    const st = milestoneStatus(input({ monitoring: [{ what: "Reddit writing stopped after a 429", nextCheckAt: iso(2) }] }));
    expect(st.needsYou).toBe(0);
    expect(st.flow.word).not.toBe("needs_you");
    expect(st.items[0].state).toBe("alarm");
    expect(st.reasons).toContain("defect for the Delivery Manager: a stopped or overdue Monitoring item names no open ask: write a coded ask or clear the item");
  });
  it("an ask already answered, or a code that names no ask: also the DM's", () => {
    expect(alertState([{ ...E46A4, state: "answered" }])).toBe("alarm");
    expect(alertState([{ code: "E946-A9", repo: "home_repo", state: "missing" }])).toBe("alarm");
    expect(alertState([])).toBe("alarm");
  });
});

describe("E908-S36 (b) the alert's ask carries its card and its inbox id", () => {
  it("askLookupIn gives the waiting item id the inbox uses, the world and the card fields", async () => {
    const ms: Milestone[] = [
      { id: "zs", title: "EPIC-900", repo: "social", path: "docs/spines/root.md", owner: "", paused: false, createdAt: iso(-1000) },
      { id: "e46", title: "EPIC-946", repo: "Acme/home_repo", path: "docs/spines/epic-946.md", owner: "", paused: false, createdAt: iso(-1000) },
    ];
    const askLine = { code: "E946-A4", question: "Mexico proxy?", state: "open", ask: "approve", options: ["yes", "no"], recommend: "yes", row: "E946-S7", line: 12, risk: "$11/month", since: "2026-11-01" } as unknown as LocatedAsk;
    const trees: Record<string, Tree> = { zs: tree("zs"), e46: tree("e46", { "docs/spines/epic-946.md": [askLine] }) };
    const lookup = askLookupIn({ listMilestones: () => ms, worldOfMilestone: (id) => (id === "zs" ? "social" : "home") }, async (m) => trees[m.id], () => "https://team.example.com", () => "home_repo");
    const got = (await lookup(ms[0], [{ repo: "home_repo", code: "E946-A4" }])).get("home_repo/E946-A4")!;
    expect(got.id).toBe(askItemId("home_repo", "docs/spines/epic-946.md", "E946-S7", "Mexico proxy?"));
    expect(got.world).toBe("home");
    expect(got.card).toEqual({ ask: "approve", question: "Mexico proxy?", path: "docs/spines/epic-946.md", line: 12, row: "E946-S7", options: ["yes", "no"], recommendation: "yes", risk: "$11/month", since: "2026-11-01" });
  });

  it("a snooze, unsnooze or answer on the ask (its own card or the alert's) moves the alert in every stored status at once", () => {
    const st = milestoneStatus(input({ monitoring: parseMonitoring(LINE), monitorAsks: asks(E46A4) })) as StatusView;
    const k = { kind: "status-one" as const, world: "social", milestoneId: "zs" };
    const snoozed = applyPatch(k, st, { kind: "snoozed", id: "wj_e46a4", until: "2026-11-04" }) as StatusView;
    expect(snoozed.needsYou).toBe(0);
    expect(snoozed.items[0]).toMatchObject({ state: "snoozed", snoozedUntil: "2026-11-04" });
    expect(snoozed.items[0].monitor?.next).toBe("Waits on home_repo/E946-A4, snoozed by you until 2026-11-04");
    const back = applyPatch(k, snoozed, { kind: "snoozed", id: "wj_e46a4", until: null }) as StatusView;
    expect(back.needsYou).toBe(1);
    expect(back.items[0].state).toBe("open");
    const answered = applyPatch(k, st, { kind: "answered", id: "wj_e46a4" }) as StatusView;
    expect(answered.needsYou).toBe(0);
    expect(answered.items[0].state).toBe("alarm");
  });
});

describe("E908-S36 (b) the alert's buttons write to the ask in its own world", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s36-"));
    const db: DB = openDb(path.join(dir, "console.db"));
    ensureAuth(db);
    cleanup = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('social', 'social', 'social', 'internal', ?)").run(iso(0));
    const store = createStore(db);
    const zs = createStore(db, { tenant: "social" }).createMilestone({ title: "EPIC-900: Memo social presence", repo: "social", path: "docs/spines/root.md", owner: "Sam", paused: false });
    const e46 = store.createMilestone({ title: "EPIC-946", repo: "home_repo", path: "docs/spines/epic-946.md", owner: "Sam", paused: false });
    const auth = createAuth(db);
    const sam = auth.addMember({ email: "sam@example.com", tenant: "social" });
    auth.addMember({ email: "sam@example.com", tenant: "home" });
    const other = auth.addMember({ email: "tester@example.com", tenant: "social", role: "member" });
    // Production: the owner's a social world repo login is its own user (j…@memory.dev), no the home world membership.
    const jordiZ = auth.addMember({ email: "sam+memo@example.com", tenant: "social" });
    db.prepare("INSERT INTO tenants (id, name, skin, plan, owner_handle, owner_name, created_at) VALUES ('tester-ann', 'Ann', 'social', 'founding', 'ann', 'Ann', ?)").run(iso(0));
    const ann = auth.addMember({ email: "ann@example.com", tenant: "tester-ann" });
    const calls: { path: string; body?: unknown; ctx?: AuthContext }[] = [];
    const inner = async (req: Request) => {
      const u = new URL(req.url);
      calls.push({ path: u.pathname + u.search, ...(req.method === "POST" ? { body: await req.json() } : {}), ctx: currentAuth() });
      if (req.method === "GET") return Response.json([{ id: "wj_real", code: "E946-A4", source: "ask", state: "open" }]);
      return Response.json({ id: "jr_1", spine: { status: "written" } }, { status: 201 });
    };
    const api = new Hono();
    mountAlertActions(api, { db, store, alertAsks: async (m) => (m.id === zs.id ? [{ ...E46A4, milestoneId: e46.id }] : []), fetch: inner });
    const post = (ctx: AuthContext | undefined, p: string, body: unknown) => {
      const go = () => api.request(`http://console${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return ctx ? runWithAuth(ctx, go) : go();
    };
    const session = (userId: string, role: "owner" | "member" = "owner"): AuthContext => ({ mode: "on", identity: { kind: "session", tenant: "social", userId, email: "x@example.com", name: "", role }, scope: "social" });
    return { db, zs, e46, sam, jordiZ, ann, other, calls, post, session };
  };

  it("Sam's social login answers home_repo/E946-A4 from the social page: relayed to its inbox route in home", async () => {
    const t = setup();
    const r = await t.post(t.session(t.sam), `/milestones/${t.zs.id}/alert-asks/E946-A4/respond`, { kind: "approve", text: "" });
    expect(r.status).toBe(201);
    expect(t.calls.map((c) => c.path)).toEqual([`/api/waiting-on-owner?milestoneId=${t.e46.id}`, "/api/waiting-on-owner/wj_real/respond"]);
    expect(t.calls[1].body).toEqual({ kind: "approve", text: "", milestoneId: t.e46.id });
    expect(t.calls[1].ctx).toMatchObject({ mode: "on", scope: "home", via: "gateway", identity: { kind: "session", tenant: "home", userId: t.sam } });
  });

  it("Sam's own social login (no home membership): the internal world's owner is home's owner, so it may act", async () => {
    const t = setup();
    const r = await t.post(t.session(t.jordiZ), `/milestones/${t.zs.id}/alert-asks/E946-A4/respond`, { kind: "approve", text: "" });
    expect(r.status).toBe(201);
    expect(t.calls[1].ctx).toMatchObject({ scope: "home", identity: { kind: "session", tenant: "home", userId: t.jordiZ } });
    // A tester world's owner (its own plan and handle) is not the home world's owner.
    const ann: AuthContext = { mode: "on", identity: { kind: "session", tenant: "tester-ann", userId: t.ann, email: "ann@example.com", name: "", role: "owner" }, scope: "tester-ann" };
    expect(actAs(t.db, ann, "home", "E946-A4")).toMatchObject({ status: 403, code: "not_member" });
    // A non-owner login of a social world repo neither.
    expect(actAs(t.db, t.session(t.other, "member"), "home", "E946-A4")).toMatchObject({ status: 403, code: "not_member" });
  });

  it("Snooze and Unsnooze go the same way (the snooze route of the ask's world)", async () => {
    const t = setup();
    const r = await t.post(t.session(t.sam), `/milestones/${t.zs.id}/alert-asks/e946-a4/snooze`, { until: null });
    expect(r.status).toBe(201);
    expect(t.calls[1]).toMatchObject({ path: "/api/waiting-on-owner/wj_real/snooze", body: { until: null, milestoneId: t.e46.id } });
  });

  it("refused: a login that is not a member of the ask's world, a world token, an ask the milestone's alerts do not name", async () => {
    const t = setup();
    const notMember = await t.post(t.session(t.other, "member"), `/milestones/${t.zs.id}/alert-asks/E946-A4/respond`, { kind: "approve", text: "" });
    expect(notMember.status).toBe(403);
    expect((await notMember.json()).error.code).toBe("not_member");
    const token: AuthContext = { mode: "on", identity: { kind: "token", tenant: "social", tokenId: "t1", label: "repo desk" }, scope: "social" };
    const tok = await t.post(token, `/milestones/${t.zs.id}/alert-asks/E946-A4/respond`, { kind: "approve", text: "" });
    expect(tok.status).toBe(403);
    expect((await tok.json()).error.code).toBe("cross_world");
    const other = await t.post(t.session(t.sam), `/milestones/${t.zs.id}/alert-asks/E946-A9/respond`, { kind: "approve", text: "" });
    expect(other.status).toBe(404);
    expect(t.calls.filter((c) => c.body)).toEqual([]);
  });

  it("auth off: relayed as today's console; same world: the caller's own context", () => {
    const db = {} as DB;
    expect(actAs(db, undefined, "home", "E946-A4")).toEqual({});
    const ctx: AuthContext = { mode: "on", identity: { kind: "token", tenant: "home", tokenId: "t", label: "checks" }, scope: "home" };
    expect(actAs(db, ctx, "home", "E946-A4")).toEqual({ ctx });
  });

  it("the route is tenant safe (a world's login reaches it; the gate's rule 3 judges the path milestone)", () => {
    expect(isTenantSafe("POST", "/api/milestones/ms_1/alert-asks/E946-A4/respond")).toBe(true);
    expect(isTenantSafe("POST", "/api/milestones/ms_1/alert-asks/E946-A4/snooze")).toBe(true);
    expect(isTenantSafe("POST", "/api/milestones/ms_1/alert-asks/E946-A4/secret")).toBe(true);
    expect(isTenantSafe("POST", "/api/milestones/ms_1/alert-asks/E946-A4/delete")).toBe(false);
  });
});
