import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Maximize2, MessageCircle, Plus, X } from "lucide-react";
import { api, type ChatRead, type CampaignTotems, type Milestone, type TotemHistoryLine, type TotemBenefit, type TotemObservation, type TotemRebuild, type TotemSlide, type TotemTask } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { WaitingOnYou } from "@/components/waiting";
import { ErrorBox, Loading } from "@/components/common";
import { useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { ChatMarkdown, inline } from "@/lib/chatMarkdown";
import { mutate, useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { absoluteLinks, slideNote, splitTaskCodes } from "@/lib/totems";
import { cn } from "@/lib/utils";
import { ChatView } from "@/pages/Chat";
import { campaignVoiceBase, useAnswerVoice } from "@/voice/AnswerVoice";

/**
 * the five fixed tabs of a campaign in the social
 * skin, each a part of the campaign's epic file (social/totems.ts on the server): Brief (the deck), Work, Observations,
 * History; Chat is the campaign chat itself (Milestone.tsx). Every write goes through the console's one spine writer:
 * a slide note goes to the campaign chat, which rebuilds the slide (POST …/slide); Keep, Undo and a proposal's Add to the
 * brief / Not now are the owner's own taps.
 */

/** The campaign's four parts; `tick` refetches (a slide note polls every 5 s until its rebuild lands). */
export function useTotems(milestoneId: string, tick = 0) {
  return useQuery(async () => api.getCampaignTotems(await worldId(), milestoneId), [milestoneId, tick]);
}

const fmtDay = (d: string, weekday = true) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...(weekday ? { weekday: "short" as const } : {}), day: "numeric", month: "short", timeZone: "UTC" });

