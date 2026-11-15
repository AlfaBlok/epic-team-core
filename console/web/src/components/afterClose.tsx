import { useEffect, useRef, useState } from "react";
import { Check, Loader2, MessageSquarePlus, Undo2, X } from "lucide-react";
import { api } from "@/api";
import type { ClosedCard, ClosedCardRef } from "@/api/review-types";
import { closeNote, NOTE_MS, useClosedNote, type ClosedNote } from "@/lib/afterClose";
import { invalidate, mutate, useQuery } from "@/lib/data";
import { useSentShown } from "@/lib/sentRows";
import { onPress } from "@/lib/press";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PHONE_TAP, RelTime } from "@/components/common";
import { useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { FoldSection } from "@/components/homeSection";
import { LimitControl, ListPane, limitList, useListLimit } from "@/components/listPane";
import { cardPage, shortTo, useAnswerVoice } from "@/voice/AnswerVoice";

/**
 * his words on a closed card (Add a last thought on the floating note, Add comment on Recently closed): typed or
 * a voice note (Send sends it at once, like a card's own box), filed to the card's row or ask and sent to its owner, who
 * may change the decision (a new round). Saved first: the box says so at once and the console writes it in the background.
 */
export function ThoughtBox({ card, label, onSent, onCancel, testid = "thought" }: { card: ClosedCardRef & { title: string }; label: string; onSent?: () => void; onCancel?: () => void; testid?: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ s: "sending" | "sent" } | { s: "failed"; why: string }>();
  const sending = state?.s === "sending";
  const files = useChatAttach({ enabled: true, disabled: sending });
  const send = async (words: string, via: "text" | "voice" = "text") => {
    if (!words.trim() && !files.ids.length) return;
    setState({ s: "sending" });
    // L-1, L-38: "Sent" as soon as the console has saved it (its 202); it is written to the project in the background
    let saved = false;
    const done = () => {
      if (saved) return;
      saved = true;
      setText("");
      files.clear();
      setState({ s: "sent" });
      onSent?.();
    };
    const off = onPress((n) => n.path === "/closed-cards/comment" && n.state === "landing" && done());
    try {
      await mutate(() => api.commentClosedCard({ ...card, text: words.trim(), ...(files.ids.length ? { attachments: files.ids } : {}), via }), "inbox");
      done();
    } catch (e) {
      setState({ s: "failed", why: e instanceof Error ? e.message : String(e) });
      if (!saved) throw e;
    } finally {
      off();
    }
  };
  const voice = useAnswerVoice({
    origin: `thought:${card.repo}:${card.ref}`,
    to: shortTo(card.title),
    page: cardPage(card.ref, card.title),
    typed: text,
    deliver: async (reply) => {
      setText("");
      await send(reply, "voice");
    },
    disabled: sending,
  });
  return (
    <div className="grid gap-2" data-testid={testid}>
      <WordsBox label={label} boxClassName="min-h-16" placeholder="Anything: a last thought, a change, even a different decision." value={text} onChange={setText} files={files} voice={voice} testid={`${testid}-box`} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className={PHONE_TAP} disabled={voice.busy || !files.ready || (!text.trim() && !files.ids.length)} pending={sending} pendingLabel="Sending…" onClick={() => void send(text).catch(() => undefined)} data-testid={`${testid}-send`}>
          Send to the owner
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={sending || voice.busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        {state?.s === "sent" && (
          <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400" role="status" data-testid={`${testid}-sent`}>
            <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden /> Sent. The owner reads it and acts on it.
          </span>
        )}
        {state?.s === "failed" && (
          <span className="text-xs text-destructive" role="alert" data-testid={`${testid}-failed`}>
            Not sent: {state.why}. Press again.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * the floating note after a card closes (phone first: full width at the bottom, big taps). It goes after
 * NOTE_MS unless he opens the box (or the pointer or focus is on it); Bring it back says what it did.
 */
export function AfterCloseNote() {
  const note = useClosedNote();
  // vn_e00f1134: the card became its own green Sent row in place; no second "Saved" floating over the page
  const inPlace = useSentShown(note?.slot ? [note.slot].flat()[0] : undefined);
  useEffect(() => {
    if (note && inPlace) closeNote(note.id);
  }, [note, inPlace]);
  if (!note || inPlace) return null;
  return <NoteView key={note.id} note={note} />;
}

function NoteView({ note }: { note: ClosedNote }) {
  const [open, setOpen] = useState(false);
  const [hold, setHold] = useState(false);
  const [sent, setSent] = useState(false);
  const [back, setBack] = useState<{ s: "busy" } | { s: "done" | "failed"; line: string }>();
  const left = useRef(NOTE_MS);
  const [, tick] = useState(0);
  const stay = open || hold || back?.s === "busy" || back?.s === "failed";
  useEffect(() => {
    if (stay) return;
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      left.current -= now - last;
      last = now;
      tick((n) => n + 1);
      if (left.current <= 0) closeNote(note.id);
    }, 100);
    return () => clearInterval(t);
  }, [stay, note.id]);
  const bringBack = async () => {
    if (!note.back) return;
    setBack({ s: "busy" });
    try {
      const r = await note.back();
      setBack({ s: r.back ? "done" : "failed", line: r.line });
      if (r.back) {
        invalidate("inbox");
        left.current = 2_500;
      } else if (note.card) setOpen(true);
    } catch (e) {
      setBack({ s: "failed", line: `Not brought back: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const done = back?.s === "done";
  return (
    <div className="fixed inset-x-0 bottom-3 z-[60] flex justify-center px-3" data-testid="after-close-note" onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)} onFocus={() => setHold(true)} onBlur={() => setHold(false)}>
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-emerald-600/40 bg-card text-card-foreground shadow-xl" role="status" aria-live="polite">
        <div className="flex items-start gap-2 px-3 pt-2.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" strokeWidth={3} aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <b data-testid="after-close-said">{done ? "Brought back." : `Saved. ${note.said}.`}</b>
            <span className="block truncate text-xs text-muted-foreground" title={note.title}>
              {note.title}
            </span>
          </div>
          <button type="button" className={cn("-mr-1 rounded p-1 text-muted-foreground hover:bg-muted", PHONE_TAP)} aria-label="Close" onClick={() => closeNote(note.id)} data-testid="after-close-dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
        {sent && (
          <p className="px-3 pt-1 text-xs text-emerald-700 dark:text-emerald-400" data-testid="after-close-sent">
            Your last thought was sent. The owner reads it and acts on it.
          </p>
        )}
        {back && back.s !== "busy" && (
          <p className={cn("px-3 pt-1 text-xs", back.s === "done" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")} data-testid="after-close-back-line">
            {back.line}
          </p>
        )}
        {!done && (
          <div className="flex flex-wrap gap-2 px-3 py-2">
            {note.card && !open && !sent && (
              <Button size="sm" variant="outline" className={cn("flex-1", PHONE_TAP)} onClick={() => setOpen(true)} data-testid="after-close-thought">
                <MessageSquarePlus className="h-4 w-4" aria-hidden /> Add a last thought
              </Button>
            )}
            {note.back && back?.s !== "failed" && (
              <Button size="sm" variant="outline" className={cn("flex-1", PHONE_TAP)} disabled={back?.s === "busy"} onClick={() => void bringBack()} data-testid="after-close-back">
                {back?.s === "busy" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" aria-hidden />} {back?.s === "busy" ? "Bringing it back…" : "Bring it back"}
              </Button>
            )}
          </div>
        )}
        {open && note.card && !done && (
          <div className="border-t px-3 py-2">
            <ThoughtBox card={{ ...note.card, title: note.title }} label="Your last thought" onSent={() => ((left.current = 3_000), setSent(true), setOpen(false), setHold(false))} onCancel={() => setOpen(false)} testid="after-close-box" />
          </div>
        )}
        {!stay && !done && <div className="h-1 bg-emerald-600/60 transition-[width] duration-100 ease-linear" style={{ width: `${Math.max(0, (left.current / NOTE_MS) * 100)}%` }} aria-hidden />}
      </div>
    </div>
  );
}

const OUTCOME: Record<ClosedCard["outcome"], string> = { approved: "Approved", declined: "Declined", changes: "Changes wanted", answered: "Answered" };

/**
 * every card he closed in the last 30 days, findable on Team home, with Add comment (his words reach the row's or
 * ask's owner, who may change the decision). Folded by default with its count (L-39); a compact line per card.
 */
export function RecentlyClosed() {
  const { data } = useQuery(() => api.listClosedCards().catch(() => [] as ClosedCard[]), [], { tag: "inbox" });
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useListLimit("recently-closed");
  const [writing, setWriting] = useState<string>();
  const items = data ?? [];
  if (!items.length) return null;
  const shown = limitList(items, limit);
  return (
    <FoldSection title="Recently closed" count={items.length} testId="recently-closed" bodyTestId="recently-closed-section" open={open} onToggle={setOpen} actions={<LimitControl limit={limit} onChange={setLimit} total={items.length} testId="recently-closed" />}>
      <p className="mb-2 text-xs text-muted-foreground">The cards you closed in the last 30 days. Add comment sends your words to the owner, even to change what you decided.</p>
      <ListPane shown={shown.length} total={items.length} testId="recently-closed" className="grid-cols-1">
        {shown.map((c) => (
          <li key={c.key} className="grid min-w-0 gap-1.5 py-1.5 text-sm" data-testid="recently-closed-item" data-ref={c.ref}>
            {/* phone first: the title has its own line there; time, comments and the button go under it */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 basis-full truncate sm:basis-0 sm:flex-1" title={c.title}>
                <span className="text-muted-foreground">{OUTCOME[c.outcome]}:</span> {c.title}
                {c.answer && <span className="text-muted-foreground"> — “{c.answer}”</span>}
              </span>
              <RelTime iso={c.at} className="shrink-0 text-xs text-muted-foreground" />
              {c.comments > 0 && <span className="shrink-0 text-xs text-muted-foreground">{c.comments === 1 ? "1 comment" : `${c.comments} comments`}</span>}
              {writing !== c.key && (
                <Button size="sm" variant="outline" className={cn("ml-auto h-7 shrink-0 text-xs", PHONE_TAP)} onClick={() => setWriting(c.key)} data-testid="recently-closed-comment">
                  <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> Add comment
                </Button>
              )}
            </div>
            {writing === c.key && <ThoughtBox card={c} label={`Your comment on ${c.title}`} onCancel={() => setWriting(undefined)} testid="recently-closed-box" />}
          </li>
        ))}
      </ListPane>
    </FoldSection>
  );
}
