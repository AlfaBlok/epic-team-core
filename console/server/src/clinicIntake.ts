import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "./db.js";
import { clientAddress } from "./clientAddress.js";
import { elevenCalls, type ElevenCalls } from "./voice/elevenAgent.js";
import { VoiceError } from "./voice/voice.js";
import { CALL_UI_CA, CALL_UI_ES, PAGE_CSS, WEEKDAYS, callScript, clinicAgentBody, clinicIn, esc, madridToday, type Clinic, type ClinicService } from "./clinicDemo.js";
import { objectiveIn, sayObjective, SETUP_OBJECTIVES_MAX, type ClinicObjective } from "./clinicSetup.js";

/**
 * Your virtual agent in Catalan (the owner's live call 27 Nov, call_065c7b6e: does ElevenLabs speak Catalan? if so, a
 * Catalonia-focused offer: "your virtual agent in Catalan, who calls you and takes your requirements"). The voice check found
 * Catalan works on Eleven v4 Turbo, so this line is its own agent on that model.
 *
 *   GET /api/public/agent-catala ── one button (the person asks for the call; nobody is ever called cold)
 *        │
 *        ▼ POST …/calls (rate-limited) ──▶ the Catalan agent (ElevenLabs, ca, v4 Turbo, no overrides)
 *        │
 *        ├─ set_business, set_hours, add_service, add_note, add_objective   each said thing noted at once
 *        ├─ read_back ──▶ the agent reads it all back
 *        └─ confirm_setup (on the person's yes) ──▶ docs/clinics/<slug>.json, lang ca, written and pushed
 *                                                    │
 *                                                    ▼
 *                               its own Catalan receptionist at /api/public/clinic/<slug>, try calls for 7 days
 *
 * The same clinic machinery as the Spanish receptionist (clinicDemo.ts): one config file is one clinic, its agent made
 * from it. Only the call's text and a hashed address for the limits are kept; the audio never.
 */

