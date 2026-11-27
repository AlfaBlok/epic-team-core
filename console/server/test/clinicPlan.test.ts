import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createClinicDemo, loadClinics, mountClinicDemo } from "../src/clinicDemo.js";
import { startClinicPlan } from "../src/clinicPlan.js";
import { isOpen } from "../src/auth/routeScope.js";

// a real clinic's receptionist answers only once its plan is on; a made-up demo clinic always answers.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clinics-on-"));
const base = { city: "Madrid", hours: { lunes: ["09:00-14:00"] }, services: [{ name: "Limpieza", price: "60 euros" }] };
fs.writeFileSync(path.join(DIR, "real-clinica.json"), JSON.stringify({ ...base, slug: "real-clinica", clinic: "Clínica Real" }));
fs.writeFileSync(path.join(DIR, "demo-clinica.json"), JSON.stringify({ ...base, slug: "demo-clinica", clinic: "Clínica Demo", madeUp: true }));
const NOW = Date.parse("2026-11-27T10:00:00Z");

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const demo = createClinicDemo({ db, clinics: () => loadClinics(DIR), key: async () => "k", eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: "wss://signed" }) }), now: () => NOW });
  const api = new Hono();
  mountClinicDemo(api, demo);
  return { db, app: new Hono().route("/api", api) };
}
const call = (app: Hono, slug: string) => app.request(`/api/public/clinic/${slug}/calls`, { method: "POST", body: "{}" });

describe("a clinic's receptionist turns on when it pays", () => {
  it("a real clinic answers only once its plan is on; the demo clinic always", async () => {
    const s = setup();
    expect((await call(s.app, "demo-clinica")).status).toBe(201);
    const off = await call(s.app, "real-clinica");
    expect(off.status).toBe(409);
    expect(((await off.json()) as any).error.code).toBe("not_on");
    startClinicPlan(s.db, { slug: "real-clinica", subscription: "sub_1", livemode: false, trialEnd: "2026-12-11T10:00:00Z", at: new Date(NOW).toISOString() });
    expect((await call(s.app, "real-clinica")).status).toBe(201);
  });
  it("the activation page is open and shows the plan", async () => {
    const s = setup();
    const r = await s.app.request("/api/public/clinic/real-clinica/activar");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("14 días gratis, luego 149 € al mes");
    expect(isOpen("GET", "/api/public/clinic/real-clinica/activar")).toBe(true);
    expect(isOpen("POST", "/api/public/clinic/real-clinica/checkout")).toBe(true);
  });
});
