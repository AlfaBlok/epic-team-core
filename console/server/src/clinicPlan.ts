import type { DB } from "./db.js";

/**
 * A clinic pays for Epic Voice Clinic (the owner: "que un usuario pueda pagar").
 *
 *   clinic set up (docs/clinics/<slug>.json) ──▶ GET /api/public/clinic/<slug>/activar ── one button ──▶ Stripe Checkout
 *        ▲                                                                                         │ 14 días gratis, luego 149 €/mes
 *        └── its receptionist answers ◀── clinic_plans: trialing / active ◀── the webhook (hosted stripeTeam.ts) ◀──┘
 *
 * The plan is the price Lucía says on the call: 149 euros a month a clinic, phone and WhatsApp, after 14 free days. A real
 * clinic's receptionist answers only while its plan is on (trialing, active or past_due); our made-up demo clinics always
 * answer. The checkout and the webhook are the hosted billing plug's (the same Stripe account as the EpicTeam plan); this file
 * holds only the state they write and the page the clinic opens, so a one-team console shows the page with no button.
 */
export const CLINIC_PLAN = { name: "Epic Voice Clinic", eurPerMonth: 149, trialDays: 14 } as const;
const ON = new Set(["trialing", "active", "past_due"]);

export interface ClinicPlan {
  slug: string;
  status: string;
  subscription: string;
  livemode: boolean;
  trialEnd?: string;
  startedAt: string;
  updatedAt: string;
}

