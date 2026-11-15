import { useState } from "react";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { PHONE_TAP } from "@/components/common";

/**
 * The owner, 2026-11-13: "I want them to report EACH TIME they ask me to do something, what it was, why only I
 * could do it. Eventially we'll try to go to zero." The inbox header names this week's count of asks to him and opens
 * the log page (each ask: tries, minutes, his verdict); a closed ask card takes his one tap: clear or confusing.
 */
export function AsksThisWeek() {
  const { data } = useQuery(() => api.askLogSummary(), []);
  if (!data?.page) return null;
  const prev = data.byWeek.length > 1 ? data.byWeek[data.byWeek.length - 2] : undefined;
  const n = data.thisWeek.asked;
  return (
    <a
      href={data.page}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex min-h-9 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent", PHONE_TAP)}
      data-testid="asks-this-week"
      title="Every time the team asked you to act this week: what, why only you, tries, minutes and your verdict"
    >
      <span className="font-semibold tabular-nums">{n}</span> ask{n === 1 ? "" : "s"} to you this week
      {prev ? <span className="text-muted-foreground">(last week {prev.asked})</span> : null} →
    </a>
  );
}

const TAPPED = "askVerdicts";
const tappedOf = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(TAPPED) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};

/** his one tap on a closed ask: was it clear or confusing (logged in docs/asks/log.jsonl). */
export function AskVerdictTap({ code }: { code: string }) {
  const [done, setDone] = useState<string | undefined>(() => tappedOf()[code]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (done)
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="ask-verdict-done">
        You said this ask was <span className="font-medium text-foreground">{done}</span>. It is on the asks log.
      </p>
    );
  const tap = (v: "clear" | "confusing") => {
    setBusy(true);
    setError(undefined);
    api
      .askVerdict(code, v)
      .then(() => {
        localStorage.setItem(TAPPED, JSON.stringify({ ...tappedOf(), [code]: v }));
        setDone(v);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="ask-verdict">
      <span>Was this ask clear?</span>
      <button type="button" disabled={busy} onClick={() => tap("clear")} className={cn("min-h-9 rounded-md border px-3 hover:bg-accent", PHONE_TAP)} data-testid="ask-verdict-clear">
        Clear
      </button>
      <button type="button" disabled={busy} onClick={() => tap("confusing")} className={cn("min-h-9 rounded-md border px-3 hover:bg-accent", PHONE_TAP)} data-testid="ask-verdict-confusing">
        Confusing
      </button>
      {error && <span className="text-destructive">Not saved: {error}</span>}
    </div>
  );
}
