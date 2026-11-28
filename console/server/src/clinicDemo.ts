import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "./db.js";
import { clientAddress } from "./clientAddress.js";
import { agentBody, elevenCalls, type CallLang, type ElevenCalls } from "./voice/elevenAgent.js";
import { VoiceError } from "./voice/voice.js";
import { tracePage, type FollowUp } from "./clinicFollowUp.js";
import { questionsIn, whoAnswered, type Leads } from "./clinicLeads.js";
import { activationPage, clinicPlan, ensureClinicPlans, planOn } from "./clinicPlan.js";
import { INVITE_CALLS_PER_DAY, fromInternet, gated, invitePage, type Invites } from "./clinicInvites.js";
import {
  CLINIC_SETUP_MAX_S,
  SETUP_CALLS_PER_DAY,
  SETUP_OBJECTIVES_MAX,
  SETUP_TOOLS,
  objectiveIn,
  sayObjective,
  setupAgentName,
  setupGreeting,
  setupKey,
  setupPrompt,
  validSetupKey,
  withObjectives,
  type ClinicObjective,
} from "./clinicSetup.js";

/**
 * The clinic receptionist (the owner's strategy call, 27 Nov: our own voice agent sells for us first, and that same agent
 * is the product we sell to clinics).
 *
 *   <home repo>/docs/clinics/<slug>.json ──▶ one ElevenLabs agent per clinic (Spanish, its prompt made here, no overrides)
 *        │
 *   GET /api/public/clinic/<slug> ── one button ──▶ POST …/calls (rate-limited) ──▶ a signed link for one call
 *        │                                                                     │
 *        └──── the browser talks to the agent; its tools (free slots, book) answer through POST …/calls/<id>/tool
 *
 * A call opened from a posted letter carries its code (?c=<code>): the rep qualifies the lead (qualify_lead: who answered,
 * what they ask and need, their answer) and the call lands as a lead row in the Dental clinics table (clinicLeads.ts).
 *
 * A clinic is one config file: name, hours, services, insurers. A clinic with a `sales` block is our own demo clinic:
 * the same receptionist books a made-up patient and also explains the offer to a clinic owner and books a follow-up.
 * The agent only answers people who press the button; it never dials out. Nothing about a real patient is kept: the
 * demo's data is made up, and only the call's text, its bookings and a hashed address for the limits are stored.
 */

export interface ClinicService {
  name: string;
  price: string;
  minutes?: number;
}
export interface ClinicSales {
  company: string;
  what: string;
  price: string;
  priceWhatsappOnly?: string;
  trialDays: number;
  setup: string;
  terms?: string;
  followUp: string;
  /** where a clinic writes to have its data deleted or object (shown in the letter page's privacy note). */
  contact?: string;
}
export interface Clinic {
  slug: string;
  clinic: string;
  city: string;
  address?: string;
  madeUp?: boolean;
  receptionist?: string;
  /** weekday (lunes … domingo) → open ranges "HH:MM-HH:MM". */
  hours: Record<string, string[]>;
  services: ClinicService[];
  insurers?: string[];
  dentists?: string[];
  notes?: string[];
  /** ElevenLabs voice (default: the account's narration voice, multilingual model). */
  voiceId?: string;
  greeting?: string;
  callsPerDay?: number;
  sales?: ClinicSales;
  /** working days the clinic promises to answer what the receptionist could not solve (default 1). */
  followUpDays?: number;
  /** who gets the follow-up reminders (the Clinic follow-up persona drafts them; nothing is sent). */
  owner?: { name: string; role?: string };
  /** what the clinic wants from its receptionist, set on its set-up call (clinicSetup.ts). */
  objectives?: ClinicObjective[];
  /** the set-up call that set them (its id in the console's clinic calls). */
  objectivesFromCall?: string;
  objectivesAt?: string;
  /** the language its receptionist speaks (default Spanish); a Catalan one runs on its own agent (clinicIntake.ts); an
   * English one (the Irish demo) gets its prompt, tools, page and invite mail in English. */
  lang?: "es" | "ca" | "en";
  /** the public address of its call page (its invite links open here), when it is not the console's default demo address. */
  site?: string;
  /** an accent its voice should have (e.g. irish): the console picks a voice with it from the ElevenLabs voice library,
   * one at no extra cost, and keeps the default voice when none is found. */
  voiceAccent?: string;
  /** what kind of practice it is, in its own words (default: una clínica dental). */
  kind?: string;
  /** a clinic set up from a Catalan call answers its own try calls until this day, before any plan (clinicIntake.ts). */
  tryUntil?: string;
  /** the Catalan call that wrote this file (its id in the console's clinic calls). */
  fromCall?: string;
}

const slugRe = /^[a-z0-9][a-z0-9-]{1,40}$/;
const range = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/);
export const clinicIn = z.object({
  slug: z.string().regex(slugRe),
  clinic: z.string().min(2).max(120),
  city: z.string().min(2).max(80),
  address: z.string().max(200).optional(),
  madeUp: z.boolean().optional(),
  receptionist: z.string().max(40).optional(),
  hours: z.record(z.array(range).max(4)),
  services: z.array(z.object({ name: z.string().min(2).max(120), price: z.string().min(1).max(80), minutes: z.number().int().min(10).max(240).optional() })).min(1).max(40),
  insurers: z.array(z.string().max(60)).max(30).optional(),
  dentists: z.array(z.string().max(80)).max(20).optional(),
  notes: z.array(z.string().max(300)).max(20).optional(),
  voiceId: z.string().max(60).optional(),
  greeting: z.string().max(400).optional(),
  callsPerDay: z.number().int().min(1).max(500).optional(),
  followUpDays: z.number().int().min(0).max(10).optional(),
  owner: z.object({ name: z.string().min(2).max(80), role: z.string().max(60).optional() }).optional(),
  objectives: z
    .array(z.object({ goal: z.string().min(3).max(200), measure: z.string().max(200).optional(), target: z.string().max(120).optional() }))
    .max(SETUP_OBJECTIVES_MAX)
    .optional(),
  objectivesFromCall: z.string().max(60).optional(),
  objectivesAt: z.string().max(40).optional(),
  lang: z.enum(["es", "ca", "en"]).optional(),
  site: z.string().url().max(200).optional(),
  voiceAccent: z.string().regex(/^[a-z]{3,20}$/).optional(),
  kind: z.string().min(3).max(80).optional(),
  tryUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fromCall: z.string().max(60).optional(),
  sales: z
    .object({
      company: z.string().min(2).max(60),
      what: z.string().min(10).max(1000),
      price: z.string().min(5).max(200),
      priceWhatsappOnly: z.string().max(200).optional(),
      trialDays: z.number().int().min(1).max(90),
      setup: z.string().max(600),
      terms: z.string().max(400).optional(),
      followUp: z.string().max(200),
      contact: z.string().max(120).optional(),
    })
    .optional(),
});

export const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** a demo call lasts at most this long (the grant's minutes). */
export const CLINIC_CALL_MAX_S = 6 * 60;
/** calls one visitor may start in an hour. */
export const CLINIC_STARTS_PER_HOUR = 3;
const TOOLS_PER_CALL = 16;
const BOOKINGS_PER_CALL = 3;
const CALL_LIVE_MS = 15 * 60_000;

/** the clinic configs in `dir`, read again at most once a minute (the home repo is pulled; a new file goes live by itself). */
export function clinicsIn(dir: () => string | undefined, now: () => number = Date.now): () => Map<string, Clinic> {
  let at = 0;
  let last = new Map<string, Clinic>();
  return () => {
    if (now() - at < 60_000) return last;
    at = now();
    const d = dir();
    last = d ? loadClinics(d) : new Map();
    return last;
  };
}

/** Every clinic config in `dir` (one JSON file each); a broken file is skipped with a warning, never a crash. */
export function loadClinics(dir: string): Map<string, Clinic> {
  const out = new Map<string, Clinic>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    try {
      const p = clinicIn.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      if (!p.success) {
        console.warn(`clinic: ${f} skipped: ${p.error.issues[0]?.path.join(".")} ${p.error.issues[0]?.message}`);
        continue;
      }
      out.set(p.data.slug, p.data as Clinic);
    } catch (e) {
      console.warn(`clinic: ${f} skipped: ${(e as Error).message}`);
    }
  }
  return out;
}

// ---------- the agenda (made up, the same answer for the same day) ----------

/** today's date and weekday in Madrid. */
export function madridToday(now: number): { iso: string; weekday: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  return { iso: p, weekday: new Date(`${p}T12:00:00Z`).getUTCDay() };
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** a day said on the phone (hoy, mañana, el martes, 3 de diciembre, 2026-12-03) as a date, from Madrid's today. */
/** Catalan day and month words as the Spanish ones parseDay reads (a Catalan receptionist passes the day as said). */
const CA_WORDS: [RegExp, string][] = [
  [/\bdema passat\b/g, "pasado manana"],
  [/\bdema\b/g, "manana"],
  [/\bavui\b/g, "hoy"],
  [/\bdilluns\b/g, "lunes"],
  [/\bdimarts\b/g, "martes"],
  [/\bdimecres\b/g, "miercoles"],
  [/\bdijous\b/g, "jueves"],
  [/\bdivendres\b/g, "viernes"],
  [/\bdissabte\b/g, "sabado"],
  [/\bdiumenge\b/g, "domingo"],
  [/\bvinent\b/g, "que viene"],
  [/\bd'/g, "de "],
  [/\bgener\b/g, "enero"],
  [/\bfebrer\b/g, "febrero"],
  [/\bmarc\b/g, "marzo"],
  [/\bmaig\b/g, "mayo"],
  [/\bjuny\b/g, "junio"],
  [/\bjuliol\b/g, "julio"],
  [/\bagost\b/g, "agosto"],
  [/\bsetembre\b/g, "septiembre"],
  [/\boctubre\b/g, "octubre"],
  [/\bnovembre\b/g, "noviembre"],
  [/\bdesembre\b/g, "diciembre"],
];
const fromCatalan = (t: string) => CA_WORDS.reduce((x, [re, to]) => x.replace(re, to), t);
/** English day and month words as the Spanish ones parseDay reads (the Irish demo's receptionist passes the day as said). */
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const EN_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const EN_WORDS: [RegExp, string][] = [
  [/\bthe day after tomorrow\b/g, "pasado manana"],
  [/\bday after tomorrow\b/g, "pasado manana"],
  [/\btomorrow\b/g, "manana"],
  [/\btoday\b/g, "hoy"],
  [/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1"],
  [/\bof\b/g, "de"],
  [/\bnext\b/g, "que viene"],
  [/\b(morning)\b/g, "manana"],
  [/\b(afternoon|evening)\b/g, "tarde"],
  ...EN_DAYS.map((d, i) => [new RegExp(`\\b${d}\\b`, "g"), plain(WEEKDAYS[i])] as [RegExp, string]),
  ...EN_MONTHS.map((m, i) => [new RegExp(`\\b${m}\\b`, "g"), MONTHS[i]] as [RegExp, string]),
];
export const fromEnglish = (t: string) => {
  let x = EN_WORDS.reduce((y, [re, to]) => y.replace(re, to), t);
  // "december 3" said month first
  x = x.replace(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})\\b`), "$2 de $1");
  return x;
};

export function parseDay(said: string, now: number): string | undefined {
  const t = fromEnglish(fromCatalan(plain(said)));
  const today = madridToday(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/pasado manana/.test(t)) return addDays(today.iso, 2);
  if (/\bhoy\b/.test(t)) return today.iso;
  if (/\bmanana\b/.test(t) && !WEEKDAYS.some((d) => t.includes(plain(d)))) return addDays(today.iso, 1);
  const m = t.match(/(\d{1,2})\s*(?:de\s+)?([a-z]+)/);
  if (m) {
    const mi = MONTHS.indexOf(m[2]);
    if (mi >= 0) {
      const y = Number(today.iso.slice(0, 4));
      let d = `${y}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      if (d < today.iso) d = `${y + 1}${d.slice(4)}`;
      return Number.isNaN(Date.parse(d)) ? undefined : d;
    }
  }
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${plain(d)}\\b`).test(t));
  if (wd >= 0) {
    let n = (wd - today.weekday + 7) % 7;
    if (n === 0 && /proximo|que viene|siguiente/.test(t)) n = 7;
    return addDays(today.iso, n);
  }
  return undefined;
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** the clinic's free half hours on a date: its hours, less a made-up 60% that are taken, less what the demo booked. */
export function freeSlots(c: Clinic, date: string, taken: Set<string>, now: number): string[] {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  const ranges = c.hours[WEEKDAYS[wd]] ?? [];
  const today = madridToday(now);
  const nowMin = (() => {
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
    return toMin(hm);
  })();
  const out: string[] = [];
  for (const r of ranges) {
    const [a, b] = r.split("-").map(toMin);
    for (let m = a; m + 30 <= b; m += 30) {
      const hm = toHm(m);
      if (date === today.iso && m <= nowMin + 60) continue;
      const h = crypto.createHash("sha256").update(`${c.slug}|${date}|${hm}`).digest()[0];
      if (h < 154 || taken.has(hm)) continue; // about 60% taken
      out.push(hm);
    }
  }
  return out;
}

function sayDate(iso: string, en = false): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (en) return `${EN_DAYS[d.getUTCDay()][0].toUpperCase()}${EN_DAYS[d.getUTCDay()].slice(1)} ${d.getUTCDate()} ${EN_MONTHS[d.getUTCMonth()][0].toUpperCase()}${EN_MONTHS[d.getUTCMonth()].slice(1)}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
}
/** the config's weekday key (lunes …) in English, for an English clinic's prompt and page. */
export const dayEn = (d: string) => {
  const i = WEEKDAYS.indexOf(d);
  return i < 0 ? d : `${EN_DAYS[i][0].toUpperCase()}${EN_DAYS[i].slice(1)}`;
};

