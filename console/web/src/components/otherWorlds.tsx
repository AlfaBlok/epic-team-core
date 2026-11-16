import { useState } from "react";
import { useSlotReady } from "@/components/slot";
import { ExternalLink } from "lucide-react";
import { api } from "@/api";
import type { WorldInbox, WorldItem } from "@/api/company-types";
import { useQuery } from "@/lib/data";
import { FoldSection, useSectionOpen } from "@/components/homeSection";

/**
 * the owner's social product team lives in its own world (its asks and cards are answered in its own app), so the
 * Inbox never listed them and a whole day of his items held none of them. This band, on top of the Inbox in both
 * skins, lists the open asks and cards of every other product world the login belongs to, read only, each opening in
 * its own app. The list is the server's GET /api/worlds (the world's own routes inside its own scope;
 * nothing here writes or answers).
 */
export const OTHER_WORLDS_SHOWN = 5;

/** the worlds that have something open or could not be read; a world with nothing open says nothing. */
export const worldsToShow = (worlds: WorldInbox[] | undefined) => (worlds ?? []).filter((w) => w.items.length || w.error);

/** asks first (they block), then cards to review; inside each, the higher priority (lower number) first. */
export function orderWorldItems(items: WorldItem[]): WorldItem[] {
  const rank = (i: WorldItem) => (i.kind === "ask" ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || (a.priority ?? 9) - (b.priority ?? 9));
}

/** "2 decisions and 3 cards to review", in plain words. */
export function worldSummary(items: WorldItem[]): string {
  const asks = items.filter((i) => i.kind === "ask").length;
  const cards = items.length - asks;
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : "");
  return [part(asks, "decision", "decisions"), part(cards, "card to review", "cards to review")].filter(Boolean).join(" and ");
}

/** one read shared by the band and the sidebar pill for a minute (the server reads each world's own two lists). */
let shared: { at: number; p: Promise<{ worlds: WorldInbox[] }> } | undefined;
export const forgetOtherWorlds = () => void (shared = undefined);
function readWorlds(): Promise<{ worlds: WorldInbox[] }> {
  if (!api.listCompanyWorlds) return Promise.resolve({ worlds: [] });
  if (!shared || Date.now() - shared.at > 60_000) {
    const p = api.listCompanyWorlds().catch(() => ({ worlds: [] as WorldInbox[] }));
    shared = { at: Date.now(), p };
  }
  return shared.p;
}
export const useOtherWorlds = () => useQuery(readWorlds, []);

/** the violet count beside the Inbox's own red and green: how many of the other worlds' items wait there. */
export function OtherWorldsPill() {
  const { data } = useOtherWorlds();
  const worlds = worldsToShow(data?.worlds);
  const n = worlds.reduce((t, w) => t + w.items.length, 0);
  if (!n) return null;
  const names = worlds.map((w) => w.app).join(", ");
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-violet-600 px-1.5 text-xs font-semibold text-white" title={`${n} waiting on you in ${names}`} aria-label={`${n} waiting on you in ${names}`} data-testid="other-world-pill">
      {n}
    </span>
  );
}

export function OtherWorldsWaiting() {
  const { data, error } = useOtherWorlds();
  useSlotReady(!!data || !!error);
  const worlds = worldsToShow(data?.worlds);
  if (!worlds.length) return null;
  return (
    <>
      {worlds.map((w) => (
        <WorldBand key={w.tenantId} w={w} />
      ))}
    </>
  );
}

/** the phone Home: an item's title without the row or ask code it may start with ("E907-S3 Pattern: …"). */
export function plainItemTitle(t: string): string {
  const s = t.replace(/^(?:[\w.-]+\/)?(?:EPIC-\d+|E\d+)-[A-Z]*\d+\b[:\s]*/, "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : t;
}

function WorldBand({ w }: { w: WorldInbox }) {
  const [all, setAll] = useState(false);
  const items = orderWorldItems(w.items);
  const shown = all ? items : items.slice(0, OTHER_WORLDS_SHOWN);
  // (the owner: "Inbox should have single pattern please - sections you can expand, all look the same"): the
  // other world is one more fold section like every other (chevron, title, count), no violet panel; it opens by
  // itself while something there waits on him.
  const [open, setOpen] = useSectionOpen(`other-world-${w.tenantId}`, true, items.length > 0);
  return (
    <FoldSection
      title={`${w.app} waits on you`}
      count={items.length}
      hideZero
      tone="needs-you"
      testId="other-world"
      open={open}
      onToggle={setOpen}
      meta={
        <a href={w.appUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex min-h-10 items-center gap-1 text-xs font-medium underline-offset-2 hover:underline sm:min-h-0">
          Open {w.app} <ExternalLink className="h-3 w-3" />
        </a>
      }
    >
      {w.error ? (
        <p className="text-sm text-muted-foreground" data-testid="other-world-error">
          {w.app} could not be read just now, so its items are missing here, not zero. Open it to see them.
        </p>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground" data-testid="other-world-summary">
            {worldSummary(items)} in your {w.app} team. Each opens there, where you answer it.
          </p>
          <ul className="grid gap-1.5" data-world={w.tenantId}>
            {shown.map((i) => (
              <li key={i.key} data-testid="other-world-item" data-kind={i.kind}>
                <a href={i.openUrl} target="_blank" rel="noreferrer" className="flex min-h-11 min-w-0 items-baseline gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted">
                  <span className="shrink-0 text-xs font-semibold">{i.kind === "ask" ? "Decide" : "Review"}</span>
                  {/* the phone Home: two lines on a phone, never cut mid-word, and no leading row code. */}
                  <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]" title={i.title}>
                    {plainItemTitle(i.title)}
                  </span>
                  {i.project && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{i.project}</span>}
                </a>
              </li>
            ))}
          </ul>
          {items.length > OTHER_WORLDS_SHOWN && (
            <button type="button" className="mt-1 min-h-10 text-xs font-medium underline-offset-2 hover:underline" onClick={() => setAll(!all)} data-testid="other-world-more">
              {all ? "Show fewer" : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </FoldSection>
  );
}
