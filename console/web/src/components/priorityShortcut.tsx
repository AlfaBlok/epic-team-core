import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import { invalidate, useSharedQuery } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common";
import { PriorityModeSection } from "@/components/priorityMode";
import { PRIORITY_PATH } from "@/lib/routePaths";
export { PRIORITY_PATH };

/**
 * the phone shortcut for priority mode: one tap away without a top-bar button (the top bar stays Inbox, Chat and the
 * mic).
 *
 *   sidebar ─ Priority mode ──────────────► /priority (the Runs page's panel, alone)
 *   long-press a card or row with a code ─► sheet "Give this the machine" ─► starts it for that row ─► /priority
 *
 * Any element carrying `data-row="<row code>"` takes the long-press (review cards, status cards, goal set board cards).
 */

const ROW_RE = /^[A-Z][A-Z0-9]*-[A-Z]*\d+$/;

/**
 * the menu chip: while priority mode is on, a small amber chip under the brand says so and names its
 * tickets; a tap opens /priority, where Resume everyone switches it off. Off (or unread): nothing at all.
 * One shared read of /api/priority-mode for the desktop and the phone menu, refreshed with the menu's poll.
 */
export function PriorityModeChip({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useSharedQuery("priority-mode", () => api.getPriorityMode());
  if (!data?.on) return null;
  const rows = data.session?.rows ?? [];
  return (
    <Link
      to={`/${PRIORITY_PATH}`}
      onClick={onNavigate}
      title="Priority mode is on: open it to see who is parked or resume everyone"
      className="mx-2 flex min-w-0 flex-col gap-0.5 rounded-lg border-2 border-amber-500 bg-amber-300 px-3 py-2 text-amber-950 shadow-sm hover:bg-amber-200 dark:border-amber-400 dark:bg-amber-400 dark:text-amber-950"
      data-testid="priority-chip"
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-950" aria-hidden />
        Priority mode on
      </span>
      <span className="text-xs">
        Only your priority tickets run{rows.length > 0 ? `: ${rows.join(", ")}` : ""}
      </span>
    </Link>
  );
}

/** how long a press must hold, and how far the finger may drift before it counts as a scroll. */
export const LONG_PRESS_MS = 550;
const MOVE_PX = 10;

/** the row code a long-press on this element means, or undefined (no data-row up the tree, or not a row code). */
export function rowAt(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-row]") : null;
  // a tree node key (milestone/…/<row code>) names its row last.
  const row = el?.dataset.row?.split("/").pop()?.trim().toUpperCase();
  // an epic card (EPIC-n) is not a ticket: no worker of its own would get the machine.
  return row && ROW_RE.test(row) && !row.startsWith("EPIC-") ? row : undefined;
}

/** the /priority page: the panel alone, ?rows= fills its box (from the long-press or a link). */
export function PriorityModePage() {
  const [params] = useSearchParams();
  const rows = params.get("rows") ?? "";
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0" data-testid="priority-page">
      <PageHeader
        title="Priority mode"
        description="Give one or two tickets the whole machine: every other session saves and stops, then wakes again where it left off."
      />
      <PriorityModeSection key={rows} initialRows={rows} />
      <p className="text-xs text-muted-foreground">
        Tip: on any card with a ticket code, press and hold for “Give this the machine”. Every run is on the{" "}
        <Link className="underline underline-offset-4" to="/runs">
          Runs page
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * Mounted once in the layout: listens on the document for a press held on a `[data-row]` element and opens a small
 * bottom sheet for that row. The sheet's button starts priority mode for that row and opens /priority.
 */
export function PriorityLongPress() {
  const [row, setRow] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const navigate = useNavigate();
  const fired = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | undefined;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      start = undefined;
    };
    const down = (e: PointerEvent) => {
      // a new press: a phone that sends no click after a long-press must not lose the sheet's first tap.
      fired.current = false;
      if (e.button > 0) return; // the main button or a finger only
      const r = rowAt(e.target);
      if (!r) return;
      // a press on the card's own buttons, links into fields or the text boxes stays theirs.
      if (e.target instanceof Element && e.target.closest("button, input, textarea, select, [contenteditable=true]")) return;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        fired.current = true;
        setErr(undefined);
        setRow(r);
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    };
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_PX) cancel();
    };
    // the click that ends a long-press (a card that is a link) must not also open it.
    const click = (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // the phone's own long-press menu (copy, open in new tab) would cover the sheet.
    const menu = (e: Event) => {
      if (timer || fired.current) e.preventDefault();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", cancel);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("scroll", cancel, true);
    document.addEventListener("click", click, true);
    document.addEventListener("contextmenu", menu);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", cancel);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("scroll", cancel, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("contextmenu", menu);
    };
  }, []);

  if (!row) return null;
  const close = () => {
    setRow(undefined);
    setErr(undefined);
  };
  const give = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.startPriorityMode({ rows: [row], reason: "long-press on its card" });
      invalidate();
      close();
      navigate(`/${PRIORITY_PATH}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={close} data-testid="priority-sheet">
      <div
        role="dialog"
        aria-label={`Priority mode for ${row}`}
        className="w-full max-w-sm rounded-t-2xl border bg-background p-4 shadow-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium">{row}</p>
        <p className="mt-1 text-xs text-muted-foreground">Every other session saves its state and stops; they wake again where they left off when {row} finishes.</p>
        <div className="mt-3 grid gap-2">
          <Button disabled={busy} onClick={() => void give()} data-testid="priority-sheet-give">
            {busy ? "Starting…" : "Give this the machine"}
          </Button>
          <Button variant="outline" onClick={close} data-testid="priority-sheet-cancel">
            Cancel
          </Button>
        </div>
        {err && <p className="mt-2 text-xs text-red-700" data-testid="priority-sheet-error">{err}</p>}
      </div>
    </div>
  );
}