// ---------- the agent ----------

export const clinicAgentName = (c: Clinic) => `Recepcionista · ${c.clinic} (${c.slug})`;

export function clinicGreeting(c: Clinic): string {
  if (c.greeting) return c.greeting;
  if (c.lang === "en") {
    const r = c.receptionist ?? "the receptionist";
    return c.sales
      ? `Hello, ${c.clinic}, you're through to ${r}. I'm the AI receptionist from ${c.sales.company}, and this is a live demo. Are you calling as a patient, or to hear how this would work for your clinic?`
      : `Hello, ${c.clinic}, ${r} speaking. How can I help?`;
  }
  const who = c.receptionist ?? "la recepcionista";
  if (c.sales)
    return `Hola, soy ${who}, una recepcionista de inteligencia artificial de ${c.sales.company}, y esto es una demostración en directo en ${c.clinic}, una clínica inventada. ¿Llama como paciente para pedir cita, o quiere saber cómo funcionaría en su clínica?`;
  if (c.lang === "ca") return `Hola, ${c.clinic}, l'atén ${c.receptionist ?? "la recepcionista"}. En què el puc ajudar?`;
  return `Hola, ${c.clinic}, le atiende ${who}. ¿En qué le puedo ayudar?`;
}

/** the language a clinic's receptionist speaks. */
export const clinicLang = (c: Clinic): CallLang => (c.lang === "ca" ? "ca" : c.lang === "en" ? "en" : "es");
/** a clinic set up from a Catalan call answers its try calls until its tryUntil day (Madrid's date). */
export const inTry = (c: Clinic, now: number) => !!c.tryUntil && madridToday(now).iso <= c.tryUntil;

