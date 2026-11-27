import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CLINIC_TOOLS, clinicPrompt, createClinicDemo, loadClinics, mountClinicDemo } from "../src/clinicDemo.js";
import { createLeads, LEAD_COLUMNS, parseCsv, questionsIn, toCsv, whoAnswered, withLead } from "../src/clinicLeads.js";

// Each call qualifies the lead, and the call lands as a lead row in the Dental clinics table.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-leads-"));
const SALES = {
  slug: "demo-sales",
  clinic: "Clínica Dental Sonrisa",
  city: "Madrid",
  madeUp: true,
  receptionist: "Lucía",
  hours: { lunes: ["09:00-14:00"], viernes: ["09:00-15:00"] },
  services: [{ name: "Limpieza dental", price: "60 euros", minutes: 45 }],
  sales: { company: "Acme", what: "Una recepcionista por voz que contesta el teléfono de la clínica.", price: "149 euros al mes por clínica", trialDays: 14, setup: "Una llamada de 45 minutos.", followUp: "una llamada de 15 minutos" },
};
fs.mkdirSync(path.join(DIR, "clinics"));
fs.writeFileSync(path.join(DIR, "clinics", "demo-sales.json"), JSON.stringify(SALES));
fs.writeFileSync(path.join(DIR, "clinics", "plain.json"), JSON.stringify({ ...SALES, slug: "plain", sales: undefined }));
const NOW = Date.parse("2026-11-27T10:00:00Z");

