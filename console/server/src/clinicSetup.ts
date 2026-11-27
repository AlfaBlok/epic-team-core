import crypto from "node:crypto";

/**
 * The set-up call (the owner's live call 27 Nov, call_065c7b6e: "que el operario sea capaz de entender cuáles son
 * los objetivos ... hay un set up donde la gente tiene que aprender y tiene que conectarse ... tenemos que pensar cómo
 * funciona"; and on the same engine's onboarding call: "it's just the beginning of something long").
 *
 *   the clinic's private set-up link ──▶ the set-up assistant (same engine, another skin of the clinic's agent)
 *        │
 *        ├─ 1 aprender:   what the receptionist does and never does, in two sentences
 *        ├─ 2 objetivos:  what the clinic wants from her, how it will know, by how much ── add_objective, one each
 *        │                said back, the owner's yes ── confirm_objectives ──▶ docs/clinics/<slug>.json
 *        │                                                         objectives + objectivesFromCall (the call id)
 *        └─ 3 conectar:   call forwarding and the agenda: what is left becomes a ticket on the clinic's task tree
 *
 * From then on the receptionist's own prompt carries the objectives (clinicPrompt), so every call is made with them in
 * mind. The link is the clinic's alone: an HMAC of its slug, handed out on the owner's signed-in view.
 */

export interface ClinicObjective {
  /** what the clinic wants from the receptionist, in the owner's words. */
  goal: string;
  /** how the clinic will know it worked. */
  measure?: string;
  /** the number or date it aims at, when the owner gave one. */
  target?: string;
}

/** objectives one set-up call may write. */
export const SETUP_OBJECTIVES_MAX = 5;
/** a set-up call lasts at most this long (the owner's onboarding words: ten minutes or so is a good start). */
export const CLINIC_SETUP_MAX_S = 15 * 60;
/** set-up calls a clinic may start in a day. */
export const SETUP_CALLS_PER_DAY = 10;

