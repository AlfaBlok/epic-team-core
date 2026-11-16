import { useState } from "react";

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
 * the sidebar's one Voice notes entry (the owner's yes to the sidebar mock-up: "Your voice notes and Voice
 * notes become one"): a page he pinned by a name ending in "voice notes" folds into it, linked from the Voice notes page.
 */
export const isVoiceNotesPin = (p: { name?: string }) => /voice notes$/i.test((p.name ?? "").trim());
