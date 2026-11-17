import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquareText, Mic } from "lucide-react";
import { api } from "@/api";
import { mutate } from "@/lib/data";
import { markSent } from "@/lib/sentRows";
import type { ClosedCardRef } from "@/api/review-types";
import { CardButton } from "@/components/ui/cardButton";
import { useChatAttach, type ChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { homeWorld } from "@/lib/identity";
import { knownWorld } from "@/lib/useSocial";
import { cn } from "@/lib/utils";
import { cardPage, shortTo, useAnswerVoice, type AnswerVoice } from "@/voice/AnswerVoice";

/**
 * E948-S60 (the owner 2026-11-12 18:27Z, Team desk vn_3d129e53: "Never again I want to see a card with I don't have a simple
 * button to give feedback that allows me to add text, screenshots, voice"): the one feedback block every card carries,
 * the same on every card type, in both skins.
 *
 * - a text box (any length),
 * - a screenshot: paste it (Ctrl/Cmd+V, a phone's Paste in the paperclip menu), drop it, or pick it with the paperclip,
 * - a microphone with its word ("Voice") on every screen, recording in place (the card recorder, useAnswerVoice),
 * - Send.
 *
 * E948-S131 (vn_73e840cd): no box open by default. The card's one row is its answer buttons, then Voice (one tap records,
 * the next sends) and Text (opens the box with its paperclip and Send), even on a phone. A card with its own words state (an ask's answer box, a review's
 * Not yet note) passes its state in (`FeedbackBlock`); every other card uses `CardFeedback`, which keeps its own.
 * The inventory (cardInventory.tsx) lists every card type and its test fails when one has no block.
 */

export const FEEDBACK_LABEL = "Feedback";
/** the box's one prompt, once Text opened it (the microphone is its own button, Voice, beside it). */
export const FEEDBACK_HINT = "Write, or paste a screenshot";
export const FEEDBACK_SEND = "Send";
/** E948-S131 (vn_73e840cd): the two buttons every card ends with, after its own answer buttons. */
export const FEEDBACK_VOICE = "Voice";
export const FEEDBACK_TEXT = "Text";

/**
 * every button in a card's one row (its answers, Park, Snooze, Voice, Text): the same height, and on a phone each line of
 * the row is filled evenly (each button grows), so a row that wraps reads as even blocks, never a ragged run (vn_73e840cd:
 * "harmonize the buttons so that they look harmonious on the mobile and not messy").
 */
export const ROW_BUTTON = "max-sm:min-h-11 max-sm:flex-auto max-sm:justify-center";

/**
 * two quiet buttons that belong together (Park and Snooze, Voice and Text): on a computer they sit in the card's one row
 * like the rest; on a phone they take a line of their own as two equal halves, so the row reads as even blocks.
 */
export function RowPair({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <span className="contents max-sm:grid max-sm:basis-full max-sm:grid-cols-2 max-sm:gap-2 max-sm:[&>*]:w-full max-sm:[&_button]:w-full" data-row-pair="" {...rest}>
      {children}
    </span>
  );
}

/** a microphone that is off (voice paused for the month, or no voice on this console): still in place, it says why. */
function MicOff() {
  return (
    <CardButton type="button" variant="outline" disabled className={cn("gap-1.5 text-sm [&_svg]:size-4", ROW_BUTTON)} title="Voice is off on this console or paused for the month" data-testid="feedback-mic-off">
      <Mic /> {FEEDBACK_VOICE}
    </CardButton>
  );
}

export function FeedbackBlock({
  value,
  onChange,
  files,
  voice,
  onSend,
  sendTestId = "card-feedback-send",
  sending,
  disabled,
  id,
  note,
  className,
  actions,
  open: openProp,
}: {
  value: string;
  onChange: (v: string) => void;
  files: ChatAttach;
  voice: Pick<AnswerVoice, "button" | "strip" | "busy">;
  /** Send: the card's own route for his words (an answer, changes wanted, a note, a comment to its owner). */
  onSend: () => void;
  sendTestId?: string;
  sending?: boolean;
  disabled?: boolean;
  id?: string;
  /** one grey line under the box (what Send does, a card's own hint, a refusal): a card says its difference here, never in the box. */
  note?: ReactNode;
  className?: string;
  /** E948-S131: the card's own answer buttons (its choices, Park, Snooze): they lead the one row, Voice and Text close it. */
  actions?: ReactNode;
  /** the box shown open from the start (a card that asks for words now): Text is then already pressed. */
  open?: boolean;
}) {
  const empty = !value.trim() && !files.ids.length;
  // E948-S131 (the owner 2026-11-17, vn_73e840cd): "we have the normal button, and then one button which is voice and one
  // button which is text ... with text, it unfolds the text dialogue, but it's not showing by default". The box opens on
  // Text, and stays open while it holds words or a screenshot (a paste or a drop opens it too).
  const [shown, setShown] = useState(false);
  const open = shown || !!openProp || !empty;
  const ref = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  useEffect(() => {
    if (open && focusNext.current) {
      focusNext.current = false;
      ref.current?.querySelector("textarea")?.focus();
    }
  }, [open]);
  const toggle = () => {
    if (open && empty) return setShown(false);
    focusNext.current = true;
    setShown(true);
    if (open) ref.current?.querySelector("textarea")?.focus();
  };
  return (
    <div ref={ref} className={cn("mt-3 grid min-w-0 gap-2", className)} id={id} data-testid="card-feedback" data-card-feedback="" data-open={open ? "yes" : "no"} {...(open ? {} : files.dropProps)}>
      {!open && voice.strip}
      <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:[&_button]:flex-auto max-sm:[&_button]:justify-center" data-feedback-row="" data-card-buttons-row="" data-testid="card-feedback-row">
        {actions}
        <RowPair data-testid="card-feedback-reply">
        <span className="contents" data-feedback-mic="" data-feedback-voice="">
          {voice.button ?? <MicOff />}
        </span>
        <CardButton
          type="button"
          variant={open ? "secondary" : "outline"}
          className={cn("gap-1.5 text-sm [&_svg]:size-4", ROW_BUTTON)}
          aria-expanded={open}
          aria-controls={id ? `${id}-box` : undefined}
          disabled={disabled}
          onClick={toggle}
          data-testid="card-feedback-text"
          data-feedback-text=""
        >
          <MessageSquareText /> {FEEDBACK_TEXT}
        </CardButton>
        </RowPair>
      </div>
      {open && (
        <WordsBox
          label={FEEDBACK_LABEL}
          rows={2}
          boxClassName="min-h-12"
          placeholder={FEEDBACK_HINT}
          value={value}
          onChange={onChange}
          files={files}
          voice={{ strip: voice.strip }}
          testid="card-feedback-box"
          send={
            <CardButton
              className="h-9"
              disabled={disabled || sending || voice.busy || !files.ready || empty}
              pending={sending}
              pendingLabel="Sending…"
              onClick={onSend}
              data-testid={sendTestId}
              data-feedback-send=""
            >
              {FEEDBACK_SEND}
            </CardButton>
          }
        />
      )}
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

/** where a card's words go when the card has no route of its own: the card's spine and owner, else the Team desk. */
export type FeedbackTarget =
  | { kind: "card"; card: { kind: "review" | "ask"; repo: string; path: string; ref: string; title?: string; milestoneId?: string } }
  | { kind: "desk"; page: string };

/** Send his words (and screenshots) to a feedback target. */
export async function sendFeedback(t: FeedbackTarget, words: string, files: string[], via: "text" | "voice" = "text"): Promise<void> {
  if (t.kind === "card") {
    await mutate(() => api.commentClosedCard({ ...t.card, text: words, ...(files.length ? { attachments: files } : {}), via }), "inbox");
    return;
  }
  const world = knownWorld();
  const text = `Feedback on ${t.page}: ${words}`;
  const id = `feedback:${t.page}:${Date.now()}`;
  if (world && world !== homeWorld()) await api.sendWorldDeskMessage(world, text, t.page, id, files.length ? files : undefined);
  else await api.sendDeskMessage(text, t.page, id, files.length ? files : undefined);
}

/**
 * the block with its own words, files and voice: for a card whose buttons take no words (a status line, an alert,
 * an ask set, a decided FYI, an answered ask, a Mac ticket with no page). `send` is the card's route; default is
 * `target` through sendFeedback.
 */
export function CardFeedback({
  origin,
  title,
  refName,
  target,
  send,
  disabled,
  className,
  sent,
  actions,
}: {
  /** one per card (`card:<id>`): the floating voice pill sends to it. */
  origin: string;
  title: string;
  refName: string;
  target?: FeedbackTarget;
  send?: (words: string, files: string[], via: "text" | "voice") => Promise<unknown>;
  /** what Send does on this card: kept for the callers, never shown (the owner 2026-11-15: no text explaining the buttons). */
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  /**
   * E948-S130 (vn_4f13161d): the card this block is on (`slot`, as its `data-inbox-card`). Once his words or voice note
   * are sent the card collapses to its green Sent row with Add comment, like every other card. `card` is where Add
   * comment files (its row or ask), else the Team desk; `said` the row's words ("Your words went to the team").
   */
  sent?: { slot: string | string[]; card?: ClosedCardRef; said?: string };
  /** E948-S131: the card's own buttons, first in the one row before Voice and Text. */
  actions?: ReactNode;
}) {
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  const [line, setLine] = useState<string>();
  const files = useChatAttach({ enabled: !disabled, disabled: sending });
  const go = async (text: string, via: "text" | "voice") => {
    setSending(true);
    setLine(undefined);
    try {
      if (send) await send(text, files.ids, via);
      else await sendFeedback(target ?? { kind: "desk", page: cardPage(refName, title) }, text, files.ids, via);
      setWords("");
      files.clear();
      setLine("Sent ✓ The team has your words.");
      // Bring it back shows the card again here (his words already went; nothing to take back)
      if (sent) markSent(sent.slot, { said: sent.said ?? (via === "voice" ? "Voice note sent to the team" : "Your words went to the team"), title, ...(sent.card ? { card: sent.card } : target?.kind === "card" ? { card: target.card } : {}), back: async () => ({ back: true, line: "The card is back. Your words already reached the team." }) });
      return true;
    } catch (e) {
      // typed words stay in the box, so Not sent is true; a voice note's own line says where his words went
      // (his memory, and the Team desk when the card refuses them), so the card never says Not sent over it.
      setLine(via === "text" ? `Not sent: ${(e as Error).message}` : undefined);
      return false;
    } finally {
      setSending(false);
    }
  };
  const voice = useAnswerVoice({
    origin,
    to: shortTo(title),
    page: cardPage(refName, title),
    typed: words,
    big: true,
    deliver: async (reply) => {
      if (!(await go(reply, "voice"))) throw new Error("the card did not take it");
    },
    disabled: disabled || sending,
  });
  return (
    <FeedbackBlock
      value={words}
      onChange={setWords}
      files={files}
      voice={voice}
      onSend={() => void go(words.trim(), "text")}
      sending={sending}
      disabled={disabled}
      note={line}
      className={className}
      actions={actions}
    />
  );
}
