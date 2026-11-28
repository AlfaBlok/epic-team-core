import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PlanState } from "@/api";
import { useQuery } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * the Buy button inside the console: a customer world buys the paid plan (name and price from the server) from its own
 * console. The server says who may buy (GET /tenants/:id/plan: a customer world
 * that has not paid; never the home world, never one of ours); the button opens Stripe's hosted checkout (test mode until
 * the go-live review) and Stripe's paid event turns the world's plan on. Back from Stripe the buyer lands on Credits, which
 * waits for that event and then says "You're on Epic Team".
 */
export const BUY_LABEL = (p: Pick<PlanState, "price">) => `Buy ${p.price.name}, €${p.price.eurPerMonth} a month`;
/** one seat bundle's button words, like "5 seats, €649 a month". */
export const BUNDLE_LABEL = (b: { seats: number; eurPerMonth: number }) => `${b.seats} seats, €${b.eurPerMonth.toLocaleString("en-GB")} a month`;
/** the locked model in one line ("your AI subscription, our console"), wherever the plan shows. */
export const PLAN_WORDS =
  "Your AI subscription, our console. Your team runs on your own AI seats, vault, repo and cloud. We host the console for €49 a month, and can run your server too, billed by the minute.";
/** one plain price per server size (cents a minute, a month at most), never how it was set. */
/** what Epic Leads says before its payment (same engine, same checkout as EpicTeam). */
export const LEADS_WORDS = "Your sales team starts once your plan is paid: your first objective is one product and one audience.";
export const centsLabel = (c: number) => `${c.toLocaleString("en-GB", { maximumFractionDigits: 2 })} cents`;
export function ComputePrices({ plan }: { plan: PlanState }) {
  const sizes = plan.compute?.sizes ?? [];
  if (!sizes.length) return null;
  return (
    <table className="w-full text-sm tabular-nums" data-testid="compute-prices">
      <caption className="mb-1 text-left text-xs text-muted-foreground">A server on our cloud, if you want one, billed by the minute and never more than the month&apos;s price</caption>
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 pr-2 font-normal">Size</th>
          <th className="py-1 pr-2 font-normal">A minute</th>
          <th className="py-1 font-normal">A month</th>
        </tr>
      </thead>
      <tbody>
        {sizes.map((z) => (
          <tr key={z.size} className="border-t border-border">
            <td className="py-1 pr-2">{z.size}, {z.cores} cores, {z.memoryGb} GB</td>
            <td className="py-1 pr-2">{centsLabel(z.centsPerMinute)}</td>
            <td className="py-1">€{z.eurPerMonthMax}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
/** @deprecated the seat bundles are retired; kept as the plan's words for older imports. */
export const SEAT_WORDS = PLAN_WORDS;
/** the own-AI button's words, like "Own AI, €49 a month". */
export const OWN_AI_LABEL = (o: { eurPerMonth: number }) => `Own AI, €${o.eurPerMonth} a month`;
/** what own AI is, in one line. */
export const OWN_AI_WORDS = "Or bring your own AI: your team runs on your own Anthropic key, kept in your own Bitwarden.";

/**
 * the bundle a visitor picked on the product site (`?bundle=5` on the way in, kept through sign-up in this browser), so
 * the payment opens on the one they chose.
 */
export function pickedBundle(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const q = Number(new URLSearchParams(window.location.search).get("bundle"));
  try {
    if (q > 0) window.localStorage.setItem("plan-bundle", String(q));
    const kept = Number(window.localStorage.getItem("plan-bundle"));
    return kept > 0 ? kept : undefined;
  } catch {
    return q > 0 ? q : undefined;
  }
}

/** the world's plan state; undefined while loading, in a console without the plan route, or for a world it does not know. */
export function usePlan(world: string | undefined, tick = 0) {
  return useQuery<PlanState | undefined>(() => (world && api.getPlan ? api.getPlan(world).catch(() => undefined) : Promise.resolve(undefined)), [world, tick]);
}

/** opens Stripe's checkout for one world (and one bundle); busy and error kept per button group. */
function useCheckout(world: string | undefined) {
  const [busy, setBusy] = useState<number | "plan" | "own">();
  const [error, setError] = useState<string>();
  const start = async (seats?: number | "own") => {
    if (!world || !api.startPlanCheckout) return;
    setBusy(seats ?? "plan");
    setError(undefined);
    try {
      window.location.assign((await api.startPlanCheckout(world, seats)).url);
    } catch (e) {
      setError((e as Error).message || "The payment page did not open. Try again in a minute.");
      setBusy(undefined);
    }
  };
  return { busy, error, start };
}

/** one button per seat bundle; the one picked on the product site leads. Falls back to the one Buy button. */
export function BundleButtons({ plan, size, testid = "buy-bundle" }: { plan: PlanState; size?: "sm" | "default"; testid?: string }) {
  const { busy, error, start } = useCheckout(plan.tenantId);
  if (!plan.canBuy || !api.startPlanCheckout) return null;
  if (!plan.bundles?.length) return <BuyButton plan={plan} size={size} />;
  const picked = pickedBundle();
  const lead = plan.bundles.some((b) => b.seats === picked) ? picked : plan.bundles[0].seats;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="flex flex-wrap gap-2">
        {plan.bundles.map((b) => (
          <Button
            key={b.seats}
            size={size}
            variant={b.seats === lead ? "default" : "outline"}
            onClick={() => start(b.seats)}
            disabled={busy !== undefined}
            pending={busy === b.seats}
            pendingLabel="Opening checkout…"
            data-testid={`${testid}-${b.seats}`}
            data-lead={b.seats === lead ? "true" : undefined}
          >
            {BUNDLE_LABEL(b)}
          </Button>
        ))}
        {plan.ownAi && (
          <Button
            size={size}
            variant="outline"
            onClick={() => start("own")}
            disabled={busy !== undefined}
            pending={busy === "own"}
            pendingLabel="Opening checkout…"
            data-testid={`${testid}-own`}
            title={OWN_AI_WORDS}
          >
            {OWN_AI_LABEL(plan.ownAi)}
          </Button>
        )}
      </span>
      {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </span>
  );
}

export function BuyButton({ plan, size }: { plan: PlanState; size?: "sm" | "default" }) {
  const { busy, error, start } = useCheckout(plan.tenantId);
  if (!plan.canBuy || !api.startPlanCheckout) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size={size} onClick={() => start()} disabled={busy !== undefined} pending={busy !== undefined} pendingLabel="Opening checkout…" data-testid="buy-plan">
        {BUY_LABEL(plan)}
      </Button>
      {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </span>
  );
}

const since = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const checkoutParam = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("checkout"));

/** the plan spot (Credits page): the Buy button, the wait after paying, then "You're on Epic Team". Nothing for our own worlds. */
export function PlanCard({ world }: { world: string | undefined }) {
  const back = checkoutParam();
  const [tick, setTick] = useState(0);
  const { data: plan } = usePlan(world, tick);
  const waiting = back === "done" && !!plan && !plan.paid;
  // back from Stripe: its paid event lands within seconds; ask again every 3 s for a minute
  useEffect(() => {
    if (!waiting || tick >= 20) return;
    const t = setTimeout(() => setTick((n) => n + 1), 3000);
    return () => clearTimeout(t);
  }, [waiting, tick]);
  if (!plan || (!plan.canBuy && !plan.paid)) return null;
  return (
    <Card className="min-w-0 p-4 lg:col-span-2" data-testid="plan-card">
      {plan.paid ? (
        <div data-testid="plan-paid">
          <h2 className="text-base font-semibold">You're on {plan.price.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {plan.seats ? `${plan.seats} seats, ` : plan.ai === "own" ? "Own AI, " : ""}€{plan.price.eurPerMonth.toLocaleString("en-GB")} a month{plan.subscription ? `, since ${since(plan.subscription.since)}` : ""}.{" "}
            {plan.ai === "own" && !plan.seats ? (
              <>
                Your team runs on your own AI key. <Link to="/your-ai" className="underline underline-offset-2">Add your key</Link>
              </>
            ) : (
              "Your team's AI is included in your seats, so credits never pause your team."
            )}
            {plan.subscription?.testMode && " Paid in Stripe's test mode: no real money moved."}
          </p>
        </div>
      ) : waiting ? (
        <div role="status" data-testid="plan-confirming">
          <h2 className="text-base font-semibold">Thank you</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {tick >= 20 ? "Stripe has not confirmed the payment yet. Refresh this page in a minute." : "Stripe is confirming your payment. This takes a few seconds."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{plan.price.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {plan.bundles?.length
                ? `Pick how many seats. ${SEAT_WORDS}${plan.ownAi ? ` ${OWN_AI_WORDS}${plan.ownAi.testMode ? " Own AI is in test mode for now: no real money moves." : ""}` : ""} Monthly, cancel any time.`
                : `${PLAN_WORDS}${plan.ownAi?.testMode ? " In test mode for now: no real money moves." : ""} Monthly, cancel any time.`}
            </p>
            {back === "cancelled" && <p className="mt-1 text-sm text-muted-foreground" data-testid="plan-cancelled">The payment was cancelled. Nothing was charged.</p>}
          </div>
          <BundleButtons plan={plan} />
          <ComputePrices plan={plan} />
        </div>
      )}
    </Card>
  );
}

/**
 * one short line on Home for a world that can buy. Not for a sign-up still waiting for its first payment: the waiting note
 * on every page already holds its Pay button.
 */
export function HomeBuyLine() {
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  const world = me?.tenant?.id;
  const { data: plan } = usePlan(me && me.billing !== "awaiting_payment" ? world : undefined);
  if (!plan?.canBuy) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="home-buy-line">
      <p className="min-w-0 flex-1 basis-56">
        Your world is on the free plan. {plan.price.name} keeps your team working on your own AI, €{plan.price.eurPerMonth.toLocaleString("en-GB")} a month.{" "}
        <Link to="/credits" className="underline underline-offset-2">
          See the plan
        </Link>
      </p>
    </div>
  );
}

/**
 * the sign-up's world before its plan is paid (Layout's BillingNote): one line and the button that pays (the hosted
 * checkout, a monthly plan). Back from Stripe it says the payment is on its way.
 */
export function PayNote({ world }: { world: string | undefined }) {
  const { data: plan } = usePlan(world);
  const back = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("checkout") === "done";
  // the seat bundles on sale, the one picked on the product site first
  return (
    <div role="status" className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="billing-note">
      {back ? (
        <p>Thank you. Stripe is confirming your payment. Your team starts as soon as it arrives, refresh in a moment.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="min-w-0">
            {plan?.line === "leads" ? `Welcome to Epic Leads. Your workspace is ready. ${LEADS_WORDS}` : <>Welcome to EpicTeam. Your account is ready. Your team starts working once your plan is paid. {PLAN_WORDS}</>}
          </p>
          {plan && <BundleButtons plan={plan} size="sm" testid="billing-pay" />}
        </div>
      )}
    </div>
  );
}
