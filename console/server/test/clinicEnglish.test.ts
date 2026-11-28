import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CLINIC_TOOLS, clinicGreeting, clinicLang, clinicPrompt, createClinicDemo, loadClinics, mountClinicDemo, parseDay } from "../src/clinicDemo.js";
import { createInvites, mountInvites, senderAs } from "../src/clinicInvites.js";

// The Irish demo clinic speaks English, its page lists what Irish callers ask, its invites open on its
// own address and its mail goes out under the product's name.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clinics-en-"));
fs.writeFileSync(path.join(DIR, "harbour-dental-demo.json"), JSON.stringify({"slug": "harbour-dental-demo", "clinic": "Harbour Dental", "city": "Galway", "address": "12 Example Quay, Galway", "madeUp": true, "lang": "en", "kind": "a family dental practice", "site": "https://host1.example.com/clinics/demo", "voiceAccent": "irish", "receptionist": "Aoife", "hours": {"lunes": ["08:30-13:00", "14:00-18:00"], "martes": ["08:30-13:00", "14:00-18:00"], "miércoles": ["08:30-13:00", "14:00-19:30"], "jueves": ["08:30-13:00", "14:00-18:00"], "viernes": ["08:30-13:00", "14:00-17:00"], "sábado": ["09:00-13:00"]}, "services": [{"name": "Check-up and exam", "price": "65 euro, or free with PRSI if you qualify", "minutes": 30}, {"name": "Scale and polish", "price": "80 euro, or 15 euro with PRSI if you qualify", "minutes": 30}, {"name": "Filling", "price": "from 110 euro", "minutes": 45}, {"name": "Emergency appointment for pain", "price": "75 euro", "minutes": 30}, {"name": "Teeth whitening", "price": "350 euro", "minutes": 60}, {"name": "Implant consultation", "price": "free, with one of our dentists", "minutes": 30}], "insurers": ["PRSI Dental Treatment Benefit", "Medical card (DTSS)", "VHI", "Laya Healthcare", "Irish Life Health"], "dentists": ["Dr. Niamh Brennan", "Dr. Ciarán O'Shea"], "notes": ["Medical card patients: we see adults on the medical card scheme; bring the card to the visit.", "PRSI: a free exam and a scale and polish at a reduced price each year for those who qualify; we check it on the day with your PPS number at the desk, never over the phone.", "Parking: a public car park on the quay, two minutes' walk; the practice is on the ground floor with step-free access.", "Implants, orthodontics and anything over 500 euro: the caller is put through to the practice manager, or the manager rings back the same day (file_ticket)."], "callsPerDay": 40, "owner": {"name": "Practice manager"}, "sales": {"company": "Epic Voice Clinic", "what": "An AI receptionist that becomes your clinic's phone line. It answers every call, day and night, at the first ring: it books, moves and cancels appointments, answers prices, hours, PRSI and insurance, turns each new patient into a lead with their name and need, puts everything it cannot settle on your team's task list with a promised day, and puts the calls that matter, like implants or an urgent case, through to your people.", "price": "149 euro a month per clinic, every call included", "trialDays": 14, "setup": "One 45 minute call with us: your prices, hours, schemes and dentists on one sheet, your number forwarded to it, and the calls you want put through to people. No set-up fee and nothing to install.", "terms": "Patients keep ringing the number they know. Cancel any month.", "followUp": "a 15 minute call with the Epic Voice Clinic team to set up your free trial", "contact": "hello@example.com"}}));
const NOW = Date.parse("2026-11-27T10:00:00Z"); // Friday

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const sent: { from: string; to: string; subject: string; text: string }[] = [];
  const demo = createClinicDemo({ db, clinics: () => loadClinics(DIR), key: async () => "k", eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: "wss://signed/1" }) }), now: () => NOW });
  const invites = createInvites({ db, now: () => NOW, base: "https://voz.example", from: "Someone <noreply@example.com>", send: async (m) => (sent.push(m as any), { ok: true, id: "m1" }) });
  const api = new Hono();
  mountClinicDemo(api, demo, { invites });
  mountInvites(api, invites, (slug) => demo.list().find((x) => x.slug === slug));
  return { demo, app: new Hono().route("/api", api), sent };
}

describe("the Irish demo clinic", () => {
  const c = loadClinics(DIR).get("harbour-dental-demo")!;
  it("loads and speaks English", () => {
    expect(c).toBeTruthy();
    expect(clinicLang(c)).toBe("en");
    expect(clinicGreeting(c)).toMatch(/^Hello, Harbour Dental/);
    expect(clinicPrompt(c)).toMatch(/phone line, not an answering machine/);
    expect(CLINIC_TOOLS(c).find((t) => t.name === "free_slots")!.description).toMatch(/free times/);
  });
  it("reads days said in English", () => {
    expect(parseDay("tomorrow", NOW)).toBe("2026-11-28");
    expect(parseDay("next Tuesday", NOW)).toBe("2026-12-01");
    expect(parseDay("the 3rd of December", NOW)).toBe("2026-12-03");
    expect(parseDay("December 3", NOW)).toBe("2026-12-03");
  });
  it("answers its tools in English", async () => {
    const { demo } = setup();
    const r = await demo.start("harbour-dental-demo", "10.0.0.1");
    const t = await demo.tool("harbour-dental-demo", r.call, "free_slots", { day: "Monday" });
    expect(t.result).toMatch(/^Monday 30 November \(2026-11-30\)/);
  });
  it("its page lists the likely questions, each one tap", async () => {
    const { app } = setup();
    const h = await (await app.request("/api/public/clinic/harbour-dental-demo")).text();
    expect(h).toContain('lang="en-IE"');
    expect(h).toContain("What callers to an Irish practice ask");
    expect((h.match(/data-ask=/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(h).toContain("PRSI");
  });
  it("from the internet without an invite: the English email box; its invite opens on the clinic's own address under the product's name", async () => {
    const { app, sent } = setup();
    const NET = { "cf-connecting-ip": "203.0.113.9" };
    const h = await (await app.request("/api/public/clinic/harbour-dental-demo", { headers: NET })).text();
    expect(h).toContain("Send my invite");
    const r = await app.request("/api/public/clinic/harbour-dental-demo/invitacion", { method: "POST", headers: { "content-type": "application/json", ...NET }, body: JSON.stringify({ email: "sam@example.com" }) });
    expect(r.status).toBe(200);
    expect(sent[0].from).toBe("Epic Voice Clinic <noreply@example.com>");
    expect(sent[0].subject).toMatch(/^Your invite/);
    expect(sent[0].text).toMatch(/https:\/\/host1\.example\.com\/clinics\/demo\?i=[a-z0-9]{20}/);
  });
  it("senderAs keeps the address and shows the product", () => {
    expect(senderAs("noreply@example.com", { clinic: "X", sales: { company: "Epic Voice Clinic" } as any })).toBe("Epic Voice Clinic <noreply@example.com>");
  });
});
