import { Link } from "react-router-dom";
import { api, type LaunchBoard, type LaunchLight, type LaunchOwner, type LaunchProduct } from "@/api";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { useShows } from "@/lib/skin";
import { sites } from "@/lib/identity";
import { LAUNCH_PATH } from "@/lib/routePaths";
export { LAUNCH_PATH };

/**
 * the launch board inside the console. EpicTeam's Team home shows EpicTeam's lights, the social product's home
 * the social product's, and /launch every product. Every red names who fixes it, the epic that owns it (its deck) and why that
 * owner; the rule is written on the board. The lights come from GET /api/launch-board (the console runs the checks every
 * 30 minutes, server/src/launch/board.ts); the home world only: another world's home never shows it.
 */
/** the console the decks live on (this one) */
const consoleUrl = () => sites().teamUrl.replace(/\/+$/, "");

function Dot({ state }: { state: LaunchLight["state"] }) {
  return (
    <span
      className={cn("mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full", state === "green" ? "bg-emerald-600" : state === "red" ? "bg-red-600" : "border border-muted-foreground/50")}
      aria-label={state === "na" ? "not needed yet" : state}
    />
  );
}

/** The owning epic's deck: a console link where the deck routes (console skin), else the console's own address. */
function EpicLink({ epic }: { epic: NonNullable<LaunchOwner["epic"]> }) {
  const shows = useShows();
  const text = `${epic.code} ${epic.title}`;
  return shows("book") ? (
    <Link to={epic.deck} className="underline-offset-2 hover:underline" data-testid="launch-owner-epic">
      {text}
    </Link>
  ) : (
    <a href={consoleUrl() + epic.deck} className="underline-offset-2 hover:underline" data-testid="launch-owner-epic">
      {text}
    </a>
  );
}

function Owner({ o }: { o: LaunchOwner }) {
  const next = o.next;
  return (
    <div className="mt-1 grid gap-0.5 text-xs" data-testid="launch-owner">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="font-medium text-foreground">Owner: {o.who}</span>
        {o.epic && (
          <span className="text-muted-foreground">
            · <EpicLink epic={o.epic} />
          </span>
        )}
        {next &&
          (next.link ? (
            <a href={next.link} className="font-mono text-muted-foreground underline-offset-2 hover:underline" data-testid="launch-owner-next">
              · {next.code}
            </a>
          ) : (
            <span className="font-mono text-muted-foreground" data-testid="launch-owner-next">
              · {next.code} {next.state}
            </span>
          ))}
        {o.draft && <span className="rounded-full border border-amber-500/50 px-1.5 text-[11px] text-amber-800 dark:text-amber-300">no row yet</span>}
      </div>
      <div className="text-muted-foreground">{o.why}</div>
    </div>
  );
}

function RedLight({ l }: { l: LaunchLight }) {
  return (
    <li className="flex min-w-0 gap-2 py-2" data-testid="launch-red">
      <Dot state="red" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{l.label}</div>
        <div className="text-xs text-muted-foreground">{l.seen}</div>
        {l.fix && <div className="text-xs">{l.fix}</div>}
        {l.owner && <Owner o={l.owner} />}
      </div>
    </li>
  );
}

