import { cardKey } from "@/lib/countCheck";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { aboutFrom } from "@/lib/about";
import { askCard as voiceAsk, SectionCallButton } from "@/voice/SectionCall";
import { ParkButton, parkAsk } from "@/components/parkButton";
import { useSlotReady } from "@/components/slot";
import { OwnerPriorityTag } from "./ownerPriority";
import { NoteMarkBand } from "./noteMark";
import { Link } from "react-router-dom";
import { useProject } from "@/lib/project";
import { AlarmClock, BookOpen, Check, ChevronDown, Copy, ExternalLink, Loader2, RotateCw, Send } from "lucide-react";
import { StampButton } from "@/components/planning";
import { LinkedText } from "@/components/outcome";
import { api, ASK_VERB, codeLabel, SNOOZE_CHOICES, isStructured, jobActive, needsAnswer, type JoinedReview, type OwnerActivity, type OwnerResponse, type MilestoneStatusView, type MonitorAlertAsk, type PendingItem, type SnoozeChoice, type SpineRef, type StatusBatch, type WaitingItem, type WakeResult } from "@/api";
import { askBookLink } from "@/lib/book";
import { invalidate, mutate, useQuery, useWaitingList } from "@/lib/data";
import { useInboxSearch } from "@/lib/inboxSearch";
import { ApiError, isTransient, onReconnecting } from "@/api/real";
import { clearSnoozeError, relayOf, snoozeItem, unsnoozeItem, useSnoozes, withSnoozes } from "@/lib/snooze";
import { formatDateTime, formatRelative, milestoneName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorBox, PHONE_TAP, RelTime, threadHref, ThreadLink } from "@/components/common";
import { CARD_LINK, CardButton } from "@/components/ui/cardButton";
import { cardPage, shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { useChatAttach, wordsWithFiles } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { CardFeedback, FeedbackBlock, RowPair, type FeedbackTarget } from "@/components/cardFeedback";
import { CARD_TITLE, CardMeta, CardShell } from "@/components/cardShell";
import { GrantWriteAction, waitingAnchor } from "@/components/unblock";
import { ACTION, PRESS } from "@/components/cardActions";
import { LimitControl, ListPane, limitList, useListLimit } from "@/components/listPane";
import { FoldSection, SkeletonCards, SortControl, sortSection, useSectionOpen, useSectionSort } from "@/components/homeSection";
import { pendingAction, statusQuestion } from "@/lib/pending";
import { isYesNo } from "@/lib/yesNo";
import { blockedItems, openCards as stillOpen, useStatusFor } from "@/lib/inbox";
import { DEFAULT_OWNER } from "@/lib/owner";
import { keepPlace } from "@/lib/keepPlace";
import { copyText, LaptopSwitch, laptopRows, MacCards, searchLaptopView } from "@/components/laptopSwitch";
import { ConnectCards, useConnects } from "@/components/connectCards";
import { showClosed } from "@/lib/afterClose";
import { answeredHere, markSent, unmarkSent, useSent, useKeepSent, type SentEntry } from "@/lib/sentRows";
import { SentOr, SentRow } from "@/components/sentRow";
import { DEFAULT_SKIN, useWords } from "@/lib/skin";
import { AskSet, askSets } from "@/components/askSet";
import { ownYesNo } from "@/lib/oneDecision";
import { AskVerdictTap } from "@/components/askLog";
import { askLead, askLeadUrl, cardBody, cardHeading, KIND_WORD, projectLabel, splitSteps } from "@/lib/askLead";
import { faceLabel, faceLinks, IMAGE_URL, isChoice } from "@/lib/faceLink";
import { deployerName, keyVaultName, sites } from "@/lib/identity";
import { FoldChevron } from "@/components/foldChevron";

/** the Mac list (tailnet, scripts/laptop_ticket.py --list): every needs-Mac-agent ticket with its one command. */
/** the Mac list (a page on the worker server), from the sites the page carries */
const macListUrl = () => sites().macListUrl;

/** Personas attached to a milestone for the "Send to…" dropdown: Delivery Manager first. */
export function useMilestoneRecipients(milestoneId?: string) {
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const isDm = (name?: string) => !!name && /delivery[\s-]*manager/i.test(name);
  return assignments
    .filter((a) => a.milestoneId === milestoneId)
    .map((a) => ({ assignmentId: a.id, name: personas.find((p) => p.id === a.personaId)?.name ?? a.personaId, enabled: a.enabled }))
    .sort((a, b) => Number(isDm(b.name)) - Number(isDm(a.name)) || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}


/** "Send to <persona>": text goes to that assignment's home thread with a "from the owner" header. */
export function SendToDialog({
  milestoneId,
  item,
  open,
  onOpenChange,
  initialText = "",
}: {
  milestoneId: string;
  item?: WaitingItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialText?: string;
}) {
  const recipients = useMilestoneRecipients(milestoneId);
  const skinWords = useWords();
  const [to, setTo] = useState<string>();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string; threadId?: string; environmentId?: string }>();
  const target = to ?? recipients[0]?.assignmentId;
  // the one box (paste, paperclip, drop): his files go as a line of links after his words.
  const files = useChatAttach({ enabled: true, disabled: busy });

  const send = async () => {
    if (!target || (!text.trim() && !files.ids.length) || !files.ready) return;
    setBusy(true);
    setResult(undefined);
    try {
      const words = await wordsWithFiles(text, files.ids);
      const m = await mutate(() => api.sendMessage({ milestoneId, assignmentId: target, text: words, ...(item ? { refItemId: item.id } : {}) }));
      if (m.delivery === "sent") {
        setResult({ ok: true, msg: "Sent to the home thread.", threadId: m.threadId, environmentId: m.environmentId });
        setText("");
        files.clear();
      } else setResult({ ok: false, msg: `Not delivered: ${m.deliveryError ?? m.delivery}` });
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to…</DialogTitle>
          <DialogDescription>
            Goes to the persona's home thread as a message from you{item ? `, linked to “${ASK_VERB[item.ask]}: ${item.question}”` : ""}.
          </DialogDescription>
        </DialogHeader>
        {recipients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No persona is attached to this {skinWords.milestone}. Attach one on the Personas tab first.</p>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">To</span>
              <select
                aria-label="Recipient"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={target}
                onChange={(e) => setTo(e.target.value)}
              >
                {recipients.map((r) => (
                  <option key={r.assignmentId} value={r.assignmentId}>
                    {r.name}
                    {r.enabled ? "" : " (not waking)"}
                  </option>
                ))}
              </select>
            </label>
            <WordsBox label="Message" rows={4} boxClassName="min-h-28" placeholder="What should they do?" value={text} onChange={setText} files={files} testid="send-to-box" />
            {result && (
              <p className={cn("text-sm", result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
                {result.msg}{" "}
                {result.threadId && (
                  <ThreadLink className="underline" threadId={result.threadId} environmentId={result.environmentId}>
                    open thread
                  </ThreadLink>
                )}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={busy || !target || !files.ready || (!text.trim() && !files.ids.length)} pending={busy} pendingLabel="Sending…" onClick={send}>
            <Send /> Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** the ask carries any of the v6 plain-words fields (context prose, impact, risk, why you). */
export const isHumanFormat = (i: WaitingItem) => !!(i.contextText || i.impact || i.risk || i.whyYou);

/** link from an ask's Context to the milestone's Epic Book, at the section that lists what it waits on. */
export function BookLink({ milestoneId }: { milestoneId: string }) {
  const l = askBookLink(milestoneId);
  return (
    <Link className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline" to={l.href} data-testid="ask-book-link">
      <BookOpen className="h-3.5 w-3.5" /> {l.label}
    </Link>
  );
}

/** what the owner needs to answer in seconds, in plain words, each under its label. */
function HumanSections({ item, linkOnly }: { item: WaitingItem; linkOnly?: boolean }) {
  const rows: [string, string | undefined][] = [
    ["Context", item.contextText],
    ["Impact", item.impact],
    ["Risk", item.risk],
    ["Recommendation", item.recommendation],
    ["Why you", item.whyYou],
  ].filter(([label]) => !linkOnly || label === "Context") as [string, string | undefined][];
  const book = !!item.milestoneId;
  return (
    <dl className="grid grid-cols-1 gap-1.5 text-sm" data-testid={linkOnly ? "ask-context-link" : "ask-human"}>
      {rows
        .filter(([label, v]) => v || (label === "Context" && book))
        .map(([label, v]) => (
          <div key={label} data-testid={`ask-${label.toLowerCase().replace(/\s+/g, "-")}`}>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
            {v && !linkOnly && (
              <dd className={cn("leading-snug", label === "Recommendation" && "font-medium")}>
                <LinkedText text={v} />
              </dd>
            )}
            {label === "Context" && book && (
              <dd>
                <BookLink milestoneId={item.milestoneId} />
              </dd>
            )}
          </div>
        ))}
    </dl>
  );
}

/**
 * (his vn_e166481b on TAX-A20: "can this type of task, which can be done via Claude with the extension, come with a
 * prompt that I can paste?"): a step in his own signed-in browser shows its one prompt for Claude in Chrome with Copy.
 */
export function BrowserPrompt({ prompt }: { prompt: string }) {
  const [said, setSaid] = useState<"copied" | "failed" | undefined>();
  return (
    <div className="mt-2.5 rounded-md border px-3 py-2" data-testid="ask-browser">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">In your browser: paste this into Claude in Chrome</div>
      <p className="mt-1 text-sm leading-relaxed text-foreground/85 break-words" data-testid="ask-browser-prompt">
        {prompt}
      </p>
      <Button
        size="sm"
        variant="outline"
        className={cn("mt-2 w-fit", PHONE_TAP)}
        data-testid="ask-browser-copy"
        onClick={async () => setSaid((await copyText(prompt)) ? "copied" : "failed")}
      >
        {said === "copied" ? <Check /> : <Copy />} {said === "copied" ? "Copied" : said === "failed" ? "Press and hold to copy" : "Copy the prompt"}
      </Button>
    </div>
  );
}

/** E948-S60: an option that asks for his own words ("your own number", "something else"): picked, it opens its own box. */
export const isOwnOption = (o: string) => /^(?:\(?[a-z1-9]\)\s*)?(?:your own|own|other|something else|another)\b/i.test(o.trim());

/**
 * E948-S69 (the owner 2026-11-13, vn_9e6f5fa4: "the buttons need to be the decisions ... what I'm clicking is what's the
 * next step"): every decision button names what happens next. An option that is a bare word (Yes, No, OK) gets its next
 * step; one that already says it ("No, use the logo") stays as written. The answer sent is still the option itself.
 */
export const YES_LABEL = "Yes: go ahead";
/** an option's own words may be long: its button wraps inside the card (never clipped), the label left-aligned. */
export const OPTION_BUTTON = "h-auto min-h-8 max-w-full shrink whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]";
export const NO_LABEL = "No: drop it";
export function optionLabel(o: string): string {
  const t = o.trim().replace(/[.!]$/, "");
  if (/^(?:yes|yep|ok|okay|sure|go|approve)$/i.test(t)) return YES_LABEL;
  if (/^(?:no|nope|decline|not now)$/i.test(t)) return NO_LABEL;
  return o;
}

/** Recommended option first, then the rest in the order written. */
const orderedOptions = (item: WaitingItem) =>
  item.options ? [...item.options].sort((a, b) => Number(b === item.recommendation) - Number(a === item.recommendation)) : [];

/** Owner + age + where it is written: the de-emphasised details line shared by every card. */
function Details({ item, showMilestone }: { item: WaitingItem; showMilestone?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="waiting-details">
      {showMilestone && (
        <Link className="font-medium hover:underline" to={`/milestones/${item.milestoneId}`}>
          {item.milestoneTitle}
        </Link>
      )}
      {(item.repo || item.path) && (
        <span className="font-mono">
          {item.repo}
          {item.repo && item.path ? " · " : ""}
          {item.path}
        </span>
      )}
      {item.row &&
        (item.rowLink ? (
          <a className="inline-flex items-center gap-1 hover:text-foreground hover:underline" href={item.rowLink.url} target="_blank" rel="noreferrer">
            {item.rowLink.label} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span>row {item.row}</span>
        ))}
      {item.contextLinks.map((l) =>
        l.threadId ? (
          <span key={l.url} className="inline-flex items-center gap-1">
            <ThreadLink className="inline-flex items-center gap-1 hover:text-foreground hover:underline" threadId={l.threadId} environmentId={l.environmentId}>
              {l.label} <ExternalLink className="h-3 w-3" />
            </ThreadLink>
          </span>
        ) : (
          <a key={l.url} className="inline-flex items-center gap-1 hover:text-foreground hover:underline" href={l.url} target="_blank" rel="noreferrer">
            {l.label} <ExternalLink className="h-3 w-3" />
          </a>
        ),
      )}
      <span>
        Owner: <span className={cn(item.owner.kind === "none" && "text-red-700 dark:text-red-400")}>{item.owner.label}</span>
        {item.owner.threadId && (
          <ThreadLink className="ml-1 hover:underline" threadId={item.owner.threadId} environmentId={item.owner.environmentId}>
            {item.owner.kind === "thread" ? "(thread)" : "(home thread)"}
          </ThreadLink>
        )}
      </span>
    </div>
  );
}

/**
 * the one line saying what an answer did to the persona who asked. `unwritten` = the console could not
 * write the answer into the spine (the reason is on the card already, not repeated here): a woken / steered asker writes it
 * in itself. "reads the answer at its next wake" only for spine answers (the wake prompt lists them, written or not);
 * a thread-delivered answer (persona request, reversal) is in the thread instead.
 */
export function wakeLine(w: WakeResult, persona = w.persona ?? "the asker", ctx: { unwritten?: string; thread?: boolean; unit?: string } = {}): string {
  const writes = ctx.unwritten !== undefined ? ` It writes the answer into the spine itself (the console could not).` : "";
  const later = ctx.thread
    ? `the answer is in ${persona === "the asker" ? "its" : `${persona}'s`} thread`
    : w.reason === "no persona attached to wake"
      ? `the first persona attached to this ${ctx.unit ?? DEFAULT_SKIN.words.milestone} reads the answer at its first wake`
      : `${persona} reads the answer at its next wake`;
  // Before a refused write was "not in the spine yet (<the refusal reason>)": the card shows that reason once.
  const why = (w.reason ?? w.notified).replace(/^(the answer is not in the spine yet) \(.*\)$/s, "$1");
  switch (w.notified) {
    case "woken":
      return `Woken ${persona}${w.runId ? ` (run ${w.runId})` : ""}.${writes}`;
    case "steered":
      return `Steered ${persona}'s running session${w.mode === "auto" ? " (queued after its current turn)" : ""}.${writes}`;
    case "queued":
      return `Queued for ${persona}: delivered as soon as its session starts.${writes}`;
    case "off":
      return `Not woken (Wake was unticked); ${later}.`;
    default:
      return `Not woken: ${why}; ${later}.`;
  }
}

/** how often a card with an answer still being written re-reads the inbox (the stored list: a few ms). */
export const ANSWER_POLL_MS = 2_000;

/**
 * an answer the console has stored whose job (spine write + push, then the wake) is still running: one line per
 * step, done ones ticked, the current one spinning; a try that failed says why and when it is tried again.
 */
export function AnswerProgress({ r, item }: { r: OwnerResponse; item: WaitingItem }) {
  const thread = item.source === "needs_jordi" || !!item.decidedBy;
  const unit = useWords().milestone;
  const persona = r.wake?.persona ?? item.asker?.personaName ?? "the asker";
  const written = thread ? r.delivery === "sent" : r.spine?.status === "written" || r.delivery === "delivered";
  const said = r.kind === "answer" ? `“${r.text}”` : r.kind === "approve" ? "approved" : r.kind === "feedback" ? "changes wanted" : "declined";
  const step = (done: boolean, working: boolean, text: ReactNode, id: string) => (
    <div className="flex items-center gap-1.5" data-testid={`answer-step-${id}`} data-done={done || undefined}>
      {done ? <Check className="size-3 text-emerald-600" aria-hidden /> : working ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <span className="size-3" />}
      <span>{text}</span>
    </div>
  );
  return (
    <div className="grid gap-0.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300" data-testid="answer-progress" role="status">
      {step(true, false, <>Saved <RelTime iso={r.createdAt} /> ({said})</>, "saved")}
      {step(
        written,
        !written,
        written ? (thread ? "Sent to the asker's thread" : `Written to the spine${r.spine?.sha ? ` in ${r.spine.sha}` : ""}`) : thread ? "Sending to the asker's thread…" : "Writing to the spine…",
        "written",
      )}
      {step(!!r.wake, written && !r.wake, r.wake ? wakeLine(r.wake, persona, { thread, unit }) : `Waking ${persona}…`, "woken")}
      {r.job?.error && (
        <div className="text-amber-800 dark:text-amber-300" data-testid="answer-retrying">
          Try {r.job.attempts} failed: {r.job.error}.{r.job.nextAt ? <> Trying again <RelTime iso={r.job.nextAt} />.</> : null}
        </div>
      )}
    </div>
  );
}

/**
 * result line. A skipped or failed wake of a delivered answer gets "Wake now" (re-runs only the wake, no
 * second spine write or message); the line then shows the new result.
 */
export function WakeNote({ wake, responseId, unwritten, thread }: { wake: WakeResult; responseId?: string; unwritten?: string; thread?: boolean }) {
  const [now, setNow] = useState<{ id: string; wake: WakeResult }>(); // the Wake now result until the next refresh
  const unit = useWords().milestone;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const w = now && now.id === responseId ? now.wake : wake;
  const bad = w.notified === "failed" || w.notified === "skipped";
  const wakeNow = async () => {
    if (!responseId) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await mutate(() => api.redeliverResponse(responseId));
      if (res.wake && !jobActive(res)) setNow({ id: responseId, wake: res.wake });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className={cn("text-xs", bad ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground")} data-testid="wake-note">
        {wakeLine(w, undefined, { ...(unwritten !== undefined ? { unwritten } : {}), thread, unit })}
      </div>
      {bad && responseId && (
        <Button size="sm" variant="outline" disabled={busy} pending={busy} pendingLabel="Waking…" onClick={wakeNow} data-testid="wake-now">
          <RotateCw /> Wake now
        </Button>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

/**
 * "Wake <persona>", ticked by default: the answer wakes the persona who asked (or steers its running session).
 * Unticked, the answer is only recorded. Hidden when the console knows no persona to wake.
 */
export function WakeToggle({ item, checked, onChange, disabled }: { item: WaitingItem; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const unit = useWords().milestone;
  if (!item.asker) return null;
  const name = item.asker.personaName ?? "the asker";
  const why = item.asker.via === "ask" ? "its run wrote this ask" : item.asker.via === "run" ? "its run raised this request" : `it owns this ${unit}`;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`${name}: ${why}`} data-testid="wake-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      Wake {name} <span className="opacity-70">({why})</span>
    </label>
  );
}

/**
 * FYI card: an ask a persona answered for the owner (`[answered … @<persona>]`): what was decided, why and the rollback,
 * with one-click Reverse (an answer to the owner, same path as respond). Compact, green-ish, never counted as waiting.
 */
export function FyiCard(props: { item: WaitingItem; showMilestone?: boolean; qualify?: boolean }) {
  // E948-S130: his words on a decided card collapse it to its Sent row, like every card
  return (
    <SentOr slot={`fyi:${props.item.id}`}>
      <FyiCardBody {...props} />
    </SentOr>
  );
}

function FyiCardBody({ item, showMilestone = false, qualify = false }: { item: WaitingItem; showMilestone?: boolean; qualify?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [wake, setWake] = useState(true);
  const code = codeLabel(item, qualify);
  const r = item.response;
  const reverse = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await mutate(() =>
        api.respondToWaiting(item.id, {
          kind: "answer",
          text: `Reverse this decision (${item.question}): roll it back using its rollback and tell me what you did.`,
          milestoneId: item.milestoneId,
          wake,
          ...relayOf(item),
        }),
      );
      if (res.delivery !== "sent" && !jobActive(res)) setError(`Recorded, not delivered: ${res.job?.error ?? res.deliveryError ?? res.delivery}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <CardShell kind="decided" className="text-sm" data-testid="fyi-card" id={waitingAnchor(item.id)}>
      {/* E948-S60: the one shell: the kind word first, then who decided, the code, the project, the age. */}
      <CardMeta kind="Decided" about={item.about ?? aboutFrom(item.title, item.question)} since={item.since} sinceWhat="decided" data-testid="fyi-meta">
        <span>by {decidedByName(item.decidedBy)}</span>
        {code && <span>{code}</span>}
        {showMilestone && (
          <Link className="hover:text-foreground hover:underline" to={`/milestones/${item.milestoneId}`}>
            {onceTitle(item.milestoneTitle)}
          </Link>
        )}
      </CardMeta>
      <div className={CARD_TITLE}>{item.question}</div>
      {item.answer && <p className="mt-1 text-sm leading-relaxed text-foreground/85">{item.answer}</p>}
      {item.rubric && <div className="mt-1 text-xs text-muted-foreground" data-testid="fyi-rubric">{item.rubric}</div>}
      {r && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2" data-testid="fyi-head">
          <span className="text-xs text-muted-foreground" data-testid="fyi-reversed">
            You asked to reverse this <RelTime iso={r.createdAt} />
            {r.delivery !== "sent" ? ` (not delivered: ${r.deliveryError ?? r.delivery})` : ""}
          </span>
        </div>
      )}
      {r?.wake && <WakeNote wake={r.wake} responseId={r.delivery === "sent" ? r.id : undefined} thread />}
      {error && <div className="text-xs text-red-600">{error}</div>}
      {/* E948-S60: a decision made for him still takes his words, short of reversing it. */}
      <CardFeedback
        origin={`fyi-feedback:${item.id}`}
        title={item.question || item.title}
        refName={item.code ?? item.id}
        target={askTarget(item)}
        sent={{ slot: `fyi:${item.id}` }}
        className="mt-3.5"
        actions={
          !r && (
            <span className="contents" data-testid="fyi-actions">
              <CardButton variant="outline" disabled={busy} pending={busy} pendingLabel="Reversing…" onClick={reverse}>
                <RotateCw /> Reverse
              </CardButton>
              <WakeToggle item={item} checked={wake} onChange={setWake} disabled={busy} />
            </span>
          )
        }
      />
    </CardShell>
  );
}

/** one spelling of the Delivery Manager ("Delivery-Manager", "DeliveryManager", "delivery manager"); other names as written. */
export const decidedByName = (who: string | undefined) => (who ?? "").replace(/delivery[- ]?manager/gi, "Delivery Manager");
/** a title written twice ("the code repo · the code repo") says it once. */
export const onceTitle = (title: string | undefined) => {
  const m = (title ?? "").match(/^(.+?) · \1$/);
  return m ? m[1] : title;
};

/**
 * One structured item (layout): code chip, verb + question, Unblocks / Effort, one-click answer controls
 * (options with the recommended first; Approve / Deny; `do` steps + Done; free text always), then a de-emphasised
 * details line. `qualify` shows the code as `<repo>/<code>` (the list spans repos).
 */
/**
 * a key ask's private paste box. No echo (password field), no autofill, no spellcheck; the value lives
 * only in this component until Save key and is cleared right after (success or not). The server stores it with
 * `secret put` and keeps only the fixed answer text; the ask is answered in the spine first and reopened on failure.
 */
/** the clicked button keeps its colour (no faded disabled look) and shows a spinner while it works. */
const WORKING = "disabled:opacity-100";
const Spinner = () => <Loader2 className="animate-spin" data-testid="button-spinner" />;
export function WorkingLine({ text }: { text: string }) {
  return (
    <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="working-line">
      <Loader2 className="size-3 animate-spin" aria-hidden /> {text}
    </div>
  );
}
/** how long a successful answer keeps the card "working" waiting for the refresh that updates or drops it. */
export const HOLD_MS = 15_000;
/**
 * an answer the console saved shows "Saved" (no spinner, no greyed buttons) until the list shows the answer, at
 * most this long; the list can take minutes on a busy host (2026-11-08: the card said "Saving…" while the answer was in).
 */
export const SAVED_HOLD_MS = 10 * 60_000;
export const SAVED_ANSWER = "Saved ✓ Your answer is being written to the project now.";
export function SavedLine() {
  return (
    <div role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400" data-testid="saved-line">
      {SAVED_ANSWER}
    </div>
  );
}

/**
 * E996-S29: on a key card every step that says where the key goes points to this card's own box, never to a box
 * elsewhere (T9-A10's steps said "the secret card", a private T3 card that had timed out).
 */
const ELSEWHERE_BOX = /\b(in|into)\s+(?:the|a)\s+(?:private\s+)?(?:T3\s+)?(?:request_secret|secret|key)\s+(?:card|box)\b(?:\s+the\s+Delivery\s+Manager\s+sends\s+you)?/gi;
// "…, not in the console card, which has no secret box while this ask is on the Mac list" (T9-A10, 13 Nov): the card has one.
const DENIES_BOX = /,?\s*(?:not\s+(?:in|into)\s+(?:the\s+)?(?:console\s+)?card,?\s+)?which\s+has\s+no\s+(?:secret\s+|private\s+|key\s+|paste\s+)?box\b[^.;:"—)]*/gi;
/** E996-S29: a key card's words point to its own box, never to a box elsewhere, never "this card has no box". */
export function keyWordsHere(text: string, item: Pick<WaitingItem, "secret" | "state">): string {
  if (!text || !item.secret || item.state !== "open") return text;
  return text.replace(DENIES_BOX, "").replace(ELSEWHERE_BOX, "$1 the box Paste the key here on this card");
}
export function keyStepsHere<T extends { list: string[] } | undefined>(steps: T, item: Pick<WaitingItem, "secret" | "state">): T {
  if (!steps || !item.secret || item.state !== "open") return steps;
  return { ...steps, list: steps.list.map((s) => keyWordsHere(s, item)) };
}

/**
 * E996-S29: open asks that store the same key (same app and name) are one card and one box: the first keeps its card and
 * names the others (`sameKey`), the others leave the list; Save key answers them all (the server's save does).
 */
export function foldSameKey(list: WaitingItem[]): { items: WaitingItem[]; folded: Set<string> } {
  const lead = new Map<string, WaitingItem>();
  const folded = new Set<string>();
  const out: WaitingItem[] = [];
  for (const i of list) {
    const keyOnly = i.state === "open" && i.secret ? `${i.secret.app}\u0000${i.secret.name}` : undefined;
    const first = keyOnly ? lead.get(keyOnly) : undefined;
    if (first && keyOnly) {
      folded.add(i.id);
      const merged = { ...first, sameKey: [...(first.sameKey ?? []), i.code ?? i.id] };
      lead.set(keyOnly, merged);
      out[out.indexOf(first)] = merged;
      continue;
    }
    if (keyOnly) lead.set(keyOnly, i);
    out.push(i);
  }
  return { items: out, folded };
}

/**
 * why a paste was not saved stays on the card even when the list redraws it (the note lived only in the box, so a
 * redraw dropped it and the owner saw the card come back empty).
 */
const keyNotes = new Map<string, { ok: boolean; text: string; open?: string }>();
/** "24 Nov, 06:12" in the viewer's own time, from the vault item's save time */
export const savedAtText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
/** a failed save in plain words: a restart the card could not wait out, a lost connection, or the console's own reason. */
export function keyFailText(e: unknown): string {
  if (isTransient(e)) return "Not saved: the console was restarting and did not answer for a minute. Nothing was stored. Paste the key again and press Save key.";
  if (e instanceof ApiError && (e.status === 404 || e.status === 409) && /not open any more|answered already|not found/.test(e.message))
    return "This ask is already answered: the key was saved on an earlier try. Nothing else to do.";
  return `Not saved: ${(e as Error).message}`;
}

export function SecretBox({ item, disabled, wake = true }: { item: WaitingItem & { secret: { app: string; name: string } }; disabled?: boolean; wake?: boolean }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNoteState] = useState<{ ok: boolean; text: string; open?: string } | undefined>(() => keyNotes.get(item.id));
  const setNote = (n: { ok: boolean; text: string; open?: string } | undefined) => {
    if (n && !n.ok) keyNotes.set(item.id, n);
    else keyNotes.delete(item.id);
    setNoteState(n);
  };
  const unit = useWords().milestone;
  const vault = keyVaultName();
  const save = async () => {
    const v = value;
    setValue("");
    if (!v.trim()) return;
    setBusy(true);
    setNote(undefined);
    try {
      const res = await mutate(() => api.saveKey(item.id, { value: v, milestoneId: item.milestoneId, wake, ...relayOf(item) }));
      // said only after our own read-back from the vault, and where exactly the item is
      const where = res.stored.vault
        ? `saved and checked in your ${res.stored.vault}${res.stored.where ? `: ${res.stored.where}` : ", in Team keys"}`
        : res.stored.deployed === false ? `stored in the secret store (no ${deployerName()} app for ${res.stored.app}, so not set in an env)` : `stored and set in ${deployerName()}`;
      // (the owner, 24 Nov: "I still haven't seen it"): when it was saved, and a link that opens it in his own vault
      const at = res.stored.at ? savedAtText(res.stored.at) : "";
      const saved = `Saved${at ? ` at ${at}` : ""}: ${res.stored.app} ${res.stored.name} is ${where}.${res.wake ? ` ${wakeLine(res.wake, undefined, { unit })}` : ""}`;
      setNote({ ok: true, text: saved, ...(res.stored.open ? { open: res.stored.open } : {}) });
      // (the owner, vn_e00f1134: "I pasted a key ... then the card disappeared"): the card becomes its green Sent row in place
      markSent(`ask:${item.id}`, {
        said: "Key saved",
        detail: saved,
        ...(res.stored.open ? { link: { href: res.stored.open, text: `Open it in your ${vault || "Bitwarden"}` } } : {}),
        title: item.question || item.title,
        ...(item.source === "ask" && item.repo && item.path && item.code ? { card: { kind: "ask" as const, repo: item.repo, path: item.path, ref: item.code, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } } : {}),
      });
    } catch (e) {
      setNote({ ok: false, text: keyFailText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid grid-cols-1 gap-1 rounded-md border border-dashed p-2"
      data-testid="secret-box"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {/* E996-S29 (the owner, 12 Nov: "it doesn't tell me where to paste it"): the box says plainly that this is where it goes. */}
      <label className="text-sm font-medium text-foreground" htmlFor={`secret-${item.id}`} data-testid="secret-box-label">
        Paste the key here
      </label>
      <p className="text-xs text-muted-foreground">
        {vault ? <>It goes straight into your {vault}, in Team keys, </> : <>It goes straight to the secret store </>}for <span className="font-mono">{item.secret.app}</span> as <span className="font-mono">{item.secret.name}</span>
        {item.sameKey?.length ? <> and answers {[item.code, ...item.sameKey].filter(Boolean).join(" and ")} at once</> : null}.{vault ? " The console never shows it." : " The console never shows or keeps it."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`secret-${item.id}`}
          type="password"
          aria-label="Key"
          name={`key-${item.id}`}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-sm max-sm:h-11 max-sm:text-base"
          placeholder="Paste the key here"
          value={value}
          disabled={busy || disabled}
          onChange={(e) => setValue(e.target.value)}
        />
        <CardButton type="submit" disabled={busy || disabled || !value.trim()} aria-busy={busy || undefined} className={cn(busy && WORKING)}>
          {busy ? <Spinner /> : <Check />} Save key
        </CardButton>
      </div>
      {busy && <WorkingLine text="Saving key…" />}
      {note && (
        <div className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")} data-testid="secret-note">
          {note.text}
          {note.open && (
            <>
              {" "}
              <a href={note.open} target="_blank" rel="noreferrer" className="font-medium underline" data-testid="secret-open-vault">
                Open it in your {vault || "Bitwarden"}
              </a>
            </>
          )}
        </div>
      )}
    </form>
  );
}

/**
 * "Sun 8 Nov" for a snooze-until day (a calendar date, read in UTC like the server writes it). A
 * snooze-until minute (`2026-11-02T18:30Z`, 3 hours) reads in local time with its hour: "Mon 2 Nov, 19:30".
 */
export const snoozeDay = (until: string) =>
  until.length === 10
    ? new Date(`${until}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    : new Date(until).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Snooze on an open ask: a dropdown of 3 days / 1 week / 1 month. The date is written on the ask's spine line
 * (` — snoozed until: <date>`); the ask stays open, the list and every count leave it out until then.
 */
export function SnoozeMenu({ item, className, label }: { item: WaitingItem; className?: string; label?: string }) {
  return (
    <SnoozeDropdown
      id={item.id}
      className={className}
      onPick={(c) => {
        void snoozeItem(item, c, label);
        // the same floating note; Bring it back unsnoozes it
        showClosed({
          said: "Snoozed",
          slot: `ask:${item.id}`,
          title: item.question || item.title,
          ...(item.source === "ask" && item.repo && item.path && item.code ? { card: { kind: "ask" as const, repo: item.repo, path: item.path, ref: item.code, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } } : {}),
          back: async () => (await unsnoozeItem(item), { back: true, line: "It is back in your inbox." }),
        });
      }}
    />
  );
}

/**
 * the Snooze dropdown itself (3 hours / 3 days / 1 week / 1 month), shared by ask cards and review cards. `id`
 * is the item whose write error (lib/snooze) shows under the button.
 */
export function SnoozeDropdown({ id, onPick, className, title = "Hide it for a while; it stays waiting", disabled }: { id: string; onPick: (c: SnoozeChoice) => void; className?: string; title?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  // a pick closes the menu and hides the card at once (lib/snooze); a failed write brings the card back with this.
  const error = useSnoozes().errors.get(id);
  return (
    <div className={cn("relative", className)} data-testid="snooze">
      {/* (the owner 2026-11-15 03:16Z, vn_5ef65752: "don't give me the snooze at the top and the other
          buttons at the bottom ... one section that is kind of decisions about the card"): Snooze is one of the card's
          buttons, beside Park, the same size and look, never on the meta line. */}
      <CardButton
        variant="outline"
        disabled={disabled}
        aria-label="Snooze"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          clearSnoozeError(id);
          setOpen(!open);
        }}
        title={title}
      >
        <AlarmClock />
        Snooze
        <ChevronDown className="h-3 w-3" />
      </CardButton>
      {open && (
        <div role="menu" className="absolute left-0 z-20 mt-1 grid w-36 grid-cols-1 rounded-md border bg-popover p-1 text-sm shadow-md" data-testid="snooze-menu">
          {SNOOZE_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              role="menuitem"
              className={cn("rounded px-2 py-1.5 text-left hover:bg-muted", PHONE_TAP)}
              onClick={() => {
                setOpen(false);
                onPick(c.hours ? { hours: c.hours } : { days: c.days! });
              }}
              data-testid="snooze-option"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="absolute left-0 z-20 mt-1 w-64 rounded-md border bg-popover p-2 text-xs text-red-700 shadow-md dark:text-red-400" data-testid="snooze-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** "Snoozing until Sun 8 Nov…" (spinner) while the spine line is written, then "Snoozed …" for a moment. */
function SnoozingLines({ items, qualify }: { items: WaitingItem[]; qualify: boolean }) {
  return <SnoozingLinesFor items={items.map((i) => ({ id: i.id, label: codeLabel(i, qualify) }))} />;
}

/** the same lines for any list (review cards too): `label` names the item, else the label given at the pick. */
export function SnoozingLinesFor({ items }: { items: { id: string; label?: string }[] }) {
  const { entries } = useSnoozes();
  const lines = items.flatMap((i) => {
    const e = entries.get(i.id);
    return e ? [{ id: i.id, done: !!e.done, text: `${i.label || e.label} until ${snoozeDay(e.until)}`, ...(e.note ? { note: `${i.label || e.label}: ${e.note}` } : {}) }] : [];
  });
  if (!lines.length) return null;
  return (
    <div className="mb-3 grid grid-cols-1 gap-1" data-testid="snoozing">
      {lines.map((l) =>
        l.done && l.note ? (
          <div key={l.id} role="status" className="text-xs text-muted-foreground" data-testid="snoozed-line">
            {l.note}
          </div>
        ) : l.done ? (
          <div key={l.id} role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="snoozed-line">
            <Check className="size-3 text-emerald-600" aria-hidden /> Snoozed {l.text}
          </div>
        ) : (
          <WorkingLine key={l.id} text={`Snoozing ${l.text}…`} />
        ),
      )}
    </div>
  );
}

/** an ask's code in a one-line row; on a phone without its `repo/` prefix (the row's hover text keeps it). */
function RowCode({ item, qualify }: { item: WaitingItem; qualify: boolean }) {
  const code = codeLabel(item, qualify);
  if (!code) return null;
  const prefix = code.slice(0, code.length - (item.code?.length ?? 0));
  return (
    <span className="shrink-0 font-mono text-xs font-semibold">
      {prefix && <span className="max-sm:hidden">{prefix}</span>}
      {item.code}
    </span>
  );
}

/**
 * "until Wed, Nov 4"; on a phone just "Nov 4" (same words as snoozeDay, the weekday and "until" hidden).:
 * a minute (3 hours) shows its local hour too: "until Mon, Nov 2, 19:30".
 */
export function SnoozeDate({ until, now = Date.now() }: { until: string; now?: number }) {
  if (until.length !== 10) {
    // a minute (3 hours): plain text, "until Mon, Nov 2, 7:41 PM"; on a phone the time alone when it is today
    // ("7:41 PM"), else "Nov 3, 1:10 AM", so the row stays one line with its Unsnooze.
    const at = new Date(until);
    const full = at.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const today = at.toDateString() === new Date(now).toDateString();
    const short = at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    return (
      <>
        <span className="max-sm:hidden">until {full}</span>
        <span className="sm:hidden">{short}</span>
      </>
    );
  }
  const parts = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).formatToParts(new Date(`${until}T00:00:00Z`));
  const w = parts.findIndex((x) => x.type === "weekday");
  return (
    <>
      <span className="max-sm:hidden">until </span>
      {parts.map((x, i) => (
        <span key={i} className={i === w || (i === w + 1 && x.type === "literal") ? "max-sm:hidden" : undefined}>
          {x.value}
        </span>
      ))}
    </>
  );
}

/** who builds an improvement request, for which campaign, and how he will see it done. */
function ImprovementFacts({ improvement }: { improvement: NonNullable<WaitingItem["improvement"]> }) {
  const builder = /^epic\s*team$/i.test(improvement.to) ? "the EpicTeam desk" : `the ${improvement.to} desk`;
  return (
    <div className="grid grid-cols-1 gap-0.5 rounded-md border border-violet-500/30 bg-violet-500/5 px-2.5 py-1.5 text-sm" data-testid="improvement-facts">
      {improvement.campaign && (
        <div className="break-words">
          <span className="text-muted-foreground">Campaign:</span> <LinkedText text={improvement.campaign} />
        </div>
      )}
      {improvement.doneMeans && (
        <div className="break-words">
          <span className="text-muted-foreground">Done means:</span> <LinkedText text={improvement.doneMeans} />
        </div>
      )}
      <div className="break-words text-muted-foreground">On your yes it goes to {builder}, which builds it and reports back here.</div>
    </div>
  );
}

/** one snoozed ask: code, question, until when, Unsnooze (takes the date off its spine line; the card is back). */
/**
 * E948-S187: the review card of the same work arrived after this ask: one card, the ask's, shows its result and its
 * question; his answer here answers both rows (lib/sameTopic.ts answerJoined).
 */
export function JoinedWork({ joined }: { joined: JoinedReview[] }) {
  return (
    <div className="mt-3 grid gap-3 border-t pt-3" data-testid="ask-joined">
      {joined.map((j) => (
        <div key={j.id} className="grid gap-1 text-sm" data-testid="ask-joined-card" data-row={j.ref}>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">The work for this is ready</div>
          {j.title && <p className="leading-snug text-foreground">{j.title}</p>}
          {j.evidence && (
            <p className="leading-snug">
              <a className="font-medium text-foreground underline underline-offset-2" href={j.evidence.url} target="_blank" rel="noreferrer" data-testid="ask-joined-evidence">
                {j.evidence.label}
              </a>
              {j.evidence.look && <span className="block text-[13px] text-muted-foreground">{j.evidence.look}</span>}
            </p>
          )}
          {j.delivered && j.delivered.length > 0 && (
            <ul className="grid gap-0.5 text-[13px] text-foreground/85" data-testid="ask-joined-delivered">
              {j.delivered.map((d, i) => (
                <li key={i}>
                  <LinkedText text={/^[✓✗]/.test(d.text) ? d.text : `${d.ok ? "✓" : "✗"} ${d.text}`} />
                </li>
              ))}
            </ul>
          )}
          {j.decision && (
            <p className="text-[13px] text-foreground/85" data-testid="ask-joined-decision">
              <LinkedText text={j.decision} />
            </p>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground" data-testid="ask-joined-both">
        One answer here settles both: the question above and this result.
      </p>
    </div>
  );
}

function SnoozedRow({ item, qualify, showMilestone }: { item: WaitingItem; qualify: boolean; showMilestone: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const code = codeLabel(item, qualify);
  // a snooze still being written shows its spinner here too (no Unsnooze until it is in the spine).
  const snoozing = useSnoozes().entries.get(item.id);
  // after a written unsnooze the row keeps its spinner until the refresh moves the card back (or HOLD_MS).
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [busy]);
  const unsnooze = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await unsnoozeItem(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  // one line (question cut, full on hover or a click on it; the milestone only on wider screens), error under it.
  const question = item.question || item.title;
  const [full, setFull] = useState(false);
  return (
    <li className="min-w-0 text-sm" data-testid="snoozed-row" data-pending-id={item.id}>
      <div className="flex min-w-0 items-center gap-x-2 whitespace-nowrap" title={`${code ? `${code} ` : ""}${question}${showMilestone && item.milestoneTitle ? `\n${item.milestoneTitle}` : ""}`}>
        <RowCode item={item} qualify={qualify} />
        <button type="button" className={cn("min-w-[4rem] flex-1 text-left", full ? "whitespace-normal break-words" : "truncate")} aria-expanded={full} onClick={() => setFull(!full)} data-testid="snoozed-question">
          <FoldChevron open={full} className="mr-1.5" />
          {question}
        </button>
        {showMilestone && <span className="hidden min-w-0 max-w-[30%] truncate text-xs text-muted-foreground sm:inline">{item.milestoneTitle}</span>}
        <Badge variant="outline" className="shrink-0">
          <SnoozeDate until={item.snoozedUntil!} />
        </Badge>
        {snoozing && !snoozing.done ? (
          <WorkingLine text="Snoozing…" />
        ) : (
          <CardButton variant="outline" className={cn("h-7 shrink-0 text-xs", busy && WORKING)} disabled={busy} aria-busy={busy || undefined} onClick={unsnooze} data-testid="unsnooze">
            {busy && <Spinner />}
            {busy ? "Unsnoozing…" : "Unsnooze"}
          </CardButton>
        )}
      </div>
      {error && <div className="text-xs text-red-700 dark:text-red-400">{error}</div>}
    </li>
  );
}

/**
 * vn_e00f1134: an ask he answered (a key saved, Yes/No, an option, Done, Park, Snooze, a note sent) shows as one green
 * Sent row with Add comment, in the same place, never vanishing; Bring it back on the row shows the card again.
 */
export function WaitingCard(props: { item: WaitingItem; showMilestone?: boolean; readOnly?: string; qualify?: boolean }) {
  const slot = `ask:${props.item.id}`;
  const sent = useSent(slot);
  // the refresh says his answer did not get through (still open, its delivery or spine write failed): the card is back
  const r = props.item.response;
  const failed = props.item.state === "open" && !!r && (r.delivery === "failed" || r.spine?.status === "failed" || r.spine?.status === "skipped");
  useEffect(() => {
    if (sent && failed) unmarkSent(slot);
  }, [sent, failed, slot]);
  return sent && !failed ? <SentRow slot={slot} entry={sent} /> : <WaitingCardBody {...props} />;
}

function WaitingCardBody({
  item,
  showMilestone = false,
  readOnly,
  qualify = false,
}: {
  item: WaitingItem;
  showMilestone?: boolean;
  /** ad hoc view: why it cannot be answered here. */
  readOnly?: string;
  qualify?: boolean;
}) {
  const [answer, setAnswer] = useState("");
  /**
   * the action in flight (which button shows the spinner) and the status line. `held`: the POST succeeded and
   * the card waits for the refresh that updates or drops it (the old "gray limbo"); cleared when the item changes or after HOLD_MS.
   */
  const [pending, setPending] = useState<{ action: string; status: string; held?: boolean; seen: string }>();
  const busy = !!pending;
  const [error, setError] = useState<string>();
  /** "Change answer" reopens the answer controls on an answered item; Cancel restores the read view. */
  const [editing, setEditing] = useState(false);
  /** Changes wanted and Decline each open their own box (his words, a reason that is optional). */
  // a `do` step also opens an Answer box (his words, a screenshot), the box its ask asks him to paste into.
  const [box, setBox] = useState<"changes" | "decline" | "answer">();
  /** More (opened by the heading), the note box shown by the second button, the picked option. */
  const [open, setOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [pick, setPick] = useState<string>();
  const [ownWords, setOwnWords] = useState("");
  /** wake (or steer) the persona who asked with the answer; on by default. */
  const [wake] = useState(true);
  const sendAsRef = useRef<[string, "answer" | "feedback"]>(["answer", "answer"]);
  /** E948-S174: why the last press did not reach its owner, for a voice note's row */
  const why = useRef<string | undefined>(undefined);
  const sendAs = () => sendAsRef.current;
  const r = item.response;
  /**
   * the card's box takes files like Chat's
   * (paperclip, paste, drop); they go with whichever press sends his words, as links after them (the console adds them).
   */
  const files = useChatAttach({ enabled: !readOnly, disabled: !!pending });
  const withFiles = files.ids.length ? { attachments: files.ids } : {};
  /**
   * a voice note answers the open box (the question's answer, Changes wanted, Decline's reason): Send sends it
   * at once through that box's own button, with what is typed before the spoken words; the reply names the note. Sent from the
   * floating pill on another page, it still lands here.
   */
  // E948-S60: with no box opened, a spoken note on an approve card is feedback (changes wanted), as its Send is.
  const voiceAs = (): [string, "answer" | "feedback" | "deny"] =>
    box === "changes" ? ["feedback", "feedback"] : box === "decline" ? ["deny", "deny"] : !box && sendAs()[1] === "feedback" ? ["feedback", "feedback"] : ["answer", "answer"];
  const voice = useAnswerVoice({
    big: true,
    origin: `card:${item.id}`,
    to: shortTo(item.question || item.title),
    page: cardPage(item.code ?? item.id, item.question || item.title),
    typed: answer,
    // a note this card refuses lands on its ask as his note on that card
    ...(item.source === "ask" && item.repo && item.path && item.code ? { card: { kind: "ask" as const, repo: item.repo, path: item.path, ref: item.code, title: item.question || item.title, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } } : {}),
    deliver: async (reply) => {
      setAnswer("");
      const [as, kind] = voiceAs();
      // E948-S174: the row says the card's own reason (refused, or recorded and not delivered), never Sent over it
      why.current = undefined;
      const ok = await answerOrFeedback(as, kind, reply);
      if (!ok || why.current) throw new Error(why.current ?? "the card did not take it");
    },
    disabled: !!pending,
  });
  const seen = `${item.state}|${r?.id}|${r?.kind}|${r?.text}|${r?.delivery}|${r?.spine?.status}|${r?.job?.state}`;
  /** the answer is stored and its spine write / wake still runs: the card shows the steps and polls until done. */
  const active = jobActive(r);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => invalidate("inbox", "background"), ANSWER_POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  const held = !!pending?.held;
  // The item changed since the click (answered, dropped, reopened): the wait is over, whichever landed first.
  useEffect(() => {
    if (held && pending?.seen !== seen) setPending(undefined);
  }, [held, seen, pending?.seen]);
  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setPending((p) => (p?.held ? undefined : p)), SAVED_HOLD_MS);
    return () => clearTimeout(t);
  }, [held]);
  /** Ends a run: an error (or nothing to wait for) stops the spinner now; a success holds it until the item changes. */
  const settle = (hold: boolean) => setPending((p) => (p && hold ? { ...p, held: true } : undefined));
  /** Props for a button that can be the one working: its colour stays and its icon becomes a spinner. */
  const working = (action: string) => pending?.action === action && !pending.held;
  // the pressed button itself spins and says "Sending…" (was: only its icon turned), the others wait.
  const workProps = (action: string) => ({ pending: working(action), pendingLabel: PRESS.sending });
  const icon = (action: string, el: ReactNode) => (working(action) ? <Spinner /> : el);
  /** a PR policy kept the console out, the asker has the answer and writes the line through its own PR. */
  const pendingPr = r?.delivery === "delivered";
  /** the answer is saved here but the spine write was refused or failed (reason on the card, Retry). */
  const refused = !!r?.spine && r.spine.status !== "written" && !pendingPr;
  /** a key paste that was not stored: the ask is open again, the key box below takes the new paste (no retry). */
  const keyNotStored = !!item.secret && item.state === "open" && r?.delivery === "failed";
  const sha = r?.spine?.status === "written" ? r.spine.sha : undefined;
  const code = codeLabel(item, qualify);
  // E948-S60 (the owner on E946-A29: "Send my pick where there is only one choice, which is ridiculous"): a pick needs two choices or more.
  const listed = item.ask === "decide" || item.source === "needs_jordi" ? orderedOptions(item) : [];
  const options = listed.length > 1 ? listed : [];
  // A recommendation that is not one of the option buttons is shown as text above the controls.
  // one set of answer controls. Options (when the item has any) replace Approve / Deny, never sit beside them.
  // answered from the console and delivered (the spine line, or the thread), not yet acted on by the owner.
  const answeredHere = !!r && !item.decidedBy && (item.state === "answered" || (item.state === "open" && (r.spine ? r.spine.status === "written" : r.delivery === "sent")));
  // feedback reopened the work: its next round comes back as a new card, never a change here.
  const canChange = answeredHere && !readOnly && !/^Granted write, scope:/.test(r!.text) && r!.kind !== "feedback" && !item.feedback;
  // his answer here is feedback (a Changes wanted, or an approval he changed to one): the card says so at once,
  // before the stored view has read the new [feedback] line.
  const feedbackHere = !!item.feedback || r?.kind === "feedback";
  const feedbackWords = item.feedback ? item.answer : r?.kind === "feedback" ? r.text : item.answer;
  // an answer being written (its job runs) takes no second answer or snooze: the card shows its progress instead.
  // a saved answer shows "Saved" in place of the controls until the list has it (no second answer meanwhile)
  const showControls = !readOnly && !held && (editing ? canChange : item.state === "open" && !answeredHere && !active);
  // only an ask written in a spine can be snoozed (the date goes on its line).
  const canSnooze = !readOnly && !held && !editing && item.source === "ask" && item.state === "open" && !answeredHere && !active && !item.snoozedUntil && !!item.path;
  const canDecide = (item.state === "open" || editing) && options.length === 0 && (item.decidable || item.ask === "approve");
  // one set of buttons per kind. An approve card (Approve,
  // or Done on a `do` step) has Changes wanted (his words reopen the work, it comes back as a new round) and Decline (it
  // closes as a no, a reason optional); a question (a provide or decide ask, an old free-text item) has its options and
  // one Answer, nothing else.
  const approveCard = canDecide || item.ask === "do";
  const canDeny = !item.decidedBy && approveCard;
  /** E948-S60: what the feedback block's Send does with his words: changes wanted on an approve card, else his answer. */
  sendAsRef.current = approveCard && item.ask !== "do" ? ["feedback", "feedback"] : ["answer", "answer"];
  const recommendText = item.recommendation && !options.includes(item.recommendation) ? item.recommendation : undefined;
  // an ask in the human format (v6) reads as labelled plain sections; older asks render as before.
  const human = isHumanFormat(item);
  const lead = askLead(item);
  const technical = (
    <>
      {(item.unblocks || item.effort) && (
        <div className="grid grid-cols-1 gap-0.5 text-sm">
          {item.unblocks && (
            <div>
              <span className="text-muted-foreground">Unblocks:</span> <LinkedText text={item.unblocks} />
            </div>
          )}
          {item.effort && (
            <div>
              <span className="text-muted-foreground">Effort:</span> <LinkedText text={item.effort} />
            </div>
          )}
        </div>
      )}
      {item.proposedAction && (
        <div className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground break-words">
          <LinkedText text={item.proposedAction} />
        </div>
      )}
    </>
  );

  /** the current answer, to mark the matching control while changing it. */
  const current = (kind: "approve" | "deny" | "answer" | "feedback", text?: string) => editing && !!r && r.kind === kind && (text === undefined || r.text === text);
  const startChange = () => {
    setAnswer(r && (r.kind !== "answer" || !options.includes(r.text)) && r.text !== "done" ? r.text : "");
    setError(undefined);
    setEditing(true);
  };
  const change = async (action: string, kind: "approve" | "deny" | "answer" | "feedback", text: string) => {
    setPending({ action, status: "Updating task…", seen });
    setError(undefined);
    let hold = false;
    try {
      const res = await mutate(() => api.changeResponse(r!.id, { kind, text, wake, ...withFiles }));
      setAnswer("");
      files.clear();
      setEditing(false);
      setBox(undefined);
      // a change to Changes wanted is stored and written by its job, like a press on an open card.
      hold = res.delivery === "sent" || !!res.spine || !!res.job;
      if (!hold) setError(`Changed, not delivered: ${res.deliveryError ?? res.delivery}`);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      settle(hold);
    }
  };
  /**
   * `action` names the clicked button (approve, deny, done, option:<text>, answer) for its spinner. True when the console took
   * the press (a voice note's Send needs to know).
   */
  const respond = async (action: string, kind: "approve" | "deny" | "answer" | "feedback", text = answer): Promise<boolean> => {
    if (editing) return change(action, kind, text);
    // when this card leaves, the next card's top lands where this one's was (a voice note's Send counts too)
    keepPlace(`ask:${item.id}`);
    setPending({ action, status: PRESS.sending, seen });
    setError(undefined);
    // a dropped request (console restarting) is sent again with the same key for ~60 s: say so instead of failing.
    const off = onReconnecting((on) => setPending((p) => (p && !p.held ? { ...p, status: on ? "Reconnecting…" : PRESS.sending } : p)));
    let hold = false;
    try {
      const res = await mutate(() => api.respondToWaiting(item.id, { kind, text, milestoneId: item.milestoneId, wake, ...withFiles, ...relayOf(item) }));
      // the floating note: Add a last thought (to this ask's spine and its owner), Bring it back (the answer taken
      // back while it waits out its window; once it is in the project, his words go to the owner instead)
      // vn_e00f1134: a press that reached its owner (or is being written) collapses the card to its green Sent row in
      // place; one recorded but not delivered, or refused by the spine, keeps the card with the reason on it
      const reached = (res.delivery === "sent" || !!res.spine || !!res.job) && res.spine?.status !== "skipped" && res.spine?.status !== "failed";
      showClosed({
        ...(reached ? { slot: `ask:${item.id}` } : {}),
        said: res.alreadyAnswered
          ? alreadyAnsweredLine(res)
          : action === "duplicate" ? ACTION.duplicate.said : kind === "approve" ? "Approved" : kind === "deny" ? "Declined" : kind === "feedback" ? "Changes sent to the team" : "Answered",
        title: item.question || item.title,
        ...(item.source === "ask" && item.repo && item.path && item.code ? { card: { kind: "ask" as const, repo: item.repo, path: item.path, ref: item.code, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } } : {}),
        back: async () => {
          try {
            await mutate(() => api.undoAnswer(res.id), "inbox");
            setPending(undefined);
            return { back: true, line: "It is open again. Nothing was written." };
          } catch (e) {
            if ((e as { status?: number }).status !== 409) throw e;
            return { back: false, line: "It is in the project already. Tell the owner below: your words can change it." };
          }
        },
      });
      // One-click answers (option, Done) leave a half-typed free-text answer alone.
      // the note went with the press (alone, or after the button's word): the box empties; a one-click answer leaves it
      if (text === answer || (answer.trim() && text.endsWith(answer.trim()))) setAnswer("");
      files.clear();
      setBox(undefined);
      // Spine items explain themselves in the banner (why the write was refused); persona requests report the thread delivery.
      // a stored answer whose job runs (or failed) is on the card from the next refresh, with its steps.
      hold = res.delivery === "sent" || !!res.spine || !!res.job;
      if (!hold) setError(`Recorded, not delivered: ${res.deliveryError ?? res.delivery}`);
      if (!reached) why.current = `recorded, not delivered: ${res.deliveryError ?? res.spine?.status ?? res.delivery}`;
      return true;
    } catch (e) {
      setError((e as Error).message);
      why.current = (e as Error).message;
      return false;
    } finally {
      off();
      settle(hold);
    }
  };
  /**
   * E948-S127 (vn_02c8f518): his words on an approve card that plainly say yes or no ("Yes, go ahead.", "No.") are his
   * answer, pressed as the Yes or No button; anything else (a yes with a change, a question) stays his feedback, as before.
   */
  const answerOrFeedback = async (action: string, kind: "approve" | "deny" | "answer" | "feedback", text = answer): Promise<boolean> => {
    if (kind === "feedback" && !editing && !box && canDecide && item.source === "ask" && text.trim()) {
      const read = await api
        .readSpokenAnswers(text, [{ id: item.id, line: item.question || item.title, ...(item.code ? { code: item.code } : {}) }])
        .then((x) => x.reads[0]?.kind)
        .catch(() => undefined);
      if (read === "approve") return respond("approve", "approve", text);
      if (read === "deny" && canDeny) return respond("decline", "deny", text);
    }
    return respond(action, kind, text);
  };
  const supersede = async () => {
    const by = window.prompt("Superseded by which coded ask (e.g. poly-maker/E904-A1)? Leave empty for moot.", "");
    if (by === null) return;
    setPending({ action: "supersede", status: "Updating task…", seen });
    setError(undefined);
    let hold = false;
    try {
      await mutate(() => api.supersedeNeedsOwner(item.needsJordiId!, by.trim() || undefined));
      hold = true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      settle(hold);
    }
  };
  const retry = async () => {
    if (!r) return;
    setPending({ action: "retry", status: r.spine ? "Retrying the spine write…" : "Retrying delivery…", seen });
    let hold = false;
    try {
      const res = await mutate(() => api.redeliverResponse(r.id));
      hold = res.delivery === "sent" || !!res.spine || jobActive(res);
      setError(hold ? undefined : `Not delivered: ${res.job?.error ?? res.deliveryError ?? res.delivery}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      settle(hold);
    }
  };

  // a meta
  // line (the kind as a word, the project, the age, Snooze), a short normal-weight heading, the ask in plain text, the Why
  // on its own grey line, a Do card's numbered steps, two buttons (the note goes with the one he presses), one grey foot.
  const heading = cardHeading(item);
  const body = keyWordsHere(cardBody(item, heading) ?? "", item) || undefined;
  const kindWord = KIND_WORD[lead.kind];
  const steps = keyStepsHere(splitSteps(item.steps), item);
  const project = projectLabel(item.milestoneTitle);
  const asker = item.asker?.personaName ?? (item.owner.kind !== "none" ? item.owner.label : undefined);
  const go = goLink(item);
  const doCard = item.ask === "do" && !canDecide;
  const pickOf = pick ?? (options.includes(item.recommendation ?? "") ? item.recommendation! : options[0]);
  // a yes or no question (no options, ends with "?"): Yes or No, the note with it
  // E948-S69 (the owner on E946-A31: "decide cards with no decide options … only ask feedback"): a decide ask is never words only.
  // E948-S200: the card's own question counts too, not only its heading (a long question's heading is cut before its "?",
  // and the card fell back to a lone Answer).
  const yesNo = !approveCard && !options.length && item.ask !== "provide" && (/\?\s*$/.test(heading) || isYesNo(item.question) || (item.ask === "decide" && /\?/.test(item.question)));
  // a question that needs words (give, a free question): the note box is the answer, always shown
  const wordsAnswer = !approveCard && !options.length && !yesNo;
  // the "your own number" kind of option takes his words in its own box when picked
  const ownPicked = !!pick && isOwnOption(pick);
  const withNote = (word: string) => (answer.trim() ? `${word}. ${answer.trim()}` : word);
  const openNote = (forBox: "changes" | "decline" | "answer") => {
    setBox(forBox);
    setNoteOpen(true);
    setTimeout(() => document.getElementById(`note-${item.id}`)?.querySelector("textarea")?.focus(), 0);
  };
  const main = (action: string, label: string, onClick: () => void, testId?: string, cur?: boolean, off?: boolean, extra?: string) => (
    <CardButton className={cn(extra, working(action) && WORKING)} disabled={busy || voice.busy || !files.ready || !!off} onClick={onClick} data-testid={testId} {...workProps(action)}>
      {label}
      {cur ? " (current)" : ""}
    </CardButton>
  );
  const second = (action: string, label: string, onClick: () => void, testId?: string, cur?: boolean, extra?: string) => (
    <CardButton variant="outline" className={cn(extra, working(action) && WORKING)} disabled={busy || voice.busy || !files.ready} onClick={onClick} data-testid={testId} {...workProps(action)}>
      {label}
      {cur ? " (current)" : ""}
    </CardButton>
  );
  // the second button: first press opens the note (what happened, why not), the next sends it with the note
  const secondPress = (forBox: "changes" | "decline" | "answer", send: () => void) => () => (noteOpen || open ? send() : openNote(forBox));

  return (
    <Card
      className={cn("min-w-0 border-border shadow-none [overflow-wrap:anywhere]", item.state === "done" && "opacity-80")}
      data-card-shell={lead.kind}
      data-testid="waiting-card"
      data-pending-id={item.id}
      data-inbox-card={`ask:${item.id}`}
      data-kind={lead.kind}
      id={waitingAnchor(item.id)}
    >
      <CardContent className="grid grid-cols-1 p-4">
        {/* the one meta line, its age right after the kind word as on every card */}
        <CardMeta kind={kindWord} about={item.about ?? aboutFrom(item.title, item.question)} kindTestId="card-kind" since={item.since} sinceWhat="issued" data-testid="card-meta">
          {project &&
            (showMilestone && item.milestoneId ? (
              <Link className="hover:text-foreground hover:underline" to={`/milestones/${item.milestoneId}`}>
                {project}
              </Link>
            ) : (
              <span>{project}</span>
            ))}
          {/* the owner's level from the Prioritizer, a grey word ("red line" when it is one); a tap shows why. */}
          <OwnerPriorityTag p={item.ownerPriority} urgent={isUrgentAsk(item)} className="max-sm:min-w-0 max-sm:shrink max-sm:text-left" />
          {item.source === "needs_jordi" && <span>persona request</span>}
          {item.improvement && <span data-testid="improvement-tag">improvement request</span>}
        </CardMeta>
        {/* his long voice note touched this ask: stale or updated until its owner rewrites it. */}
        {item.state === "open" && item.noteMark && <NoteMarkBand mark={item.noteMark} />}
        <button
          type="button"
          className="mt-1.5 text-left text-[15px] font-medium leading-snug text-foreground hover:underline hover:decoration-foreground/30 hover:underline-offset-[3px]"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          data-testid="ask-lead"
          data-kind={lead.kind}
        >
          <FoldChevron open={open} className="mr-1.5" />
          {heading}
        </button>
        {body && (
          <p className="mt-1 text-sm leading-relaxed text-foreground/85" data-testid="ask-question">
            <LinkedText text={body} />
          </p>
        )}
        {lead.why && (
          // the owner: "all greyed out". The why is read, so it is in the question's ink, not the meta grey
          <p className="mt-1 text-sm leading-relaxed text-foreground/85" data-testid="ask-why">
            Why: <LinkedText text={lead.why} />
          </p>
        )}
        {steps && (
          <>
            <ol className="mt-2.5 list-decimal space-y-0.5 pl-5 text-sm leading-relaxed text-foreground/85" data-testid="ask-steps">
              {steps.list.map((s, i) => (
                <li key={i}>
                  <LinkedText text={s} />
                </li>
              ))}
            </ol>
            {item.secret && item.state === "open" && (
              <p className="mt-2 text-[13px] font-medium text-foreground" data-testid="ask-key-where">
                Then paste the key in the box below, Paste the key here{item.sameKey?.length ? `: one key answers ${[item.code, ...item.sameKey].filter(Boolean).join(" and ")}` : ""}.
              </p>
            )}
            {steps.done && (
              <p className="mt-2 text-[13px] text-muted-foreground" data-testid="ask-done-looks">
                Done looks like: <LinkedText text={steps.done} />
              </p>
            )}
          </>
        )}
        {item.improvement && <ImprovementFacts improvement={item.improvement} />}
        {item.joined && item.joined.length > 0 && <JoinedWork joined={item.joined} />}
        {/* E948-S69: the options are the buttons themselves (below); a "your own" option takes its words here. */}
        {showControls && options.length > 0 && ownPicked && (
          <div className="mt-2.5 grid" data-testid="ask-options">
            <input
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              placeholder="Yours: write it here, then press it again"
              aria-label={pickOf}
              value={ownWords}
              onChange={(e) => setOwnWords(e.target.value)}
              disabled={busy}
              data-testid="ask-option-own"
            />
          </div>
        )}
        {/* who asked: context, above the answered line, the link and the buttons, never between the buttons and the feedback */}
        <div className="mt-3 text-xs text-muted-foreground" data-testid="card-foot">
          {[project, asker ? `asked by the ${asker}` : undefined].filter(Boolean).join(" · ")}
          {code && (
            <span className="ml-2" data-testid="ask-code">
              {code}
            </span>
          )}
        </div>
        {open && (
          <div className="mt-3 grid grid-cols-1 gap-2 border-t pt-3 text-sm" data-testid="ask-more">
            {item.referencedBy && item.referencedBy.length > 0 && (
              <div data-testid="ask-references">
                <span className="text-muted-foreground">Also blocks:</span>{" "}
                {item.referencedBy.map((x, i) => {
                  const label = `${x.milestoneTitle}${x.row ? ` · row ${x.row}` : ""}${x.via === "unblocks" ? " (unblocks)" : ""}`;
                  return (
                    <span key={`${x.milestoneId}:${x.path}:${x.line ?? ""}:${x.row ?? ""}`}>
                      {i > 0 && ", "}
                      {x.url ? (
                        <a className="hover:underline" href={x.url} target="_blank" rel="noreferrer" {...(x.gloss ? { title: x.gloss } : {})}>
                          {label}
                        </a>
                      ) : (
                        label
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            {human ? <HumanSections item={item} /> : item.milestoneId ? <HumanSections item={item} linkOnly /> : null}
            {item.readerNote && (
              <div className="rounded-md border border-dashed px-3 py-2 text-sm" data-testid="ask-reader-note">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.heldPast2h === "not-checked" ? "Not checked yet" : "Still unclear to a fresh reader"}</div>
                <div className="leading-snug">{item.readerNote}</div>
              </div>
            )}
            {(item.unblocks || item.effort || item.proposedAction) && <div className="grid grid-cols-1 gap-2">{technical}</div>}
            {!human && recommendText && (
              <div>
                <span className="text-muted-foreground">Recommended:</span> <LinkedText text={recommendText} />
              </div>
            )}
            <Details item={item} showMilestone={showMilestone} />
            {!editing && item.source === "needs_jordi" && item.needsJordiId && (
              <CardButton variant="ghost" className={cn("h-7 w-max px-2 text-xs text-muted-foreground", working("supersede") && WORKING)} disabled={busy} title="Replaced by a coded ask, or moot: retires this item without answering it" onClick={supersede} {...workProps("supersede")}>
                Supersede
              </CardButton>
            )}
          </div>
        )}
        {/* states, read from the spine: answered, pending work (the [answered] line exists) → done (the owner deleted it). */}
        {item.state === "answered" && !editing && feedbackHere && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="answer-state" data-outcome="feedback">
            <span className="font-medium text-foreground">You asked for changes</span>
            {feedbackWords ? `: ${feedbackWords}` : ""}. This is not an approval. The work is open again, and the team brings you the next round as a new card.
          </p>
        )}
        {item.state === "answered" && !editing && !feedbackHere && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="answer-state">
            <span className="font-medium text-foreground">Answered, pending work</span>
            {item.answer ? `: ${item.answer}` : ""}
            {r?.replacedAnswer ? ` (changed from “${r.replacedAnswer}”)` : ""}.{" "}
            {r && !r.spine
              ? "Sent to the owner's thread; the owner acts on it."
              : `${sha ? `Written to the spine in ${sha}. ` : "It is in the spine. "}The owner acts on it and marks the line done.`}
          </p>
        )}
        {item.state === "done" && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="answer-state">
            <span className="font-medium text-foreground">Done</span>
            {item.answer ? ` (you answered: ${item.answer})` : ""}. The owner acted on it and marked the line done (or removed it) in the spine.
          </p>
        )}
        {/* the asks log: his one tap on a closed coded ask (clear or confusing), logged on the asks log */}
        {(item.state === "done" || item.state === "answered") && !editing && item.source === "ask" && item.code && <AskVerdictTap code={item.code} />}
        {r && active && !editing && <AnswerProgress r={r} item={item} />}
        {r && item.state === "open" && !editing && !active && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="answer-state">
            <span>
              You answered <RelTime iso={r.createdAt} /> ({r.kind === "answer" ? `“${r.text}”` : r.kind === "approve" ? "approved" : r.kind === "feedback" ? "changes wanted" : "declined"}
              {r.kind !== "answer" && r.text ? `: ${r.text}` : ""}).{" "}
              {keyNotStored
                ? `The key was not stored: ${r.deliveryError ?? r.spine?.reason ?? "unknown reason"}. Paste it again below.`
                : pendingPr
                ? `Delivered to the asker; ${(r.deliveryError ?? "spine line pending in the repo's PR").replace(/^delivered, /, "")} (the console does not push there). Still open until that line is in the spine.`
                : r.spine
                ? r.spine.status === "written"
                  ? `Written to the spine${sha ? ` in ${sha}` : ""}; still open here until the owner cleans it up.`
                  : `Saved here, not written to the spine (${r.spine.status}): ${r.spine.reason ?? "unknown reason"}.`
                : r.delivery === "sent"
                  ? "Sent to the asking run's thread."
                  : `Not delivered: ${(r.job?.state === "failed" && r.job.error) || r.deliveryError || r.delivery}.`}
            </span>
            {/* a line still pending in the repo's PR is not answered either: Retry checks the spine again. */}
            {!keyNotStored && (refused || pendingPr || (!r.spine && r.delivery !== "sent")) && (
              <CardButton variant="outline" disabled={busy} onClick={retry} {...workProps("retry")} className={cn(working("retry") && WORKING)}>
                {icon("retry", <RotateCw />)} {r.spine ? "Retry spine write" : "Retry delivery"}
              </CardButton>
            )}
          </div>
        )}
        {r?.wake && !editing && !active && item.state !== "done" && (
          <WakeNote
            wake={r.wake}
            responseId={r.delivery === "sent" ? r.id : undefined}
            unwritten={r.spine && r.spine.status !== "written" ? (r.spine.reason ?? r.spine.status) : undefined}
            thread={item.source === "needs_jordi" || !!item.decidedBy}
          />
        )}
        {/* one answer closes many: the other asks the same answer closed, and the maybes the team judges next. */}
        {r?.settles?.line && !editing && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="answer-settles">
            {r.settles.line.charAt(0).toUpperCase() + r.settles.line.slice(1)}.
            {r.settles.maybe.length ? " The team checks the maybes and closes only the ones your answer clearly settles." : ""}
          </p>
        )}
        {canChange && !editing && (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="change-answer">
            <CardButton variant="outline" disabled={busy} onClick={startChange}>
              Change answer
            </CardButton>
            {r?.ownerRunSince && (
              <span className="text-xs text-muted-foreground" data-testid="owner-ran">
                The owner may already have read the old answer (a run started <RelTime iso={r.ownerRunSince} />); the change is written as a correction.
              </span>
            )}
          </div>
        )}
        {editing && (
          <div className="mt-2 text-xs text-muted-foreground" data-testid="changing-answer">
            Changing your answer{r ? ` (now: ${r.kind === "answer" ? `“${r.text}”` : r.kind === "approve" ? "approved" : r.kind === "feedback" ? "changes wanted" : "declined"}${r.kind !== "answer" && r.text ? `: ${r.text}` : ""})` : ""}.{" "}
            {r?.spine ? "The answered line in the spine is rewritten in place." : "The owner's thread gets a correction."}
          </div>
        )}
        {item.state === "open" && readOnly && <div className="mt-2 text-xs text-muted-foreground">{readOnly}</div>}
        {showControls && (
          <>
            {item.secret && !editing && item.state === "open" && (
              <div className="mt-3">
                <SecretBox item={item as WaitingItem & { secret: { app: string; name: string } }} disabled={busy} wake={wake} />
              </div>
            )}
            {/* the link to check sits above the buttons, so he sees the thing before he answers. */}
            {go?.image && (
              <a className="mt-3 block w-fit max-w-full" href={go.href} target="_blank" rel="noreferrer" data-testid="card-go-picture">
                <img src={go.href} alt={go.label} loading="lazy" className="max-h-56 max-w-full rounded-md border object-contain" />
              </a>
            )}
            {go && (
              <a className={CARD_LINK} href={go.href} target="_blank" rel="noreferrer" data-testid="card-go">
                {go.label} ↗
              </a>
            )}
            {/* a step in his own signed-in browser: the prompt he pastes into Claude in Chrome, under the place it opens */}
            {item.browserPrompt && item.state === "open" && <BrowserPrompt prompt={item.browserPrompt} />}
          </>
        )}
        {/* The owner 2026-11-15 00:0xZ: the buttons and the feedback box with its microphone are one group, nothing between
            and no text explaining them. E948-S60: an answered, done or read-only card still takes feedback. */}
        {showControls ? (
              <div className="grid" data-testid={`answer-${box ?? "answer"}-box`}>
                <FeedbackBlock
                  id={`note-${item.id}`}
                  className="mt-3.5"
                  open={editing || noteOpen}
                  answer={wordsAnswer && !item.secret}
                  actions={
                    <div className="contents" data-testid="answer-buttons">
                    {doCard ? (
                      <>
                        {main("done", ACTION.done.label, () => void respond("done", "answer", withNote("done")), "done", current("answer", "done"))}
                        {second("stuck", "Stuck", secondPress("answer", () => void respond("stuck", "answer", withNote("Stuck"))), "stuck")}
                      </>
                    ) : approveCard ? (
                      <>
                        {/* E948-S128: the ask's own "Yes: …" and "No: …" words, so yes says exactly what happens */}
                        {main("approve", (item.ask === "approve" && ownYesNo(item).yes) || YES_LABEL, () => void respond("approve", "approve", answer.trim()), "approve", current("approve"), false, OPTION_BUTTON)}
                        {canDeny && second("deny", (item.ask === "approve" && ownYesNo(item).no) || NO_LABEL, secondPress("decline", () => void respond("deny", "deny", answer.trim())), "decline", current("deny"), OPTION_BUTTON)}
                      </>
                    ) : options.length > 0 ? (
                      <>
                        {/* E948-S69: one button per option, named by what happens next, the recommended one filled; never a lone Send my pick. */}
                        {options.map((o) => {
                          const own = isOwnOption(o);
                          // a "your own" option first opens its box, the next press sends his words with it
                          const press = () => (own && !(pick === o && ownWords.trim()) ? setPick(o) : void respond(`option:${o}`, "answer", withNote(own ? `${o}: ${ownWords.trim()}` : o)));
                          const lead = o === pickOf && !ownPicked;
                          const cur = current("answer", o);
                          return <Fragment key={o}>{lead ? main(`option:${o}`, optionLabel(o), press, "ask-option", cur, false, OPTION_BUTTON) : second(`option:${o}`, optionLabel(o), press, "ask-option", cur, OPTION_BUTTON)}</Fragment>;
                        })}
                      </>
                    ) : yesNo ? (
                      <>
                        {main("yes", YES_LABEL, () => void respond("yes", "answer", withNote("Yes")), "yes", current("answer", "Yes"))}
                        {second("no", NO_LABEL, () => void respond("no", "answer", withNote("No")), "no", current("answer", "No"))}
                      </>
                    ) : null}
                    {/* E948-S139: one tap closes any ask as a duplicate or already answered; the note box goes with it. */}
                    {!editing && item.state === "open" && !item.secret && second("duplicate", ACTION.duplicate.label, () => void respond("duplicate", "answer", withNote(ACTION.duplicate.words)), "card-duplicate")}
                    {/* E948-S83 iteration 2: Park beside the card's own buttons (a month on its spine line, nothing decided). */}
                    {canSnooze && (
                      <RowPair>
                        <ParkButton disabled={busy} onPark={() => parkAsk(item)} />
                        <SnoozeMenu item={item} />
                      </RowPair>
                    )}
                    {/* the owner 2026-11-15: Snooze beside Park, in the one decisions block, never at the top of the card. */}
                    {editing && (
                      <CardButton
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setEditing(false);
                          setBox(undefined);
                          setAnswer("");
                          files.clear();
                          setError(undefined);
                        }}
                      >
                        Cancel
                      </CardButton>
                    )}
                    {canDecide && !editing && <GrantWriteAction item={item} />}
                    </div>
                  }
                  note={item.secret ? "Never paste the key here: use the private box above." : undefined}
                  value={answer}
                  onChange={setAnswer}
                  files={files}
                  voice={voice}
                  sending={working(wordsAnswer ? "answer" : "feedback")}
                  disabled={busy}
                  sendTestId={wordsAnswer ? "answer" : "card-feedback-send"}
                  onSend={() => (wordsAnswer ? void respond("answer", "answer") : void answerOrFeedback("feedback", sendAs()[1]))}
                />
              </div>
        ) : (
          <CardFeedback origin={`card-feedback:${item.id}`} title={item.question || item.title} refName={item.code ?? item.id} target={askTarget(item)} sent={{ slot: `ask:${item.id}` }} />
        )}
        {pending && (pending.held ? <SavedLine /> : pending.status !== PRESS.sending && <WorkingLine text={pending.status} />)}
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      </CardContent>
    </Card>
  );
}

/** E948-S60: where feedback on an ask goes when it takes no answer now: its spine line and owner, else the Team desk. */
export function askTarget(item: WaitingItem): FeedbackTarget {
  if (item.source === "ask" && item.repo && item.path && item.code)
    return { kind: "card", card: { kind: "ask", repo: item.repo, path: item.path, ref: item.code, title: item.question || item.title, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } };
  return { kind: "desk", page: cardPage(item.code ?? item.id, item.question || item.title) };
}

/**
 * the card's one green link, above its buttons: the page the ask opens with, its steps page, its first link that is not a
 * spine line, else the first link anywhere in its words (context, options, recommendation: E948-S151, E940-A10's mockups
 * sat only in its collapsed context). A choice (A, B or C) labels it "See the options".
 */
export function goLink(item: WaitingItem): { href: string; label: string; image?: boolean } | undefined {
  const lead = askLeadUrl(item);
  const choice = isChoice(item);
  if (lead) return { href: lead, label: item.ask === "do" ? "Open the steps" : choice ? faceLabel(item, lead) : "Open", ...(IMAGE_URL.test(lead) ? { image: true } : {}) };
  if (item.stepsLink) return { href: item.stepsLink.url, label: "Open the steps" };
  const l = (item.contextLinks ?? []).find((x) => !x.threadId && !/github\.com\/.+\/blob\//.test(x.url));
  if (l) return { href: l.url, label: choice ? faceLabel(item, l.url) : "Open", ...(IMAGE_URL.test(l.url) ? { image: true } : {}) };
  // a link in the ask's words (its question, context prose, options, recommendation): on the face, never only in "more"
  const any = faceLinks(item)[0];
  if (!any) return undefined;
  return { href: any, label: faceLabel(item, any), ...(IMAGE_URL.test(any) ? { image: true } : {}) };
}

const linkHref = (l: WaitingItem["contextLinks"][number]) => (l.threadId ? threadHref(l.threadId, l.environmentId) : l.url);
const rowHref = (i: WaitingItem) => i.contextLinks[0] && linkHref(i.contextLinks[0]);

/** A compact row line (Coming up): title linked to its spine line, plus a muted note; one line, full text on hover (L-39). */
function RowLine({ item, note }: { item: WaitingItem; note?: string }) {
  const href = rowHref(item);
  return (
    <li className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap text-sm" data-testid="coming-row" title={[item.title, note].filter(Boolean).join("\n")}>
      {href ? (
        <a className="min-w-0 max-w-[70%] shrink-0 truncate hover:underline" href={href} target="_blank" rel="noreferrer">
          {item.title}
        </a>
      ) : (
        <span className="min-w-0 max-w-[70%] shrink-0 truncate">{item.title}</span>
      )}
      {note && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{note}</span>}
    </li>
  );
}

/** merge two priority-sorted lists (status rows first on a tie); an item without a priority sorts last. */
type PriorityRow = { status?: PendingItem; card?: WaitingItem };
export function mergeByPriority(status: PendingItem[], cards: WaitingItem[]): PriorityRow[] {
  const p = (x: { priority?: number }) => x.priority ?? Number.MAX_SAFE_INTEGER;
  const out: PriorityRow[] = [];
  let i = 0;
  let j = 0;
  while (i < status.length || j < cards.length) {
    if (j >= cards.length || (i < status.length && p(status[i]) <= p(cards[j]))) out.push({ status: status[i++] });
    else out.push({ card: cards[j++] });
  }
  return out;
}

/** Where the blocked run can be seen: its thread (run thread link), else the persona's home thread, else Activity. */
function runHref(i: WaitingItem): { href: string; label: string; internal?: boolean; threadId?: string; environmentId?: string } {
  const run = i.contextLinks.find((l) => l.threadId);
  if (run?.threadId) return { href: threadHref(run.threadId, run.environmentId), label: "run thread", threadId: run.threadId, environmentId: run.environmentId };
  if (i.owner.threadId) return { href: threadHref(i.owner.threadId, i.owner.environmentId), label: "home thread", threadId: i.owner.threadId, environmentId: i.owner.environmentId };
  return { href: `/milestones/${i.milestoneId}?tab=activity`, label: "run", internal: true };
}

/**
 * "Waiting on you": Team = every milestone; Milestone page = that milestone from `nodeKey` down.
 * Order: items blocking a persona run now (fields), then open structured asks, then answered ones ("answered, pending work" while the `[answered]
 * line is in the spine, "done" for a few days after the owner deletes it); open guessed
 * rows are not listed (no question for the owner, a defect for the owner); future gates sit in a collapsed "Coming up" list.
 */
/** the list is served from the console's stored view; its time shows only when it is older than this. */
export const AS_OF_QUIET_MS = 2 * 60_000;
export const staleAsOf = (asOf: string, now = Date.now()) => now - Date.parse(asOf) > AS_OF_QUIET_MS;

/** an open priority ask (the owner, vn_cdcf1208: "if the question reaches me 10 notifications deep ... we've defeated the purpose"). */
/**
 * a priority ask, or an item the owner asked by name to be first (pressing kind `first`, or `label: urgent` on the ask,
 * E948-S155): it leads Blocked on you, the section open.
 */
export const leadsFirst = (i: WaitingItem) => !!i.urgent || i.ownerPriority?.pressing?.kind === "first";
export const isPinnedPriority = (i: WaitingItem) => (!!i.putFirst || leadsFirst(i)) && i.state === "open" && !i.snoozedUntil && !i.macAgent;
/**
 * E948-S132 (the owner, vn_a80780bd 20 Nov: "we've been asking for like an urgent section in the inbox ... it's still not
 * there"): an open ask labelled urgent, or pressing (he asked for it first, again, or with frustration), sits in the
 * Inbox's own Urgent section at the very top, out of Blocked on you.
 */
/**
 * (the owner 22 Nov 03:35Z: "I press send and it disappears and then it comes back"): a press on a card he had
 * already answered says so, with when and what, instead of a second plain Answered that the next list could contradict.
 */
export function alreadyAnsweredLine(r: Pick<OwnerResponse, "createdAt" | "text" | "kind">): string {
  const d = new Date(r.createdAt);
  const at = Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const what = r.kind === "approve" ? "Approved" : r.kind === "deny" ? "Declined" : r.text.trim() ? `“${r.text.trim().slice(0, 40)}”` : "Answered";
  return `Already answered${at ? ` at ${at}` : ""}: ${what}, the team has it`;
}
export const isUrgentAsk = (i: WaitingItem) => i.state === "open" && !i.snoozedUntil && !i.macAgent && (!!i.urgent || !!i.ownerPriority?.pressing);

/**
 * the one-line question on his order of work, "Put X first in your objectives?", sits first in his Inbox,
 * above every section and every pressing item, until he answers it (Yes puts X first in his objectives, No closes it).
 * The same card as everywhere (L-2): no new colour, no new box.
 */
export function WaitingOnYou({
  milestoneId,
  nodeKey,
  scopeLabel,
  spine,
  title = "Waiting on you",
  fold,
  laptop = false,
  part = "all",
  only,
  connects = false,
  urgentApart = false,
}: {
  /** the Inbox's accounts to connect lead this section (before, loose cards above every section). */
  connects?: boolean;
  /** E948-S132: the Inbox draws its urgent and pressing asks in the Urgent section above, so they leave this one. */
  urgentApart?: boolean;
  /** a goal set lists its own asks only. */
  only?: (i: WaitingItem) => boolean;
  milestoneId?: string;
  nodeKey?: string;
  scopeLabel?: string;
  /** the Team home calls it "Blocked, waiting on you". */
  title?: string;
  /** the section folds (heading is the toggle, state kept under this localStorage key) and its badge shows 0 / "…". */
  fold?: string;
  /** ad hoc view of an untracked spine: its items, read-only (answering needs a milestone to deliver to). */
  spine?: SpineRef;
  /** the Team home (the home world): the "I'm on my laptop" switch on top; while on, the Mac tasks lead the inbox. */
  laptop?: boolean;
  /**
   * "blocked" is the switch and the Blocked list only, "rest" the
   * other folds (Mac agent, Snoozed, Decided for you, Coming up, Answered, Superseded), shown after the review list.
   */
  part?: "all" | "blocked" | "rest";
}) {
  // one shared fetch for the Blocked part, the rest part and the page around them (same filter, same answer).
  const { data: fetchedAll, error, loading } = useWaitingList(spine ? { ...spine, nodeKey } : { milestoneId, nodeKey, includeSuperseded: true });
  // the count is the server's open items (the Team badge's list), not this list's own filter; an untracked spine has none.
  // the same fetch the pills read (one per key), so the pill and this list never show two moments.
  const { data: statusAll, loading: statusLoading } = useStatusFor(milestoneId, !!spine);
  // the world-wide list (Team home, Blocked) shows the selected project's asks only.
  const project = useProject();
  const skinWords = useWords();
  const narrowed = !milestoneId && !spine && !!project.current;
  const fetchedKept = narrowed && fetchedAll ? fetchedAll.filter((i) => project.keep(i.milestoneId)) : fetchedAll;
  const fetched = only && fetchedKept ? fetchedKept.filter(only) : fetchedKept;
  const statusKept = narrowed && statusAll ? { ...statusAll, items: statusAll.items.filter((i) => project.keep(i.milestoneId)) } : statusAll;
  // a scorecard's count is its own list's open asks.
  const onlyIds = only && fetched ? new Set(fetched.map((i) => i.id)) : undefined;
  const status = onlyIds && statusKept ? { ...statusKept, items: statusKept.items.filter((i) => onlyIds.has(i.id) || only!(i as unknown as WaitingItem)) } : statusKept;
  // an ask being snoozed is out of the cards and the count at once (and back if the write fails).
  const { entries: snoozes } = useSnoozes();
  // the Inbox's search box keeps only the items the server's search names (titles, card text, his notes),
  // plus done items older than this list's window as their rows. Only on the world-wide Inbox (no milestone, no spine).
  const search = useInboxSearch();
  const hits = !milestoneId && !spine && search.active ? search.hits : undefined;
  const unfiltered = withSnoozes(fetched, snoozes);
  const data = useMemo(() => {
    if (!hits || !unfiltered) return unfiltered;
    const kept = unfiltered.filter((i) => hits.has(i.id));
    const have = new Set(unfiltered.map((i) => i.id));
    // the same ask written in two spines of one repo (an epic and its parent) is one line: a row whose repo and code
    // the shown matches (or an earlier row) already hold is left out, so Answered never shows it twice
    const key = (i: WaitingItem) => (i.code ? `${i.repo ?? ""}|${i.code}` : `id|${i.id}`);
    const keys = new Set(kept.map(key));
    const rows = search.rows.filter((r) => {
      if (have.has(r.id) || keys.has(key(r)) || (narrowed && !project.keep(r.milestoneId))) return false;
      keys.add(key(r));
      return true;
    });
    return [...kept, ...rows];
  }, [hits, unfiltered, search.rows, narrowed, project]);
  /** while a search is on, every section shows its matches open. */
  const searching = !!hits;
  const [sendOpen, setSendOpen] = useState(false);
  const [comingOpen, setComingOpen] = useState(false);
  const [supersededOpen, setSupersededOpen] = useState(false);
  const [answeredOpen, setAnsweredOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [macOpen, setMacOpen] = useState(false);
  const { data: laptopView, loading: laptopLoading } = useQuery(() => (laptop && api.laptop ? api.laptop() : Promise.resolve(undefined)), [laptop], { tag: "inbox" });
  // this section holds its place (Slot) until its list, its count and the laptop switch are all in.
  useSlotReady(!!error || (!!data && !laptopLoading && (!!spine || (!statusLoading && !statusAll?.loading))));
  const laptopOn = !!laptopView?.session && (!laptopView.session.until || Date.parse(laptopView.session.until) > Date.now());
  // each folded list, open, sits in the shared scroll pane with its own Show 20 / 50 / all (remembered).
  const [comingLimit, setComingLimit] = useListLimit("coming-up");
  const [answeredLimit, setAnsweredLimit] = useListLimit("answered");
  const [supersededLimit, setSupersededLimit] = useListLimit("superseded");
  // Snoozed and Decided for you too; Decided for you folds on its heading (open by default, as before).
  const [snoozedLimit, setSnoozedLimit] = useListLimit("snoozed");
  const [fyiLimit, setFyiLimit] = useListLimit("decided-for-you");
  const [fyiOpen, setFyiOpen] = useSectionOpen("decided-for-you", false);
  // (the owner: "It should just be at the top on blocked waiting for me"): an open priority ask ("Put X first in
  // your objectives?", vn_cdcf1208) and an account to connect lead this section, never loose above every section;
  // while a priority ask is here the section opens by itself (an account to connect waits folded, as before).
  // E948-S141: an answered priority ask is out of the count and the list at once, like every card
  const leadsHere = (i: WaitingItem) => isPinnedPriority(i) && !(urgentApart && isUrgentAsk(i));
  const pinnedFirst = part !== "rest" && !milestoneId && !spine ? stillOpen((data ?? []).filter(leadsHere).sort((a, b) => Number(leadsFirst(b)) - Number(leadsFirst(a))), (i) => `ask:${i.id}`) : [];
  const connectList = useConnects("inbox", connects && part !== "rest");
  const connectFirst = connects && part !== "rest" ? connectList : [];
  const [sectionOpen, setSectionOpen] = useSectionOpen(fold, true, pinnedFirst.length > 0);
  // on the Team home (fold set) the section's own sort, remembered; it orders each group (blocking now,
  // status rows, asks, decided for you) by the asks' age, the groups keep their place. Elsewhere the server's order.
  const [sort, setSort] = useSectionSort(fold);
  const bySort = <T extends { since?: string }>(list: T[]) => sortSection(list, sort, (i) => i.since);
  // superseded Needs the owner rows are history: out of the list and the count, shown collapsed at the end.
  const superseded = (data ?? []).filter((i) => i.state === "superseded");
  // snoozed asks are out of every list and count (the server's too); a "n snoozed" toggle shows them with Unsnooze.
  const snoozed = (data ?? []).filter((i) => i.state === "open" && !!i.snoozedUntil).sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!));
  // asks labelled `needs Mac agent` leave the list and the count for the Mac list (run in one sitting on his laptop).
  const mac = (data ?? []).filter((i) => i.state === "open" && i.macAgent && !i.snoozedUntil);
  const { items, folded: sameKeyFolded } = foldSameKey((data ?? []).filter((i) => i.state !== "superseded" && !(i.state === "open" && (i.snoozedUntil || i.macAgent))));
  const blocksRun = (i: WaitingItem) => !!(i.blocksRunId || i.blocksPersona);
  // an answer whose spine write was refused still needs the owner (Retry): it stays up top and counts.
  const refusedWrite = (i: WaitingItem) => i.state === "open" && !!i.response?.spine && i.response.spine.status !== "written";
  const pending = (i: WaitingItem) => needsAnswer(i) || refusedWrite(i);
  // the open section is exactly the server's open items (same ids, same count as the badge); without a status
  // (an untracked spine) the list's own rule. Status items with no card here (Ready to mark, a failed run) get a row.
  // a snoozed ask never counts or shows, from the moment the owner picks Snooze (this browser's snoozes).
  // the open items are `blockedItems`, the function the red pills count with: one row per item, a card when this
  // list has one for it, else its status row, so the count and the rows are the same list (before, an item with a list
  // entry but no card, a guessed line, was counted and shown nowhere).
  // an open priority ask ("Put X first in your objectives?") leads this section (pinnedFirst), so the rows below leave it out.
  const pinned = !milestoneId && !spine ? new Set((data ?? []).filter((i) => isPinnedPriority(i) || (urgentApart && isUrgentAsk(i))).map((i) => i.id)) : new Set<string>();
  const blocked = status ? blockedItems(status, { nodeKey, snoozing: snoozes }).filter((st) => !sameKeyFolded.has(st.id) && !pinned.has(st.id) && (!hits || hits.has(st.id))) : undefined;
  const blockedIds = blocked && new Set(blocked.map((i) => i.id));
  const isOpen = (i: WaitingItem) => (blockedIds ? blockedIds.has(i.id) : pending(i) && !pinned.has(i.id));
  // a Mark ready item (the owner's ready stamp) is the status row with the stamp button, never a guessed card.
  const stampItem = (i: WaitingItem) => i.signal === "stamp_ready";
  const cards = new Map(items.filter((i) => isStructured(i) && !stampItem(i)).map((i) => [i.id, i]));
  const openCards = blocked ? blocked.flatMap((st) => cards.get(st.id) ?? []) : items.filter((i) => isStructured(i) && pending(i));
  const statusOnly = bySort((blocked ?? []).filter((st) => !cards.has(st.id)));
  const blocking = bySort(openCards.filter(blocksRun));
  const open = bySort(openCards.filter((i) => !blocksRun(i)));
  // under "Highest priority" the status-only rows and open cards are one list by milestone priority (both
  // lists come sorted by it); within one milestone the status rows lead, as before. One milestone's page, or another
  // sort: status rows, then cards.
  const openRows =
    sort === "priority" && !milestoneId && !spine
      ? mergeByPriority(statusOnly, open)
      : [...statusOnly.map((st): PriorityRow => ({ status: st })), ...open.map((card): PriorityRow => ({ card }))];
  const fyi = bySort(items.filter((i) => isStructured(i) && i.decidedBy));
  // Answered (collapsed): everything structured that is not open, most recent answer first (the console answer's time,
  // else the ask's date); on a tie answered-pending-work before consumed / done.
  const written = outcomeWritten(status, milestoneId);
  const consumed = (i: WaitingItem) => i.state === "done" || !!i.consumedAt || (i.source === "needs_jordi" && written);
  const answeredAt = (i: WaitingItem) => i.response?.createdAt ?? i.since ?? "";
  const rest = items
    .filter((i) => isStructured(i) && !isOpen(i) && !pinned.has(i.id) && !i.decidedBy)
    .sort((a, b) => answeredAt(b).localeCompare(answeredAt(a)) || Number(consumed(a)) - Number(consumed(b)));
  // a spine line naming the owner with no coded ask is no question for him: no card here, never counted (the
  // header lists it for the Delivery Manager, the Tree shows it amber). Only future gates of such lines show, under Coming up.
  const coming = items.filter((i) => !isStructured(i) && i.gate === "future");
  // a green Sent row counts nothing: the red number is what he still has to act on, 0 when none.
  const count = (blocked ? blocked.length : [...blocking, ...open].filter((i) => !answeredHere(i.id)).length) + pinnedFirst.length;
  // the milestone a status row belongs to, by name (only where the list spans milestones)
  const { data: milestones } = useQuery(() => (!milestoneId && !spine ? api.listMilestones() : Promise.resolve([])), [milestoneId, spine?.repo]);
  const names = new Map((milestones ?? []).map((m) => [m.id, milestoneName(m)]));
  // a monitor alert whose every ask he snoozed: one quiet line with Unsnooze, never counted. One that names no ask for
  // him (state alarm, the Delivery Manager's) is never in his inbox (the owner: "I can't take action on it so what's it
  // doing there?"): the console hands it back to its team as one desk note (status/alertHandBack.ts).
  const quietAlerts = !nodeKey && status ? status.items.filter((i) => i.kind === "monitor_alert" && i.state === "snoozed" && (!hits || hits.has(i.id))) : [];
  // the number is known as soon as the fast status batch is in (before the cards); unknown while it counts.
  const knownCount = status && !status.loading ? count : data && !status ? count : undefined;
  // Codes are qualified `<repo>/<code>` when the list spans repos (human-asks v2).
  const qualify = new Set(items.map((i) => i.repo).filter(Boolean)).size > 1;
  const showMilestone = !milestoneId && !spine;
  const readOnly = spine ? `Not tracked: Track as ${skinWords.milestone} to answer here.` : undefined;
  // every Mac task is a full card (Done, Stuck, a note, voice); with the Mac list, one card per ticket (laptopRows)
  const askCard = (i: WaitingItem) => <WaitingCard item={i} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} />;
  // E996-S29: a Mac ticket card (its steps page) whose ask takes a key shows that ask's private box too.
  const keyBox = (i: WaitingItem) => (i.secret && !readOnly ? <SecretBox item={i as WaitingItem & { secret: { app: string; name: string } }} /> : null);
  // E996-S29: a key ask is a card in the list above with its box; its Mac ticket is not a second card here.
  const keyAsks = new Set(items.filter((i) => i.state === "open" && i.secret && i.code).flatMap((i) => [i.code!, ...(i.sameKey ?? [])]));
  // E948-S78: one narrowed view for both the laptop panel and the Needs Mac agent fold (before, the panel showed
  // every Mac task while a search was on).
  const shownView = laptopView && searching ? searchLaptopView(laptopView, mac, search.q) : laptopView;
  const macRows = shownView ? laptopRows(shownView.tasks.filter((t) => !(t.ask && keyAsks.has(t.ask))), mac, shownView.done) : undefined;
  // while searching, a laptop panel with no matching Mac task hides (Blocked says what matches).
  const laptopShown = laptop && (!searching || (macRows ?? []).some((r) => !r.done));
  const macCount = macRows ? macRows.filter((r) => !r.done).length : mac.length;
  // a persona's open approve asks (two or more) are one set with Accept all, shown where its first ask comes.
  const sets = askSets(open);
  const setOf = new Map(sets.flatMap((g) => g.items.map((i) => [i.id, g] as const)));
  const setLead = new Set<string>();
  for (const g of sets) {
    const first = openRows.find((r) => r.card && g.items.some((i) => i.id === r.card!.id));
    if (first?.card) setLead.add(first.card.id);
  }
  // vn_e00f1134: an ask he answered stays where it was, as its green Sent row, after the refetch drops it
  const placeKey = `blocked:${milestoneId ?? nodeKey ?? "all"}:${part ?? "all"}`;
  const keptRows = useKeepSent(openRows, (r) => (r.card ? `ask:${r.card.id}` : `status:${r.status!.id}`), `${placeKey}:rows`);
  const keptBlocking = useKeepSent(blocking, (i) => `ask:${i.id}`, `${placeKey}:blocking`);
  const blockedBy = useRef(new Map<string, string>());
  const byPersona = new Map<string, { slot: string; item?: WaitingItem; sent?: SentEntry }[]>();
  for (const r of keptBlocking) {
    const i = r.item;
    // a Sent row stays in the group it was in (remembered while it was listed)
    const who = i ? i.blocksPersona ?? i.owner.personaName ?? i.owner.label : blockedBy.current.get(r.slot);
    if (!who) continue;
    blockedBy.current.set(r.slot, who);
    byPersona.set(who, [...(byPersona.get(who) ?? []), r]);
  }
  // every list here is the same fold section (one box, chevron, title, count pill), siblings in one column:
  // Blocked first, then Snoozed, Decided for you, Coming up, Answered, Superseded; each folds on its own header.
  return (
    <>
      {part !== "rest" && (
      <>
      <FoldSection
        title={title}
        count={fold ? knownCount : count}
        hideZero={!fold}
        tone="needs-you"
        testId="waiting-on-you"
        open={sectionOpen || searching}
        onToggle={fold ? setSectionOpen : undefined}
        call={
          fold &&
          !milestoneId &&
          keptBlocking.length + keptRows.length > 0 && (
            <SectionCallButton
              section={title}
              testId="waiting-on-you"
              onOpen={() => setSectionOpen(true)}
              cards={() => [
                ...blocking.map((i) => voiceAsk({ id: i.id, code: i.code, title: i.title, question: i.question, where: i.milestoneTitle })),
                ...openRows.map((r) => (r.card ? voiceAsk({ id: r.card.id, code: r.card.code, title: r.card.title, question: r.card.question, where: r.card.milestoneTitle }) : voiceAsk({ id: r.status!.id, code: r.status!.code, title: r.status!.title }))),
              ]}
            />
          )
        }
        meta={
          <>
            {scopeLabel && <span className="text-xs text-muted-foreground">from {scopeLabel} down</span>}
            {status?.asOf && staleAsOf(status.asOf) && (
              <span className="text-xs text-muted-foreground" title={`List as of ${formatDateTime(status.asOf)}: the console refreshes it in the background`} data-testid="waiting-as-of">
                as of {formatRelative(status.asOf)}
              </span>
            )}
            {milestoneId && (
              <Button className="ml-auto" size="sm" variant="outline" onClick={() => setSendOpen(true)}>
                <Send /> Send to…
              </Button>
            )}
          </>
        }
        actions={fold && <SortControl value={sort} onChange={setSort} testId="waiting-on-you" />}
      >
        {/* the owner ("inbox is inbox, filters on top of expanders nothing between"): the laptop switch opens the
            Blocked section, inside it, never a box between the filters and the sections. */}
        {laptopShown && <LaptopSwitch view={shownView} mac={mac} listUrl={macListUrl()} askCard={askCard} keyBox={keyBox} />}
        {/* what leads, at the top: the priority asks, then the accounts to connect. */}
        {pinnedFirst.length > 0 && (
          <div className="mb-3 grid gap-3" data-testid="pinned-priority">
            {pinnedFirst.map((i) => (
              <div key={i.id} data-testid="pinned-priority-ask" data-priority={i.putFirst?.objective ?? "urgent"} data-inbox-open="">
                <WaitingCard item={i} showMilestone qualify={qualify} />
              </div>
            ))}
          </div>
        )}
        {connectFirst.length > 0 && <ConnectCards where="inbox" />}
        <SnoozingLines items={snoozed} qualify={qualify} />
        {error && <ErrorBox error={error} />}
        {loading && !data && <SkeletonCards count={knownCount} testId="waiting-on-you-loading" />}
        {data && count === 0 && searching && (
          <p className="text-sm text-muted-foreground" data-testid="nothing-matches-blocked">
            Nothing blocked matches “{search.q}”.
          </p>
        )}
        {data && count === 0 && !searching && !connectFirst.length && (
          <EmptyState
            title={`Nothing waiting on you${milestoneId ? " here" : ""}`}
            detail={`You're clear${status?.asOf ? `, checked ${formatRelative(status.asOf)}` : ""}. A new ask from the team lands here first.`}
            testId="nothing-waiting"
          />
        )}
        {quietAlerts.length > 0 && (
          <div className="mb-2 grid gap-1" data-testid="monitor-alert-lines">
            {quietAlerts.map((i) => (
              <MonitorAlertLine key={i.id} item={i} />
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3">
          {[...byPersona].map(([who, rows]) => {
            const list = rows.flatMap((r) => (r.item ? [r.item] : []));
            if (!list.length) return rows.map((r) => r.sent && <SentRow key={r.slot} slot={r.slot} entry={r.sent} />);
            const link = runHref(list[0]);
            return (
              <div key={who} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border p-3" data-testid="blocking-now">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-red-800 dark:text-red-300">
                  Blocking {who} now
                  {link.internal ? (
                    <Link className="inline-flex items-center gap-1 text-xs font-normal underline" to={link.href}>
                      {link.label}
                    </Link>
                  ) : (
                    <ThreadLink className="inline-flex items-center gap-1 text-xs font-normal underline" threadId={link.threadId!} environmentId={link.environmentId}>
                      {link.label} <ExternalLink className="h-3 w-3" />
                    </ThreadLink>
                  )}
                </div>
                {rows.map((r) =>
                  r.sent || !r.item ? (
                    r.sent && <SentRow key={r.slot} slot={r.slot} entry={r.sent} />
                  ) : (
                    <Open key={r.item.id} item={r.item}>
                      <WaitingCard item={r.item} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} />
                    </Open>
                  ),
                )}
              </div>
            );
          })}
          {keptRows.map(({ slot, item: r, sent }) =>
            sent || !r ? (
              sent && <SentRow key={slot} slot={slot} entry={sent} />
            ) : r.status ? (
              <Open key={r.status.id}>
                <StatusItemRow item={r.status} milestone={showMilestone ? names.get(r.status.milestoneId) : undefined} />
              </Open>
            ) : setOf.has(r.card!.id) ? (
              setLead.has(r.card!.id) && (
                <Open key={`set:${r.card!.id}`} n={setOf.get(r.card!.id)!.items.length}>
                  <AskSet group={setOf.get(r.card!.id)!} readOnly={readOnly} />
                </Open>
              )
            ) : (
              <Open key={r.card!.id} item={r.card!}>
                <WaitingCard item={r.card!} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} />
              </Open>
            ),
          )}
        </div>
      </FoldSection>
      </>
      )}
      {part !== "blocked" && (
      <>
      {macCount > 0 && !laptopOn && (
        <FoldSection title="Needs Mac agent" count={macCount} testId="mac-agent" bodyTestId="mac-agent-section" open={macOpen || searching} onToggle={setMacOpen}>
          <p className="mb-2 text-xs text-muted-foreground">
            Claude on your Mac does these in your own Chrome, one text each. Each is a card: Done, Stuck, a note or a voice note.{" "}
            <a className="underline" href={macListUrl()} target="_blank" rel="noreferrer" data-testid="mac-agent-list">
              Open the Mac list
            </a>{" "}
            to run them in one sitting.
          </p>
          {/* the same cards as the laptop list (a Done here ticks the ticket page and clears it); without the Mac list, each ask's own card */}
          {macRows ? (
            <MacCards rows={macRows} askCard={askCard} keyBox={keyBox} testId="mac-agent-cards" />
          ) : (
            <div className="grid grid-cols-1 gap-3" data-testid="mac-agent-cards">
              {mac.map((i) => (
                <WaitingCard key={i.id} item={i} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} />
              ))}
            </div>
          )}
        </FoldSection>
      )}
      {snoozed.length > 0 && (
        <FoldSection
          title="Snoozed"
          count={snoozed.length}
          testId="snoozed"
          bodyTestId="snoozed-section"
          open={snoozedOpen || searching}
          onToggle={setSnoozedOpen}
          actions={<LimitControl limit={snoozedLimit} onChange={setSnoozedLimit} total={snoozed.length} testId="snoozed" />}
        >
          <p className="mb-2 text-xs text-muted-foreground">Still waiting on you, hidden until the day or time shown (written in each spine).</p>
          <ListPane shown={limitList(snoozed, snoozedLimit).length} total={snoozed.length} testId="snoozed" className="grid-cols-1">
            {limitList(snoozed, snoozedLimit).map((i) => (
              <SnoozedRow key={i.id} item={i} qualify={qualify} showMilestone={showMilestone} />
            ))}
          </ListPane>
        </FoldSection>
      )}
      {fyi.length > 0 && (
        <FoldSection
          title="Decided for you"
          count={fyi.length}
          testId="decided-for-you"
          open={fyiOpen || searching}
          onToggle={setFyiOpen}
          actions={<LimitControl limit={fyiLimit} onChange={setFyiLimit} total={fyi.length} testId="decided-for-you" />}
        >
          <ListPane shown={limitList(fyi, fyiLimit).length} total={fyi.length} testId="decided-for-you" className="grid-cols-1 gap-2">
            {limitList(fyi, fyiLimit).map((i) => (
              <li key={i.id} className="min-w-0">
                <FyiCard item={i} showMilestone={showMilestone} qualify={qualify} />
              </li>
            ))}
          </ListPane>
        </FoldSection>
      )}
      {coming.length > 0 && (
        <FoldSection
          title="Coming up"
          count={coming.length}
          testId="coming-up"
          open={comingOpen || searching}
          onToggle={setComingOpen}
          actions={<LimitControl limit={comingLimit} onChange={setComingLimit} total={coming.length} testId="coming-up" />}
        >
          <ListPane shown={limitList(coming, comingLimit).length} total={coming.length} testId="coming-up" className="grid-cols-1">
            {limitList(coming, comingLimit).map((i) => (
              <RowLine key={i.id} item={i} note={[i.gateReason, showMilestone ? i.milestoneTitle : undefined].filter(Boolean).join(" · ")} />
            ))}
          </ListPane>
        </FoldSection>
      )}
      {rest.length > 0 && (
        // folded = the one "Answered" line, nothing else; open = one compact line per ask, a click opens that ask's card.
        <FoldSection
          title="Answered"
          count={rest.length}
          testId="answered-section"
          open={answeredOpen || searching}
          onToggle={setAnsweredOpen}
          actions={<LimitControl limit={answeredLimit} onChange={setAnsweredLimit} total={rest.length} testId="answered" />}
        >
          <ListPane shown={limitList(rest, answeredLimit).length} total={rest.length} testId="answered" className="grid-cols-1 gap-0.5">
            {limitList(rest, answeredLimit).map((i) => (
              <AnsweredRow key={i.id} item={i} done={consumed(i)} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} />
            ))}
          </ListPane>
        </FoldSection>
      )}
      {superseded.length > 0 && (
        <FoldSection
          title="Superseded"
          count={superseded.length}
          testId="superseded"
          open={supersededOpen || searching}
          onToggle={setSupersededOpen}
          actions={<LimitControl limit={supersededLimit} onChange={setSupersededLimit} total={superseded.length} testId="superseded" />}
        >
          <ListPane shown={limitList(superseded, supersededLimit).length} total={superseded.length} testId="superseded">
            {limitList(superseded, supersededLimit).map((i) => (
              <li key={i.id} className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap text-sm text-muted-foreground" data-testid="superseded-row" title={i.question}>
                <span className="min-w-0 flex-1 truncate">{i.question}</span>
                <Badge variant="outline" className="shrink-0">{i.supersededBy === "moot" || !i.supersededBy ? "superseded: moot" : `superseded by ${i.supersededBy}`}</Badge>
              </li>
            ))}
          </ListPane>
        </FoldSection>
      )}
      </>
      )}
      {milestoneId && sendOpen && <SendToDialog milestoneId={milestoneId} open={sendOpen} onOpenChange={setSendOpen} />}
    </>
  );
}

/** the milestone's `## Outcome` is written (marked, or ready to mark from it): its persona requests are consumed. */
function outcomeWritten(status: MilestoneStatusView | StatusBatch | undefined, milestoneId?: string): boolean {
  if (!status) return false;
  const st = "milestones" in status ? status.milestones.find((m) => m.milestoneId === milestoneId) : status;
  return !!st && (st.outcome.source === "outcome" || st.outcome.word === "ready_to_mark");
}

/** "answered by the owner 2 h ago" (the console answer, else the spine's `[answered … @who]`); the world's owner. */
export function answeredBy(i: WaitingItem): string {
  const at = i.response?.createdAt;
  const owner = i.ownerName ?? DEFAULT_OWNER;
  const who = i.response ? owner : (i.who ?? owner);
  return `answered by ${who}${at ? ` ${formatRelative(at, new Date())}` : ""}${i.answer ? `: ${i.answer}` : ""}`;
}

/**
 * one answered ask as one compact line (code, question, chip, answer, each cut to one line; full text on hover); a
 * click opens its card. One line on a phone too (the answer text is hidden there; hover or open the card for it).
 */
function AnsweredRow({ item: i, done, showMilestone, readOnly, qualify }: { item: WaitingItem; done: boolean; showMilestone?: boolean; readOnly?: string; qualify?: boolean }) {
  const [open, setOpen] = useState(false);
  const code = codeLabel(i, !!qualify);
  const question = i.question || i.title;
  const by = answeredBy(i);
  return (
    <li className="min-w-0" data-testid="answered-row">
      <button
        type="button"
        className="flex w-full min-w-0 items-baseline gap-x-2 whitespace-nowrap rounded px-1 py-0.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
        title={`${code ? `${code} ` : ""}${question}\n${by}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <FoldChevron open={open} className="self-center" />
        <RowCode item={i} qualify={!!qualify} />
        <span className="min-w-0 flex-1 truncate" data-testid="answered-question">{question}</span>
        {/* not on a phone: the section already says Answered, and the question keeps the line (it was cut to two words) */}
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal max-sm:hidden">{done ? "answered, done" : "answered"}</Badge>
        {/* the same answer closed other asks: said on the folded row too, the full line in the opened card. */}
        {!!i.response?.settles?.closed.length && (
          <Badge variant="outline" className="shrink-0 border-sky-500/40 px-1.5 py-0 text-[10px] font-normal text-sky-800 dark:text-sky-300" title={i.response.settles.line} data-testid="answered-also-closed">
            also closed {i.response.settles.closed.length}
          </Badge>
        )}
        {/* one line on a phone too: the answer shows from sm up; on a phone it is on hover and in the opened card. */}
        <span className="hidden min-w-0 max-w-[40%] truncate text-xs sm:inline" data-testid="answered-answer">{by}</span>
      </button>
      {open && (
        <div className="mt-1 mb-2">
          {i.slim ? <WholeAskLoader item={i} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} /> : <WaitingCard item={i} showMilestone={showMilestone} readOnly={readOnly} qualify={qualify} />}
        </div>
      )}
    </li>
  );
}

/**
 * the list carries a done ask as its one-line row; its whole card is fetched when the row opens (a fixed-size
 * placeholder meanwhile). Without the route (mock, an older console) the row's own fields make the card.
 */
function WholeAskLoader({ item, ...rest }: { item: WaitingItem; showMilestone?: boolean; readOnly?: string; qualify?: boolean }) {
  const { data, error } = useQuery(() => (api.getWaitingItem ? api.getWaitingItem(item.id, item.milestoneId) : Promise.resolve(item)), [item.id]);
  if (!data && !error) return <SkeletonCards count={1} testId="answered-card-loading" />;
  return <WaitingCard item={data ?? item} {...rest} />;
}

/** an open status item with no Waiting-on-you card (Ready to mark, a failed run): one row, its one action. */
/**
 * E948-S141: an open item drawn in Blocked on you (one card, one status row, or an ask set of `n` asks): the live inbox
 * check (lib/countCheck) counts these and fails when the section's pill says another number. Layout-neutral.
 */
function Open({ n = 1, item, children }: { n?: number; item?: Pick<WaitingItem, "repo" | "code">; children: ReactNode }) {
  return (
    <div className="contents" data-inbox-open={n === 1 ? "" : String(n)} data-card-key={item ? cardKey("ask", item.repo, item.code) : undefined}>
      {children}
    </div>
  );
}

export function StatusItemRow(props: { item: PendingItem; milestone?: string }) {
  // E948-S130: a status line or an alert he wrote on collapses to its Sent row, like every card
  return (
    <SentOr slot={`status:${props.item.id}`}>
      <StatusItemBody {...props} />
    </SentOr>
  );
}

function StatusItemBody({ item, milestone }: { item: PendingItem; milestone?: string }) {
  if (item.kind === "monitor_alert") return <MonitorAlertCard item={item} />;
  const action = pendingAction(item);
  // E948-S198 (vn_c408c78f): the card leads with its one plain question, never the row's internal line.
  const asked = statusQuestion(item);
  // E948-S200: an ask whose question is a yes or no (every approve ask is) answers it right here, Yes or No, never a lone Answer.
  const yesNo = (item.kind === "ask" || item.kind === "needs_jordi") && item.ask !== "provide" && item.ask !== "do" && (item.ask === "approve" || isYesNo(asked.question));
  // a status line is a card of the one family: meta, heading, body, its one button.
  return (
    <CardShell kind={item.kind} data-testid="status-item" data-kind={item.kind} data-pending-id={item.id} data-row={item.nodeKey} id={waitingAnchor(item.id)}>
      <CardMeta kind={item.kind === "mark_ready" ? "Do" : yesNo || item.kind === "stalled" ? "Decision" : "Review"} about={item.kind === "ready_to_mark" ? undefined : item.kind === "stalled" ? (item.goal ?? milestone ?? aboutFrom(item.title)) : aboutFrom(item.title)} since={item.since} sinceWhat="issued">
        {milestone && <span data-testid="status-item-milestone">{milestone}</span>}
        <OwnerPriorityTag p={item.ownerPriority} className="max-sm:min-w-0 max-sm:shrink max-sm:text-left" />
      </CardMeta>
      <div className={CARD_TITLE} data-testid="status-item-question">
        {asked.question}
      </div>
      {asked.why && (
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground" data-testid="status-item-why">
          Why: {asked.why}
        </p>
      )}
      {/* every Blocked card gives its info (what waits on the owner), not only the ready stamp. */}
      {item.detail && <p className="mt-1 text-sm leading-relaxed text-foreground/85" data-testid="status-item-detail">{item.detail}</p>}
      {/* E948-S60: a status card takes feedback too, to the Team desk with the card named; E948-S131: its one action leads the row. */}
      <CardFeedback
        origin={`status-feedback:${item.id}`}
        title={item.title}
        refName={item.id}
        sent={{ slot: `status:${item.id}` }}
        className="mt-3.5"
        actions={
          <>
            {/* the owner's ready stamp is the item's one action, right here (writes Status: ready, like the Tree's button). */}
            {item.kind === "mark_ready" ? (
              <StampButton milestoneId={item.milestoneId} to="ready" {...(item.path ? { path: item.path } : {})} />
            ) : item.kind === "ready_to_mark" ? (
              <FinishedButtons item={item} />
            ) : item.kind === "stalled" ? (
              <StalledButtons item={item} question={asked.question} open={"to" in action ? action.to : undefined} />
            ) : yesNo ? (
              <StatusYesNo item={item} question={asked.question} open={"to" in action ? action.to : undefined} />
            ) : (
              "to" in action && (
                <CardButton asChild variant="outline" >
                  <Link to={action.to}>{action.label}</Link>
                </CardButton>
              )
            )}
            {(item.kind === "ask" || item.kind === "needs_jordi") && <StatusDuplicate item={item} question={asked.question} />}
          </>
        }
      />
    </CardShell>
  );
}

/**
 * E948-S200 (the owner, closing E948-S109 24 Nov: a yes-or-no card's buttons say Yes and No, not Answer): a status card for an
 * ask that asks yes or no (a held ask like E907-A43, "Do you approve one private test notes repo …?") shows Yes and No, each
 * saying what it does, through the ask's own answer route; its words box below stays for a free note, and the whole card
 * is one link away. An approve ask's Yes approves and its No declines; any other ask gets "Yes" or "No" as its answer.
 */
function StatusYesNo({ item, question, open }: { item: PendingItem; question: string; open?: string }) {
  const [busy, setBusy] = useState<"yes" | "no">();
  const [error, setError] = useState<string>();
  const approve = item.ask === "approve";
  const press = async (yes: boolean) => {
    setBusy(yes ? "yes" : "no");
    setError(undefined);
    try {
      const kind = approve ? (yes ? "approve" : "deny") : "answer";
      await mutate(() => api.respondToWaiting(item.id, { kind, text: approve ? "" : yes ? "Yes" : "No", milestoneId: item.milestoneId, wake: true }), "inbox");
      markSent(`status:${item.id}`, { said: yes ? "Yes. The team goes ahead." : "No. The team drops it.", title: question });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <CardButton onClick={() => void press(true)} disabled={!!busy} title={ACTION.approve.hint} data-testid="yes">
        {busy === "yes" ? <Loader2 className="animate-spin" /> : <Check />} {YES_LABEL}
      </CardButton>
      <CardButton variant="outline" onClick={() => void press(false)} disabled={!!busy} title="No. Nothing goes ahead; the team drops it." data-testid="no">
        {busy === "no" && <Loader2 className="animate-spin" />} {NO_LABEL}
      </CardButton>
      {open && (
        <CardButton asChild variant="ghost">
          <Link to={open} data-testid="status-open-card">
            Open the whole card
          </Link>
        </CardButton>
      )}
      {error && <span className="text-xs text-destructive" data-testid="status-yes-no-error">{error}</span>}
    </>
  );
}

/**
 * E948-S204 (the owner, closing E948-S200 24 Nov: "a stalled-team card asks Should a team member work on it? and offers
 * Switch on, not Yes and No"): the card for a goal whose team is off answers its question right here.
 *
 *   Should a team member work on it?
 *   [ Switch on ]  ── the goal's switched-off persona starts waking: the Personas tab's own switch, written to the repo
 *   [ Leave it off ] ── quiet: the goal is paused (written to the repo too), so the card does not come back
 *   words box below ── a free note to the team, as on every card
 *
 * With no persona to switch on, Switch on opens the goal's Personas tab to pick one.
 */
function StalledButtons({ item, question, open }: { item: PendingItem; question: string; open?: string }) {
  const target = item.switchOn?.[0];
  const [busy, setBusy] = useState<"on" | "off">();
  const [error, setError] = useState<string>();
  const press = async (on: boolean) => {
    setBusy(on ? "on" : "off");
    setError(undefined);
    try {
      if (on && target) await mutate(() => api.updateAssignment(target.assignmentId, { enabled: true }), "inbox");
      else await mutate(() => api.updateMilestone(item.milestoneId, { paused: true }), "inbox");
      markSent(`status:${item.id}`, {
        said: on ? `Switched on. ${target!.persona} starts working on it.` : "Left off. The goal is paused until you switch it on.",
        title: item.goal ?? question,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      {target ? (
        <CardButton onClick={() => void press(true)} disabled={!!busy} title={`${target.persona} starts waking on its cadence and works the ready steps.`} data-testid="stalled-switch-on">
          {busy === "on" ? <Loader2 className="animate-spin" /> : <Check />} Switch on
        </CardButton>
      ) : (
        open && (
          <CardButton asChild>
            <Link to={open} data-testid="stalled-switch-on">
              Switch on
            </Link>
          </CardButton>
        )
      )}
      <CardButton variant="ghost" onClick={() => void press(false)} disabled={!!busy} title="Nobody works on it. The goal is paused until you switch it on." data-testid="stalled-leave-off">
        {busy === "off" && <Loader2 className="animate-spin" />} Leave it off
      </CardButton>
      {error && <span className="text-xs text-destructive" data-testid="stalled-error">{error}</span>}
    </>
  );
}

/**
 * E948-S139 (the owner, 24 Nov 20:37Z: "Give me a button. That's it Duplicate or already answered"): a status card for an ask
 * closes in one tap as a duplicate or already answered, through the ask's own answer route; the console names the card it
 * repeats on the answer line and tells the asker.
 */
function StatusDuplicate({ item, question }: { item: PendingItem; question: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const press = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await mutate(() => api.respondToWaiting(item.id, { kind: "answer", text: ACTION.duplicate.words, milestoneId: item.milestoneId, wake: true }), "inbox");
      markSent(`status:${item.id}`, { said: ACTION.duplicate.said, title: question });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <CardButton variant="outline" onClick={() => void press()} disabled={busy} title={ACTION.duplicate.hint} data-testid="card-duplicate">
        {busy && <Loader2 className="animate-spin" />} {ACTION.duplicate.label}
      </CardButton>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </>
  );
}

/**
 * the Ready to mark card asks "Is <goal> finished?"; its buttons answer that question. Yes marks it finished
 * (the team's own Outcome sentence and evidence, Status done, its team stops); the results page opens beside it; Not yet is
 * his words by voice or text in the box below, which go to the team.
 */
function FinishedButtons({ item }: { item: PendingItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const yes = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await mutate(() => api.markMilestone(item.milestoneId, { verdict: "accomplished" }));
      markSent(`status:${item.id}`, { said: "Marked finished. Its team stops.", title: item.title });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <CardButton onClick={() => void yes()} disabled={busy} data-testid="ready-to-mark-yes">
        {busy ? <Loader2 className="animate-spin" /> : <Check />} Yes, it's finished
      </CardButton>
      {item.url ? (
        <CardButton asChild variant="outline">
          <a href={item.url} target="_blank" rel="noreferrer" data-testid="ready-to-mark-results">
            <ExternalLink /> Open the results
          </a>
        </CardButton>
      ) : (
        <CardButton asChild variant="outline">
          <Link to={`/milestones/${encodeURIComponent(item.milestoneId)}?tab=summary`}>Open the goal</Link>
        </CardButton>
      )}
      {error && <span className="text-xs text-destructive" data-testid="ready-to-mark-error">{error}</span>}
    </>
  );
}

/**
 * the ask a counted monitor alert names, as its own Waiting on you card (the same card, buttons and feedback:
 * Approve, Deny, an option, Answer, Save key, Snooze). Its buttons go through the alert's milestone (`relay`), which
 * writes to the ask in its own repo and world (a social world repo's page answering the code repo/).
 */
export function alertAskItem(alert: PendingItem, a: MonitorAlertAsk): WaitingItem | undefined {
  const c = a.card;
  if (!c || a.state !== "open" || a.snoozedUntil || !a.milestoneId) return undefined;
  return {
    id: a.id ?? `${alert.id}:${a.code}`,
    source: "ask",
    state: "open",
    repo: a.repo,
    code: a.code,
    milestoneId: a.milestoneId,
    milestoneTitle: a.milestoneTitle ?? "",
    path: c.path,
    ...(c.line !== undefined ? { line: c.line } : {}),
    ...(c.row ? { row: c.row } : {}),
    title: c.question,
    ask: c.ask,
    question: c.question,
    ...(c.options?.length ? { options: c.options } : {}),
    ...(c.recommendation ? { recommendation: c.recommendation } : {}),
    ...(c.contextText ? { contextText: c.contextText } : {}),
    ...(c.impact ? { impact: c.impact } : {}),
    ...(c.risk ? { risk: c.risk } : {}),
    ...(c.whyYou ? { whyYou: c.whyYou } : {}),
    ...(c.secret ? { secret: c.secret } : {}),
    ...(c.since ? { since: c.since } : {}),
    contextLinks: a.href ? [{ label: `${a.repo ? `${a.repo}/` : ""}${a.code} in ${a.milestoneTitle ?? `its ${DEFAULT_SKIN.words.milestone}`}`, url: a.href }] : [],
    owner: { kind: "delivery-manager", label: "Delivery Manager" },
    decidable: false,
    relay: { milestoneId: alert.milestoneId, code: a.code },
  } as WaitingItem;
}

/**
 * a monitor that saw something stop (or a check a day overdue) as an alert: the item, how long, the overdue
 * check, and the ask that unblocks it (linked). A counted alert carries that ask's own card with its buttons,
 * so the owner acts here; snoozed and Delivery Manager alerts are a quiet line (MonitorAlertLine), never this card.
 */
export function MonitorAlertCard({ item }: { item: PendingItem }) {
  return (
    <SentOr slot={`status:${item.id}`}>
      <MonitorAlertBody item={item} />
    </SentOr>
  );
}

function MonitorAlertBody({ item }: { item: PendingItem }) {
  const m = item.monitor;
  const asks = m?.asks ?? [];
  return (
    <CardShell kind="monitor_alert" className="text-sm" data-testid="monitor-alert" data-kind={item.kind} data-pending-id={item.id} id={waitingAnchor(item.id)}>
      <CardMeta kind="Alert" about={aboutFrom(item.title.replace(/^Monitor alert:\s*/, ""))} since={item.since} sinceWhat="issued">
        <span data-testid="monitor-alert-state">{m?.why.includes("stop") ? "Stopped" : "Check overdue"}</span>
      </CardMeta>
      <div className={CARD_TITLE}>{item.title.replace(/^Monitor alert:\s*/, "")}</div>
      {item.detail && <p className="mt-1 text-sm leading-relaxed text-foreground/85" data-testid="monitor-alert-detail">{item.detail}</p>}
      {asks.length > 0 && (
        <ul className="mt-3 grid gap-1" data-testid="monitor-alert-asks">
          {asks.map((a) => {
            const label = `${a.repo ? `${a.repo}/` : ""}${a.code}`;
            const state = a.state === "missing" ? "no ask has this code" : a.snoozedUntil ? `snoozed until ${a.snoozedUntil}` : a.state === "open" ? "open" : "already answered";
            const card = alertAskItem(item, a);
            return (
              <li key={label} className="grid min-w-0 gap-1.5" data-testid="monitor-alert-ask">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="text-muted-foreground">Unblocked by</span>
                  <AskLink href={a.href} label={label} />
                  <Badge variant={a.snoozedUntil || a.state === "missing" ? "amber" : "outline"} data-testid="monitor-alert-ask-state">
                    {state}
                  </Badge>
                  {!card && a.question && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={a.question}>{a.question}</span>}
                </div>
                {card && (
                  <div className="min-w-0" data-testid="monitor-alert-ask-card">
                    <WaitingCard item={card} qualify />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {m && !asks.some((a) => a.state === "open") && <span className="mt-1 text-xs text-muted-foreground" data-testid="monitor-alert-next">{m.next}</span>}
      {/* E948-S60: the alert itself takes feedback (its asks' cards carry their own). */}
      <CardFeedback origin={`alert-feedback:${item.id}`} title={item.title.replace(/^Monitor alert:\s*/, "")} refName={item.id} sent={{ slot: `status:${item.id}` }} />
    </CardShell>
  );
}

function AskLink({ href, label }: { href?: string; label: string }) {
  if (!href) return <span className="font-mono text-xs font-semibold">{label}</span>;
  return /^https?:/.test(href) ? (
    <a className="font-mono text-xs font-semibold underline" href={href} target="_blank" rel="noreferrer">
      {label} <ExternalLink className="inline h-3 w-3" />
    </a>
  ) : (
    <Link className="font-mono text-xs font-semibold underline" to={href}>
      {label}
    </Link>
  );
}

/**
 * a monitor alert that is not the owner's now, as one quiet line, never counted: snoozed ("waits on, snoozed
 * by you until 2026-11-04" + Unsnooze, which unsnoozes the ask in its own world; the alert is counted again), or the
 * Delivery Manager's (no open ask: it writes one or clears the item).
 */
export function MonitorAlertLine({ item }: { item: PendingItem }) {
  const m = item.monitor;
  const open = (m?.asks ?? []).filter((a) => a.state === "open" && a.snoozedUntil && a.milestoneId);
  const what = item.title.replace(/^Monitor alert:\s*/, "");
  return (
    <div className="grid min-w-0 gap-1 text-sm text-muted-foreground" data-testid="monitor-alert-line" data-state={item.state} data-alert-id={item.id}>
      <div className="flex min-w-0 items-center gap-x-2 whitespace-nowrap" title={`${what}\n${m?.next ?? ""}`}>
        <Badge variant="outline" className="shrink-0">
          {item.state === "snoozed" ? "Snoozed alert" : "Delivery Manager"}
        </Badge>
        {/* Who and the item on the first line, what unblocks it on its own line under them (polish.css). */}
        <span className="shrink-0 text-foreground" data-testid="monitor-alert-line-why">
          {item.state === "snoozed" && open.length > 0 ? `waits on ${open.map((a) => `${a.code}, snoozed by you until ${a.snoozedUntil}`).join("; ")}` : (m?.next ?? "names no open ask")}
        </span>
        <span className="min-w-0 flex-1 truncate" data-testid="monitor-alert-line-what">· {what}</span>
        {item.state === "snoozed" && open.map((a) => <AlertUnsnooze key={a.code} alert={item} ask={a} />)}
      </div>
    </div>
  );
}

/** Unsnooze the ask a snoozed alert waits on (in its own world, through the alert); spinner and result at the button (L-38). */
function AlertUnsnooze({ alert, ask }: { alert: PendingItem; ask: MonitorAlertAsk }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const go = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await mutate(() => api.snoozeWaiting(ask.id ?? ask.code, { until: null, milestoneId: ask.milestoneId, relay: { milestoneId: alert.milestoneId, code: ask.code } }), "inbox");
      setNote({ ok: true, text: `${ask.code} unsnoozed: the alert is back` });
    } catch (e) {
      setNote({ ok: false, text: `Unsnooze failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <CardButton variant="outline" className={cn("h-7 shrink-0 text-xs", busy && WORKING)} disabled={busy} aria-busy={busy || undefined} onClick={go} data-testid="alert-unsnooze">
        {busy && <Spinner />}
        {busy ? "Unsnoozing…" : "Unsnooze"}
      </CardButton>
      {note && (
        <span className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")} data-testid="alert-unsnooze-note">
          {note.text}
        </span>
      )}
    </span>
  );
}

/** the owner's answers and messages in Activity, with the thread each went to. */
export function OwnerActivityList({ milestoneId }: { milestoneId?: string }) {
  const { data } = useQuery(() => api.listOwnerActivity(milestoneId), [milestoneId]);
  const [open, setOpen] = useState(false);
  if (!data?.length) return null;
  const line = (a: OwnerActivity) =>
    a.type === "message"
      ? a.messageKind === "ask_for_asks"
        ? a.text
        : `Message: ${a.text}`
      : a.replacesId
        ? `Changed answer: ${a.itemTitle ?? a.itemId} — “${a.replacedAnswer ?? "?"}” → “${a.kind === "approve" ? `APPROVED${a.text ? ` — ${a.text}` : ""}` : a.kind === "deny" ? `DECLINED${a.text ? ` — ${a.text}` : ""}` : a.text}”`
        : `${a.kind === "approve" ? "Approved" : a.kind === "deny" ? "Declined" : a.kind === "feedback" ? "Changes wanted" : "Answered"}: ${a.itemTitle ?? a.itemId}${a.text ? ` — “${a.text}”` : ""}`;
  return (
    <FoldSection title="From you" count={data.length} testId="owner-activity" open={open} onToggle={setOpen} bodyClassName="p-0">
        <ul className="divide-y">
          {data.map((a) => (
            <li key={a.id} className="grid gap-0.5 px-4 py-2.5 text-sm">
              <span className="break-words">{line(a)}</span>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <RelTime iso={a.at} />
                {a.spine ? (
                  <span className={cn(a.spine.status !== "written" && "text-amber-700 dark:text-amber-400")}>
                    {a.spine.status === "written" ? `written to the spine${a.spine.sha ? ` (${a.spine.sha})` : ""}` : `not written to the spine: ${a.spine.reason ?? a.spine.status}`}
                  </span>
                ) : (
                  <>
                    <span>to {a.personaName ?? a.assignmentId ?? (a.threadId ? "owner thread" : "nobody yet")}</span>
                    <span className={cn(a.delivery !== "sent" && "text-red-700 dark:text-red-400")}>
                      {a.delivery}
                      {a.deliveryError ? `: ${a.deliveryError}` : ""}
                    </span>
                  </>
                )}
                {a.threadId && (
                  <ThreadLink className="inline-flex items-center gap-1 hover:text-foreground hover:underline" threadId={a.threadId} environmentId={a.environmentId}>
                    thread <ExternalLink className="h-3 w-3" />
                  </ThreadLink>
                )}
              </span>
            </li>
          ))}
        </ul>
    </FoldSection>
  );
}