export function ensureClinicPlans(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_plans (
      subscription TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      customer TEXT,
      email TEXT,
      status TEXT NOT NULL,
      livemode INTEGER NOT NULL DEFAULT 0,
      trial_end TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS clinic_plans_slug ON clinic_plans (slug, updated_at);
  `);
}

/** the clinic's newest plan, when it ever opened one. */
export function clinicPlan(db: DB, slug: string): ClinicPlan | undefined {
  ensureClinicPlans(db);
  const r = db.prepare("SELECT * FROM clinic_plans WHERE slug = ? ORDER BY updated_at DESC, started_at DESC LIMIT 1").get(slug) as Record<string, any> | undefined;
  if (!r) return undefined;
  return { slug: r.slug, status: r.status, subscription: r.subscription, livemode: !!r.livemode, ...(r.trial_end ? { trialEnd: r.trial_end } : {}), startedAt: r.started_at, updatedAt: r.updated_at };
}

export const planOn = (p: ClinicPlan | undefined) => !!p && ON.has(p.status);

/** a paid checkout: the clinic's plan starts (its trial first); the same subscription again only refreshes it. */
export function startClinicPlan(db: DB, o: { slug: string; subscription: string; customer?: string; email?: string; livemode: boolean; trialEnd?: string; at: string }) {
  ensureClinicPlans(db);
  const status = o.trialEnd && Date.parse(o.trialEnd) > Date.parse(o.at) ? "trialing" : "active";
  db.prepare(
    `INSERT INTO clinic_plans (subscription, slug, customer, email, status, livemode, trial_end, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscription) DO UPDATE SET status = excluded.status, trial_end = excluded.trial_end, updated_at = excluded.updated_at`,
  ).run(o.subscription, o.slug, o.customer ?? null, o.email || null, status, o.livemode ? 1 : 0, o.trialEnd ?? null, o.at, o.at);
  return status;
}

/** a subscription changed in Stripe: its status is kept; undefined = not a clinic plan. */
export function changeClinicPlan(db: DB, subscription: string, status: string, at: string): string | undefined {
  ensureClinicPlans(db);
  const r = db.prepare("SELECT slug FROM clinic_plans WHERE subscription = ?").get(subscription) as { slug: string } | undefined;
  if (!r) return undefined;
  db.prepare("UPDATE clinic_plans SET status = ?, updated_at = ? WHERE subscription = ?").run(status, at, subscription);
  return r.slug;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const day = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(+d) ? "" : d.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" });
};

/** the page a clinic opens after its set-up call: the plan, one button to Stripe, and whether its receptionist is on. */
export function activationPage(c: { slug: string; clinic: string; receptionist?: string; madeUp?: boolean }, plan: ClinicPlan | undefined, o: { back?: string } = {}): string {
  const on = planOn(plan);
  const who = c.receptionist ?? "Su recepcionista";
  const punch = on
    ? `${who} ya contesta las llamadas de ${c.clinic}.${plan?.status === "trialing" && plan.trialEnd ? ` Prueba gratis hasta el ${day(plan.trialEnd)}.` : ""}`
    : `Active la recepcionista de ${c.clinic}: ${CLINIC_PLAN.trialDays} días gratis, luego ${CLINIC_PLAN.eurPerMonth} € al mes.`;
  const steps = ["Puesta en marcha", "Activar con tarjeta", `${CLINIC_PLAN.trialDays} días gratis`, `${who} contesta`];
  const done = on ? 4 : 1;
  const note =
    o.back === "ok" && !on
      ? `<p id="wait" class="small">Pago recibido. Activando… esta página se actualiza sola.</p>`
      : o.back === "cancelled"
        ? `<p class="small">No se ha cobrado nada. Puede activarla cuando quiera.</p>`
        : "";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>Activar recepcionista · ${esc(c.clinic)}</title>
<style>
@font-face{font-family:"Inter";font-weight:400;font-display:swap;src:url(/fonts/inter-400.woff2) format("woff2")}
@font-face{font-family:"Inter";font-weight:600;font-display:swap;src:url(/fonts/inter-600.woff2) format("woff2")}
:root{--paper:#f6f3ec;--ink:#1d1b17;--muted:#6b665c;--line:#d9d3c5;--green:#1f5c45;--card:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Inter,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:28px 16px 48px}
.tag{display:inline-block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
h1{font-size:26px;line-height:1.2;margin:12px 0 8px;font-weight:600}
.punch{font-size:18px;margin:0 0 20px}
.flow{display:flex;align-items:center;gap:6px;margin:0 0 24px;flex-wrap:wrap}
.flow span{border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:14px;background:var(--card);color:var(--muted)}
.flow span.done{border-color:var(--ink);color:var(--ink)}
.flow span.now{border-color:var(--green);color:var(--green);font-weight:600}
.flow i{font-style:normal;color:var(--muted)}
#pay{display:block;width:100%;padding:18px;border:0;border-radius:12px;background:var(--green);color:#fff;font:600 19px Inter,system-ui,sans-serif;cursor:pointer}
#pay[disabled]{opacity:.6;cursor:default}
#status{min-height:24px;margin:12px 0 0;color:var(--muted);font-size:15px}
.on{border:1px solid var(--green);border-radius:12px;padding:16px;background:var(--card)}
.on b{color:var(--green)}
section{margin-top:28px;border-top:1px solid var(--line);padding-top:16px}
h2{font-size:17px;margin:0 0 10px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}
td:last-child{text-align:right;white-space:nowrap;padding-left:12px}
.small{font-size:13px;color:var(--muted)}
</style></head><body><main>
<span class="tag">${esc(CLINIC_PLAN.name)}</span>
<h1>${esc(c.clinic)}</h1>
<p class="punch" data-testid="plan-punch">${esc(punch)}</p>
<div class="flow" aria-hidden="true">${steps.map((s, i) => `<span class="${i < done ? "done" : ""}${i === (on ? 3 : 1) ? " now" : ""}">${esc(s)}</span>`).join("<i>→</i>")}</div>
${
  on
    ? `<div class="on" id="state" data-testid="plan-on"><b>Activada.</b> ${esc(plan!.status === "trialing" ? `Prueba gratis hasta el ${day(plan!.trialEnd)}; el primer cobro de ${CLINIC_PLAN.eurPerMonth} € es ese día.` : `Plan de ${CLINIC_PLAN.eurPerMonth} € al mes en curso.`)}${plan!.livemode ? "" : " Modo de prueba: no se ha cobrado nada real."}</div>`
    : `<button id="pay" data-testid="plan-pay">Activar: ${CLINIC_PLAN.trialDays} días gratis</button>
<p id="status" role="status">Hoy no se cobra nada. Se cancela cualquier mes.</p>${note}`
}
<section id="plan"><h2>El plan</h2>
<table>
<tr><td>Teléfono y WhatsApp, todas las llamadas</td><td>${CLINIC_PLAN.eurPerMonth} € al mes</td></tr>
<tr><td>Prueba en su propio número</td><td>${CLINIC_PLAN.trialDays} días gratis</td></tr>
<tr><td>Instalación</td><td>sin coste</td></tr>
<tr><td>Permanencia</td><td>ninguna</td></tr>
</table>
<p class="small">El pago lo gestiona Stripe. Los pacientes siguen llamando al número de siempre.${c.madeUp ? " Clínica de demostración: solo pagos de prueba." : ""}</p></section>
</main>
${
  on
    ? ""
    : `<script type="module">
const base = "/api/public/clinic/" + ${JSON.stringify(c.slug)};
const btn = document.getElementById("pay"), status = document.getElementById("status");
btn.onclick = async () => {
  btn.disabled = true; status.textContent = "Abriendo el pago seguro…";
  try {
    const r = await fetch(base + "/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error((j.error && j.error.message) || "El pago no está disponible ahora.");
    location.href = j.url;
  } catch (e) { status.textContent = e.message; btn.disabled = false; }
};
if (document.getElementById("wait")) { let n = 0; try { n = Number(sessionStorage.getItem("clinicWait") || 0); sessionStorage.setItem("clinicWait", String(n + 1)); } catch {} if (n < 15) setTimeout(() => location.reload(), 4000); }
</script>`
}</body></html>`;
}