/** One product's lights: the reds with their owners, then the greens and the not-needed-yet lights in one line each. */
export function ProductLights({ p }: { p: LaunchProduct }) {
  const reds = p.lights.filter((l) => l.state === "red");
  const greens = p.lights.filter((l) => l.state === "green");
  const nas = p.lights.filter((l) => l.state === "na");
  return (
    <div className="grid gap-2" data-testid={`launch-product-${p.id}`}>
      {reds.length > 0 && <ul className="divide-y">{reds.map((l) => <RedLight key={l.label} l={l} />)}</ul>}
      {greens.length > 0 && (
        <details className="text-sm" data-testid="launch-greens">
          <summary className="cursor-pointer text-muted-foreground">{greens.length} green</summary>
          <ul className="mt-1 grid gap-1">
            {greens.map((l) => (
              <li key={l.label} className="flex min-w-0 gap-2">
                <Dot state="green" />
                <span className="min-w-0">
                  {l.label} <span className="text-xs text-muted-foreground">{l.seen}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {nas.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="launch-nas">
          Not needed yet: {nas.map((l) => l.label).join(", ")}.
        </p>
      )}
    </div>
  );
}

function Rule({ b }: { b: LaunchBoard }) {
  return b.ownerRule ? (
    <p className="border-l-2 border-emerald-700 pl-2 text-xs text-muted-foreground" data-testid="launch-rule">
      <span className="font-medium text-foreground">Who owns a red. </span>
      {b.ownerRule}
    </p>
  ) : null;
}

/** The Team home's section: this skin's product only, its score in the header, a link to every product. */
/** product: the launch board's product id (the team product, or the social product's name in lower case) */
export function LaunchLights({ product }: { product: string }) {
  const { data } = useQuery(() => api.getLaunchBoard(product), [product]);
  const [open, setOpen] = useSectionOpen(`launch-${product}`, true);
  const p = data?.board?.products[0];
  if (!data?.board || !p) return null;
  const reds = p.lights.filter((l) => l.state === "red").length;
  return (
    <FoldSection
      title={`Launch board: ${p.name}, ${p.greens} of ${p.total} lights green`}
      count={reds}
      tone="needs-you"
      testId="launch-lights"
      open={open}
      onToggle={setOpen}
      meta={
        <Link to={`/${LAUNCH_PATH}`} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline" data-testid="launch-all-link">
          Every product
        </Link>
      }
    >
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          Every light is a real check, run again every 30 minutes. Last check <RelTime iso={data.board.checkedAt} />.
          {data.error ? ` ${data.error}.` : ""}
        </p>
        <Rule b={data.board} />
        <ProductLights p={p} />
      </div>
    </FoldSection>
  );
}

/** /launch: every product's score, then each product's lights with their owners. */
export function LaunchBoardPage() {
  const q = useQuery(() => api.getLaunchBoard(), []);
  const b = q.data?.board;
  return (
    <>
      <PageHeader title="Launch board" description="A traffic light per product. Every red says who fixes it and why that owner." />
      {q.error && <ErrorBox error={q.error} />}
      {q.loading && <Loading />}
      {q.data && !b && <p className="text-sm text-muted-foreground">The first check is still running. Open this page again in a minute.</p>}
      {b && (
        <div className="grid gap-4" data-testid="launch-board">
          <p className="text-sm">
            <span className="text-[15px] font-semibold">
              {b.greens} of {b.total} lights are green.
            </span>{" "}
            <span className="text-muted-foreground">
              Checked <RelTime iso={b.checkedAt} />, again every 30 minutes.{q.data?.error ? ` ${q.data.error}.` : ""}
            </span>
          </p>
          <Rule b={b} />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="launch-scores">
            {b.products.map((p) => (
              <a key={p.id} href={`#${p.id}`} className="rounded-lg border bg-card px-3 py-2 hover:border-foreground/20" data-testid="launch-score">
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-xl tabular-nums">
                  {p.greens}
                  <span className="text-sm text-muted-foreground"> / {p.total}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted">
                  <div className="h-1.5 rounded-full bg-emerald-600" style={{ width: `${p.total ? Math.round((100 * p.greens) / p.total) : 0}%` }} />
                </div>
              </a>
            ))}
          </div>
          {b.products.map((p) => (
            <section key={p.id} id={p.id} className="min-w-0 rounded-lg border bg-card px-3 py-3 [overflow-wrap:anywhere]">
              <h2 className="flex flex-wrap items-baseline gap-x-2 text-base font-medium">
                {p.name}
                <span className="text-sm font-normal text-muted-foreground">
                  {p.greens} of {p.total} green · <a href={p.site} className="underline-offset-2 hover:underline">{p.site.split("//")[1]?.replace(/\/$/, "")}</a>
                </span>
              </h2>
              <ProductLights p={p} />
            </section>
          ))}
          {b.drafts.length > 0 && (
            <section className="rounded-lg border border-amber-500/40 bg-card px-3 py-3" data-testid="launch-drafts">
              <h2 className="text-sm font-medium">Reds with no row yet: the Delivery Manager drafts one at its next wake</h2>
              <ul className="mt-1 grid gap-1 text-sm">
                {b.drafts.map((d) => (
                  <li key={`${d.product}-${d.label}`}>
                    {d.product}: {d.label} <span className="text-xs text-muted-foreground">→ {d.world ? `the ${d.world} team, by a desk note` : d.epic}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
