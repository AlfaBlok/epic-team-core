import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "./db.js";
import { clientAddress } from "./clientAddress.js";
import { clinicPage, type ClinicDemo } from "./clinicDemo.js";
import { VoiceError } from "./voice/voice.js";

/**
 * The posted letter to a Spanish clinic: sales email is barred in Spain (LSSI art. 21), a posted letter is not, so the
 * letter carries a code that opens a live web call with our AI rep.
 *
 *   <home repo>/docs/clinics/letters/*.json ── one code per clinic ──▶ the printed letter (scripts/clinic_letters.py)
 *        │                                                                  │ QR code or typed short link
 *   GET /api/public/carta/<CODE> ── a scan, counted per clinic ──▶ the call page: one button, our AI rep, live
 *        │                                                                  │
 *        └── POST …/clinic/<demo>/calls {ref: CODE} ── the call carries the clinic's code ──▶ GET /api/clinic-demo/letters
 *
 * The public short link is <public address>/carta/<CODE> (a router in the hosted layer maps it here; an older short
 * host redirects there). A code is six characters
 * from an alphabet without look-alikes (no 0, O, 1, I, L). Nothing here sends or posts anything: a letter is printed and
 * posted only after the owner's yes. A scan keeps only the time and a hashed address.
 */

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** a code as read: 4 to 12 letters and digits (a new one is six from CODE_ALPHABET). */
export const codeRe = /^[A-Z0-9]{4,12}$/;

export interface Letter {
  code: string;
  /** the clinic the letter goes to, as it names itself. */
  clinic: string;
  city: string;
  /** the clinic config whose agent answers (default: the batch's demo). */
  demo: string;
  /** a test letter (ours, never posted): its scans and calls are kept apart in the reading. */
  test?: boolean;
  /** the published postal address the letter goes to (printed in the envelope window only). */
  address?: string;
  /** the tracker row it came from (Dental clinics table). */
  row?: string;
}

const letterIn = z.object({
  code: z.string().regex(codeRe),
  clinic: z.string().min(2).max(120),
  city: z.string().min(2).max(80),
  demo: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(),
  test: z.boolean().optional(),
  address: z.string().max(300).optional(),
  row: z.string().max(80).optional(),
});
const batchIn = z.object({
  demo: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  letters: z.array(letterIn).max(2000),
});

/** a typed code as printed: upper case, spaces and dashes dropped. */
export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[\s\-_.]/g, "").slice(0, 12);
}

/** a fresh code not in `taken`. */
export function newCode(taken: Set<string>, rnd: (n: number) => Buffer = crypto.randomBytes): string {
  for (;;) {
    const b = rnd(6);
    const c = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
    if (!taken.has(c)) return c;
  }
}

/** every letter in `<dir>/*.json` (one batch per file); a broken file is skipped with a warning, never a crash. */
export function loadLetters(dir: string): Map<string, Letter> {
  const out = new Map<string, Letter>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    try {
      const p = batchIn.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      if (!p.success) {
        console.warn(`letters: ${f} skipped: ${p.error.issues[0]?.path.join(".")} ${p.error.issues[0]?.message}`);
        continue;
      }
      for (const l of p.data.letters) if (!out.has(l.code)) out.set(l.code, { ...l, demo: l.demo ?? p.data.demo });
    } catch (e) {
      console.warn(`letters: ${f} skipped: ${(e as Error).message}`);
    }
  }
  return out;
}

/** the letters in `dir`, read again at most once a minute (the home repo is pulled; a new batch goes live by itself). */
export function lettersIn(dir: () => string | undefined, now: () => number = Date.now): () => Map<string, Letter> {
  let at = -Infinity;
  let last = new Map<string, Letter>();
  return () => {
    if (now() - at < 60_000) return last;
    at = now();
    const d = dir();
    last = d ? loadLetters(d) : new Map();
    return last;
  };
}

export interface LetterDeps {
  db: DB;
  letters: () => Map<string, Letter>;
  demo: ClinicDemo;
}

