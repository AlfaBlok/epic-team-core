import { useCallback, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { CatalogRow, Milestone, MotionBody, PersonaSlide, ProductSlide, TargetView } from "@/api/types";
import { PageHeader } from "@/components/common";
import { ChatMarkdown } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { useCampaigns } from "@/lib/campaign";
import { useProject } from "@/lib/project";
import { worldId } from "@/lib/useSocial";
import { cn } from "@/lib/utils";
import { screenUrl, slideBlocks, statValue } from "@/lib/productSlide";
import { DeckNav, SLIDE_HEIGHT } from "./Totems";
import { PRODUCT_PATH } from "./nav";
import { Where } from "./SiteWhere";
import { ProductNoteBox, useProductNotes, type ProductSlideRef } from "./ProductNote";

/**
 * GET /api/tenants/:id/social/motion for the selected project:
 *  - ProductPage (PRODUCT_PATH): the product deck, one paper slide per part of data/product.md, paged like a campaign's
 *    Brief deck; separate from each campaign's deck;
 *  - Motion (on the Performance page): each campaign's target from the metrics catalog and where it stands, the catalog
 *    itself (a number with no source says "No source yet"), and one slide per role: the number it wakes to move, how,
 *    and the files it reads at each wake.
 */
export { PRODUCT_PATH } from "./nav";

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string | null) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "");

function useMotion(repoAsked?: string, campaign?: string) {
  const project = useProject();
  const repo = repoAsked ?? project.current?.repo;
  return useQuery(async () => api.getSocialMotion(await worldId(), repo, campaign), [repo ?? "", campaign ?? ""]);
}

/** who reads this, said in one line on both product pages (the wake's order, motionCompute READ_ORDER). */
export const READS_LINE = "Personas read this: the project's product deck first, then their campaign's product deck, then the targets and their role's line.";

/** `?slide=n` paging with the arrow keys (not while typing). */
function usePaged(total: number, param: string) {
  const [params, setParams] = useSearchParams();
  const i = Math.max(0, Math.min(Math.max(total, 1), Number(params.get(param)) || 1) - 1);
  const go = useCallback(
    (k: number) => {
      const next = new URLSearchParams(params);
      next.set(param, String(k + 1));
      setParams(next, { replace: true });
    },
    [params, setParams, param],
  );
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowLeft" && i > 0) go(i - 1);
      else if (e.key === "ArrowRight" && i < total - 1) go(i + 1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [i, total, go]);
  return { i, go };
}

