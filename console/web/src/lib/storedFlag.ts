import { useState } from "react";
import { useLocation } from "react-router-dom";

/** a fold open or closed, kept in this browser's localStorage under `key` (default closed). */
export function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return [
    v,
    (next: boolean) => {
      setV(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* storage off: the toggle still works for this page */
      }
    },
  ];
}

/**
 * a sidebar fold (Tools, Settings, Other goals) that opens by itself while the page shown is one of its own
 * (`auto`), yet always answers a press (on the Gap finder page Tools was held open by the page, so
 * pressing it did nothing). A press is the owner's word for this page: it wins until he moves to another page,
 * and it is kept in this browser's localStorage under `key` as the fold's default.
 */
export function useFold(key: string, auto: boolean): [boolean, () => void] {
  const [stored, setStored] = useStoredFlag(key);
  const { pathname } = useLocation();
  const [pressed, setPressed] = useState<{ at: string; open: boolean } | null>(null);
  const shown = pressed && pressed.at === pathname ? pressed.open : stored || auto;
  return [
    shown,
    () => {
      setPressed({ at: pathname, open: !shown });
      setStored(!shown);
    },
  ];
}

/**
 * the sidebar's one Voice notes entry (the owner's yes to the sidebar mock-up: "Your voice notes and Voice
 * notes become one"): a page he pinned by a name ending in "voice notes" folds into it, linked from the Voice notes page.
 */
export const isVoiceNotesPin = (p: { name?: string }) => /voice notes$/i.test((p.name ?? "").trim());
