import { useState } from "react";
import { api, type Milestone } from "@/api";
import type { CampaignBriefing } from "@/api/campaign-types";
import { inline } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { FoldChevron } from "@/components/foldChevron";

/**
 * The owner's morning briefing is also kept on its campaign: open the campaign and see its key results, its Plan and
 * the latest daily briefing, older ones one tap away. Read from the talk's own record (GET …/campaigns/:mid/briefings),
 * in its three parts: yesterday, today, open questions; the owner's answer under it when given one. A campaign with no talk yet says so in one quiet line.
 */
export function DailyBriefingPanel({ m }: { m: Milestone }) {
  const { data, error } = useQuery(async () => api.getCampaignBriefings(await worldId(), m.id), [m.id]);
  const [open, setOpen] = useState(false);
  if (error || !data) return null;
  if (!data.latest)
    return (
      <p className="max-w-4xl text-xs text-muted-foreground" data-testid="briefing-none">
        No morning briefing for this campaign yet.
      </p>
    );
  return (
    <section className="grid max-w-4xl gap-3 rounded-lg border bg-card p-4" data-testid="daily-briefing">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold">
        Morning briefing
        <span className="text-sm font-normal text-muted-foreground">{dayLabel(data.latest.day)}</span>
      </h2>
      <BriefingBody b={data.latest} />
      {data.older.length > 0 && (
        <div className="grid gap-2 border-t pt-3">
          <button type="button" className="justify-self-start text-sm text-primary underline-offset-4 hover:underline" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="briefing-older-toggle">
            <FoldChevron open={open} className="mr-1.5" />
            {open ? "Hide older briefings" : `Older briefings (${data.older.length})`}
          </button>
          {open && (
            <div className="grid gap-2" data-testid="briefing-older">
              {data.older.map((b) => (
                <details key={b.day} className="rounded-md border px-3 py-2" data-testid="briefing-older-day">
                  <summary className="cursor-pointer text-sm font-medium">{dayLabel(b.day)}</summary>
                  <div className="mt-2">
                    <BriefingBody b={b} />
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function BriefingBody({ b }: { b: CampaignBriefing }) {
  const split = b.yesterday || b.today;
  return (
    <div className="grid gap-2 text-sm [overflow-wrap:anywhere]">
      {split ? (
        <>
          {b.yesterday && <Part label="Yesterday" text={b.yesterday} />}
          {b.today && <Part label="Today" text={b.today} />}
        </>
      ) : (
        b.text && <p>{inline(b.text)}</p>
      )}
      {b.questions.map((q, i) => (
        <Part key={i} label={b.questions.length > 1 ? `Open question ${i + 1}` : "Open question"} text={q} />
      ))}
      {b.answers.map((a, i) => (
        <div key={i} className="grid gap-0.5" data-testid="briefing-answer">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Your answer</span>
          <p className="border-l-2 pl-3 text-muted-foreground">{inline(a.text)}</p>
        </div>
      ))}
    </div>
  );
}

function Part({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3" data-testid="briefing-part">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:pt-0.5">{label}</span>
      <p>{inline(text)}</p>
    </div>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2026-11-18` → `Wed 18 Nov`, read as a calendar day (no time zone shift). */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