/** the person's own words for the agent's name, the business, a day or a price: one line, no table or markup. */
const one = (s: unknown, n: number) =>
  String(s ?? "")
    .replace(/[\r\n\t|`<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** an intake call lasts at most this long. */
export const INTAKE_CALL_MAX_S = 15 * 60;
/** calls one visitor may start in an hour. */
export const INTAKE_STARTS_PER_HOUR = 3;
/** intake calls the line takes in a day, everyone together. */
export const INTAKE_CALLS_PER_DAY = 30;
/** clinic files intake calls may write in a day, everyone together. */
export const INTAKE_WRITES_PER_DAY = 5;
/** days a written clinic's receptionist answers its try calls, before any plan. */
export const TRY_DAYS = 7;
/** try calls a day for a clinic set up here. */
export const TRY_CALLS_PER_DAY = 10;
const TOOLS_PER_CALL = 60;
const SERVICES_MAX = 15;
const NOTES_MAX = 10;
const CALL_LIVE_MS = INTAKE_CALL_MAX_S * 1000 + 60_000;

export interface IntakeDraft {
  business?: string;
  kind?: string;
  city?: string;
  owner?: string;
  agentName?: string;
  /** Spanish weekday (the config's keys) → open ranges HH:MM-HH:MM. */
  hours: Record<string, string[]>;
  services: ClinicService[];
  notes: string[];
  objectives: ClinicObjective[];
}
export const emptyDraft = (): IntakeDraft => ({ hours: {}, services: [], notes: [], objectives: [] });

// ---------- days and hours as said on the phone ----------

const DAYS_CA = ["diumenge", "dilluns", "dimarts", "dimecres", "dijous", "divendres", "dissabte"];
const DAYS_ES = WEEKDAYS.map(plain);
const dayIndex = (w: string): number => {
  const t = plain(w);
  const i = DAYS_CA.indexOf(t);
  return i >= 0 ? i : DAYS_ES.indexOf(t);
};

/** the weekdays a phrase names (de dilluns a divendres, feiners, cada dia, dilluns i dimecres), as 0 (Sunday) … 6. */
export function daysIn(said: string): number[] {
  const t = plain(said).replace(/\s*-\s*/g, " a ");
  if (/cada dia|tots els dies|todos los dias|cada dia de la setmana|7 dies/.test(t)) return [1, 2, 3, 4, 5, 6, 0];
  const words = t.match(/[a-z]+/g) ?? [];
  const found = words.map(dayIndex).filter((i) => i >= 0);
  const span = t.match(/(?:de |del )?([a-z]+)\s+(?:a|al|fins a|fins al|-)\s+([a-z]+)/);
  if (span && dayIndex(span[1]) >= 0 && dayIndex(span[2]) >= 0) {
    const order = [1, 2, 3, 4, 5, 6, 0];
    const a = order.indexOf(dayIndex(span[1]));
    const b = order.indexOf(dayIndex(span[2]));
    if (a <= b) return [...new Set([...order.slice(a, b + 1), ...found])];
  }
  if (!found.length && /feiner|entre setmana|laborable|entre semana/.test(t)) return [1, 2, 3, 4, 5];
  return [...new Set(found)];
}

/** open ranges from a phrase (de 9 a 14 i de 16 a 20, 09:00-14:00, 9h-13.30h); [] when it says closed. */
export function rangesIn(said: string): string[] | undefined {
  const t = plain(said);
  if (/tancat|cerrado|no obr|festiu/.test(t)) return [];
  const times = [...t.matchAll(/(\d{1,2})(?:\s*[:.h']\s*(\d{2}))?\s*h?/g)]
    .map((m) => ({ h: Number(m[1]), m: m[2] ? Number(m[2]) : 0 }))
    .filter((x) => x.h <= 24 && x.m < 60);
  const out: string[] = [];
  let prevEnd = 0;
  for (let i = 0; i + 1 < times.length && out.length < 4; i += 2) {
    const [a, b] = [times[i], times[i + 1]];
    let am = a.h * 60 + a.m;
    let bm = b.h * 60 + b.m;
    // "de 9 a 14 i de 4 a 8": a range said after one that ran past noon is in the afternoon
    if (am < prevEnd && a.h < 12) {
      am += 12 * 60;
      if (b.h <= 12) bm += 12 * 60;
    }
    if (bm <= am && b.h < 12) bm += 12 * 60; // "de 4 a 8" in the afternoon
    if (bm <= am || bm > 24 * 60) continue;
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    out.push(`${hm(am)}-${hm(bm)}`);
    prevEnd = bm;
  }
  return out.length ? out : undefined;
}

/** a file name from the business and its town: lower case, plain letters, dashes; unique against `taken`. */
export function slugFor(business: string, city: string, taken: (s: string) => boolean): string {
  const base =
    plain(`${business} ${city}`)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(.{0,38})(?:-.*)?$/, (all, head: string) => (all.length <= 38 ? all : head)) // whole words only
      .slice(0, 38)
      .replace(/-+$/, "") || "clinica";
  const b = base.length >= 2 ? base : `${base}-ca`;
  if (!taken(b)) return b;
  for (let i = 2; i < 50; i++) if (!taken(`${b}-${i}`)) return `${b}-${i}`;
  return `${b}-${crypto.randomBytes(2).toString("hex")}`;
}

/** what is still missing before the file can be written, in Catalan for the agent to ask; [] when complete. */
export function missing(d: IntakeDraft): string[] {
  const out: string[] = [];
  if (!d.business) out.push("el nom de la clínica");
  if (!d.city) out.push("la ciutat");
  if (!Object.values(d.hours).some((r) => r.length)) out.push("l'horari");
  if (!d.services.length) out.push("almenys un servei amb el seu preu");
  return out;
}

const sayDays = (d: IntakeDraft) => {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const parts = order.filter((i) => (d.hours[WEEKDAYS[i]] ?? []).length).map((i) => `${DAYS_CA[i]} ${d.hours[WEEKDAYS[i]].map((r) => r.replace("-", " a ")).join(" i ")}`);
  return parts.length ? parts.join("; ") : "cap horari encara";
};

/** the whole draft in Catalan, for the agent to read back before the yes. */
export function readBack(d: IntakeDraft): string {
  return [
    `Clínica: ${d.business ?? "sense nom"}${d.kind ? `, ${d.kind}` : ""}${d.city ? `, a ${d.city}` : ""}.`,
    d.owner ? `Parla: ${d.owner}.` : "",
    `L'agent es dirà ${d.agentName ?? "Laia"}.`,
    `Horari: ${sayDays(d)}.`,
    d.services.length ? `Serveis: ${d.services.map((s) => `${s.name}, ${s.price}`).join("; ")}.` : "Serveis: cap encara.",
    d.notes.length ? `A més: ${d.notes.join(" ")}` : "",
    d.objectives.length ? `Objectius: ${d.objectives.map((o, i) => `${i + 1}. ${sayObjective(o)}`).join(" ")}` : "Objectius: cap encara.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** the clinic file a confirmed draft becomes: Catalan, its try window, the call that wrote it. */
export function draftConfig(d: IntakeDraft, slug: string, call: string, now: number): Clinic {
  const today = madridToday(now).iso;
  const tryUntil = new Date(Date.parse(`${today}T12:00:00Z`) + TRY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const at = new Date(now).toISOString();
  return {
    slug,
    clinic: d.business!,
    city: d.city!,
    ...(d.kind ? { kind: d.kind } : {}),
    lang: "ca",
    receptionist: d.agentName ?? "Laia",
    hours: d.hours,
    services: d.services,
    ...(d.notes.length ? { notes: d.notes } : {}),
    callsPerDay: TRY_CALLS_PER_DAY,
    followUpDays: 1,
    ...(d.owner ? { owner: { name: d.owner, role: "qui va trucar per configurar-lo" } } : {}),
    ...(d.objectives.length ? { objectives: d.objectives.slice(0, SETUP_OBJECTIVES_MAX), objectivesFromCall: call, objectivesAt: at } : {}),
    tryUntil,
    fromCall: call,
  };
}

// ---------- the agent ----------

export const INTAKE_AGENT_NAME = "Agent en català · posada en marxa";
/** whose agent it is: the company of the demo clinic's offer (its `sales` block), never a name in the code. */
export const intakeCompany = (clinics: Map<string, Clinic>) => [...clinics.values()].find((c) => c.sales)?.sales?.company;
/** "de" before the company, "d'" before a vowel or h, as Catalan writes it. */
const of = (company?: string) => (company ? (/^[aeiouàèéíòóúh]/i.test(company) ? ` d'${company}` : ` de ${company}`) : "");
export const intakeGreeting = (company?: string) =>
  `Hola, sóc la Núria, l'agent virtual en català${of(company)}. En uns deu minuts m'expliques com és la teva clínica i com vols que atengui els teus pacients, i en acabar la trucada el teu agent ja estarà configurat. Comencem: com es diu la clínica i a quina ciutat és?`;

export function intakePrompt(company?: string): string {
  return [
    "# Estil: el més important d'aquesta trucada",
    "- Parles sempre en català, càlida, tranquil·la i breu: una o dues frases per torn. Tractes de tu. Si et parlen en castellà, contestes en castellà; en anglès, en anglès.",
    "- Una pregunta cada vegada. Deixa que acabi; una pausa no és el final. No interrompis mai.",
    "- No llegeixis mai identificadors, enllaços ni números llargs.",
    "",
    `Ets la Núria, l'agent virtual en català${of(company)}. Parles amb qui porta una clínica o una consulta (dental, fisioteràpia, estètica o semblant) i ha demanat aquesta trucada des de la nostra pàgina. La teva feina: prendre els seus requisits perquè, en acabar, la clínica tingui la seva pròpia recepcionista per veu en català, configurada amb el que ha dit. Mai truques ningú per iniciativa pròpia: aquesta persona ha demanat la trucada.`,
    "",
    "# Què has d'apuntar, en aquest ordre, i com",
    "Apunta cada cosa en el mateix torn que te la diuen, amb les seves paraules, mai amb una idea teva. No diguis mai que ho apuntes sense cridar l'eina.",
    "1. La clínica: nom, tipus (per exemple clínica dental, fisioteràpia), ciutat, el nom de qui parla i quin nom vol per a la seva recepcionista (si no en té cap, proposa Laia). Crida set_business; pots cridar-la més d'un cop a mesura que ho diu.",
    "2. L'horari: per a cada grup de dies, crida set_hours amb els dies tal com els diu (per exemple \"de dilluns a divendres\") i les hores en xifres (per exemple \"09:00-14:00, 16:00-20:00\"). Els dies que tanca, \"tancat\".",
    "3. Els serveis i els preus: crida add_service un cop per servei, amb el preu tal com el diu (\"60 euros\", \"des de 40 euros\", \"gratuït\"). Amb tres o quatre n'hi ha prou; pregunta si en vol afegir més.",
    "4. Què li pregunten els pacients i com vol que respongui (aparcament, mútues, urgències): crida add_note amb una frase per cosa.",
    `5. Els objectius: què vol aconseguir amb la recepcionista (per exemple no perdre trucades a l'hora de dinar, més primeres visites). Crida add_objective per a cadascun; com ho mesurarà i la meta són opcionals. Entre un i ${SETUP_OBJECTIVES_MAX}.`,
    "6. Quan ho tinguis, crida read_back i llegeix-li el resum en frases curtes. Pregunta: \"Ho deixo així i configuro el teu agent?\". Només amb el seu sí, crida confirm_setup una vegada i digues la frase que retorna. Si vol canviar alguna cosa, torna a cridar l'eina que toca (set_hours, add_service amb el mateix nom) i torna a llegir-ho.",
    "Si confirm_setup diu que falta alguna cosa, pregunta-la i torna-ho a provar.",
    "",
    "Mai prometis resultats, xifres ni preus del nostre servei: si en pregunta, digues que l'equip li explicarà en provar-lo. No demanis mai dades de pagament, de salut ni el DNI.",
    "Quan s'acomiadi, si el resum està llegit però no confirmat, pregunta una sola vegada si el deixes així; amb el seu sí crida confirm_setup. Després acomiada't en una frase i crida end_call. No pengis mai mentre la persona encara parla.",
  ].join("\n");
}

const str = (description: string) => ({ type: "string", description });
export const INTAKE_TOOLS = [
  {
    name: "set_business",
    description: "Apunta les dades de la clínica a mesura que les diu: nom, tipus, ciutat, qui parla i el nom de la recepcionista. Els camps que no ha dit, buits.",
    parameters: {
      properties: { name: str("el nom de la clínica"), kind: str("el tipus, per exemple clínica dental"), city: str("la ciutat"), owner: str("el nom de qui parla"), agent_name: str("el nom que vol per a la recepcionista") },
      required: [],
    },
  },
  {
    name: "set_hours",
    description: "Apunta l'horari d'un grup de dies. Un cop per grup.",
    parameters: { properties: { days: str("els dies tal com els diu, per exemple de dilluns a divendres, o dissabte"), hours: str("les hores en xifres, per exemple 09:00-14:00, 16:00-20:00, o tancat") }, required: ["days", "hours"] },
  },
  {
    name: "add_service",
    description: "Apunta un servei amb el seu preu. Amb el mateix nom, el canvia.",
    parameters: { properties: { name: str("el servei"), price: str("el preu tal com el diu"), minutes: str("opcional: quants minuts dura") }, required: ["name", "price"] },
  },
  { name: "add_note", description: "Apunta una cosa que els pacients pregunten o com vol que es respongui, en una frase.", parameters: { properties: { text: str("la nota, en una frase") }, required: ["text"] } },
  {
    name: "add_objective",
    description: "Apunta un objectiu de la clínica per a la recepcionista, amb les seves paraules. Amb number en canvia un.",
    parameters: { properties: { goal: str("el que vol aconseguir"), measure: str("opcional: com ho mesurarà"), target: str("opcional: la meta"), number: str("opcional: el número de l'objectiu que canvia") }, required: ["goal"] },
  },
  { name: "read_back", description: "Retorna el resum de tot el que has apuntat, per llegir-lo abans de confirmar.", parameters: { properties: {}, required: [] } },
  {
    name: "confirm_setup",
    description: "Configura l'agent de la clínica amb el que has apuntat. Només després de llegir el resum i que la persona digui que sí.",
    parameters: { properties: { said_yes: str("el que va dir la persona en confirmar") }, required: [] },
  },
];

// ---------- the calls ----------

export interface IntakeDeps {
  db: DB;
  key: () => Promise<string | undefined>;
  /** the clinic configs (to keep a new file name unique). */
  clinics: () => Map<string, Clinic>;
  /** writes a clinic's config file in the repo (commit + push), as the set-up call does. */
  writeClinic?: (slug: string, make: (cur: string | undefined) => string, msg: string) => Promise<{ state: string; detail?: string }>;
  /** tests fake the ElevenLabs door. */
  eleven?: ElevenCalls;
  now?: () => number;
  writeWaitMs?: number;
}

export function createClinicIntake(d: IntakeDeps) {
  const { db } = d;
  const now = d.now ?? Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_intake_calls (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      visitor TEXT NOT NULL,
      tools INTEGER NOT NULL DEFAULT 0,
      draft TEXT NOT NULL,
      slug TEXT,
      written_at TEXT,
      ended_at TEXT,
      reason TEXT,
      transcript TEXT
    );
    CREATE INDEX IF NOT EXISTS clinic_intake_started ON clinic_intake_calls (started_at);
  `);
  const k = "eleven_clinic_intake_ca_agent_id";
  const door: ElevenCalls =
    d.eleven ??
    elevenCalls({
      name: INTAKE_AGENT_NAME,
      tags: ["clinic-intake", "ca"],
      key: d.key,
      prompt: () => intakePrompt(intakeCompany(d.clinics())),
      firstMessage: () => intakeGreeting(intakeCompany(d.clinics())),
      tools: () => INTAKE_TOOLS as any,
      body: clinicAgentBody({}, INTAKE_CALL_MAX_S, "Acaba la trucada quan la persona s'acomiada, després d'un comiat curt."),
      knownLang: "ca",
      known: {
        get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value,
        set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, id),
      },
    });
  const iso = () => new Date(now()).toISOString();
  const visitorHash = (addr: string) => crypto.createHash("sha256").update(`clinic-intake|${addr}`).digest("hex").slice(0, 16);
  const row = (id: string) => db.prepare("SELECT * FROM clinic_intake_calls WHERE id = ?").get(id) as any;
  const live = (id: string) => {
    const r = row(id);
    if (!r || r.ended_at || now() - Date.parse(r.started_at) > CALL_LIVE_MS) throw new VoiceError(404, "no_call", "Aquesta trucada ja ha acabat.");
    return r;
  };
  const save = (id: string, draft: IntakeDraft) => db.prepare("UPDATE clinic_intake_calls SET draft = ? WHERE id = ?").run(JSON.stringify(draft), id);
  const left = (dr: IntakeDraft) => {
    const m = missing(dr);
    return m.length ? ` Encara falta: ${m.join(", ")}.` : " Ja ho tens tot el necessari; si no hi ha res més, crida read_back.";
  };
  const clinicLink = (slug: string) => `/api/public/clinic/${slug}`;

  async function confirm(id: string, r: any, dr: IntakeDraft): Promise<{ result: string; link?: string }> {
    if (r.slug && r.written_at) return { result: `Ja està configurat: l'agent de ${dr.business} ja existeix. Digues que el pot provar des de l'enllaç que té a la pàgina.`, link: clinicLink(r.slug) };
    const m = missing(dr);
    if (m.length) return { result: `Encara no el puc configurar: falta ${m.join(", ")}. Pregunta-ho i torna a cridar confirm_setup.` };
    if (!d.writeClinic) return { result: "Ara no puc configurar-lo. Digues que l'equip ho farà avui amb el que ha explicat." };
    const dayAgo = new Date(now() - 86_400_000).toISOString();
    const written = (db.prepare("SELECT COUNT(*) n FROM clinic_intake_calls WHERE written_at > ?").get(dayAgo) as { n: number }).n;
    if (written >= INTAKE_WRITES_PER_DAY) return { result: "Avui ja s'han configurat tots els agents que podem. Digues que l'equip el configurarà demà amb el que ha explicat." };
    const have = d.clinics();
    const slug = slugFor(dr.business!, dr.city!, (s) => have.has(s));
    const cfg = draftConfig(dr, slug, id, now());
    const ok = clinicIn.safeParse(cfg);
    if (!ok.success) return { result: `No el puc configurar així: ${ok.error.issues[0]?.path.join(".")}. Pregunta-ho de nou amb altres paraules.` };
    const w = d
      .writeClinic(
        slug,
        (cur) => {
          if (cur !== undefined) throw new Error(`${slug}.json already exists`);
          return `${JSON.stringify(cfg, null, 2)}\n`;
        },
        `Clinic intake: ${slug} set up from its Catalan call ${id} (via console)`,
      )
      .catch((e) => ({ state: "failed", detail: (e as Error).message }));
    const done = await Promise.race([w, new Promise<undefined>((res) => setTimeout(() => res(undefined), d.writeWaitMs ?? 12_000))]);
    if (done && done.state === "failed") return { result: "No s'ha pogut configurar ara. Digues-ho en una frase: l'equip ho farà avui amb el que ha explicat." };
    db.prepare("UPDATE clinic_intake_calls SET slug = ?, written_at = ? WHERE id = ?").run(slug, iso(), id);
    return {
      result: `Fet: l'agent de ${dr.business}, ${cfg.receptionist}, ja està configurat en català amb el seu horari, ${dr.services.length} serveis${dr.objectives.length ? ` i ${dr.objectives.length} objectius` : ""}. Digues-ho en una frase i que a la pàgina ja té l'enllaç per provar-lo durant ${TRY_DAYS} dies, d'aquí a un minut.`,
      link: clinicLink(slug),
    };
  }

  return {
    warm: () => void door.warm?.("ca"),
    async start(addr: string) {
      const v = visitorHash(addr);
      const hourAgo = new Date(now() - 3_600_000).toISOString();
      const dayAgo = new Date(now() - 86_400_000).toISOString();
      if ((db.prepare("SELECT COUNT(*) n FROM clinic_intake_calls WHERE visitor = ? AND started_at > ?").get(v, hourAgo) as { n: number }).n >= INTAKE_STARTS_PER_HOUR)
        throw new VoiceError(409, "too_many", "Has fet diverses trucades seguides. Torna-ho a provar d'aquí a una hora.");
      if ((db.prepare("SELECT COUNT(*) n FROM clinic_intake_calls WHERE started_at > ?").get(dayAgo) as { n: number }).n >= INTAKE_CALLS_PER_DAY)
        throw new VoiceError(409, "day_full", "Avui ja hem atès totes les trucades. Torna-ho a provar demà.");
      const link = await door.link("ca");
      const id = `ci_${crypto.randomBytes(12).toString("hex")}`;
      db.prepare("INSERT INTO clinic_intake_calls (id, started_at, visitor, draft) VALUES (?, ?, ?, ?)").run(id, iso(), v, JSON.stringify(emptyDraft()));
      return { call: id, signedUrl: link.signedUrl };
    },
    async tool(id: string, name: string, args: Record<string, unknown>): Promise<{ result: string; link?: string }> {
      const r = live(id);
      if (r.tools >= TOOLS_PER_CALL) return { result: "No puc fer més gestions en aquesta trucada. Llegeix el resum i confirma." };
      db.prepare("UPDATE clinic_intake_calls SET tools = tools + 1 WHERE id = ?").run(id);
      const dr = { ...emptyDraft(), ...(JSON.parse(r.draft) as IntakeDraft) };
      if (name === "set_business") {
        const f = { business: one(args.name, 80), kind: one(args.kind, 80), city: one(args.city, 60), owner: one(args.owner, 60), agentName: one(args.agent_name, 30) };
        for (const [key, val] of Object.entries(f)) if (val.length >= 2) (dr as any)[key] = val;
        if (dr.kind && dr.kind.length < 3) delete dr.kind;
        save(id, dr);
        return { result: `Apuntat: ${[dr.business, dr.kind, dr.city, dr.owner && `parla ${dr.owner}`, dr.agentName && `recepcionista ${dr.agentName}`].filter(Boolean).join(", ")}.${left(dr)}` };
      }
      if (name === "set_hours") {
        const days = daysIn(one(args.days, 80));
        const ranges = rangesIn(one(args.hours, 80));
        if (!days.length) return { result: `No he entès els dies "${one(args.days, 80)}". Torna a cridar set_hours amb els noms dels dies.` };
        if (!ranges) return { result: `No he entès les hores "${one(args.hours, 80)}". Torna a cridar set_hours amb les hores en xifres, per exemple 09:00-14:00.` };
        for (const i of days) dr.hours[WEEKDAYS[i]] = ranges;
        save(id, dr);
        return { result: `Apuntat: ${days.map((i) => DAYS_CA[i]).join(", ")}: ${ranges.length ? ranges.map((x) => x.replace("-", " a ")).join(" i ") : "tancat"}.${left(dr)}` };
      }
      if (name === "add_service") {
        const s = one(args.name, 120);
        const price = one(args.price, 80);
        if (s.length < 2 || !price) return { result: "Falta el servei o el preu. Pregunta'l i torna a cridar add_service." };
        const minutes = Number(String(args.minutes ?? "").replace(/\D/g, ""));
        const svc: ClinicService = { name: s, price, ...(minutes >= 10 && minutes <= 240 ? { minutes } : {}) };
        const at = dr.services.findIndex((x) => plain(x.name) === plain(s));
        if (at >= 0) dr.services[at] = { ...svc, name: dr.services[at].name };
        else if (dr.services.length >= SERVICES_MAX) return { result: `Ja hi ha ${SERVICES_MAX} serveis, el màxim. Passa a la següent pregunta.` };
        else dr.services.push(svc);
        save(id, dr);
        return { result: `Apuntat: ${s}, ${price}.${left(dr)}` };
      }
      if (name === "add_note") {
        const t = one(args.text, 300);
        if (t.length < 3) return { result: "La nota és buida. Torna-ho a provar amb una frase." };
        if (dr.notes.length >= NOTES_MAX) return { result: "Ja hi ha prou notes. Passa als objectius." };
        dr.notes.push(t);
        save(id, dr);
        return { result: `Apuntat.${left(dr)}` };
      }
      if (name === "add_objective") {
        const o = objectiveIn(args);
        if (!o) return { result: "Falta l'objectiu. Pregunta'l i torna a cridar add_objective." };
        const asked = Number(String(args.number ?? "").replace(/\D/g, ""));
        if (asked >= 1 && asked <= dr.objectives.length) dr.objectives[asked - 1] = o;
        else if (dr.objectives.length >= SETUP_OBJECTIVES_MAX) return { result: `Ja hi ha ${SETUP_OBJECTIVES_MAX} objectius, el màxim. Crida read_back.` };
        else dr.objectives.push(o);
        save(id, dr);
        return { result: `Apuntat l'objectiu ${asked >= 1 && asked <= dr.objectives.length ? asked : dr.objectives.length}: ${sayObjective(o)}.${left(dr)}` };
      }
      if (name === "read_back") {
        const m = missing(dr);
        return { result: `${readBack(dr)}${m.length ? ` Abans de confirmar falta: ${m.join(", ")}.` : " Llegeix-ho en frases curtes i pregunta si ho deixes així."}` };
      }
      if (name === "confirm_setup") return confirm(id, r, dr);
      return { result: `No conec l'eina ${name}.` };
    },
    end(id: string, b: { reason?: string; transcript?: { who: string; text: string }[] }) {
      const r = row(id);
      if (!r) throw new VoiceError(404, "no_call", "No existeix aquesta trucada.");
      if (r.ended_at) return { ended: true };
      const t = (b.transcript ?? []).slice(0, 300).map((l) => ({ who: l.who === "voice" ? "voice" : "caller", text: l.text.slice(0, 1000) }));
      db.prepare("UPDATE clinic_intake_calls SET ended_at = ?, reason = ?, transcript = ? WHERE id = ?").run(iso(), (b.reason ?? "ended").slice(0, 40), JSON.stringify(t), id);
      return { ended: true };
    },
    /** the owner's view (signed in): every intake call, its draft and the file it wrote. */
    calls(limit = 50) {
      return (db.prepare("SELECT * FROM clinic_intake_calls ORDER BY started_at DESC LIMIT ?").all(Math.min(limit, 200)) as any[]).map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        reason: r.reason,
        draft: JSON.parse(r.draft),
        slug: r.slug ?? null,
        writtenAt: r.written_at ?? null,
        transcript: r.transcript ? JSON.parse(r.transcript) : [],
      }));
    },
  };
}
export type ClinicIntake = ReturnType<typeof createClinicIntake>;

