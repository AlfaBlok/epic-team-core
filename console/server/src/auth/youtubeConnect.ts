/**
 * The YouTube Allow as one link on the owner's phone (no paste, no laptop step).
 *
 * The console's own Google sign-in client already lists this site's callback,
 * `https://<customer site>/api/access/oauth/google/callback`, so no Google setting changes:
 *
 *   GET /api/access/oauth/youtube/start    to Google's consent for the four YouTube scopes (offline, PKCE), state bound
 *                                          to this browser as a sign-in's is (auth/oauth.ts)
 *   (Google's callback, purpose youtube)   code to tokens; every scope granted; `channels.list mine` must be one of
 *                                          YOUTUBE_CONNECT_CHANNELS (else sites().youtubeChannels); then the three keys
 *                                          YOUTUBE_OAUTH_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN go into the console's
 *                                          store (the Secrets page path: an `[answered SK-<n>]` line, `secret put --stdin`),
 *                                          where the Team Browser's YouTube acts read them (browser/src/acts/youtube.ts)
 *   (purpose youtube-enable)               only when Google answers that the YouTube APIs are off in the client's project:
 *                                          one more Allow with `service.management`; the team switches on the YouTube Data
 *                                          and Analytics APIs in that project (the project number is the client id's
 *                                          prefix), takes that Allow back at once (revoke), and checks the channel again
 *   GET /api/access/oauth/youtube/finish?p= check again after a switch-on Google has not spread yet (10 minutes)
 *   GET /api/access/oauth/youtube/status   { ready, connected, channel, at } for the steps page (names only)
 *
 * No link token: a stranger's Allow is refused at the channel check (their grant is taken back, nothing stored), and
 * a stranger's switch-on Allow has no rights on the project. Tokens and keys are never logged, echoed or put in a page.
 */

import { sites } from "../identity.js";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
export const ENABLE_SCOPE = "https://www.googleapis.com/auth/service.management";
export const YOUTUBE_APIS = ["youtube.googleapis.com", "youtubeanalytics.googleapis.com"];
export const YOUTUBE_KEY_NAMES = { clientId: "YOUTUBE_OAUTH_CLIENT_ID", clientSecret: "YOUTUBE_OAUTH_CLIENT_SECRET", refreshToken: "YOUTUBE_OAUTH_REFRESH_TOKEN" } as const;

const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const CHANNELS = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

export const expectedChannels = (env: NodeJS.ProcessEnv = process.env) =>
  (env.YOUTUBE_CONNECT_CHANNELS ?? sites().youtubeChannels)
    .split(/[\s,]+/)
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);

/** The Google Cloud project number a web client belongs to: its id's leading digits (`<number>-<x>.apps.googleusercontent.com`). */
export const projectNumberOf = (clientId: string) => /^(\d{6,})-/.exec(clientId)?.[1];

export type StoreKey = (name: string, value: string, note: string) => Promise<{ ok: true } | { ok: false; message: string }>;

export interface Tokens {
  access: string;
  refresh?: string;
  scopes: string[];
}

export type ChannelAnswer = { kind: "ok"; handle: string; title: string } | { kind: "none" } | { kind: "api_off" } | { kind: "error"; status: number };

export function youtubeGoogle(http: typeof fetch) {
  const form = (b: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b) });
  return {
    async exchange(i: { code: string; clientId: string; clientSecret: string; redirect: string; verifier: string }): Promise<Tokens> {
      const r = await http(TOKEN, form({ code: i.code, client_id: i.clientId, client_secret: i.clientSecret, redirect_uri: i.redirect, grant_type: "authorization_code", code_verifier: i.verifier }));
      const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string };
      if (!r.ok || !j.access_token) throw new Error(`token ${r.status}`);
      return { access: j.access_token, ...(j.refresh_token ? { refresh: j.refresh_token } : {}), scopes: (j.scope ?? "").split(/\s+/).filter(Boolean) };
    },
    async refresh(i: { refresh: string; clientId: string; clientSecret: string }): Promise<string> {
      const r = await http(TOKEN, form({ refresh_token: i.refresh, client_id: i.clientId, client_secret: i.clientSecret, grant_type: "refresh_token" }));
      const j = (await r.json().catch(() => ({}))) as { access_token?: string };
      if (!r.ok || !j.access_token) throw new Error(`refresh ${r.status}`);
      return j.access_token;
    },
    async channel(access: string): Promise<ChannelAnswer> {
      const r = await http(CHANNELS, { headers: { authorization: `Bearer ${access}` } });
      const text = await r.text().catch(() => "");
      if (r.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/.test(text)) return { kind: "api_off" };
      if (!r.ok) return { kind: "error", status: r.status };
      let items: { snippet?: { customUrl?: string; title?: string } }[] = [];
      try {
        items = (JSON.parse(text) as { items?: typeof items }).items ?? [];
      } catch {
        return { kind: "error", status: r.status };
      }
      if (!items.length) return { kind: "none" };
      const s = items[0].snippet ?? {};
      return { kind: "ok", handle: (s.customUrl ?? "").replace(/^@/, "").toLowerCase(), title: s.title ?? "" };
    },
    /** Switch the YouTube APIs on in the project; true when Google took it (the operation may still be spreading). */
    async enable(access: string, projectNumber: string): Promise<{ ok: true } | { ok: false; status: number }> {
      const r = await http(`https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services:batchEnable`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({ serviceIds: YOUTUBE_APIS }),
      });
      await r.text().catch(() => "");
      return r.ok ? { ok: true } : { ok: false, status: r.status };
    },
    async revoke(token: string): Promise<void> {
      await http(REVOKE, form({ token })).then((r) => r.text()).catch(() => undefined);
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The page the phone lands on: one heading, one or two plain lines, at most one button. */
export function resultPage(o: { title: string; lines: string[]; button?: { href: string; label: string }; ok?: boolean }): string {
  const colour = o.ok ? "#1d6b46" : "#8a4b12";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;background:#f6f2ea;color:#1c1b19;margin:0;padding:32px 22px;max-width:560px}h1{font-size:24px;color:${colour};margin:0 0 14px}p{margin:0 0 12px}a.b{display:inline-block;margin-top:10px;padding:14px 22px;background:#1d6b46;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}</style></head>
<body><h1>${esc(o.title)}</h1>${o.lines.map((l) => `<p>${esc(l)}</p>`).join("")}${o.button ? `<a class="b" href="${esc(o.button.href)}">${esc(o.button.label)}</a>` : ""}</body></html>`;
}
