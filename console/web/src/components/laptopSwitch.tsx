import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Laptop, Loader2, MessageSquareReply, RotateCcw, Send } from "lucide-react";
import { api, type LaptopFor, type LaptopStep, type LaptopView, type MacTask, type StepTickInput, type WaitingItem } from "@/api";
import { mutate } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PHONE_TAP } from "@/components/common";
import { ACTION, PRESS, pressProps, type Pressing } from "@/components/cardActions";
import { useChatAttach, wordsWithFiles } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { cardPage, shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { cn } from "@/lib/utils";
import { homeRepo } from "@/lib/identity";

/**
 * "I'm on my laptop for 1 h / 2 h / until I say", on top of the Team home's
 * inbox. While on, every needs Mac agent task comes first, red line first, then his priority (the inbox's order of the
 * Mac asks), each with its minutes and one Copy command button; off at its time or when he says. The server tells the
 * Team desk each way (hosted/console/server/src/laptop.ts).
 */
export interface LaptopRow {
  key: string;
  title: string;
  repo: string;
  code?: string;
  url?: string;
  command?: string;
  minutes?: number;
  redLine: boolean;
  /** the ticket's row and ask (what its card's press names as waiting on the step). */
  row?: string;
  ask?: string;
  /** its ticket page's step: the card writes it (Done, Stuck, a note), the page shows the same. */
  step?: LaptopStep;
  /** the inbox's ask behind it: a task with no ticket page is that ask's own card. */
  item?: WaitingItem;
  /** a Done (on the card or the page) cleared it; shown only on the card he just pressed. */
  done?: boolean;
}

const FOR: { f: LaptopFor; label: string }[] = [
  { f: "1h", label: "1 h" },
  { f: "2h", label: "2 h" },
  { f: "open", label: "Until I say" },
];

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** A Mac ask opens with the page it means (`http://…/t//: paste this command…`). */
const LEAD = /^[\s—–-]*(?:(?:needs mac agent|mac page)\s*:?\s*)?(https?:\/\/\S+)?\s*(?:\([^)]*\))?[\s:—–-]*/i;
const leadUrl = (q: string) => q.match(LEAD)?.[1];
/** The ticket row its leading link names (`…/t//` →). */
const ticketRowOf = (i: WaitingItem) => leadUrl(i.question ?? "")?.match(/\/t\/([^/]+)\/?$/)?.[1];
/** The ask that only points at the whole Mac list ('s kind): this switch is that list, so it is no row here. */
const isListAsk = (i: WaitingItem) => /\/mac\/?$/.test(leadUrl(i.question ?? "") ?? "");
/** The words without the leading link or label, first letter up; none left = its code. */
export function plainTitle(q: string, fallback: string): string {
  const t = q.replace(LEAD, "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : fallback;
}
/** The ticket page of an inbox Mac ask: its leading link, else its first link to a /t/ page. */
const ticketOf = (i: WaitingItem) => leadUrl(i.question ?? "") ?? i.contextLinks.find((l) => /\/t\/[^/]+\/?$/.test(l.url))?.url;

/**
 * The Mac tasks in run order: each task ranks by the inbox's Mac ask it answers (the server sorted those red line first,
 * then the owner's level, then the milestone order: `priority`); a task whose ask is not in the inbox comes after, in the Mac
 * list's own order. An ask is a task's by its code, the ticket its link opens, or the row it unblocks. An inbox Mac ask
 * with no task (no ticket written yet) is a row too, without a command.
 */
export function laptopRows(tasks: MacTask[], macAll: WaitingItem[], done: MacTask[] = []): LaptopRow[] {
  const mac = macAll.filter((i) => !isListAsk(i));
  const rankOf = (i: WaitingItem | undefined, n: number) => (i ? (i.ownerPriority?.redLine ? -1e12 : 0) + (i.priority ?? n) : Number.MAX_SAFE_INTEGER);
  const index = new Map(mac.map((i, n) => [i.id, n]));
  const mine = (t: MacTask) => (i: WaitingItem) => (!i.repo || same(i.repo, t.repo)) && (same(i.code, t.ask) || (!!t.row && (same(ticketRowOf(i), t.row) || same(i.row, t.row))));
  const used = new Set<string>();
  // a task a Done cleared still holds its asks (an ask of a done ticket is never a row of its own)
  const finished = new Set(done.map((t) => t.key));
  const rows = [...tasks, ...done.filter((t) => !tasks.some((x) => x.key === t.key))].map((t) => {
    const all = mac.filter(mine(t));
    for (const i of all) used.add(i.id);
    // The best-ranked of its asks sets its place (a ticket can answer two).
    const i = all.sort((a, b) => rankOf(a, index.get(a.id)!) - rankOf(b, index.get(b.id)!))[0];
    return { t, i, rank: rankOf(i, index.get(i?.id ?? "") ?? 0) };
  });
  rows.sort((a, b) => a.rank - b.rank || a.t.order - b.t.order || a.t.key.localeCompare(b.t.key));
  const out: (LaptopRow & { rank: number })[] = rows.map(({ t, i, rank }) => ({
    key: t.key,
    // A ticket's title is written for him; an inline ask's words are the ask's, without its link.
    title: t.row ? t.title : plainTitle(i?.question ?? t.title, t.ask ?? t.title),
    repo: t.repo,
    code: t.row ?? t.ask,
    url: t.url,
    command: t.command,
    minutes: t.minutes,
    redLine: !!i?.ownerPriority?.redLine,
    ...(t.row ? { row: t.row } : {}),
    ...(t.ask ? { ask: t.ask } : {}),
    ...(t.step ? { step: t.step } : {}),
    ...(i ? { item: i } : {}),
    ...(finished.has(t.key) || t.step?.state === "done" ? { done: true } : {}),
    rank,
  }));
  for (const [n, i] of mac.entries()) {
    if (used.has(i.id)) continue;
    out.push({ key: i.id, title: plainTitle(i.question || i.title, i.code ?? i.title), repo: i.repo ?? "", code: i.code, url: ticketOf(i), redLine: !!i.ownerPriority?.redLine, item: i, rank: rankOf(i, n) });
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _r, ...r }) => r);
}

