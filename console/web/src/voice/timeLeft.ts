/**
 * The time left on a call, said out loud before its limit. One piece for every call kind (Partner, strategy,
 * briefer, onboarding, the inbox walk): the engine says these words by voice, on the OpenAI line and the ElevenLabs line
 * alike, in the call's language. The owner: "if the two-minute limit is approaching, you should
 * say it on the call" and "you should be telling me on the voice, not on the UX, because I'm not looking at the screen".
 *
 *   start ──── … ──── warn: "About two minutes left on this call …" ──── limit: the call ends
 *   quiet ──── … ──── warn: "Still there? I'll hang up in ten seconds." ──── quiet limit: the call ends
 */
import type { CallLang } from "./callLang";

const EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ES = ["cero", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];

/** a span as words: under a minute in seconds (rounded to 5), else whole minutes ("two minutes", "dos minutos"). */
export function spanWords(seconds: number, lang: CallLang = "en"): string {
  const s = Math.max(1, Math.round(seconds));
  const n = (k: number) => (k <= 10 ? (lang === "es" ? ES : EN)[k] : String(k));
  if (s < 60) {
    const k = s < 10 ? s : Math.round(s / 5) * 5;
    return lang === "es" ? `${k === 1 ? "un" : n(k)} segundo${k === 1 ? "" : "s"}` : `${n(k)} second${k === 1 ? "" : "s"}`;
  }
  const m = Math.round(s / 60);
  return lang === "es" ? `${n(m)} minuto${m === 1 ? "" : "s"}` : `${n(m)} minute${m === 1 ? "" : "s"}`;
}

/** what the voice says before the call's length limit. */
export function callLimitLine(secondsLeft: number, lang: CallLang = "en"): string {
  const t = spanWords(secondsLeft, lang);
  const one = /^un /.test(t);
  return lang === "es" ? `Aviso: ${one ? "queda" : "quedan"} ${t} de llamada. Luego puedes volver a llamar.` : `Heads up: about ${t} left on this call. You can call again after.`;
}

/** what the voice says before the quiet hang-up. */
export function quietLine(secondsLeft: number, lang: CallLang = "en"): string {
  const t = spanWords(secondsLeft, lang);
  return lang === "es" ? `¿Sigues ahí? Cuelgo en ${t}.` : `Still there? I'll hang up in ${t}.`;
}

/** the note a line's agent gets to say a time line word for word (the ElevenLabs line has no other way in). */
export const CLOCK_MARK = "[call clock]";
export const clockNote = (line: string) => `${CLOCK_MARK} A note from the call's clock, not from the caller: say exactly "${line}" and nothing else, then carry on where you were.`;
