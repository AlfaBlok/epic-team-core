import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isOpen } from "../src/auth/routeScope.js";
import { clinicGreeting, clinicPrompt, createClinicDemo, loadClinics, mountClinicDemo, parseDay } from "../src/clinicDemo.js";
import { createClinicIntake, daysIn, INTAKE_TOOLS, intakePrompt, mountClinicIntake, rangesIn, slugFor } from "../src/clinicIntake.js";
import { agentBody, elevenCalls } from "../src/voice/elevenAgent.js";

// Your virtual agent in Catalan: the person asks for the call on the Catalan page, the Catalan agent takes the clinic's
// requirements, and on their yes they are written as a new clinic config whose own Catalan receptionist answers.
const NOW = Date.parse("2026-11-27T10:00:00Z");

function setup(o: { write?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-intake-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const writes: string[] = [];
  const links: string[] = [];
  const intake = createClinicIntake({
    db,
    clinics: () => loadClinics(dir),
    key: async () => "k",
    eleven: { link: async (lang) => (links.push(String(lang)), { agentId: "a", signedUrl: "wss://signed/ca" }) },
    now: () => NOW,
    writeClinic:
      o.write === false
        ? undefined
        : async (slug, make, msg) => {
            const f = path.join(dir, `${slug}.json`);
            fs.writeFileSync(f, make(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined));
            writes.push(msg);
            return { state: "pushed" };
          },
  });
  const receptionLinks: string[] = [];
  const demo = createClinicDemo({
    db,
    clinics: () => loadClinics(dir),
    key: async () => "k",
    eleven: () => ({ link: async (lang) => (receptionLinks.push(String(lang)), { agentId: "r", signedUrl: "wss://signed/r" }) }),
    now: () => NOW,
  });
  const api = new Hono();
  mountClinicIntake(api, intake);
  mountClinicDemo(api, demo);
  const app = new Hono().route("/api", api);
  return { dir, db, intake, app, writes, links, receptionLinks };
}
const post = (app: Hono, p: string, body: object = {}) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the Catalan call-me page", () => {
  it("is open, in Catalan, one button, and its routes only", async () => {
    const { app } = setup();
    const r = await app.request("/api/public/agent-catala");
    expect(r.status).toBe(200);
    const h = await r.text();
    expect(h).toContain('<html lang="ca">');
    expect(h).toMatch(/El teu agent virtual, en català/);
    expect(h).toMatch(/Vull que em truqui/);
    expect(h).toContain('"/api/public/agent-catala"');
    expect(h).toContain('"set_business","set_hours","add_service","add_note","add_objective","read_back","confirm_setup"');
    expect(h).toMatch(/ningú no rep trucades sense haver-les demanat/);
    expect(isOpen("GET", "/api/public/agent-catala")).toBe(true);
    expect(isOpen("POST", "/api/public/agent-catala/calls")).toBe(true);
    expect(isOpen("POST", `/api/public/agent-catala/calls/ci_${"a".repeat(24)}/tool`)).toBe(true);
    expect(isOpen("GET", "/api/clinic-intake/calls")).toBe(false);
  });

  it("a call takes the requirements and, on the yes, writes a Catalan clinic whose receptionist answers in Catalan", async () => {
    const { app, dir, writes, links, receptionLinks } = setup();
    const s = (await (await post(app, "/api/public/agent-catala/calls")).json()) as any;
    expect(s.call).toMatch(/^ci_[a-f0-9]{24}$/);
    expect(links).toEqual(["ca"]);
    const tool = async (name: string, args: object = {}) => (await (await post(app, `/api/public/agent-catala/calls/${s.call}/tool`, { name, args })).json()) as any;
    // nothing written before the essentials
    expect((await tool("confirm_setup")).result).toMatch(/falta el nom de la clínica, la ciutat, l'horari, almenys un servei/);
    expect((await tool("set_business", { name: "Clínica Dental Montseny", kind: "clínica dental", city: "Girona", owner: "Marta", agent_name: "Laia" })).result).toMatch(/^Apuntat: Clínica Dental Montseny/);
    expect((await tool("set_hours", { days: "de dilluns a divendres", hours: "09:00-14:00, 16:00-20:00" })).result).toMatch(/dilluns, dimarts, dimecres, dijous, divendres: 09:00 a 14:00 i 16:00 a 20:00/);
    expect((await tool("set_hours", { days: "dissabte", hours: "de 10 a 13" })).result).toMatch(/dissabte: 10:00 a 13:00/);
    expect((await tool("set_hours", { days: "el dia de la setmana", hours: "9-14" })).result).toMatch(/No he entès els dies/);
    expect((await tool("add_service", { name: "Neteja dental", price: "55 euros", minutes: "45" })).result).toMatch(/Ja ho tens tot el necessari/);
    expect((await tool("add_service", { name: "Primera visita", price: "gratuïta" })).result).toMatch(/^Apuntat: Primera visita/);
    // the same service again changes its price
    await tool("add_service", { name: "neteja dental", price: "60 euros" });
    await tool("add_note", { text: "Hi ha aparcament gratuït davant de la clínica." });
    await tool("add_objective", { goal: "No perdre cap trucada a l'hora de dinar", measure: "trucades contestades de 14 a 16", target: "totes" });
    const back = (await tool("read_back")).result;
    expect(back).toMatch(/Clínica: Clínica Dental Montseny, clínica dental, a Girona/);
    expect(back).toMatch(/Neteja dental, 60 euros; Primera visita, gratuïta/);
    expect(back).toMatch(/pregunta si ho deixes així/);
    const done = await tool("confirm_setup", { said_yes: "sí, endavant" });
    expect(done.result).toMatch(/^Fet: l'agent de Clínica Dental Montseny, Laia, ja està configurat en català/);
    expect(done.link).toBe("/api/public/clinic/clinica-dental-montseny-girona");
    expect(writes).toEqual([`Clinic intake: clinica-dental-montseny-girona set up from its Catalan call ${s.call} (via console)`]);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "clinica-dental-montseny-girona.json"), "utf8"));
    expect(cfg).toMatchObject({
      slug: "clinica-dental-montseny-girona",
      clinic: "Clínica Dental Montseny",
      city: "Girona",
      kind: "clínica dental",
      lang: "ca",
      receptionist: "Laia",
      hours: { lunes: ["09:00-14:00", "16:00-20:00"], viernes: ["09:00-14:00", "16:00-20:00"], sábado: ["10:00-13:00"] },
      services: [{ name: "Neteja dental", price: "60 euros" }, { name: "Primera visita", price: "gratuïta" }],
      notes: ["Hi ha aparcament gratuït davant de la clínica."],
      objectives: [{ goal: "No perdre cap trucada a l'hora de dinar", measure: "trucades contestades de 14 a 16", target: "totes" }],
      objectivesFromCall: s.call,
      fromCall: s.call,
      tryUntil: "2026-12-04",
      owner: { name: "Marta" },
    });
    expect(cfg.madeUp).toBeUndefined();
    // a second yes writes nothing more
    expect((await tool("confirm_setup")).result).toMatch(/Ja està configurat/);
    expect(writes).toHaveLength(1);
    // the new clinic loads, its page answers, and its receptionist speaks Catalan on its try days
    const c = loadClinics(dir).get("clinica-dental-montseny-girona")!;
    expect(c).toBeTruthy();
    expect(clinicGreeting(c)).toBe("Hola, Clínica Dental Montseny, l'atén Laia. En què el puc ajudar?");
    expect(clinicPrompt(c)).toMatch(/^# Idioma: parles sempre en català/);
    expect(clinicPrompt(c)).toMatch(/la recepcionista por voz de Clínica Dental Montseny, una clínica dental en Girona/);
    expect(clinicPrompt(c)).toMatch(/No perdre cap trucada a l'hora de dinar/);
    expect((await app.request("/api/public/clinic/clinica-dental-montseny-girona")).status).toBe(200);
    const r = await post(app, "/api/public/clinic/clinica-dental-montseny-girona/calls");
    expect(r.status).toBe(201);
    expect(receptionLinks).toEqual(["ca"]);
    // the call's end keeps its text
    expect((await post(app, `/api/public/agent-catala/calls/${s.call}/end`, { reason: "bye", transcript: [{ who: "voice", text: "Adéu!" }] })).status).toBe(200);
    expect((await tool("read_back")).result).toBeUndefined();
  });

  it("a written clinic past its try days waits on its plan", async () => {
    const { dir, db } = setup();
    fs.writeFileSync(
      path.join(dir, "vella.json"),
      JSON.stringify({ slug: "vella", clinic: "Clínica Vella", city: "Vic", lang: "ca", hours: { lunes: ["09:00-14:00"] }, services: [{ name: "Visita", price: "40 euros" }], tryUntil: "2026-11-20" }),
    );
    const demo = createClinicDemo({ db, clinics: () => loadClinics(dir), key: async () => "k", eleven: () => ({ link: async () => ({ agentId: "r", signedUrl: "wss://x" }) }), now: () => NOW });
    await expect(demo.start("vella", "1.2.3.4")).rejects.toThrow(/aún no está activada/);
  });

  it("is rate-limited: three calls an hour a visitor", async () => {
    const { app } = setup();
    for (let i = 0; i < 3; i++) expect((await post(app, "/api/public/agent-catala/calls")).status).toBe(201);
    expect((await post(app, "/api/public/agent-catala/calls")).status).toBe(429);
  });

  it("with no writer it says the team will do it and writes nothing", async () => {
    const { app } = setup({ write: false });
    const s = (await (await post(app, "/api/public/agent-catala/calls")).json()) as any;
    const tool = async (name: string, args: object = {}) => (await (await post(app, `/api/public/agent-catala/calls/${s.call}/tool`, { name, args })).json()) as any;
    await tool("set_business", { name: "Fisio Mar", city: "Tarragona" });
    await tool("set_hours", { days: "feiners", hours: "8 a 15" });
    await tool("add_service", { name: "Sessió", price: "45 euros" });
    expect((await tool("confirm_setup")).result).toMatch(/l'equip ho farà avui/);
  });
});

describe("Catalan words", () => {
  it("days, hours and file names as said on the phone", () => {
    expect(daysIn("de dilluns a dijous")).toEqual([1, 2, 3, 4]);
    expect(daysIn("dilluns-divendres")).toEqual([1, 2, 3, 4, 5]);
    expect(daysIn("feiners")).toEqual([1, 2, 3, 4, 5]);
    expect(daysIn("cada dia")).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(daysIn("dimarts i dijous")).toEqual([2, 4]);
    expect(rangesIn("de 9 a 14 i de 4 a 8")).toEqual(["09:00-14:00", "16:00-20:00"]);
    expect(rangesIn("9h-13.30h")).toEqual(["09:00-13:30"]);
    expect(rangesIn("tancat")).toEqual([]);
    expect(rangesIn("al matí")).toBeUndefined();
    expect(slugFor("Clínica Dental Montseny", "Girona", () => false)).toBe("clinica-dental-montseny-girona");
    expect(slugFor("Clínica Dental Montseny", "Girona", (s) => s === "clinica-dental-montseny-girona")).toBe("clinica-dental-montseny-girona-2");
    // a long name is cut at a whole word, never mid-word
    expect(slugFor("Clínica Dental Test Montseny", "Girona", () => false)).toBe("clinica-dental-test-montseny-girona");
    expect(slugFor("Centre de Fisioteràpia i Rehabilitació del Montseny", "Sant Celoni", () => false)).toBe("centre-de-fisioterapia-i-rehabilitacio");
    // a Catalan receptionist passes the day as said
    expect(parseDay("dimarts", NOW)).toBe("2026-12-01");
    expect(parseDay("demà", NOW)).toBe("2026-11-28");
    expect(parseDay("3 de desembre", NOW)).toBe("2026-12-03");
  });

  it("the intake agent: Catalan on v4 Turbo with its own name, its tools and an end on goodbye", () => {
    const b = agentBody(intakePrompt(), "Hola", INTAKE_TOOLS as any, "Agent en català · posada en marxa", ["clinic-intake"], "ca");
    expect(b.conversation_config.agent.language).toBe("ca");
    expect(b.conversation_config.tts).toMatchObject({ model_id: "eleven_v4_turbo" });
    expect(intakePrompt()).toMatch(/Parles sempre en català/);
    expect(intakePrompt()).toMatch(/Mai truques ningú per iniciativa pròpia/);
    expect(intakePrompt("Acme")).toMatch(/agent virtual en català d'Acme\./);
    expect(intakePrompt("Nova")).toMatch(/agent virtual en català de Nova\./);
  });

  it("the door names a Catalan agent apart from the English and Spanish ones", async () => {
    const made: any[] = [];
    const f = (async (url: string, init: any) => {
      if (String(url).includes("/agents?search")) return new Response(JSON.stringify({ agents: [] }));
      if (String(url).includes("/agents/create")) return made.push(JSON.parse(init.body)), new Response(JSON.stringify({ agent_id: "ag_ca" }));
      return new Response(JSON.stringify({ signed_url: "wss://ok" }));
    }) as any;
    const door = elevenCalls({ name: "Línia", key: async () => "k", prompt: () => "p", firstMessage: () => "h", tools: () => [], f });
    await door.link("ca");
    expect(made[0].name).toBe("Línia · Català");
    expect(made[0].conversation_config.tts.model_id).toBe("eleven_v4_turbo");
  });
});
