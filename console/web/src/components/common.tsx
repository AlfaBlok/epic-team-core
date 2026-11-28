import { useEffect, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Check, Clock, Copy } from "lucide-react";
import { api, type MilestoneStatus, type Run, type RunOutcome } from "@/api";
import { worldSwitching } from "@/api/real";
import { goToSite } from "@/lib/inPlaceLinks";
import { RUN_WORD_LABEL, runWord, type RunWord } from "@/lib/status";
import { useOpenAsks } from "@/components/status";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCampaignScope } from "@/lib/campaign";
import { ownerName } from "@/lib/identity";

const DOT: Record<MilestoneStatus, string> = {
  draft: "bg-zinc-300",
  ready: "bg-violet-500",
  active: "bg-emerald-500",
  blocked: "bg-red-500",
  review: "bg-amber-500",
  testing: "bg-amber-500",
  done: "bg-sky-500",
  superseded: "bg-zinc-300",
  deferred: "bg-zinc-400",
  paused: "bg-zinc-400",
  unknown: "bg-zinc-300",
};

export function StatusDot({ status, className }: { status?: MilestoneStatus; className?: string }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT[status ?? "unknown"], className)} />;
}

const STATUS_VARIANT: Record<MilestoneStatus, BadgeProps["variant"]> = {
  draft: "gray",
  ready: "outline",
  active: "green",
  blocked: "red",
  review: "amber",
  testing: "amber",
  done: "blue",
  superseded: "gray",
  deferred: "gray",
  paused: "gray",
  unknown: "gray",
};

const isStatus = (s?: string): s is MilestoneStatus => !!s && s in STATUS_VARIANT;

/** Badge for a spine status word (from the `Status:` line only); an unknown word is shown as-is. */
export function StatusBadge({ status, title }: { status?: MilestoneStatus | string; title?: string }) {
  const s = status || "unknown";
  return (
    <Badge variant={isStatus(s) ? STATUS_VARIANT[s] : "gray"} title={title}>
      <StatusDot status={isStatus(s) ? s : "unknown"} />
      {s === "unknown" ? "no status" : s}
    </Badge>
  );
}

/** run badges use the milestone words; amber (Needs you) is the attention colour, Monitoring calm blue. */
const WORD_VARIANT: Record<RunWord, BadgeProps["variant"]> = {
  working: "outline",
  progressed: "green",
  needs_you: "amber",
  monitoring: "blue",
  idle: "gray",
  failed: "red",
  // an attention state, never green: the turn ended and nobody reported what (if anything) it did.
  blank_report: "amber",
  // the owner's own act, nothing wrong and nothing to do: calm grey.
  stopped: "gray",
  // load-cap / no seat when it started; the console retries it: waiting, not wrong (never red).
  deferred: "amber",
};

/** Human label of an outcome (`blank_report` -> "Ended without report", `blocked` -> "Needs you"). */
export const outcomeLabel = (o: RunOutcome) => RUN_WORD_LABEL[runWord({ outcome: o, summary: "" })];

/** a time label, relative ("3 min ago", "in 2 h"), with the exact timestamp on hover. */
export function RelTime({ iso, now, className }: { iso?: string | null; now?: number; className?: string }) {
  if (!iso) return <span className={className}>—</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso, now === undefined ? undefined : new Date(now))}
    </time>
  );
}

/**
 * The owner 17 Nov (vn_4d2a86f9: "this very card ... it is not showing its age, bro"; vn_c2d7cc29: "Why can
 * I not see how old this card is?"): how old a card is, in his short form ("12 min old", "3 h old", "2 d old", "1 wk old"),
 * the full date and time on hover. ONE component for every card: CardMeta draws it right after the kind word, so it sits
 * in the same spot on every card in every place (Inbox, an objective's Inbox and Board, red lines, Mac, posts); lists
 * (the slim inbox, the Board) draw it first on each line. Ink, not grey, so it reads at a glance. A date-only value (an
 * old ask line) counts calendar days ("today", "3 d old").
 */
