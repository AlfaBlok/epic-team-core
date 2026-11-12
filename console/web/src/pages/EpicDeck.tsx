import { useCallback, useEffect, type CSSProperties, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { api, type BookState, type DeckListItem, type DeckLive, type EpicDeck } from "@/api";
import { useQuery } from "@/lib/data";
import { useLiveBook } from "@/lib/useLiveBook";
import { planRows } from "@/lib/book";
import { DECK_ALL_PATH, DECK_PATH, PAPER, ROCKS_PATH, SERIF, deckHref } from "@/lib/deck";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty, ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { DeckAboutBlock } from "@/components/pageAbout";
import { MadeList } from "@/components/bookMade";
import { ownerName, homeRepo } from "@/lib/identity";

/**
 * the epic deck, one numbered slide deck per high-level epic (L-19), in the house paper style
 * (L-49), built on the server from the spine (GET /api/deck/:repo/:code, deck/build.ts; the repo is the source, L-45).
 * Slide 1 is the big rocks the epic serves; then what and why, where we are, what we just did, how we measure
 * it and the trend, the plan, the decisions landed, what waits on the owner, and everything made for it. Every diagram is
 * drawn here from that data, never by hand. The deck replaces the Epic Book; every old
 * /book link leads here (pages/BookRedirect.tsx) and the book's index lives on as "Every epic" (/deck/all).
 * `/deck/<repo>/<code>` (stable: the spine's code), `?slide=<n>` or `?slide=<key>` (`where`, `made`…); `/deck` lists the decks.
 */
export const EPIC_DECK_PATH = `${DECK_PATH}/:repo/:code`;
export const DECK_INDEX_PATH = DECK_PATH;

/** One height for every slide, so Previous and Next never move (as the campaign Brief deck). */
const SLIDE_HEIGHT = "h-[34rem] sm:h-[32rem]";

const STATE_WORD: Record<BookState, string> = { moving: "Moving", stuck: "Waiting on someone", parked: "Parked", done: "Done" };
const STATE_COLOR: Record<BookState, string> = { moving: PAPER.focusLine, stuck: PAPER.warn, parked: PAPER.quietLine, done: PAPER.ink };

const box = (focus = false): CSSProperties => ({
  background: focus ? PAPER.focusFill : PAPER.card,
  border: `1px solid ${focus ? PAPER.focusLine : PAPER.line}`,
  color: focus ? PAPER.focusInk : PAPER.ink,
});
const quiet: CSSProperties = { background: PAPER.quietFill, border: `1px solid ${PAPER.quietLine}`, color: PAPER.muted };
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function Box({ children, focus, className, style, testId }: { children: ReactNode; focus?: boolean; className?: string; style?: CSSProperties; testId?: string }) {
  return (
    <div className={cn("min-w-0 rounded-md px-3 py-2 [overflow-wrap:anywhere]", className)} style={{ ...box(focus), ...style }} data-testid={testId}>
      {children}
    </div>
  );
}

/** A thin down arrow between two boxes (the diagrams stack on a phone). */
function Down() {
  return (
    <div className="flex justify-center" aria-hidden>
      <svg width="12" height="20" viewBox="0 0 12 20">
        <line x1="6" y1="0" x2="6" y2="15" stroke={PAPER.line} strokeWidth="1" />
        <path d="M2 12 L6 18 L10 12" fill="none" stroke={PAPER.line} strokeWidth="1" />
      </svg>
    </div>
  );
}

interface Slide {
  key: string;
  title: string;
  /** Where in the spine it comes from (the slide's footer). */
  source: string;
  body: ReactNode;
}

function RocksSlide({ d }: { d: EpicDeck }) {
  if (!d.rocks.length)
    return (
      <div className="grid gap-3" data-testid="deck-rocks-none">
        <Box focus>{d.title}</Box>
        <p style={{ color: PAPER.muted }}>
          None of {ownerName()}'s big rocks names this epic yet. The board lists them all:{" "}
          <Link className="underline" to={`/${ROCKS_PATH}`}>
            Big rocks
          </Link>
          .
        </p>
      </div>
    );
  const max = Math.max(...d.rocks.map((r) => r.frequency.notes), 1);
  return (
    <div className="grid gap-2" data-testid="deck-rocks">
      <Box focus className="text-center font-medium">
        {d.title}
      </Box>
      <Down />
      <div className="grid gap-2 sm:grid-cols-2">
        {d.rocks.map((r) => (
          <Link key={r.id} to={`/${ROCKS_PATH}#${r.id}`} className="block min-w-0 rounded-md px-3 py-2 hover:opacity-90" style={box(false)} data-testid="deck-rock">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold" style={{ fontFamily: SERIF }}>
                {r.name}
              </span>
              <span className="shrink-0 text-xs" style={{ color: PAPER.muted }}>
                {r.weight}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full" style={{ background: PAPER.quietFill }} aria-hidden>
              <div className="h-1.5 rounded-full" style={{ width: `${Math.round((r.frequency.notes / max) * 100)}%`, background: r.weight === "heavy" ? PAPER.focusLine : PAPER.quietLine }} />
            </div>
            <div className="mt-1 text-xs" style={{ color: PAPER.muted }}>
              {r.frequency.notes} notes on {r.frequency.days} days
              {r.frequency.last ? `, last ${day(r.frequency.last)}` : ""}
            </div>
            {r.evidence[0] && <div className="mt-1 text-sm italic">“{r.evidence[0].quote}”</div>}
          </Link>
        ))}
      </div>
    </div>
  );
}

function WhatWhySlide({ d }: { d: EpicDeck }) {
  return (
    <div className="grid gap-1" data-testid="deck-what">
      <Box focus>
        <div className="text-xs uppercase tracking-wide">What we want</div>
        <div className="text-base">{d.goal ?? "The spine has no Goal written yet."}</div>
      </Box>
      <Down />
      <Box>
        <div className="text-xs uppercase tracking-wide" style={{ color: PAPER.muted }}>
          Why: what it serves
        </div>
        <div>{d.serves ?? "The spine names nothing it serves yet."}</div>
      </Box>
      <Down />
      <Box style={quiet}>
        <span className="font-medium" style={{ color: STATE_COLOR[d.state] }}>
          {STATE_WORD[d.state]}
        </span>
        {d.measure.goalsTotal > 0 && ` · ${d.measure.goalsMet} of ${d.measure.goalsTotal} goals met`}
        {d.outcome && <div className="mt-1">Outcome: {d.outcome}</div>}
      </Box>
    </div>
  );
}

function WhereSlide({ d }: { d: EpicDeck }) {
  const here = d.goals.findIndex((g) => !g.done);
  return (
    <div className="grid gap-3" data-testid="deck-where">
      {d.goals.length ? (
        <ol className="relative grid gap-2 pl-6" data-testid="deck-track">
          <span className="absolute bottom-2 left-[9px] top-2 w-px" style={{ background: PAPER.line }} aria-hidden />
          {d.goals.map((g, i) => (
            <li key={g.id} className="relative" data-done={g.done ? "" : undefined}>
              <span
                className="absolute -left-6 top-1 h-[19px] w-[19px] rounded-full"
                style={{ background: g.done ? PAPER.focusLine : PAPER.card, border: `1px solid ${g.done ? PAPER.focusLine : PAPER.line}`, boxShadow: i === here ? `0 0 0 3px ${PAPER.focusFill}` : undefined }}
                aria-hidden
              />
              <span className="text-xs" style={{ color: PAPER.muted }}>
                {g.id}
                {g.done ? " · met" : i === here ? " · we are here" : ""}
              </span>
              <div className={cn("text-sm", g.done && "opacity-80")}>{g.text}</div>
            </li>
          ))}
        </ol>
      ) : (
        <p style={{ color: PAPER.muted }}>This spine has no Done means yet.</p>
      )}
      <div className="grid gap-1 text-sm">
        {d.whereWeAre.slice(0, 3).map((t, i) => (
          <p key={i}>{t}</p>
        ))}
      </div>
    </div>
  );
}

function JustDidSlide({ d }: { d: EpicDeck }) {
  if (!d.justDid.length) return <p style={{ color: PAPER.muted }}>Nothing changed on this epic in the last 120 days.</p>;
  return (
    <ol className="relative grid gap-3 pl-6" data-testid="deck-timeline">
      <span className="absolute bottom-1 left-[6px] top-1 w-px" style={{ background: PAPER.line }} aria-hidden />
      {d.justDid.map((e, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-6 top-1.5 h-[13px] w-[13px] rounded-full" style={{ background: i === 0 ? PAPER.focusLine : PAPER.card, border: `1px solid ${i === 0 ? PAPER.focusLine : PAPER.line}` }} aria-hidden />
          <div className="text-xs" style={{ color: PAPER.muted }}>
            {day(e.date)} · {e.code} · {e.kind === "decision" ? "decided" : "changed"}
          </div>
          <div className="text-sm">{e.text}</div>
        </li>
      ))}
    </ol>
  );
}

/** Bars of changes per week, and the deck's own trend of goals met (from its lines in the repo). */
function MeasureSlide({ d }: { d: EpicDeck }) {
  const m = d.measure;
  const total = Object.values(m.epics).reduce((a, b) => a + b, 0);
  const tiles: [string, string, boolean][] = [
    ["Goals met", m.goalsTotal ? `${m.goalsMet} of ${m.goalsTotal}` : "none written", true],
    ["Goals of the epics under it", m.subGoals.total ? `${m.subGoals.done} of ${m.subGoals.total}` : "none", false],
    ["Epics under it", total ? `${m.epics.done} done, ${m.epics.moving} moving, ${m.epics.stuck} waiting` : "none", false],
    ["Questions waiting on you", String(m.asksOnJordi), false],
  ];
  const maxW = Math.max(...m.weekly.map((w) => w.n), 1);
  const W = 320;
  const H = 90;
  const bw = W / Math.max(m.weekly.length, 1);
  const t = m.trend;
  const tMax = Math.max(...t.map((p) => p.goalsTotal), 1);
  return (
    <div className="grid gap-3" data-testid="deck-measure">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map(([label, value, focus]) => (
          <Box key={label} focus={focus} testId="deck-kpi">
            <div className="text-xs" style={{ color: focus ? PAPER.focusInk : PAPER.muted }}>
              {label}
            </div>
            <div className="text-lg font-semibold" style={{ fontFamily: SERIF }}>
              {value}
            </div>
          </Box>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <div className="text-xs" style={{ color: PAPER.muted }}>
            Recent changes per week (the newest 15 per epic)
          </div>
          <svg viewBox={`0 0 ${W} ${H + 16}`} className="h-auto w-full max-w-sm" role="img" aria-label="Changes per week" data-testid="deck-weekly">
            <line x1="0" x2={W} y1={H} y2={H} stroke={PAPER.line} strokeWidth="1" />
            {m.weekly.map((w, i) => {
              const h = Math.round((w.n / maxW) * (H - 14));
              return (
                <g key={w.week}>
                  <rect x={i * bw + 6} y={H - h} width={bw - 12} height={h} fill={i === m.weekly.length - 1 ? PAPER.focusLine : PAPER.quietLine} />
                  {w.n > 0 && (
                    <text x={i * bw + bw / 2} y={H - h - 3} textAnchor="middle" fontSize="11" fill={PAPER.ink}>
                      {w.n}
                    </text>
                  )}
                  <text x={i * bw + bw / 2} y={H + 13} textAnchor="middle" fontSize="10" fill={PAPER.muted}>
                    {w.week.slice(-3)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="min-w-0" data-testid="deck-trend">
          <div className="text-xs" style={{ color: PAPER.muted }}>
            Goals met over time
          </div>
          {t.length >= 2 ? (
            <svg viewBox={`0 0 ${W} ${H + 16}`} className="h-auto w-full max-w-sm" role="img" aria-label="Goals met over time">
              <line x1="0" x2={W} y1={H} y2={H} stroke={PAPER.line} strokeWidth="1" />
              <polyline
                fill="none"
                stroke={PAPER.focusLine}
                strokeWidth="2"
                points={t.map((p, i) => `${(i / (t.length - 1)) * (W - 20) + 10},${H - (p.goalsMet / tMax) * (H - 14)}`).join(" ")}
              />
              {t.map((p, i) => (
                <text key={p.date} x={(i / (t.length - 1)) * (W - 20) + 10} y={H + 13} textAnchor="middle" fontSize="10" fill={PAPER.muted}>
                  {i === 0 || i === t.length - 1 ? day(p.date) : ""}
                </text>
              ))}
            </svg>
          ) : (
            <p className="text-sm" style={{ color: PAPER.muted }}>
              {t.length === 1 ? `${t[0].goalsMet} of ${t[0].goalsTotal} goals met on ${day(t[0].date)}. ` : ""}The line grows by one point each day the deck changes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanSlide({ d }: { d: EpicDeck }) {
  const rows = planRows(d.plan);
  if (rows.length < 2) return <p style={{ color: PAPER.muted }}>No epics sit under this one. Its plan is its goals, on slide 3.</p>;
  return (
    <ul className="grid gap-1.5" data-testid="deck-plan">
      {rows.map((r, i) => (
        <li key={r.key} className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${r.depth * 1.25}rem` }} data-state={r.state}>
          {r.depth > 0 && (
            <span className="shrink-0" style={{ color: PAPER.muted }} aria-hidden>
              └
            </span>
          )}
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm" style={i === 0 ? box(true) : r.code ? box(false) : quiet}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_COLOR[r.state] }} title={STATE_WORD[r.state]} />
            {r.code && <span className="shrink-0 text-xs font-medium">{r.code}</span>}
            <span className="min-w-0 truncate">{r.title}</span>
            {r.dod?.total ? (
              <span className="ml-auto shrink-0 text-xs tabular-nums" style={{ color: PAPER.muted }}>
                {r.dod.done}/{r.dod.total}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DecisionsSlide({ d }: { d: EpicDeck }) {
  if (!d.decisions.length) return <p style={{ color: PAPER.muted }}>No decisions are written on this epic yet.</p>;
  return (
    <ul className="grid gap-2" data-testid="deck-decisions">
      {d.decisions.map((x, i) => (
        <li key={i}>
          <Box focus={i === 0}>
            <div className="text-xs" style={{ color: i === 0 ? PAPER.focusInk : PAPER.muted }}>
              {day(x.date)} · {x.code} · {x.outcome}
            </div>
            <div className="text-sm">{x.decision}</div>
          </Box>
        </li>
      ))}
    </ul>
  );
}

function WaitsSlide({ d }: { d: EpicDeck }) {
  return (
    <div className="grid gap-3" data-testid="deck-waits">
      {d.waits.length ? (
        <ul className="grid gap-2">
          {d.waits.map((w) => (
            <li key={w.code}>
              <Box focus>
                <div className="text-xs">
                  {w.code} · {w.epic}
                </div>
                <div className="text-sm">{w.question}</div>
              </Box>
            </li>
          ))}
        </ul>
      ) : (
        <Box style={quiet}>Nothing waits on you here.</Box>
      )}
      {d.next.length > 0 && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide" style={{ color: PAPER.muted }}>
            Next steps
          </div>
          <ul className="grid gap-1 text-sm">
            {d.next.slice(0, 5).map((n, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: n.stuck ? PAPER.warn : PAPER.focusLine }} aria-hidden />
                <span>
                  {n.code ? `${n.code}: ` : ""}
                  {n.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Link to="/" className="text-sm underline">
        Answer on the Team home
      </Link>
    </div>
  );
}

/**'s "Everything made for this", whole (the deck replaces the Epic Book): 8 shown, then all, dead links marked. */
function MadeSlide({ d }: { d: EpicDeck }) {
  if (!d.made.length) return <p style={{ color: PAPER.muted }}>Nothing made for this epic is recorded yet.</p>;
  return (
    <div data-testid="deck-made">
      <MadeList items={d.made} initial={8} />
    </div>
  );
}

export function deckSlides(d: EpicDeck): Slide[] {
  return [
    { key: "rocks", title: "The big rocks it serves", source: "docs/big-rocks.md", body: <RocksSlide d={d} /> },
    { key: "what", title: "What we are doing, and why", source: "Goal, Serves", body: <WhatWhySlide d={d} /> },
    { key: "where", title: "Where we are", source: "Done means, Current State", body: <WhereSlide d={d} /> },
    { key: "did", title: "What we just did", source: "git log, Decisions", body: <JustDidSlide d={d} /> },
    { key: "measure", title: "How we measure it", source: "Done means, deck-updates.md", body: <MeasureSlide d={d} /> },
    { key: "plan", title: "The plan", source: "the spines under it", body: <PlanSlide d={d} /> },
    { key: "decisions", title: "Decisions landed", source: "Decisions", body: <DecisionsSlide d={d} /> },
    { key: "waits", title: "What waits on you", source: "Waiting on, Next action", body: <WaitsSlide d={d} /> },
    { key: "made", title: "Everything made for this", source: "the spines' live links, evidence and decks", body: <MadeSlide d={d} /> },
  ];
}

function DeckNav({ i, total, go }: { i: number; total: number; go: (k: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-3" data-testid="deck-nav">
      <Button variant="outline" size="sm" disabled={i === 0} onClick={() => go(i - 1)} data-testid="deck-prev">
        <ChevronLeft /> Previous
      </Button>
      <span className="text-sm tabular-nums text-muted-foreground" data-testid="deck-pos">
        {i + 1} / {total}
      </span>
      <Button size="sm" disabled={i >= total - 1} onClick={() => go(i + 1)} data-testid="deck-next">
        Next <ChevronRight />
      </Button>
    </div>
  );
}

/**
 * a goal opened from a proposal card
 * on Team home (`?from=home`) says where he came from and leads straight back to the card.
 */
export function BackToHome({ draft }: { draft: boolean }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-sm" data-testid="deck-back-home">
      <Link to="/" className="inline-flex items-center gap-1 font-medium underline underline-offset-2" data-testid="deck-back-home-link">
        <ArrowLeft className="h-4 w-4" /> Back to Team home
      </Link>
      <span className="text-muted-foreground">
        {draft ? "This goal is a proposal. Switch it on or off on its card there, nothing starts before." : "You opened this goal from a card on your Team home."}
      </span>
    </div>
  );
}

/**
 * a product's deck, its Epic Book, links the page where its numbers live:
 * one plain label, the live numbers beside it, and in small words where they came from. Phone first: it wraps, and the
 * link is a 44 px tap.
 */
export function DeckLiveStrip({ live }: { live: DeckLive }) {
  const c0 = live.counts[0];
  const read = c0?.note?.replace(/ \d{4}-\d{2}-\d{2} /, " ");
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0 rounded-lg border px-3" style={{ background: PAPER.bg, color: PAPER.ink, borderColor: PAPER.quietLine }} data-testid="deck-live">
      <a href={live.link.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-medium underline underline-offset-2" data-testid="deck-live-link">
        {live.link.label}
      </a>
      {live.counts.map((c) => (
        <span key={c.source} className="py-1 text-sm" data-testid="deck-live-count" title={[c.sourceText, c.note].filter(Boolean).join(". ")}>
          <span className="font-semibold tabular-nums">{c.value === null || c.value === undefined ? "–" : c.value}</span> <span style={{ color: PAPER.muted }}>{c.label.toLowerCase()}</span>
        </span>
      ))}
      {c0 && (
        <span className="basis-full pb-1.5 text-[11px] sm:basis-auto sm:pb-0" style={{ color: PAPER.muted }} data-testid="deck-live-from">
          from {(c0.sourceText ?? "").split(",")[0]}
          {read ? `, ${read}` : ""}
        </span>
      )}
    </div>
  );
}

export function EpicDeckPage() {
  const { repo = "", code = "" } = useParams();
  return <EpicDeckView repo={repo} code={code} />;
}

/**
 * The deck itself: its own page (`/deck/<repo>/<code>`), or (the owner: "it's one more tab section, like chat
 * or summary or definitions. And then the deck shows inside of it") `embedded` in a milestone page's Deck tab, under a
 * small heading instead of the page's, with a link to open it as its own page. `?slide=` works the same in both.
 */
export function EpicDeckView({ repo, code, embedded }: { repo: string; code: string; embedded?: { links?: ReactNode } }) {
  const { data, error, loading } = useLiveBook(() => api.getEpicDeck(repo, code).then((v) => ({ book: v.deck, building: v.building, about: v.about, live: v.live })), [repo, code], `epic-deck:${repo}/${code}`);
  const [params, setParams] = useSearchParams();
  const d = data?.book ?? null;
  const slides = d ? deckSlides(d) : [];
  const asked = params.get("slide");
  const byKey = slides.findIndex((x) => x.key === asked);
  const i = byKey >= 0 ? byKey : Math.max(0, Math.min(slides.length - 1, (Number(asked) || 1) - 1));
  const go = useCallback(
    (k: number) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (k > 0) n.set("slide", String(k + 1));
          else n.delete("slide");
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (typing) return;
      if (e.key === "ArrowLeft" && i > 0) go(i - 1);
      else if (e.key === "ArrowRight" && i < slides.length - 1) go(i + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, slides.length, go]);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  if (!d)
    return (
      <div>
        {!embedded && <PageHeader title="Epic deck" />}
        <Empty>The deck is being built from the spines. It appears here by itself in a few seconds.</Empty>
      </div>
    );
  const s = slides[i];
  return (
    <div className="mx-auto min-w-0 max-w-5xl" data-testid="epic-deck" data-embedded={embedded ? "true" : undefined}>
      {!embedded && params.get("from") === "home" && <BackToHome draft={/^(draft|proposed)\b/i.test(d.status)} />}
      {(() => {
        const meta = (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {d.ref.code} in {d.ref.repo}. Built from the spine <RelTime iso={d.builtAt} />
              {data?.building && " (refreshing)"}.
            </span>
            {embedded?.links}
            {embedded && (
              <Link to={deckHref(d.ref.repo, d.ref.code)} className="underline" data-testid="deck-open-page">
                Open as a page
              </Link>
            )}
            <Link to={`/${ROCKS_PATH}`} className="underline">
              Big rocks
            </Link>
            <Link to={`/${DECK_PATH}`} className="underline">
              All decks
            </Link>
            <Link to={`/${DECK_ALL_PATH}?repo=${encodeURIComponent(d.ref.repo)}`} className="underline">
              Every epic in {d.ref.repo}
            </Link>
            {d.spineHref && (
              <a href={d.spineHref} target="_blank" rel="noreferrer" className="underline">
                The spine
              </a>
            )}
          </span>
        );
        return embedded ? (
          <div className="mb-3 min-w-0">
            <h2 className="text-lg font-semibold leading-tight [overflow-wrap:anywhere]" data-testid="deck-tab-title">
              {d.title}
            </h2>
            <div className="mt-1 text-sm text-muted-foreground">{meta}</div>
          </div>
        ) : (
          <PageHeader title={`${d.title}: epic deck`} description={meta} />
        );
      })()}
      {data?.live && <DeckLiveStrip live={data.live} />}
      {data?.about && <DeckAboutBlock a={data.about} code={d.ref.code} />}
      <div className="mb-2 flex min-w-0 gap-1.5 overflow-x-auto pb-1" data-testid="deck-strip">
        {slides.map((x, k) => (
          <button
            key={x.key}
            type="button"
            onClick={() => go(k)}
            aria-current={k === i}
            className={cn("max-w-[11rem] shrink-0 truncate rounded-md border px-2 py-1 text-left text-xs", k === i ? "border-emerald-700 bg-emerald-50 text-emerald-900" : "text-muted-foreground hover:text-foreground")}
            title={x.title}
          >
            <span className="mr-1 tabular-nums">{k + 1}</span>
            {x.title}
          </button>
        ))}
      </div>
      <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl border shadow-sm", SLIDE_HEIGHT)} style={{ background: PAPER.bg, color: PAPER.ink, borderColor: PAPER.quietLine }} data-testid="slide" data-slide={i + 1}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-10 sm:py-7" data-testid="slide-scroll">
          <h2 className="font-semibold leading-tight [overflow-wrap:anywhere] text-2xl sm:text-3xl" style={{ fontFamily: SERIF }} data-testid="slide-title">
            {s.title}
          </h2>
          <div className="min-w-0">{s.body}</div>
          <div className="mt-auto flex flex-wrap justify-between gap-2 border-t pt-2 text-xs" style={{ color: PAPER.muted, borderColor: PAPER.quietLine }}>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {d.title} · from {s.source}
            </span>
            <span data-testid="slide-count">
              {i + 1} / {slides.length}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <DeckNav i={i} total={slides.length} go={go} />
      </div>
    </div>
  );
}

/** `/deck`: the owner's focus milestones first, then the big lanes, each with its goals met and its big rocks. */
export function DeckIndexPage() {
  const { data, error, loading } = useQuery(() => api.listDecks(), []);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const decks = data?.decks ?? [];
  const group = (kind: DeckListItem["kind"], title: string, sub: string) => {
    const xs = decks.filter((x) => x.kind === kind);
    if (!xs.length) return null;
    return (
      <section className="grid gap-2" data-testid={`deck-index-${kind}`}>
        <h2 className="text-base font-semibold">
          {title} <span className="text-sm font-normal text-muted-foreground">{xs.length}</span>
        </h2>
        <p className="text-xs text-muted-foreground">{sub}</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {xs.map((x) => (
            <li key={x.href}>
              <Link to={x.href} className="block min-w-0 rounded-md px-3 py-2 hover:opacity-90" style={box(x.kind === "big")} data-testid="deck-index-item">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_COLOR[x.state] }} title={STATE_WORD[x.state]} />
                  <span className="min-w-0 truncate font-semibold" style={{ fontFamily: SERIF }}>
                    {x.title}
                  </span>
                </div>
                <div className="mt-0.5 text-xs" style={{ color: PAPER.muted }}>
                  {x.ref.code} in {x.ref.repo}
                  {x.goalsTotal ? ` · ${x.goalsMet} of ${x.goalsTotal} goals met` : ""}
                  {x.rocks.length ? ` · big rocks ${x.rocks.join(", ")}` : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  };
  return (
    <div className="min-w-0" data-testid="deck-index">
      <PageHeader
        title="Epic decks"
        description={
          <span className="flex flex-wrap gap-x-3">
            <span>One short deck per high-level epic, built from its spine. A deck that changes lands on the Team home, once a day at most.</span>
            <Link to={`/${ROCKS_PATH}`} className="underline">
              Big rocks
            </Link>
            <Link to={`/${DECK_ALL_PATH}`} className="underline" data-testid="deck-index-all">
              Every epic, every repo
            </Link>
          </span>
        }
      />
      {!decks.length ? (
        <Empty>The decks are being built from the spines.</Empty>
      ) : (
        <div className="grid gap-5">
          {group("big", "Focus projects", `${ownerName()}'s big projects, in his order.`)}
          {group("lane", "Big lanes", `The open epics right under ${homeRepo()}'s root.`)}
        </div>
      )}
    </div>
  );
}