// ---------- routes ----------

const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;
const toolIn = z.object({ name: z.string().min(1).max(40), args: z.record(z.unknown()).optional() });
const endIn = z.object({ reason: z.string().max(40).optional(), transcript: z.array(z.object({ who: z.string().max(10), text: z.string().max(4000) })).max(400).optional() });

/** GET /api/public/agent-catala (the page), its call routes (open, routeScope.ts), and the owner's GET /api/clinic-intake/calls. */
export function mountClinicIntake(api: Hono, intake: ClinicIntake) {
  const hits = new Map<string, number[]>();
  const limited = (c: Context) => {
    const a = clientAddress(peerOf(c), (h) => c.req.header(h));
    const t = Date.now();
    const recent = (hits.get(a) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    hits.set(a, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > 60;
  };
  const pub = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    if (limited(c)) return c.json({ error: { code: "too_many", message: "Massa peticions, espera un minut." } }, 429);
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof VoiceError) return c.json({ error: { code: e.code, message: e.message } }, e.code === "too_many" || e.code === "day_full" ? 429 : e.status);
      throw e;
    }
  };
  const body = async (c: Context) => {
    const t = await c.req.text().catch(() => "");
    try {
      return t ? JSON.parse(t) : {};
    } catch {
      return {};
    }
  };
  api.get(
    "/public/agent-catala",
    pub((c) => {
      intake.warm();
      c.header("referrer-policy", "no-referrer");
      return c.html(intakePage());
    }),
  );
  api.post(
    "/public/agent-catala/calls",
    pub(async (c) => c.json(await intake.start(clientAddress(peerOf(c), (h) => c.req.header(h))), 201)),
  );
  api.post(
    "/public/agent-catala/calls/:cid/tool",
    pub(async (c) => {
      const p = toolIn.safeParse(await body(c));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "name and args" } }, 400);
      return c.json(await intake.tool(c.req.param("cid") ?? "", p.data.name, p.data.args ?? {}));
    }),
  );
  api.post(
    "/public/agent-catala/calls/:cid/end",
    pub(async (c) => {
      const p = endIn.safeParse(await body(c));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "reason and transcript" } }, 400);
      return c.json(intake.end(c.req.param("cid") ?? "", p.data));
    }),
  );
  api.get("/clinic-intake/calls", (c) => c.json({ calls: intake.calls(Number(c.req.query("limit")) || 50) }));
}