export function cardAgeWords(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  let min: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    const days = Math.round((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(y, m - 1, d)) / 86_400_000);
    if (days <= 0) return "today";
    min = days * 1440;
  } else {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  }
  if (min < 1) return "just now";
  if (min < 60) return `${min} min old`;
  if (min < 1440) return `${Math.floor(min / 60)} h old`;
  const days = Math.floor(min / 1440);
  if (days < 14) return `${days} d old`;
  if (days < 60) return `${Math.floor(days / 7)} wk old`;
  if (days < 365) return `${Math.floor(days / 30)} mo old`;
  return `${Math.floor(days / 365)} yr old`;
}

export function CardAge({ iso, className, what = "issued" }: { iso?: string | null; className?: string; what?: string }) {
  const words = cardAgeWords(iso);
  if (!iso || !words) return null;
  return (
    <time
      dateTime={iso}
      title={/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${what} ${iso} (day only)` : `${what} ${formatDateTime(iso)}`}
      className={cn("whitespace-nowrap text-xs tabular-nums text-foreground/85", className)}
      data-testid="issued-age"
      data-card-age=""
    >
      {words}
    </time>
  );
}
/** the old name: every card's age is CardAge. */
export const IssuedAge = CardAge;

/**
 * A run's word: Working / Needs you / Monitoring / Progressed / Failed / Idle. With `run`, a `blocked` run reads Needs
 * you only while a code it cites is open (OpenAsksContext), else Monitoring; a Monitoring badge says "next check <time>".
 */
export function OutcomeBadge({ outcome, run }: { outcome: RunOutcome; run?: Run }) {
  const open = useOpenAsks();
  const word = runWord({ outcome, summary: run?.summary ?? "" }, run ? open : undefined);
  const next = word === "monitoring" ? run?.nextCheckAt ?? run?.retryAt : undefined;
  const reported = run?.reportedOutcome && run.reportedOutcome !== outcome ? ` (reported ${run.reportedOutcome})` : "";
  if (word === "monitoring" && run?.heldOn) return <HeldChip heldOn={run.heldOn} next={next} />;
  // the run skipped its note, or the console could not bring the persona's checkout current.
  const pullFailed = !!run?.preWake && /pull failed|unreadable/.test(run.preWake);
  if (run && (run.noteSkipped || pullFailed))
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <OutcomeBadge outcome={outcome} run={{ ...run, noteSkipped: undefined, preWake: undefined }} />
        {run.noteSkipped && (
          <Badge variant="amber" data-testid="note-skipped" title={`The report never said what it did about the note (note: done|not done):\n${run.instructions ?? ""}`}>
            note skipped
          </Badge>
        )}
        {pullFailed && (
          <Badge variant="amber" data-testid="stale-checkout" title={run.preWake}>
            stale checkout
          </Badge>
        )}
      </span>
    );
  // the wake said idle while steps read ready, or gave the same report n wakes in a row.
  if (run && (run.readyIgnored?.length || run.repeating))
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <OutcomeBadge outcome={outcome} run={{ ...run, readyIgnored: undefined, repeating: undefined }} />
        {!!run.readyIgnored?.length && (
          <Badge variant="amber" data-testid="ready-ignored" title={`Reported idle, but these steps read ready: ${run.readyIgnored.join(", ")}. Fix the step status or work them.`}>
            ignored {run.readyIgnored.length} ready
          </Badge>
        )}
        {!!run.repeating && (
          <Badge variant="gray" data-testid="repeating" title={run.repeatSince ? `First of them ${formatDateTime(run.repeatSince)}` : undefined}>
            {repeatLabel(run.repeating, run.repeatSince)}
          </Badge>
        )}
      </span>
    );
  // a Delivery manager wake that launched nothing while rows read ready and named no blocker.
  if (run?.stalled)
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <OutcomeBadge outcome={outcome} run={{ ...run, stalled: undefined }} />
        <Badge variant="amber" data-testid="run-stalled" title={`Ready means go (L-26): this wake ${run.stalled}. A wake that starts nothing names its one blocker (\`blocker: …\`).`}>
          stalled
        </Badge>
      </span>
    );
  // the run's commits broke its pack's rules (wrong role or transition); never reverted by the console.
  if (run?.ruleBroken)
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <OutcomeBadge outcome={outcome} run={{ ...run, ruleBroken: undefined }} />
        <Badge variant="red" data-testid="rule-broken" title={`Pack check after the run${run.ruleBroken.roles.length ? ` (as ${run.ruleBroken.roles.join("/")})` : ""}:\n${run.ruleBroken.issues.join("\n")}`}>
          rule broken
        </Badge>
      </span>
    );
  // NO_SELF_READY: the run turned a draft into ready itself; the Delivery manager reverts it.
  if (run?.selfReadied?.length)
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <OutcomeBadge outcome={outcome} run={{ ...run, selfReadied: undefined }} />
        <Badge variant="amber" data-testid="self-readied" title={`Only ${ownerName()} stamps ready. This run changed:\n${run.selfReadied.join("\n")}`}>
          self-readied
        </Badge>
      </span>
    );
  return (
    <Badge
      variant={WORD_VARIANT[word]}
      data-word={word}
      title={
        outcome === "blank_report"
          ? "The T3 turn ended and nobody reported: unknown, not progress. Verify its effect, then redispatch or record."
          : word === "monitoring"
            ? `Waiting on a time or a condition, nothing for you to do${reported}.${next ? ` Next check ${formatDateTime(next)}.` : ""}`
            : undefined
      }
    >
      {RUN_WORD_LABEL[word]}
      {next ? ` · next check ${formatRelative(next)}` : ""}
    </Badge>
  );
}

