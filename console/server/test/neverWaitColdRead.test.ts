// Blocked on you never waits on a cold read. A view with no stored row answers from its nearest stored
// neighbour after the budget (the inline read carries on), a slow asker lookup is cut at its budget, each console
// copy sets its own indexer CPU cap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createReadModelHost, nearestView } from "../src/readModel/host.js";
import { ensureReadModel, writeSnapshot } from "../src/readModel/table.js";
import { keyOf, type ViewKey } from "../src/readModel/views.js";
import { INDEXER_LIMITS, indexerLimitsFromEnv } from "../src/indexer/launch.js";
import { withinBudget } from "../src/inbox/routes.js";

let dir: string;
let db: DB;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s90-"));
  db = openDb(path.join(dir, "console.db"));
  ensureReadModel(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const world: ViewKey = { kind: "waiting", world: "w", includeSettled: false };
const items = [
  { id: "a", milestoneId: "m1", state: "open" },
  { id: "b", milestoneId: "m2", state: "open" },
  { id: "c", milestoneId: "m3", state: "open", referencedBy: [{ milestoneId: "m1" }] },
];

describe("a cold view never holds the request ", () => {
  it("answers a milestone's missing view from the world view, narrowed, after the budget", async () => {
    writeSnapshot(db, keyOf(world), { items, defects: [], scopedIds: ["m1", "m2", "m3"] }, "2026-11-12T17:00:00.000Z");
    const logs: string[] = [];
    const host = createReadModelHost({ db, mode: "external", worlds: () => ["w"], tickMs: 0, runningRuns: () => [], inlineBudgetMs: 50, log: (m) => logs.push(m) });
    let finished = false;
    const slow = () => new Promise<{ items: { id: string }[]; scopedIds: string[] }>((res) => setTimeout(() => ((finished = true), res({ items: [], scopedIds: [] })), 400));
    const t0 = Date.now();
    const v = await host.view<{ items: { id: string }[]; scopedIds: string[] }>({ kind: "waiting", world: "w", milestoneId: "m1", includeSettled: false }, slow);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(v.source).toBe("fallback");
    expect(v.payload.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(v.payload.scopedIds).toEqual(["m1"]);
    expect(finished).toBe(false);
    expect(logs.join("\n")).toMatch(/not stored yet, answered from/);
  });

  it("waits as before when no neighbour is stored, and a hit never waits", async () => {
    const host = createReadModelHost({ db, mode: "external", worlds: () => ["w"], tickMs: 0, runningRuns: () => [], inlineBudgetMs: 20 });
    const v = await host.view<{ x: number }>({ kind: "status", world: "w", includeSettled: false }, () => new Promise((r) => setTimeout(() => r({ x: 2 }), 60)));
    expect(v).toMatchObject({ source: "inline", payload: { x: 2 } });
    writeSnapshot(db, keyOf(world), { items, defects: [], scopedIds: [] }, "2026-11-12T17:00:00.000Z");
    const hit = await host.view(world, () => Promise.reject(new Error("never read")));
    expect(hit.source).toBe("snapshot");
  });

  it("the other includeSettled stands in for a status view", () => {
    const stored = { kind: "status", world: "w", includeSettled: true } as ViewKey;
    const peek = <T,>(k: ViewKey) => (keyOf(k) === keyOf(stored) ? ({ payload: { ok: 1 } as T, asOf: "t", source: "snapshot" as const }) : undefined);
    expect(nearestView({ kind: "status", world: "w", includeSettled: false }, peek)?.from).toBe(keyOf(stored));
    expect(nearestView({ kind: "review", world: "w" }, peek)).toBeUndefined();
  });
});

describe("budgets and caps ", () => {
  it("withinBudget gives undefined past the budget and the value before it", async () => {
    expect(await withinBudget(new Promise((r) => setTimeout(() => r(1), 200)), 20)).toBeUndefined();
    expect(await withinBudget(Promise.resolve(3), 20)).toBe(3);
    expect(await withinBudget(Promise.reject(new Error("git failed")), 20)).toBeUndefined();
  });

  it("CONSOLE_INDEXER_CPU_QUOTA sets the indexer's cap; nonsense keeps the default", () => {
    expect(indexerLimitsFromEnv({ CONSOLE_INDEXER_CPU_QUOTA: "20%" }).cpuQuota).toBe("20%");
    expect(indexerLimitsFromEnv({ CONSOLE_INDEXER_CPU_QUOTA: "lots" })).toEqual(INDEXER_LIMITS);
    expect(indexerLimitsFromEnv({})).toEqual(INDEXER_LIMITS);
  });
});
