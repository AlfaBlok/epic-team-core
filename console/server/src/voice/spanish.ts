import { ownerName, socialProduct } from "../identity.js";

/**
 * A call in Spanish (the owner on call_f5516a60, 26 Nov: "dile al equipo si es posible seleccionar español ...
 * estaría bueno si cuando sale ya la llamada puedo escoger el idioma"). He picks Español on the call screen; the call then
 * runs on its Spanish agent (a native Spain-Spanish voice, elevenAgent.ts), greets him in Spanish and is told, first in
 * its prompt and in Spanish, to speak Spanish from Spain. The facts, lookups and tools below it stay the same.
 *
 *   English greeting ──▶ spanishGreeting ──▶ the same greeting in Spanish (a known one), else "Hola …, ¿por dónde empezamos?"
 *   instructions     ──▶ spanishInstructions ──▶ the Spanish lead + the same instructions, its greeting line in Spanish
 */

/** each call's English greeting and its Spanish one (the greetings in coach, briefing, levelCall, marketing, teamStrategy, voice, inbox). */
const GREETINGS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^Hi (.+?), I'm the desk line\. How can I help\?$/, (m) => `Hola ${m[1]}, soy la línea del equipo. ¿En qué te ayudo?`],
  [/^Hi (.+?), objectives coach here\. Which objective do you want to work on\?$/, (m) => `Hola ${m[1]}, aquí tu coach de objetivos. ¿En qué objetivo quieres trabajar?`],
  [/^Hi (.+?), your objectives review\./, (m) => `Hola ${m[1]}, tu repaso de objetivos. Voy objetivo por objetivo, primero lo que está en rojo. ¿Empezamos?`],
  [/^Hi (.+?), your briefer for (.+?)\. Key results first, or straight to what is red\?$/, (m) => `Hola ${m[1]}, soy tu briefer de ${m[2]}. ¿Empezamos por los resultados clave o vamos directos a lo que está en rojo?`],
  [/^Hi (.+?), your (.+?) (?:briefer|partner) here\./, (m) => `Hola ${m[1]}, aquí tu briefer de ${m[2]}. ¿Quieres primero los números, posts, respuestas, mensajes y testers, o vamos directos al bloqueo número uno?`],
  [/^Hi (.+?), your (.+?) launch strategist here, on the (.+?) objective\./, (m) => `Hola ${m[1]}, aquí tu estratega de lanzamiento de ${m[2]}, en el objetivo ${m[3]}. ¿Por dónde seguimos?`],
  // a customer's onboarding call (onboarding.ts): never the owner's name in the fallback hello
  [/^Hi (.+?), I'm your (.+?) onboarding helper\. Do you have ten minutes or so\?/, (m) => `Hola ${m[1]}, soy tu asistente de bienvenida de ${m[2]}. ¿Tienes unos diez minutos? Podemos tomarnos el tiempo que quieras.`],
  [/^Hi (.+?), it's your (.+?) onboarding helper again\./, (m) => `Hola ${m[1]}, soy otra vez tu asistente de bienvenida de ${m[2]}. ¿Seguimos donde lo dejamos?`],
  [/^(.+): (\d+) cards?\. Shall we go through them one by one\?$/, (m) => `${m[1]}: ${m[2]} tarjeta${m[2] === "1" ? "" : "s"}. ¿Las repasamos una por una?`],
  [/^(.+) is clear: nothing waits there\. Anything else\?$/, (m) => `${m[1]} está al día: no hay nada pendiente ahí. ¿Algo más?`],
];

/** the call's first words in Spanish: a known greeting said the same way in Spanish, else a short Spanish hello. */
export function spanishGreeting(en: string | undefined): string {
  const t = (en ?? "").trim();
  for (const [re, es] of GREETINGS) {
    const m = re.exec(t);
    if (m) return es(m);
  }
  return `Hola ${ownerName()}, ¿por dónde empezamos?`;
}

/** the rule a Spanish call reads first: Spanish from Spain, the same facts and tools. */
export function spanishLead(): string {
  const n = ownerName();
  return [
    "# Idioma de esta llamada: español de España",
    `${n} ha elegido español para esta llamada. Habla siempre en español de España (castellano), tuteándole, natural y cercano, aunque las instrucciones y los datos de abajo estén en inglés.`,
    `Los datos, los números, las fechas, los nombres y las herramientas son los mismos: úsalos igual y dilos en español. Los nombres de productos (como ${socialProduct()}) no se traducen.`,
    `Si ${n} habla en inglés, sigue en español salvo que te pida cambiar. Lo que pases al equipo (relay_to_desk, ask_the_desk) lleva sus palabras tal cual las dijo.`,
  ].join("\n");
}

/** the call's instructions for a Spanish call: the Spanish lead first, then the same instructions with its greeting line in Spanish. */
export function spanishInstructions(instructions: string, en: string | undefined, es: string): string {
  const body = en ? instructions.split(`"${en}"`).join(`"${es}"`) : instructions;
  return `${spanishLead()}\n\n${body}`;
}