/** `egress:laptop` → "held: laptop offline" (same words as the server's status reason). */
/** "same report ×5 since 3 h ago". */
export const repeatLabel = (n: number, since?: string, now?: number) =>
  `same report ×${n}${since ? ` since ${formatRelative(since, now === undefined ? undefined : new Date(now))}` : ""}`;

export const heldLabel = (heldOn: string) => (heldOn === "credits" ? "held: out of credits" : `held: ${heldOn.replace(/^egress:/, "")} offline`);

/** a run held on an offline egress. Not "Needs you": it resumes by itself when the egress is back. */
export function HeldChip({ heldOn, next }: { heldOn: string; next?: string }) {
  return (
    <Badge
      variant={WORD_VARIANT.monitoring}
      data-word="monitoring"
      data-testid="held-chip"
      title={
        heldOn === "credits"
          ? "Held: this workspace is out of credits. It starts again after a top-up or the monthly grant."
          : `Held: the Team Browser route ${heldOn} is offline. Nothing for you to do; it resumes when it is back.${next ? ` Fallback check ${formatDateTime(next)}.` : ""}`
      }
    >
      {heldLabel(heldOn)}
    </Badge>
  );
}

/** "Unblocker answered: act on them" → "". */
export const unblockerCodes = (note: string) => /^\s*unblocker answered\s+(.+?)(?::|\n|$)/i.exec(note)?.[1]?.trim();

/** Run now instructions on a run, collapsed to the first line; labelled by who gave them (the owner or the Unblocker). */
export function RunNote({ text, by, label, ack, className }: { text?: string; by?: string; label?: string; ack?: string; className?: string }) {
  if (!text?.trim()) return null;
  const first = text.trim().split("\n")[0];
  const unblocker = /unblocker/i.test(by ?? "");
  const codes = unblocker ? unblockerCodes(text) : undefined;
  return (
    <details className={cn("text-xs text-muted-foreground", className)} data-testid="run-note">
      <summary className="cursor-pointer truncate">
        {unblocker ? (
          <span className="font-medium text-foreground">Woken by Unblocker{codes ? `: answered ${codes}` : ""}</span>
        ) : (
          <>
            <span className="font-medium text-foreground">{label ?? (by && by !== ownerName() ? `${by}'s note:` : `${ownerName()}'s note:`)}</span> {first}
          </>
        )}
      </summary>
      <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{text.trim()}</p>
      {ack && <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="run-note-ack">note: {ack}</p>}
    </details>
  );
}

