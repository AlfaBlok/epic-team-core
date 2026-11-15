import { useEffect, useState, type ReactNode } from "react";
import { BarChart3, ChevronDown, Flag, Pencil, Trash2, Undo2 } from "lucide-react";
import { api } from "@/api";
import type { OwnerPriority, RedLine } from "@/api/inbox-types";
import { mutate, useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { RedLineCards } from "@/components/redLineCards";
import { shortTo, useAnswerVoice } from "@/voice/AnswerVoice";

const LABEL: Record<OwnerPriority["level"], string> = {
  high: "High priority",
  normal: "Normal priority",
  low: "Low priority",
};
const LOOK: Record<OwnerPriority["level"], string> = {
  // the level is a grey word in the card's meta line.
  high: "text-muted-foreground",
  normal: "text-muted-foreground",
  low: "text-muted-foreground opacity-80",
};
/** the red marker of an item on the owner's red line. */
const RED = "text-muted-foreground";
const RED_LABEL = "On the red line";
/** a named line's marker names it ("Red line: Data-product flywheel"). */
const redLabel = (r: NonNullable<OwnerPriority["redLine"]>) => (r.name ? `Red line: ${r.name}` : RED_LABEL);
/** what he was frustrated about or said again leads the inbox; its marker says which, in his terms. */
const PRESSING_LABEL: Record<NonNullable<OwnerPriority["pressing"]>["kind"], string> = {
  frustrated: "You were frustrated",
  repeated: "You asked again",
};
/**
 * why the item ranks where it does, in one short line: his first objective leads ("Your objective 1: Five testers use
 * the product"); else what put it high (frustrated, said again, red line, level) with the objective it moves.
 */
export function rankWhy(p: OwnerPriority): string {
  const o = p.objective;
  if (o && o.n === 0) return `Your objective 1: ${o.name}`;
  const hot = p.pressing;
  const base = hot ? PRESSING_LABEL[hot.kind] : p.redLine ? redLabel(p.redLine) : undefined;
  if (base) return o ? `${base} · objective ${o.n + 1}` : base;
  return o ? `Your objective ${o.n + 1}: ${o.name}` : LABEL[p.level];
}

/**
 * the owner's level for an inbox item (the Prioritizer read his voice notes and wrote it into the repo); a tap shows
 * why, with his words and the day he said them. Inside a wrapping flex row the why takes its own full-width line.
 * an item on his red line shows a red "On the red line" marker instead, and its why opens with the line.
 */
export function OwnerPriorityTag({ p, className }: { p?: OwnerPriority; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!p) return null;
  const red = p.redLine;
  const hot = p.pressing;
  const first = p.objective?.n === 0;
  const label = rankWhy(p);
  const why = hot ? hot.why : red ? red.sentence : p.why;
  const words = hot ? hot.words : p.words;
  const said = hot ? hot.said : p.said;
  return (
    <>
      <button
        type="button"
        className={cn("shrink-0 text-xs font-medium hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center", red ? RED : LOOK[p.level], className)}
        aria-expanded={open}
        title={open ? undefined : `${label}: ${why}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        data-testid="owner-priority"
        data-level={p.level}
        {...(red ? { "data-red-line": red.name ?? "" } : {})}
        {...(hot ? { "data-pressing": hot.kind } : {})}
        {...(p.objective ? { "data-objective": p.objective.n + 1 } : {})}
      >
        {label}
      </button>
      {open && (
        <div className="basis-full rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground" data-testid="owner-priority-why">
          {red && !hot && (
            <div className="mb-1 font-medium" data-testid="owner-priority-red-line">
              {red.name ? `Red line, ${red.name}: ` : "Red line: "}
              {red.sentence}
            </div>
          )}
          {!first && <div>{hot ? hot.why : p.why}</div>}
          {words && !first && (
            <div className="mt-1 italic text-muted-foreground">
              “{words}”{said ? ` · you said this on ${said}` : ""}
            </div>
          )}
          {p.objective && (
            <div className="mt-1" data-testid="owner-priority-objective">
              {first
                ? `It moves your first objective, ${p.objective.name}, so it leads your inbox.`
                : `It moves your objective ${p.objective.n + 1}, ${p.objective.name}. Your objectives' order sorts your inbox.`}
            </div>
          )}
          <div className="mt-1 text-xs text-muted-foreground">
            {first
              ? "First in your inbox while this is your first objective."
              : hot
                ? "First in your inbox until you answer it."
                : <>Set by the Prioritizer from your voice notes{(red?.at ?? p.at) ? ` on ${red?.at ?? p.at}` : ""}.</>}
          </div>
        </div>
      )}
    </>
  );
}

