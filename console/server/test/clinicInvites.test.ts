import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createClinicDemo, loadClinics, mountClinicDemo } from "../src/clinicDemo.js";
import { isOpen } from "../src/auth/routeScope.js";
import { createInvites, INVITE_CALLS_PER_DAY, mountInvites } from "../src/clinicInvites.js";

// From the internet the demo opens by invite only, each invite one email.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clinics-"));
fs.writeFileSync(path.join(DIR, "demo-sales.json"), JSON.stringify({"slug": "demo-sales", "clinic": "Clínica Dental Sonrisa", "city": "Madrid", "address": "Calle de Ejemplo 12, 28010 Madrid", "madeUp": true, "receptionist": "Lucía", "hours": {"lunes": ["09:00-14:00", "16:00-20:30"], "martes": ["09:00-14:00", "16:00-20:30"], "miércoles": ["09:00-14:00", "16:00-20:30"], "jueves": ["09:00-14:00", "16:00-20:30"], "viernes": ["09:00-15:00"], "sábado": ["10:00-14:00"]}, "services": [{"name": "Primera visita y revisión", "price": "gratis", "minutes": 30}, {"name": "Limpieza dental", "price": "60 euros", "minutes": 45}, {"name": "Empaste", "price": "desde 50 euros", "minutes": 45}, {"name": "Blanqueamiento", "price": "250 euros", "minutes": 60}, {"name": "Ortodoncia invisible, primera consulta", "price": "gratis", "minutes": 30}, {"name": "Urgencia por dolor", "price": "40 euros", "minutes": 30}], "insurers": ["Sanitas", "Adeslas", "DKV", "Mapfre"], "dentists": ["Dra. Marta Ruiz", "Dr. Pablo Serrano"], "notes": ["Hay parking público a 100 metros.", "Traiga su tarjeta del seguro si tiene uno."], "callsPerDay": 40, "sales": {"company": "Acme", "what": "Una recepcionista por voz que contesta el teléfono y el WhatsApp de la clínica cuando recepción no puede: a la hora de comer, por la tarde y el fin de semana. Informa de precios, horarios y seguros, reserva, cambia o cancela citas en la agenda, y pasa la llamada a una persona cuando hace falta.", "price": "149 euros al mes por clínica, teléfono y WhatsApp, todas las llamadas incluidas", "priceWhatsappOnly": "79 euros al mes por clínica, solo WhatsApp", "trialDays": 14, "setup": "Una llamada de 45 minutos con nosotros: sus precios, horarios, seguros y dentistas en una hoja, el desvío de llamadas activado y la agenda conectada. Sin coste de instalación y sin instalar nada.", "terms": "Los pacientes siguen llamando al número de siempre. Se cancela cualquier mes.", "followUp": "una llamada de 15 minutos con el equipo de Acme para preparar la prueba gratis"}}));
fs.writeFileSync(path.join(DIR, "plain-clinic.json"), JSON.stringify({"slug": "plain-clinic", "clinic": "Clínica Dental Norte", "city": "Madrid", "address": "Avenida de Ejemplo 40, 28035 Madrid", "madeUp": true, "receptionist": "Carmen", "hours": {"lunes": ["10:00-14:00", "16:00-20:00"], "martes": ["10:00-14:00", "16:00-20:00"], "miércoles": ["10:00-14:00", "16:00-20:00"], "jueves": ["10:00-14:00", "16:00-20:00"], "viernes": ["10:00-14:00"]}, "services": [{"name": "Revisión", "price": "30 euros", "minutes": 30}, {"name": "Limpieza dental", "price": "55 euros", "minutes": 45}, {"name": "Endodoncia", "price": "desde 180 euros", "minutes": 60}, {"name": "Implante, primera consulta", "price": "gratis", "minutes": 30}], "insurers": ["Sanitas", "Asisa"], "dentists": ["Dr. Luis Romero"], "notes": ["Estamos junto a la parada de metro."], "callsPerDay": 20}));
fs.writeFileSync(path.join(DIR, "broken.json"), "{ not json");
// Friday 27 Nov 2026, 11:00 in Madrid
const NOW = Date.parse("2026-11-27T10:00:00Z");

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const sent: { to: string; subject: string; text: string }[] = [];
  const demo = createClinicDemo({
    db,
    clinics: () => loadClinics(DIR),
    key: async () => "k",
    eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: "wss://signed/1" }) }),
    now: () => NOW,
  });
  const invites = createInvites({ db, now: () => NOW, base: "https://voz.example", from: "Sam <noreply@example.com>", send: async (m) => (sent.push(m), { ok: true, id: "m1" }) });
  const api = new Hono();
  mountClinicDemo(api, demo, { invites, letterOk: (c) => c === "PRUEBA01" });
  mountInvites(api, invites, (slug) => demo.list().find((x) => x.slug === slug));
  const app = new Hono().route("/api", api);
  return { db, app, invites, sent };
}
const NET = { "cf-connecting-ip": "203.0.113.9" };
const post = (app: Hono, p: string, b: unknown, h: Record<string, string> = NET) =>
  app.request(`/api${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });

describe("the demo by invite", () => {
  it("from the internet the page shows the email box, not the call button", async () => {
    const { app } = setup();
    const r = await app.request("/api/public/clinic/demo-sales", { headers: NET });
    const h = await r.text();
    expect(r.status).toBe(200);
    expect(h).toContain('data-testid="invite-email"');
    expect(h).not.toContain('data-testid="call-start"');
    // on our private network it stays open, as before
    expect(await (await app.request("/api/public/clinic/demo-sales")).text()).toContain('data-testid="call-start"');
  });

  it("a call from the internet needs an invite or a letter's code", async () => {
    const { app } = setup();
    const r = await post(app, "/public/clinic/demo-sales/calls", {});
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("invite_needed");
    expect((await post(app, "/public/clinic/demo-sales/calls", { invite: "a".repeat(20) })).status).toBe(403);
    expect((await post(app, "/public/clinic/demo-sales/calls", { code: "PRUEBA01" })).status).toBe(201);
  });

  it("the email box mails one invite to that email, and its link opens the page and the call", async () => {
    const { app, sent, invites, db } = setup();
    const r = await post(app, "/public/clinic/demo-sales/invitacion", { email: " Sam@example.com " });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("sam@example.com");
    const link = sent[0].text.match(/https:\/\/voz\.example\/api\/public\/clinic\/demo-sales\?i=([a-z0-9]{20})/);
    expect(link).toBeTruthy();
    const token = link![1];
    const page = await (await app.request(`/api/public/clinic/demo-sales?i=${token}`, { headers: NET })).text();
    expect(page).toContain('data-testid="call-start"');
    const call = await post(app, "/public/clinic/demo-sales/calls", { invite: token });
    expect(call.status).toBe(201);
    const id = (await call.json()).call;
    expect((db.prepare("SELECT invite FROM clinic_calls WHERE id = ?").get(id) as any).invite).toBe(token);
    // the same email again: the same invite, no second mail the same day
    await post(app, "/public/clinic/demo-sales/invitacion", { email: "sam@example.com" }, { "cf-connecting-ip": "203.0.113.10" });
    expect(sent).toHaveLength(1);
    expect(invites.list()[0]).toMatchObject({ email: "sam@example.com", via: "request", calls: 1 });
    // an invite belongs to its demo clinic only
    expect((await post(app, "/public/clinic/plain-clinic/calls", { invite: token })).status).toBe(403);
  });

  it("an invite starts a few calls a day; a revoked one none; robots and bad emails get nothing", async () => {
    const { app, sent, invites } = setup();
    const made = await invites.create(loadClinics(DIR).get("demo-sales")!, "owner@example.com");
    expect(sent).toHaveLength(0); // the team's invite is mailed only when it says so
    const t = made!.invite.token;
    for (let n = 0; n < INVITE_CALLS_PER_DAY; n++) await post(app, "/public/clinic/demo-sales/calls", { invite: t }, { "cf-connecting-ip": `198.51.100.${n}` });
    expect((await post(app, "/public/clinic/demo-sales/calls", { invite: t }, { "cf-connecting-ip": "198.51.100.99" })).status).toBe(429);
    invites.revoke(t);
    expect((await app.request(`/api/public/clinic/demo-sales?i=${t}`, { headers: NET })).status).toBe(403);
    expect((await post(app, "/public/clinic/demo-sales/invitacion", { email: "not-an-email" })).status).toBe(400);
    expect((await post(app, "/public/clinic/demo-sales/invitacion", { email: "e@example.com", web: "spam" })).status).toBe(200);
    expect(sent).toHaveLength(0);
    // three asks an hour a visitor
    for (const e of ["a@example.com", "b@example.com", "c@example.com"]) await post(app, "/public/clinic/demo-sales/invitacion", { email: e }, { "cf-connecting-ip": "192.0.2.7" });
    expect((await post(app, "/public/clinic/demo-sales/invitacion", { email: "d@example.com" }, { "cf-connecting-ip": "192.0.2.7" })).status).toBe(429);
    expect(sent).toHaveLength(3);
  });

  it("the email box is an open route; the invite list is the owner's", () => {
    expect(isOpen("POST", "/api/public/clinic/sonrisa-demo/invitacion")).toBe(true);
    expect(isOpen("GET", "/api/clinic-demo/invites")).toBe(false);
  });
});