/**
 * Link to a T3 thread. With its environment: the T3 desktop app's deep link
 * `t3code://threads/<environmentId>/<threadId>`, both segments URL-encoded (T3 copies the path into its
 * `/$environmentId/$threadId` route, which decodes once: a `thread:delegated-task:command%3A…` id only opens as
 * `…%253A…`; checked in T3's web client 2026-10-24). Without: `t3-thread://v1/<threadId>`, the id exactly as T3
 * returned it, which only works inside T3's own chat, so ThreadLink adds a copy-id button.
 * VITE_T3_THREAD_URL (e.g. a T3 web client `https://host/{env}/{id}`) replaces both: `{env}` and `{id}` URL-encoded;
 * a template with `{env}` is used only when the environment is known.
 */
export function threadHref(threadId: string, environmentId?: string) {
  const tpl = import.meta.env.VITE_T3_THREAD_URL;
  if (tpl && (environmentId || !tpl.includes("{env}")))
    return tpl.replace("{env}", encodeURIComponent(environmentId ?? "")).replace("{id}", encodeURIComponent(threadId));
  return environmentId ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}` : `t3-thread://v1/${threadId}`;
}

/** The link opens nothing outside T3 (no environment known): offer the id to paste into T3's search instead. */
export const threadLinkDead = (href: string) => href.startsWith("t3-thread:");

/** Copies a thread id (for a thread link that cannot open from the browser). */
export function CopyThreadId({ threadId }: { threadId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(threadId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (plain http): the id is in the button title */
    }
  };
  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
      onClick={copy}
      aria-label="Copy thread id"
      title={`Copy thread id (this link only opens inside T3): ${threadId}`}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span className="sr-only">{copied ? "Copied" : "Copy thread id"}</span>
    </button>
  );
}