const day = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * the red line on top of
 * the Team home; the items on it lead the lists below, each with the red marker. Nothing when no line was written.
 * one per named line, in order.
 * one slim row per line (name, day, how many items block it); the pencil unfolds a box to type or
 * speak the change, the bin deletes the line (never its cards) after one confirm, with Undo for a while.
 * a tap unfolds the full inbox cards on the line and nothing else.
 */
export function RedLineBand({ list }: { list?: boolean } = {}) {
  const { data } = useQuery(() => api.redLine(), [], { tag: "inbox" });
  const [gone, setGone] = useState<{
    name: string;
    s: "shown" | "busy" | "failed";
    why?: string;
  }>();
  useEffect(() => {
    if (gone?.s !== "shown") return;
    const t = setTimeout(() => setGone(undefined), UNDO_MS);
    return () => clearTimeout(t);
  }, [gone]);
  const lines = data?.redLines?.length ? data.redLines : data?.redLine ? [data.redLine] : [];
  if (!lines.length && !gone) return null;
  const undo = async (name: string) => {
    setGone({ name, s: "busy" });
    try {
      await mutate(() => api.undoRedLine({ name }), "inbox");
      setGone(undefined);
    } catch (e) {
      setGone({
        name,
        s: "failed",
        why: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const rows = lines.map((r) =>
    list ? <ListRedLine key={r.name ?? r.sentence} r={r} onDeleted={(name) => setGone({ name, s: "shown" })} /> : <OneRedLine key={r.name ?? r.sentence} r={r} onDeleted={(name) => setGone({ name, s: "shown" })} />,
  );
  return (
    <div className={cn("mb-5 flex flex-col", list ? "mb-6 gap-2" : "gap-1.5")} data-testid="red-lines" data-look={list ? "list" : undefined}>
      {/* Settings (the round 2 mockup): a "Red lines" heading, then one quiet list, Edit and Delete as words. */}
      {list && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h2 className="text-[15px] font-semibold text-foreground">Red lines</h2>
          <span className="text-xs text-muted-foreground">their cards lead your Inbox</span>
        </div>
      )}
      {list ? <div className="divide-y rounded-xl border bg-card">{rows}</div> : rows}
      {gone && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-sm" role="status" data-testid="red-line-deleted">
          <span className="min-w-0 flex-1">{gone.s === "failed" ? `Not brought back: ${gone.why}.` : `Deleted the red line “${gone.name}”. Its cards are still in your inbox.`}</span>
          <Button size="sm" variant="outline" className={PHONE_TAP} pending={gone.s === "busy"} pendingLabel="Bringing it back…" onClick={() => void undo(gone.name)} data-testid="red-line-undo">
            <Undo2 className="h-4 w-4" aria-hidden /> Undo
          </Button>
        </div>
      )}
    </div>
  );
}

/** how long Undo stays after a delete. */
export const UNDO_MS = 30_000;

/** the voice note's reply is "<words> (voice note vn_…, audio …)": his words and the note's id apart. */
export function splitVoiceReply(reply: string): {
  words: string;
  note?: string;
} {
  const m = /\s*\(voice note (vn_[\w-]+)(?:, audio [^)]*)?\)\s*$/.exec(reply);
  return m ? { words: reply.slice(0, m.index).trim(), note: m[1] } : { words: reply.trim() };
}

const lineKey = (r: RedLine) => r.name ?? r.sentence;

function OneRedLine({ r, onDeleted }: { r: RedLine; onDeleted: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"edit" | "delete">();
  const n = r.items.length;
  return (
    <section className="overflow-hidden rounded-xl border bg-card" data-testid="red-line" data-red-line-name={r.name ?? ""}>
      {/* one compact row in's look (a filled symbol, big dark words, strong icons); the live
          counts of sit in the row, never in a strip under it. */}
      <div className="flex items-center gap-0.5 pl-2 pr-0.5">
        <button type="button" className="flex min-h-12 min-w-0 flex-1 items-center gap-2 py-1.5 text-left" aria-expanded={open} onClick={() => setOpen(!open)} title={r.sentence} data-testid="red-line-row">
          <span className="inline-flex h-8 w-5 shrink-0 items-center justify-center text-muted-foreground sm:w-8" aria-hidden>
            <Flag className="h-4 w-4" strokeWidth={2} />
          </span>
          {/* on a phone the date sits under the name, so the name keeps the row's width (a two-word name was cut at 360 px) */}
          <span className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
            <span className="line-clamp-2 min-w-0 text-[15px] font-semibold leading-tight text-foreground [overflow-wrap:normal] sm:truncate sm:leading-snug" data-testid="red-line-name">
              {r.name ?? r.sentence}
            </span>
            {r.target && (
              <span className="shrink-0 text-xs text-muted-foreground sm:text-sm" data-testid="red-line-target">
                by {day(r.target)}
              </span>
            )}
          </span>
          <span className="shrink-0 rounded-full bg-[hsl(0_72%_51%)] px-2 text-xs font-semibold leading-5 text-white" title={`${n} ${n === 1 ? "item blocks" : "items block"} it`} data-testid="red-line-count">
            {n}
          </span>
          {r.state === "proposed" && <span className="shrink-0 text-sm text-muted-foreground">proposed</span>}
          <LiveCounts r={r} />
          <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground", open && "rotate-180")} strokeWidth={2.5} aria-hidden />
        </button>
        <LiveLinks r={r} />
        <IconTap label={`Edit the red line ${r.name ?? ""}`} active={mode === "edit"} onClick={() => setMode(mode === "edit" ? undefined : "edit")} testid="red-line-edit">
          <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />
        </IconTap>
        <IconTap label={`Delete the red line ${r.name ?? ""} only, its cards stay`} active={mode === "delete"} onClick={() => setMode(mode === "delete" ? undefined : "delete")} testid="red-line-delete">
          <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
        </IconTap>
      </div>
      {open && <RedLineCards r={r} />}
      {mode === "edit" && <EditBox r={r} onDone={() => setMode(undefined)} />}
      {mode === "delete" && <DeleteConfirm r={r} onCancel={() => setMode(undefined)} onDeleted={() => onDeleted(lineKey(r))} />}
    </section>
  );
}

/** One red line as a quiet row (Settings): name, a grey detail, its red count, Edit and Delete as words. */
function ListRedLine({ r, onDeleted }: { r: RedLine; onDeleted: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"edit" | "delete">();
  const n = r.items.length;
  const detail = [r.target ? `by ${day(r.target)}` : "", ...(r.counts ?? []).map(countText), r.state === "proposed" ? "proposed" : ""].filter(Boolean).join(" · ");
  const link = r.links?.[0];
  const word = "h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <section data-testid="red-line" data-red-line-name={r.name ?? ""}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5">
        <button type="button" className="min-w-0 flex-1 basis-48 text-left text-sm" aria-expanded={open} onClick={() => setOpen(!open)} title={r.sentence} data-testid="red-line-row">
          <span className="text-foreground" data-testid="red-line-name">
            {r.name ?? r.sentence}
          </span>
          {detail && <span className="text-xs text-muted-foreground"> · {detail}</span>}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {link && (
            <a href={link.url} target="_blank" rel="noreferrer" className="mr-1 shrink-0 text-xs text-muted-foreground underline decoration-foreground/25 underline-offset-[3px] hover:text-foreground" data-testid="red-line-link">
              {link.label}
            </a>
          )}
          <span className="shrink-0 rounded-full bg-[hsl(0_72%_51%)] px-1.5 text-xs font-semibold leading-5 text-white" title={`${n} ${n === 1 ? "item blocks" : "items block"} it`} data-testid="red-line-count">
            {n}
          </span>
          <button
            type="button"
            className={cn(word, mode === "edit" && "bg-accent text-foreground")}
            aria-pressed={mode === "edit"}
            aria-label={`Edit the red line ${r.name ?? ""}`.trim()}
            onClick={() => setMode(mode === "edit" ? undefined : "edit")}
            data-testid="red-line-edit"
          >
            Edit
          </button>
          <button
            type="button"
            className={cn(word, mode === "delete" && "bg-accent text-foreground")}
            aria-pressed={mode === "delete"}
            aria-label={`Delete the red line ${r.name ?? ""} only, its cards stay`.trim()}
            onClick={() => setMode(mode === "delete" ? undefined : "delete")}
            data-testid="red-line-delete"
          >
            Delete
          </button>
        </span>
      </div>
      {open && <RedLineCards r={r} />}
      {mode === "edit" && <EditBox r={r} onDone={() => setMode(undefined)} />}
      {mode === "delete" && <DeleteConfirm r={r} onCancel={() => setMode(undefined)} onDeleted={() => onDeleted(lineKey(r))} />}
    </section>
  );
}

function IconTap({ label, active, onClick, testid, children }: { label: string; active: boolean; onClick: () => void; testid: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label.trim()}
      title={label.trim()}
      aria-pressed={active}
      className={cn("flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground sm:w-10", active && "bg-accent text-foreground")}
      onClick={onClick}
      data-testid={testid}
    >
      {children}
    </button>
  );
}

const countText = (c: NonNullable<RedLine["counts"]>[number]) => `${c.value === null || c.value === undefined ? "–" : c.value} ${c.label.toLowerCase()}`;

/**
 * a line's live
 * numbers, inside its one row: shown from 640 px, on the phone they are the page icon's label;
 * where each number came from is its hover, and from 1024 px a short "from …" too.
 */
function LiveCounts({ r }: { r: RedLine }) {
  if (!r.counts?.length) return null;
  const c0 = r.counts[0];
  const read = c0.note?.replace(/^read \d{4}-\d{2}-\d{2} /, "read ");
  return (
    <span className="hidden min-w-0 flex-1 basis-0 items-center gap-x-3 overflow-hidden whitespace-nowrap pl-1 text-sm sm:inline-flex" data-testid="red-line-counts">
      {r.counts.map((c) => (
        <span key={c.source} className="shrink-0 text-muted-foreground" data-testid="red-line-count-value" title={[c.sourceText, c.note].filter(Boolean).join(". ")}>
          {countText(c)}
        </span>
      ))}
      <span className="hidden truncate text-xs text-muted-foreground lg:inline" data-testid="red-line-count-from">
        from {(c0.sourceText ?? "").split(",")[0]}
        {read ? `, ${read}` : ""}
      </span>
    </span>
  );
}

/** The pages a line is about, one icon each beside edit and delete; its label carries the live numbers. */
function LiveLinks({ r }: { r: RedLine }) {
  if (!r.links?.length) return null;
  const nums = (r.counts ?? []).map(countText).join(", ");
  return (
    <>
      {r.links.map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          aria-label={nums ? `${l.label}: ${nums}` : l.label}
          title={nums ? `${l.label}: ${nums}` : l.label}
          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground sm:w-10"
          data-testid="red-line-link"
        >
          <BarChart3 className="h-4 w-4" strokeWidth={2} aria-hidden />
          <span className="sr-only">{l.label}</span>
        </a>
      ))}
    </>
  );
}

