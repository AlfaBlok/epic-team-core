import { useEffect, useState } from "react";

/**
 * while a new workspace's onboarding call leads Home (one button first), the other first-screen asks (pay, connect GitHub)
 * wait under it. A tiny store, so the menu's pay note reads it without loading the call code.
 */
let leads = false;
const subs = new Set<(v: boolean) => void>();
export const setOnboardingLeads = (v: boolean) => {
  if (leads === v) return;
  leads = v;
  for (const f of subs) f(v);
};
export function useOnboardingLeads(): boolean {
  const [v, setV] = useState(leads);
  useEffect(() => {
    subs.add(setV);
    setV(leads);
    return () => void subs.delete(setV);
  }, []);
  return v;
}
