import { Link, useParams, useSearchParams } from "react-router-dom";
import { ObjectiveName } from "@/components/objectiveName";
import { api } from "@/api";
import type { ProductView, ProductsBody, PursuitKitBody } from "@/api/pursuit-types";
import type { SiteCount, SiteKpisBody } from "@/api/types";
import { worldId } from "@/lib/useSocial";
import { STATE_FILL, TabStrip, titleOf, useGoalSets } from "@/components/goalSets";
import { SocialKitBody } from "@/components/socialKit";
import { ChatMarkdown } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { PRODUCTS_PATH, SET_NAME, productHref, scorecardHref } from "@/lib/scorecards";

/**
 * Products, each defined once (the owner's ask: "A Products section: each product defined
 * once (benefits, problems it solves, how it works, target audience); goals and campaigns on it reuse that instead of
 * repeating it"). Every word is read where it already lives: the product's deck (its campaign repo's data/product.md)
 * and its social kit (docs/brand/social-kit/<id>); docs/scorecard/products.json names both, and each objective names
 * its product, so several objectives share one product and one kit. Nothing here is written twice.
 */
const TABS = [
  { id: "table", label: "What it is" },
  { id: "kit", label: "Social kit" },
] as const;

/** the product's letter on its own colour (the kit's accent), the mark every product page opens with. */
function Mark({ p, size = 44 }: { p: Pick<ProductView, "name" | "accent">; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg font-semibold text-white"
      style={{ width: size, height: size, background: p.accent ?? "hsl(var(--foreground))", fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {p.name.slice(0, 1)}
    </span>
  );
}

function Wheels({ p }: { p: ProductView }) {
  // the same names the sidebar shows (the objectives screen), the file's name until it has read them.
  const { data } = useGoalSets();
  const named = new Map((data?.nodes ?? []).map((n) => [n.id, titleOf(n)]));
  if (!p.wheels.length) return <p className="text-sm text-muted-foreground">No {SET_NAME.one.toLowerCase()} names it yet.</p>;
  return (
    <ul className="divide-y rounded-xl border bg-card" data-testid="product-wheels">
      {p.wheels.map((w) => (
        <li key={w.id}>
          <Link to={scorecardHref(w.id)} className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2 hover:bg-accent/40" data-testid="product-wheel">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_FILL[w.state] ?? STATE_FILL.unknown }} aria-hidden="true" />
            <ObjectiveName name={named.get(w.id) ?? w.name} className="min-w-0 flex-1 text-sm text-foreground" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {w.greens} of {w.total} green
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A numbered list read as steps, the rest of the part as words. */
export function stepsOf(body: string): { steps: string[]; rest: string } {
  const lines = body.split("\n");
  const steps = lines.flatMap((l) => {
    const m = /^\d+\.\s+(.*)$/.exec(l.trim());
    return m ? [m[1]] : [];
  });
  const rest = lines.filter((l) => !/^\d+\.\s+/.test(l.trim())).join("\n").trim();
  return { steps, rest };
}

/** How it works is a sequence: its steps as boxes in one line with arrows (stacked down on a phone). */
function Steps({ body }: { body: string }) {
  const { steps, rest } = stepsOf(body);
  if (steps.length < 2) return <ChatMarkdown text={body} />;
  const intro = rest.split("\n\n");
  return (
    <div className="grid min-w-0 gap-3">
      <ol className="flex min-w-0 flex-col items-stretch gap-1 md:flex-row md:items-stretch" data-testid="product-steps">
        {steps.map((x, i) => (
          <li key={i} className="flex min-w-0 flex-col items-center gap-1 md:flex-1 md:flex-row">
            <div className="w-full min-w-0 flex-1 self-stretch rounded-lg border bg-background p-2.5 text-sm [overflow-wrap:anywhere]" data-testid="product-step">
              <span className="mb-1 block text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <ChatMarkdown text={x} />
            </div>
            {i < steps.length - 1 && (
              <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                <span className="md:hidden">↓</span>
                <span className="hidden md:inline">→</span>
              </span>
            )}
          </li>
        ))}
      </ol>
      {intro.some((t) => t.trim()) && <ChatMarkdown text={rest} />}
    </div>
  );
}

/** the deck's four parts, read where they live (the product page and every campaign of the product show these). */
function ProductParts({ p }: { p: ProductView }) {
  return (
    <>
      {p.deck && p.deck.parts.length > 0 ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2" data-testid="product-parts">
          {p.deck.parts.map((x) => (
            <section key={x.part} className={cn("min-w-0 rounded-xl border bg-card p-3 sm:p-4", x.part === "How it works" && "md:col-span-2")} data-testid="product-part" data-part={x.part}>
              <h2 className="mb-1.5 text-[15px] font-semibold text-foreground">{x.label}</h2>
              <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
                {x.part === "How it works" ? <Steps body={x.body} /> : <ChatMarkdown text={x.body} />}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No product deck is named for it yet.</p>
      )}
    </>
  );
}

/** where the words were read from, written once there. */
function ProductSource({ p }: { p: ProductView }) {
  if (!p.deck) return null;
  return (
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="product-source">
      Read from {p.deck.repo} {p.deck.path}
      {p.deck.parts.some((x) => x.from) ? ` and ${p.deck.parts.flatMap((x) => (x.from ? [x.from] : [])).join(", ")}` : ""}, written once there.
    </p>
  );
}

/**
 * a campaign's product, never written again on the campaign: its name and line, the deck's four parts and its
 * social kit, read from the Products section (the owner: goals and campaigns reuse the product, never repeat it).
 */
export function CampaignProductWords({ id, name }: { id: string; name: string }) {
  const { data: p, error, loading } = useQuery<ProductView>(() => api.getProduct(id), [id]);
  return (
    <section className="grid min-w-0 gap-3" data-testid="campaign-product-words" data-product={id}>
      <header className="flex min-w-0 items-start gap-3 rounded-xl border border-l-[6px] bg-card p-3 shadow-sm sm:p-4" style={{ borderLeftColor: p?.accent }}>
        <Mark p={p ?? { name }} size={36} />
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="text-lg font-semibold leading-tight">For {p?.name ?? name}</h2>
          <p className="text-sm text-foreground [overflow-wrap:anywhere]" data-testid="campaign-product-line">
            {p?.tagline ? `${p.tagline.replace(/[.!?]+$/, "")}. ` : ""}Its words are written once, on its product page.
          </p>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link to={productHref(id)} className="underline underline-offset-4" data-testid="campaign-product-link">
              Product page ›
            </Link>
            {p?.kit && (
              <Link to={`${productHref(id)}?tab=kit`} className="underline underline-offset-4" data-testid="campaign-product-kit">
                Social kit ›
              </Link>
            )}
          </span>
        </div>
      </header>
      {loading && !p && <div className="text-sm text-muted-foreground">Reading the product…</div>}
      {error && <div className="text-sm text-muted-foreground">The product page could not be read: {error.message}</div>}
      {p && <ProductParts p={p} />}
      {p && <ProductSource p={p} />}
    </section>
  );
}

/**
 * The owner asked on a briefing call how many views the websites get: the product's own website, its views per day for the last 7 days, yesterday first. The same counts as Performance › Every site and the briefer's
 * site_views (our own counter, one view per visitor and day, no cookie, crawlers and tests left out).
 */
export function ProductSiteViews({ name }: { name: string }) {
  const { data } = useQuery<SiteKpisBody>(async () => api.getSiteKpis(await worldId()), []);
  const sites = (data?.sites ?? []).filter((s) => s.name === name);
  if (!data?.today || !sites.length) return null;
  return (
    <section className="grid gap-2" data-testid="product-site-views">
      <h2 className="text-sm font-semibold text-foreground">Website views a day</h2>
      {sites.map((s) => (
        <SiteWeek key={s.host} s={s} today={data.today} />
      ))}
    </section>
  );
}

const dayBack = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function SiteWeek({ s, today }: { s: SiteCount; today: string }) {
  const at = (d: string) => s.visits.find((p) => p.date === d)?.value ?? 0;
  const days = Array.from({ length: 8 }, (_, i) => dayBack(today, i));
  const yesterday = days[1];
  const week = days.slice(1).reduce((a, d) => a + at(d), 0);
  const top = Math.max(1, ...days.map(at));
  return (
    <div className="grid gap-2 rounded-xl border bg-card p-3 sm:p-4" data-testid="product-site" data-site={s.host}>
      <p className="text-[15px] leading-snug text-foreground">
        <span className="font-semibold tabular-nums" data-testid="product-site-yesterday">
          {at(yesterday)} {at(yesterday) === 1 ? "view" : "views"}
        </span>{" "}
        yesterday on{" "}
        <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-4 hover:decoration-foreground">
          {s.label}
        </a>
        <span className="text-muted-foreground"> · {week} in the last 7 days</span>
      </p>
      <ul className="grid gap-1 text-xs tabular-nums">
        {days.map((d) => (
          <li key={d} className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-2" data-testid="product-site-day" data-day={d}>
            <span className={cn("text-muted-foreground", d === yesterday && "font-semibold text-foreground")}>{d === today ? "Today so far" : shortDay(d)}</span>
            <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className={cn("block h-full rounded-full", d === yesterday ? "bg-emerald-700" : "bg-foreground/30")} style={{ width: `${Math.round((at(d) / top) * 100)}%` }} />
            </span>
            <span className={cn("text-right", d === yesterday && "font-semibold")}>{at(d)}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-snug text-muted-foreground/80">Our own counter on {s.label}: one view per visitor and day, no cookie, crawlers and tests left out.</p>
    </div>
  );
}

/** /products: every defined product, one row each, opening its page. */
export function ProductsPage() {
  const { data, error, loading } = useQuery<ProductsBody>(() => api.listProducts(), []);
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-3" data-testid="products-page">
      <header className="grid gap-1 rounded-xl border bg-card p-3 shadow-sm sm:p-4" data-testid="products-answer">
        <h1 className="text-xl font-semibold tracking-tight sm:text-3xl">Products</h1>
        <p className="text-[15px] font-semibold leading-snug text-foreground">Each product is written once. Its {SET_NAME.many.toLowerCase()} and its social kit read it from here.</p>
      </header>
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the products…</div>}
      {error && <div className="text-sm text-destructive">Could not read the products: {error.message}</div>}
      {data && (
        <ul className="divide-y rounded-xl border bg-card">
          {data.products.map((p) => (
            <li key={p.id}>
              <Link to={productHref(p.id)} className="flex min-w-0 items-center gap-3 px-3 py-3 hover:bg-accent/40" data-testid="product-row" data-product={p.id}>
                <Mark p={p} size={36} />
                <span className="grid min-w-0 flex-1">
                  <span className="text-[15px] font-medium text-foreground">{p.name}</span>
                  {p.tagline && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.tagline}</span>}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {p.wheels.length} {p.wheels.length === 1 ? SET_NAME.one.toLowerCase() : SET_NAME.many.toLowerCase()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductKit({ id }: { id: string }) {
  const { data, error, loading } = useQuery<PursuitKitBody>(() => api.getProductKit(id), [id]);
  if (loading && !data) return <div className="text-sm text-muted-foreground">Opening the kit…</div>;
  if (error || !data) return <div className="text-sm text-destructive">Could not open the social kit{error ? `: ${error.message}` : ""}.</div>;
  return <SocialKitBody body={data} />;
}

/** /products/<id>: what it is (the deck's four parts), the objectives on it, and its social kit. */
export function ProductPage() {
  const id = useParams().id ?? "";
  const [params] = useSearchParams();
  const tab = params.get("tab") === "kit" ? "kit" : "table";
  const { data: p, error, loading } = useQuery<ProductView>(() => api.getProduct(id), [id]);
  const tabs = p?.kit ? TABS : TABS.filter((t) => t.id !== "kit");
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="product-page" data-product={id}>
      <nav className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Where you are">
        <Link to={`/${PRODUCTS_PATH}`} className="underline-offset-4 hover:underline">
          Products
        </Link>
        <span aria-hidden="true">›</span>
        <span className="text-foreground">{p?.name ?? id}</span>
      </nav>
      {loading && !p && <div className="text-sm text-muted-foreground">Reading the product…</div>}
      {error && (
        <div className="text-sm text-muted-foreground" data-testid="product-unknown">
          No product here. <Link to={`/${PRODUCTS_PATH}`} className="underline underline-offset-4">See every one</Link>
        </div>
      )}
      {p && (
        <>
          <header className="flex min-w-0 items-start gap-3 rounded-xl border border-l-[6px] bg-card p-3 shadow-sm sm:p-4" style={{ borderLeftColor: p.accent }} data-testid="product-answer">
            <Mark p={p} />
            <div className="grid min-w-0 gap-1">
              <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-3xl">{p.name}</h1>
              <p className="text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="product-line">
                {p.tagline ? `${p.tagline.replace(/[.!?]+$/, "")}. ` : ""}
                {p.wheels.length
                  ? `${p.wheels.length} ${p.wheels.length === 1 ? SET_NAME.one.toLowerCase() : SET_NAME.many.toLowerCase()} use${p.wheels.length === 1 ? "s" : ""} it.`
                  : ""}
              </p>
              {p.url && (
                <a href={p.url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">
                  {p.url.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          </header>
          <TabStrip tabs={tabs} tab={tab} label="Product pages" />
          {tab === "table" && (
            <div className="grid gap-4">
              <ProductSiteViews name={p.name} />
              <ProductParts p={p} />
              <section className="grid gap-2">
                <h2 className="text-sm font-semibold text-foreground">{SET_NAME.many} on it</h2>
                <Wheels p={p} />
              </section>
              <ProductSource p={p} />
            </div>
          )}
          {tab === "kit" && p.kit && <ProductKit id={p.id} />}
        </>
      )}
    </div>
  );
}
