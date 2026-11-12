/** Browser the console page runs in, from its user agent (Arc reports as Chrome; the sync script still finds Arc). */
export function detectBrowser(ua: string, isBrave = false): string {
  if (isBrave) return "brave";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "chrome";
}

export const BROWSERS = ["chrome", "arc", "brave", "edge", "firefox", "safari"] as const;

/** Site patterns typed by the owner: comma/space/newline separated, lowercased, deduped. */
export function parsePatterns(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export type ExpiryState = "none" | "ok" | "soon" | "expired";

/** "soon" = under 3 days left. */
export function expiryState(iso: string | undefined, now: Date = new Date()): ExpiryState {
  if (!iso) return "none";
  const left = new Date(iso).getTime() - now.getTime();
  if (left <= 0) return "expired";
  return left < 3 * 86_400_000 ? "soon" : "ok";
}