/** Plain http (the tailnet) has no navigator.clipboard: copy through a hidden textarea. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(t);
  return ok;
}

function CopyCommand({ command }: { command: string }) {
  const [said, setSaid] = useState<"copied" | "failed" | undefined>();
  return (
    <Button
      size="sm"
      className={cn("w-fit shrink-0", PHONE_TAP)}
      title={command}
      data-testid="laptop-copy"
      onClick={async () => setSaid((await copyText(command)) ? "copied" : "failed")}
    >
      {said === "copied" ? <Check /> : <Copy />} {said === "copied" ? "Copied" : said === "failed" ? "Press and hold to copy" : "Copy the text"}
    </Button>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function left(until: string, now: number): string {
  const m = Math.max(0, Math.round((Date.parse(until) - now) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
}

export function LaptopSwitch({ view, mac, listUrl, askCard }: { view?: LaptopView; mac: WaitingItem[]; listUrl: string; askCard?: (item: WaitingItem) => ReactNode }) {
  const [busy, setBusy] = useState<LaptopFor | "off" | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const s = view?.session;
  // The server ends a session at its time within a minute; the screen does not wait for it.
  const on = !!s && (!s.until || Date.parse(s.until) > now);
  const all = laptopRows(view?.tasks ?? [], mac, view?.done);
  const rows = all.filter((r) => !r.done);
  const withCmd = rows.filter((r) => r.command);
  const minutes = withCmd.reduce((n, r) => n + (r.minutes ?? 0), 0);
  const act = (b: LaptopFor | "off") => async () => {
    setBusy(b);
    setErr(undefined);
    try {
      await mutate<unknown>(() => (b === "off" ? api.laptopOff() : api.setLaptop(b)), "inbox");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const spin = (b: LaptopFor | "off") => (busy === b ? <Loader2 className="animate-spin" /> : null);
  return (
    <section
      className={cn("mb-3 rounded-xl border bg-card px-4 py-3")}
      data-testid="laptop-switch"
      data-on={on ? "1" : "0"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <Laptop className="h-4 w-4" />
          {on ? (s!.until ? `On your laptop until ${clock(s!.until)}` : "On your laptop until you say") : "I'm on my laptop for"}
        </span>
        {on ? (
          <>
            {s!.until && <span className="text-xs text-muted-foreground" data-testid="laptop-left">{left(s!.until, now)}</span>}
            <Button size="sm" variant="outline" className={cn("ml-auto", PHONE_TAP)} disabled={!!busy} onClick={act("off")} data-testid="laptop-off">
              {spin("off")} I'm off the laptop
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            {FOR.map(({ f, label }) => (
              <Button key={f} size="sm" variant="outline" className={PHONE_TAP} disabled={!!busy} onClick={act(f)} data-testid={`laptop-on-${f}`}>
                {spin(f)} {label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="laptop-summary">
        {rows.length === 0
          ? "No task waits on your Mac now."
          : `${withCmd.length} task${withCmd.length === 1 ? "" : "s"} for Claude on your Mac, about ${minutes} minutes one after another, red line first.`}
        {on ? " Open the Claude app, start a new session, paste the text and send it. No Terminal. The team knows you are here." : rows.length ? " Turn it on and they come first here, and the team is told." : ""}
      </p>
      {err && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{err}</p>}
      {on && all.length > 0 && <MacCards rows={all} askCard={askCard} />}
      {on && (
        <p className="mt-2 text-xs text-muted-foreground">
          <a className="underline" href={view?.listUrl || listUrl} target="_blank" rel="noreferrer">
            The Mac list
          </a>{" "}
          has the same texts with each ticket's report.
        </p>
      )}
    </section>
  );
}

/**
 * every Mac task is a full card, in the laptop
 * list and in the Needs Mac agent fold alike. A task with a ticket page writes that page's step (Done, Stuck or changes
 * wanted, a note with no length limit, a voice note, screenshots): the steps kit's own path, so the page shows the same
 * state and its owner is woken. A task with no page is its inbox ask's own card (`askCard`). A Done clears the task;
 * the card he just pressed stays with Not done after all until he leaves the page.
 */
