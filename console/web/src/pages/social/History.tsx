import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SocialData, SocialInsight } from "@/api/types";
import { useSectionOpen } from "@/components/homeSection";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common";
import { isLive, isReply, postsOf, type Post } from "@/lib/social";
import { useSocialScreen } from "@/lib/useSocialWrite";
import { LimitControl, ListPane, limitList, useListLimit } from "@/components/listPane";
import { DigestPage } from "@/pages/Digest";
import { ReportPage } from "@/pages/Report";
import { dayLabel, FeedbackBox, OutLink, PostActions, PostBadge, SocialScreen, WriteNoteLine } from "./parts";

/**
 * History (deck v3 slide 15): everything we posted, with its link, numbers and your feedback. Feedback after the
 * fact (👍 / 👎 / note → the row's Feedback and the Feedback log, as you); Pull deletes the live post (C5, asks first).
 * one compact row per post in a fixed pane with Show 20 / 50 / all (L-39),
 * the note box opens on that row's Note only, and Digests (the 20:00 digest, day by day) is a view of this tab.
 */
type Kind = "all" | "post" | "reply" | "outreach" | "digests";
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "post", label: "Posts" },
  { id: "reply", label: "Replies" },
  { id: "outreach", label: "Outreach" },
  { id: "digests", label: "Digests" },
];
const kindOf = (p: Post): Exclude<Kind, "all" | "digests"> => (p.kind === "reply" || p.kind === "outreach" ? p.kind : isReply(p) ? "reply" : "post");

function Row({ p, write, busy, note }: { p: Post; write: ReturnType<typeof useSocialScreen>["write"]; busy?: string; note?: ReturnType<typeof useSocialScreen>["note"] }) {
  return (
    <li className="grid min-w-0 gap-1 border-b py-2 text-sm last:border-b-0" data-testid="history-row">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-20 shrink-0 whitespace-nowrap text-xs text-muted-foreground">{dayLabel(p.date)}</span>
        <span className="min-w-0 flex-1 truncate" title={p.title}>
          {p.title}
        </span>
        {/* the details as calm tags, no "·" separators. */}
        <span className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{p.id}</span>
          <span>{p.platform}</span>
          {p.community && <span>{p.community}</span>}
          <span className="tabular-nums">{p.replies} replies</span>
          {p.metrics && <span>{p.metrics}</span>}
          <PostBadge p={p} />
          <OutLink href={p.link}>link</OutLink>
        </span>
      </div>
      {isLive(p) ? (
        <div className="flex flex-wrap items-start gap-2 sm:pl-[5.5rem]">
          <FeedbackBox p={p} write={write} busy={busy} note={note} noteOnClick />
          <PostActions key={`${p.id}:${p.status}`} p={p} write={write} busy={busy} note={note} />
        </div>
      ) : (
        p.feedback && <div className="text-xs text-muted-foreground sm:pl-[5.5rem]">You said: {p.feedback}</div>
      )}
    </li>
  );
}

/** the active insights of this campaign (or of the repo, with no campaign), from data/insights.md. */
export function workingLines(s: Pick<SocialData, "data" | "campaign"> | undefined): SocialInsight[] {
  const code = s?.campaign?.code?.toLowerCase();
  return (s?.data.insights?.lines ?? []).filter((x) => (x.state ?? "").toLowerCase() === "active" && (!x.campaign || !code || x.campaign.toLowerCase() === code));
}

/**
 * "What's working", the Reporter's weekly insights pass
 * (data/insights.md), as the console's fold list with a count (L-39): folded shows the header only; open, one line each
 * (insight, its confidence), the use and evidence on hover.
 */
