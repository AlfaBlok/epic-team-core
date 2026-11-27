import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clinicAgentBody, clinicPrompt, createClinicDemo, CLINIC_TOOLS, freeSlots, loadClinics, mountClinicDemo, parseDay } from "../src/clinicDemo.js";
import { isOpen } from "../src/auth/routeScope.js";

// The clinic receptionist. Each clinic is one config file; the demo clinic with a sales block also sells.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clinics-"));
fs.writeFileSync(path.join(DIR, "demo-sales.json"), JSON.stringify({"slug": "demo-sales", "clinic": "Clínica Dental Sonrisa", "city": "Madrid", "address": "Calle de Ejemplo 12, 28010 Madrid", "madeUp": true, "receptionist": "Lucía", "hours": {"lunes": ["09:00-14:00", "16:00-20:30"], "martes": ["09:00-14:00", "16:00-20:30"], "miércoles": ["09:00-14:00", "16:00-20:30"], "jueves": ["09:00-14:00", "16:00-20:30"], "viernes": ["09:00-15:00"], "sábado": ["10:00-14:00"]}, "services": [{"name": "Primera visita y revisión", "price": "gratis", "minutes": 30}, {"name": "Limpieza dental", "price": "60 euros", "minutes": 45}, {"name": "Empaste", "price": "desde 50 euros", "minutes": 45}, {"name": "Blanqueamiento", "price": "250 euros", "minutes": 60}, {"name": "Ortodoncia invisible, primera consulta", "price": "gratis", "minutes": 30}, {"name": "Urgencia por dolor", "price": "40 euros", "minutes": 30}], "insurers": ["Sanitas", "Adeslas", "DKV", "Mapfre"], "dentists": ["Dra. Marta Ruiz", "Dr. Pablo Serrano"], "notes": ["Hay parking público a 100 metros.", "Traiga su tarjeta del seguro si tiene uno."], "callsPerDay": 40, "sales": {"company": "Acme", "what": "Una recepcionista por voz que contesta el teléfono y el WhatsApp de la clínica cuando recepción no puede: a la hora de comer, por la tarde y el fin de semana. Informa de precios, horarios y seguros, reserva, cambia o cancela citas en la agenda, y pasa la llamada a una persona cuando hace falta.", "price": "149 euros al mes por clínica, teléfono y WhatsApp, todas las llamadas incluidas", "priceWhatsappOnly": "79 euros al mes por clínica, solo WhatsApp", "trialDays": 14, "setup": "Una llamada de 45 minutos con nosotros: sus precios, horarios, seguros y dentistas en una hoja, el desvío de llamadas activado y la agenda conectada. Sin coste de instalación y sin instalar nada.", "terms": "Los pacientes siguen llamando al número de siempre. Se cancela cualquier mes.", "followUp": "una llamada de 15 minutos con el equipo de Acme para preparar la prueba gratis"}}));
fs.writeFileSync(path.join(DIR, "plain-clinic.json"), JSON.stringify({"slug": "plain-clinic", "clinic": "Clínica Dental Norte", "city": "Madrid", "address": "Avenida de Ejemplo 40, 28035 Madrid", "madeUp": true, "receptionist": "Carmen", "hours": {"lunes": ["10:00-14:00", "16:00-20:00"], "martes": ["10:00-14:00", "16:00-20:00"], "miércoles": ["10:00-14:00", "16:00-20:00"], "jueves": ["10:00-14:00", "16:00-20:00"], "viernes": ["10:00-14:00"]}, "services": [{"name": "Revisión", "price": "30 euros", "minutes": 30}, {"name": "Limpieza dental", "price": "55 euros", "minutes": 45}, {"name": "Endodoncia", "price": "desde 180 euros", "minutes": 60}, {"name": "Implante, primera consulta", "price": "gratis", "minutes": 30}], "insurers": ["Sanitas", "Asisa"], "dentists": ["Dr. Luis Romero"], "notes": ["Estamos junto a la parada de metro."], "callsPerDay": 20}));
fs.writeFileSync(path.join(DIR, "broken.json"), "{ not json");
// Friday 27 Nov 2026, 11:00 in Madrid
const NOW = Date.parse("2026-11-27T10:00:00Z");

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  let links = 0;
  const demo = createClinicDemo({
    db,
    clinics: () => loadClinics(DIR),
    key: async () => "k",
    eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: `wss://signed/${++links}` }) }),
    now: () => NOW,
  });
  const api = new Hono();
  mountClinicDemo(api, demo);
  const app = new Hono().route("/api", api);
  return { db, demo, app, links: () => links };
}