/** the receptionist's instructions, in Spanish, made from the clinic's config only. */
export function clinicPrompt(c: Clinic): string {
  if (c.lang === "en") return clinicPromptEn(c);
  const who = c.receptionist ?? "la recepcionista";
  const hours = WEEKDAYS.slice(1)
    .concat(WEEKDAYS[0])
    .map((d) => `- ${d}: ${(c.hours[d] ?? []).length ? c.hours[d].map((r) => r.replace("-", " a ")).join(" y ") : "cerrado"}`)
    .join("\n");
  const services = c.services.map((s) => `- ${s.name}: ${s.price}${s.minutes ? ` (${s.minutes} minutos)` : ""}`).join("\n");
  const out = [
    c.lang === "ca"
      ? `# Idioma: parles sempre en català, amb frases curtes, càlida i professional. Tractes de vostè. Si et parlen en castellà, contestes en castellà; en anglès, en anglès. Les instruccions d'aquí sota són en castellà, però tu parles en català.\n`
      : "",
    `Eres ${who}, la recepcionista por voz de ${c.clinic}, ${c.kind ? `${/^(una?|el|la)\s/i.test(c.kind) ? "" : "una "}${c.kind}` : "una clínica dental"} en ${c.city}${c.address ? ` (${c.address})` : ""}. ${c.lang === "ca" ? "Hablas catalán" : "Hablas español de España"}, con frases cortas, cálida y profesional. Tratas siempre de usted. Si te hablan en inglés, contestas en inglés.`,
    c.madeUp ? "Esta clínica es una demostración: sus pacientes, citas y precios son inventados. Si te lo preguntan, lo dices con naturalidad." : "",
    "",
    "# Lo que sabes de la clínica (solo esto)",
    "Horario:",
    hours,
    "Tratamientos y precios:",
    services,
    c.insurers?.length ? `Seguros con los que trabajamos: ${c.insurers.join(", ")}.` : "",
    c.dentists?.length ? `Dentistas: ${c.dentists.join(", ")}.` : "",
    ...(c.notes ?? []),
    ...(c.objectives?.length
      ? [
          "",
          "# Lo que la clínica quiere conseguir contigo (lo dijo en su llamada de puesta en marcha)",
          ...c.objectives.map((o, i) => `${i + 1}. ${sayObjective(o)}`),
          "Tenlo presente en cada llamada: es para lo que la clínica te tiene. Nunca lo leas en voz alta ni lo uses para presionar a nadie.",
        ]
      : []),
    "",
    "# Cómo atiendes a un paciente",
    "1. Pregunta qué necesita. Si no sabes el tratamiento, ofrece una primera visita.",
    "2. Pregunta qué día le viene bien y llama a free_slots con ese día tal como lo dice (por ejemplo \"el martes\", \"mañana\", \"3 de diciembre\"). Ofrece como mucho tres horas de las que devuelve. Nunca inventes una hora libre.",
    "3. Cuando elija una hora, pide su nombre y llama a book_appointment con el nombre, el tratamiento, la fecha (la que devolvió free_slots, AAAA-MM-DD) y la hora. Después repite el día, la hora y el tratamiento en una frase.",
    "4. Precios, horarios, seguros y cómo llegar: solo lo que está arriba. Si no lo sabes, dilo y ofrece que recepción le llame.",
    "Nunca das consejo médico ni dices qué significa un dolor. Si es una urgencia grave (mucho sangrado, hinchazón que dificulta respirar, un golpe fuerte en la cara), dile que llame al 112. Si tiene dolor, ofrece la primera cita de urgencia libre.",
    "Nunca pidas datos médicos, DNI ni datos de pago.",
  ];
  if (c.sales) {
    const s = c.sales;
    out.push(
      "",
      `# Si quien llama tiene o dirige una clínica (la demostración de ${s.company})`,
      `Tú misma eres el producto: lo que acaba de oír es lo que tendría su clínica. En tu primera respuesta di en una frase qué es y en otra el precio y la prueba gratis; nunca preguntes si quiere saber el precio, dilo. Después contesta lo que pregunte, de una cosa en una:`,
      `- Qué es: ${s.what}`,
      `- Precio: ${s.price}.${s.priceWhatsappOnly ? ` Solo WhatsApp: ${s.priceWhatsappOnly}.` : ""}`,
      `- Prueba: ${s.trialDays} días gratis en su propio número.`,
      `- Puesta en marcha: ${s.setup}`,
      s.terms ? `- ${s.terms}` : "",
      "Di solo lo que hace, nunca resultados: no prometas más pacientes, menos ausencias ni cifras, porque ninguna clínica lo ha usado todavía. Si te piden algo que no está aquí (una integración con su programa de gestión, protección de datos), di que lo verá el equipo en la llamada de seguimiento.",
      `Para seguir: ofrece ${s.followUp}. Pide su nombre, el nombre de su clínica, un teléfono o email y cuándo le viene bien, y llama a book_follow_up. Con su nombre y un teléfono o email basta: si no entiendes un dato, pregúntalo una sola vez y después apunta lo que tengas. Después confirma en una frase que el equipo le llamará.`,
      "Si quiere probar la demo como paciente, cambia al papel de recepcionista y atiéndele como a un paciente.",
      "",
      "# Quién te habla y qué necesita (para el equipo)",
      "Cuando veas que llama por una clínica, pregunta una sola vez y con naturalidad con quién hablas: si es el dueño o director de la clínica, de recepción u otra persona, y de qué clínica y ciudad llama. Escucha qué pregunta y qué le hace falta en su clínica (por ejemplo cubrir la hora de comer, las llamadas perdidas, el WhatsApp, su programa de agenda).",
      "Antes de despedirte de alguien de una clínica, llama una vez a qualify_lead con quién es, su clínica y ciudad, lo que preguntó, lo que necesita (en sus palabras, corto) y su respuesta: sí, quizá o no. No lo digas en voz alta: es una nota para el equipo. Si no sabes algo, pon \"no lo dijo\".",
    );
  }
  out.push(
    "",
    "# Lo que no puedes resolver en la llamada",
    "Si piden algo que no puedes hacer tú (una pregunta cuya respuesta no está arriba, que les llame una persona, cambiar o anular una cita que no reservaste tú, una queja, un presupuesto), nunca lo dejes en el aire: llama a file_ticket con lo que necesitan en una frase, quién es (paciente, clínica u otra persona) y, si lo da, un teléfono o email. Después di exactamente la frase que devuelve: es la promesa de la clínica, nunca prometas otra cosa ni otro día.",
    "",
    "# Cómo hablas",
    "Una o dos frases por turno. No leas listas largas ni números largos. Nunca interrumpas.",
    `Cuando la persona se despide (adiós, gracias, eso es todo), despídete en una frase${c.sales ? ", llama a qualify_lead si es de una clínica y no lo has hecho," : ""} y llama a end_call, aunque falte algún dato: nunca la retengas.`,
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** the receptionist's instructions in English (an Irish clinic), made from the clinic's config only. */
export function clinicPromptEn(c: Clinic): string {
  const who = c.receptionist ?? "the receptionist";
  const hours = WEEKDAYS.slice(1)
    .concat(WEEKDAYS[0])
    .map((d) => `- ${dayEn(d)}: ${(c.hours[d] ?? []).length ? c.hours[d].map((r) => r.replace("-", " to ")).join(" and ") : "closed"}`)
    .join("\n");
  const services = c.services.map((s) => `- ${s.name}: ${s.price}${s.minutes ? ` (${s.minutes} minutes)` : ""}`).join("\n");
  const out = [
    `You are ${who}, the voice receptionist of ${c.clinic}, ${c.kind ?? "a dental practice"} in ${c.city}${c.address ? ` (${c.address})` : ""}, Ireland. You speak warm, natural Irish English in short sentences, friendly and professional. You answer every call to the practice: you are its phone line, not an answering machine.`,
    c.madeUp ? "This practice is a demo: its patients, appointments and prices are made up. If asked, say so naturally." : "",
    "",
    "# What you know about the practice (only this)",
    "Opening hours:",
    hours,
    "Treatments and prices:",
    services,
    c.insurers?.length ? `Schemes and insurers: ${c.insurers.join(", ")}.` : "",
    c.dentists?.length ? `Dentists: ${c.dentists.join(", ")}.` : "",
    ...(c.notes ?? []),
    ...(c.objectives?.length
      ? ["", "# What the practice wants from you", ...c.objectives.map((o, i) => `${i + 1}. ${sayObjective(o)}`), "Keep it in mind on every call. Never read it out or push anyone with it."]
      : []),
    "",
    "# How you look after a patient",
    "1. Ask what they need. If they do not know the treatment, offer a check-up.",
    "2. Ask which day suits and call free_slots with the day as they say it (for example \"Tuesday\", \"tomorrow\", \"3 December\"). Offer at most three of the times it returns. Never make up a free time.",
    "3. When they pick a time, ask their name and call book_appointment with the name, the treatment, the date (the one free_slots returned, YYYY-MM-DD) and the time. Then repeat the day, time and treatment in one sentence.",
    "4. To change or cancel an appointment, take their name and the appointment they have, and file a ticket for the front desk unless you booked it on this call.",
    "5. Prices, hours, schemes, insurance and directions: only what is above. If you do not know, say so and file a ticket so the team rings back.",
    "Never give medical advice or say what a pain means. In a serious emergency (heavy bleeding, swelling that makes breathing hard, a hard knock to the face) tell them to ring 999 or 112. If they are in pain, offer the first free emergency slot.",
    "Never ask for medical details, PPS numbers or card details.",
  ];
  if (c.sales) {
    const s = c.sales;
    out.push(
      "",
      `# If the caller owns or runs a clinic (the ${s.company} demo)`,
      `You are the product: what they just heard is what their clinic would have. You become the clinic's phone line: you pick up every call, turn each into a booking, a lead or a task for the staff, and put the calls that matter through to their people. In your first answer say what it is in one sentence and the price and free trial in another; never ask whether they want the price, say it. Then answer what they ask, one thing at a time:`,
      `- What it is: ${s.what}`,
      `- Price: ${s.price}.${s.priceWhatsappOnly ? ` WhatsApp only: ${s.priceWhatsappOnly}.` : ""}`,
      `- Trial: ${s.trialDays} days free on their own number.`,
      `- Setting up: ${s.setup}`,
      s.terms ? `- ${s.terms}` : "",
      "Say only what it does, never results: never promise more patients, fewer no-shows or any figure, because no clinic has used it yet. If they ask for something not here (their practice software, data protection), say the team will cover it on the follow-up call.",
      `To follow up: offer ${s.followUp}. Ask their name, their clinic, a phone or email and when suits, and call book_follow_up. A name and a phone or email is enough: if you miss a detail, ask once, then note what you have. Then confirm in one sentence that the team will be in touch.`,
      "If they want to try it as a patient, switch to the receptionist role and look after them as a patient.",
      "",
      "# Who is calling and what they need (for the team)",
      "When you see they are calling for a clinic, ask once and naturally who you are speaking with: the owner or practice manager, the front desk, or someone else, and which clinic and town.",
      "Before saying goodbye to someone from a clinic, call qualify_lead once with who they are, their clinic and town, what they asked, what they need (in their words, short) and their answer: yes, maybe or no. Do not say it out loud: it is a note for the team. If you do not know something, put \"not said\".",
    );
  }
  out.push(
    "",
    "# What you cannot sort out on the call",
    "If they want something you cannot do (a question whose answer is not above, a person to ring them, a change to an appointment you did not book, a complaint, a quote), never leave it hanging: call file_ticket with what they need in one sentence, who they are (patient, clinic or other) and, if they give it, a phone or email. Then say exactly the sentence it returns: it is the practice's promise; never promise anything else or another day.",
    "",
    "# How you speak",
    "One or two sentences a turn. No long lists or long numbers. Never interrupt.",
    `When they say goodbye (bye, thanks, that's all), say goodbye in one sentence${c.sales ? ", call qualify_lead if they are from a clinic and you have not," : ""} and call end_call, even if a detail is missing: never keep them.`,
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

const CLINIC_TOOLS_EN = (c: Clinic) => [
  {
    name: "file_ticket",
    description: "Puts something you cannot sort out on the call on the practice's task list. Returns the promise sentence you must say.",
    parameters: { properties: { need: { type: "string", description: "what the person needs, in one sentence" }, who: { type: "string", description: "patient, clinic or other" }, contact: { type: "string", description: "optional: their phone or email if they give it" } }, required: ["need"] },
  },
  {
    name: "free_slots",
    description: "The practice's free times on a day. Pass the day as the person says it (today, tomorrow, Tuesday, 3 December) or a date YYYY-MM-DD.",
    parameters: { properties: { day: { type: "string", description: "the day the person asks for" }, part: { type: "string", description: "optional: morning or afternoon" } }, required: ["day"] },
  },
  {
    name: "book_appointment",
    description: "Books a patient into a free time that free_slots returned.",
    parameters: { properties: { name: { type: "string", description: "the patient's name" }, service: { type: "string", description: "the treatment" }, date: { type: "string", description: "the date YYYY-MM-DD" }, time: { type: "string", description: "the time HH:MM" } }, required: ["name", "service", "date", "time"] },
  },
  ...(c.sales
    ? [
        {
          name: "book_follow_up",
          description: "Notes the follow-up call with the team for an interested clinic.",
          parameters: { properties: { name: { type: "string", description: "the person's name" }, clinic: { type: "string", description: "their clinic" }, contact: { type: "string", description: "their phone or email" }, when: { type: "string", description: "when suits for the call" } }, required: ["name", "contact"] },
        },
        {
          name: "qualify_lead",
          description: "A note for the team, once per call with someone from a clinic: who they are, what they asked, what they need and their answer. Never said out loud.",
          parameters: {
            properties: {
              who: { type: "string", description: "who answered: owner or practice manager, receptionist, or someone else with their role" },
              clinic: { type: "string", description: "their clinic's name, if said" },
              city: { type: "string", description: "their town, if said" },
              asks: { type: "string", description: "what they asked, short" },
              needs: { type: "string", description: "what their clinic needs, in their words, short" },
              answer: { type: "string", description: "yes, maybe or no: whether they want to go on" },
            },
            required: ["who", "needs"],
          },
        },
      ]
    : []),
];

export const CLINIC_TOOLS = (c: Clinic) => (c.lang === "en" ? CLINIC_TOOLS_EN(c) : CLINIC_TOOLS_ES(c));
const CLINIC_TOOLS_ES = (c: Clinic) => [
  {
    name: "file_ticket",
    description: "Apunta en la lista de pendientes de la clínica algo que no puedes resolver en la llamada. Devuelve la frase con la promesa que debes decir.",
    parameters: {
      properties: {
        need: { type: "string", description: "lo que necesita la persona, en una frase" },
        who: { type: "string", description: "paciente, clínica u otra persona" },
        contact: { type: "string", description: "opcional: su teléfono o email si lo da" },
      },
      required: ["need"],
    },
  },
  {
    name: "free_slots",
    description: "Las horas libres de la clínica en un día. Pásale el día tal como lo dice la persona (hoy, mañana, el martes, 3 de diciembre) o una fecha AAAA-MM-DD.",
    parameters: { properties: { day: { type: "string", description: "el día que pide la persona" }, part: { type: "string", description: "opcional: mañana o tarde" } }, required: ["day"] },
  },
  {
    name: "book_appointment",
    description: "Reserva la cita de un paciente en una hora libre que devolvió free_slots.",
    parameters: {
      properties: {
        name: { type: "string", description: "nombre del paciente" },
        service: { type: "string", description: "el tratamiento" },
        date: { type: "string", description: "la fecha AAAA-MM-DD" },
        time: { type: "string", description: "la hora HH:MM" },
      },
      required: ["name", "service", "date", "time"],
    },
  },
  ...(c.sales
    ? [
        {
          name: "book_follow_up",
          description: "Apunta la llamada de seguimiento con el equipo para una clínica interesada.",
          parameters: {
            properties: {
              name: { type: "string", description: "nombre de la persona" },
              clinic: { type: "string", description: "nombre de su clínica" },
              contact: { type: "string", description: "su teléfono o email" },
              when: { type: "string", description: "cuándo le viene bien la llamada" },
            },
            required: ["name", "contact"],
          },
        },
        {
          name: "qualify_lead",
          description: "Nota para el equipo, una vez por llamada con alguien de una clínica: quién es, qué preguntó, qué necesita y su respuesta. No se dice en voz alta.",
          parameters: {
            properties: {
              who: { type: "string", description: "quién contesta: dueño o director, recepcionista, u otra persona con su puesto" },
              clinic: { type: "string", description: "el nombre de su clínica, si lo dijo" },
              city: { type: "string", description: "su ciudad, si la dijo" },
              asks: { type: "string", description: "lo que preguntó, corto" },
              needs: { type: "string", description: "lo que necesita su clínica, en sus palabras, corto" },
              answer: { type: "string", description: "sí, quizá o no: si quiere seguir" },
            },
            required: ["who", "needs"],
          },
        },
      ]
    : []),
];

/** the agent as made on the account: Spanish, multilingual voice, end_call only on a goodbye, a short call, no
 * overrides (the public page can never change what it says) and signed links only. */
export function clinicAgentBody(c: Pick<Clinic, "voiceId"> & { lang?: Clinic["lang"] }, maxS: number = CLINIC_CALL_MAX_S, endCall = "Termina la llamada cuando la persona se despide, después de una despedida corta.") {
  if (c.lang === "en" && endCall.startsWith("Termina")) endCall = "End the call when the person says goodbye, after a short goodbye.";
  return (prompt: string, firstMessage: string, tools: Parameters<typeof agentBody>[2], name?: string, tags?: string[], lang: CallLang = "es") => {
    const b = agentBody(prompt, firstMessage, tools, name, tags, c.lang === "en" ? "en" : lang === "en" ? "es" : lang);
    const agent = b.conversation_config.agent;
    agent.prompt.tools = agent.prompt.tools.map((t: any) =>
      t.type === "system" ? { ...t, description: endCall } : { ...t, response_timeout_secs: 20 },
    ) as typeof agent.prompt.tools;
    return {
      ...b,
      conversation_config: {
        ...b.conversation_config,
        tts: { ...b.conversation_config.tts, ...(c.voiceId ? { voice_id: c.voiceId } : {}) },
        conversation: { max_duration_seconds: maxS },
      },
      platform_settings: { auth: { enable_auth: true }, overrides: { conversation_config_override: { agent: { prompt: { prompt: false }, first_message: false, language: false } } } },
    } as unknown as ReturnType<typeof agentBody>;
  };
}

// ---------- the calls ----------

export interface ClinicDeps {
  db: DB;
  /** every clinic config, read again when a page or call asks (a new file needs no release). */
  clinics: () => Map<string, Clinic>;
  key: () => Promise<string | undefined>;
  /** tests fake the ElevenLabs door per clinic. */
  eleven?: (c: Clinic) => ElevenCalls;
  now?: () => number;
  /** what the receptionist cannot solve becomes a ticket on the clinic's task tree (clinicFollowUp.ts). */
  followUp?: FollowUp;
  /** each qualified call lands as a lead row in the Dental clinics table (clinicLeads.ts). */
  leads?: Leads;
  /** writes the clinic's config file in the repo (commit + push); the set-up call writes its objectives with it. */
  writeClinic?: (slug: string, make: (cur: string | undefined) => string, msg: string) => Promise<{ state: string; detail?: string }>;
  /** how long confirm_objectives waits for the write before it answers (tests shorten it). */
  writeWaitMs?: number;
}

export function ensureClinicTables(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_calls (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      started_at TEXT NOT NULL,
      visitor TEXT NOT NULL,
      tools INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      reason TEXT,
      transcript TEXT
    );
    CREATE INDEX IF NOT EXISTS clinic_calls_slug ON clinic_calls (slug, started_at);
    CREATE TABLE IF NOT EXISTS clinic_setup (
      call_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      n INTEGER NOT NULL,
      data TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (call_id, n)
    );
    CREATE TABLE IF NOT EXISTS clinic_bookings (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      date TEXT,
      time TEXT,
      data TEXT NOT NULL,
      at TEXT NOT NULL
    );
    -- each open of a clinic's call page is one scan (a posted letter's code or short link lands here), read
    -- weekly with the calls by scripts/clinic_reading.py; code is the letter's code (?c=), null for a plain open.
    CREATE TABLE IF NOT EXISTS clinic_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      code TEXT,
      visitor TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS clinic_scans_slug ON clinic_scans (slug, at);
  `);
  // the letter's code a call was opened with
  if (!(db.prepare("PRAGMA table_info(clinic_calls)").all() as { name: string }[]).some((c) => c.name === "code")) db.exec("ALTER TABLE clinic_calls ADD COLUMN code TEXT");
  // a set-up call (clinicSetup.ts) is a clinic call of kind 'setup'; older rows are the receptionist's.
  if (!(db.prepare("PRAGMA table_info(clinic_calls)").all() as { name: string }[]).some((c) => c.name === "kind"))
    db.exec("ALTER TABLE clinic_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'reception'");
}

/** a letter's code as the call page passes it: letters, digits and dashes, upper case; anything else is no code. */
export const letterCode = (v: unknown): string | undefined => {
  const t = String(v ?? "").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{2,15}$/.test(t) ? t : undefined;
};

export type ClinicCallKind = "reception" | "setup";

export function createClinicDemo(d: ClinicDeps) {
  const { db } = d;
  ensureClinicTables(db);
  ensureClinicPlans(db);
  const now = d.now ?? Date.now;
  const doors = new Map<string, ElevenCalls>();
  const setting = (k: string) => (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const setSetting = (k: string, v: string) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  const finding = new Set<string>();
  // a clinic whose voice should have an accent (the Irish demo): the voice found once in the ElevenLabs voice library and
  // kept as `<voice id>|<name>`; until then (or when none is found, tried again after a day) the default voice speaks.
  const accentVoice = (c: Clinic): string | undefined => {
    if (c.voiceId || !c.voiceAccent || d.eleven) return c.voiceId;
    const k = `eleven_voice_accent_${c.voiceAccent}`;
    const have = setting(k);
    if (have && !have.startsWith("none|")) return have.split("|")[0];
    if (have && now() - Number(have.split("|")[1] ?? 0) < 86_400_000) return undefined;
    if (!finding.has(k)) {
      finding.add(k);
      void findAccentVoice(d.key, c.voiceAccent, clinicLang(c))
        .then((v) => setSetting(k, v ? `${v.id}|${v.name}` : `none|${now()}|no free voice with that accent`))
        .catch((e) => setSetting(k, `none|${now()}|${(e as Error).message.slice(0, 120)}`))
        .finally(() => finding.delete(k));
    }
    return undefined;
  };
  // one door per clinic and skin; a changed prompt (new objectives) or voice makes a new door, which brings the agent in step.
  const door = (c0: Clinic, kind: ClinicCallKind = "reception") => {
    const voice = accentVoice(c0);
    const c: Clinic = voice ? { ...c0, voiceId: voice } : c0;
    const setup = kind === "setup";
    const prompt = setup ? setupPrompt(c) : clinicPrompt(c);
    const at = `${c.slug}|${kind}|${crypto.createHash("sha256").update(`${prompt}|${c.voiceId ?? ""}`).digest("hex").slice(0, 12)}`;
    let x = doors.get(at);
    if (!x) {
      const k = setup ? `eleven_clinic_setup_${c.slug}_agent_id` : `eleven_clinic_${c.slug}_agent_id`;
      x =
        d.eleven?.(c) ??
        elevenCalls({
          name: setup ? setupAgentName(c) : clinicAgentName(c),
          tags: [setup ? "clinic-setup" : "clinic-receptionist", c.slug],
          key: d.key,
          prompt: () => prompt,
          firstMessage: () => (setup ? setupGreeting(c) : clinicGreeting(c)),
          tools: () => (setup ? SETUP_TOOLS : CLINIC_TOOLS(c)) as any,
          body: clinicAgentBody(c, setup ? CLINIC_SETUP_MAX_S : CLINIC_CALL_MAX_S),
          knownLang: clinicLang(c),
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, id),
          },
        });
      for (const key of [...doors.keys()]) if (key.startsWith(`${c.slug}|${kind}|`)) doors.delete(key);
      doors.set(at, x);
    }
    return x;
  };
  const clinic = (slug: string) => {
    const c = d.clinics().get(slug);
    if (!c) throw new VoiceError(404, "not_found", "No hay ninguna clínica con ese nombre.");
    return c;
  };
  const iso = () => new Date(now()).toISOString();
  const visitorHash = (addr: string) => crypto.createHash("sha256").update(`clinic|${addr}`).digest("hex").slice(0, 16);
  const liveCall = (slug: string, id: string) => {
    const r = db.prepare("SELECT * FROM clinic_calls WHERE id = ? AND slug = ?").get(id, slug) as any;
    if (!r || r.ended_at || now() - Date.parse(r.started_at) > (r.kind === "setup" ? CLINIC_SETUP_MAX_S * 1000 + 60_000 : CALL_LIVE_MS)) throw new VoiceError(404, "no_call", "Esta llamada ya terminó.");
    return r;
  };
  const secret = () => {
    const k = "clinic_setup_secret";
    if (!(db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined))
      db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(k, crypto.randomBytes(24).toString("hex"));
    return (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string }).value;
  };
  const saved = (id: string): ClinicObjective[] =>
    (db.prepare("SELECT data FROM clinic_setup WHERE call_id = ? ORDER BY n").all(id) as { data: string }[]).map((r) => JSON.parse(r.data));
  const setupTool = async (c: Clinic, id: string, name: string, args: Record<string, unknown>): Promise<{ result: string }> => {
    if (name === "add_objective") {
      const o = objectiveIn(args);
      if (!o) return { result: "Falta el objetivo. Pregúntalo y vuelve a llamar a add_objective." };
      const have = saved(id).length;
      const asked = Number(String(args.number ?? "").replace(/\D/g, ""));
      const n = asked >= 1 && asked <= have ? asked : have + 1;
      if (n > SETUP_OBJECTIVES_MAX) return { result: `Ya hay ${SETUP_OBJECTIVES_MAX} objetivos apuntados, el máximo. Léelos y pregunta si los deja así.` };
      db.prepare("INSERT INTO clinic_setup (call_id, slug, n, data, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(call_id, n) DO UPDATE SET data = excluded.data, at = excluded.at").run(id, c.slug, n, JSON.stringify(o), iso());
      return { result: `Apuntado el objetivo ${n}: ${sayObjective(o)}. Si hay más, pregunta por el siguiente; si no, léelos todos y pregunta si los deja así en la ficha.` };
    }
    if (name === "confirm_objectives") {
      const list = saved(id);
      if (!list.length) return { result: "Aún no hay ningún objetivo apuntado. Pregunta qué quiere conseguir y usa add_objective." };
      if (!d.writeClinic) return { result: "No puedo escribir en la ficha ahora. Di que el equipo los apuntará y pon un file_ticket con los objetivos." };
      const at = iso();
      const w = d
        .writeClinic(c.slug, (cur) => withObjectives(cur ?? "{}", list, id, at), `Clinic set-up: ${c.slug}'s objectives set on its set-up call ${id} (via console)`)
        .catch((e) => ({ state: "failed", detail: (e as Error).message }));
      const done = await Promise.race([w, new Promise<undefined>((r) => setTimeout(() => r(undefined), d.writeWaitMs ?? 12_000))]);
      if (done && done.state === "failed") return { result: "No se pudo escribir en la ficha. Dilo en una frase y pon un file_ticket con los objetivos para que el equipo los apunte." };
      return { result: `Escrito: ${list.length} objetivo${list.length === 1 ? "" : "s"} en la ficha de ${c.clinic}. Dilo en una frase: desde ahora ${c.receptionist ?? "la recepcionista"} trabaja con ellos en mente. Después pasa a conectar.` };
    }
    if (name === "file_ticket") {
      if (!d.followUp) return { result: "No puedo apuntar pendientes ahora. Di que el equipo lo verá." };
      // on a set-up call the promise is ours to the clinic, never the clinic's to itself
      return { result: d.followUp.file({ ...c, clinic: `El equipo de ${c.sales?.company ?? "puesta en marcha"}` }, id, { need: String(args.need ?? ""), who: String(args.who ?? "clínica") }).result };
    }
    return { result: `No conozco la herramienta ${name}.` };
  };
  const taken = (slug: string, date: string) => new Set((db.prepare("SELECT time FROM clinic_bookings WHERE slug = ? AND kind = 'appointment' AND date = ?").all(slug, date) as { time: string }[]).map((r) => r.time));

  return {
    clinic,
    list: () => [...d.clinics().values()],
    /** the voice an accented clinic speaks with: the library voice found, or why the default speaks. */
    voiceOf: (c: Clinic) => (c.voiceAccent ? (setting(`eleven_voice_accent_${c.voiceAccent}`) ?? "looking") : c.voiceId ?? "default"),
    /** one scan per open of the call page, with the letter's code when the link carries one (?c=). */
    scan(slug: string, code: string | undefined, addr: string) {
      clinic(slug);
      const k = /^[A-Za-z0-9_-]{1,40}$/.test(code ?? "") ? code! : null;
      db.prepare("INSERT INTO clinic_scans (slug, code, visitor, at) VALUES (?, ?, ?, ?)").run(slug, k, visitorHash(addr), iso());
    },
    /** the page opened: the next call's link is made now (one per clinic, kept 10 minutes). */
    warm(slug: string, kind: ClinicCallKind = "reception") {
      const c = clinic(slug);
      void door(c, kind).warm?.(clinicLang(c));
    },
    /** a real clinic's receptionist answers only while its plan is on; our made-up demo clinics always do. */
    isOn: (slug: string) => !!clinic(slug).madeUp || inTry(clinic(slug), now()) || planOn(clinicPlan(db, slug)),
    plan: (slug: string) => clinicPlan(db, slug),
    /** the clinic's private set-up link (its key is the credential); handed out on the owner's signed-in view. */
    setupLink: (slug: string) => `/api/public/clinic/${clinic(slug).slug}/puesta-en-marcha?k=${setupKey(secret(), slug)}`,
    validSetup: (slug: string, k: string) => validSetupKey(secret(), slug, k),
    /** the objectives a set-up call has noted so far (written to the file only on the owner's yes). */
    noted: (id: string) => saved(id),
    async start(slug: string, addr: string, code?: string, kind: ClinicCallKind = "reception", k = "") {
      const c = clinic(slug);
      if (kind === "setup" && !validSetupKey(secret(), slug, k)) throw new VoiceError(404, "not_found", "Este enlace de puesta en marcha no es válido.");
      // the set-up call comes before the receptionist is on; only her own calls wait on the plan.
      if (kind !== "setup" && !c.madeUp && !inTry(c, now()) && !planOn(clinicPlan(db, slug))) throw new VoiceError(409, "not_on", "La recepcionista de esta clínica aún no está activada.");
      const v = visitorHash(addr);
      const hourAgo = new Date(now() - 3_600_000).toISOString();
      const dayAgo = new Date(now() - 86_400_000).toISOString();
      // a set-up call counts only against set-up calls: its link's key and its own day cap bound it.
      const mine = (db.prepare("SELECT COUNT(*) n FROM clinic_calls WHERE visitor = ? AND started_at > ? AND (kind = 'setup') = ?").get(v, hourAgo, kind === "setup" ? 1 : 0) as { n: number }).n;
      if (mine >= CLINIC_STARTS_PER_HOUR) throw new VoiceError(409, "too_many", "Ha hecho varias llamadas seguidas. Vuelva a probar dentro de una hora.");
      const all = (db.prepare("SELECT COUNT(*) n FROM clinic_calls WHERE slug = ? AND started_at > ?").get(slug, dayAgo) as { n: number }).n;
      if (kind === "setup") {
        const setups = (db.prepare("SELECT COUNT(*) n FROM clinic_calls WHERE slug = ? AND kind = 'setup' AND started_at > ?").get(slug, dayAgo) as { n: number }).n;
        if (setups >= SETUP_CALLS_PER_DAY) throw new VoiceError(409, "day_full", "Hoy ya se han hecho todas las llamadas de puesta en marcha. Vuelva a probar mañana.");
      } else if (all >= (c.callsPerDay ?? 40)) throw new VoiceError(409, "day_full", "La demo ya ha atendido todas las llamadas de hoy. Vuelva a probar mañana.");
      const link = await door(c, kind).link(clinicLang(c));
      const id = `cc_${crypto.randomBytes(12).toString("hex")}`;
      db.prepare("INSERT INTO clinic_calls (id, slug, started_at, visitor, code, kind) VALUES (?, ?, ?, ?, ?, ?)").run(id, slug, iso(), v, letterCode(code) ?? null, kind);
      return { call: id, signedUrl: link.signedUrl, ...(d.followUp ? { trace: d.followUp.traceUrl(slug, id) } : {}) };
    },
    async tool(slug: string, id: string, name: string, args: Record<string, unknown>): Promise<{ result: string }> {
      const c = clinic(slug);
      const r = liveCall(slug, id);
      if (r.tools >= TOOLS_PER_CALL * (r.kind === "setup" ? 2 : 1)) return { result: "No puedo hacer más gestiones en esta llamada." };
      db.prepare("UPDATE clinic_calls SET tools = tools + 1 WHERE id = ?").run(id);
      if (r.kind === "setup") return setupTool(c, id, name, args);
      const en = c.lang === "en";
      const L = (es: string, e: string) => (en ? e : es);
      const s = (k: string) => String(args[k] ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const booked = () => (db.prepare("SELECT COUNT(*) n FROM clinic_bookings WHERE call_id = ?").get(id) as { n: number }).n;
      if (name === "free_slots") {
        const date = parseDay(s("day"), now());
        if (!date) return { result: L(`No he entendido el día "${s("day")}". Pide el día de la semana o la fecha.`, `I did not understand the day "${s("day")}". Ask for the weekday or the date.`) };
        if (date < madridToday(now()).iso) return { result: L("Ese día ya ha pasado. Pide otro día.", "That day has passed. Ask for another day.") };
        let slots = freeSlots(c, date, taken(slug, date), now());
        const part = fromEnglish(plain(s("part")));
        if (/tarde/.test(part)) slots = slots.filter((h) => h >= "14:00");
        else if (/manana/.test(part)) slots = slots.filter((h) => h < "14:00");
        if (!(c.hours[WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]] ?? []).length) return { result: L(`El ${sayDate(date)} (${date}) la clínica está cerrada.`, `The practice is closed on ${sayDate(date, true)} (${date}).`) };
        if (!slots.length) return { result: L(`El ${sayDate(date)} (${date}) no queda ninguna hora libre${part ? ` por la ${part}` : ""}. Ofrece otro día.`, `Nothing free on ${sayDate(date, true)} (${date})${part ? ` in the ${s("part")}` : ""}. Offer another day.`) };
        return { result: L(`${sayDate(date)} (${date}): horas libres ${slots.slice(0, 3).join(", ")}. Ofrece estas.`, `${sayDate(date, true)} (${date}): free at ${slots.slice(0, 3).join(", ")}. Offer these.`) };
      }
      if (name === "book_appointment") {
        if (booked() >= BOOKINGS_PER_CALL) return { result: L("En una llamada de demostración se reservan como mucho tres citas.", "A demo call books three appointments at most.") };
        const date = /^\d{4}-\d{2}-\d{2}$/.test(s("date")) ? s("date") : parseDay(s("date"), now());
        const time = (s("time").match(/^(\d{1,2})[:.h ]?(\d{2})?/) ?? []).slice(1);
        const hm = time[0] ? `${time[0].padStart(2, "0")}:${time[1] ?? "00"}` : "";
        if (!date || !hm || !s("name")) return { result: L("Faltan el nombre, la fecha o la hora. Pídelos y vuelve a llamar a book_appointment.", "The name, date or time is missing. Ask for it and call book_appointment again.") };
        if (!freeSlots(c, date, taken(slug, date), now()).includes(hm)) return { result: L(`Las ${hm} del ${sayDate(date)} no están libres. Llama a free_slots y ofrece otra hora.`, `${hm} on ${sayDate(date, true)} is not free. Call free_slots and offer another time.`) };
        db.prepare("INSERT INTO clinic_bookings (id, call_id, slug, kind, date, time, data, at) VALUES (?, ?, ?, 'appointment', ?, ?, ?, ?)").run(
          `cb_${crypto.randomBytes(6).toString("hex")}`,
          id,
          slug,
          date,
          hm,
          JSON.stringify({ name: s("name"), service: s("service") }),
          iso(),
        );
        return { result: L(`Reservado: ${s("service") || "cita"} para ${s("name")}, el ${sayDate(date)} a las ${hm}. Confírmalo en una frase.`, `Booked: ${s("service") || "appointment"} for ${s("name")}, ${sayDate(date, true)} at ${hm}. Confirm it in one sentence.`) };
      }
      if (name === "file_ticket") {
        if (!d.followUp) return { result: L("No puedo apuntar pendientes ahora. Di que llamen a la clínica en horario de recepción.", "I cannot note tasks right now. Ask them to ring the practice during opening hours.") };
        const t = d.followUp.file(c, id, { need: s("need"), who: s("who"), contact: s("contact") });
        return { result: en ? `Noted for the team. Promise exactly this, in English: the practice will get back to them within ${c.followUpDays ?? 1} working day${(c.followUpDays ?? 1) === 1 ? "" : "s"}. (Its note: ${t.result})` : t.result };
      }
      if (name === "qualify_lead" && c.sales) {
        if ((db.prepare("SELECT COUNT(*) n FROM clinic_bookings WHERE call_id = ? AND kind = 'lead'").get(id) as { n: number }).n)
          return { result: L("Ya está anotado. Sigue la conversación o despídete.", "Already noted. Carry on or say goodbye.") };
        const lead = { who: whoAnswered(s("who")), clinic: s("clinic"), city: s("city"), asks: s("asks"), needs: s("needs"), answer: s("answer"), code: r.code ?? undefined };
        db.prepare("INSERT INTO clinic_bookings (id, call_id, slug, kind, data, at) VALUES (?, ?, ?, 'lead', ?, ?)").run(`cb_${crypto.randomBytes(6).toString("hex")}`, id, slug, JSON.stringify(lead), iso());
        void d.leads?.land({ call: id, day: madridToday(now()).iso, ...lead });
        return { result: L("Anotado para el equipo. No lo menciones; sigue la conversación o despídete.", "Noted for the team. Do not mention it; carry on or say goodbye.") };
      }
      if (name === "book_follow_up" && c.sales) {
        if (booked() >= BOOKINGS_PER_CALL) return { result: L("Ya está apuntado. Confírmalo y despídete.", "Already noted. Confirm it and say goodbye.") };
        if (!s("name") || !s("contact")) return { result: L("Faltan su nombre o un teléfono o email. Pídelos.", "Their name or a phone or email is missing. Ask for it.") };
        db.prepare("INSERT INTO clinic_bookings (id, call_id, slug, kind, data, at) VALUES (?, ?, ?, 'follow_up', ?, ?)").run(
          `cb_${crypto.randomBytes(6).toString("hex")}`,
          id,
          slug,
          JSON.stringify({ name: s("name"), clinic: s("clinic"), contact: s("contact"), when: s("when") }),
          iso(),
        );
        return { result: L(`Apuntado: el equipo de ${c.sales.company} llamará a ${s("name")} (${s("clinic")})${s("when") ? `, ${s("when")}` : ""}. Confírmalo en una frase.`, `Noted: the ${c.sales.company} team will be in touch with ${s("name")} (${s("clinic")})${s("when") ? `, ${s("when")}` : ""}. Confirm it in one sentence.`) };
      }
      return { result: `No conozco la herramienta ${name}.` };
    },
    end(slug: string, id: string, b: { reason?: string; transcript?: { who: string; text: string }[] }) {
      const r = db.prepare("SELECT * FROM clinic_calls WHERE id = ? AND slug = ?").get(id, slug) as any;
      if (!r) throw new VoiceError(404, "no_call", "No existe esa llamada.");
      if (r.ended_at) return { ended: true };
      const t = (b.transcript ?? []).slice(0, 200).map((l) => ({ who: l.who === "voice" ? "voice" : "caller", text: l.text.slice(0, 1000) }));
      db.prepare("UPDATE clinic_calls SET ended_at = ?, reason = ?, transcript = ? WHERE id = ?").run(iso(), (b.reason ?? "ended").slice(0, 40), JSON.stringify(t), id);
      // a call opened from a letter always lands as a lead: what the caller asked, from the call's text, when the rep
      // never qualified it (the caller hung up first, the line dropped)
      const qualified = (db.prepare("SELECT COUNT(*) n FROM clinic_bookings WHERE call_id = ? AND kind = 'lead'").get(id) as { n: number }).n > 0;
      if (r.code && !qualified && d.leads) {
        const lead = { who: "no lo dijo", asks: questionsIn(t), needs: "", answer: t.some((l) => l.who === "caller") ? `colgó sin decirlo (${(b.reason ?? "ended").slice(0, 20)})` : "no habló", code: r.code as string };
        db.prepare("INSERT INTO clinic_bookings (id, call_id, slug, kind, data, at) VALUES (?, ?, ?, 'lead', ?, ?)").run(`cb_${crypto.randomBytes(6).toString("hex")}`, id, slug, JSON.stringify({ ...lead, fromEnd: true }), iso());
        void d.leads.land({ call: id, day: madridToday(now()).iso, ...lead });
      }
      return { ended: true };
    },
    /** the caller's trace: the call and its tickets, only with the call's own key. */
    trace(slug: string, id: string, k: string) {
      const c = clinic(slug);
      if (!d.followUp || !d.followUp.validTrace(id, k)) throw new VoiceError(404, "no_call", "No existe esa llamada.");
      const r = db.prepare("SELECT * FROM clinic_calls WHERE id = ? AND slug = ?").get(id, slug) as any;
      if (!r) throw new VoiceError(404, "no_call", "No existe esa llamada.");
      return { clinic: c, call: { startedAt: r.started_at, endedAt: r.ended_at, transcript: r.transcript ? JSON.parse(r.transcript) : [] }, tickets: d.followUp.tickets(slug, id) };
    },
    /** the owner's view: the calls with their text and bookings, newest first. */
    calls(limit = 50) {
      const rows = db.prepare("SELECT * FROM clinic_calls ORDER BY started_at DESC LIMIT ?").all(Math.min(limit, 200)) as any[];
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        code: r.code ?? undefined,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        reason: r.reason,
        kind: r.kind ?? "reception",
        ...(r.kind === "setup" ? { objectives: saved(r.id) } : {}),
        transcript: r.transcript ? JSON.parse(r.transcript) : [],
        bookings: (db.prepare("SELECT kind, date, time, data, at FROM clinic_bookings WHERE call_id = ? ORDER BY at").all(r.id) as any[]).map((b) => ({ ...b, data: JSON.parse(b.data) })),
        tickets: d.followUp ? d.followUp.tickets(r.slug, r.id) : [],
      }));
    },
  };
}
export type ClinicDemo = ReturnType<typeof createClinicDemo>;

