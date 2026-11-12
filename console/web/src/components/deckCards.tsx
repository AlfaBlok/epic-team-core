import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type DeckCard } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { DECK_PATH } from "@/lib/deck";
import { Button } from "@/components/ui/button";
import { FoldSection, useSectionOpen } from "@/components/homeSection";

/**
 * "Epic decks changed" on the Team home. One card per high-level epic whose deck changed
 * materially (a goal met, a new question for the owner, an epic under it finished…), at most one per deck per day: each is the
 * deck's newest line in docs/status/deck-updates.md (the repo is the source, L-45, L-46). Open deck goes to the deck;
 * Seen writes `· seen <date>` on the line, spinning at the button (L-38). Folds with its count (L-39); nothing renders
 * when no deck changed.
 */
export function DeckCards() {
  const { data, error } = useQuery(() => api.listDeckCards(), [], { tag: "inbox" });
  const [open, setOpen] = useSectionOpen("deck-cards", true);
  const cards = data?.cards ?? [];
  if (error || !cards.length) return null;
  return (
    <FoldSection
      title="Epic decks changed"
      count={cards.length}
      testId="deck-cards"
      open={open}
      onToggle={setOpen}
      meta={
        <Link to={`/${DECK_PATH}`} className="text-xs text-muted-foreground underline">
          All decks
        </Link>
      }
    >
      <ul className="grid gap-2" data-testid="deck-cards-list">
        {cards.map((c) => (
          <DeckCardLine key={`${c.ref.repo}/${c.ref.code}/${c.date}`} c={c} />
        ))}
      </ul>
    </FoldSection>
  );
}

function DeckCardLine({ c }: { c: DeckCard }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const seen = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await mutate(() => api.deckCardSeen({ ...c.ref, date: c.date }), "inbox");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <li className="grid min-w-0 gap-1 rounded-lg border bg-card px-3 py-2" data-testid="deck-card">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Link to={c.href} className="min-w-0 truncate font-medium hover:underline">
          {c.title}
        </Link>
        <span className="text-xs text-muted-foreground">
          {c.ref.code} · {new Date(`${c.date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}
          {c.goals.total ? ` · ${c.goals.met} of ${c.goals.total} goals met` : ""}
        </span>
      </div>
      <p className="text-sm">{c.text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to={c.href} data-testid="deck-card-open">
            Open deck
          </Link>
        </Button>
        <Button size="sm" variant="outline" pending={busy} pendingLabel="Marking…" disabled={busy} onClick={seen} data-testid="deck-card-seen">
          Seen
        </Button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </li>
  );
}
