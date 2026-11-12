import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/common";
import type { SocialData } from "@/api/types";
import { useSocialScreen } from "@/lib/useSocialWrite";
import { addDays, initialWeek, placeByDay, postsOf } from "@/lib/social";
import { dayLabel, PostBadge, SocialScreen } from "@/pages/social/parts";
import { socialHref } from "@/pages/social/nav";

/**
 * the week calendar over the world's posts, read from the pack export.:
 * the approval inbox is gone (C1, no gate): nothing waits for you; held posts and text edits live on the Pipeline.
 */
export function CalendarPage() {
  const { social, error, repo } = useSocialScreen();
  return (
    <SocialScreen title="Calendar" intro="Drafts and posts by day. Nothing waits for you: held posts and text edits are on the Pipeline." social={social} error={error}>
      {(s) => <WeekView social={s} pipelineHref={socialHref("pipeline", repo)} />}
    </SocialScreen>
  );
}

/** the week calendar, also the Pipeline's Week view on a campaign (mockup note 5; was only this page). */
export function WeekView({ social, sources, pipelineHref }: { social?: SocialData; sources?: { repo: string; campaign?: string; social: SocialData }[]; pipelineHref?: string }) {
  // the all-campaigns Pipeline's Week view: every campaign's posts, keyed by repo (post ids repeat across campaigns).
  const posts = useMemo(
    () => (sources ? sources.flatMap((s) => postsOf(s.social.data).map((p) => ({ ...p, id: `${s.repo}|${p.id}`, campaign: s.campaign }))) : postsOf(social?.data).map((p) => ({ ...p, campaign: undefined as string | undefined }))),
    [social, sources],
  );
  const [week, setWeek] = useState<string>();
  const start = week ?? initialWeek(posts, new Date().toISOString().slice(0, 10));
  const days = placeByDay(posts, start);
  return (
    <section className="grid gap-3" aria-label="Week">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold" data-testid="week-label">
          Week of {dayLabel(start)}
        </h2>
        {pipelineHref && (
          <Link to={pipelineHref} className="text-sm underline">
            Pipeline
          </Link>
        )}
        <Button size="icon" variant="outline" aria-label="Previous week" onClick={() => setWeek(addDays(start, -7))}>
          <ChevronLeft />
        </Button>
        <Button size="icon" variant="outline" aria-label="Next week" onClick={() => setWeek(addDays(start, 7))}>
          <ChevronRight />
        </Button>
      </div>
      {posts.length === 0 && <Empty>No posts yet.</Empty>}
      <div className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-7">
        {days.map((d) => (
          <div key={d.date} className="min-w-0 rounded-lg border p-2" data-testid={`day-${d.date}`}>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{dayLabel(d.date)}</div>
            {d.posts.length === 0 && <div className="text-xs text-muted-foreground/60">nothing</div>}
            <div className="grid gap-1.5">
              {d.posts.map((p) => (
                <div key={p.id} className="min-w-0 rounded-md bg-muted/50 p-1.5 text-xs" data-testid="day-post">
                  <div className="flex flex-wrap items-center gap-1">
                    <PostBadge p={p} />
                    <span className="truncate text-muted-foreground">
                      {p.campaign ? `${p.campaign} · ` : ""}
                      {p.platform.replace(/\s*\(.*$/, "")}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 break-words">{p.title}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
