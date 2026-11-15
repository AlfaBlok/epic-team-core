import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TENANT } from "../db.js";
import { currentAuth, type AuthMode, type Identity } from "./identity.js";
import { homeRepo } from "../identity.js";

/**
 * with CONSOLE_AUTH=on, legacy trust (a loopback or tailnet caller with
 * no credential) is still the home world for the everyday routes (plan §2, D3: today's agents, the watchdog and the spines' curl
 * recipes), but no longer the platform owner. Owner powers (agent tokens, secret writes, service changes, world make and
 * remove, settings) need an owner login, or the HOST OWNER TOKEN: a random `ho_…` value the console makes at start in a
 * 0600 file only its own host user reads (CONSOLE_HOST_TOKEN_FILE, default ~/.config/the code repo/host-owner.token; staging
 * keeps its own under its root). The console's own callers send it as `Authorization: Bearer ho_…` (the Team desk's
 * recipes, check-curl.sh with CHECK_CURL_OWNER=1); the home world agent token (`at_…`) never has owner powers.
 */
export const HOST_TOKEN_PREFIX = "ho_";

export const defaultHostTokenFile = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) =>
  env.CONSOLE_HOST_TOKEN_FILE?.trim() || path.join(home, ".config", homeRepo(), "host-owner.token");

/** Read the host owner token, making it (0600, its directory 0700) when the file is missing or empty. */
export function ensureHostToken(file: string): string {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.startsWith(HOST_TOKEN_PREFIX) && t.length > 20) return t;
  } catch {
    /* missing: made below */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const t = `${HOST_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${t}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return t;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();
let hostHash: Buffer | undefined;
/** Set (or clear) the token this process accepts; index.ts sets it at start, tests set their own. */
export function setHostToken(token: string | undefined): void {
  hostHash = token ? sha(token) : undefined;
}
/** Constant-time check of a presented `ho_…` bearer against this process's host owner token. */
export function isHostToken(raw: string): boolean {
  return !!hostHash && raw.startsWith(HOST_TOKEN_PREFIX) && crypto.timingSafeEqual(sha(raw), hostHash);
}

/**
 * Owner powers for this identity under `mode`. Auth off (or no request context): today's console, every caller. A login
 * needs the owner role (its world's handlers keep it to that world); legacy trust needs the host owner token under `on`
 * (shadow judges like on and logs, but keeps today's answer); an agent token never.
 */
export function hasOwnerPower(i: Identity | undefined, mode: AuthMode | undefined): boolean {
  if (!i || !mode || mode === "off") return true;
  if (i.kind === "session") return i.role === "owner" && !i.door;
  if (i.kind === "legacy") return !!i.host || mode !== "on";
  return false;
}

/** this request comes through the door (a login let into the home world on a customer site): a customer's view, never the platform's. */
export function doorSession(): boolean {
  const i = currentAuth()?.identity;
  return i?.kind === "session" && !!i.door;
}

/** The platform owner for the current request: the home world's owner login or its console host (host owner token). */
export function platformOwner(): boolean {
  const a = currentAuth();
  if (!a) return true; // auth off: today's console, every caller is the platform
  const i = a.identity;
  if (i.kind === "session" && i.door) return false; // the door is a customer's way in, never the platform's
  return "tenant" in i && i.tenant === DEFAULT_TENANT && hasOwnerPower(i, a.mode);
}
