import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useGapFinderQuery } from "@/lib/gapFinder";
import { githubRepoUrl, homeOrg, memoryName, homeRepo, socialProduct } from "@/lib/identity";
import { GAP_FINDER_PATH } from "@/lib/routePaths";
import { FoldChevron } from "@/components/foldChevron";
export { GAP_FINDER_PATH };

/**
 * the Gap finder has one place in the console, a main-menu
 * entry beside Team and Chat (it works at the root, across every project: like Team, Chat and Performance it aggregates,
 * round 2's rule for the top level). /gap-finder lists its runs (docs/landing/gap-finder/runs.json, written by
 * docs/status/gap-finder/build.py), /gap-finder/<date> opens one run's page (a repo file under /landing/, L-45) inside the
 * console with a way back, the same frame as the goal graph. Both say where it lives in one block.
 */
const LANDING = "/landing/gap-finder";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GAP_FINDER_WHERE = {
  get persona() {
    return `${githubRepoUrl("team")}/blob/main/state/personas/gap-finder.md`;
  },
  schedule: "/milestones/ms_a1c1fa4e-cd02-4d03-9939-9bcf052e69bb?tab=personas",
  get findings() {
    return `${githubRepoUrl()}/tree/main/docs/status/gap-finder`;
  },
};

/** The /landing/ file a console path shows: /gap-finder/<date> → that run's page; undefined for the list or anything else. */
export function gapFinderFileOf(consolePath: string): string | undefined {
  const m = consolePath.replace(/\/+$/, "").match(new RegExp(`^/${GAP_FINDER_PATH}/(\\d{4}-\\d{2}-\\d{2})$`));
  return m ? `${LANDING}/${m[1]}.html` : undefined;
}

/** The console path of a /landing/gap-finder/ page (the list for its index), else undefined. */
export function gapFinderPathOf(landingPath: string): string | undefined {
  const p = landingPath.replace(/\/index\.html$/, "/");
  if (p === `${LANDING}/` || p === LANDING) return `/${GAP_FINDER_PATH}`;
  const m = p.match(/^\/landing\/gap-finder\/(\d{4}-\d{2}-\d{2})\.html$/);
  return m ? `/${GAP_FINDER_PATH}/${m[1]}` : undefined;
}

export interface GapFinderRun {
  date: string;
  title: string;
  page: string;
  row: string;
  gaps: number;
  still_pending?: number;
  in_flight?: number;
  closed?: number;
  /** the voice notes this run took a second look at, and their asks by state. */
  notes?: number;
  asks?: number;
  reflected?: number;
  partly?: number;
  missed?: number;
}

/** one voice note checked a day later (docs/status/gap-finder/notes/*.json, listed in notes.json by build.py). */
export type AskState = "reflected" | "partly" | "missed";
export interface NoteAsk {
  ask: string;
  words?: string;
  state: AskState;
  where?: string;
  link?: string;
  why?: string;
  followup?: string;
}
export interface NoteCheck {
  id: string;
  where: string;
  recordedAt: string;
  checkedAt: string;
  run: string;
  minutes?: number;
  gist: string;
  private?: boolean;
  /** what the memory service holds of the note (build.py writes it from the note record) */
  memoryNote?: string;
  asks: NoteAsk[];
}

const dayOf = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** One line per state that has gaps: "2 still pending · 4 in flight". */
export function runCounts(r: GapFinderRun): string {
  const parts = [
    [r.still_pending, "still pending"],
    [r.in_flight, "in flight"],
    [r.closed, "closed"],
  ]
    .filter(([n]) => typeof n === "number" && n > 0)
    .map(([n, w]) => `${n} ${w}`);
  if (r.notes) parts.push(`${r.notes} voice note${r.notes === 1 ? "" : "s"} checked a day later: ${askCounts(r)}`);
  return parts.length ? parts.join(" · ") : `${r.gaps} gap${r.gaps === 1 ? "" : "s"}`;
}