function EditBox({ r, onDone }: { r: RedLine; onDone: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ s: "sending" } | { s: "failed"; why: string }>();
  const sending = state?.s === "sending";
  const files = useChatAttach({ enabled: false, disabled: sending });
  const send = async (reply: string) => {
    const { words, note } = splitVoiceReply(reply);
    if (!words) return;
    setState({ s: "sending" });
    try {
      await mutate(
        () =>
          api.editRedLine({
            name: lineKey(r),
            words,
            ...(note ? { note } : {}),
          }),
        "inbox",
      );
      setText("");
      setState(undefined);
      onDone();
    } catch (e) {
      setState({
        s: "failed",
        why: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const voice = useAnswerVoice({
    origin: `red-line:${lineKey(r)}`,
    to: shortTo(`red line ${lineKey(r)}`),
    page: `red line ${lineKey(r)}: ${r.sentence}`.slice(0, 200),
    typed: text,
    deliver: async (reply) => {
      setText("");
      await send(reply);
    },
    disabled: sending,
  });
  return (
    <div className="grid gap-2 border-t px-3 py-2" data-testid="red-line-edit-box">
      <p className="text-sm text-muted-foreground">{r.sentence}</p>
      <WordsBox label="How should this line change?" boxClassName="min-h-16" placeholder="Say or type the change: a new name, a new sentence, a new day." value={text} onChange={setText} files={files} voice={voice} testid="red-line-words" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className={PHONE_TAP} disabled={voice.busy || !text.trim()} pending={sending} pendingLabel="Changing…" onClick={() => void send(text)} data-testid="red-line-save">
          Change the line
        </Button>
        <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={sending || voice.busy} onClick={onDone}>
          Cancel
        </Button>
        {state?.s === "failed" && (
          <span className="text-xs text-destructive" role="alert" data-testid="red-line-failed">
            Not changed: {state.why}
          </span>
        )}
      </div>
    </div>
  );
}

function DeleteConfirm({ r, onCancel, onDeleted }: { r: RedLine; onCancel: () => void; onDeleted: () => void }) {
  const [state, setState] = useState<{ s: "sending" } | { s: "failed"; why: string }>();
  const del = async () => {
    setState({ s: "sending" });
    try {
      await mutate(() => api.deleteRedLine({ name: lineKey(r) }), "inbox");
      onDeleted();
    } catch (e) {
      setState({
        s: "failed",
        why: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-sm" data-testid="red-line-delete-confirm">
      <span className="min-w-0 flex-1">Delete the red line “{r.name ?? r.sentence}”? Only the line goes. Its cards stay in your inbox, they just stop leading it.</span>
      <Button size="sm" variant="destructive" className={PHONE_TAP} pending={state?.s === "sending"} pendingLabel="Deleting…" onClick={() => void del()} data-testid="red-line-delete-yes">
        Delete the line
      </Button>
      <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={state?.s === "sending"} onClick={onCancel}>
        Cancel
      </Button>
      {state?.s === "failed" && (
        <span className="basis-full text-xs text-destructive" role="alert">
          Not deleted: {state.why}
        </span>
      )}
    </div>
  );
}