/** Header + one-line description, as every tab of the mockup opens. */
function TabHead({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1 basis-72">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Two or three pills that switch a view (Tasks / Posts, This campaign / Whole team). */
function Pills<T extends string>({ value, options, onChange, testId }: { value: T; options: [T, string][]; onChange: (v: T) => void; testId: string }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn("rounded-full border px-3 py-1 text-xs", value === v ? "border-violet-400 bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "text-muted-foreground hover:text-foreground")}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** A line of text with Markdown links (relative ones to GitHub) and task codes linking to Work. */
function LineText({ text, base }: { text: string; base: { remote?: string; path?: string } }) {
  const md = absoluteLinks(text, base);
  return (
    <>
      {splitTaskCodes(md).map((p, i) =>
        "code" in p ? (
          <Link key={i} to={`?tab=work&row=${encodeURIComponent(p.code)}`} className="font-mono text-[0.92em] text-primary underline" data-testid="task-link">
            {p.code}
          </Link>
        ) : (
          <Fragment key={i}>{inline(p.text)}</Fragment>
        ),
      )}
    </>
  );
}

// ---------- Brief: the deck ----------

const pendingKey = (mid: string, ref: string) => `e64s14-pending:${mid}:${ref}`;
interface Pending {
  at: number;
  body: string;
}
function readPending(mid: string, ref: string): Pending | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(pendingKey(mid, ref)) ?? "null") as Pending | null;
    return p && Date.now() - p.at < 10 * 60_000 ? p : undefined;
  } catch {
    return undefined;
  }
}

/** The slide's one height, so Previous / Next never move between slides (the owner): a long slide scrolls inside. */
export const SLIDE_HEIGHT = "h-[26rem] sm:h-[28rem]";
export const SLIDE_HEIGHT_FULL = "h-[52vh] sm:h-[58vh]";

/** One slide on its paper card: title, the facts (slide 1), the body, and where in the epic file it comes from. */
function SlideCard({ s, total, epic, base, banner, before, big }: { s: TotemSlide; total: number; epic: string; base: { remote?: string; path?: string }; banner?: ReactNode; before?: string; big?: boolean }) {
  const fresh = useMemo(() => (before ? new Set(before.split("\n").map((l) => l.trim())) : undefined), [before]);
  const body = absoluteLinks(s.body, { ...base, path: s.file });
  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground", big ? SLIDE_HEIGHT_FULL : SLIDE_HEIGHT)} data-testid="slide" data-slide={s.n} data-fixed-height="">
      {banner}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-6 sm:px-10", big && "sm:py-10")} data-testid="slide-scroll">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className={cn("min-w-0 text-2xl font-semibold [overflow-wrap:anywhere]", big && "sm:text-4xl")} data-testid="slide-title">
            {s.title}
          </h3>
          {s.draft && (
            <Badge variant="amber" data-testid="slide-draft">
              {s.draft}
            </Badge>
          )}
        </div>
        {s.facts && s.facts.length > 0 && (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="slide-facts">
            {s.facts.map((f) => (
              <div key={f.label} className="min-w-0 rounded-lg border bg-background/60 p-3 text-sm">
                <div className="font-semibold">{f.label}</div>
                <div className="text-muted-foreground [overflow-wrap:anywhere]">{f.value}</div>
              </div>
            ))}
          </div>
        )}
        <div className={cn("min-w-0 [overflow-wrap:anywhere]", big ? "text-base sm:text-lg" : "text-base")} data-testid="slide-body">
          {s.benefits && s.benefits.length > 0 ? (
            <BenefitsBody list={s.benefits} asked={s.asked ?? []} big={big} />
          ) : fresh ? (
            body.split("\n\n").map((para, i) => (
              <div key={i} className={cn(i > 0 && "mt-2")}>
                {para.split("\n").map((l, j) => (
                  <div key={j} className={cn("rounded px-1", l.trim() && !fresh.has(l.trim()) && "bg-emerald-600/10")} data-new={l.trim() && !fresh.has(l.trim()) ? "" : undefined}>
                    <ChatMarkdown text={l} />
                  </div>
                ))}
              </div>
            ))
          ) : (
            <ChatMarkdown text={body} />
          )}
        </div>
        <div className="mt-auto flex flex-wrap justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {epic} · from the epic file: {s.source}
          </span>
          <span data-testid="slide-count">
            {s.n} / {total}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * the benefits slide as "what it does for you". Each row says what the social product does
 * in plain words and, under it, what you get from that; picking a row shows the real screen of it (beside the list on a
 * wide screen, under the row on a phone). A line not built yet is greyed and says Coming soon.
 */
function BenefitsBody({ list, asked, big }: { list: TotemBenefit[]; asked: { id: string; text: string }[]; big?: boolean }) {
  const [pick, setPick] = useState(() => Math.max(0, list.findIndex((b) => !b.soon && b.screen?.url)));
  // On a phone the list shows first; a tapped line opens its screen under it (tap again to close).
  const [open, setOpen] = useState<number | null>(null);
  const sel = list[pick] ?? list[0];
  const shot = (b: TotemBenefit, where: "side" | "row") =>
    b.screen?.url ? (
      <figure className="flex min-h-0 min-w-0 flex-col gap-2" data-testid={`benefit-screen-${where}`}>
        <div className="min-h-0 overflow-hidden rounded-lg bg-white ring-1 ring-black/5 dark:bg-zinc-800">
          <img src={b.screen.url} alt={b.screen.label || b.does} loading="lazy" className={cn("block w-full object-contain object-top", where === "side" ? (big ? "max-h-[46vh]" : "max-h-[19rem]") : "max-h-72")} />
        </div>
        {b.screen.label && <figcaption className="text-sm text-zinc-600 dark:text-zinc-400">{b.screen.label}</figcaption>}
      </figure>
    ) : (
      <p className="rounded-lg bg-black/[0.03] p-4 text-sm text-zinc-600 dark:bg-white/5 dark:text-zinc-400" data-testid={`benefit-screen-${where}`}>
        {b.soon ? "Being built. It shows here when it works." : "No screen yet."}
      </p>
    );
  return (
    <div className="flex flex-col gap-4" data-testid="benefits">
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <ul className="flex min-w-0 flex-col gap-1" aria-label="What it does for you">
          {list.map((b, k) => {
            const on = k === pick;
            return (
              <li key={b.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => (setPick(k), setOpen(open === k ? null : k))}
                  aria-pressed={on}
                  aria-expanded={open === k}
                  className={cn("w-full rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", on ? "lg:bg-white lg:dark:bg-zinc-800" : "lg:hover:bg-black/[0.03] lg:dark:hover:bg-white/5", open === k && "max-lg:bg-white max-lg:dark:bg-zinc-800")}
                  data-testid="benefit-row"
                  data-soon={b.soon ? "" : undefined}
                >
                  <ChevronRight className={cn("float-right ml-2 mt-1 h-4 w-4 text-zinc-400 transition-transform lg:hidden", open === k && "rotate-90")} aria-hidden />
                  <span className={cn("block font-semibold leading-snug", big ? "text-lg sm:text-xl" : "text-base", b.soon && "text-zinc-500")} data-testid="benefit-does">
                    {b.does || b.benefit}
                    {b.soon && <span className="ml-2 whitespace-nowrap text-sm font-medium text-amber-700 dark:text-amber-400">Coming soon</span>}
                  </span>
                  {b.does && (
                    <span className={cn("mt-0.5 block leading-snug", big ? "text-base sm:text-lg" : "text-[0.95rem]", b.soon ? "text-zinc-500" : "text-emerald-800 dark:text-emerald-300")} data-testid="benefit-gives">
                      {b.benefit}
                    </span>
                  )}
                </button>
                {open === k && <div className="px-3 pb-2 pt-1 lg:hidden">{shot(b, "row")}</div>}
              </li>
            );
          })}
        </ul>
        <div className="hidden min-w-0 lg:block">{sel && shot(sel, "side")}</div>
      </div>
      {asked.length > 0 && (
        <div className="text-sm" data-testid="benefits-asked">
          <div className="font-semibold">People asked for</div>
          <ul className="mt-1 list-disc pl-5 text-zinc-700 dark:text-zinc-300">
            {asked.map((a) => (
              <li key={a.id}>{a.text}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Keep / Undo on a rebuilt slide (the spine's open `Slide rebuilt` row), spinning in place (L-38). */
function RebuildBanner({ rebuild, onKeep, onUndo }: { rebuild: TotemRebuild; onKeep: () => Promise<void>; onUndo: () => Promise<void> }) {
  const [busy, setBusy] = useState<"keep" | "undo">();
  const [err, setErr] = useState<string>();
  const act = (k: "keep" | "undo", fn: () => Promise<void>) => async () => {
    setBusy(k);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 bg-emerald-800 px-4 py-2 text-sm text-white" data-testid="rebuild-banner">
      <span className="min-w-0 flex-1 basis-60">Rebuilt from your note{rebuild.note ? `: “${rebuild.note}”` : ""}. Every persona reads it from its next wake.</span>
      <Button size="sm" variant="outline" className="h-7 border-white/60 bg-transparent text-white hover:bg-white/10" pending={busy === "keep"} pendingLabel="Keeping…" disabled={!!busy} onClick={act("keep", onKeep)} data-testid="rebuild-keep">
        Keep
      </Button>
      <Button size="sm" variant="outline" className="h-7 border-white/60 bg-transparent text-white hover:bg-white/10" pending={busy === "undo"} pendingLabel="Undoing…" disabled={!!busy} onClick={act("undo", onUndo)} data-testid="rebuild-undo">
        Undo
      </Button>
      {err && <span className="w-full text-xs text-red-200">{err}</span>}
    </div>
  );
}

/** Previous / n of N / Next. */
export function DeckNav({ i, total, go, extra, dark }: { i: number; total: number; go: (k: number) => void; extra?: ReactNode; dark?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3" data-testid="deck-nav">
      <Button variant="outline" size="sm" disabled={i === 0} onClick={() => go(i - 1)} data-testid="deck-prev">
        <ChevronLeft /> Previous
      </Button>
      <span className={cn("text-sm tabular-nums", dark ? "text-zinc-300" : "text-muted-foreground")} data-testid="deck-pos">
        {i + 1} / {total}
      </span>
      <Button size="sm" disabled={i >= total - 1} onClick={() => go(i + 1)} data-testid="deck-next">
        Next <ChevronRight />
      </Button>
      {extra}
    </div>
  );
}

export function BriefTab({ m, chatSlot }: { m: Milestone; chatSlot?: (send: (text: string) => string) => ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [tick, setTick] = useState(0);
  const q = useTotems(m.id, tick);
  const t = q.data;
  const [team, setTeam] = useState(false);
  const slides = (team ? t?.team?.slides : t?.slides) ?? [];
  const rebuildsList = (team ? t?.team?.rebuilds : t?.rebuilds) ?? [];
  const n = Math.max(1, Math.min(slides.length || 1, Number(params.get("slide")) || 1));
  const i = n - 1;
  const s = slides[i];
  const full = params.get("full") === "1";
  const setSearch = useCallback(
    (patch: Record<string, string | undefined>) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          for (const [k, v] of Object.entries(patch)) v === undefined ? next.delete(k) : next.set(k, v);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const go = useCallback((k: number) => setSearch({ slide: k > 0 ? String(k + 1) : undefined }), [setSearch]);
  // A sent slide note: poll every 5 s until the campaign chat's rebuild lands (or 5 min pass).
  const [pending, setPending] = useState<Pending | undefined>();
  useEffect(() => setPending(s ? readPending(m.id, s.ref) : undefined), [m.id, s?.ref]);
  const rebuild = s && rebuildsList.find((r) => r.ref === s.ref);
  const waiting = !!pending && !(rebuild?.state === "rebuilt" && s && s.body.trim() !== pending.body.trim());
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick((k) => k + 1), 5_000);
    const stop = setTimeout(() => clearInterval(timer), 5 * 60_000);
    return () => (clearInterval(timer), clearTimeout(stop));
  }, [waiting]);
  // Keyboard: arrows page through, Esc leaves full screen (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement | null)?.tagName ?? "") || (e.target as HTMLElement | null)?.isContentEditable;
      if (e.key === "Escape" && full) setSearch({ full: undefined });
      else if (!typing && e.key === "ArrowRight" && i < slides.length - 1) go(i + 1);
      else if (!typing && e.key === "ArrowLeft" && i > 0) go(i - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, i, slides.length, go, setSearch]);
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => void (document.body.style.overflow = prev);
  }, [full]);

  if (q.error && !t) return <ErrorBox error={q.error} />;
  if (!t) return <Loading />;
  const epicName = team ? (t.team?.root.title ?? "The team") : t.epic.title;
  const base = { remote: t.remote ?? undefined };
  const sent = (text: string) => {
    if (!s) return text;
    const p = { at: Date.now(), body: s.body };
    localStorage.setItem(pendingKey(m.id, s.ref), JSON.stringify(p));
    setPending(p);
    return slideNote(s, text);
  };
  const keep = async () => {
    await mutate(async () => api.keepSlide(await worldId(), m.id, { file: s!.file, ref: s!.ref }));
    localStorage.removeItem(pendingKey(m.id, s!.ref));
    setPending(undefined);
    setTick((k) => k + 1);
  };
  const undo = async () => {
    await mutate(async () => api.undoSlide(await worldId(), m.id, { file: s!.file, ref: s!.ref }));
    localStorage.removeItem(pendingKey(m.id, s!.ref));
    setPending(undefined);
    setTick((k) => k + 1);
  };
  const banner = rebuild?.state === "rebuilt" ? <RebuildBanner rebuild={rebuild} onKeep={keep} onUndo={undo} /> : undefined;
  const before = rebuild?.state === "rebuilt" && pending ? pending.body : undefined;
  const card = s ? <SlideCard key={`${team}:${s.ref}`} s={s} total={slides.length} epic={epicName} base={base} banner={banner} before={before} big={full} /> : <div className={cn("rounded-xl border p-8 text-sm text-muted-foreground", full ? SLIDE_HEIGHT_FULL : SLIDE_HEIGHT)}>This brief has no slides yet: its epic file has no Goal, plan or Done means written.</div>;
  const waitLine = waiting && (
    <div role="status" className="text-xs text-muted-foreground" data-testid="rebuild-waiting">
      Sent to the campaign chat. It rebuilds this slide; Keep and Undo show on the slide when it is done.
    </div>
  );

  // Full screen: one column at the slide's width. The slide keeps one height, Previous / Next sit under it, the feedback chat below.
  if (full)
    return (
      <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-zinc-900 sm:px-6" data-testid="deck-full" role="dialog" aria-label="Brief, full screen">
        <div className="mx-auto flex w-full max-w-6xl shrink-0 flex-col gap-3 px-3 pt-3 sm:px-0 sm:pt-5">
          {card}
          <DeckNav
            i={i}
            total={slides.length}
            go={go}
            dark
            extra={
              <Button variant="outline" size="sm" onClick={() => setSearch({ full: undefined })} data-testid="deck-exit">
                <X /> Exit full screen (Esc)
              </Button>
            }
          />
        </div>
        <FeedbackChat m={m} slide={s} sent={sent} waitLine={waitLine} chatSlot={chatSlot} />
      </div>
    );

  // No heading block (the owner): the slide strip and two buttons sit above the slide, feedback below it.
  return (
    <div data-testid="brief-tab">
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2" data-testid="brief-bar">
        <div className="flex min-w-0 flex-1 basis-64 gap-1.5 overflow-x-auto pb-1" data-testid="deck-strip">
          {slides.map((x, k) => (
            <button
              key={x.ref}
              type="button"
              onClick={() => go(k)}
              aria-current={k === i}
              className={cn("max-w-[11rem] shrink-0 truncate rounded-md border px-2 py-1 text-left text-xs", k === i ? "border-violet-400 bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200" : "text-muted-foreground hover:text-foreground")}
              title={x.title}
            >
              <span className="mr-1 tabular-nums">{x.n}</span>
              {x.title}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => (setTeam(!team), go(0))} data-testid="brief-scope">
            {team ? "This campaign's brief" : "Whole team brief"}
          </Button>
          <Button size="sm" onClick={() => setSearch({ full: "1" })} data-testid="brief-full">
            <Maximize2 /> Full screen with chat
          </Button>
        </div>
      </div>
      <div className="grid min-w-0 gap-3">
        {card}
        <DeckNav i={i} total={slides.length} go={go} />
        <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]" data-testid="slide-feedback">
          {s && <SlideNoteBox key={`${team}:${s.ref}`} m={m} sent={sent} />}
          <div className="grid min-w-0 content-start gap-3">
            {waitLine}
            {s && <SlideChanges rebuild={rebuild} />}
          </div>
        </div>
        {!team && t.deck && (
          <p className="text-xs text-muted-foreground" data-testid="brief-old-deck">
            The longer story deck is still at{" "}
            <a href={t.deck} target="_blank" rel="noreferrer" className="underline">
              its old address
            </a>{" "}
            until its story is in these slides.
          </p>
        )}
      </div>
    </div>
  );
}

/** "What should change on this slide?": the note goes to the campaign chat, which rebuilds the slide. */
export function SlideNoteBox({ m, sent }: { m: Milestone; sent: (text: string) => string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  // the one box (paste, paperclip, drop): a screenshot goes to the campaign chat with the note, like Chat's files.
  const files = useChatAttach({ enabled: true, disabled: busy });
  /** Sends the words (and any screenshots) to the campaign chat; throws when it failed (a voice note keeps its words then). */
  const deliver = async (words: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      if (files.ids.length) await api.sendMilestoneChatMessage(m.id, sent(words), undefined, undefined, files.ids);
      else await api.sendMilestoneChatMessage(m.id, sent(words));
      setText("");
      files.clear();
      setNote({ ok: true, text: "Sent. The campaign chat rebuilds this slide." });
    } catch (e) {
      setNote({ ok: false, text: `Not sent: ${(e as Error).message}` });
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    if ((!text.trim() && !files.ids.length) || !files.ready) return;
    void deliver(text).catch(() => undefined);
  };
  // the shared mic on the campaign's own voice routes: what is typed goes first, then the spoken words, through Send.
  const voice = useAnswerVoice({ origin: `brief:${m.id}`, to: "this slide's change", page: "brief slide", base: campaignVoiceBase(m.id), typed: text, deliver, disabled: busy });
  return (
    <section className="grid gap-2 rounded-lg border p-3" data-testid="slide-note">
      <h3 className="text-sm font-semibold">What should change on this slide?</h3>
      <p className="text-xs text-muted-foreground">The campaign chat rewrites this slide only. You can undo it.</p>
      <WordsBox label="What should change on this slide" rows={2} boxClassName="min-h-16" value={text} onChange={setText} files={files} voice={voice} placeholder="For example: I don't like the tone of these posts. Too technical." testid="slide-note-box" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !files.ready || (!text.trim() && !files.ids.length)} pending={busy} pendingLabel="Sending…" onClick={send} data-testid="slide-note-send">
          Send
        </Button>
        {note && (
          <span role="status" className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
            {note.text}{" "}
            {note.ok && (
              <Link to="?tab=chat" className="underline">
                In Chat
              </Link>
            )}
          </span>
        )}
      </div>
    </section>
  );
}

function SlideChanges({ rebuild }: { rebuild?: TotemRebuild }) {
  const [open, setOpen] = useState(true);
  const list = [...(rebuild?.changes ?? [])].reverse();
  return (
    <FoldSection title="Changes to this slide" count={list.length} testId="slide-changes" open={open} onToggle={setOpen} className="mb-0">
      {list.length ? (
        <ul className="grid gap-2 text-xs">
          {list.map((c, k) => (
            <li key={k} className="[overflow-wrap:anywhere]">
              <span className="text-muted-foreground">{fmtDay(c.date, false)}</span> {c.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No changes yet.</p>
      )}
    </FoldSection>
  );
}

/** The feedback chat inside the full-screen deck: the campaign chat, sent to "This slide" or "Whole campaign". */
function FeedbackChat({ m, slide, sent, waitLine, chatSlot }: { m: Milestone; slide?: TotemSlide; sent: (text: string) => string; waitLine: ReactNode; chatSlot?: (send: (text: string) => string) => ReactNode }) {
  const [scope, setScope] = useState<"slide" | "all">("slide");
  const wrap = useCallback((text: string) => (scope === "slide" && slide ? sent(text) : text), [scope, slide, sent]);
  const load = useCallback((read?: ChatRead) => api.getMilestoneChat(m.id, read), [m.id]);
  // screenshots go with the campaign chat's messages too (the same box as every chat)
  const send = useCallback((text: string, page?: string, id?: string, files?: string[]) => (files?.length ? api.sendMilestoneChatMessage(m.id, wrap(text), page, id, files) : api.sendMilestoneChatMessage(m.id, wrap(text), page, id)), [m.id, wrap]);
  const markSeen = useCallback(() => api.markChatSeen({ chat: "milestone", id: m.id }), [m.id]);
  return (
    <aside className="mx-auto mt-3 flex min-h-0 w-full max-w-6xl flex-1 flex-col bg-background sm:mb-5 sm:rounded-xl" data-testid="feedback-chat">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2">
        <h3 className="text-sm font-semibold" title="The campaign chat, inside the deck.">
          <MessageCircle className="mr-1 inline h-4 w-4" /> Feedback chat
        </h3>
        <Pills
          value={scope}
          onChange={setScope}
          testId="feedback-scope"
          options={[
            ["slide", slide ? `This slide (${slide.n})` : "This slide"],
            ["all", "Whole campaign"],
          ]}
        />
        {waitLine && <div className="w-full">{waitLine}</div>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">
        {chatSlot ? (
          chatSlot(wrap)
        ) : (
          <ChatView
            panel
            voiceBase={campaignVoiceBase(m.id)}
            who="Campaign chat"
            load={load}
            cacheKey={`milestone:${m.id}`}
            sendMessage={send}
            markSeen={markSeen}
            placeholder={scope === "slide" ? "What should change on this slide?" : "Feedback on the whole campaign. For example: make a logo mark for the thread images"}
          />
        )}
      </div>
    </aside>
  );
}

// ---------- Work ----------

const GROUPS: { id: TotemTask["group"]; title: string; meta: string }[] = [
  { id: "waiting", title: "Tasks waiting on you", meta: "in review, or blocked on your answer" },
  { id: "moving", title: "Moving", meta: "picked up at the owner's next wake" },
  { id: "planned", title: "Planned", meta: "not started" },
  { id: "done", title: "Done", meta: "with their outcome" },
];

const statusTone = (s: string): "amber" | "green" | "blue" | "gray" | "red" => (/^\W*(review|held)/i.test(s) ? "amber" : /^\W*done/i.test(s) ? "green" : /^\W*blocked/i.test(s) ? "red" : /^\W*(active|ready)/i.test(s) ? "blue" : "gray");

/** the campaign's tasks (its posts are the Pipeline tab, what waits for the owner the Waiting on me tab). */
export function WorkTab({ m }: { m: Milestone }) {
  const [params] = useSearchParams();
  const q = useTotems(m.id);
  const t = q.data;
  const row = params.get("row");
  return (
    <div data-testid="work-tab">
      <TabHead title="Tasks">
        The campaign's tasks: the rows of its epic file's Issue Ledger. Each one has an owner, a status and an outcome. Research, a logo, a thread to answer and a post to write all land here.
      </TabHead>
      {q.error && !t ? (
        <ErrorBox error={q.error} />
      ) : !t ? (
        <Loading />
      ) : (
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="goal-path">
            {[...t.chain].reverse().map((e, k, all) => (
              <Fragment key={e.path}>
                <span className={cn("min-w-0 [overflow-wrap:anywhere]", k === all.length - 1 && "font-semibold")}>{e.title}</span>
                <span className="text-muted-foreground">›</span>
              </Fragment>
            ))}
            <span className="text-muted-foreground">{t.work.rows.length} tasks</span>
          </div>
          <AddTask m={m} />
          <TaskGroups rows={t.work.rows} row={row} base={{ remote: t.remote ?? undefined, path: t.epic.path }} />
        </div>
      )}
    </div>
  );
}

/** what waits for the owner in this campaign, its own tab (was Work's first section). */
export function WaitingTab({ m }: { m: Milestone }) {
  return (
    <div data-testid="waiting-tab">
      <TabHead title="Waiting on me">The asks and reviews of this campaign that need your answer. Answer here or on the Team page, where the asks of every campaign wait together.</TabHead>
      <WaitingOnYou milestoneId={m.id} fold="campaign-work-waiting" />
    </div>
  );
}

/** Add task: a ready row in the campaign's Issue Ledger (the owner's ask is ready, root L-37); the Delivery manager gives it an owner. */
function AddTask({ m }: { m: Milestone }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setNote(undefined);
    try {
      const r = await mutate(() => api.addToTree(m.id, { kind: "row", title: title.trim() }));
      setTitle("");
      setNote({ ok: true, text: `Added ${r.id ?? "the task"}${r.ready === false ? " as a draft" : ""}. The Delivery manager gives it an owner at its next wake.` });
    } catch (e) {
      setNote({ ok: false, text: `Not added: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      data-testid="add-task"
    >
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 basis-56" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task, for example: research which subreddits allow a demo video" aria-label="New task" data-testid="add-task-title" />
        <Button type="submit" disabled={busy || !title.trim()} pending={busy} pendingLabel="Adding…" data-testid="add-task-send">
          <Plus /> Add task
        </Button>
      </div>
      {note && (
        <div role="status" className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")} data-testid="add-task-result">
          {note.text}
        </div>
      )}
    </form>
  );
}

function TaskGroups({ rows, row, base }: { rows: TotemTask[]; row: string | null; base: { remote?: string; path?: string } }) {
  const target = row ? rows.find((r) => r.id === row) : undefined;
  return (
    <div data-testid="task-groups">
      {GROUPS.map((g) => (
        <TaskGroup key={g.id} g={g} rows={rows.filter((r) => r.group === g.id)} row={row} forceOpen={target?.group === g.id} base={base} />
      ))}
    </div>
  );
}

function TaskGroup({ g, rows, row, forceOpen, base }: { g: (typeof GROUPS)[number]; rows: TotemTask[]; row: string | null; forceOpen: boolean; base: { remote?: string; path?: string } }) {
  const [open, setOpen] = useSectionOpen(`campaign-work-${g.id}`, g.id !== "done");
  const shown = open || forceOpen;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (forceOpen) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [forceOpen, row]);
  if (!rows.length && g.id !== "moving") return null;
  return (
    <FoldSection title={g.title} count={rows.length} tone={g.id === "waiting" ? "needs-you" : "info"} testId={`tasks-${g.id}`} open={shown} onToggle={setOpen} meta={<span className="text-xs text-muted-foreground">{g.meta}</span>} bodyClassName="p-0">
      {rows.length ? (
        <ul className="divide-y">
          {rows.map((r) => (
            <li
              key={r.id}
              ref={r.id === row ? ref : undefined}
              id={`task-${r.id}`}
              className={cn("grid gap-1 px-3 py-2 text-sm sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3", r.id === row && "bg-sky-500/10 ring-2 ring-inset ring-sky-500")}
              data-testid="task-row"
              data-row={r.id}
            >
              <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium" title={r.title}>
                  {r.title}
                </span>
                {(r.evidence || r.next) && (
                  <span className="block truncate text-xs text-muted-foreground" title={[r.evidence, r.next].filter(Boolean).join(" · ")}>
                    <LineText text={r.group === "done" || !r.next ? r.evidence : r.next} base={base} />
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {(r.owner || r.role) && <Badge variant="gray">{/^(unassigned|none|-)?$/i.test(r.owner.trim()) ? `${r.role || "no owner yet"}` : r.owner.replace(/^the /, "")}</Badge>}
                <Badge variant={statusTone(r.status)} title={r.status}>
                  {r.status.split(/[\s(—:]/)[0] || "?"}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">Nothing moving. Add a task above.</p>
      )}
    </FoldSection>
  );
}

// ---------- Observations ----------

export function ObservationsTab({ m }: { m: Milestone }) {
  const [tick, setTick] = useState(0);
  const q = useTotems(m.id, tick);
  const t = q.data;
  const [scope, setScope] = useState<"campaign" | "team">("campaign");
  if (q.error && !t) return <ErrorBox error={q.error} />;
  if (!t) return <Loading />;
  const list = (scope === "team" ? t.team?.observations : t.observations) ?? [];
  const file = scope === "team" ? t.team?.root.path : t.epic.path;
  const base = { remote: t.remote ?? undefined, path: file };
  const proposals = list.filter((o) => o.proposal?.state === "open");
  const force = list.filter((o) => !o.retired);
  const retired = list.filter((o) => o.retired);
  return (
    <div data-testid="observations-tab">
      <TabHead
        title="Observations"
        actions={
          <Pills
            value={scope}
            onChange={setScope}
            testId="observations-scope"
            options={[
              ["campaign", "This campaign"],
              ["team", "Whole team"],
            ]}
          />
        }
      >
        What we learned: your notes and the Reporter's lessons, each with its evidence. Every persona reads the lines in force when it wakes. A line is retired, never deleted.
      </TabHead>
      <ObsSection id="force" title="In force" meta="read at every wake" list={force} base={base} />
      <FoldSectionProposals list={proposals} m={m} file={file} onDone={() => setTick((k) => k + 1)} />
      <ObsSection id="retired" title="Retired" meta="kept, no longer read" list={retired} base={base} byDefault={false} />
    </div>
  );
}

function ObsSection({ id, title, meta, list, base, byDefault = true }: { id: string; title: string; meta: string; list: TotemObservation[]; base: { remote?: string; path?: string }; byDefault?: boolean }) {
  const [open, setOpen] = useSectionOpen(`campaign-obs-${id}`, byDefault);
  return (
    <FoldSection title={title} count={list.length} testId={`obs-${id}`} open={open} onToggle={setOpen} meta={<span className="text-xs text-muted-foreground">{meta}</span>} bodyClassName="p-0">
      {list.length ? (
        <ul className="divide-y">
          {list.map((o) => (
            <ObsRow key={o.id} o={o} base={base} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">None yet.</p>
      )}
    </FoldSection>
  );
}

function ObsRow({ o, base }: { o: TotemObservation; base: { remote?: string; path?: string } }) {
  const [full, setFull] = useState(false);
  const date = /(\d{4}-\d{2}-\d{2})/.exec(`${o.confirmed} ${o.why}`)?.[1];
  return (
    <li className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-center sm:gap-3" data-testid="obs-row" data-id={o.id}>
      <span className="font-mono text-xs text-muted-foreground">
        {o.id}
        {date ? ` · ${fmtDay(date, false)}` : ""}
      </span>
      <button type="button" className={cn("min-w-0 text-left", !full && "truncate")} onClick={() => setFull(!full)} title={o.rule}>
        {o.when && <span className="text-muted-foreground">{o.when}: </span>}
        <LineText text={o.rule} base={base} />
      </button>
      <span className={cn("min-w-0 text-xs text-muted-foreground", !full && "truncate")} title={o.why}>
        <LineText text={o.why} base={base} />
      </span>
      <Badge variant={o.retired ? "gray" : "green"}>{o.retired ? "retired" : o.proposal?.state === "added" ? "in the brief" : "in force"}</Badge>
    </li>
  );
}

function FoldSectionProposals({ list, m, file, onDone }: { list: TotemObservation[]; m: Milestone; file?: string; onDone: () => void }) {
  const [open, setOpen] = useSectionOpen("campaign-obs-proposals");
  return (
    <FoldSection title="Proposed changes to the brief" count={list.length} tone="needs-you" testId="obs-proposals" open={open} onToggle={setOpen} meta={<span className="text-xs text-muted-foreground">when your note and the numbers agree</span>} bodyClassName="p-0">
      {list.length ? (
        <ul className="divide-y">
          {list.map((o) => (
            <ProposalRow key={o.id} o={o} m={m} file={file} onDone={onDone} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">No proposal waits for you.</p>
      )}
    </FoldSection>
  );
}

function ProposalRow({ o, m, file, onDone }: { o: TotemObservation; m: Milestone; file?: string; onDone: () => void }) {
  const [busy, setBusy] = useState<"add" | "notnow">();
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const act = async (action: "add" | "notnow") => {
    setBusy(action);
    setNote(undefined);
    try {
      await mutate(async () => api.decideProposal(await worldId(), m.id, { file, id: o.id, action }));
      setNote({ ok: true, text: action === "add" ? `Added to the brief (${o.proposal!.part}).` : "Kept here, not in the brief." });
      onDone();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <li className="grid gap-2 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-testid="proposal-row" data-id={o.id}>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        Add to <b>{o.proposal!.part}</b>: “{o.proposal!.text}” <span className="text-xs text-muted-foreground">({o.id}, {o.why})</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!!busy} pending={busy === "add"} pendingLabel="Adding…" onClick={() => act("add")} data-testid="proposal-add">
          Add to the brief
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} pending={busy === "notnow"} pendingLabel="Saving…" onClick={() => act("notnow")} data-testid="proposal-notnow">
          Leave it out of the brief
        </Button>
        {note && (
          <span role="status" className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
            {note.text}
          </span>
        )}
      </span>
    </li>
  );
}

// ---------- History ----------

type HistoryFilter = "all" | "decisions" | "owner" | "wakes" | "posts" | "runs";
const FILTERS: [HistoryFilter, string][] = [
  ["all", "All"],
  ["decisions", "Decisions"],
  ["owner", "Your notes"],
  ["wakes", "Wakes"],
  ["posts", "Posts and replies"],
  ["runs", "Runs"],
];
const keepLine = (f: HistoryFilter) => (l: TotemHistoryLine) => f === "all" || (f === "decisions" ? l.kind === "decision" : f === "owner" ? l.kind === "owner" : l.kind === "wake");

export function HistoryTab({ m, posts, runs }: { m: Milestone; posts: ReactNode; runs: ReactNode }) {
  const q = useTotems(m.id);
  const t = q.data;
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [every, setEvery] = useState(false);
  return (
    <div data-testid="history-tab">
      <TabHead
        title="History"
        actions={
          filter !== "posts" && filter !== "runs" ? (
            <Button variant="outline" size="sm" onClick={() => setEvery(!every)} data-testid="history-every">
              {every ? "Fold the days" : "Open every day"}
            </Button>
          ) : undefined
        }
      >
        What happened, newest first. A campaign runs in weeks: each week closes with its result against its targets. Every persona reads the weeks when it wakes and opens a day only when it needs to.
      </TabHead>
      <div className="mb-3">
        <Pills value={filter} onChange={setFilter} testId="history-filter" options={FILTERS} />
      </div>
      {filter === "posts" ? (
        posts
      ) : filter === "runs" ? (
        runs
      ) : q.error && !t ? (
        <ErrorBox error={q.error} />
      ) : !t ? (
        <Loading />
      ) : (
        <div data-testid="history-weeks">
          {t.history.weeks.map((w, k) => (
            <HistoryWeekBox key={`${w.week}:${every}`} w={w} first={k === 0} every={every} keep={keepLine(filter)} base={{ remote: t.remote ?? undefined, path: w.page ?? t.epic.path }} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryWeekBox({ w, first, every, keep, base }: { w: CampaignTotems["history"]["weeks"][number]; first: boolean; every: boolean; keep: (l: TotemHistoryLine) => boolean; base: { remote?: string; path?: string } }) {
  const [open, setOpen] = useState(first || every);
  const days = w.days.map((d) => ({ ...d, lines: d.lines.filter(keep) })).filter((d) => d.lines.length || d.day);
  const count = days.reduce((n, d) => n + d.lines.length, 0);
  const span = /^(\d{4})-W(\d{2})$/.exec(w.week);
  return (
    <FoldSection
      title={<span className="font-semibold">{span ? `Week ${Number(span[2])}` : w.week}</span>}
      count={count}
      testId="history-week"
      open={open}
      onToggle={setOpen}
      meta={<span className="min-w-0 flex-1 basis-60 text-sm text-muted-foreground [overflow-wrap:anywhere]">{w.line || "no result written yet"}</span>}
      bodyClassName="p-0"
    >
      {days.length ? days.map((d, k) => <HistoryDayBox key={d.date} d={d} open={every || (first && k === 0)} base={base} />) : <p className="px-3 py-3 text-sm text-muted-foreground">Nothing logged this week yet.</p>}
    </FoldSection>
  );
}

function HistoryDayBox({ d, open: byDefault, base }: { d: CampaignTotems["history"]["weeks"][number]["days"][number]; open: boolean; base: { remote?: string; path?: string } }) {
  const [open, setOpen] = useState(byDefault);
  return (
    <div className="border-b last:border-b-0" data-testid="history-day" data-date={d.date}>
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-muted/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDownSmall /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="font-semibold">{fmtDay(d.date)}</span>
        {d.day && <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.day}</span>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{d.lines.length}</span>
      </button>
      {open && (
        <ul className="pb-1">
          {d.lines.map((l, k) => (
            <li
              key={k}
              className={cn("grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 px-3 py-1 text-sm sm:grid-cols-[3rem_9rem_minmax(0,1fr)]", l.kind === "owner" && "bg-violet-500/5", l.kind === "decision" && "bg-violet-500/10")}
              data-testid="history-line"
              data-kind={l.kind}
            >
              <span className="tabular-nums text-muted-foreground">{l.time || "·"}</span>
              <span className={cn("truncate font-medium", l.kind !== "wake" && "text-violet-700 dark:text-violet-300")} title={l.who}>
                {l.kind === "owner" ? "You" : l.who}
              </span>
              <span className="col-span-2 min-w-0 [overflow-wrap:anywhere] sm:col-span-1">
                <LineText text={l.text} base={base} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ChevronDownSmall = () => <ChevronRight className="h-4 w-4 rotate-90 text-muted-foreground" />;

// ---------- Chat ----------

/** The Chat tab's words above the campaign chat. */
export function ChatIntro() {
  return (
    <TabHead title="Chat">
      {/* on a phone the chat itself gets the room. */}
      <span className="max-sm:hidden">
        Feedback on the whole campaign. The campaign chat reads the epic file like every persona. Each reply says where your words landed: a task, an observation, the brief or a decision.
      </span>
    </TabHead>
  );
}
