import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * The owner: the Inbox button opens the Inbox with every section folded, at the top; Back (from a card's page, a link it
 * opened) returns to the same open sections and the same scroll place. Each visit is one history entry
 * (location.key); its open folds and scroll are kept in sessionStorage under that key while he is on it. Arriving by
 * Back (POP) restores them once the sections are drawn; arriving any other way (the Inbox button, a link) lands folded
 * at the top, and a press on the Inbox button while already there folds everything and goes to the top again.
 */
const STORE = "inbox.place.";
type Saved = { open: Record<string, boolean>; y: number };

function read(key: string): Saved | undefined {
  try {
    const raw = window.sessionStorage.getItem(STORE + key);
    return raw ? (JSON.parse(raw) as Saved) : undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, v: Saved) {
  try {
    window.sessionStorage.setItem(STORE + key, JSON.stringify(v));
  } catch {
    /* storage off: Back lands folded */
  }
}

/** the Inbox button's navigation state: pressed, even on the Inbox itself (a same-page link replaces), it lands folded at the top. */
export const INBOX_LAND = { land: true } as const;

/** how long Back waits for the sections to draw before giving up on the scroll place. */
export const RESTORE_WAIT_MS = 10_000;

export function useInboxPlace(drawnSelector = '[data-testid="inbox-stack"][data-ready="yes"]') {
  const loc = useLocation();
  const nav = useNavigationType();
  // a new visit (not Back, not a filter's replace) remounts the sections folded
  const [visit, setVisit] = useState(loc.key);
  const first = useRef(true);
  const saved = useRef<Saved>({ open: {}, y: 0 });
  const [restored, setRestored] = useState<Record<string, boolean> | undefined>(() => {
    if (nav !== "POP") return undefined;
    const s = read(loc.key);
    if (s) saved.current = s;
    return s?.open;
  });
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (nav !== "POP") window.scrollTo(0, 0);
      return;
    }
    if (nav === "PUSH" || (nav !== "POP" && (loc.state as { land?: boolean } | null)?.land)) {
      saved.current = { open: {}, y: 0 };
      setRestored(undefined);
      setVisit(loc.key);
      window.scrollTo(0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.key]);
  // keep the place of this visit while he is on it
  useEffect(() => {
    const key = loc.key;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        saved.current = { ...saved.current, y: Math.round(window.scrollY) };
        write(key, saved.current);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [loc.key]);
  // Back: once the sections are drawn (with the restored folds open), go to where he was
  useEffect(() => {
    if (nav !== "POP" || !restored) return;
    const y = saved.current.y;
    if (!y) return;
    const until = Date.now() + RESTORE_WAIT_MS;
    let raf = 0;
    const tick = () => {
      if (document.querySelector(drawnSelector)) return void requestAnimationFrame(() => window.scrollTo(0, y));
      if (Date.now() < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);
  const place = useMemo(
    () => ({
      restored,
      record: (fold: string, open: boolean) => {
        saved.current = { ...saved.current, open: { ...saved.current.open, [fold]: open } };
        write(loc.key, saved.current);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [restored, visit],
  );
  return { visit, place };
}