function setup() {
  const repo = fs.mkdtempSync(path.join(DIR, "repo-"));
  const rel = "docs/trackers/voice-clinic/dental-clinics.csv";
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  const head = [...LEAD_COLUMNS];
  const row = (o: Record<string, string>) => head.map((h) => o[h] ?? "");
  fs.writeFileSync(
    path.join(repo, rel),
    toCsv([head, row({ Name: "Clínica de prueba, Madrid", Status: "test", Code: "PRUEBA01", City: "Madrid", Source: "test" }), row({ Name: "Clínica Real", Status: "posted", Code: "AB12CD", City: "Valencia" })]),
  );
  const writes: string[] = [];
  const leads = createLeads({
    repoDir: () => repo,
    rel,
    write: async (r, f, make, msg) => {
      const abs = path.join(r, f);
      fs.writeFileSync(abs, make(fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined));
      writes.push(msg);
      return { state: "pushed" };
    },
  });
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const demo = createClinicDemo({ db, clinics: () => loadClinics(path.join(DIR, "clinics")), key: async () => "k", eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: "wss://x" }) }), now: () => NOW, leads });
  const api = new Hono();
  mountClinicDemo(api, demo);
  const app = new Hono().route("/api", api);
  const post = (p: string, b: unknown, ip = "10.0.0.1") => app.request(`/api/public/clinic/demo-sales${p}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(b) });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { db, demo, leads, writes, post, settle };
}

describe("the rep qualifies the lead", () => {
  it("a sales clinic's rep asks who answers and takes a note for the team; a plain clinic never does", () => {
    const all = loadClinics(path.join(DIR, "clinics"));
    const p = clinicPrompt(all.get("demo-sales")!);
    expect(p).toMatch(/dueño o director de la clínica, de recepción u otra persona/);
    expect(p).toMatch(/qualify_lead/);
    const tool = CLINIC_TOOLS(all.get("demo-sales")!).find((t) => t.name === "qualify_lead")!;
    expect(tool.parameters.required).toEqual(["who", "needs"]);
    expect(clinicPrompt(all.get("plain")!)).not.toMatch(/qualify_lead/);
    expect(CLINIC_TOOLS(all.get("plain")!).map((t) => t.name)).not.toContain("qualify_lead");
  });

  it("who answered reads as dueño, recepcionista or otra persona", () => {
    expect(whoAnswered("Soy la directora")).toBe("dueño");
    expect(whoAnswered("el dueño de la clínica")).toBe("dueño");
    expect(whoAnswered("recepción")).toBe("recepcionista");
    expect(whoAnswered("la higienista")).toBe("otra persona: la higienista");
    expect(whoAnswered("")).toBe("no lo dijo");
  });
});

describe("the call lands as a lead row", () => {
  it("a test letter's code runs start to finish into its row: who answered, questions, needs, answer", async () => {
    const t = setup();
    const s = (await (await t.post("/calls", { code: "prueba01" })).json()) as { call: string };
    const r = (await (await t.post(`/calls/${s.call}/tool`, { name: "qualify_lead", args: { who: "Soy el dueño", clinic: "Clínica de prueba", city: "Madrid", asks: "¿Funciona con mi programa de agenda?", needs: "cubrir la hora de comer y las llamadas perdidas", answer: "sí" } })).json()) as { result: string };
    expect(r.result).toMatch(/Anotado/);
    await t.settle();
    const row = t.leads.rows().find((x) => x.Code === "PRUEBA01")!;
    expect(row).toMatchObject({ Name: "Clínica de prueba, Madrid", Status: "test", "Who answered": "dueño", Questions: "¿Funciona con mi programa de agenda?", Needs: "cubrir la hora de comer y las llamadas perdidas", Answer: "sí" });
    expect(row.Called).toBe(`2026-11-27 ${s.call}`);
    expect(t.writes[0]).toMatch(/Clinic lead from call cc_\w+ \(code PRUEBA01\)/);
    // once per call; the end adds nothing more
    expect(((await (await t.post(`/calls/${s.call}/tool`, { name: "qualify_lead", args: { who: "x", needs: "y" } })).json()) as { result: string }).result).toMatch(/Ya está anotado/);
    await t.post(`/calls/${s.call}/end`, { reason: "bye", transcript: [{ who: "caller", text: "Adiós" }] });
    await t.settle();
    expect(t.writes).toHaveLength(1);
    expect(t.leads.rows()).toHaveLength(2);
    // the console keeps the lead with its needs (the requirements key result reads it)
    expect(JSON.parse((t.db.prepare("SELECT data FROM clinic_bookings WHERE kind = 'lead'").get() as { data: string }).data)).toMatchObject({ needs: "cubrir la hora de comer y las llamadas perdidas", code: "PRUEBA01" });
  });

  it("a letter's call that hangs up before the note still lands, with what the caller asked", async () => {
    const t = setup();
    const s = (await (await t.post("/calls", { code: "AB12CD" })).json()) as { call: string };
    await t.post(`/calls/${s.call}/end`, { reason: "hangup", transcript: [{ who: "voice", text: "Hola" }, { who: "caller", text: "¿Cuánto cuesta al mes?" }, { who: "caller", text: "Vale, gracias" }] });
    await t.settle();
    const row = t.leads.rows().find((x) => x.Code === "AB12CD")!;
    expect(row).toMatchObject({ Status: "lead", "Who answered": "no lo dijo", Questions: "¿Cuánto cuesta al mes?" });
    expect(row.Answer).toMatch(/colgó sin decirlo/);
  });

  it("a call without a code lands only when qualified, as an inbound row; a call with no note writes nothing", async () => {
    const t = setup();
    const a = (await (await t.post("/calls", {})).json()) as { call: string };
    await t.post(`/calls/${a.call}/end`, { reason: "bye", transcript: [{ who: "caller", text: "Quiero una cita" }] });
    await t.settle();
    expect(t.writes).toHaveLength(0);
    const b = (await (await t.post("/calls", {}, "10.0.0.2")).json()) as { call: string };
    await t.post(`/calls/${b.call}/tool`, { name: "qualify_lead", args: { who: "recepcionista", clinic: "Dental Sur", city: "Sevilla", needs: "el WhatsApp", answer: "quizá" } });
    await t.settle();
    const row = t.leads.rows().find((x) => x.Name === "Dental Sur")!;
    expect(row).toMatchObject({ Status: "inbound", City: "Sevilla", "Who answered": "recepcionista", Needs: "el WhatsApp", Answer: "quizá" });
    expect(t.leads.rows().find((x) => x.Code === "AB12CD")!.Status).toBe("posted");
  });

  it("a bad code is no code, and a caller's words never break the table", async () => {
    const t = setup();
    const s = (await (await t.post("/calls", { code: "<script>" })).json()) as { call: string };
    expect((t.db.prepare("SELECT code FROM clinic_calls WHERE id = ?").get(s.call) as { code: string | null }).code).toBeNull();
    const w = withLead(undefined, { call: "cc_1", day: "2026-11-27", who: "dueño", clinic: 'Clínica "La, Sonrisa"', asks: "uno\ndos, tres", needs: "a|b", answer: "sí" });
    const rows = parseCsv(w.text);
    expect(rows[0]).toEqual(LEAD_COLUMNS);
    expect(rows[1][0]).toBe('Clínica "La, Sonrisa"');
    expect(rows[1][LEAD_COLUMNS.indexOf("Questions")]).toBe("uno dos, tres");
    expect(questionsIn([{ who: "caller", text: "Hola" }, { who: "caller", text: "¿Y el precio?" }, { who: "voice", text: "¿Algo más?" }])).toBe("¿Y el precio?");
  });
});
