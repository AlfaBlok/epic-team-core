import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createJobServers, mountJobServers } from "../src/status/jobServers.js";

// box/provision.py's job records reach the console: each alert once (fresh only), status lines and spend on the route.
const T0 = Date.parse("2026-11-11T11:00:00Z");
const line = (id: string, at: string, kind = "job-outlived") => JSON.stringify({ id, at, kind, text: `text ${id}` }) + "\n";

describe("job servers (T97-S7)", () => {
  it("sends each fresh alert once and never an old one", () => {
    const dir = mkdtempSync(join(tmpdir(), "e97s7-"));
    writeFileSync(join(dir, "job-alerts.jsonl"), line("old", "2026-11-11T09:00:00Z") + line("a1", "2026-11-11T10:55:00Z"));
    let t = T0;
    const sent: string[] = [];
    const j = createJobServers({ dir, now: () => t, alert: (k, x) => sent.push(`${k}|${x}`) });
    j.tick();
    expect(sent).toEqual(["job-outlived|EpicTeam job servers: text a1"]);
    j.tick();
    expect(sent.length).toBe(1);
    t += 60_000;
    appendFileSync(join(dir, "job-alerts.jsonl"), line("a2", "2026-11-11T11:01:00Z", "job-fails") + "{half");
    j.tick();
    expect(sent[1]).toBe("job-fails|EpicTeam job servers: text a2");
  });

  it("shows every customer's status line and today's spend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e97s7-"));
    writeFileSync(join(dir, "job-status.json"), JSON.stringify({ acme: { state: "failed", line: "A job failed: x (3 in a row).", fails_in_row: 3, at: "2026-11-11T10:00:00Z" }, sam: { state: "ok", line: "Jobs run normally." } }));
    writeFileSync(join(dir, "job-spend.json"), JSON.stringify({ days: { "2026-11-10": { eur: 1, servers: 2, limit_eur: 5 }, "2026-11-11": { eur: 0.16, servers: 6, limit_eur: 5 } } }));
    const j = createJobServers({ dir, now: () => T0 });
    const api = new Hono();
    mountJobServers(api, () => j);
    const r = await (await api.request("/job-servers")).json();
    expect(r.customers.map((c: { customer: string }) => c.customer)).toEqual(["acme", "sam"]);
    expect(r.customers[0].failsInRow).toBe(3);
    expect(r.spend).toMatchObject({ day: "2026-11-11", eur: 0.16 });
    expect(j.health()).toMatchObject({ state: "off", failing: ["acme"], spendToday: 0.16 });
  });

  it("no files: empty, not an error", () => {
    const j = createJobServers({ dir: join(tmpdir(), "e97s7-none-x") });
    expect(j.tick()).toMatchObject({ customers: [], spend: null, alerts: [] });
  });
});
