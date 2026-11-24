/**
 * The key contract between core and the hosted secret store. Core answers a key ask and a steps
 * page's key box with these checks and types; where a key is stored is the hosted layer's (plug/hooks.ts `keys`).
 * The text below moved unchanged from inbox/secretPut.ts, secrets.ts and secrets/worlds.ts.
 */
export interface SecretPutInput {
  app: string;
  name: string;
  /** The answered ask's code: `secret` checks an `[answered <CODE> …]` line in `docsDir/*.md` before the app platform write. */
  approved: string;
  /** SECRET_DOCS_DIR for the tool: the folder of the spine that carries the ask (the tool reads `*.md` there, not below). */
  docsDir: string;
  value: string;
  /** also set it in the app's env on the app platform (deployerName()); default true (key asks always do). */
  deployed?: boolean;
  /** a whole key file (several lines, e.g. a JSON service-account key): `--multiline`, never with `--the app platform`. */
  multiline?: boolean;
  /** the vault save already ran and was read back (`saveFirst`): the store writes only its working copy. */
  vaultSaved?: string;
}

/** ok = stored (and set in the app platform); err = the tool's stderr tail (it never carries values; scrubbed anyway). */
export type SecretPutResult = { ok: true } | { ok: false; err: string };
export type SecretPut = (o: SecretPutInput) => Promise<SecretPutResult>;

/** `the app platform` = where the key went: false when the store-only fallback ran (or the app platform was not asked for). */
export type SecretStoreResult = { ok: true; deployed: boolean; vault?: string; mirrorErr?: string; noCopy?: boolean } | { ok: false; err: string };
/**
 * `vault`: the password manager the key went into first (identity `vault`); the secret store then holds only a working
 * copy. `mirrorErr`: that working copy could not be written (the key is saved in the vault all the same). `noCopy`: no
 * working copy was written at all (a test key lives only in the vault).
 */

export interface WorldKeys {
  backend(world: string): string;
  refuse(world: string, app: string): string | undefined;
  /** Store a pasted key in the world's backend; default world = today's `putWithFallback(secret put)` unchanged. */
  store(world: string, i: SecretPutInput): Promise<SecretStoreResult & { world?: boolean }>;
  /**
   * the owner's words: "it was supposed to make it into the vault, it didn't. But the card closed": save
   * the key in the owner's vault and read it back by name BEFORE the card is answered, so a card never closes on a key
   * that is not there. undefined: this world has no vault (the store is the only save); ok false: nothing saved, the
   * card stays open with why.
   */
  saveFirst?(world: string, i: { app: string; name: string; value: string; source: string }): Promise<{ ok: true; vault: string; where?: string; open?: string; at?: string } | { ok: false; err: string } | undefined>;
}

/** Remove the value (and any line that still holds it) from tool output before it is shown or stored. */
export const scrub = (text: string, value: string) => {
  if (!value) return text;
  let out = text.split(value).join("[redacted]");
  // a key file's pieces are secret too (a tool may quote one line of it, or the key inside a JSON string):
  // every line, and every piece between quotes or escaped line breaks, of 16 characters or more.
  if (/[\r\n]/.test(value))
    for (const l of [...new Set(value.split(/\r?\n|\\n|"/).map((x) => x.trim()).filter((x) => x.length >= 16))].sort((a, b) => b.length - a.length)) out = out.split(l).join("[redacted]");
  return out;
};

/** the largest key file a steps page's file box stores (a Google service-account key is about 2.4 KB). */
export const MAX_FILE = 64 * 1024;
/** a name that says JSON (GOOGLE_SA_KEY_JSON) holds a JSON object; the file is checked before it is stored. */
export const namesJson = (name: string) => /JSON/i.test(name);

/**
 * a key file's own checks (the value is never quoted back): not empty, at most MAX_FILE, a JSON object when the
 * name says JSON. The whole file is the value; only a trailing line break is dropped (as `secret` reads stdin).
 */
export function fileValueProblem(name: string, value: string): string | undefined {
  if (!value.trim()) return "the file is empty";
  if (Buffer.byteLength(value, "utf8") > MAX_FILE) return `the file is too big for a key file (at most ${MAX_FILE / 1024} KB)`;
  if (/\u0000/.test(value)) return "the file is not text: pick the key file itself";
  if (namesJson(name)) {
    let j: unknown;
    try {
      j = JSON.parse(value);
    } catch {
      return `${name} is a JSON key file, and this file is not valid JSON: pick the .json file Google downloaded`;
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) return `${name} is a JSON key file: the file must hold one JSON object`;
  }
  return undefined;
}