describe("clinic configs", () => {
  it("every file in clinics/ loads, and a second clinic needs only its file", () => {
    const all = loadClinics(DIR);
    expect([...all.keys()].sort()).toEqual(["demo-sales", "plain-clinic"]);
    expect(all.get("demo-sales")!.sales?.trialDays).toBe(14);
    expect(all.get("plain-clinic")!.sales).toBeUndefined();
  });

  it("the sales clinic's prompt explains the offer with a plain price; a clinic without sales never does", () => {
    const all = loadClinics(DIR);
    const sales = clinicPrompt(all.get("demo-sales")!);
    expect(sales).toMatch(/149 euros al mes por clínica/);
    expect(sales).toMatch(/14 días gratis/);
    expect(sales).not.toMatch(/margen|coste más/i);
    const plain = clinicPrompt(all.get("plain-clinic")!);
    expect(plain).toMatch(/Clínica Dental Norte/);
    expect(plain).not.toMatch(/149|book_follow_up/);
    expect(CLINIC_TOOLS(all.get("plain-clinic")!).map((t) => t.name)).toEqual(["free_slots", "book_appointment"]);
    expect(CLINIC_TOOLS(all.get("demo-sales")!).map((t) => t.name)).toContain("book_follow_up");
    // a garbled clinic name never blocks the follow-up: a name and a phone or email are enough
    expect(CLINIC_TOOLS(all.get("demo-sales")!).find((t) => t.name === "book_follow_up")!.parameters.required).toEqual(["name", "contact"]);
    expect(sales).toMatch(/nunca la retengas/);
  });

  it("the agent speaks Spanish, takes no overrides and needs a signed link", () => {
    const c = loadClinics(DIR).get("demo-sales")!;
    const b = clinicAgentBody(c)("p", "hola", CLINIC_TOOLS(c) as any, "n", ["t"]) as any;
    expect(b.conversation_config.agent.language).toBe("es");
    expect(b.conversation_config.tts.model_id).toBe("eleven_flash_v2_5");
    expect(b.platform_settings.auth.enable_auth).toBe(true);
    expect(b.platform_settings.overrides.conversation_config_override.agent.prompt.prompt).toBe(false);
    expect(b.conversation_config.agent.prompt.tools.map((t: any) => t.name)).toEqual(["free_slots", "book_appointment", "book_follow_up", "end_call"]);
  });
});

describe("the agenda", () => {
  it("reads days said on the phone from Madrid's today", () => {
    expect(parseDay("hoy", NOW)).toBe("2026-11-27");
    expect(parseDay("mañana", NOW)).toBe("2026-11-28");
    expect(parseDay("el martes", NOW)).toBe("2026-12-01");
    expect(parseDay("el lunes por la mañana", NOW)).toBe("2026-11-30");
    expect(parseDay("3 de diciembre", NOW)).toBe("2026-12-03");
    expect(parseDay("2026-12-02", NOW)).toBe("2026-12-02");
    expect(parseDay("cuando sea", NOW)).toBeUndefined();
  });
  it("offers only open half hours, the same each time, and none on a closed day", () => {
    const c = loadClinics(DIR).get("demo-sales")!;
    const a = freeSlots(c, "2026-12-01", new Set(), NOW);
    expect(a.length).toBeGreaterThan(2);
    expect(a).toEqual(freeSlots(c, "2026-12-01", new Set(), NOW));
    expect(a.every((h) => (h >= "09:00" && h < "14:00") || (h >= "16:00" && h < "20:30"))).toBe(true);
    expect(freeSlots(c, "2026-11-29", new Set(), NOW)).toEqual([]); // Sunday
  });
});

