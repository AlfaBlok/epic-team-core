import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * a tab strip stays on one line at every width; the tabs that
 * do not fit fold, from the right, under "More". The open tab never folds.
 *
 * Which tabs fold: keep tabs from the left while they fit beside the open tab and the More button; the first that does not
 * fit and every tab after it fold, so the strip keeps its order. `reserve` keeps room for More when it shows anyway.
 */
export function tabsToFold(widths: number[], avail: number, moreWidth: number, active: number, reserve = false): Set<number> {
  const total = widths.reduce((a, b) => a + b, 0);
  if (!reserve && total <= avail) return new Set();
  const room = avail - moreWidth;
  let used = active >= 0 ? widths[active] : 0;
  const folded = new Set<number>();
  let full = false;
  widths.forEach((w, i) => {
    if (i === active) return;
    if (!full && used + w <= room) used += w;
    else {
      full = true;
      folded.add(i);
    }
  });
  return folded;
}

/**
 * Measures the strip (put `ref` on it; its direct children with data-tab-id are the tabs) and returns the ids to fold.
 * A callback ref, so the strip is measured when it mounts, also after a page's loading state. Widths are remembered while a
 * tab shows, so a folded tab comes back when the strip widens. jsdom has no layout: nothing folds there.
 */
export function useTabFold(ids: string[], active: string, reserve = false): { ref: (el: HTMLElement | null) => void; folded: Set<string> } {
  const widths = useRef(new Map<string, number>());
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const key = ids.join("|");
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      for (const t of el.querySelectorAll<HTMLElement>(":scope > [data-tab-id]")) if (t.offsetWidth) widths.current.set(t.dataset.tabId!, t.offsetWidth);
      const more = el.querySelector<HTMLElement>(":scope > [data-tab-more]");
      const style = getComputedStyle(el);
      const avail = el.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      if (avail <= 0 || ids.some((id) => !widths.current.get(id))) return;
      const next = tabsToFold(
        ids.map((id) => widths.current.get(id)!),
        avail,
        more?.offsetWidth || 84,
        ids.indexOf(active),
        reserve,
      );
      const out = new Set([...next].map((i) => ids[i]));
      setFolded((was) => (was.size === out.size && [...out].every((x) => was.has(x)) ? was : out));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, key, active, reserve]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref: setEl, folded };
}

/** The More button and its menu: the folded tabs (and any tabs that always live there); the picked one shows as its label. */
export function MoreTabMenu({ items, current, onPick }: { items: { id: string; label: string }[]; current: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const picked = items.find((t) => t.id === current);
  if (!items.length) return null;
  return (
    <span className="relative ml-auto inline-flex shrink-0" data-tab-more>
      <button
        type="button"
        className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium", picked ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground")}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="more-tabs"
        onClick={() => setOpen((o) => !o)}
      >
        {picked?.label ?? "More"} <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span role="menu" className="absolute right-0 top-full z-30 mt-1 grid min-w-36 rounded-md border bg-popover p-1 text-sm shadow-md">
          {items.map((t) => (
            <button key={t.id} type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-accent" onClick={() => (setOpen(false), onPick(t.id))}>
              {t.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