export function MacCards({ rows, askCard, testId = "laptop-tasks" }: { rows: LaptopRow[]; askCard?: (item: WaitingItem) => ReactNode; testId?: string }) {
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const shown = rows.filter((r) => !r.done || kept.has(r.key));
  const open = shown.filter((r) => !r.done);
  if (!shown.length) return null;
  return (
    <ol className="mt-3 grid grid-cols-1 gap-3" data-testid={testId}>
      {shown.map((r) => (
        <li key={r.key} className="min-w-0" data-testid="laptop-task" data-state={r.step?.state ?? "none"}>
          {r.step ? (
            <LaptopCard row={r} n={open.indexOf(r) + 1} onDone={() => setKept((k) => new Set(k).add(r.key))} />
          ) : r.item && askCard ? (
            <div className="grid min-w-0 gap-1.5">
              <TaskHead row={r} n={open.indexOf(r) + 1} />
              {r.command && <CopyCommand command={r.command} />}
              {askCard(r.item)}
            </div>
          ) : (
            <Card className="py-0">
              <CardContent className="grid min-w-0 gap-2 px-3 py-3">
                <TaskHead row={r} n={open.indexOf(r) + 1} />
                <TaskTitle row={r} />
                {r.command ? <CopyCommand command={r.command} /> : <span className="text-xs text-muted-foreground">No text yet: its next wake writes the ticket.</span>}
              </CardContent>
            </Card>
          )}
        </li>
      ))}
    </ol>
  );
}

function TaskHead({ row: r, n }: { row: LaptopRow; n: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {n > 0 && <span>{n}</span>}
      {r.redLine && <span className="text-xs text-muted-foreground" data-testid="laptop-red-line">Red line</span>}
      {r.minutes != null && <span data-testid="laptop-minutes">{r.minutes} min</span>}
      {r.code && <span>{r.code}</span>}
      {r.repo && r.repo !== homeRepo() && <span>{r.repo}</span>}
      {r.step?.state === "stuck" && <span className="font-medium text-foreground" data-testid="laptop-state">Stuck</span>}
      {r.step?.state === "done" && <span className="text-muted-foreground" data-testid="laptop-state">Done</span>}
    </div>
  );
}

function TaskTitle({ row: r }: { row: LaptopRow }) {
  return r.url ? (
    <a className="text-sm font-medium hover:underline" href={r.url} target="_blank" rel="noreferrer">
      {r.title} <ExternalLink className="inline h-3 w-3" />
    </a>
  ) : (
    <span className="text-sm font-medium">{r.title}</span>
  );
}

/** Where the newest press is: saved and filing, in the repo, or refused (root L-38: said at the buttons). */
function changeLine(c: LaptopStep["change"]): { text: string; bad?: boolean } | undefined {
  if (!c) return undefined;
  if (c.status === "saved") return { text: "Saved. Filing it to the repo…" };
  if (c.status === "failed") return { text: `Not filed: ${c.reason ?? "the repo refused it"}. Press again or tell the team.`, bad: true };
  if (c.status === "filed") return { text: `In the repo${c.sha ? ` (${c.sha.slice(0, 7)})` : ""}. The team was told${c.wake === "started" || c.wake === "sent" ? " and its owner woken" : ""}.` };
  return undefined;
}

