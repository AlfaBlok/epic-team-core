import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import type { DB } from "./db.js";
import type { MailSender } from "./auth/emailAccess.js";
import { clientAddress } from "./clientAddress.js";
import { esc, type Clinic } from "./clinicDemo.js";
import { sites } from "./identity.js";

/**
 * The demo clinic opens from the internet by invite only (the owner, 27 Nov: "It's not like totally open.
 * You need an invite, and each invite is linked to an email. So you give us your email, we send you an invite, or we
 * find your email somehow, and we send you the invite.").
 *
 *   visitor from the internet ──▶ demo page without an invite ──▶ the email box ──▶ POST …/invitacion
 *                                                                                   │ one invite for that email
 *   the team (signed in) ── POST /api/clinic-demo/invites {email} ──▶ the same invite ┘ (an email we found)
 *                                                                                   ▼
 *                     the invite link goes to that email only ──▶ ?i=<token> opens the page and its call button
 *
 * An invite belongs to one email and one demo clinic; it lasts INVITE_DAYS and allows INVITE_CALLS_PER_DAY calls a day,
 * on top of the page's own limits (3 an hour a visitor, the clinic's day cap). A posted letter's code is its own invite
 * (clinicLetters.ts). Visits on our private network (no Cloudflare header) stay open, as before, so the team can test.
 * Mail: only to the address typed in the box or given by the team, one a day per address, MAILS_PER_DAY in all.
 */

export const INVITE_DAYS = 30;
export const INVITE_CALLS_PER_DAY = 5;
export const MAILS_PER_DAY = 40;
const VISITOR_REQUESTS_PER_HOUR = 3;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;
const tokenRe = /^[a-z0-9]{20}$/;

/** a visit from the internet reaches us through Cloudflare, which always sets this header; our private network does not. */
export const fromInternet = (header: (n: string) => string | undefined) => !!header("cf-connecting-ip")?.trim();
/** the demo clinics (made up) are the ones behind invites; a real clinic's own receptionist page answers on its plan. */
export const gated = (c: Pick<Clinic, "madeUp">) => !!c.madeUp;

export interface InviteDeps {
  db: DB;
  send?: MailSender;
  /** the public address the link in the mail opens (sites().clinicDemoUrl). */
  base?: string;
  from?: string;
  now?: () => number;
}

export interface Invite {
  token: string;
  slug: string;
  email: string;
  via: "request" | "team";
  created_at: string;
  mailed_at: string | null;
  mail: string | null;
  revoked_at: string | null;
}

export function ensureInviteTables(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_invites (
      token TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      email TEXT NOT NULL,
      via TEXT NOT NULL,
      created_at TEXT NOT NULL,
      mailed_at TEXT,
      mail TEXT,
      revoked_at TEXT,
      UNIQUE (slug, email)
    );
    CREATE TABLE IF NOT EXISTS clinic_invite_asks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  if (!(db.prepare("PRAGMA table_info(clinic_calls)").all() as { name: string }[]).some((c) => c.name === "invite")) db.exec("ALTER TABLE clinic_calls ADD COLUMN invite TEXT");
}

export const normalEmail = (v: unknown): string | undefined => {
  const e = String(v ?? "").trim().toLowerCase();
  return e.length <= 120 && EMAIL.test(e) ? e : undefined;
};

