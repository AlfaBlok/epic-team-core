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
/** what a seat is, in one line, wherever the bundles show. */
export const SEAT_WORDS = "A seat is one AI teammate working for you. We run the AI and the servers, so there is nothing to set up.";

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
  const [busy, setBusy] = useState<number | "plan">();
  const [error, setError] = useState<string>();
  const start = async (seats?: number) => {
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
            {plan.seats ? `${plan.seats} seats, ` : ""}€{plan.price.eurPerMonth.toLocaleString("en-GB")} a month{plan.subscription ? `, since ${since(plan.subscription.since)}` : ""}. Your team's AI is included in your seats, so credits never pause your team.
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
                ? `Pick how many seats. ${SEAT_WORDS} Monthly, cancel any time.`
                : `One plan, €${plan.price.eurPerMonth} a month. Your team plans, builds and reports on your projects. Cancel any time.`}
            </p>
            {back === "cancelled" && <p className="mt-1 text-sm text-muted-foreground" data-testid="plan-cancelled">The payment was cancelled. Nothing was charged.</p>}
          </div>
          <BundleButtons plan={plan} />
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
        Your world is on the free plan. {plan.price.name} keeps your team working with its AI included, from €{plan.price.eurPerMonth.toLocaleString("en-GB")} a month.{" "}
        <Link to="/credits" className="underline underline-offset-2">
          Pick your seats
        </Link>
      </p>
    </div>
  );
}
