import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Onboarding, type OnboardingTick } from "@/api";
import { useQuery } from "@/lib/data";
import { useRoutes, type ScreenId } from "@/lib/skin";
import { worldId } from "@/lib/useSocial";
import { cn } from "@/lib/utils";
import { socialProduct } from "@/lib/identity";
import { FoldChevron } from "@/components/foldChevron";

/**
 * the onboarding scorecard on the social product home, the social product side of's wizard
 * (docs/proposals/e97-s1-which-product-first/wizard.html: the same ring, six rows, dots and words). Every dot is read from
 * live state by the console (GET /tenants/:id/onboarding); nothing here ticks a box. Shown until six of six, then gone.
 * the owner, 2026-11-10 23:08Z: "a little scorecard of things completed … until you get six points when you've done the six things".
 */
// the console's own tokens, ink and one green; no cream panel on the dark page.
const C = {
  accent: "hsl(142 60% 45%)",
  wait: "hsl(var(--muted-foreground))",
  line: "hsl(var(--border))",
  faint: "hsl(var(--muted-foreground))",
  ring: "hsl(var(--border))",
  card: "hsl(var(--card))",
  ink: "hsl(var(--foreground))",
  muted: "hsl(var(--muted-foreground))",
};
/**
 * each step opens the screen where the customer does it, when that screen exists in this
 * skin. Sign in is the login page itself (the card shows only after it); the vault's screen is not built yet.
 */
export const STEP_SCREENS: Record<OnboardingTick["id"], { to: string; screen: ScreenId; label: string } | null> = {
  signin: null,
  // the vault step's own screen, Connect your socials.
  vault: { to: "/socials", screen: "browserAuth", label: "Connect your socials" },
  world: null,
  repos: null,
  seats: null,
  // accounts are connected where the sign-in sync lives (Browser auth: the Mac copies them into the world's own browser).
  accounts: {
    to: "/auth",
    screen: "browserAuth",
    label: "Connect your accounts",
  },
  product: {
    to: "/product",
    screen: "performance",
    label: "Open your product page",
  },
  campaign: {
    to: "/campaigns/new",
    screen: "campaigns",
    label: "Make a campaign",
  },
  post: { to: "/pipeline", screen: "pipeline", label: "Open the Pipeline" },
};
// only a proven step is green; anything else is red.
const LABEL: Record<OnboardingTick["state"], string> = {
  done: "Proven",
  part: "Not yet",
  todo: "Not yet",
};
const RED = "hsl(var(--muted-foreground))";

function Ring({ n, of }: { n: number; of: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className="h-14 w-14 flex-none" role="img" aria-label={`${n} of ${of} done`} data-testid="onboarding-ring">
      <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" stroke={C.ring} />
      <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" stroke={C.accent} strokeLinecap="round" strokeDasharray={c.toFixed(1)} strokeDashoffset={(c * (1 - n / of)).toFixed(1)} transform="rotate(-90 50 50)" />
      <text
        x="50"
        y="58"
        textAnchor="middle"
        style={{
          font: "600 1.5rem Inter, ui-sans-serif, system-ui, sans-serif",
          fill: C.ink,
        }}
      >
        {n}/{of}
      </text>
    </svg>
  );
}

function Dot({ t, i }: { t: OnboardingTick; i: number }) {
  const done = t.state === "done";
  return (
    <span
      className="grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-semibold"
      style={{
        border: `1.5px solid ${done ? C.accent : RED}`,
        background: done ? C.accent : "transparent",
        color: done ? C.card : RED,
      }}
      aria-hidden
    >
      {done ? "✓" : i + 1}
    </span>
  );
}