/** A slide (the app's card, not paper); `grow`: on a phone it takes the height its content needs (a role's slide lists every file it reads), fixed from sm up. */
function Paper({ children, foot, n, total, testid, grow, deck }: { children: React.ReactNode; foot: React.ReactNode; n: number; total: number; testid: string; grow?: boolean; deck?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground", deck ? "min-h-[26rem] sm:min-h-[32rem]" : grow ? "min-h-[26rem] sm:h-[28rem]" : SLIDE_HEIGHT)} data-testid={testid}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-6 sm:px-10">
        {children}
        <div className="mt-auto flex flex-wrap justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="min-w-0 [overflow-wrap:anywhere]">{foot}</span>
          <span data-testid="slide-count">
            {n} / {total}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * one product deck slide as a claim (large type, the app's one face), big numbers (Stat lines, live ones read from the catalog or the
 * campaign's target) and real screens (Screen lines), then short Markdown proof (lib/productSlide).
 */
function SlideBody({ body, m, target }: { body: string; m: MotionBody; target?: number | null }) {
  const { lead, blocks } = slideBlocks(body);
  return (
    <div className="grid min-w-0 gap-4">
      {lead && (
        <p className="text-xl leading-snug [overflow-wrap:anywhere] sm:text-2xl" data-testid="slide-lead">
          {lead}
        </p>
      )}
      {blocks.map((b, k) =>
        b.kind === "stats" ? (
          <div key={k} className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="slide-stats">
            {b.items.map((s) => (
              <div key={s.label} className="min-w-0 border-l-4 border-emerald-700 pl-3" data-testid="slide-stat">
                <div className="text-4xl font-semibold tabular-nums leading-none text-emerald-800 dark:text-emerald-400 sm:text-5xl">{statValue(s.value, { target, catalog: m.catalog })}</div>
                <div className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{s.label}</div>
              </div>
            ))}
          </div>
        ) : b.kind === "screens" ? (
          <div key={k} className={cn("grid gap-3", b.items.length > 1 && "sm:grid-cols-2")} data-testid="slide-screens">
            {b.items.map((s) => {
              const url = screenUrl(s.src, m.tenantId, m.repo);
              return url ? (
                <figure key={s.src} className="min-w-0" data-testid="slide-screen">
                  <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border bg-white shadow-sm">
                    <img src={url} alt={s.caption} loading="lazy" className="h-40 w-full object-cover object-left-top sm:h-48" />
                  </a>
                  <figcaption className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.caption}</figcaption>
                </figure>
              ) : null;
            })}
          </div>
        ) : (
          <div key={k} className="min-w-0 text-[15px] [overflow-wrap:anywhere]" data-testid="slide-body">
            <ChatMarkdown text={b.text} />
          </div>
        ),
      )}
    </div>
  );
}

/**
 * a `Features:` slide, one group of the service's feature list (the code repo docs/features/<service>.json, drawn
 * live by the server): every line as a short claim and its proof sentence, two columns from sm up, the count in the corner.
 */
function FeatureGrid({ f }: { f: NonNullable<ProductSlide["features"]> }) {
  return (
    <div className="grid min-w-0 gap-2" data-testid="slide-features">
      <ul className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
        {f.items.map((x) => (
          <li key={x.id} className="min-w-0 border-l-2 border-emerald-700/60 pl-3" data-testid="slide-feature">
            <div className="text-[17px] font-semibold leading-snug [overflow-wrap:anywhere]">{x.title.replace(/\.$/, "")}</div>
            <p className="mt-0.5 text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere]">{x.text}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground" data-testid="slide-features-count">
        {f.items.length} {f.items.length === 1 ? "feature" : "features"}, from{" "}
        <a href={/^https:/.test(f.source) ? f.source : undefined} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
          the {f.service} feature list
        </a>
      </p>
    </div>
  );
}

/** `note`: what sits under the slide (a campaign's Product tab puts its note box there), keyed to the slide. */
export function ProductView({ m, deck = m.product, target, note }: { m: MotionBody; deck?: MotionBody["product"]; target?: number | null; note?: (s: ProductSlideRef) => React.ReactNode }) {
  const slides = deck.slides;
  const { i, go } = usePaged(slides.length, "slide");
  const s = slides[i];
  if (!slides.length)
    return (
      <div className="rounded-xl border p-4 text-sm text-muted-foreground" data-testid="product-missing">
        {m.repo ? `${m.repo} has no ${deck === m.product ? "product deck" : "product deck for this campaign"} yet: ${deck.file} is where it goes, one part per slide (${deck.missing.join(", ")}).` : "Pick a project to see its product deck."}
      </div>
    );
  return (
    <div className="grid gap-3" data-testid="product-deck">
      <Paper n={i + 1} total={slides.length} testid="product-slide" deck foot={`${deck.title ?? "Product deck"} · ${m.repo}/${deck.file}`}>
        <h3 className="min-w-0 text-2xl font-semibold [overflow-wrap:anywhere] sm:text-3xl" data-testid="slide-title">
          {s.title}
        </h3>
        <SlideBody body={s.body} m={m} target={target} />
        {s.features && <FeatureGrid f={s.features} />}
      </Paper>
      <DeckNav i={i} total={slides.length} go={go} />
      <ol className="flex flex-wrap justify-center gap-1.5 text-xs" aria-label="Slides" data-testid="product-index">
        {slides.map((x, k) => (
          <li key={x.title}>
            <button type="button" onClick={() => go(k)} className={cn("rounded-full border px-2.5 py-1", k === i ? "border-emerald-700 bg-emerald-700 text-white" : "text-muted-foreground hover:bg-muted")}>
              {k + 1}. {x.title}
            </button>
          </li>
        ))}
      </ol>
      {note?.({ n: i + 1, title: s.part ?? s.title, file: deck.file })}
      {deck.missing.length > 0 && (
        <p className="text-center text-xs text-muted-foreground" data-testid="product-gaps">
          Not written yet: {deck.missing.join(", ")}.
        </p>
      )}
    </div>
  );
}

/** "Personas read this" under a product deck's title. */
function ReadsLine() {
  return (
    <p className="mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="reads-line">
      {READS_LINE}
    </p>
  );
}

/** Project › Product at the top of the project's product page (a campaign's tabs carry Project › Campaign › Tab). */
export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground" data-testid="crumbs">
      {items.map((c, k) => (
        <span key={`${k}-${c.label}`} className="flex min-w-0 items-center gap-x-1.5">
          {k > 0 && <span aria-hidden>›</span>}
          {c.to ? (
            <Link to={c.to} className="min-w-0 hover:text-foreground hover:underline [overflow-wrap:anywhere]">
              {c.label}
            </Link>
          ) : (
            <span className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]" aria-current="page">
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The project's campaigns, each opening its own Product tab. */
function CampaignDecks({ repo }: { repo: string | null }) {
  const { data } = useCampaigns();
  const cards = (data?.campaigns ?? []).filter((c) => c.campaign && c.milestoneId && !c.retired && c.repo === repo);
  if (!cards.length) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" data-testid="campaign-decks">
      <span className="text-muted-foreground">Each campaign's own product deck:</span>
      {cards.map((c) => (
        <Link key={c.milestoneId} to={`/milestones/${encodeURIComponent(c.milestoneId!)}?tab=product`} className="rounded-full border px-2.5 py-1 hover:bg-muted" data-testid="campaign-deck-link">
          {c.campaign!.name} ›
        </Link>
      ))}
    </div>
  );
}

export function ProductPage() {
  const { data, error } = useMotion();
  const project = useProject();
  return (
    <div data-testid="product-page">
      {project.current && <Crumbs items={[{ label: project.current.name, to: `/?project=${encodeURIComponent(project.current.repo)}` }, { label: "Product" }]} />}
      <PageHeader
        title="Product"
        description="What the project sells, to whom and for how much: the landing page as a deck. Each campaign narrows it in its own Product tab."
      />
      <ReadsLine />
      {error ? <div className="rounded-xl border p-3 text-sm text-muted-foreground">The product deck could not load: {error.message}</div> : data ? <ProductView m={data} /> : <div className="text-sm text-muted-foreground">Loading…</div>}
      {data && <CampaignDecks repo={data.repo} />}
      {/* targets, who moves what and the catalog live here, under the deck, not at the top of Performance (the owner 2026-11-08). */}
      <div className="mt-8">
        <Motion />
      </div>
    </div>
  );
}

/**
 * a campaign's Product tab, its own product deck
 * (docs/campaigns/<epic-n>/product.md), with its target and a link up to the project's deck. A repo-level page (no
 * campaign code) shows the project's deck.
 */
export function CampaignProductTab({ repo, code, m }: { repo: string; code?: string; m?: Pick<Milestone, "id"> }) {
  const { data, error } = useMotion(repo, code);
  const own = data?.campaignProduct;
  const target = code ? data?.targets.find((t) => t.code.toUpperCase() === code.toUpperCase()) : undefined;
  return (
    <div className="grid gap-3" data-testid="campaign-product">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{own ? `What ${own.name} pushes` : "The project's product"}</h2>
        <Link to={`/${PRODUCT_PATH}?project=${encodeURIComponent(repo)}`} className="text-sm text-muted-foreground underline hover:text-foreground" data-testid="project-product-link">
          The project's product deck ›
        </Link>
      </div>
      <ReadsLine />
      {error ? (
        <div className="rounded-xl border p-3 text-sm text-muted-foreground">The product deck could not load: {error.message}</div>
      ) : !data ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : m ? (
        <NotedProductView m={m} data={data} deck={own ?? undefined} target={own ? target?.now : undefined} />
      ) : (
        <ProductView m={data} deck={own ?? undefined} target={own ? target?.now : undefined} />
      )}
      {target && <TargetsView targets={[target]} />}
    </div>
  );
}

/** a campaign's product deck with the note box under each slide and the notes already filed on it. */
function NotedProductView({ m, data, deck, target }: { m: Pick<Milestone, "id">; data: MotionBody; deck?: MotionBody["product"]; target?: number | null }) {
  const notes = useProductNotes(m);
  return <ProductView m={data} deck={deck} target={target} note={(s: ProductSlideRef) => <ProductNoteBox key={`${s.file}:${s.title}`} m={m} s={s} notes={notes.all} onFiled={notes.add} />} />;
}

function Progress({ now, target }: { now: number | null; target: number }) {
  const pct = now === null ? 0 : Math.min(100, Math.round((now / Math.max(1, target)) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${pct}% of the target`}>
      <div className="h-full rounded-full bg-emerald-700" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function TargetsView({ targets }: { targets: TargetView[] }) {
  return (
    <section className="mb-6 rounded-xl border bg-card" data-testid="targets">
      <div className="flex min-h-11 flex-wrap items-baseline gap-x-2 px-3 py-2">
        <h2 className="text-[15px] font-semibold">Targets</h2>
        <span className="text-xs text-muted-foreground">Each campaign moves one number from the catalog. Its spine's Metric line sets it.</span>
      </div>
      <div className="grid grid-cols-1 gap-2 border-t px-3 py-4 sm:grid-cols-2">
        {targets.length === 0 && <p className="text-sm text-muted-foreground">No campaign has a target yet.</p>}
        {targets.map((t) => (
          <div key={t.spine} className="min-w-0 rounded-lg border p-3" data-testid="target">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
                {t.code} {t.name}
              </span>
              {t.proposed && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-300">proposed, you set it</span>}
            </div>
            {t.metric && t.target !== null ? (
              <>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-2xl font-semibold tabular-nums" data-testid="target-now">
                    {t.source === null ? "–" : fmt(t.now)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    of {fmt(t.target)} {t.label?.toLowerCase()}
                    {t.by ? ` by ${short(t.by)}` : ""}
                  </span>
                </div>
                {!!t.where?.length && (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="target-where">
                    Counts on <Where where={t.where} />
                  </p>
                )}
                <div className="mt-2">
                  <Progress now={t.now} target={t.target} />
                </div>
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
                  {t.from ? `Counted since ${short(t.from)}. ` : ""}Source: {t.source ?? "no source yet"}
                  {t.sourceNote ? `. ${t.sourceNote}.` : ""}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{t.unknown ? `Its Metric line names a number not in the catalog: ${t.unknown}` : "No target yet."}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function CatalogView({ catalog }: { catalog: CatalogRow[] }) {
  return (
    <section className="mb-6 rounded-xl border bg-card" data-testid="catalog">
      <div className="flex min-h-11 flex-wrap items-baseline gap-x-2 px-3 py-2">
        <h2 className="text-[15px] font-semibold">Metrics catalog</h2>
        <span className="text-xs text-muted-foreground">The one list of numbers a campaign may target. All time, or the latest reading.</span>
      </div>
      <ul className="divide-y border-t">
        {catalog.map((c) => (
          <li key={c.id} className="flex min-w-0 items-baseline gap-3 px-3 py-2" data-testid="catalog-row">
            <span className="w-14 shrink-0 text-right text-base font-semibold tabular-nums">{c.source === null ? "" : fmt(c.now)}</span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-medium">{c.label}</span>
              {!!c.where?.length && (
                <span className="block text-xs text-muted-foreground" data-testid="catalog-where">
                  Counts on <Where where={c.where} />
                </span>
              )}
              <span className="block text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{c.source ? `Source: ${c.source}${c.sourceNote ? `. ${c.sourceNote}.` : ""}` : "No source yet"}</span>
            </span>
            <code className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{c.id}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PersonaDeck({ personas }: { personas: PersonaSlide[] }) {
  const { i, go } = usePaged(personas.length, "role");
  const p = personas[i];
  if (!p) return null;
  return (
    <section className="mb-6 grid gap-3" data-testid="persona-deck">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[15px] font-semibold">Who moves what</h2>
        <span className="text-xs text-muted-foreground">One slide per role: the number it wakes to move and the files it reads.</span>
      </div>
      <Paper n={i + 1} total={personas.length} testid="persona-slide" foot="data/metrics.md · Who moves what" grow>
        <h3 className="text-2xl font-semibold sm:text-3xl" data-testid="slide-title">
          {p.role}
        </h3>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wakes to move</div>
            {p.moves.length ? (
              <ul className="mt-1 grid gap-2">
                {p.moves.map((x) => (
                  <li key={x.code} className="rounded-lg border border-emerald-700/40 bg-background/60 p-2.5">
                    <div className="text-sm">
                      <span className="font-semibold">{x.code}</span> {x.name}
                    </div>
                    <div className="text-lg font-semibold tabular-nums">
                      {fmt(x.now)} <span className="text-sm font-normal text-muted-foreground">of {fmt(x.target)} {x.label.toLowerCase()}{x.by ? ` by ${short(x.by)}` : ""}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">No campaign target yet.</p>
            )}
            <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Its own number</div>
            <p className="text-sm">
              {p.leverLabel}: <span className="font-semibold tabular-nums">{fmt(p.leverNow)}</span>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">It {p.how}.</p>
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reads at each wake</div>
            <ol className="mt-1 grid gap-1 text-sm" data-testid="persona-files">
              {p.files.map((f, k) => (
                <li key={f} className="flex min-w-0 gap-2">
                  <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{k + 1}</span>
                  <code className="min-w-0 [overflow-wrap:anywhere]">{f}</code>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </Paper>
      <DeckNav i={i} total={personas.length} go={go} />
    </section>
  );
}

/** Under the product deck: targets, the persona slides, the catalog (the selected project). */
export function Motion() {
  const { data, error } = useMotion();
  if (error)
    return (
      <div className="mb-6 rounded-xl border p-3 text-sm text-muted-foreground" data-testid="motion-error">
        The targets could not load: {error.message}
      </div>
    );
  if (!data || !data.repo) return null;
  return (
    <div data-testid="motion">
      <TargetsView targets={data.targets} />
      <PersonaDeck personas={data.personas} />
      <CatalogView catalog={data.catalog} />
    </div>
  );
}