export function inviteMail(c: Pick<Clinic, "clinic" | "sales" | "receptionist">, link: string): { subject: string; text: string; html: string } {
  const who = c.receptionist ?? "nuestra recepcionista";
  const company = c.sales?.company ?? c.clinic;
  const subject = `Su invitación: hable con ${who}, la recepcionista por voz de ${company}`;
  const lines = [
    "Hola,",
    "",
    `Aquí tiene su invitación para probar en directo nuestra recepcionista de inteligencia artificial. Abra este enlace, pulse el botón y hable con ${who} como lo haría un paciente, o pregúntele cuánto costaría en su clínica:`,
    "",
    link,
    "",
    `El enlace es solo suyo y vale ${INVITE_DAYS} días. Necesita micrófono; no guardamos el audio.`,
    "",
    `Si no la ha pedido usted, ignore este correo: no le escribiremos más.`,
    "",
    `El equipo de ${company}`,
  ];
  const html = `<p>Hola,</p><p>Aquí tiene su invitación para probar en directo nuestra recepcionista de inteligencia artificial. Abra este enlace, pulse el botón y hable con ${esc(who)} como lo haría un paciente, o pregúntele cuánto costaría en su clínica:</p><p><a href="${esc(link)}">Hablar con ${esc(who)}</a></p><p>El enlace es solo suyo y vale ${INVITE_DAYS} días. Necesita micrófono; no guardamos el audio.</p><p>Si no la ha pedido usted, ignore este correo: no le escribiremos más.</p><p>El equipo de ${esc(company)}</p>`;
  return { subject, text: lines.join("\n"), html };
}

export function createInvites(d: InviteDeps) {
  const { db } = d;
  ensureInviteTables(db);
  const now = d.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const base = (d.base ?? process.env.CONSOLE_CLINIC_DEMO_URL ?? sites().clinicDemoUrl).replace(/\/$/, "");
  const from = d.from ?? process.env.CONSOLE_INVITE_FROM ?? sites().clinicInviteFrom;
  const link = (i: Pick<Invite, "slug" | "token">) => `${base}/api/public/clinic/${i.slug}?i=${i.token}`;
  const get = (slug: string, email: string) => db.prepare("SELECT * FROM clinic_invites WHERE slug = ? AND email = ?").get(slug, email) as Invite | undefined;
  const make = (slug: string, email: string, via: Invite["via"]): Invite => {
    const have = get(slug, email);
    if (have && !have.revoked_at) return have;
    const token = crypto.randomBytes(15).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20).padEnd(20, "0");
    db.prepare("INSERT INTO clinic_invites (token, slug, email, via, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(slug, email) DO UPDATE SET token = excluded.token, via = excluded.via, created_at = excluded.created_at, mailed_at = NULL, mail = NULL, revoked_at = NULL").run(token, slug, email, via, iso());
    return get(slug, email)!;
  };
  const mailsToday = () => (db.prepare("SELECT COUNT(*) n FROM clinic_invites WHERE mailed_at > ?").get(new Date(now() - 86_400_000).toISOString()) as { n: number }).n;
  const mail = async (c: Clinic, i: Invite): Promise<string> => {
    let outcome: string;
    if (i.mailed_at && now() - Date.parse(i.mailed_at) < 86_400_000) return "sent today already";
    if (!d.send || !from || !base) outcome = "held: no mail sender";
    else if (mailsToday() >= MAILS_PER_DAY) outcome = "held: day cap";
    else {
      const m = inviteMail(c, link(i));
      const r = await d.send({ from, to: i.email, ...m }).catch((e) => ({ ok: false as const, message: (e as Error).message }));
      outcome = r.ok ? `sent${r.id ? ` ${r.id}` : ""}` : `failed: ${r.message.slice(0, 120)}`;
    }
    db.prepare("UPDATE clinic_invites SET mail = ?, mailed_at = CASE WHEN ? LIKE 'sent%' THEN ? ELSE mailed_at END WHERE token = ?").run(outcome, outcome, iso(), i.token);
    return outcome;
  };
  const visitorHash = (addr: string) => crypto.createHash("sha256").update(`invite|${addr}`).digest("hex").slice(0, 16);

  return {
    link,
    /** a visitor typed an email in the box: one invite for that email, mailed to it (the same answer whatever happens). */
    async request(c: Clinic, rawEmail: unknown, addr: string): Promise<{ ok: boolean; reason?: "bad_email" | "too_many" }> {
      const email = normalEmail(rawEmail);
      if (!email) return { ok: false, reason: "bad_email" };
      const v = visitorHash(addr);
      const n = (db.prepare("SELECT COUNT(*) n FROM clinic_invite_asks WHERE visitor = ? AND at > ?").get(v, new Date(now() - 3_600_000).toISOString()) as { n: number }).n;
      if (n >= VISITOR_REQUESTS_PER_HOUR) return { ok: false, reason: "too_many" };
      db.prepare("INSERT INTO clinic_invite_asks (visitor, at) VALUES (?, ?)").run(v, iso());
      await mail(c, make(c.slug, email, "request"));
      return { ok: true };
    },
    /** the team's: an invite for an email it found; mailed only when `send` is set. */
    async create(c: Clinic, rawEmail: unknown, send = false): Promise<{ invite: Invite; link: string; mail?: string } | undefined> {
      const email = normalEmail(rawEmail);
      if (!email) return undefined;
      const i = make(c.slug, email, "team");
      const out = send ? await mail(c, i) : undefined;
      const now_ = get(c.slug, email)!;
      return { invite: now_, link: link(now_), ...(out ? { mail: out } : {}) };
    },
    revoke(token: string) {
      return db.prepare("UPDATE clinic_invites SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").run(iso(), token).changes > 0;
    },
    /** the invite a link carries, when it is for this clinic, not revoked and not older than INVITE_DAYS. */
    valid(slug: string, token: unknown): Invite | undefined {
      const t = String(token ?? "").trim().toLowerCase();
      if (!tokenRe.test(t)) return undefined;
      const i = db.prepare("SELECT * FROM clinic_invites WHERE token = ? AND slug = ?").get(t, slug) as Invite | undefined;
      if (!i || i.revoked_at || now() - Date.parse(i.created_at) > INVITE_DAYS * 86_400_000) return undefined;
      return i;
    },
    /** calls this invite started in the last day. */
    callsToday: (token: string) =>
      (db.prepare("SELECT COUNT(*) n FROM clinic_calls WHERE invite = ? AND started_at > ?").get(token, new Date(now() - 86_400_000).toISOString()) as { n: number }).n,
    mark(callId: string, token: string) {
      db.prepare("UPDATE clinic_calls SET invite = ? WHERE id = ?").run(token, callId);
    },
    /** the owner's list: each invite, its email, how it came, its mail and its calls. */
    list() {
      const calls = new Map((db.prepare("SELECT invite, COUNT(*) n, MAX(started_at) last FROM clinic_calls WHERE invite IS NOT NULL GROUP BY invite").all() as any[]).map((r) => [r.invite, r]));
      return (db.prepare("SELECT * FROM clinic_invites ORDER BY created_at DESC LIMIT 500").all() as Invite[]).map((i) => ({
        ...i,
        link: link(i),
        calls: calls.get(i.token)?.n ?? 0,
        lastCall: calls.get(i.token)?.last ?? null,
      }));
    },
  };
}
export type Invites = ReturnType<typeof createInvites>;

