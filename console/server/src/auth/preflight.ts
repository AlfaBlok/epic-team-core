import type { DB } from "../db.js";
import { WORLD_WAKE_HOLD_CODE, type WorldWakeHold } from "../plug/hooks.js";
import { createAuth, SESSION_COOKIE, type AuthMode } from "./identity.js";
import { judge } from "./routeScope.js";
import { platformSession } from "./gate.js";

export interface Refusal {
  status: 401 | 403 | 404 | 409;
  code: string;
  message: string;
}

/**
 * what the console would answer a request before its handler acts: the auth gate's verdict (CONSOLE_AUTH, owner
 * powers) and the world wake gate on Run now / wake. Staging refuses whatever acts for real before the app sees it
 * (staging.ts STAGING_REFUSED); it asks this first, so a refusal there names the real reason (`owner_only`,
 * `world_needs_box`) instead of only `staging_no_act`. Undefined = the console would go on.
 */
export function createPreflight(db: DB, mode: AuthMode, worldHold: WorldWakeHold) {
  const auth = createAuth(db);
  return (req: Request, peer?: string): Refusal | undefined => {
    const url = new URL(req.url);
    const header = (n: string) => req.headers.get(n) ?? undefined;
    if (mode !== "off") {
      const cookie = (header("cookie") ?? "")
        .split(";")
        .map((p) => p.trim().split("="))
        .find(([k]) => k === SESSION_COOKIE)?.[1];
      const i = auth.resolve({ header, cookie: cookie ? decodeURIComponent(cookie) : undefined, peer });
      const v = judge(db, i.kind === "session" ? platformSession(i) : i, req.method, url.pathname); // as the gate sees it
      if (!v.allow) return { status: v.status, code: v.reason, message: v.message };
    }
    const wake = /^\/api\/assignments\/([^/]+)\/(run-now|wake)$/.exec(url.pathname);
    if (req.method === "POST" && wake) {
      let id = wake[1];
      try {
        id = decodeURIComponent(id);
      } catch {
        /* as given */
      }
      const row = db.prepare("SELECT m.tenant_id AS t FROM assignments a JOIN milestones m ON m.id = a.milestone_id WHERE a.id = ?").get(id) as { t: string } | undefined;
      const hold = row ? worldHold(row.t) : undefined;
      if (hold) return { status: 409, code: WORLD_WAKE_HOLD_CODE, message: hold };
    }
    return undefined;
  };
}
