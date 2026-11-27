import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isOpen } from "../src/auth/routeScope.js";
import { clinicPrompt, createClinicDemo, loadClinics, mountClinicDemo } from "../src/clinicDemo.js";
import { SETUP_TOOLS, setupPrompt, withObjectives } from "../src/clinicSetup.js";

// The set-up call. A clinic's owner says on a call what the receptionist is for; on their yes the objectives
// are written into the clinic's config file with the call that set them, and the receptionist works with them in mind.
const NOW = Date.parse("2026-11-27T10:00:00Z");
const CLINIC = {
  slug: "demo-setup",
  clinic: "Clínica Dental Sonrisa",
  city: "Madrid",
  madeUp: true,
  receptionist: "Lucía",
  hours: { lunes: ["09:00-14:00"] },
  services: [{ name: "Limpieza dental", price: "60 euros", minutes: 45 }],
};

function setup(o: { write?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-setup-"));
  fs.writeFileSync(path.join(dir, "demo-setup.json"), JSON.stringify(CLINIC, null, 2) + "\n");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const writes: string[] = [];
  const agents: string[] = [];
  const demo = createClinicDemo({
    db,
    clinics: () => loadClinics(dir),
    key: async () => "k",
    eleven: (c) => ({ link: async () => (agents.push(clinicPrompt(c)), { agentId: "a", signedUrl: "wss://signed/1" }) }),
    now: () => NOW,
    writeClinic:
      o.write === false
        ? undefined
        : async (slug, make, msg) => {
            const f = path.join(dir, `${slug}.json`);
            fs.writeFileSync(f, make(fs.readFileSync(f, "utf8")));
            writes.push(msg);
            return { state: "pushed" };
          },
  });
  const api = new Hono();
  mountClinicDemo(api, demo);
  const app = new Hono().route("/api", api);
  return { dir, db, demo, app, writes };
}
const post = (app: Hono, p: string, body: object = {}) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const key = (demo: ReturnType<typeof setup>["demo"]) => new URL(`http://x${demo.setupLink("demo-setup")}`).searchParams.get("k")!;

describe("the set-up call", () => {
  it("its private page needs the clinic's own key; a wrong one is not found", async () => {
    const { app, demo } = setup();
    const k = key(demo);
    const ok = await app.request(`/api/public/clinic/demo-setup/puesta-en-marcha?k=${k}`);
    expect(ok.status).toBe(200);
    const h = await ok.text();
    expect(h).toMatch(/Puesta en marcha/);
    expect(h).toMatch(/Aún ninguno/);
    expect(h).toContain('"add_objective","confirm_objectives","file_ticket"');
    expect((await app.request("/api/public/clinic/demo-setup/puesta-en-marcha?k=nope")).status).toBe(404);
    expect((await post(app, "/api/public/clinic/demo-setup/setup/calls?k=nope")).status).toBe(404);
  });

  it("notes each objective, writes them on the owner's yes with the call that set them, and the receptionist then knows them", async () => {
    const { app, demo, dir, writes } = setup();
    const s = (await (await post(app, `/api/public/clinic/demo-setup/setup/calls?k=${key(demo)}`)).json()) as any;
    expect(s.call).toMatch(/^cc_[a-f0-9]{24}$/);
    const tool = async (name: string, args: object = {}) => ((await (await post(app, `/api/public/clinic/demo-setup/calls/${s.call}/tool`, { name, args })).json()) as any).result as string;
    // nothing to confirm yet
    expect(await tool("confirm_objectives")).toMatch(/ningún objetivo/);
    expect(await tool("add_objective", { goal: "No perder llamadas a la hora de comer", measure: "llamadas contestadas de 14 a 16", target: "todas" })).toMatch(/^Apuntado el objetivo 1/);
    expect(await tool("add_objective", { goal: "Más primeras visitas de ortodoncia" })).toMatch(/^Apuntado el objetivo 2/);
    // a change to one already noted replaces it
    expect(await tool("add_objective", { goal: "Más primeras visitas de ortodoncia invisible", target: "diez al mes", number: "2" })).toMatch(/^Apuntado el objetivo 2/);
    // a receptionist's tool is not a set-up tool
    expect(await tool("book_appointment", { name: "x" })).toMatch(/No conozco/);
    expect(await tool("confirm_objectives", { said_yes: "sí, así" })).toMatch(/^Escrito: 2 objetivos/);
    expect(writes).toHaveLength(1);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "demo-setup.json"), "utf8"));
    expect(file.objectives).toEqual([
      { goal: "No perder llamadas a la hora de comer", measure: "llamadas contestadas de 14 a 16", target: "todas" },
      { goal: "Más primeras visitas de ortodoncia invisible", target: "diez al mes" },
    ]);
    expect(file.objectivesFromCall).toBe(s.call);
    expect(file.objectivesAt).toBe(new Date(NOW).toISOString());
    // every other field kept, and the file still loads
    expect(file.services).toEqual(CLINIC.services);
    const c = loadClinics(dir).get("demo-setup")!;
    expect(c.objectives).toHaveLength(2);
    expect(clinicPrompt(c)).toMatch(/Lo que la clínica quiere conseguir contigo[\s\S]*1\. No perder llamadas a la hora de comer; se mide por llamadas contestadas de 14 a 16; meta todas/);
    expect(setupPrompt(c)).toMatch(/Objetivos que ya tiene la clínica/);
    // the owner's view lists the call as a set-up call with its objectives, and the link
    const [call] = demo.calls();
    expect(call.kind).toBe("setup");
    expect(call.objectives).toHaveLength(2);
    const v = (await (await app.request("/api/clinic-demo/setup")).json()) as any;
    expect(v.clinics[0].objectivesFromCall).toBe(s.call);
    expect(v.clinics[0].link).toMatch(/^\/api\/public\/clinic\/demo-setup\/puesta-en-marcha\?k=[a-f0-9]{24}$/);
    // the page shows them now
    expect(await (await app.request(`/api/public/clinic/demo-setup/puesta-en-marcha?k=${key(demo)}`)).text()).toMatch(/No perder llamadas a la hora de comer/);
  });

  it("never says written when the file cannot be written", async () => {
    const { app, demo } = setup({ write: false });
    const s = (await (await post(app, `/api/public/clinic/demo-setup/setup/calls?k=${key(demo)}`)).json()) as any;
    await post(app, `/api/public/clinic/demo-setup/calls/${s.call}/tool`, { name: "add_objective", args: { goal: "Llenar huecos de la agenda" } });
    const r = ((await (await post(app, `/api/public/clinic/demo-setup/calls/${s.call}/tool`, { name: "confirm_objectives", args: {} })).json()) as any).result;
    expect(r).not.toMatch(/^Escrito/);
  });

  it("a visitor's receptionist calls never use up the set-up call's limit", async () => {
    const { app, demo } = setup();
    for (let i = 0; i < 3; i++) expect((await post(app, "/api/public/clinic/demo-setup/calls")).status).toBe(201);
    expect((await post(app, "/api/public/clinic/demo-setup/calls")).status).toBe(429);
    expect((await post(app, `/api/public/clinic/demo-setup/setup/calls?k=${key(demo)}`)).status).toBe(201);
  });

  it("a receptionist call keeps its own tools and never writes objectives", async () => {
    const { app, writes } = setup();
    const s = (await (await post(app, "/api/public/clinic/demo-setup/calls")).json()) as any;
    const r = ((await (await post(app, `/api/public/clinic/demo-setup/calls/${s.call}/tool`, { name: "confirm_objectives", args: {} })).json()) as any).result;
    expect(r).toMatch(/No conozco/);
    expect(writes).toHaveLength(0);
  });

  it("the set-up prompt teaches, asks for objectives, and connects; its tools are the three", () => {
    const p = setupPrompt(CLINIC as any);
    expect(p).toMatch(/1\. Aprender/);
    expect(p).toMatch(/2\. Objetivos/);
    expect(p).toMatch(/3\. Conectar/);
    expect(p).toMatch(/Solo con su sí, llama a confirm_objectives/);
    expect(p).toMatch(/Nunca digas que lo apuntas sin llamar a add_objective/);
    expect(SETUP_TOOLS.map((t) => t.name)).toEqual(["add_objective", "confirm_objectives", "file_ticket"]);
    // the file write keeps unknown fields and ends in a newline
    const out = withObjectives(JSON.stringify({ slug: "x", extra: 1 }), [{ goal: "Una cosa" }], "cc_1", "t");
    expect(JSON.parse(out)).toEqual({ slug: "x", extra: 1, objectives: [{ goal: "Una cosa" }], objectivesFromCall: "cc_1", objectivesAt: "t" });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("only the page and its call start are open; the owner's link list is not", () => {
    expect(isOpen("GET", "/api/public/clinic/demo-setup/puesta-en-marcha")).toBe(true);
    expect(isOpen("POST", "/api/public/clinic/demo-setup/setup/calls")).toBe(true);
    expect(isOpen("GET", "/api/clinic-demo/setup")).toBe(false);
  });
});
