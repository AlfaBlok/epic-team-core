import { useEffect, useState } from "react";

/**
 * The call's language, picked on the call screen (the owner on call_f5516a60: "estaría bueno si cuando sale ya la
 * llamada puedo escoger el idioma"): English or Español, one tap, kept on this device. Every call start and the
 * page-open link (callApi.ts) send it; Spanish runs on the console's Spanish agent and a native Spain-Spanish voice.
 */
export type CallLang = "en" | "es";
const KEY = "call-lang";
let current: CallLang | undefined;
const subs = new Set<(l: CallLang) => void>();

export function getCallLang(): CallLang {
  if (current) return current;
  try {
    current = globalThis.localStorage?.getItem(KEY) === "es" ? "es" : "en";
  } catch {
    current = "en";
  }
  return current;
}

export function setCallLang(l: CallLang): void {
  current = l;
  try {
    globalThis.localStorage?.setItem(KEY, l);
  } catch {
    // a private window keeps it for this page only
  }
  for (const s of subs) s(l);
}

/** the picked language, following a pick made on any call screen of the page. */
export function useCallLang(): [CallLang, (l: CallLang) => void] {
  const [l, setL] = useState<CallLang>(getCallLang);
  useEffect(() => {
    subs.add(setL);
    setL(getCallLang());
    return () => void subs.delete(setL);
  }, []);
  return [l, setCallLang];
}