/** "12 asks: 10 reflected, 1 partly, 1 missed" (the states with none left out). */
export function askCounts(c: Partial<Record<AskState | "asks", number>>): string {
  const states = (["reflected", "partly", "missed"] as const).filter((k) => (c[k] ?? 0) > 0).map((k) => `${c[k]} ${k}`);
  const n = c.asks ?? 0;
  return `${n} ask${n === 1 ? "" : "s"}${states.length ? `: ${states.join(", ")}` : ""}`;
}

export function noteTally(n: Pick<NoteCheck, "asks">) {
  const count = (k: AskState) => n.asks.filter((a) => a.state === k).length;
  return { asks: n.asks.length, reflected: count("reflected"), partly: count("partly"), missed: count("missed") };
}

const LINK = "text-emerald-800 underline underline-offset-2 hover:text-emerald-950 dark:text-emerald-300";

/** Where the Gap finder lives: its level, its settings, its findings and who reads them (the same four facts as its card). */
export function GapFinderWhere({ compact = false }: { compact?: boolean }) {
  const rows: [string, JSX.Element][] = [
    ["Level", <>The root, across every project: agent team, EpicSpine, {socialProduct()} and {memoryName()}. That is why it sits in the main menu beside Team and Chat, not inside one project.</>],
    [
      "Settings",
      <>
        Its instructions are one file in the {homeOrg()} team repo,{" "}
        <a className={LINK} href={GAP_FINDER_WHERE.persona} target="_blank" rel="noreferrer" data-testid="gap-where-persona">
          state/personas/gap-finder.md
        </a>
        . Its daily job, 12:00 UTC, is an assignment on the{" "}
        <Link className={LINK} to={GAP_FINDER_WHERE.schedule} data-testid="gap-where-schedule">
          {homeRepo()} root project
        </Link>
        , Personas tab, where you pause it or change the time.
      </>,
    ],
    [
      "Findings",
      <>
        Saved in the {homeRepo()} repo, one page a day:{" "}
        <a className={LINK} href={GAP_FINDER_WHERE.findings} target="_blank" rel="noreferrer" data-testid="gap-where-findings">
          docs/status/gap-finder
        </a>{" "}
        holds the text, docs/landing/gap-finder the page you open here and the list of runs, docs/cards the day's card. Your switches go into the {homeRepo()} spines.
      </>,
    ],
    ["Read by", <>You, on its Team home card and here. The Gap finder itself on its next run, so it never repeats what moved or what you switched off. The Delivery manager, who starts each follow-up you switch on.</>],
  ];
  return (
    <section className="rounded-lg border border-dashed bg-card px-3 py-2 text-sm" data-testid="gap-finder-where">
      <div className="mb-1 font-medium">Where the Gap finder lives</div>
      <dl className={compact ? "grid gap-1" : "grid gap-1.5 sm:grid-cols-[6.5rem_1fr]"}>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function useRuns() {
  const [runs, setRuns] = useState<GapFinderRun[]>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    let on = true;
    fetch(`${LANDING}/runs.json`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { runs?: GapFinderRun[] }) => on && setRuns((j.runs ?? []).filter((r) => DATE.test(r.date))))
      .catch(() => on && setErr(true));
    return () => {
      on = false;
    };
  }, []);
  return { runs, err };
}

function useNotes() {
  const [notes, setNotes] = useState<NoteCheck[]>();
  useEffect(() => {
    let on = true;
    fetch(`${LANDING}/notes.json`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { notes?: NoteCheck[] }) => on && setNotes(Array.isArray(j.notes) ? j.notes : []))
      .catch(() => on && setNotes([]));
    return () => {
      on = false;
    };
  }, []);
  return notes;
}

const STATE_STYLE: Record<AskState, string> = {
  reflected: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  partly: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  missed: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
};
const STATE_MARK: Record<AskState, string> = { reflected: "✓ reflected", partly: "◐ partly", missed: "✗ missed" };

const noteWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} ${d.toISOString().slice(11, 16)} UTC`;
};

/**
 * every voice note gets a second look a day later,
 * ask by ask. Newest first; a note opens to its asks, each with its state, his words and where it landed; a missed one says
 * what is offered on his Team home card.
 */
export function NoteChecks({ notes, limit = 30 }: { notes?: NoteCheck[]; limit?: number }) {
  if (!notes?.length) return null;
  const total = notes.reduce((t, n) => {
    const c = noteTally(n);
    return { asks: t.asks + c.asks, reflected: t.reflected + c.reflected, partly: t.partly + c.partly, missed: t.missed + c.missed };
  }, { asks: 0, reflected: 0, partly: 0, missed: 0 });
  return (
    <section className="grid gap-2" aria-label="Every voice note, a day later" data-testid="gap-finder-notes">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Every voice note, a day later</div>
      <p className="text-sm text-muted-foreground" data-testid="gap-finder-notes-total">
        {notes.length} voice note{notes.length === 1 ? "" : "s"} checked, {askCounts(total)}. Each missed ask, and each partly one with a clear next move, is a switch on your Team home card.
      </p>
      {notes.slice(0, limit).map((n) => {
        const c = noteTally(n);
        return (
          <details key={n.id} className="min-w-0 rounded-lg border bg-card px-3 py-2" data-testid="gap-finder-note" open={c.missed > 0 || undefined}>
            <summary className="flex cursor-pointer list-none items-start gap-2">
              <FoldChevron className="mt-[3px]" />
              <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted-foreground">
                {n.where} · {noteWhen(n.recordedAt)}
                {n.minutes ? ` · ${n.minutes} min` : ""} · checked {noteWhen(n.checkedAt)}
              </span>
              <span className="block font-medium">{n.gist}</span>
              <span className="mt-0.5 flex flex-wrap gap-1 text-xs" data-testid="gap-finder-note-tally">
                {c.asks === 0 && <span className="text-muted-foreground">nothing for the team</span>}
                {(["reflected", "partly", "missed"] as const)
                  .filter((k) => c[k] > 0)
                  .map((k) => (
                    <span key={k} className={`rounded-full px-2 font-medium ${STATE_STYLE[k]}`}>
                      {c[k]} {k}
                    </span>
                  ))}
              </span>
              </span>
            </summary>
            {n.memoryNote && <p className="mt-1 text-xs text-muted-foreground">{n.memoryNote}</p>}
            {n.asks.length > 0 && (
              <ol className="mt-2 grid list-decimal gap-2 pl-5 text-sm">
                {n.asks.map((a, i) => (
                  <li key={i} data-testid="gap-finder-ask" data-state={a.state}>
                    <span className={`mr-1.5 rounded-full px-2 text-xs font-medium ${STATE_STYLE[a.state] ?? ""}`}>{STATE_MARK[a.state] ?? a.state}</span>
                    {a.ask}
                    {a.words && !n.private && <span className="block italic text-muted-foreground">“{a.words}”</span>}
                    {(a.where || a.link) && (
                      <span className="block">
                        Landed:{" "}
                        {a.link ? (
                          <a className={LINK} href={a.link} target="_blank" rel="noreferrer">
                            {a.where || "where it landed"}
                          </a>
                        ) : (
                          a.where
                        )}
                      </span>
                    )}
                    {a.why && <span className="block text-muted-foreground">{a.why}</span>}
                    {a.state !== "reflected" && a.followup && (
                      <span className="block font-medium" data-testid="gap-finder-offered">
                        Offered on your Team home card: {a.followup}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <Link className={`mt-1 inline-block text-xs ${LINK}`} to={`/${GAP_FINDER_PATH}/${n.run}#${encodeURIComponent(n.id)}`}>
              In the run of {dayOf(n.run)}
            </Link>
          </details>
        );
      })}
    </section>
  );
}

function Back({ run }: { run?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <Link to="/" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" data-testid="gap-finder-back">
        <ArrowLeft className="h-4 w-4" />
        Team home
      </Link>
      {run && (
        <Link to={`/${GAP_FINDER_PATH}`} className="text-muted-foreground hover:text-foreground" data-testid="gap-finder-all">
          All Gap finder runs
        </Link>
      )}
    </div>
  );
}