/** A thread link (t3code:// when the environment is known), plus a copy-id button when it cannot open outside T3. */
export function ThreadLink({
  threadId,
  environmentId,
  className,
  title,
  children,
}: {
  threadId: string;
  environmentId?: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const href = threadHref(threadId, environmentId);
  return (
    <>
      <a className={className} href={href} title={title}>
        {children}
      </a>
      {threadLinkDead(href) && <CopyThreadId threadId={threadId} />}
    </>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  // a social screen inside a campaign tab (Pipeline, Brief & directions, History) sits under the milestone's own
  // header, so its header is a section heading there.
  if (useCampaignScope())
    return (
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" data-testid="section-header">
        <div className="min-w-0">
          <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{title}</h2>
          {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    );
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{title}</h1>
        {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** an empty list is a calm, solid panel, not a dashed hole. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-[10px] bg-muted/60 px-[18px] py-4 text-sm text-muted-foreground" data-testid="empty">{children}</div>;
}

/**
 * an empty state that is news. A round mark, the title in bold, one line under it: the good news
 * (a green tick, "Nothing waiting on you") or what will show here once there is something (a clock).
 */
export function EmptyState({ title, detail, tone = "clear", testId }: { title: string; detail?: ReactNode; tone?: "clear" | "later"; testId?: string }) {
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-3 rounded-[10px] bg-muted/60 px-[18px] py-4" data-testid={testId ?? "empty-state"} data-tone={tone}>
      <span
        aria-hidden
        className={cn(
          "grid h-8 w-8 place-items-center rounded-full",
          tone === "clear" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted text-muted-foreground",
        )}
      >
        {tone === "clear" ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Clock className="h-4 w-4" />}
      </span>
      <div className="min-w-0">
        <b className="block text-sm font-semibold text-foreground">{title}</b>
        {detail && <small className="block text-[13px] text-muted-foreground">{detail}</small>}
      </div>
    </div>
  );
}

export function Loading() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

/** `muted`: for optional read sources (T3, seats) that may be down; shown as a quiet note, not an alarm. */
/**
 * a link into another world this login belongs to (his campaign link opened in his own workspace on the social
 * site) switches to that world once and opens the same page there, instead of a 404 he cannot act on.
 */
function OtherWorld({ world }: { world: { id: string; name: string } }) {
  const [err, setErr] = useState<string>();
  useEffect(() => {
    const here = window.location.pathname + window.location.search + window.location.hash;
    const key = `switched:${world.id}:${here}`;
    if (worldSwitching.on) return; // another box on this page already switches
    try {
      // a switch for this same page under a minute ago did not open it: stop, never loop
      if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 60_000) return setErr("This page did not open after switching. Use Your workspaces in the menu.");
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      /* no storage: switch once anyway */
    }
    worldSwitching.on = true;
    api
      .switchWorld?.(world.id)
      .then((r) => {
        // the installed app never loads the other site over itself: a new window, the app stays here
        if (goToSite(r?.handoff || here) === "window") {
          worldSwitching.on = false;
          setErr("Opened in your other workspace in a new window.");
        }
      })
      .catch((e: unknown) => {
        worldSwitching.on = false;
        setErr((e as Error).message);
      });
  }, [world.id]);
  return (
    <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-testid="other-world">
      {err ?? "Opening this page in your other workspace…"}
    </div>
  );
}

export function ErrorBox({ error, muted }: { error: Error; muted?: boolean }) {
  const world = (error as { code?: string; world?: { id: string; name: string } }).code === "other_world" ? (error as { world?: { id: string; name: string } }).world : undefined;
  if (world) return <OtherWorld world={world} />;
  if (muted) return <Empty>{error.message}</Empty>;
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error.message}</div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * phone answer box. Below sm (640 px) the box takes the full row, uses 16 px text (no focus zoom), is at least
 * 4 lines and grows with its text (CSS field-sizing, JS fallback); on focus it scrolls its row, send buttons included,
 * above the on-screen keyboard. At sm and up nothing changes: the caller's classes render as before.
 */
const PHONE_TEXTAREA = "max-sm:basis-full max-sm:min-h-28 max-sm:max-h-[40dvh] max-sm:text-base max-sm:[field-sizing:content]";
/** a 44 px tap target for a button next to a phone answer box. */
export const PHONE_TAP = "max-sm:min-h-11";
/** a call control on a phone (narrow, or sideways): 64 px tall, a bold label and a big icon, for cold hands outdoors. */
export const CALL_TAP = "phone:h-16 phone:min-h-16 phone:rounded-xl phone:px-5 phone:text-base phone:font-semibold phone:[&_svg]:size-6";
const onPhone = () => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 639.98px)").matches;

export function AnswerTextarea({ className, onInput, onFocus, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(PHONE_TEXTAREA, className)}
      onInput={(e) => {
        const el = e.currentTarget;
        if (onPhone() && !globalThis.CSS?.supports?.("field-sizing", "content")) {
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight + 2}px`;
        }
        onInput?.(e);
      }}
      onFocus={(e) => {
        const row = e.currentTarget.parentElement ?? e.currentTarget;
        // Wait for the keyboard to open (the viewport resizes: interactive-widget=resizes-content in index.html).
        if (onPhone()) setTimeout(() => row.scrollIntoView?.({ block: "end", behavior: "smooth" }), 350);
        onFocus?.(e);
      }}
    />
  );
}

/** the pack check's issue lines under a rule-broken run (Activity, run detail). */
export function RuleBrokenLines({ run, className }: { run: Pick<Run, "ruleBroken">; className?: string }) {
  if (!run.ruleBroken?.issues.length) return null;
  return (
    <div className={cn("text-xs text-red-700 dark:text-red-400", className)} data-testid="rule-broken-lines">
      <p>
        Rule broken{run.ruleBroken.roles.length ? ` as ${run.ruleBroken.roles.join("/")}` : ""} (pack check after the run; sent to the Delivery Manager, nothing reverted):
      </p>
      <ul className="ml-4 list-disc font-mono">
        {run.ruleBroken.issues.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/** why a real cadence wake ran (kept on the run; hidden while the summary still says it). */
export function WokeBecause({ run, className }: { run: Pick<Run, "wokeBecause" | "summary">; className?: string }) {
  if (!run.wokeBecause || run.summary.includes(`woke: ${run.wokeBecause}`)) return null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)} data-testid="woke-because">
      Woke because: {run.wokeBecause}
    </p>
  );
}
