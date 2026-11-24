import type { CampaignCard, CampaignChannel } from "@/api/campaign-types";
import { useDrawWidth } from "@/components/wheelPlan";
import { cn } from "@/lib/utils";

/**
 * the campaign roll-up (the owner: "which is the account, which is the channel. Is the authentication green for that
 * channel? … aggregate up to that lane the views, the replies, the impressions"), one box per channel: the account and whether its
 * sign-in is green, the cadence and what we post, what it counts toward, and the summed views, likes and replies of the
 * campaign's live posts there with the change since the last recorded day. `compact`: one line per channel (Team home).
 */
const DOT: Record<CampaignChannel["signIn"]["state"], string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  grey: "bg-muted-foreground/40",
};
const WORD: Record<CampaignChannel["signIn"]["state"], string> = { green: "Sign-in green", amber: "Sign-in not checked", red: "Signed out", grey: "Sign-in unknown" };

const fmt = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString("en-US") : "–");
function Delta({ v }: { v: number | null | undefined }) {
  if (typeof v !== "number") return null;
  return (
    <span className={cn("ml-1 text-[11px] font-medium", v > 0 ? "text-emerald-700 dark:text-emerald-400" : v < 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground")}>
      {v > 0 ? `▲ ${fmt(v)}` : v < 0 ? `▼ ${fmt(-v)}` : "±0"}
    </span>
  );
}

/** Tiny bars of the recorded days (views, else likes), oldest first. */
function Spark({ ch }: { ch: CampaignChannel }) {
  const key = ch.history.some((d) => typeof d.views === "number") ? "views" : "likes";
  const vals = ch.history.map((d) => (typeof d[key] === "number" ? (d[key] as number) : 0));
  if (vals.length < 2) return null;
  const max = Math.max(1, ...vals);
  return (
    <span className="flex h-5 items-end gap-px" aria-label={`${key} per day, last ${vals.length} days`} title={ch.history.map((d) => `${d.date}: ${fmt(d[key])} ${key}`).join("\n")} data-testid="channel-spark">
      {vals.map((v, i) => (
        <span key={i} className="w-1.5 rounded-sm bg-emerald-600/70" style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }} />
      ))}
    </span>
  );
}

function Stat({ label, v, d, none }: { label: string; v: number | null | undefined; d?: number | null; none?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {typeof v === "number" ? (
        <div className="text-lg font-semibold leading-6 tabular-nums">
          {fmt(v)}
          <Delta v={d} />
        </div>
      ) : (
        <div className="text-xs leading-6 text-muted-foreground">{none ?? "not read yet"}</div>
      )}
    </div>
  );
}