function RunList() {
  const { runs, err } = useRuns();
  const notes = useNotes();
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="gap-finder-page">
      <Back />
      <div>
        <h1 className="text-xl font-semibold">Gap finder</h1>
        <p className="text-sm text-muted-foreground">
          Once a day it reads your last ten days of voice notes and lists what you asked for more than once and still do not have. It also takes a second look at every voice note a day after you
          spoke it, from every place you speak, and checks each thing you asked in it.
        </p>
      </div>
      <NoteChecks notes={notes} />
      <GapFinderWhere />
      <section className="grid gap-2" aria-label="Its runs" data-testid="gap-finder-runs">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Its runs, newest first</div>
        {err && <p className="text-sm text-muted-foreground">The list of runs could not be read. Try again in a minute.</p>}
        {!err && !runs && <p className="text-sm text-muted-foreground">Loading…</p>}
        {runs?.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        {runs?.map((r) => (
          <Link key={r.date} to={`/${GAP_FINDER_PATH}/${r.date}`} className="block min-w-0 rounded-lg border bg-card px-3 py-2 hover:bg-muted" data-testid="gap-finder-run">
            <span className="block text-xs text-muted-foreground">{dayOf(r.date)}</span>
            <span className="block font-medium">{r.title}</span>
            <span className="block text-sm text-muted-foreground">{runCounts(r)}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}

function RunPage({ file }: { file: string }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  const [whereOpen, setWhereOpen] = useState(false);

  useEffect(() => {
    const fit = () => {
      const top = frame.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(360, Math.floor(window.innerHeight - top - 8)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [file, whereOpen]);

  // A link inside the page: a console page opens in the console, another site in a new tab.
  const onLoad = () => {
    const win = frame.current?.contentWindow;
    let doc: Document;
    try {
      if (!win) return;
      doc = win.document;
    } catch {
      return;
    }
    doc.addEventListener("click", (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a");
      if (!a || !a.href || ev.defaultPrevented || ev.metaKey || ev.ctrlKey) return;
      const url = new URL(a.href, win.location.href);
      if (url.pathname === win.location.pathname && url.origin === window.location.origin) return;
      ev.preventDefault();
      if (url.origin !== window.location.origin) {
        window.open(url.href, "_blank", "noopener");
        return;
      }
      navigate((gapFinderPathOf(url.pathname) ?? url.pathname) + url.search + url.hash);
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="gap-finder-run-page">
      <Back run />
      <button type="button" className="self-start text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setWhereOpen(!whereOpen)} aria-expanded={whereOpen} data-testid="gap-finder-where-toggle">
        <FoldChevron open={whereOpen} className="mr-1.5" />
        {whereOpen ? "Hide where the Gap finder lives" : "Where the Gap finder lives: its settings, its findings, who reads them"}
      </button>
      {whereOpen && <GapFinderWhere compact />}
      <iframe
        key={file}
        ref={frame}
        src={file + loc.hash}
        title="Gap finder run"
        onLoad={onLoad}
        className="w-full rounded-lg border bg-[#faf7f0]"
        style={{ height: height ?? 600 }}
        data-testid="gap-finder-frame"
      />
    </div>
  );
}

/** the Gap finder is switched off (or not in this team): nothing of it shows, one line says how to switch it on. */
function Off({ settings }: { settings: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="gap-finder-off">
      <Back />
      <h1 className="text-xl font-semibold">Gap finder</h1>
      <p className="text-sm text-muted-foreground">
        The Gap finder is switched off in this team, so it has no runs to show.{" "}
        <Link className={LINK} to={settings} data-testid="gap-finder-switch-on">
          Switch it on in its settings
        </Link>
        .
      </p>
    </div>
  );
}

export function GapFinderPage() {
  const { date } = useParams();
  const { data: gapFinder, loading } = useGapFinderQuery();
  if (loading)
    return (
      <div className="flex flex-col gap-3">
        <Back />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  if (gapFinder?.on === false) return <Off settings={gapFinder.settings} />;
  if (!date) return <RunList />;
  const file = gapFinderFileOf(`/${GAP_FINDER_PATH}/${date}`);
  if (!file)
    return (
      <div className="flex flex-col gap-3">
        <Back run />
        <p className="text-sm text-muted-foreground" data-testid="gap-finder-missing">
          No such run.
        </p>
      </div>
    );
  return <RunPage file={file} />;
}
