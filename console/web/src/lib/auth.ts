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

/**
 * A row's sync state in the owner's words. Out of sync = what makes the browser service send a reminder: the
 * session reads dead, or the login (its login cookies, else the earliest cookie) runs out within 3 days. The line is
 * the reminder's own first words ("Out of sync: @SamNews, lives in profile example.com (ops@)."), so the
 * page shows its form before any login goes stale.
 */
export function syncState(
  site: { pattern: string; accounts?: string[]; profileLabel?: string; sourceProfile?: string; session?: string; loginCookie?: string; loginExpiry?: string; earliestExpiry?: string },
  now: Date = new Date(),
): { stale: boolean; line: string } {
  const exp = site.loginCookie ? site.loginExpiry : site.earliestExpiry;
  const stale = site.session === "dead" || ["soon", "expired"].includes(expiryState(exp, now));
  const who = site.accounts?.length ? site.accounts.map((a) => "@" + a.replace(/^@/, "")).join(", ") : site.pattern.replace(/^\*\./, "");
  const where = site.profileLabel ?? site.sourceProfile;
  return { stale, line: `${stale ? "Out of sync" : "In sync"}: ${who}${where ? `, lives in profile ${where}` : ""}.` };
}
