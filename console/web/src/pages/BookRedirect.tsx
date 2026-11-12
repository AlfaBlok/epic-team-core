import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { DECK_ALL_PATH, DECK_PATH } from "@/lib/deck";
import { ErrorBox, Loading } from "@/components/common";

/**
 * every old Epic Book URL leads to the deck.
 * `/book` opens the decks; `/book?repo=…`, `/book?show=…` and `/book#capabilities` open "Every epic" (`/deck/all`, the
 * old index, kept whole); `/book/<milestone>` opens the deck of that milestone's spine, and its `#<section>` the slide of
 * the same name (`#where`, an ask's link), or `#<EPIC-n>` (`#epic:<file name>`) that epic's own deck (a review card's goal
 * link, a milestone page's Epic deck on one of its epics).
 */
export function BookIndexRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={search || hash ? `/${DECK_ALL_PATH}${search}${hash}` : `/${DECK_PATH}`} replace />;
}

const CODE = /^(EPIC-\d+[A-Za-z]?|M\d+)$/i;

/** Where `/book/<key>#<hash>` leads, given the deck of the milestone's spine (`/deck/<repo>/<code>`). */
export function deckTarget(href: string, hash: string): string {
  let h = hash.replace(/^#/, "");
  try {
    h = decodeURIComponent(h);
  } catch {
    // keep the raw hash
  }
  if (!h) return href;
  // `#epic:<file name>`, the deck of a spine with no EPIC-n code (round 2; round 3 links open the Deck tab instead).
  if (h.startsWith("epic:") && h.length > 5) return `${href.replace(/\/[^/]+$/, "")}/${encodeURIComponent(h.slice(5))}`;
  if (CODE.test(h)) return `${href.replace(/\/[^/]+$/, "")}/${encodeURIComponent(h.toUpperCase())}`;
  return `${href}?slide=${encodeURIComponent(h)}`;
}

export function BookToDeck() {
  const { key = "" } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () =>
      api
        .deckOf(key)
        .then((r) => {
          if (!alive) return;
          if (r.href) navigate(deckTarget(r.href, hash), { replace: true });
          else timer = setTimeout(go, 3_000); // the decks are still being built
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e : new Error(String(e))));
    void go();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, hash, navigate]);
  if (error) return <ErrorBox error={error} />;
  return <Loading />;
}