export function CampaignChannels({ card, compact = false }: { card: CampaignCard; compact?: boolean }) {
  const chs = card.channels;
  if (!chs?.length) return null;
  const metric = card.goal?.metric;
  const by = metric?.by ? new Date(`${metric.by.slice(0, 10)}T12:00:00Z`) : null;
  const byWord = by && !Number.isNaN(by.getTime()) ? ` by ${by.getUTCDate()} ${by.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}` : "";
  const measure = metric ? `${metric.target} ${metric.label}${byWord}` : null;
  if (compact)
    return (
      <div className="grid gap-0.5" data-testid="campaign-channels-compact">
        {chs.map((ch) => (
          <div key={ch.key} className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={ch.signIn.line}>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[ch.signIn.state])} aria-label={WORD[ch.signIn.state]} />
            <span className="min-w-0 truncate">
              <span className="text-foreground">{ch.name}</span>
              {ch.account ? ` ${ch.account}` : ""} · {ch.posts} post{ch.posts === 1 ? "" : "s"}
              {ch.totals && typeof ch.totals.views === "number" ? ` · ${fmt(ch.totals.views)} views` : ""}
              {ch.totals ? ` · ${fmt(ch.totals.likes)} likes · ${fmt(ch.totals.replies)} replies` : ""}
            </span>
          </div>
        ))}
      </div>
    );
  return (
    <section className="mb-4 grid gap-2" data-testid="campaign-channels" aria-label="Channels">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-sm font-semibold">Channels</h2>
        <span className="text-xs text-muted-foreground">Counts sum the campaign's live posts on each channel. Change is since the last recorded day.</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {chs.map((ch) => (
          <div key={ch.key} className="grid min-w-0 content-start gap-2 rounded-lg border bg-card p-3 text-sm" data-testid={`channel-${ch.key}`}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-semibold">{ch.name}</span>
                <span className="ml-1.5 text-muted-foreground">{ch.account ?? "no account named"}</span>
              </div>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
                  ch.signIn.state === "green" && "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
                  ch.signIn.state === "amber" && "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
                  ch.signIn.state === "red" && "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
                )}
                title={ch.signIn.line}
                data-testid="channel-signin"
                data-state={ch.signIn.state}
              >
                <span className={cn("h-2 w-2 rounded-full", DOT[ch.signIn.state])} aria-hidden />
                {WORD[ch.signIn.state]}
              </span>
            </div>
            <div className="text-xs text-muted-foreground" data-testid="channel-signin-line">{ch.signIn.line}</div>
            <dl className="grid gap-1 text-xs">
              <div className="grid grid-cols-[5.5rem_1fr] gap-2">
                <dt className="text-muted-foreground">Cadence</dt>
                <dd className="line-clamp-3 min-w-0" title={ch.cadence ?? undefined}>{ch.cadence ?? <span className="text-muted-foreground">not in the plan yet</span>}</dd>
              </div>
              <div className="grid grid-cols-[5.5rem_1fr] gap-2">
                <dt className="text-muted-foreground">Objective</dt>
                <dd className="line-clamp-3 min-w-0" title={ch.what ?? card.goal?.sentence ?? undefined}>{ch.what ?? card.goal?.sentence ?? <span className="text-muted-foreground">not in the plan yet</span>}</dd>
              </div>
              <div className="grid grid-cols-[5.5rem_1fr] gap-2">
                <dt className="text-muted-foreground">Metric</dt>
                <dd className="min-w-0">{measure ?? <span className="text-muted-foreground">no metric set</span>}</dd>
              </div>
            </dl>
            <div className="grid grid-cols-3 gap-2 border-t pt-2" data-testid="channel-totals">
              <Stat label="Views" v={ch.totals?.views} d={ch.trend?.views} none={ch.key === "reddit" ? "Reddit shows none" : ch.posts === 0 ? "no post yet" : ch.totals ? "none shown" : undefined} />
              <Stat label="Likes" v={ch.totals?.likes} d={ch.trend?.likes} none={ch.posts === 0 ? "no post yet" : undefined} />
              <Stat label="Replies" v={ch.totals?.replies} d={ch.trend?.replies} none={ch.posts === 0 ? "no post yet" : undefined} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span data-testid="channel-read-line">
                {ch.posts} post{ch.posts === 1 ? "" : "s"} live{ch.replyRows ? `, ${ch.replyRows} of our replies` : ""} · {ch.readLine}
                {ch.trend ? ` · change since ${ch.trend.since.slice(5)}` : " · no earlier day yet"}
              </span>
              <Spark ch={ch} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const STRIP_FILL: Record<CampaignChannel["signIn"]["state"], string> = {
  green: "fill-emerald-600",
  amber: "fill-amber-500",
  red: "fill-red-600",
  grey: "fill-muted-foreground/40",
};
const STRIP_WORD: Record<CampaignChannel["signIn"]["state"], string> = { green: "signed in", amber: "not checked", red: "signed out", grey: "unknown" };

/**
 * The social kit drawn (the card check, rule 7): the campaign's channels as stops on one line, each dot coloured by
 * its sign-in and its post count under the name. The accounts, cadence and counts open under it.
 */
export function ChannelStrip({ card }: { card: CampaignCard }) {
  const chs = card.channels ?? [];
  const [ref, width] = useDrawWidth();
  if (!chs.length) return null;
  const step = width / chs.length;
  const x = (i: number) => Math.round(step * i + step / 2);
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg width={width} height={74} viewBox={`0 0 ${width} 74`} role="img" className="block max-w-full" data-testid="channel-strip" aria-label={chs.map((c) => `${c.name}: ${STRIP_WORD[c.signIn.state]}, ${c.posts} posts`).join(". ")}>
        {chs.length > 1 && <line x1={x(0)} x2={x(chs.length - 1)} y1={12} y2={12} className="stroke-border" strokeWidth={2} />}
        {chs.map((c, i) => (
          <g key={c.key} data-testid="channel-stop" data-state={c.signIn.state}>
            <circle cx={x(i)} cy={12} r={9} className={STRIP_FILL[c.signIn.state]} />
            <text x={x(i)} y={42} textAnchor="middle" fontSize={13} fontWeight={600} className="fill-foreground">
              {c.name}
            </text>
            <text x={x(i)} y={60} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
              {`${STRIP_WORD[c.signIn.state]} · ${c.posts} posts`}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
