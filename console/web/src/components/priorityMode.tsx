import { useEffect, useState } from "react";
import { api, type PriorityModeView } from "@/api";
import { invalidate, useQuery } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { RelTime } from "@/components/common";

const ROW_RE = /^[A-Z][A-Z0-9]*-[A-Z]*\d+$/;
const STATE_WORD: Record<string, string> = {
  asked: "asked to save and stop",
  ask_failed: "could not be asked",
  resumed: "woken again",
  resume_failed: "could not be woken",
  handed_to_manager: "handed to its Delivery Manager",
  skipped: "nothing to resume",
};

/**
 * Priority mode on the Runs page: name one or two rows and press Priority mode; every other running session is
 * asked to save its state and stop, only those rows run, and Resume (or their finish) wakes the others where they left
 * off, in priority order. Shows who is parked and every park and resume line.
 */
export function PriorityModeSection({ initialRows = "" }: { initialRows?: string } = {}) {
  const { data, error } = useQuery(() => api.getPriorityMode(), []);
  const [view, setView] = useState<PriorityModeView | undefined>();
  const [rowsText, setRowsText] = useState(initialRows);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => setView(undefined), [data]); // a fresh read replaces what the last press answered
  const v = view ?? data;
  const rows = rowsText
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const rowsOk = rows.length >= 1 && rows.length <= 2 && rows.every((r) => ROW_RE.test(r));
  const act = async (fn: () => Promise<PriorityModeView>) => {
    setBusy(true);
    setErr(undefined);
    try {
      setView(await fn());
      invalidate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const s = v?.session;
  const workers = (v?.parked ?? []).filter((p) => p.kind === "worker");
  return (
    <section className="mb-4 rounded-lg border p-3" data-testid="priority-mode">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Priority mode</h2>
        {v?.on ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900" data-testid="priority-on">
            On for {s?.rows.join(" and ")} since <RelTime iso={s!.startedAt} />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Off: every ticket runs.</span>
        )}
      </div>
      {error && !v && <p className="mt-1 text-xs text-red-700">{error.message}</p>}
      {v?.on ? (
        <div className="mt-2 space-y-2">
          <p className="text-sm">
            Only {s?.rows.join(" and ")} run. {workers.length} parked worker{workers.length === 1 ? "" : "s"} wake again where they left off when{" "}
            {s && s.rows.length > 1 ? "these finish" : "it finishes"}, or now:
          </p>
          <Button size="sm" disabled={busy} onClick={() => act(() => api.resumePriorityMode())} data-testid="priority-resume">
            Resume everyone
          </Button>
        </div>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (rowsOk) void act(() => api.startPriorityMode({ rows, reason: reason.trim() || undefined }));
          }}
        >
          <label className="flex min-w-0 flex-col text-xs">
            One or two tickets
            <input
              className="h-8 w-48 max-w-full rounded-md border bg-background px-2 text-sm"
              placeholder="one or two row codes"
              value={rowsText}
              onChange={(e) => setRowsText(e.target.value)}
              data-testid="priority-rows"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col text-xs">
            Why (optional)
            <input className="h-8 min-w-0 rounded-md border bg-background px-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button size="sm" type="submit" disabled={busy || !rowsOk} data-testid="priority-start">
            Give them the machine
          </Button>
        </form>
      )}
      {err && <p className="mt-1 text-xs text-red-700">{err}</p>}
      {v && (v.parked.length > 0 || v.log.length > 0) && (
        <details className="mt-2 text-sm" open={!!v.on}>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {v.on ? "Parked now" : `Last time: ${s?.rows.join(" and ")}, ${s?.endWhy ?? ""}`} · {v.log.length} log line{v.log.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5" data-testid="priority-parked">
            {v.parked.map((p) => (
              <li key={p.runId} className="text-xs">
                <span className="font-medium">{p.ticket ?? (p.kind === "wake" ? "a wake" : p.runId.slice(0, 12))}</span>
                {p.rank !== null ? ` · rank ${p.rank}` : ""} · {STATE_WORD[p.state] ?? p.state}
                {p.note ? ` (${p.note})` : ""}
              </li>
            ))}
          </ul>
          <ol className="mt-2 space-y-0.5 border-t pt-1" data-testid="priority-log">
            {v.log.map((l, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                {l.at.slice(11, 16)}Z {l.event} {l.ticket ?? ""} {l.detail}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