const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;

/** POST /api/public/clinic/<slug>/invitacion (the email box; open) and the owner's GET|POST /api/clinic-demo/invites. */
export function mountInvites(api: Hono, x: Invites, clinic: (slug: string) => Clinic | undefined) {
  api.post("/public/clinic/:slug/invitacion", async (c) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    const cl = clinic(c.req.param("slug") ?? "");
    if (!cl || !gated(cl)) return c.json({ error: { code: "not_found", message: "No hay ninguna demo con ese nombre." } }, 404);
    const t = await c.req.text().catch(() => "");
    let b: any = {};
    try {
      b = t.startsWith("{") ? JSON.parse(t) : Object.fromEntries(new URLSearchParams(t));
    } catch {
      b = {};
    }
    if (b.web) return c.json({ ok: true }); // the hidden box only robots fill
    const r = await x.request(cl, b.email, clientAddress(peerOf(c), (h) => c.req.header(h)));
    if (r.reason === "bad_email") return c.json({ error: { code: "bad_email", message: "Revise el correo: no parece una dirección válida." } }, 400);
    if (r.reason === "too_many") return c.json({ error: { code: "too_many", message: "Ya ha pedido varias invitaciones. Vuelva a probar dentro de una hora." } }, 429);
    return c.json({ ok: true });
  });
  api.get("/clinic-demo/invites", (c) => c.json({ invites: x.list() }));
  api.post("/clinic-demo/invites", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { slug?: string; email?: string; send?: boolean };
    const cl = clinic(b.slug ?? "sonrisa-demo");
    if (!cl || !gated(cl)) return c.json({ error: { code: "not_found", message: "no such demo clinic" } }, 404);
    const r = await x.create(cl, b.email, b.send === true);
    if (!r) return c.json({ error: { code: "bad_email", message: "not an email" } }, 400);
    return c.json(r, 201);
  });
  api.post("/clinic-demo/invites/:token/revoke", (c) => c.json({ revoked: x.revoke(c.req.param("token") ?? "") }));
}