export function WhatsWorking({ s }: { s: SocialData | undefined }) {
  const lines = workingLines(s);
  const [open, setOpen] = useSectionOpen("history-whats-working", true);
  const since = lines.map((x) => x.since ?? "").sort().at(-1);
  return (
    <section className="rounded-lg border px-3 py-2" data-testid="whats-working">
      <button type="button" className="flex w-full items-center gap-1.5 text-left text-sm font-medium" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        What's working · {lines.length} active
        <span className="font-normal text-muted-foreground">· Reporter, weekly{since ? ` · ${since}` : ""}</span>
      </button>
      {open && (
        <ul className="mt-1 grid max-h-48 gap-0 overflow-y-auto text-sm" data-testid="whats-working-list">
          {lines.length === 0 ? (
            <li className="py-1 text-muted-foreground">Nothing yet: the Reporter's weekly pass writes it from the numbers we can read (data/insights.md).</li>
          ) : (
            lines.map((x) => (
              <li key={x.id ?? x._line} className="flex min-w-0 items-center gap-2 border-b py-1 last:border-b-0" title={[x.use && `Use: ${x.use}`, x.evidence && `Evidence: ${x.evidence}`].filter(Boolean).join("\n")}>
                <span className="shrink-0 text-xs text-muted-foreground">{x.id}</span>
                <span className="min-w-0 flex-1 truncate">{x.insight}</span>
                {x.confidence && <span className="shrink-0 text-xs text-muted-foreground">{x.confidence}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  );
}

export function HistoryPage() {
  const { social, error, write, busy, note } = useSocialScreen();
  const [kind, setKind] = useState<Kind>("all");
  const [limit, setLimit] = useListLimit("history");
  // Digests holds the 20:00 daily digest and the weekly report.
  const [digest, setDigest] = useState<"daily" | "weekly">("daily");
  const all = useMemo(() => postsOf(social?.data), [social]);
  // Newest first; pulled rows stay listed (the row keeps its link, marked pulled).
  const gone = all.filter((p) => isLive(p) || p.status === "pulled").reverse();
  const rows = gone.filter((p) => kind === "all" || kindOf(p) === kind);
  const live = gone.filter(isLive);
  const shown = limitList(rows, limit);

  return (
    <SocialScreen title="History" intro="Everything we posted, with its link, numbers and your feedback." social={social} error={error}>
      {() => (
        <div className="grid gap-3">
          <WhatsWorking s={social} />
          <WriteNoteLine note={note && rows.some((p) => isLive(p) && (note.scope === p.id || note.scope === `${p.id}#feedback`)) ? undefined : note} />
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind">
              {KINDS.map((k) => (
                <Button key={k.id} size="sm" variant={kind === k.id ? "default" : "outline"} onClick={() => setKind(k.id)}>
                  {k.label}
                </Button>
              ))}
            </div>
            <div className="text-sm text-muted-foreground" data-testid="history-summary">
              {live.filter((p) => kindOf(p) === "post").length} posts · {live.filter((p) => kindOf(p) !== "post").length} replies and outreach ·{" "}
              {live.reduce((n, p) => n + p.replies, 0)} replies we got · {gone.length - live.length} pulled
            </div>
            {kind !== "digests" && <LimitControl limit={limit} onChange={setLimit} total={rows.length} testId="history" />}
          </div>
          {kind === "digests" ? (
            <div className="grid gap-3">
              <div className="flex gap-1.5" role="group" aria-label="Digest" data-testid="digest-view">
                {(["daily", "weekly"] as const).map((v) => (
                  <Button key={v} size="sm" variant={digest === v ? "default" : "outline"} aria-pressed={digest === v} onClick={() => setDigest(v)}>
                    {v === "daily" ? "Daily digest" : "Weekly report"}
                  </Button>
                ))}
              </div>
              {digest === "daily" ? <DigestPage /> : <ReportPage />}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState tone="later" title="Nothing posted yet" detail="Each post shows here once it is live, with its link, its numbers and your feedback." testId="history-empty" />
          ) : (
            <ListPane shown={shown.length} total={rows.length} testId="history" className="gap-0 rounded-lg border px-3">
              {shown.map((p) => (
                <Row key={p.id} p={p} write={write} busy={busy} note={note} />
              ))}
            </ListPane>
          )}
        </div>
      )}
    </SocialScreen>
  );
}