/**
 * A voice with this accent from the ElevenLabs voice library, added once to the account: only a voice open to every plan
 * and billed at the normal rate (no custom price), so it costs nothing beyond the call's usual minutes. Undefined when
 * none fits; the clinic then keeps the default voice.
 */
export async function findAccentVoice(key: () => Promise<string | undefined>, accent: string, lang: CallLang, f: typeof fetch = fetch): Promise<{ id: string; name: string } | undefined> {
  const k = await key();
  if (!k) throw new Error("no ElevenLabs key");
  const get = async (p: string, init: RequestInit = {}) => {
    const r = await f(`https://api.elevenlabs.io${p}`, { ...init, headers: { "xi-api-key": k, ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${String(j?.detail?.message ?? j?.detail?.status ?? "").slice(0, 100)}`);
    return j;
  };
  const ours = `Clinic receptionist · ${accent}`;
  const mine = await get(`/v1/voices?show_legacy=false`).catch(() => ({ voices: [] }));
  const kept = ((mine?.voices ?? []) as any[]).find((v) => v?.name === ours);
  if (kept?.voice_id) return { id: kept.voice_id, name: ours };
  const pick = (vs: any[]) =>
    vs.find((v) => v?.voice_id && v?.public_owner_id && v.free_users_allowed !== false && !(Number(v.rate) > 1) && v.category !== "famous" && /conversational|customer|narrat|social|informative/i.test(`${v.use_case ?? ""} ${v.descriptive ?? ""}`)) ??
    vs.find((v) => v?.voice_id && v?.public_owner_id && v.free_users_allowed !== false && !(Number(v.rate) > 1) && v.category !== "famous");
  const q = (gender: string) => `/v1/shared-voices?accent=${encodeURIComponent(accent)}&language=${lang}&gender=${gender}&page_size=50&sort=cloned_by_count`;
  const v = pick((await get(q("female")))?.voices ?? []) ?? pick((await get(q("male")))?.voices ?? []);
  if (!v) return undefined;
  const added = await get(`/v1/voices/add/${encodeURIComponent(v.public_owner_id)}/${encodeURIComponent(v.voice_id)}`, { method: "POST", body: JSON.stringify({ new_name: ours }) });
  return added?.voice_id ? { id: added.voice_id, name: `${ours} (${String(v.name ?? "").slice(0, 40)})` } : undefined;
}

// ---------- routes ----------

const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;
const toolIn = z.object({ name: z.string().min(1).max(40), args: z.record(z.unknown()).optional() });
const endIn = z.object({ reason: z.string().max(40).optional(), transcript: z.array(z.object({ who: z.string().max(10), text: z.string().max(4000) })).max(400).optional() });

/** GET /api/public/clinic/<slug> (the page), its call routes (open, routeScope.ts), and the owner's GET /api/clinic-demo/calls. */
/**
 * `invites` puts the demo clinics behind invites for visits from the internet (clinicInvites.ts): the page shows the email
 * box until its link carries a valid invite (?i=), and a call starts only with that invite or a posted letter's code.
 */
export function mountClinicDemo(api: Hono, demo: ClinicDemo, o: { invites?: Invites; letterOk?: (code: string) => boolean } = {}) {
  const needsInvite = (c: Context, cl: Clinic) => !!o.invites && gated(cl) && fromInternet((h) => c.req.header(h));
  const letterOk = (code: unknown) => typeof code === "string" && !!code && !!o.letterOk?.(code);
  const hits = new Map<string, number[]>();
  const limited = (c: Context) => {
    const a = clientAddress(peerOf(c), (h) => c.req.header(h));
    const t = Date.now();
    const recent = (hits.get(a) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    hits.set(a, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > 40;
  };
  const pub = (fn: (c: Context, slug: string) => Promise<Response> | Response) => async (c: Context) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    if (limited(c)) return c.json({ error: { code: "too_many", message: "Demasiadas peticiones, espere un minuto." } }, 429);
    try {
      return await fn(c, c.req.param("slug") ?? "");
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
    "/public/clinic/:slug",
    pub((c, slug) => {
      const cl = demo.clinic(slug);
      c.header("referrer-policy", "no-referrer");
      const inv = c.req.query("i");
      if (needsInvite(c, cl) && !o.invites!.valid(slug, inv) && !letterOk(c.req.query("c"))) return c.html(invitePage(cl, { bad: !!inv }), inv ? 403 : 200);
      demo.scan(slug, c.req.query("c"), clientAddress(peerOf(c), (h) => c.req.header(h)));
      demo.warm(slug);
      return c.html(clinicPage(cl));
    }),
  );
  // the clinic's activation page: the plan (14 days free, then 149 euros a month), one button to the hosted
  // checkout (POST …/checkout, the billing plug), and whether its receptionist is on.
  api.get(
    "/public/clinic/:slug/activar",
    pub((c, slug) => {
      const cl = demo.clinic(slug);
      c.header("referrer-policy", "no-referrer");
      return c.html(activationPage(cl, demo.plan(slug), { back: c.req.query("pago") }));
    }),
  );
  // the branded instant web call: a link the clinic sends; the page names who calls, one tap answers.
  api.get(
    "/public/clinic/:slug/llamada",
    pub((c, slug) => {
      const cl = demo.clinic(slug);
      demo.scan(slug, c.req.query("c"), clientAddress(peerOf(c), (h) => c.req.header(h)));
      demo.warm(slug);
      c.header("referrer-policy", "no-referrer");
      return c.html(clinicPage(cl, { ring: true }));
    }),
  );
  // the caller's own trace of one call: what was said, each promise with its day and its state.
  api.get(
    "/public/clinic/:slug/calls/:cid/trace",
    pub((c, slug) => {
      const t = demo.trace(slug, c.req.param("cid") ?? "", c.req.query("k") ?? "");
      c.header("referrer-policy", "no-referrer");
      return c.html(tracePage(t.clinic, t.call, t.tickets));
    }),
  );
  api.post(
    "/public/clinic/:slug/calls",
    pub(async (c, slug) => {
      const b = await body(c);
      const cl = demo.clinic(slug);
      let inv: string | undefined;
      if (needsInvite(c, cl) && !letterOk(b.code)) {
        const i = o.invites!.valid(slug, b.invite);
        const en = cl.lang === "en";
        if (!i) return c.json({ error: { code: "invite_needed", message: en ? "The demo works by invite. Ask for yours with your email." : "La demo funciona con invitación. Pida la suya con su correo." } }, 403);
        if (o.invites!.callsToday(i.token) >= INVITE_CALLS_PER_DAY) return c.json({ error: { code: "too_many", message: en ? "Your invite has made all of today's calls. Come back tomorrow." : "Su invitación ya ha hecho todas las llamadas de hoy. Vuelva mañana." } }, 429);
        inv = i.token;
      } else if (o.invites?.valid(slug, b.invite)) inv = String(b.invite).toLowerCase();
      const r = await demo.start(slug, clientAddress(peerOf(c), (h) => c.req.header(h)), b.code);
      if (inv) o.invites!.mark(r.call, inv);
      return c.json(r, 201);
    }),
  );
  // the set-up call (clinicSetup.ts): the clinic's private page and its call start; the key is the credential.
  api.get(
    "/public/clinic/:slug/puesta-en-marcha",
    pub((c, slug) => {
      const k = c.req.query("k") ?? "";
      if (!demo.validSetup(slug, k)) throw new VoiceError(404, "not_found", "Este enlace de puesta en marcha no es válido.");
      demo.warm(slug, "setup");
      c.header("referrer-policy", "no-referrer");
      return c.html(clinicPage(demo.clinic(slug), { setup: k }));
    }),
  );
  api.post(
    "/public/clinic/:slug/setup/calls",
    pub(async (c, slug) => c.json(await demo.start(slug, clientAddress(peerOf(c), (h) => c.req.header(h)), undefined, "setup", c.req.query("k") ?? ""), 201)),
  );
  api.post(
    "/public/clinic/:slug/calls/:cid/tool",
    pub(async (c, slug) => {
      const p = toolIn.safeParse(await body(c));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "name and args" } }, 400);
      return c.json(await demo.tool(slug, c.req.param("cid") ?? "", p.data.name, p.data.args ?? {}));
    }),
  );
  api.post(
    "/public/clinic/:slug/calls/:cid/end",
    pub(async (c, slug) => {
      const p = endIn.safeParse(await body(c));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "reason and transcript" } }, 400);
      return c.json(demo.end(slug, c.req.param("cid") ?? "", p.data));
    }),
  );
  // the owner's (signed in, not open): every demo call with its text and bookings.
  api.get("/clinic-demo/calls", (c) => c.json({ clinics: demo.list().map((x) => ({ slug: x.slug, clinic: x.clinic, sales: !!x.sales, lang: x.lang ?? "es", voice: demo.voiceOf(x) })), calls: demo.calls(Number(c.req.query("limit")) || 50) }));
  // the owner's (signed in): each clinic's private set-up link and the objectives its file holds.
  api.get("/clinic-demo/setup", (c) =>
    c.json({ clinics: demo.list().map((x) => ({ slug: x.slug, clinic: x.clinic, link: demo.setupLink(x.slug), objectives: x.objectives ?? [], objectivesFromCall: x.objectivesFromCall ?? null })) }),
  );
}

// ---------- the page ----------

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
/** the ElevenLabs browser client, pinned (the console's web app uses the same version). */
const ELEVEN_CLIENT = { pkg: "@elevenlabs/client", version: "1.36.1" };
export const ELEVEN_CLIENT_URL = `https://cdn.jsdelivr.net/npm/${ELEVEN_CLIENT.pkg}@${ELEVEN_CLIENT.version}/+esm`;

export function clinicPage(c: Clinic, o: { ring?: boolean; letter?: { code: string; clinic: string }; setup?: string } = {}): string {
  if (o.setup) return setupPage(c, o.setup);
  if (c.lang === "en" && !o.letter) return clinicPageEn(c, o);
  const s = c.sales;
  // a Catalan clinic (set up from the Catalan call, clinicIntake.ts) gets its page in Catalan
  const ca = c.lang === "ca" && !s && !o.letter;
  const caller = c.receptionist ?? (ca ? "Recepció" : "Recepción");
  const days = WEEKDAYS.slice(1).concat(WEEKDAYS[0]).filter((d) => (c.hours[d] ?? []).length);
  const dayName = (d: string) => (ca ? DAYS_CA_OF[d] : `${d[0].toUpperCase()}${d.slice(1)}`);
  const title = s ? `Pruebe la recepcionista por voz · ${s.company}` : ca ? `${c.clinic} · Truqui a recepció` : `${c.clinic} · Llame a recepción`;
  const punch = s
    ? `Llame a nuestra recepcionista por voz: contesta, informa y reserva cita en español, a cualquier hora. Pregúntele también cuánto cuesta para su clínica.`
    : ca
      ? `Truqui a la recepció de ${c.clinic}: l'informa i li reserva hora, a qualsevol hora, en català.`
      : `Llame a la recepción de ${c.clinic}: le informa y le reserva cita, a cualquier hora.`;
  const flow = ca
    ? ["Algú truca", `${c.receptionist ?? "La recepcionista"} contesta`, "Busca hora lliure", "Hora reservada"]
    : ["Alguien llama", `${c.receptionist ?? "La recepcionista"} contesta`, "Busca hora libre", "Cita reservada"];
  return `<!doctype html>
<html lang="${ca ? "ca" : "es"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
${PAGE_CSS}</style></head><body><main>
${
  o.letter
    ? `<span class="tag">Su carta · código ${esc(o.letter.code)}</span>
<h1 data-testid="letter-clinic">${esc(o.letter.clinic)}: hable ahora con nuestra recepcionista de IA</h1>
<p class="punch">Es un agente de inteligencia artificial y esto es una demostración en directo. Pregúntele lo que quiera, como lo haría un paciente o usted mismo.</p>
<div class="flow" aria-hidden="true">${["Pulse el botón", "Hable con ella", "Pregunte el precio"].map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>`
    : o.ring
    ? `<span class="tag">Llamada entrante</span>
<h1 id="who">${esc(caller)} de ${esc(c.clinic)} le llama</h1>
<p class="punch">Pulse Contestar y hable. Sin descargar nada y sin WhatsApp. Al colgar, la llamada y lo que quede pendiente quedan en una página solo suya.</p>
<div class="flow" aria-hidden="true">${["Contestar", "Hablar", "Su página con lo pendiente"].map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>`
    : `<span class="tag">${s ? `Demo · ${esc(s.company)}` : esc(c.city)}</span>
<h1>${esc(c.clinic)}</h1>
<p class="punch">${esc(punch)}</p>
<div class="flow" aria-hidden="true">${flow.map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>`
}
<button id="call" data-testid="call-start" disabled>${o.ring ? (ca ? "Contestar" : "Contestar") : o.letter ? "Empezar la llamada" : ca ? "Trucar a recepció" : "Llamar a recepción"}</button>
<button id="hang" data-testid="call-hangup">${ca ? "Penjar" : "Colgar"}</button>
<p id="status" role="status">${ca ? "Preparant la línia…" : "Preparando la línea…"}</p>
<ul id="lines" aria-live="polite"></ul>
<p id="trace" class="small" hidden><a data-testid="call-trace" href="#">Su llamada y lo que queda pendiente</a>: esta página es solo suya, guárdela.</p>
${
  s
    ? `<section id="offer"><h2>Lo que recibe su clínica</h2>
<p>${esc(s.what)}</p>
<p class="price">${esc(s.price.replace(/,.*$/, ""))}</p>
<table>
<tr><td>Teléfono y WhatsApp, todas las llamadas</td><td>${esc(s.price.replace(/,.*$/, ""))}</td></tr>
${s.priceWhatsappOnly ? `<tr><td>Solo WhatsApp</td><td>${esc(s.priceWhatsappOnly.replace(/,.*$/, ""))}</td></tr>` : ""}
<tr><td>Prueba en su propio número</td><td>${s.trialDays} días gratis</td></tr>
<tr><td>Puesta en marcha</td><td>una llamada de 45 minutos</td></tr>
</table>
<p class="small">${esc(s.terms ?? "")} Pídale a la recepcionista que le llame el equipo.</p></section>`
    : ""
}
<section id="clinic"><h2>La clínica</h2>
<table>${days.map((d) => `<tr><td>${dayName(d)}</td><td>${c.hours[d].map((r) => r.replace("-", "–")).join(", ")}</td></tr>`).join("")}</table>
<table style="margin-top:12px">${c.services.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.price)}</td></tr>`).join("")}</table>
</section>
<p class="small" style="margin-top:24px">${
  ca
    ? "Cal micròfon. No guardem l'àudio, només el text de la trucada. La recepcionista no truca mai ningú: només contesta."
    : `${c.madeUp ? "Clínica de demostración: pacientes, citas y precios inventados. " : ""}Necesita micrófono. No guardamos el audio, solo el texto de la llamada. La recepcionista nunca llama a nadie: solo contesta.`
}</p>${
  o.letter
    ? `
<p class="small" id="privacy">Privacidad: ${esc(s?.company ?? "Nuestro equipo")} tomó la dirección postal de su clínica de su web pública y solo la usa para esta carta. Esta página cuenta cuántas veces se abre su código, sin cookies.${s?.contact ? ` Para que borremos sus datos o no volver a recibir nada, escriba a ${esc(s.contact)}.` : ""}</p>`
    : ""
}
</main>
${callScript(c.slug, "/calls", ["free_slots", "book_appointment", "book_follow_up", "file_ticket", "qualify_lead"], ca ? caller : "Recepción", o.letter?.code ?? "", ca ? { ui: CALL_UI_CA } : {})}</body></html>`;
}

export const PAGE_CSS = `@font-face{font-family:"Inter";font-weight:400;font-display:swap;src:url(/fonts/inter-400.woff2) format("woff2")}
@font-face{font-family:"Inter";font-weight:600;font-display:swap;src:url(/fonts/inter-600.woff2) format("woff2")}
:root{--paper:#f6f3ec;--ink:#1d1b17;--muted:#6b665c;--line:#d9d3c5;--green:#1f5c45;--card:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Inter,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:28px 16px 48px}
.tag{display:inline-block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
h1{font-size:26px;line-height:1.2;margin:12px 0 8px;font-weight:600}
.punch{font-size:18px;margin:0 0 20px}
.flow{display:flex;align-items:center;gap:6px;margin:0 0 24px;flex-wrap:wrap}
.flow span{border:1px solid var(--ink);border-radius:8px;padding:6px 10px;font-size:14px;background:var(--card)}
.flow i{font-style:normal;color:var(--muted)}
.flow span:last-child{border-color:var(--green);color:var(--green);font-weight:600}
#call{display:block;width:100%;padding:18px;border:0;border-radius:12px;background:var(--green);color:#fff;font:600 19px Inter,system-ui,sans-serif;cursor:pointer}
#call[disabled]{opacity:.6;cursor:default}
#hang{display:none;width:100%;margin-top:10px;padding:14px;border:1px solid var(--ink);border-radius:12px;background:transparent;font:600 16px Inter,system-ui,sans-serif;cursor:pointer;color:var(--ink)}
#status{min-height:24px;margin:12px 0 0;color:var(--muted);font-size:15px}
#lines{margin:16px 0 0;padding:0;list-style:none}
#lines li{margin:0 0 8px;padding:8px 12px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:15px}
#lines li.voice{border-color:var(--green)}
#lines li b{font-weight:600;margin-right:6px}
section{margin-top:28px;border-top:1px solid var(--line);padding-top:16px}
h2{font-size:17px;margin:0 0 10px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}
td:last-child{text-align:right;white-space:nowrap;padding-left:12px}
.price{font-size:22px;font-weight:600;color:var(--green)}
.small{font-size:13px;color:var(--muted)}
`;

/** the questions a caller to an Irish dental practice is likely to ask (the owner, 28 Nov, vn_d168d96e: "we should just be
 * able to, like, have an idea for what are the questions that are likely to be asked"); each one is a button that asks it
 * on the call. */
export const LIKELY_QUESTIONS_EN: { topic: string; ask: string }[] = [
  { topic: "Opening hours", ask: "Hi, what time are you open until today?" },
  { topic: "A new booking", ask: "I'd like to book a check-up for next week, please." },
  { topic: "Changing an appointment", ask: "I need to move my appointment on Thursday. Can you help?" },
  { topic: "Prices", ask: "How much is a scale and polish?" },
  { topic: "PRSI and insurance", ask: "Can I use my PRSI for a check-up, and do you take VHI?" },
  { topic: "Medical card", ask: "Do you see medical card patients?" },
  { topic: "Where you are", ask: "Where are you, and is there parking nearby?" },
  { topic: "A toothache today", ask: "I've a bad toothache. Can someone see me today?" },
  { topic: "A person, please", ask: "Can I speak to someone about getting implants?" },
  { topic: "For your clinic", ask: "I run a dental practice. How would this work for us, and what does it cost?" },
];
export const CALL_UI_EN = {
  you: "You",
  failed: "Could not: ",
  again: "Call again",
  endedBye: "Call ended. Thank you.",
  ended: "Call ended.",
  ready: "Press the button and speak normally, or tap a question below.",
  noLoad: "The call could not load. Reload the page.",
  connecting: "Connecting…",
  live: "Live. Speak whenever you like, or tap a question.",
  error: "Error: ",
  mic: "The call needs your microphone.",
};

/** an English clinic's call page (the Irish demo): one button, and the questions callers are likely to ask, each one tap. */
function clinicPageEn(c: Clinic, o: { ring?: boolean } = {}): string {
  const s = c.sales;
  const who = c.receptionist ?? "Reception";
  const days = WEEKDAYS.slice(1).concat(WEEKDAYS[0]).filter((d) => (c.hours[d] ?? []).length);
  const title = s ? `Hear ${who} answer · ${s.company}` : `${c.clinic} · Call reception`;
  return `<!doctype html>
<html lang="en-IE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
${PAGE_CSS}
.asks{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:8px;margin:0;padding:0;list-style:none}
.asks button{width:100%;text-align:left;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:15px/1.4 Inter,system-ui,sans-serif;cursor:pointer}
.asks button:hover{border-color:var(--green)}
.asks button:focus-visible,#call:focus-visible,#hang:focus-visible{outline:2px solid var(--green);outline-offset:2px}
.asks b{display:block;font-size:13px;font-weight:600;color:var(--green);margin-bottom:2px}
</style></head><body><main>
<span class="tag">${s ? `Live demo · ${esc(s.company)}` : esc(c.city)}</span>
<h1>${s ? `Ring ${esc(c.clinic)} and hear ${esc(who)} answer` : esc(c.clinic)}</h1>
<p class="punch">${s ? `${esc(who)} is the AI receptionist on this made-up Irish practice's phone line. Ask what your patients ask, the way they ask it.` : `Call reception: ${esc(who)} answers, books and passes on what needs a person.`}</p>
<div class="flow" aria-hidden="true">${["A patient rings", `${who} answers`, "Booked, noted or put through"].map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>
<button id="call" data-testid="call-start" disabled>${o.ring ? "Answer" : `Call ${esc(who)}`}</button>
<button id="hang" data-testid="call-hangup">Hang up</button>
<p id="status" role="status">Getting the line ready…</p>
<ul id="lines" aria-live="polite"></ul>
<p id="trace" class="small" hidden><a data-testid="call-trace" href="#">Your call and what is still to do</a>: this page is yours alone, keep it.</p>
<section id="questions" data-testid="likely-questions"><h2>What callers to an Irish practice ask</h2>
<p class="small" style="margin:0 0 10px">Tap one to ask it on the call, or say it in your own words.</p>
<ul class="asks">${LIKELY_QUESTIONS_EN.map((q) => `<li><button type="button" data-ask="${esc(q.ask)}"><b>${esc(q.topic)}</b>${esc(q.ask)}</button></li>`).join("")}</ul>
</section>
${
  s
    ? `<section id="offer"><h2>What your clinic gets</h2>
<p>${esc(s.what)}</p>
<p class="price">${esc(s.price.replace(/,.*$/, ""))}</p>
<table>
<tr><td>Every call to your number, answered</td><td>${esc(s.price.replace(/,.*$/, ""))}</td></tr>
<tr><td>Free trial on your own number</td><td>${s.trialDays} days</td></tr>
<tr><td>Setting up</td><td>one 45 minute call</td></tr>
</table>
<p class="small">${esc(s.terms ?? "")} Ask ${esc(who)} to have the team ring you.</p></section>`
    : ""
}
<section id="clinic"><h2>The practice ${c.madeUp ? "(made up for the demo)" : ""}</h2>
<table>${days.map((d) => `<tr><td>${dayEn(d)}</td><td>${c.hours[d].map((r) => r.replace("-", "–")).join(", ")}</td></tr>`).join("")}</table>
<table style="margin-top:12px">${c.services.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.price)}</td></tr>`).join("")}</table>
</section>
<p class="small" style="margin-top:24px">${c.madeUp ? "Demo practice: patients, appointments and prices are made up. " : ""}You need a microphone. We keep the text of the call, never the audio. ${esc(who)} never rings anyone: it only answers.${s?.contact ? ` Questions: ${esc(s.contact)}.` : ""}</p>
</main>
${callScript(c.slug, "/calls", ["free_slots", "book_appointment", "book_follow_up", "file_ticket", "qualify_lead"], who, "", { ui: CALL_UI_EN })}</body></html>`;
}

/** the call page's words (Spanish by default; the Catalan intake page passes its own). */
export const CALL_UI_ES = {
  you: "Usted",
  failed: "No se pudo: ",
  again: "Llamar otra vez",
  endedBye: "Llamada terminada. Gracias.",
  ended: "Llamada terminada.",
  ready: "Pulse el botón y hable con normalidad.",
  noLoad: "No se pudo cargar la llamada. Recargue la página.",
  connecting: "Conectando…",
  live: "En línea. Hable cuando quiera.",
  error: "Error: ",
  mic: "Hace falta permiso para el micrófono.",
};
export type CallUi = typeof CALL_UI_ES;
export const CALL_UI_CA: CallUi = {
  you: "Vostè",
  failed: "No s'ha pogut: ",
  again: "Tornar a trucar",
  endedBye: "Trucada acabada. Gràcies.",
  ended: "Trucada acabada.",
  ready: "Premi el botó i parli amb normalitat.",
  noLoad: "No s'ha pogut carregar la trucada. Torni a carregar la pàgina.",
  connecting: "Connectant…",
  live: "En línia. Parli quan vulgui.",
  error: "Error: ",
  mic: "Cal permís per al micròfon.",
};
/** the config's weekday keys as Catalan names, for a Catalan clinic's page. */
const DAYS_CA_OF: Record<string, string> = { lunes: "Dilluns", martes: "Dimarts", miércoles: "Dimecres", jueves: "Dijous", viernes: "Divendres", sábado: "Dissabte", domingo: "Diumenge" };

/** the page's call script: one button, a signed link from \`start\`, the agent's client tools answered by the console.
 * A tool answer carrying `link` (the Catalan intake's written agent) shows it in the page's #made box. */
export function callScript(slug: string, start: string, tools: string[], voice: string, code = "", o: { base?: string; ui?: CallUi } = {}): string {
  const ui = o.ui ?? CALL_UI_ES;
  return `<script type="module">
const SLUG = ${JSON.stringify(slug)};
const CODE = ${JSON.stringify(code)} || new URLSearchParams(location.search).get("c") || "";
const INVITE = new URLSearchParams(location.search).get("i") || "";
const UI = ${JSON.stringify(ui)};
const base = ${JSON.stringify(o.base ?? "/api/public/clinic/")} + SLUG;
const $ = (id) => document.getElementById(id);
const START = ${JSON.stringify(start)};
const btn = $("call"), hang = $("hang"), status = $("status"), list = $("lines");
let conv = null, callId = null, traceUrl = null, lines = [], ended = false;
const say = (t) => (status.textContent = t);
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error?.message || "Error " + r.status); return j; });
const add = (who, text) => { lines.push({ who, text }); const li = document.createElement("li"); li.className = who; li.innerHTML = "<b></b>"; li.firstChild.textContent = who === "voice" ? ${JSON.stringify(voice)} : UI.you; li.append(text); list.append(li); li.scrollIntoView({ block: "nearest" }); };
const made = (l) => { const m = $("made"); if (!m || !l) return; const a = m.querySelector("a"); a.href = l; m.hidden = false; };
const tool = (name) => async (args) => { try { const j = await post("/calls/" + callId + "/tool", { name, args }); made(j.link); return j.result; } catch (e) { return UI.failed + e.message; } };
function finish(reason) {
  if (ended) return; ended = true;
  if (callId) navigator.sendBeacon(base + "/calls/" + callId + "/end", JSON.stringify({ reason, transcript: lines }));
  hang.style.display = "none"; btn.style.display = "block"; btn.disabled = false; btn.textContent = UI.again;
  if (traceUrl) { const t = $("trace"); t.querySelector("a").href = traceUrl; t.hidden = false; }
  say(reason === "bye" ? UI.endedBye : UI.ended);
}
let Conversation = null;
import(${JSON.stringify(ELEVEN_CLIENT_URL)}).then((m) => { Conversation = m.Conversation; btn.disabled = false; say(UI.ready); }).catch(() => say(UI.noLoad));
btn.onclick = async () => {
  btn.disabled = true; ended = false; lines = []; list.textContent = ""; say(UI.connecting);
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
    const s = await post(START, Object.assign({}, CODE ? { code: CODE } : {}, INVITE ? { invite: INVITE } : {}));
    callId = s.call; traceUrl = s.trace || null; $("trace").hidden = true;
    conv = await Conversation.startSession({
      signedUrl: s.signedUrl,
      connectionType: "websocket",
      clientTools: Object.fromEntries(${JSON.stringify(tools)}.map((n) => [n, tool(n)])),
      onConnect: () => { btn.style.display = "none"; hang.style.display = "block"; say(UI.live); },
      onMessage: (m) => { const t = (m.message || "").replace(/\\[[a-z ]{2,20}\\]\\s*/g, "").trim(); if (t.replace(/[.\\s…]/g, "") && !(m.role === "user" && lines.length && lines[lines.length - 1].who === "caller" && lines[lines.length - 1].text === t)) add(m.role === "user" ? "caller" : "voice", t); if (m.role !== "user" && queued) { const q = queued; queued = ""; setTimeout(() => ask(q), 400); } },
      onDisconnect: (d) => finish(d && d.reason === "agent" ? "bye" : d && d.reason === "user" ? "hangup" : "line_dropped"),
      onError: (m) => say(UI.error + m),
    });
  } catch (e) { say(e.message && /Permission|NotAllowed/i.test(e.name + e.message) ? UI.mic : e.message); btn.disabled = false; }
};
hang.onclick = () => { if (conv) conv.endSession().catch(() => {}); finish("hangup"); };
// a likely question tapped (the English demo page): asked on the live call, or the call starts and it is asked after the greeting
let queued = "";
function ask(q) { if (conv && !ended && hang.style.display === "block") { try { conv.sendUserMessage(q); add("caller", q); } catch (e) { say(UI.error + e.message); } } else { queued = q; if (!btn.disabled) btn.click(); } }
document.querySelectorAll("[data-ask]").forEach((b) => (b.onclick = () => ask(b.dataset.ask)));
addEventListener("pagehide", () => { if (conv && !ended) { conv.endSession().catch(() => {}); finish("left"); } });
</script>`;
}

/** the clinic's private set-up page (clinicSetup.ts): one button to the set-up assistant, and what its file holds now. */
function setupPage(c: Clinic, k: string): string {
  const who = c.receptionist ?? "su recepcionista";
  const have = c.objectives ?? [];
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(`Puesta en marcha · ${c.clinic}`)}</title>
<style>
${PAGE_CSS}
ol.obj{margin:0;padding-left:20px}ol.obj li{margin:0 0 8px}
</style></head><body><main>
<span class="tag">Puesta en marcha · solo para su clínica</span>
<h1>${esc(c.clinic)}: diez minutos para poner en marcha a ${esc(who)}</h1>
<p class="punch">Una llamada: le contamos cómo trabaja, usted dice qué quiere conseguir con ella y vemos qué falta conectar. Lo que acuerden queda escrito en la ficha de su clínica.</p>
<div class="flow" aria-hidden="true">${["Aprender", "Sus objetivos", "Conectar"].map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>
<button id="call" data-testid="call-start" disabled>Empezar la puesta en marcha</button>
<button id="hang" data-testid="call-hangup">Colgar</button>
<p id="status" role="status">Preparando la línea…</p>
<ul id="lines" aria-live="polite"></ul>
<p id="trace" class="small" hidden><a data-testid="call-trace" href="#">Su llamada y lo que queda pendiente</a>: esta página es solo suya, guárdela.</p>
<section id="objectives" data-testid="setup-objectives"><h2>Sus objetivos para ${esc(who)}</h2>
${
  have.length
    ? `<ol class="obj">${have.map((o) => `<li>${esc(sayObjective(o))}</li>`).join("")}</ol><p class="small">Escritos en su llamada de puesta en marcha${c.objectivesAt ? ` del ${esc(c.objectivesAt.slice(0, 10))}` : ""}. Llame otra vez para cambiarlos.</p>`
    : `<p class="small">Aún ninguno: los apunta la llamada.</p>`
}
</section>
<p class="small" style="margin-top:24px">${c.madeUp ? "Clínica de demostración, inventada. " : ""}Necesita micrófono. No guardamos el audio, solo el texto de la llamada. Este enlace es solo para su clínica: no lo comparta.</p>
</main>
${callScript(c.slug, `/setup/calls?k=${encodeURIComponent(k)}`, ["add_objective", "confirm_objectives", "file_ticket"], "Asistente")}</body></html>`;
}
