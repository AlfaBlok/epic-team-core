import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { Card, CardContent } from "@/components/ui/card";
import { useShows } from "@/lib/skin";

/**
 * one line on the Team home, under
 * what blocks on him, saying how many tester applications he has not opened yet, linking /testers (opening it clears
 * the count). With none new it still names the total, so the way to the list is always on the page.
 */
export function NewApplications() {
  const shows = useShows();
  const on = shows("testers");
  // Another world's skin has no Testers screen (the route is the home world's): no call at all there.
  const { data, error } = useQuery(() => (on ? api.listTesters() : Promise.resolve(undefined)), [on], { tag: "inbox" });
  if (!on || error || !data) return null;
  const n = data.newCount ?? data.signups.filter((s) => !s.seenAt && (s.offer || "tester-10").includes("tester-10")).length;
  // the same count as the Applications tracker (the team's own tests left out) when the server gives it.
  const total = data.counted ?? data.signups.filter((s) => (s.offer || "tester-10").includes("tester-10")).length;
  return (
    <section className="mb-6" data-testid="new-applications">
      {/* /testers opens the Applications tracker on its objective; opening it here clears the new count. */}
      <Link to="/testers" className="group block" onClick={() => void api.markTestersSeen().catch(() => undefined)}>
        <Card className={n ? "border-emerald-600/60 transition-colors group-hover:border-emerald-600" : "transition-colors group-hover:border-foreground/20"}>
          <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4 text-sm">
            <Users className="h-4 w-4 shrink-0" />
            <span className="font-medium" data-testid="new-applications-count">
              {n ? `${n} new application${n === 1 ? "" : "s"}` : "No new applications"}
            </span>
            <span className="text-muted-foreground">
              {total} application{total === 1 ? "" : "s"} in all, the team's own tests left out · open the Applications tracker
            </span>
          </CardContent>
        </Card>
      </Link>
    </section>
  );
}
