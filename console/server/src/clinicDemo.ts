import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "./db.js";
import { clientAddress } from "./clientAddress.js";
import { agentBody, elevenCalls, type ElevenCalls } from "./voice/elevenAgent.js";
import { VoiceError } from "./voice/voice.js";

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
}

const slugRe = /^[a-z0-9][a-z0-9-]{1,40}$/;
const range = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/);
const clinicIn = z.object({
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
export function parseDay(said: string, now: number): string | undefined {
  const t = plain(said);
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

function sayDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
}

// ---------- the agent ----------

export const clinicAgentName = (c: Clinic) => `Recepcionista · ${c.clinic} (${c.slug})`;

export function clinicGreeting(c: Clinic): string {
  if (c.greeting) return c.greeting;
  const who = c.receptionist ?? "la recepcionista";
  if (c.sales)
    return `Hola, gracias por llamar a ${c.clinic}, una clínica de demostración de ${c.sales.company}. Soy ${who}, la recepcionista por voz. ¿Llama como paciente para pedir cita, o quiere saber cómo funcionaría en su clínica?`;
  return `Hola, ${c.clinic}, le atiende ${who}. ¿En qué le puedo ayudar?`;
}

/** the receptionist's instructions, in Spanish, made from the clinic's config only. */
export function clinicPrompt(c: Clinic): string {
  const who = c.receptionist ?? "la recepcionista";
  const hours = WEEKDAYS.slice(1)
    .concat(WEEKDAYS[0])
    .map((d) => `- ${d}: ${(c.hours[d] ?? []).length ? c.hours[d].map((r) => r.replace("-", " a ")).join(" y ") : "cerrado"}`)
    .join("\n");
  const services = c.services.map((s) => `- ${s.name}: ${s.price}${s.minutes ? ` (${s.minutes} minutos)` : ""}`).join("\n");
  const out = [
    `Eres ${who}, la recepcionista por voz de ${c.clinic}, una clínica dental en ${c.city}${c.address ? ` (${c.address})` : ""}. Hablas español de España, con frases cortas, cálida y profesional. Tratas siempre de usted. Si te hablan en inglés, contestas en inglés.`,
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
    );
  }
  out.push(
    "",
    "# Cómo hablas",
    "Una o dos frases por turno. No leas listas largas ni números largos. Nunca interrumpas.",
    "Cuando la persona se despide (adiós, gracias, eso es todo), despídete en una frase y llama a end_call, aunque falte algún dato: nunca la retengas.",
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export const CLINIC_TOOLS = (c: Clinic) => [
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
      ]
    : []),
];

/** the agent as made on the account: Spanish, multilingual voice, end_call only on a goodbye, a short call, no
 * overrides (the public page can never change what it says) and signed links only. */
export function clinicAgentBody(c: Clinic) {
  return (prompt: string, firstMessage: string, tools: Parameters<typeof agentBody>[2], name?: string, tags?: string[]) => {
    const b = agentBody(prompt, firstMessage, tools, name, tags, "es");
    const agent = b.conversation_config.agent;
    agent.prompt.tools = agent.prompt.tools.map((t: any) =>
      t.type === "system" ? { ...t, description: "Termina la llamada cuando la persona se despide, después de una despedida corta." } : { ...t, response_timeout_secs: 20 },
    ) as typeof agent.prompt.tools;
    return {
      ...b,
      conversation_config: {
        ...b.conversation_config,
        tts: { ...b.conversation_config.tts, ...(c.voiceId ? { voice_id: c.voiceId } : {}) },
        conversation: { max_duration_seconds: CLINIC_CALL_MAX_S },
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
  `);
}

export function createClinicDemo(d: ClinicDeps) {
  const { db } = d;
  ensureClinicTables(db);
  const now = d.now ?? Date.now;
  const doors = new Map<string, ElevenCalls>();
  const door = (c: Clinic) => {
    let x = doors.get(c.slug);
    if (!x) {
      const k = `eleven_clinic_${c.slug}_agent_id`;
      x =
        d.eleven?.(c) ??
        elevenCalls({
          name: clinicAgentName(c),
          tags: ["clinic-receptionist", c.slug],
          key: d.key,
          prompt: () => clinicPrompt(c),
          firstMessage: () => clinicGreeting(c),
          tools: () => CLINIC_TOOLS(c) as any,
          body: clinicAgentBody(c),
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, id),
          },
        });
      doors.set(c.slug, x);
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
    if (!r || r.ended_at || now() - Date.parse(r.started_at) > CALL_LIVE_MS) throw new VoiceError(404, "no_call", "Esta llamada ya terminó.");
    return r;
  };
  const taken = (slug: string, date: string) => new Set((db.prepare("SELECT time FROM clinic_bookings WHERE slug = ? AND kind = 'appointment' AND date = ?").all(slug, date) as { time: string }[]).map((r) => r.time));

  return {
    clinic,
    list: () => [...d.clinics().values()],
    /** the page opened: the next call's link is made now (one per clinic, kept 10 minutes). */
    warm(slug: string) {
      void door(clinic(slug)).warm?.("es");
    },
    async start(slug: string, addr: string) {
      const c = clinic(slug);
      const v = visitorHash(addr);
      const hourAgo = new Date(now() - 3_600_000).toISOString();
      const dayAgo = new Date(now() - 86_400_000).toISOString();
      const mine = (db.prepare("SELECT COUNT(*) n FROM clinic_calls WHERE visitor = ? AND started_at > ?").get(v, hourAgo) as { n: number }).n;
      if (mine >= CLINIC_STARTS_PER_HOUR) throw new VoiceError(409, "too_many", "Ha hecho varias llamadas seguidas. Vuelva a probar dentro de una hora.");
      const all = (db.prepare("SELECT COUNT(*) n FROM clinic_calls WHERE slug = ? AND started_at > ?").get(slug, dayAgo) as { n: number }).n;
      if (all >= (c.callsPerDay ?? 40)) throw new VoiceError(409, "day_full", "La demo ya ha atendido todas las llamadas de hoy. Vuelva a probar mañana.");
      const link = await door(c).link("es");
      const id = `cc_${crypto.randomBytes(12).toString("hex")}`;
      db.prepare("INSERT INTO clinic_calls (id, slug, started_at, visitor) VALUES (?, ?, ?, ?)").run(id, slug, iso(), v);
      return { call: id, signedUrl: link.signedUrl };
    },
    tool(slug: string, id: string, name: string, args: Record<string, unknown>): { result: string } {
      const c = clinic(slug);
      const r = liveCall(slug, id);
      if (r.tools >= TOOLS_PER_CALL) return { result: "No puedo hacer más gestiones en esta llamada de demostración." };
      db.prepare("UPDATE clinic_calls SET tools = tools + 1 WHERE id = ?").run(id);
      const s = (k: string) => String(args[k] ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const booked = () => (db.prepare("SELECT COUNT(*) n FROM clinic_bookings WHERE call_id = ?").get(id) as { n: number }).n;
      if (name === "free_slots") {
        const date = parseDay(s("day"), now());
        if (!date) return { result: `No he entendido el día "${s("day")}". Pide el día de la semana o la fecha.` };
        if (date < madridToday(now()).iso) return { result: "Ese día ya ha pasado. Pide otro día." };
        let slots = freeSlots(c, date, taken(slug, date), now());
        const part = plain(s("part"));
        if (/tarde/.test(part)) slots = slots.filter((h) => h >= "14:00");
        else if (/manana/.test(part)) slots = slots.filter((h) => h < "14:00");
        if (!(c.hours[WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]] ?? []).length) return { result: `El ${sayDate(date)} (${date}) la clínica está cerrada.` };
        if (!slots.length) return { result: `El ${sayDate(date)} (${date}) no queda ninguna hora libre${part ? ` por la ${part}` : ""}. Ofrece otro día.` };
        return { result: `${sayDate(date)} (${date}): horas libres ${slots.slice(0, 3).join(", ")}. Ofrece estas.` };
      }
      if (name === "book_appointment") {
        if (booked() >= BOOKINGS_PER_CALL) return { result: "En una llamada de demostración se reservan como mucho tres citas." };
        const date = /^\d{4}-\d{2}-\d{2}$/.test(s("date")) ? s("date") : parseDay(s("date"), now());
        const time = (s("time").match(/^(\d{1,2})[:.h ]?(\d{2})?/) ?? []).slice(1);
        const hm = time[0] ? `${time[0].padStart(2, "0")}:${time[1] ?? "00"}` : "";
        if (!date || !hm || !s("name")) return { result: "Faltan el nombre, la fecha o la hora. Pídelos y vuelve a llamar a book_appointment." };
        if (!freeSlots(c, date, taken(slug, date), now()).includes(hm)) return { result: `Las ${hm} del ${sayDate(date)} no están libres. Llama a free_slots y ofrece otra hora.` };
        db.prepare("INSERT INTO clinic_bookings (id, call_id, slug, kind, date, time, data, at) VALUES (?, ?, ?, 'appointment', ?, ?, ?, ?)").run(
          `cb_${crypto.randomBytes(6).toString("hex")}`,
          id,
          slug,
          date,
          hm,
          JSON.stringify({ name: s("name"), service: s("service") }),
          iso(),
        );
        return { result: `Reservado: ${s("service") || "cita"} para ${s("name")}, el ${sayDate(date)} a las ${hm}. Confírmalo en una frase.` };
      }
      if (name === "book_follow_up" && c.sales) {
        if (booked() >= BOOKINGS_PER_CALL) return { result: "Ya está apuntado. Confírmalo y despídete." };
        if (!s("name") || !s("contact")) return { result: "Faltan su nombre o un teléfono o email. Pídelos." };
        db.prepare("INSERT INTO clinic_bookings (id, call_id, slug, kind, data, at) VALUES (?, ?, ?, 'follow_up', ?, ?)").run(
          `cb_${crypto.randomBytes(6).toString("hex")}`,
          id,
          slug,
          JSON.stringify({ name: s("name"), clinic: s("clinic"), contact: s("contact"), when: s("when") }),
          iso(),
        );
        return { result: `Apuntado: el equipo de ${c.sales.company} llamará a ${s("name")} (${s("clinic")})${s("when") ? `, ${s("when")}` : ""}. Confírmalo en una frase.` };
      }
      return { result: `No conozco la herramienta ${name}.` };
    },
    end(slug: string, id: string, b: { reason?: string; transcript?: { who: string; text: string }[] }) {
      const r = db.prepare("SELECT * FROM clinic_calls WHERE id = ? AND slug = ?").get(id, slug) as any;
      if (!r) throw new VoiceError(404, "no_call", "No existe esa llamada.");
      if (r.ended_at) return { ended: true };
      const t = (b.transcript ?? []).slice(0, 200).map((l) => ({ who: l.who === "voice" ? "voice" : "caller", text: l.text.slice(0, 1000) }));
      db.prepare("UPDATE clinic_calls SET ended_at = ?, reason = ?, transcript = ? WHERE id = ?").run(iso(), (b.reason ?? "ended").slice(0, 40), JSON.stringify(t), id);
      return { ended: true };
    },
    /** the owner's view: the calls with their text and bookings, newest first. */
    calls(limit = 50) {
      const rows = db.prepare("SELECT * FROM clinic_calls ORDER BY started_at DESC LIMIT ?").all(Math.min(limit, 200)) as any[];
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        reason: r.reason,
        transcript: r.transcript ? JSON.parse(r.transcript) : [],
        bookings: (db.prepare("SELECT kind, date, time, data, at FROM clinic_bookings WHERE call_id = ? ORDER BY at").all(r.id) as any[]).map((b) => ({ ...b, data: JSON.parse(b.data) })),
      }));
    },
  };
}
export type ClinicDemo = ReturnType<typeof createClinicDemo>;

// ---------- routes ----------

const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;
const toolIn = z.object({ name: z.string().min(1).max(40), args: z.record(z.unknown()).optional() });
const endIn = z.object({ reason: z.string().max(40).optional(), transcript: z.array(z.object({ who: z.string().max(10), text: z.string().max(4000) })).max(400).optional() });

/** GET /api/public/clinic/<slug> (the page), its call routes (open, routeScope.ts), and the owner's GET /api/clinic-demo/calls. */
export function mountClinicDemo(api: Hono, demo: ClinicDemo) {
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
      demo.warm(slug);
      c.header("referrer-policy", "no-referrer");
      return c.html(clinicPage(cl));
    }),
  );
  api.post(
    "/public/clinic/:slug/calls",
    pub(async (c, slug) => c.json(await demo.start(slug, clientAddress(peerOf(c), (h) => c.req.header(h))), 201)),
  );
  api.post(
    "/public/clinic/:slug/calls/:cid/tool",
    pub(async (c, slug) => {
      const p = toolIn.safeParse(await body(c));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "name and args" } }, 400);
      return c.json(demo.tool(slug, c.req.param("cid") ?? "", p.data.name, p.data.args ?? {}));
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
  api.get("/clinic-demo/calls", (c) => c.json({ clinics: demo.list().map((x) => ({ slug: x.slug, clinic: x.clinic, sales: !!x.sales })), calls: demo.calls(Number(c.req.query("limit")) || 50) }));
}

// ---------- the page ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
/** the ElevenLabs browser client, pinned (the console's web app uses the same version). */
const ELEVEN_CLIENT = { pkg: "@elevenlabs/client", version: "1.36.1" };
export const ELEVEN_CLIENT_URL = `https://cdn.jsdelivr.net/npm/${ELEVEN_CLIENT.pkg}@${ELEVEN_CLIENT.version}/+esm`;

export function clinicPage(c: Clinic): string {
  const s = c.sales;
  const days = WEEKDAYS.slice(1).concat(WEEKDAYS[0]).filter((d) => (c.hours[d] ?? []).length);
  const title = s ? `Pruebe la recepcionista por voz · ${s.company}` : `${c.clinic} · Llame a recepción`;
  const punch = s
    ? `Llame a nuestra recepcionista por voz: contesta, informa y reserva cita en español, a cualquier hora. Pregúntele también cuánto cuesta para su clínica.`
    : `Llame a la recepción de ${c.clinic}: le informa y le reserva cita, a cualquier hora.`;
  const flow = ["Alguien llama", `${c.receptionist ?? "La recepcionista"} contesta`, "Busca hora libre", "Cita reservada"];
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
@font-face{font-family:"Inter";font-weight:400;font-display:swap;src:url(/fonts/inter-400.woff2) format("woff2")}
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
</style></head><body><main>
<span class="tag">${s ? `Demo · ${esc(s.company)}` : esc(c.city)}</span>
<h1>${esc(c.clinic)}</h1>
<p class="punch">${esc(punch)}</p>
<div class="flow" aria-hidden="true">${flow.map((f) => `<span>${esc(f)}</span>`).join("<i>→</i>")}</div>
<button id="call" data-testid="call-start" disabled>Llamar a recepción</button>
<button id="hang" data-testid="call-hangup">Colgar</button>
<p id="status" role="status">Preparando la línea…</p>
<ul id="lines" aria-live="polite"></ul>
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
<table>${days.map((d) => `<tr><td>${d[0].toUpperCase()}${d.slice(1)}</td><td>${c.hours[d].map((r) => r.replace("-", "–")).join(", ")}</td></tr>`).join("")}</table>
<table style="margin-top:12px">${c.services.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.price)}</td></tr>`).join("")}</table>
</section>
<p class="small" style="margin-top:24px">${c.madeUp ? "Clínica de demostración: pacientes, citas y precios inventados. " : ""}Necesita micrófono. No guardamos el audio, solo el texto de la llamada. La recepcionista nunca llama a nadie: solo contesta.</p>
</main>
<script type="module">
const SLUG = ${JSON.stringify(c.slug)};
const base = "/api/public/clinic/" + SLUG;
const $ = (id) => document.getElementById(id);
const btn = $("call"), hang = $("hang"), status = $("status"), list = $("lines");
let conv = null, callId = null, lines = [], ended = false;
const say = (t) => (status.textContent = t);
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error?.message || "Error " + r.status); return j; });
const add = (who, text) => { lines.push({ who, text }); const li = document.createElement("li"); li.className = who; li.innerHTML = "<b></b>"; li.firstChild.textContent = who === "voice" ? "Recepción" : "Usted"; li.append(text); list.append(li); li.scrollIntoView({ block: "nearest" }); };
const tool = (name) => async (args) => { try { return (await post("/calls/" + callId + "/tool", { name, args })).result; } catch (e) { return "No se pudo: " + e.message; } };
function finish(reason) {
  if (ended) return; ended = true;
  if (callId) navigator.sendBeacon(base + "/calls/" + callId + "/end", JSON.stringify({ reason, transcript: lines }));
  hang.style.display = "none"; btn.style.display = "block"; btn.disabled = false; btn.textContent = "Llamar otra vez";
  say(reason === "bye" ? "Llamada terminada. Gracias." : "Llamada terminada.");
}
let Conversation = null;
import(${JSON.stringify(ELEVEN_CLIENT_URL)}).then((m) => { Conversation = m.Conversation; btn.disabled = false; say("Pulse el botón y hable con normalidad."); }).catch(() => say("No se pudo cargar la llamada. Recargue la página."));
btn.onclick = async () => {
  btn.disabled = true; ended = false; lines = []; list.textContent = ""; say("Conectando…");
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
    const s = await post("/calls");
    callId = s.call;
    conv = await Conversation.startSession({
      signedUrl: s.signedUrl,
      connectionType: "websocket",
      clientTools: { free_slots: tool("free_slots"), book_appointment: tool("book_appointment"), book_follow_up: tool("book_follow_up") },
      onConnect: () => { btn.style.display = "none"; hang.style.display = "block"; say("En línea. Hable cuando quiera."); },
      onMessage: (m) => { if (m.message && m.message.replace(/[.\\s…]/g, "")) add(m.role === "user" ? "caller" : "voice", m.message); },
      onDisconnect: (d) => finish(d && d.reason === "agent" ? "bye" : d && d.reason === "user" ? "hangup" : "line_dropped"),
      onError: (m) => say("Error: " + m),
    });
  } catch (e) { say(e.message && /Permission|NotAllowed/i.test(e.name + e.message) ? "Hace falta permiso para el micrófono." : e.message); btn.disabled = false; }
};
hang.onclick = () => { if (conv) conv.endSession().catch(() => {}); finish("hangup"); };
addEventListener("pagehide", () => { if (conv && !ended) { conv.endSession().catch(() => {}); finish("left"); } });
</script></body></html>`;
}
