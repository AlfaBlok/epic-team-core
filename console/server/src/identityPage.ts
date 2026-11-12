import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { identity, NEUTRAL_SITES, sites, type Identity, type Sites } from "./identity.js";

/**
 * The web client's identity (open core): the app page carries the owner's name, the home world, the home repo, the
 * two host ids, the memory service's name, the social world and the ops repo in a small script before the bundle, so its first paint already names them (web/src/lib/identity.ts reads it). The open
 * core's neutral defaults hold when the page is served without it (the dev server).
 */
export function identityScript(id: Identity = identity(), s: Sites = sites()): string {
  // the sites the web client links to (web lib/identity.ts sites()): its two skins, the customer sites, the Mac list
  const webSites = { teamUrl: s.teamUrl, socialUrl: s.socialUrl, customerHosts: process.env.CONSOLE_CUSTOMER_HOSTS ?? s.customerHosts, socialMovedTo: process.env.CONSOLE_SOCIAL_MOVED_TO ?? s.socialMovedTo, macListUrl: s.macListUrl, bookQuestionsUrl: s.bookQuestionsUrl };
  // JSON in a script element: escape what could end it or start a comment, and the two line separators JSON allows
  const json = JSON.stringify({ owner: id.owner, homeWorld: id.homeWorld, homeRepo: id.homeRepo, mainHost: id.mainHost, workerHost: id.workerHost, memory: id.memory, socialWorld: id.socialWorld, opsRepo: id.opsRepo, org: id.org, socialProduct: id.socialProduct, deployer: id.deployer, sites: webSites })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script>window.__IDENTITY__=${json}</script>`;
}

/** the page as built names the neutral team address in its link-preview tags (web/index.html); served, it names this console's */
export function withOrigin(html: string, origin: string = sites().teamUrl): string {
  return origin === NEUTRAL_SITES.teamUrl ? html : html.split(`${NEUTRAL_SITES.teamUrl}/`).join(`${origin}/`);
}

/** the page with the identity script as the first thing in its head (or at the very top when it has no head), and this console's address */
export function withIdentity(html: string, id: Identity = identity()): string {
  if (html.includes("window.__IDENTITY__=")) return html;
  html = withOrigin(html);
  const m = /<head[^>]*>/i.exec(html);
  const script = identityScript(id);
  return m ? html.slice(0, m.index + m[0].length) + script + html.slice(m.index + m[0].length) : script + html;
}

type Served = { raw: Buffer; gzip?: Buffer; etag: string };
const made = new Map<string, Served>();

const withOriginMade = new Map<string, Served>();

/** a static file that names the neutral team address (web/public/steps-kit.js's voice page), with this console's written in */
export function originFile(f: { raw: Buffer; etag: string }, origin: string = sites().teamUrl): Served {
  if (origin === NEUTRAL_SITES.teamUrl) return f;
  const key = `${f.etag}\0${origin}`;
  const have = withOriginMade.get(key);
  if (have) return have;
  const raw = Buffer.from(withOrigin(f.raw.toString("utf8"), origin));
  const out = { raw, ...(raw.length > 1024 ? { gzip: zlib.gzipSync(raw, { level: 6 }) } : {}), etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"` };
  withOriginMade.clear();
  withOriginMade.set(key, out);
  return out;
}

/** index.html with the identity script, made once per index version and identity (same caching as the file) */
export function identityIndex(f: { raw: Buffer; etag: string }, id: Identity = identity()): Served {
  const key = `${f.etag}\0${JSON.stringify(id)}\0${JSON.stringify(sites())}`;
  const have = made.get(key);
  if (have) return have;
  const raw = Buffer.from(withIdentity(f.raw.toString("utf8"), id));
  const out = { raw, ...(raw.length > 1024 ? { gzip: zlib.gzipSync(raw, { level: 6 }) } : {}), etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"` };
  made.clear();
  made.set(key, out);
  return out;
}
