import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { useSkin } from "@/lib/skin";
import { cn } from "@/lib/utils";
import { topObjectives, useGoalSets } from "@/components/goalRing";
import { MADE_OF_PATH, WHEEL_CLASS, WHEEL_TABS, type WheelKind, type WheelTab } from "@/lib/wheelTabs";

/**
 * "What an objective is made of" (the owner, vn_cdef45cd, 24 Nov: "it's almost as if you have a class which is
 * objective. And then you can implant an object which is objective ... these properties are like what each of these
 * properties is what showing me on the tabs ... It's both a UX and a data thing"). One sentence, the class drawn with its
 * objects, then one box per tab: what it holds, where it lives, who reads and writes it. Every word comes from the same
 * map the tabs come from (docs/totems/<product>.json `wheel`, through lib/wheelTabs.ts), so it can never disagree with
 * the tabs; scripts/totems.py check refuses a tab missing any of the four.
 */
export { MADE_OF_PATH };

/** the made-of screen for a kind of wheel: /made-of?class=objective|campaign (the skin's own kind by default). */
export const madeOfHref = (kind: WheelKind, tab?: string) => `/${MADE_OF_PATH}?class=${kind}${tab ? `#prop-${tab}` : ""}`;

/** the small "What is this?" beside a wheel's tab strip. */
export function MadeOfLink({ kind, className }: { kind: WheelKind; className?: string }) {
  return (
    <Link to={madeOfHref(kind)} className={cn("text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline", className)} data-testid="made-of-link">
      What are these tabs?
    </Link>
  );
}

function Chips({ items }: { items?: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {(items ?? []).map((x) => (
        <span key={x} className="rounded-full border px-2 py-0.5 text-xs">
          {x}
        </span>
      ))}
    </span>
  );
}

/** "repo · path" → the repo set apart from its path. */
function Lives({ text }: { text?: string }) {
  return (
    <span className="grid gap-1">
      {(text ?? "").split(/, and /).map((part) => {
        const [repo, ...rest] = part.split(" · ");
        return rest.length ? (
          <span key={part} className="text-sm">
            <span className="font-medium">{repo}</span>
            <span className="text-muted-foreground"> · </span>
            <code className="break-words font-mono text-[12px]">{rest.join(" · ")}</code>
          </span>
        ) : (
          <span key={part} className="text-sm">{part}</span>
        );
      })}
    </span>
  );
}