type Press = "done" | "stuck" | "note" | "todo";

export function LaptopCard({ row: r, n, onDone }: { row: LaptopRow; n: number; onDone?: () => void }) {
  const st = r.step!;
  const [words, setWords] = useState("");
  const [press, setPress] = useState<Pressing>();
  const [err, setErr] = useState<string>();
  const files = useChatAttach({ enabled: true, disabled: !!press });
  async function send(kind: Press, spoken?: string) {
    setPress({ key: kind, phase: "sending" });
    setErr(undefined);
    try {
      const said = spoken ?? (await wordsWithFiles(words, files.ids));
      const body: StepTickInput = { step: st.step, title: r.title, ...(r.row ? { row: r.row } : r.ask ? { ask: r.ask } : {}), ...(kind === "note" ? {} : { state: kind }), ...(said.trim() ? { comment: said } : {}) };
      await mutate(() => api.stepTick(st.pageId, body), "inbox");
      if (kind === "done") onDone?.();
      setWords("");
      files.clear();
      setPress({ key: kind, phase: "saved" });
      setTimeout(() => setPress(undefined), PRESS.savedMs * 4);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      setPress(undefined);
      return false;
    }
  }
  const voice = useAnswerVoice({
    origin: `laptop:${r.key}`,
    to: shortTo(r.title),
    page: cardPage(r.code ?? r.key, r.title),
    typed: words,
    deliver: async (reply) => {
      if (!(await send("note", reply))) throw new Error("the card did not take it");
    },
    disabled: !!press,
  });
  const wait = !!press || voice.busy || !files.ready;
  const typed = !!words.trim() || files.ids.length > 0;
  const line = changeLine(st.change);
  const last = st.notes.slice(-2);
  return (
    <Card className={cn("py-0", st.state === "done" && "opacity-80")} data-testid="laptop-card">
      <CardContent className="grid min-w-0 gap-2 px-3 py-3">
        <TaskHead row={r} n={st.state === "done" ? 0 : n} />
        <TaskTitle row={r} />
        <p className="text-xs text-muted-foreground">
          {st.state === "done"
            ? "Done. It is off your laptop list, and the ticket page says Done too."
            : "Claude on your Mac does this. Copy the text, paste it into a new session of the Claude app and send it. Then press Done here or on its page."}
        </p>
        {st.state === "stuck" && st.words && (
          <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-foreground" data-testid="laptop-stuck-words">
            Stuck: {st.words}
          </p>
        )}
        {last.length > 0 && (
          <ul className="grid gap-0.5 text-xs text-muted-foreground" data-testid="laptop-notes">
            {last.map((x, i) => (
              <li key={i} className="line-clamp-2" title={x.words}>
                Note {x.at}: {x.words}
              </li>
            ))}
          </ul>
        )}
        {r.command && st.state !== "done" && <CopyCommand command={r.command} />}
        <WordsBox
          label="A note for the team"
          placeholder="A note, what you saw, or what should change. Any length. Speak it, or paste a screenshot."
          value={words}
          onChange={setWords}
          files={files}
          voice={voice}
          testid="laptop-note"
        />
        <div className="flex flex-wrap items-center gap-2" data-testid="laptop-buttons">
          {st.state !== "done" ? (
            <>
              <Button size="sm" className={PHONE_TAP} onClick={() => send("done")} data-testid="laptop-done" {...pressProps(press, "done", wait)}>
                <Check /> {ACTION.done.label}
              </Button>
              <Button size="sm" variant="outline" className={PHONE_TAP} onClick={() => send("stuck")} data-testid="laptop-stuck" {...pressProps(press, "stuck", wait || (st.state === "stuck" && !typed))}>
                <MessageSquareReply /> Stuck or changes wanted
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className={PHONE_TAP} onClick={() => send("todo")} data-testid="laptop-undo" {...pressProps(press, "todo", wait)}>
              <RotateCcw /> Not done after all
            </Button>
          )}
          <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => send("note")} data-testid="laptop-send-note" {...pressProps(press, "note", wait || !typed)}>
            <Send /> Send the note
          </Button>
          {err ? (
            <span className="text-xs text-red-700 dark:text-red-400" data-testid="laptop-error">{err}</span>
          ) : (
            line && (
              <span className={cn("text-xs", line.bad ? "text-red-700 dark:text-red-400" : "text-muted-foreground")} data-testid="laptop-change">
                {line.text}
              </span>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}