describe("the public call", () => {
  const post = (app: Hono, p: string, b: unknown = {}, ip = "1.2.3.4") =>
    app.request(p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(b) });

  it("the page has one call button and the offer; an unknown clinic is a 404", async () => {
    const { app } = setup();
    const r = await app.request("/api/public/clinic/demo-sales");
    expect(r.status).toBe(200);
    const h = await r.text();
    expect(h).toMatch(/data-testid="call-start"/);
    expect(h).toMatch(/149 euros al mes/);
    expect(h).toMatch(/14 días gratis/);
    expect((await app.request("/api/public/clinic/nope")).status).toBe(404);
    const n = await (await app.request("/api/public/clinic/plain-clinic")).text();
    expect(n).not.toMatch(/149 euros/);
  });

  it("books a patient into a free slot and a clinic owner's follow-up, then keeps the transcript", async () => {
    const { app, demo } = setup();
    const s = (await (await post(app, "/api/public/clinic/demo-sales/calls")).json()) as any;
    expect(s.signedUrl).toMatch(/^wss:\/\/signed/);
    const tool = async (name: string, args: object) => ((await (await post(app, `/api/public/clinic/demo-sales/calls/${s.call}/tool`, { name, args })).json()) as any).result as string;
    const slots = await tool("free_slots", { day: "el martes" });
    expect(slots).toMatch(/martes 1 de diciembre \(2026-12-01\): horas libres/);
    const first = slots.match(/\d{2}:\d{2}/)![0];
    expect(await tool("book_appointment", { name: "Ana", service: "Limpieza dental", date: "2026-12-01", time: first })).toMatch(/^Reservado/);
    // the same half hour is no longer free
    expect(await tool("book_appointment", { name: "Luis", service: "Revisión", date: "2026-12-01", time: first })).toMatch(/no están libres/);
    expect(await tool("book_follow_up", { name: "Dra. Pérez", clinic: "Clínica Pérez", contact: "600000000", when: "el lunes por la tarde" })).toMatch(/^Apuntado/);
    await post(app, `/api/public/clinic/demo-sales/calls/${s.call}/end`, { reason: "bye", transcript: [{ who: "voice", text: "Hola" }, { who: "owner", text: "Adiós" }] });
    const [c] = demo.calls();
    expect(c.reason).toBe("bye");
    expect(c.transcript).toEqual([{ who: "voice", text: "Hola" }, { who: "caller", text: "Adiós" }]);
    expect(c.bookings.map((b: any) => b.kind)).toEqual(["appointment", "follow_up"]);
    // an ended call takes no more tools
    expect((await post(app, `/api/public/clinic/demo-sales/calls/${s.call}/tool`, { name: "free_slots", args: { day: "hoy" } })).status).toBe(404);
  });

  it("a clinic without sales has no follow-up tool", async () => {
    const { app } = setup();
    const s = (await (await post(app, "/api/public/clinic/plain-clinic/calls")).json()) as any;
    const r = (await (await post(app, `/api/public/clinic/plain-clinic/calls/${s.call}/tool`, { name: "book_follow_up", args: { name: "x", contact: "y" } })).json()) as any;
    expect(r.result).toMatch(/No conozco/);
  });

  it("a visitor gets 3 calls an hour", async () => {
    const { app, links } = setup();
    for (let i = 0; i < 3; i++) expect((await post(app, "/api/public/clinic/demo-sales/calls", {}, "9.9.9.9")).status).toBe(201);
    const r = await post(app, "/api/public/clinic/demo-sales/calls", {}, "9.9.9.9");
    expect(r.status).toBe(429);
    expect(links()).toBe(3);
    expect((await post(app, "/api/public/clinic/demo-sales/calls", {}, "8.8.8.8")).status).toBe(201);
  });

  it("only the page and its call routes are open without a login", () => {
    expect(isOpen("GET", "/api/public/clinic/demo-sales")).toBe(true);
    expect(isOpen("POST", "/api/public/clinic/demo-sales/calls")).toBe(true);
    expect(isOpen("POST", `/api/public/clinic/demo-sales/calls/cc_${"a".repeat(24)}/tool`)).toBe(true);
    expect(isOpen("POST", `/api/public/clinic/demo-sales/calls/cc_${"a".repeat(24)}/end`)).toBe(true);
    expect(isOpen("GET", "/api/clinic-demo/calls")).toBe(false);
    expect(isOpen("POST", "/api/public/clinic/demo-sales/calls/x/other")).toBe(false);
  });
});