/** the page a visitor from the internet sees without an invite: what it is, and the email box that brings one. */
export function invitePage(c: Clinic, o: { bad?: boolean } = {}): string {
  const s = c.sales;
  const who = c.receptionist ?? "nuestra recepcionista";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>Pida su invitación · ${esc(s?.company ?? c.clinic)}</title>
<style>
:root{--ink:#1d1b16;--muted:#6b665c;--line:#d9d3c7;--bg:#f6f2ea;--accent:#1f5c45}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px 56px}
.tag{display:inline-block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:32px;line-height:1.15;margin:16px 0 12px}
.punch{font-size:18px;margin:0 0 20px}
.flow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 28px;font-size:14px}
.flow span{border:1px solid var(--ink);border-radius:6px;padding:6px 10px;background:#fff}.flow i{font-style:normal;color:var(--muted)}
form{display:flex;flex-direction:column;gap:10px}
label{font-size:14px;color:var(--muted)}
input[type=email]{font:inherit;padding:14px;border:1px solid var(--ink);border-radius:8px;background:#fff;width:100%}
button{font:inherit;font-weight:600;padding:14px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6}
#msg{min-height:1.5em;margin:6px 0 0}
.small{font-size:13px;color:var(--muted)}
.hide{position:absolute;left:-9999px}
a{color:var(--accent)}
</style></head><body><main>
<span class="tag">Demo con invitación${s ? ` · ${esc(s.company)}` : ""}</span>
<h1>Hable con ${esc(who)}, nuestra recepcionista por voz</h1>
<p class="punch">La demo en directo funciona con invitación. Déjenos su correo y le enviamos su enlace personal.</p>
<div class="flow" aria-hidden="true"><span>Su correo</span><i>→</i><span>Su invitación</span><i>→</i><span>Hable con ella</span></div>
<form id="ask" method="post" action="/api/public/clinic/${esc(c.slug)}/invitacion">
<label for="email">Su correo</label>
<input id="email" name="email" type="email" required maxlength="120" autocomplete="email" placeholder="Su correo" data-testid="invite-email">
<input class="hide" name="web" tabindex="-1" autocomplete="off" aria-hidden="true">
<button id="send" data-testid="invite-send">Recibir mi invitación</button>
<p id="msg" role="status">${o.bad ? "Este enlace de invitación no es válido o ha caducado. Pida uno nuevo." : ""}</p>
</form>
<p class="small" style="margin-top:28px">Cada invitación es para un correo y vale ${INVITE_DAYS} días. Solo usamos su correo para enviarle el enlace. ¿Recibió una carta? <a href="/api/public/carta">Escriba su código</a>.</p>
</main>
<script>
const f = document.getElementById("ask"), b = document.getElementById("send"), m = document.getElementById("msg");
f.onsubmit = async (e) => {
  e.preventDefault(); b.disabled = true; m.textContent = "Enviando…";
  try {
    const r = await fetch(f.action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: f.email.value, web: f.web.value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || "No se pudo enviar. Pruebe otra vez.");
    f.email.disabled = true; b.style.display = "none";
    m.textContent = "Listo. Le hemos enviado su invitación a " + f.email.value + ". Mire también en correo no deseado.";
  } catch (err) { m.textContent = err.message; b.disabled = false; }
};
</script></body></html>`;
}
