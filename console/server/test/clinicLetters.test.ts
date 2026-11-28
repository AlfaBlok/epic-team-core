import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clinicGreeting, createClinicDemo, loadClinics, mountClinicDemo } from "../src/clinicDemo.js";
import { codeRe, createLetters, loadLetters, mountLetters, newCode, normalizeCode } from "../src/clinicLetters.js";
import { isOpen } from "../src/auth/routeScope.js";

// The posted letter's code opens the call page with our AI rep; each scan is counted per clinic and a call
// started there carries the clinic's code.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "letters-"));
fs.writeFileSync(
  path.join(DIR, "sonrisa-demo.json"),
  JSON.stringify({
    slug: "sonrisa-demo", clinic: "Clínica Dental Sonrisa", city: "Madrid", madeUp: true, receptionist: "Lucía",
    hours: { lunes: ["09:00-14:00"] }, services: [{ name: "Limpieza dental", price: "60 euros", minutes: 45 }],
    sales: { company: "Acme", what: "Una recepcionista por voz para clínicas dentales.", price: "149 euros al mes por clínica, todas las llamadas incluidas", trialDays: 14, setup: "Una llamada de 45 minutos.", followUp: "una llamada de 15 minutos", contact: "privacy@example.com" },
  }),
);
fs.mkdirSync(path.join(DIR, "letters"));
fs.writeFileSync(
  path.join(DIR, "letters", "batch.json"),
  JSON.stringify({ demo: "sonrisa-demo", letters: [{ code: "K7M4QP", clinic: "Clínica Dental Prueba", city: "Madrid", test: true }, { code: "ZX93HT", clinic: "Clínica Dental Real", city: "Valencia" }] }),
);
fs.writeFileSync(path.join(DIR, "letters", "broken.json"), "{ nope");
const BAD = fs.mkdtempSync(path.join(os.tmpdir(), "letters-bad-"));
fs.writeFileSync(path.join(BAD, "bad.json"), JSON.stringify({ demo: "sonrisa-demo", letters: [{ code: "K7M4QP", clinic: "A", city: "Madrid" }, { code: "bad", clinic: "Broken", city: "X" }] }));
const NOW = Date.parse("2026-11-27T10:00:00Z");

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const demo = createClinicDemo({
    db,
    clinics: () => loadClinics(DIR),
    key: async () => "k",
    eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: "wss://signed/1" }) }),
    now: () => NOW,
  });
  const letters = createLetters({ db, demo, letters: () => loadLetters(path.join(DIR, "letters")) });
  const api = new Hono();
  mountClinicDemo(api, demo);
  mountLetters(api, letters, demo);
  return { db, letters, app: new Hono().route("/api", api) };
}
const get = (app: Hono, p: string, ip = "1.2.3.4") => app.request(p, { headers: { "x-real-ip": ip } });
const post = (app: Hono, p: string, b: unknown = {}, ip = "1.2.3.4") =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(b) });

describe("letter codes", () => {
  it("six characters with no look-alikes; a batch file loads, a bad code or file is skipped", () => {
    const c = newCode(new Set());
    expect(c).toMatch(codeRe);
    expect(c).not.toMatch(/[01OIL]/);
    expect(normalizeCode(" k7m-4qp ")).toBe("K7M4QP");
    expect([...loadLetters(path.join(DIR, "letters")).keys()].sort()).toEqual(["K7M4QP", "ZX93HT"]);
    // one bad code fails its whole batch: nothing half-loaded
    expect(loadLetters(BAD).size).toBe(0);
  });
});

describe("the letter's page", () => {
  it("the code opens the call page with the clinic's name, says plainly it is an AI agent and a live demo, with the privacy note", async () => {
    const { app } = setup();
    const r = await get(app, "/api/public/carta/k7m4qp");
    expect(r.status).toBe(200);
    const h = await r.text();
    expect(h).toMatch(/Clínica Dental Prueba: hable ahora con nuestra recepcionista de IA/);
    expect(h).toMatch(/agente de inteligencia artificial y esto es una demostración en directo/);
    expect(h).toMatch(/Privacidad: Acme tomó la dirección postal.*privacy@example.com/);
    expect(h).toMatch(/data-testid="call-start"[^>]*>Empezar la llamada/);
    expect(h).toMatch(/149 euros al mes/);
    expect(h).toMatch(/const CODE = "K7M4QP" \|\|/);
  });

  it("each scan is counted for its clinic, and a call from the page carries the code", async () => {
    const { app, letters } = setup();
    await get(app, "/api/public/carta/ZX93HT", "5.5.5.5");
    await get(app, "/api/public/carta/ZX93HT", "5.5.5.5");
    await get(app, "/api/public/carta/ZX93HT", "6.6.6.6");
    const c = await post(app, "/api/public/clinic/sonrisa-demo/calls", { code: "ZX93HT" });
    expect(c.status).toBe(201);
    // a made-up code, or a call from the plain demo page, counts for no clinic
    expect((await post(app, "/api/public/clinic/sonrisa-demo/calls", { code: "AAAAAA" }, "7.7.7.7")).status).toBe(201);
    const s = letters.stats();
    const real = s.letters.find((l) => l.code === "ZX93HT")!;
    expect(real).toMatchObject({ scans: 3, people: 2, calls: 1, test: false });
    expect(s.letters.find((l) => l.code === "K7M4QP")).toMatchObject({ scans: 0, calls: 0, test: true });
    expect(s.totals).toEqual({ letters: 1, scanned: 1, called: 1, followUps: 0 });
  });

  it("an unknown code shows the box to type it again; a typed code goes to its page", async () => {
    const { app } = setup();
    const n = await get(app, "/api/public/carta/QQQQQQ");
    expect(n.status).toBe(404);
    expect(await n.text()).toMatch(/No encontramos el código/);
    expect(await (await get(app, "/api/public/carta")).text()).toMatch(/seis letras y números/);
    const r = await get(app, "/api/public/carta?codigo=zx93-ht");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("carta/ZX93HT");
    expect(new URL(r.headers.get("location")!, "https://h.example/api/public/carta?codigo=zx93ht").pathname).toBe("/api/public/carta/ZX93HT");
  });

  it("the rep's first words say it is an AI and a live demo", () => {
    expect(clinicGreeting(loadClinics(DIR).get("sonrisa-demo")!)).toMatch(/recepcionista de inteligencia artificial.*demostración en directo/);
  });

  it("only the code box and its page are open; the reading needs a login", () => {
    expect(isOpen("GET", "/api/public/carta")).toBe(true);
    expect(isOpen("GET", "/api/public/carta/K7M4QP")).toBe(true);
    expect(isOpen("GET", "/api/clinic-demo/letters")).toBe(false);
    expect(isOpen("POST", "/api/public/carta/K7M4QP")).toBe(false);
  });
});