export function createLetters(d: LetterDeps) {
  const { db } = d;
  const find = (raw: string) => {
    const code = normalizeCode(raw);
    return codeRe.test(code) ? d.letters().get(code) : undefined;
  };
  return {
    find,
    /** the letter's page was opened: one scan in the demo's scan table (clinicDemo.ts), counted for its clinic. */
    scan(raw: string, addr: string): Letter | undefined {
      const l = find(raw);
      if (!l) return undefined;
      d.demo.scan(l.demo, l.code, addr);
      return l;
    },
    /** the owner's reading: per letter its scans, people, calls and follow-ups (test letters marked). */
    stats() {
      const scans = new Map((db.prepare("SELECT code, COUNT(*) n, COUNT(DISTINCT visitor) people, MIN(at) first, MAX(at) last FROM clinic_scans WHERE code IS NOT NULL GROUP BY code").all() as any[]).map((r) => [r.code, r]));
      const calls = new Map((db.prepare("SELECT code, COUNT(*) n, MAX(started_at) last FROM clinic_calls WHERE code IS NOT NULL GROUP BY code").all() as any[]).map((r) => [r.code, r]));
      const follow = new Map(
        (db.prepare("SELECT c.code code, COUNT(*) n FROM clinic_bookings b JOIN clinic_calls c ON c.id = b.call_id WHERE c.code IS NOT NULL AND b.kind = 'follow_up' GROUP BY c.code").all() as any[]).map((r) => [r.code, r.n]),
      );
      const letters = [...d.letters().values()].map((l) => ({
        code: l.code,
        clinic: l.clinic,
        city: l.city,
        demo: l.demo,
        test: !!l.test,
        row: l.row ?? null,
        scans: scans.get(l.code)?.n ?? 0,
        people: scans.get(l.code)?.people ?? 0,
        firstScan: scans.get(l.code)?.first ?? null,
        lastScan: scans.get(l.code)?.last ?? null,
        calls: calls.get(l.code)?.n ?? 0,
        lastCall: calls.get(l.code)?.last ?? null,
        followUps: follow.get(l.code) ?? 0,
      }));
      const real = letters.filter((l) => !l.test);
      return {
        letters,
        totals: { letters: real.length, scanned: real.filter((l) => l.scans > 0).length, called: real.filter((l) => l.calls > 0).length, followUps: real.reduce((a, l) => a + l.followUps, 0) },
      };
    },
  };
}
export type Letters = ReturnType<typeof createLetters>;

// ---------- routes ----------

const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;

/** GET /api/public/carta (type your code), GET /api/public/carta/<CODE> (the call page; open, routeScope.ts) and the owner's GET /api/clinic-demo/letters. */
export function mountLetters(api: Hono, x: Letters, demo: ClinicDemo) {
  const hits = new Map<string, number[]>();
  const limited = (a: string) => {
    const t = Date.now();
    const recent = (hits.get(a) ?? []).filter((v) => t - v < 60_000);
    recent.push(t);
    hits.set(a, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > 30;
  };
  const head = (c: Context) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    c.header("referrer-policy", "no-referrer");
  };
  api.get("/public/carta", (c) => {
    head(c);
    const q = c.req.query("codigo");
    if (q) {
      const l = x.find(q);
      // relative, so the public short address keeps its own path (<public>/carta?codigo=X -> <public>/carta/X)
      if (l) return c.redirect(`carta/${l.code}`, 302);
      return c.html(codePage(q), 404);
    }
    return c.html(codePage());
  });
  api.get("/public/carta/:code", (c) => {
    head(c);
    const a = clientAddress(peerOf(c), (h) => c.req.header(h));
    if (limited(a)) return c.html(codePage(undefined, "Demasiadas visitas seguidas. Espere un minuto y vuelva a abrir el enlace."), 429);
    const l = x.scan(c.req.param("code") ?? "", a);
    if (!l) return c.html(codePage(c.req.param("code") ?? ""), 404);
    let cl;
    try {
      cl = demo.clinic(l.demo);
    } catch (e) {
      if (e instanceof VoiceError) return c.html(codePage(undefined, "La demostración no está disponible ahora mismo. Pruebe más tarde."), 503);
      throw e;
    }
    demo.warm(l.demo);
    return c.html(clinicPage(cl, { letter: { code: l.code, clinic: l.clinic } }));
  });
  api.get("/clinic-demo/letters", (c) => c.json(x.stats()));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** the box to type the code printed on the letter (and the page an unknown code lands on). */
export function codePage(tried?: string, note?: string): string {
  const msg = note ?? (tried ? `No encontramos el código «${esc(tried.slice(0, 12))}». Revíselo en la carta y escríbalo otra vez.` : "Escriba el código de seis letras y números que viene en su carta.");
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Su código</title>
<style>
:root{--paper:#f6f3ec;--ink:#1d1b17;--muted:#6b665c;--line:#d9d3c5;--green:#1f5c45;--card:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:40px 16px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px;font-weight:600}
p{margin:0 0 20px;color:var(--muted)}
input{width:100%;padding:14px;font:600 22px/1 ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;border:1px solid var(--ink);border-radius:10px;background:var(--card);color:var(--ink)}
button{display:block;width:100%;margin-top:12px;padding:16px;border:0;border-radius:10px;background:var(--green);color:#fff;font:600 18px system-ui,sans-serif;cursor:pointer}
</style></head><body><main>
<h1>Hable con nuestra recepcionista de IA</h1>
<p data-testid="code-note">${msg}</p>
<form method="get" action="/api/public/carta"><input name="codigo" maxlength="12" autocomplete="off" autocapitalize="characters" aria-label="Código de la carta" placeholder="K7M4QP">
<button type="submit">Continuar</button></form>
</main></body></html>`;
}