export function ScorecardView({ s, chat, has = () => true, list }: { s: Onboarding; chat?: boolean; has?: (screen: ScreenId) => boolean; list?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const n = s.done;
  const of = s.of || s.ticks.length;
  const product = s.product === "team" ? "EpicTeam" : socialProduct();
  const head = n === of ? "Your team is ready." : `Your ${product} is not ready yet.`;
  // Settings (the round 2 mockup): a "Setup" heading with the count in grey, then one quiet list, a row per step.
  if (list)
    return (
      <section className="mb-6" data-testid="onboarding-scorecard" data-look="list" aria-label="Your team's setup">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h2 className="text-[15px] font-semibold text-foreground">Setup</h2>
          <span className="text-xs text-muted-foreground" data-testid="onboarding-count">
            {n} of {of} proven by a live check{s.site ? ` on ${s.site}` : ""}
          </span>
        </div>
        <ul className="divide-y rounded-xl border bg-card">
          {s.ticks.map((t) => (
            <li key={t.id} data-testid={`onboarding-${t.id}`} data-state={t.state}>
              <button type="button" className="flex w-full items-baseline gap-3 px-4 py-3 text-left" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <FoldChevron open={open === t.id} className="self-center" />
                <span className="min-w-0 flex-1 text-sm text-foreground">
                  {t.title}
                  <span className="text-xs text-muted-foreground"> · {t.line}</span>
                </span>
                <span className={cn("shrink-0 whitespace-nowrap text-xs", t.state === "done" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>{t.state === "done" ? "proven" : "not yet"}</span>
              </button>
              {open === t.id && <StepDetail s={s} t={t} chat={chat} has={has} className="mx-4 mb-3" />}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <section className="mb-4 rounded-xl border p-4" style={{ background: C.card, borderColor: C.line }} data-testid="onboarding-scorecard" aria-label="Your onboarding scorecard">
      <div className="mb-3 flex items-center gap-4">
        <Ring n={n} of={of} />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight" style={{ color: C.ink }}>
            {head}
          </h2>
          <p className="mt-1 text-sm" style={{ color: C.muted }}>
            {n} of {of} proven by a live check{s.site ? ` on ${s.site}` : ""}. Red until proven.
          </p>
        </div>
      </div>
      <ul className="border-t" style={{ borderColor: C.line }}>
        {s.ticks.map((t, i) => (
          <li key={t.id} className="border-b" style={{ borderColor: C.line }} data-testid={`onboarding-${t.id}`} data-state={t.state}>
            <button type="button" className="grid w-full grid-cols-[1.75rem_1fr_auto] items-center gap-2.5 py-2 text-left" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
              <Dot t={t} i={i} />
              <span className="min-w-0">
                <b className="block text-sm font-medium" style={{ color: C.ink }}>
                  {t.title}
                </b>
                <span className="block text-[13px]" style={{ color: C.muted }}>
                  {t.line}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium" style={{ color: t.state === "done" ? C.accent : RED }}>
                {LABEL[t.state]}
                <FoldChevron open={open === t.id} />
              </span>
            </button>
            {open === t.id && <StepDetail s={s} t={t} chat={chat} has={has} className="mb-3 ml-[2.4rem]" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One step opened: what is true today, how to turn it green, how we know. */
function StepDetail({ s, t, chat, has, className }: { s: Onboarding; t: OnboardingTick; chat?: boolean; has: (screen: ScreenId) => boolean; className?: string }) {
  return (
    <div className={cn("grid gap-1.5 text-sm", className)} data-testid={`onboarding-${t.id}-detail`}>
      <p style={{ color: C.ink }}>{t.today}</p>
      {t.id === "accounts" && (
        <div className="flex flex-wrap gap-1.5">
          {s.accounts.map((a) => (
            <span
              key={a.platform}
              className="rounded-md border px-2 py-0.5 text-xs font-medium"
              style={{
                borderColor: a.state === "green" ? C.accent : RED,
                color: a.state === "green" ? C.accent : RED,
              }}
              data-testid={`onboarding-tile-${a.platform}`}
              data-state={a.state}
            >
              {a.label} · {a.state === "green" ? "on your team's browser" : a.state === "yellow" ? "only on the platform's browser" : "not signed in"}
            </span>
          ))}
        </div>
      )}
      {t.id === "vault" && !!s.vault?.length && (
        <ul className="grid gap-1" data-testid="onboarding-vault-items">
          {s.vault.map((v) => (
            <li key={v.name} className="flex flex-wrap items-baseline gap-x-2 text-xs" data-state={v.state}>
              <b className="font-medium" style={{ color: v.state === "green" ? C.accent : RED }}>
                {v.state === "green" ? "✓" : "✗"} {v.name}
              </b>
              <span style={{ color: C.muted }}>{v.why}</span>
            </li>
          ))}
        </ul>
      )}
      {t.state !== "done" && t.fix && (
        <p className="text-sm" style={{ color: RED }} data-testid={`onboarding-${t.id}-fix`}>
          <b className="font-medium">To turn it green.</b> {t.fix}
        </p>
      )}
      <p className="rounded-md px-2.5 py-2" style={{ background: "hsl(var(--muted))", color: C.muted }}>
        <b className="font-medium" style={{ color: C.ink }}>
          How we know.
        </b>{" "}
        {t.how}
        {t.proof && (
          <span className="mt-1 block text-xs" data-testid={`onboarding-${t.id}-proof`}>
            Read {new Date(s.readAt).toISOString().slice(0, 16).replace("T", " ")} UTC: {t.proof}
          </span>
        )}
      </p>
      {t.state !== "done" && STEP_SCREENS[t.id] && has(STEP_SCREENS[t.id]!.screen) && (
        <Link to={STEP_SCREENS[t.id]!.to} className="text-sm font-medium underline" style={{ color: C.accent }} data-testid={`onboarding-${t.id}-open`}>
          {STEP_SCREENS[t.id]!.label}
        </Link>
      )}
      {t.state !== "done" && chat && (
        <Link to="/chat" className="text-sm underline" style={{ color: C.accent }}>
          Stuck? Tell your desk
        </Link>
      )}
    </div>
  );
}

/** The home's card: hidden until it loads, on any error, and once all six are done. */
export function OnboardingScorecard({ list }: { list?: boolean } = {}) {
  const routes = useRoutes();
  const q = useQuery(async () => api.getOnboarding(await worldId()), []);
  const s = q.data;
  if (!s || s.done >= s.of) return null;
  return <ScorecardView s={s} chat={!!routes("chat")} has={(x) => !!routes(x)} list={list} />;
}
