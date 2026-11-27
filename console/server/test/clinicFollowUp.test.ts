import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clinicPrompt, createClinicDemo, loadClinics, mountClinicDemo } from "../src/clinicDemo.js";
import { createFollowUp, newTasksText, parseTasks, repoFileWriter, withTicket, workingDaysAfter } from "../src/clinicFollowUp.js";
import { isOpen } from "../src/auth/routeScope.js";

// The clinic follow-up: what the receptionist cannot solve becomes a ticket on the clinic's own task tree (a file in the repo), the
// caller gets a trace page with each promise and its day, and a ringing page names who calls.
const NOW = Date.parse("2026-11-27T10:00:00Z"); // Friday 11:00 in Madrid

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const dir = path.join(root, "docs/clinics");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test-clinic.json"),
    JSON.stringify({ slug: "test-clinic", clinic: "Clínica Dental Prueba", city: "Madrid", madeUp: true, receptionist: "Lucía", hours: { lunes: ["09:00-14:00"] }, services: [{ name: "Revisión", price: "gratis" }], owner: { name: "Dra. Prueba" } }),
  );
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  return { root, dir };
}

function setup() {
  const { root, dir } = repo();
  const db = new Database(":memory:");
  db.exec("CREATE TABLE voice_settings (key TEXT PRIMARY KEY, value TEXT)");
  const writes: Promise<unknown>[] = [];
  const real = repoFileWriter();
  const followUp = createFollowUp({ db, dir: () => dir, repoDir: () => root, now: () => NOW, write: (...a) => { const p = real(...a); writes.push(p); return p; } });
  const demo = createClinicDemo({ db, followUp, clinics: () => loadClinics(dir), key: async () => "k", eleven: () => ({ link: async () => ({ agentId: "a", signedUrl: "wss://signed/1" }) }), now: () => NOW });
  const api = new Hono();
  mountClinicDemo(api, demo);
  return { root, dir, db, demo, app: new Hono().route("/api", api), settle: () => Promise.all(writes) };
}
const post = (app: Hono, p: string, b: unknown = {}) => app.request(p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "5.5.5.5" }, body: JSON.stringify(b) });

describe("the clinic's task tree", () => {
  it("a working day after Friday is Monday; a row survives a round trip and never carries a pipe or a newline", () => {
    expect(workingDaysAfter(NOW, 1)).toBe("2026-11-30");
    expect(workingDaysAfter(NOW, 0)).toBe("2026-11-27");
    const t = { id: "ct_0123456789", slug: "x", call: "cc_1", opened: "2026-11-27T10:00Z", need: "Saber si | aceptan\n`Asisa`", who: "paciente", promise: "p", due: "2026-11-30", status: "abierto", reminded: "—" };
    const text = withTicket(newTasksText("Clínica X", "x"), t);
    const [back] = parseTasks(text, "x");
    expect(back.need).toBe("Saber si aceptan Asisa");
    expect(back.due).toBe("2026-11-30");
    expect(text).toMatch(/## Recordatorios/);
  });

  it("every clinic's receptionist is told to file what it cannot solve and to say only the promise it gets back", () => {
    const p = clinicPrompt(loadClinics(repo().dir).get("test-clinic")!);
    expect(p).toMatch(/file_ticket/);
    expect(p).toMatch(/nunca prometas otra cosa/);
  });
});

describe("one call end to end", () => {
  it("the ringing page names who calls; a ticket lands as a committed row; the caller's trace shows the promise and the text", async () => {
    const { app, root, dir, settle } = setup();
    const ring = await (await app.request("/api/public/clinic/test-clinic/llamada")).text();
    expect(ring).toMatch(/Lucía de Clínica Dental Prueba le llama/);
    expect(ring).toMatch(/>Contestar</);
    const s = (await (await post(app, "/api/public/clinic/test-clinic/calls")).json()) as any;
    expect(s.trace).toMatch(/\/trace\?k=[a-f0-9]{24}$/);
    const tool = async (args: object) => ((await (await post(app, `/api/public/clinic/test-clinic/calls/${s.call}/tool`, { name: "file_ticket", args })).json()) as any).result as string;
    const said = await tool({ need: "Saber si trabajan con el seguro Asisa", who: "paciente", contact: "600111222" });
    expect(said).toMatch(/le contesta como muy tarde el lunes 30 de noviembre/);
    expect(await tool({ need: "otra" })).toMatch(/^Apuntado/);
    expect(await tool({ need: "una tercera" })).toMatch(/Ya hay dos pendientes/);
    await post(app, `/api/public/clinic/test-clinic/calls/${s.call}/end`, { reason: "bye", transcript: [{ who: "caller", text: "¿Aceptan Asisa?" }, { who: "voice", text: "Lo he apuntado." }] });
    await settle();
    const file = fs.readFileSync(path.join(dir, "test-clinic.tasks.md"), "utf8");
    const rows = parseTasks(file, "test-clinic");
    expect(rows.map((r) => r.need)).toEqual(["Saber si trabajan con el seguro Asisa", "otra"]);
    expect(file).not.toMatch(/600111222/); // a caller's phone never reaches the repo
    expect(execFileSync("git", ["-C", root, "log", "--format=%s", "-1"]).toString()).toMatch(/Clinic ticket ct_[a-f0-9]+ on test-clinic's task tree/);
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"]).toString().trim()).toBe("");
    const tr = await app.request(s.trace);
    expect(tr.status).toBe(200);
    const h = await tr.text();
    expect(h).toMatch(/Clínica Dental Prueba le contesta como muy tarde el lunes 30 de noviembre/);
    expect(h).toMatch(/¿Aceptan Asisa\?/);
    expect(h).toMatch(/Abierto/);
    // the owner marks it done in the file: the caller's page follows
    fs.writeFileSync(path.join(dir, "test-clinic.tasks.md"), file.replace(/\| abierto \|/g, "| hecho 2026-11-28 |"));
    expect(await (await app.request(s.trace)).text()).toMatch(/Todo lo que quedó pendiente está hecho/);
    // a wrong key shows nothing
    expect((await app.request(s.trace.replace(/k=.*/, "k=" + "0".repeat(24)))).status).toBe(404);
  });

  it("only the ringing page and a trace are newly open", () => {
    expect(isOpen("GET", "/api/public/clinic/test-clinic/llamada")).toBe(true);
    expect(isOpen("GET", `/api/public/clinic/test-clinic/calls/cc_${"a".repeat(24)}/trace`)).toBe(true);
    expect(isOpen("GET", `/api/public/clinic/test-clinic/calls/cc_${"a".repeat(24)}/other`)).toBe(false);
  });
});