/** the class box: its name, then one line per property (tab), product data first marked apart from the console's own. */
function ClassBox({ kind, tabs }: { kind: WheelKind; tabs: readonly WheelTab[] }) {
  const cls = WHEEL_CLASS[kind];
  return (
    <div className="w-full max-w-xs rounded-lg border-2 border-foreground/80 bg-card" data-testid="made-of-class">
      <div className="border-b-2 border-foreground/80 px-3 py-2 text-center">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">class</div>
        <div className="text-lg font-semibold">{cls.name}</div>
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-1">
        {tabs.map((t) => (
          <li key={t.id} className="flex items-baseline gap-2 text-sm">
            <span className={cn("inline-block h-2 w-2 shrink-0 rounded-sm", t.kind === "data" ? "bg-emerald-700" : "bg-foreground/50")} aria-hidden="true" />
            <a href={`#prop-${t.id}`} className="underline-offset-4 hover:underline">
              {t.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** one object of the class: its own name, the same properties as small blocks, always the same shape. */
function ObjectNode({ name, to, tabs }: { name: string; to?: string; tabs: readonly WheelTab[] }) {
  const body = (
    <>
      <div className="truncate text-sm font-medium">{name}</div>
      <div className="mt-1.5 flex flex-wrap gap-1" aria-label={`${tabs.length} properties`}>
        {tabs.map((t) => (
          <span key={t.id} title={t.label} className={cn("h-2.5 w-4 rounded-sm", t.kind === "data" ? "bg-emerald-700" : "bg-foreground/40")} />
        ))}
      </div>
    </>
  );
  return to ? (
    <Link to={to} className="block min-w-0 rounded-md border bg-card px-3 py-2 hover:border-foreground/50" data-testid="made-of-object">
      {body}
    </Link>
  ) : (
    <div className="min-w-0 rounded-md border bg-card px-3 py-2" data-testid="made-of-object">
      {body}
    </div>
  );
}

function useObjects(kind: WheelKind): { name: string; to?: string }[] {
  const { data } = useGoalSets();
  // a campaign's objects are the campaigns of the app that has them; elsewhere the picture shows the shape alone.
  const campaigns = !!useSkin().campaigns;
  const { data: ms } = useQuery(() => (kind === "campaign" && campaigns ? api.listMilestones() : Promise.resolve([])), [kind, campaigns]);
  if (kind === "campaign") return (ms ?? []).slice(0, 3).map((m) => ({ name: m.title, to: `/milestones/${encodeURIComponent(m.id)}` }));
  return topObjectives(data?.nodes)
    .filter((n) => n.kind === "pursuit")
    .slice(0, 3)
    .map((n) => ({ name: n.headline ?? n.name, to: `/sets/${encodeURIComponent(n.id)}` }));
}

/** the drawn picture: the class on one side, its objects on the other, joined by "is an object of". */
function ClassDiagram({ kind, tabs }: { kind: WheelKind; tabs: readonly WheelTab[] }) {
  const cls = WHEEL_CLASS[kind];
  const objects = useObjects(kind);
  const shown = objects.length ? objects : [{ name: `One ${cls.name.toLowerCase()}` }, { name: `Another ${cls.name.toLowerCase()}` }];
  return (
    <figure className="grid items-center gap-3 rounded-xl border bg-muted/30 p-4 sm:grid-cols-[auto_auto_1fr] sm:gap-5" data-testid="made-of-diagram">
      <ClassBox kind={kind} tabs={tabs} />
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground sm:flex-col sm:gap-1" aria-hidden="true">
        <span className="sm:hidden">▲</span>
        <span className="whitespace-nowrap">is an object of</span>
        <span className="hidden items-center sm:flex">
          <span className="text-sm leading-none text-foreground/70">◀</span>
          <span className="h-px w-20 bg-foreground/60" />
        </span>
      </div>
      <div className="grid min-w-0 gap-2">
        {shown.map((o) => (
          <ObjectNode key={o.name} name={o.name} to={o.to} tabs={tabs} />
        ))}
        <p className="text-xs text-muted-foreground">
          Every {cls.name.toLowerCase()} has these {tabs.length} properties, never more or fewer. Only what is inside them differs.
        </p>
      </div>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground sm:col-span-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-700" /> this product's own data
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-foreground/50" /> the console's, the same on every product
        </span>
      </figcaption>
    </figure>
  );
}

function PropertyBox({ t, n }: { t: WheelTab; n: number }) {
  return (
    <section id={`prop-${t.id}`} className="scroll-mt-20 rounded-xl border bg-card p-4 target:ring-2 target:ring-emerald-700" data-testid="made-of-property">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold">
          <span className="mr-2 text-sm font-normal text-muted-foreground">{n}</span>
          {t.label}
        </h3>
        <span className={cn("shrink-0 text-[11px] uppercase tracking-wider", t.kind === "data" ? "text-emerald-700" : "text-muted-foreground")}>{t.kind === "data" ? "product data" : "console"}</span>
      </header>
      <p className="mt-1 text-sm">{t.holds}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[7rem_1fr]">
        <dt className="text-xs text-muted-foreground sm:pt-0.5">Lives in</dt>
        <dd className="min-w-0">
          <Lives text={t.lives} />
        </dd>
        <dt className="text-xs text-muted-foreground sm:pt-0.5">Read by</dt>
        <dd>
          <Chips items={t.reads} />
        </dd>
        <dt className="text-xs text-muted-foreground sm:pt-0.5">Written by</dt>
        <dd>
          <Chips items={t.writes} />
        </dd>
      </dl>
    </section>
  );
}

export function MadeOfPage() {
  const [params, setParams] = useSearchParams();
  const own: WheelKind = useSkin().campaigns ? "campaign" : "objective";
  const asked = params.get("class");
  const kind: WheelKind = asked === "campaign" || asked === "objective" ? asked : own;
  const cls = WHEEL_CLASS[kind];
  const tabs = WHEEL_TABS[kind];
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6 sm:px-6" data-testid="made-of">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">What {kind === "campaign" ? "a campaign" : "an objective"} is made of</h1>
          <div className="inline-flex rounded-md border p-0.5 text-sm" role="tablist" aria-label="Which class">
            {(["objective", "campaign"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={k === kind}
                onClick={() => setParams({ class: k })}
                className={cn("min-h-9 rounded px-3", k === kind ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
                data-testid={`made-of-class-${k}`}
              >
                {WHEEL_CLASS[k].name}
              </button>
            ))}
          </div>
        </div>
        <p className="rounded-lg border-l-4 border-emerald-700 bg-card px-4 py-3 text-base" data-testid="made-of-one">
          {cls.one}
        </p>
      </header>
      <ClassDiagram kind={kind} tabs={tabs} />
      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">Each property, one tab</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {tabs.map((t, i) => (
            <PropertyBox key={t.id} t={t} n={i + 1} />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Drawn from the same map the tabs are built from, so this page and the tabs always agree. The agents read it too: an
        agent writes only into one of these properties.
      </p>
    </div>
  );
}
