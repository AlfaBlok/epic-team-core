import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type InboxSearchResult, type WaitingItem } from "@/api";
import { useGoalShown, useShownGoals, type GoalInput } from "@/lib/goalFilter";

/**
 * the owner, 2026-11-12 21:17Z: a search box on top of the Inbox; typing a word filters every section
 * (blocked, review, done) at once. The server finds the matching items (GET /api/inbox/search: titles, card text,
 * his answers, feedback and voice notes); each section keeps only its items the search names. Outside the Inbox
 * (no provider) nothing is filtered.
 */
export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_MIN = 2;

export interface InboxSearchState {
  /** what he typed. */
  text: string;
  setText: (t: string) => void;
  /** a search is on (two letters or more): the sections show its matches only. */
  active: boolean;
  /** the query the result answers (the typed text, after the short pause). */
  q: string;
  result?: InboxSearchResult;
  error?: Error;
  /** waiting for the server's answer to the current text. */
  searching: boolean;
  /** the item ids that match; undefined while no search is on or its first answer is not in yet. */
  hits?: Set<string>;
  /** done items the Inbox's list does not hold (older than its window), as rows for Answered. */
  rows: WaitingItem[];
  /** he picked goals with the goal labels above the Inbox (not every goal is on). */
  goals: boolean;
  /** a card stays when the search names it (or none is on) and its goal is not hidden: every section reads it. */
  keeps: (i: { id: string } & GoalInput) => boolean;
}

const OFF: InboxSearchState = { text: "", setText: () => {}, active: false, q: "", searching: false, rows: [], goals: false, keeps: () => true };
const Ctx = createContext<InboxSearchState>(OFF);

export function useInboxSearch(): InboxSearchState {
  return useContext(Ctx);
}

/** keep an item when no search is on, or the search names it. */
export function matches(s: Pick<InboxSearchState, "active" | "hits">, id: string): boolean {
  return !s.active || !s.hits || s.hits.has(id);
}

/**
 * E948-S78: the searched text, lower case, for a block that filters on its own words (goals, goal talk, since
 * yesterday): "" when no search is on. Outside the Inbox (no provider) always "".
 */
export function useSearchNeedle(): string {
  const s = useContext(Ctx);
  return s.active ? (s.q || s.text).trim().toLowerCase() : "";
}

/** a block's line stays when no search is on, or one of its words holds the searched text. */
export function saysNeedle(needle: string, ...words: (string | null | undefined)[]): boolean {
  return !needle || words.some((w) => !!w && w.toLowerCase().includes(needle));
}

export function InboxSearchProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [result, setResult] = useState<InboxSearchResult | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const trimmed = text.trim();
  const active = trimmed.length >= SEARCH_MIN;
  const shown = useGoalShown();
  const goals = useShownGoals() !== null;
  useEffect(() => {
    if (!active) {
      setQ("");
      setResult(undefined);
      setError(undefined);
      return;
    }
    const t = setTimeout(() => setQ(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [trimmed, active]);
  useEffect(() => {
    if (!q || !api.searchInbox) return;
    let alive = true;
    api
      .searchInbox(q)
      .then((r) => alive && (setResult(r), setError(undefined)))
      .catch((e: Error) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [q]);
  const value = useMemo<InboxSearchState>(() => {
    // the last answer stays on screen while the next word is on its way (no flash of every card between letters).
    const r = active ? result : undefined;
    const hits = r ? new Set(r.hits.map((h) => h.id)) : undefined;
    return {
      text,
      setText,
      active,
      q: r?.q ?? q,
      result: r,
      error: active ? error : undefined,
      searching: active && (!r || r.q !== trimmed),
      hits,
      rows: r?.rows ?? [],
      goals,
      keeps: (i) => (!active || !hits || hits.has(i.id)) && shown(i),
    };
  }, [text, active, result, error, q, trimmed, goals, shown]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
