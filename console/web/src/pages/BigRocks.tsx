import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, type BigRock } from "@/api";
import { useQuery } from "@/lib/data";
import { DECK_PATH, PAPER, SERIF, epicLabel } from "@/lib/deck";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { RocksAboutBlock } from "@/components/pageAbout";
import { ownerName } from "@/lib/identity";
import { ROCKS_PAGE_PATH } from "@/lib/routePaths";
export { ROCKS_PAGE_PATH };

/**
 * the big rocks board, the heavy themes the owner keeps repeating in his voice notes, from the repo
 * file docs/big-rocks.md (GET /api/rocks, server deck/bigRocks.ts). The board leads with a diagram (how often each rock
 * comes back), then one card per rock: what we want, why it weighs, the epics it maps to (each opens its deck) and the
 * voice notes that carry it, quoted. `/rocks`, `#R<n>` opens one rock.
 */

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** How often each rock comes back: one bar per rock, heavy ones in the deep green. */
function RockBars({ rocks }: { rocks: BigRock[] }) {
  const max = Math.max(...rocks.map((r) => r.frequency.notes), 1);
  return (
    <ol className="grid gap-1.5" data-testid="rocks-bars" aria-label="How often each rock comes back">
      {rocks.map((r) => (
        <li key={r.id} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 text-sm sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]">
          <a href={`#${r.id}`} className="truncate hover:underline" title={r.name}>
            {r.name}
          </a>
          <span className="h-3 rounded-sm" style={{ background: PAPER.quietFill }} aria-hidden>
            <span className="block h-3 rounded-sm" style={{ width: `${Math.round((r.frequency.notes / max) * 100)}%`, background: r.weight === "heavy" ? PAPER.focusLine : PAPER.quietLine }} />
          </span>
          <span className="text-xs tabular-nums" style={{ color: PAPER.muted }}>
            {r.frequency.notes} notes
          </span>
        </li>
      ))}
    </ol>
  );
}

function RockCard({ r, open }: { r: BigRock; open: boolean }) {
  const [all, setAll] = useState(open);
  const shown = all ? r.evidence : r.evidence.slice(0, 2);
  return (
    <article id={r.id} className="min-w-0 scroll-mt-20 rounded-lg px-4 py-3" style={{ background: PAPER.card, border: `1px solid ${r.weight === "heavy" ? PAPER.focusLine : PAPER.line}`, color: PAPER.ink }} data-testid="rock">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-lg font-semibold" style={{ fontFamily: SERIF }}>
          <span className="mr-2 text-sm font-normal" style={{ color: PAPER.muted }}>
            {r.id}
          </span>
          {r.name}
        </h2>
        <span className="text-xs" style={{ color: r.weight === "heavy" ? PAPER.focusInk : PAPER.muted }} data-testid="rock-frequency">
          {r.weight} · {r.frequency.notes} notes on {r.frequency.days} days
          {r.frequency.first && r.frequency.last ? `, ${day(r.frequency.first)} to ${day(r.frequency.last)}` : ""}
        </span>
      </div>
      <p className="mt-1">{r.want}</p>
      {r.why && (
        <p className="mt-1 text-sm" style={{ color: PAPER.muted }}>
          {r.why}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="rock-epics">
        <span style={{ color: PAPER.muted }}>Decks:</span>
        {r.decks?.length ? (
          r.decks.map((d) => (
            <Link key={d.href} to={d.href} className="rounded px-1.5 py-0.5 hover:underline" style={{ background: PAPER.focusFill, color: PAPER.focusInk, border: `1px solid ${PAPER.focusLine}` }}>
              {d.title}
            </Link>
          ))
        ) : (
          <span>{r.epics.length ? r.epics.map(epicLabel).join(", ") : "no epic yet"}</span>
        )}
      </div>
      <ul className="mt-2 grid gap-1.5" data-testid="rock-evidence">
        {shown.map((e, i) => (
          <li key={i} className="text-sm">
            <span className="mr-1 text-xs" style={{ color: PAPER.muted }}>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noreferrer" className="underline">
                  {day(e.date)}
                </a>
              ) : (
                day(e.date)
              )}
            </span>
            <span className="italic">“{e.quote}”</span>
          </li>
        ))}
      </ul>
      {r.evidence.length > 2 && (
        <button type="button" className="mt-1 text-xs underline" style={{ color: PAPER.muted }} onClick={() => setAll(!all)}>
          {all ? "Fewer notes" : `All ${r.evidence.length} notes`}
        </button>
      )}
    </article>
  );
}

export function BigRocksPage() {
  const { data, error, loading } = useQuery(() => api.getBigRocks(), []);
  const hash = useLocation().hash.slice(1);
  const ready = !!data?.rocks;
  useEffect(() => {
    if (hash && ready) document.getElementById(hash)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [hash, ready]);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const b = data?.rocks;
  if (!b) return <Empty>The big rocks board is not in the repo yet ({data?.file ?? "docs/big-rocks.md"}).</Empty>;
  return (
    <div className="mx-auto min-w-0 max-w-5xl" data-testid="big-rocks">
      <PageHeader
        title="Big rocks"
        description={
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <span>The heavy themes {ownerName()} keeps coming back to in his voice notes. Each one sits on the first slide of the decks it touches.</span>
            <Link to={`/${DECK_PATH}`} className="underline">
              Epic decks
            </Link>
          </span>
        }
      />
      {data?.about && <RocksAboutBlock r={data.about} />}
      <section className="mb-4 grid gap-3 rounded-xl px-4 py-4 sm:px-6" style={{ background: PAPER.bg, border: `1px solid ${PAPER.quietLine}`, color: PAPER.ink }} data-testid="rocks-head">
        <div className="text-sm" style={{ color: PAPER.muted }}>
          {b.read}
          {b.window ? ` · ${b.window}` : ""}
          {b.lastRead ? ` · read ${day(b.lastRead)}` : ""}
        </div>
        <RockBars rocks={b.rocks} />
        {b.note && (
          <p className="text-xs" style={{ color: PAPER.muted }}>
            {b.note}
          </p>
        )}
      </section>
      <div className="grid gap-3">
        {b.rocks.map((r) => (
          <RockCard key={r.id} r={r} open={hash === r.id} />
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        {b.method} Source: {b.file} in {b.repo}.
      </p>
    </div>
  );
}
