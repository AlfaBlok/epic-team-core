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
 * properties is what showing me on the tabs ... It's both a UX and a data thing"). Iteration 2 (his card note, 24 Nov
 * 12:56Z: "a chapter of the knowledge linked to the objective. 10 chapters"): the say-back in one line, the objective drawn
 * as one book with its contents, the words he picks from, then one box per tab: what it holds, where it lives, who reads
 * and writes it. Every word comes from the same
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
      What are these chapters?
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

function useObjects(kind: WheelKind): { name: string; to?: string }[] {
  const { data } = useGoalSets();
  // a campaign's objects are the campaigns of the app that has them; elsewhere the picture shows the shape alone.
  const campaigns = !!useSkin().campaigns;
  const { data: ms } = useQuery(() => (kind === "campaign" && campaigns ? api.listMilestones() : Promise.resolve([])), [kind, campaigns]);
  if (kind === "campaign") return (ms ?? []).slice(0, 4).map((m) => ({ name: m.title, to: `/milestones/${encodeURIComponent(m.id)}` }));
  return topObjectives(data?.nodes)
    .filter((n) => n.kind === "pursuit")
    .slice(0, 4)
    .map((n) => ({ name: n.headline ?? n.name, to: `/sets/${encodeURIComponent(n.id)}` }));
}

/**
 * The owner's card note (24 Nov 12:56Z): "It's like a chapter of the knowledge linked to the objective. 10
 * chapters. Each including relevant part of the knowledge required for agents to roll towards objective." Drawn as one
 * book: the objective on its cover, its contents in order, each line saying what knowledge it holds for the agents.
 */
function Book({ kind, tabs }: { kind: WheelKind; tabs: readonly WheelTab[] }) {
  const cls = WHEEL_CLASS[kind];
  const objects = useObjects(kind);
  const [first, ...rest] = objects;
  return (
    <figure className="grid gap-3" data-testid="made-of-diagram">
      <div className="rounded-r-xl rounded-l-sm border border-l-[6px] border-foreground/70 bg-card" data-testid="made-of-book">
        <div className="border-b px-4 py-3 sm:px-6">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{cls.name}</div>
          <div className="text-lg font-semibold">
            {first?.to ? (
              <Link to={first.to} className="text-foreground no-underline hover:underline">
                {first.name}
              </Link>
            ) : (
              first?.name ?? `Any ${cls.name.toLowerCase()}`
            )}
          </div>
        </div>
        <div className="px-4 py-3 sm:px-6">
          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Contents</div>
          <ol className="grid" data-testid="made-of-contents">
            {tabs.map((t, i) => (
              <li key={t.id} className="border-b border-dashed py-2 last:border-b-0" data-testid="made-of-chapter">
                <div className="flex items-baseline gap-3">
                  <span className="w-6 shrink-0 text-right font-mono text-sm text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <a href={`#prop-${t.id}`} className="inline-flex min-h-[44px] min-w-[44px] items-center font-semibold">
                        {t.label}
                      </a>
                      {t.kind === "data" && <span className="text-[11px] uppercase tracking-wider text-emerald-700">this product's own</span>}
                    </span>
                    <span className="block text-sm text-muted-foreground">{t.knows ?? t.holds}</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <figcaption className="text-sm text-muted-foreground">
        Every {cls.name.toLowerCase()} has the same {tabs.length} chapters, in the same order, one tab each. Only what is written in them differs.
        {rest.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-1.5" data-testid="made-of-objects">
            {rest.map((o) => (
              <Link key={o.name} to={o.to ?? "#"} className="rounded-full border px-2 py-0.5 text-xs text-foreground hover:border-foreground/50">
                {o.name}
              </Link>
            ))}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

function ChapterBox({ t, n }: { t: WheelTab; n: number }) {
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
        <p className="rounded-lg border-l-4 border-emerald-700 bg-card px-4 py-3 text-base" data-testid="made-of-understood">
          {cls.understood ?? cls.one}
        </p>
      </header>
      <Book kind={kind} tabs={tabs} />
      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">Where each chapter lives, who reads and writes it</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {tabs.map((t, i) => (
            <ChapterBox key={t.id} t={t} n={i + 1} />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Drawn from the same map the chapter tabs are built from, so this page and the tabs always agree. The agents read it too: an
        agent writes only into one of these {tabs.length} chapters.
      </p>
    </div>
  );
}
