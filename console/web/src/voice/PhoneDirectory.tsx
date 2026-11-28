import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookUser, Phone } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { topObjectives, useGoalSets } from "@/components/goalRing";
import { campaignMilestones, useCampaigns } from "@/lib/campaign";
import { useSharedQuery } from "@/lib/data";
import { scorecardHref } from "@/lib/scorecards";
import { useSkin } from "@/lib/skin";
import { cn } from "@/lib/utils";
import { fullName, shortName, TEAM_DESK_PARTNER } from "./whoAnswers";
import type { ScorecardNode } from "@/api/pursuit-types";

/**
 * His phone directory (the owner, 28 Nov: "a phone directory on the top left-hand side. And when I press it, I
 * just get all the people that I can call, and I can call the board ... about objectives and key results. Or I can call
 * the campaign managers ... all the phone calls are there"). One button at the top left of the top bar, in both products:
 *
 *   [📖] ──▶ The board            Team desk partner          /chat?call=partner          (every objective and key result)
 *            1 Buy a house        manager of House: Buy …    /sets/<id>?call=1           (the team skin: each objective, his order)
 *            …                                               /milestones/<id>?tab=chat&call=1  (the social skin: each campaign)
 *
 * One tap opens that level's own page with its call starting (the same call routes and call bar as its own Call button,
 * never a second call system), and each call opens prepared on its own status and our proposal (server voice/prepared.ts).
 * Shown only where calls can start (the board's call state says available).
 */
export type DirectoryEntry = { key: string; title: string; who: string; about?: string; light?: string; href: string };

export const BOARD_ENTRY: DirectoryEntry = { key: "board", title: "The board", who: TEAM_DESK_PARTNER, about: "Every objective and key result", href: "/chat?call=partner" };

const withCall = (href: string) => `${href}${href.includes("?") ? "&" : "?"}call=1`;
const managerOf = (name: string) => `${shortName(name)} manager`;

/** the objectives' lines, in his order (the sidebar's own list: folded ones live inside the one they joined; parked ones have no one on call). */
export function objectiveEntries(nodes: ScorecardNode[] | undefined): DirectoryEntry[] {
  return topObjectives(nodes)
    .filter((n) => n.kind === "pursuit" && !n.parked)
    .map((n) => ({ key: n.id, title: fullName(n.name), who: managerOf(n.name), about: n.total ? `${n.greens} of ${n.total} key results green` : "No key results yet", ...(n.state ? { light: n.state } : {}), href: withCall(scorecardHref(n.id)) }));
}

/** the campaigns' lines, in the sidebar's order. */
export function campaignEntries(ms: { id: string; title: string }[]): DirectoryEntry[] {
  return ms.map((m) => ({ key: m.id, title: fullName(m.title), who: managerOf(m.title), href: withCall(`/milestones/${encodeURIComponent(m.id)}?tab=chat`) }));
}

const DOT: Record<string, string> = { green: "bg-emerald-600", amber: "bg-amber-500", red: "bg-red-600" };

export function DirectoryList({ entries, onPick }: { entries: DirectoryEntry[]; onPick?: () => void }) {
  return (
    <ol className="grid gap-1.5" data-testid="directory-list">
      {entries.map((e, i) => (
        <li key={e.key} className="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2" data-testid="directory-entry">
          <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{e.key === "board" ? "" : i}</span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="directory-title">
              {e.light && <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[e.light] ?? "bg-muted-foreground/40")} />}
              {e.title}
            </span>
            <span className="text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]" data-testid="directory-who">
              {e.who}
              {e.about ? ` · ${e.about}` : ""}
            </span>
          </span>
          <Button asChild size="sm" className="h-11 shrink-0 gap-1.5 rounded-full bg-emerald-600 px-4 text-white hover:bg-emerald-700" data-testid="directory-call">
            <Link to={e.href} onClick={onPick} aria-label={`Call the ${e.who}`}>
              <Phone className="h-4 w-4" /> Call
            </Link>
          </Button>
        </li>
      ))}
    </ol>
  );
}

/** the button at the top left and its sheet. */
export function PhoneDirectory() {
  const [open, setOpen] = useState(false);
  const [can, setCan] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch("/api/voice/coach/state")
      .then((r) => (r.ok ? r.json() : undefined))
      .then((s: { available?: boolean } | undefined) => live && setCan(!!s?.available))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const campaigns = !!useSkin().campaigns;
  const sets = useGoalSets();
  const { data: camps } = useCampaigns();
  const { data: ms } = useSharedQuery("sb:milestones", () => api.listMilestones());
  if (!can) return null;
  const levels = campaigns ? campaignEntries(campaignMilestones(camps?.campaigns, ms)) : objectiveEntries(sets.data?.nodes);
  const entries = [BOARD_ENTRY, ...levels];
  return (
    <>
      <Button variant="ghost" size="icon" className="shrink-0" aria-label="Phone directory: everyone you can call" title="Phone directory" onClick={() => setOpen(true)} data-testid="topbar-directory">
        <BookUser className="h-5 w-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-[26rem] max-w-[100vw] flex-col gap-3 overflow-y-auto px-3 pt-[calc(env(safe-area-inset-top)+1rem)]" data-testid="directory-sheet" aria-describedby={undefined}>
          <div className="grid gap-0.5 pr-8">
            <SheetTitle className="text-base font-semibold">Phone directory</SheetTitle>
            <p className="text-xs text-muted-foreground" data-testid="directory-count">
              {entries.length} calls, in your order. Each opens on where it stands and our proposal.
            </p>
          </div>
          <DirectoryList entries={entries} onPick={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