// ---------- the page ----------

/** the intake page speaks to the owner as "tu", as the offer does. */
export const CALL_UI_TU: typeof CALL_UI_ES = {
  ...CALL_UI_CA,
  you: "Tu",
  ready: "Prem el botó i parla amb normalitat.",
  noLoad: "No s'ha pogut carregar la trucada. Torna a carregar la pàgina.",
  live: "En línia. Parla quan vulguis.",
};

/** the Catalan call-me page: the offer in one line, the flow, one button, and what the call will ask. */
export function intakePage(): string {
  const flow = ["Demanes la trucada", "Expliques la clínica", "Agent configurat", "El proves"];
  const asks = [
    ["La clínica", "nom, tipus, ciutat i com vols que es digui la recepcionista"],
    ["L'horari", "els dies i les hores que obres"],
    ["Serveis i preus", "el que fas i quant costa"],
    ["Què pregunten", "aparcament, mútues, urgències i com vols que respongui"],
    ["Objectius", "què vols aconseguir amb ella"],
  ];
  return `<!doctype html>
<html lang="ca"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>El teu agent virtual, en català</title>
<style>
${PAGE_CSS}
#made{margin-top:16px;padding:14px 16px;border:1px solid var(--green);border-radius:12px;background:var(--card)}
#made a{color:var(--green);font-weight:600}
#asks td:last-child{white-space:normal;text-align:left}
#asks td:first-child{white-space:nowrap;padding-right:12px;font-weight:600}
</style></head><body><main>
<span class="tag">Epic Voice · en català</span>
<h1>El teu agent virtual, en català</h1>
<p class="punch">Demana la trucada i explica'ns la teva clínica. En penjar, la teva recepcionista per veu ja està configurada amb les teves respostes i la pots provar.</p>
<div class="flow" aria-hidden="true">${flow.map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>
<button id="call" data-testid="call-start" disabled>Vull que em truqui</button>
<button id="hang" data-testid="call-hangup">Penjar</button>
<p id="status" role="status">Preparant la línia…</p>
<ul id="lines" aria-live="polite"></ul>
<p id="made" data-testid="intake-made" hidden>El teu agent ja està configurat. <a href="#">Prova'l ara</a>: respon en català, ${TRY_DAYS} dies de prova.</p>
<p id="trace" hidden><a href="#"></a></p>
<section id="asks"><h2>Què et preguntarà, en uns deu minuts</h2>
<table>${asks.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</table>
</section>
<p class="small" style="margin-top:24px">Només parlem quan tu ho demanes: ningú no rep trucades sense haver-les demanat. Cal micròfon. No guardem l'àudio, només el text de la trucada.</p>
</main>
${callScript("", "/calls", INTAKE_TOOLS.map((t) => t.name), "Núria", "", { base: "/api/public/agent-catala", ui: CALL_UI_TU })}</body></html>`;
}