const one = (s: unknown, n: number) =>
  String(s ?? "")
    .replace(/[\r\n\t|`<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

/** an add_objective call's arguments, cleaned; undefined when it names no goal. */
export function objectiveIn(args: Record<string, unknown>): ClinicObjective | undefined {
  const goal = one(args.goal ?? args.objective, 200);
  if (goal.length < 3) return undefined;
  const measure = one(args.measure, 200);
  const target = one(args.target, 120);
  return { goal, ...(measure ? { measure } : {}), ...(target ? { target } : {}) };
}

/** the clinic file's text with this call's objectives written in (every other field kept as it was). */
export function withObjectives(cur: string, objectives: ClinicObjective[], call: string, at: string): string {
  const c = JSON.parse(cur) as Record<string, unknown>;
  c.objectives = objectives.slice(0, SETUP_OBJECTIVES_MAX);
  c.objectivesFromCall = call;
  c.objectivesAt = at;
  return `${JSON.stringify(c, null, 2)}\n`;
}

/** the clinic's own set-up key (the link's credential). */
export const setupKey = (secret: string, slug: string) => crypto.createHmac("sha256", secret).update(`setup|${slug}`).digest("hex").slice(0, 24);
export function validSetupKey(secret: string, slug: string, k: string): boolean {
  const want = Buffer.from(setupKey(secret, slug));
  const got = Buffer.from(String(k ?? ""));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export interface SetupClinic {
  slug: string;
  clinic: string;
  city: string;
  receptionist?: string;
  madeUp?: boolean;
  objectives?: ClinicObjective[];
  sales?: { company: string };
}

export const setupAgentName = (c: SetupClinic) => `Puesta en marcha · ${c.clinic} (${c.slug})`;

export function setupGreeting(c: SetupClinic): string {
  return `Hola, soy la asistente de puesta en marcha de ${c.clinic}. En unos diez minutos le cuento cómo trabaja ${c.receptionist ?? "su recepcionista"}, apuntamos qué quiere conseguir con ella y vemos qué falta conectar. Podemos tardar lo que usted quiera. ¿Empezamos?`;
}

const sayObjective = (o: ClinicObjective) => `${o.goal}${o.measure ? `; se mide por ${o.measure}` : ""}${o.target ? `; meta ${o.target}` : ""}`;

/** the set-up assistant's instructions, in Spanish, made from the clinic's config. */
export function setupPrompt(c: SetupClinic): string {
  const who = c.receptionist ?? "la recepcionista";
  return [
    "# Estilo: lo más importante en esta llamada",
    "- Cálida, tranquila y breve: una o dos frases por turno. Tratas de usted. Hablas español de España; si te hablan en inglés, contestas en inglés.",
    "- Una pregunta cada vez. Deja que termine; una pausa no es el final. Nunca interrumpas.",
    "- Nunca leas identificadores, enlaces ni números largos.",
    "",
    `Eres la asistente de puesta en marcha de ${c.clinic}${c.city ? ` (${c.city})` : ""}. Hablas con quien dirige la clínica. ${who} es su recepcionista por voz: contesta el teléfono cuando recepción no puede, informa de precios, horarios y seguros, reserva citas y apunta lo que no puede resolver. Esta llamada es el principio de una relación larga, no un formulario.`,
    c.madeUp ? "Esta clínica es una demostración inventada; si te lo preguntan, lo dices con naturalidad." : "",
    "",
    "# Tu trabajo, en tres partes y en este orden",
    `1. Aprender (un minuto): explica en dos frases qué hace ${who} y qué no hace nunca (no da consejo médico, no pide datos de pago ni de salud, nunca llama a nadie: solo contesta). Pregunta si tiene alguna duda.`,
    `2. Objetivos (lo principal): pregunta qué quiere conseguir la clínica con ${who}. Por ejemplo: no perder llamadas a la hora de comer, llenar los huecos de la agenda, más primeras visitas de un tratamiento, menos citas olvidadas. Para cada objetivo pregunta cómo sabrá que funciona y, si lo tiene, un número o una fecha. Llama a add_objective una vez por objetivo, con sus palabras, nunca con una idea tuya. Entre uno y ${SETUP_OBJECTIVES_MAX} objetivos; con dos o tres basta.`,
    `   Cuando no tenga más, léelos en una frase cada uno y pregunta: "¿Lo dejo así en la ficha de la clínica?". Solo con su sí, llama a confirm_objectives una vez y di la frase que devuelve. Si quiere cambiar uno, llama a add_objective con su número y el texto nuevo, y vuelve a leerlos.`,
    `3. Conectar: pregunta si ya tiene el desvío de llamadas a ${who} y qué programa usa para la agenda. Lo que falte (activar el desvío, conectar la agenda) lo apuntas con file_ticket, una cosa por ticket, con quién es "clínica", y dices la frase que devuelve. Nunca prometas que está conectado si no lo está.`,
    "",
    c.objectives?.length
      ? `# Objetivos que ya tiene la clínica (de una llamada anterior)\n${c.objectives.map((o, i) => `${i + 1}. ${sayObjective(o)}`).join("\n")}\nPregunta si siguen valiendo o si quiere cambiarlos; si los confirma igual, vuelve a apuntarlos con add_objective y confirm_objectives.`
      : "# La clínica aún no tiene objetivos: apuntarlos es el trabajo de esta llamada.",
    "",
    "Nunca prometas resultados ni cifras, ni precios distintos de los que ya conoce la clínica. Si pregunta algo que no sabes (protección de datos, integraciones), apúntalo con file_ticket.",
    "Cuando la persona se despide (adiós, gracias, eso es todo), despídete en una frase y llama a end_call. Nunca cuelgues por tu cuenta.",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export const SETUP_TOOLS = [
  {
    name: "add_objective",
    description: "Apunta un objetivo de la clínica para su recepcionista, con las palabras de quien llama. Una vez por objetivo; con number cambia uno ya apuntado.",
    parameters: {
      properties: {
        goal: { type: "string", description: "lo que la clínica quiere conseguir, en una frase corta y con sus palabras" },
        measure: { type: "string", description: "cómo sabrá que funciona (opcional)" },
        target: { type: "string", description: "el número o la fecha que quiere alcanzar, si lo dijo (opcional)" },
        number: { type: "string", description: "opcional: el número del objetivo que cambia (1, 2, 3…)" },
      },
      required: ["goal"],
    },
  },
  {
    name: "confirm_objectives",
    description: "Escribe en la ficha de la clínica los objetivos apuntados en esta llamada. Solo después de leerlos y de que la persona diga que sí.",
    parameters: { properties: { said_yes: { type: "string", description: "lo que dijo la persona al confirmarlos" } }, required: [] },
  },
  {
    name: "file_ticket",
    description: "Apunta en la lista de pendientes de la clínica algo que falta conectar o una pregunta que no sabes contestar. Devuelve la frase que debes decir.",
    parameters: {
      properties: {
        need: { type: "string", description: "lo que falta, en una frase (por ejemplo: activar el desvío de llamadas)" },
        who: { type: "string", description: "clínica" },
      },
      required: ["need"],
    },
  },
];

export { sayObjective };
