import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";

// an outside probe reports slow answers: one alarm per episode, /api/health shows it, ok ends it.
const dbs: DB[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-speed-"));
  roots.push(root);
  const db = openDb(path.join(root, "c.db"));
  dbs.push(db);
  const sent: string[] = [];
  const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => { throw new Error("none"); } };
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    readModel: { mode: "in-process", tickMs: 0, drift: { everyMs: 3600_000, firstAfterMs: 3600_000, confirmAfterMs: 0, alert: true } },
    whatsapp: { sender: async () => async (text: string) => (sent.push(text), { ok: true, receipt: "whatsapp:m1:sent" }) },
  });
  const post = (b: unknown) => app.request("/api/health/answer-speed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const health = async () => ((await (await app.request("/api/health")).json()) as { answerSpeed: { state: string; worstMs?: number; page?: string } }).answerSpeed;
  return { post, health, sent };
}

describe("POST /api/health/answer-speed", () => {
  it("is off until a probe reports, alarms once per slow episode and clears on ok", async () => {
    const { post, health, sent } = setup();
    expect((await health()).state).toBe("off");
    expect((await post({ state: "slow", worstMs: 31_500, minutes: 5, page: "http://probe.example/" })).status).toBe(200);
    expect(await health()).toMatchObject({ state: "slow", worstMs: 31_500, page: "http://probe.example/" });
    await post({ state: "slow", worstMs: 9_000, minutes: 6 });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((t) => /console is slow/.test(t))).toHaveLength(1);
    expect(sent[0]).toMatch(/over 5 s for 5 minutes \(worst 31\.5 s\)/);
    expect((await health()).worstMs).toBe(31_500);
    await post({ state: "ok" });
    expect((await health()).state).toBe("ok");
  });

  it("refuses an unknown state", async () => {
    const { post } = setup();
    expect((await post({ state: "maybe" })).status).toBe(400);
  });
});
