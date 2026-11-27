import { useEffect, useState } from "react";

/** seconds since the call started connecting, so "Connecting… 4 s" shows it is moving, never stuck. */
export function useConnectingSeconds(phase: string): number {
  const connecting = phase === "starting" || phase === "connecting";
  const [since, setSince] = useState<number | undefined>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!connecting) return void setSince(undefined);
    setSince((s) => s ?? Date.now());
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [connecting]);
  return since === undefined ? 0 : Math.max(0, Math.floor((Date.now() - since) / 1000));
}
export const connectingText = (s: number) => (s > 0 ? `Connecting… ${s} s` : "Connecting…");

