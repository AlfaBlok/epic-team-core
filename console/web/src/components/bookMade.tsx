import { useState } from "react";
import type { Deliverable } from "@/api";
import { day } from "@/lib/book";

/**
 * "Everything made for this": every mockup, deck, proposal, live page, tailnet preview and piece
 * of evidence made for an epic, newest first, one line each (root L-39: 20 shown, then all). Nothing is dropped: a link
 * that no longer answers is marked, and a stopped preview names the folder to serve it from again.
 */
const KIND_STYLE: Record<Deliverable["kind"], string> = {
  mockup: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  deck: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  proposal: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  "live page": "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  preview: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  evidence: "bg-muted text-muted-foreground",
};

function Check({ d }: { d: Deliverable }) {
  const c = d.check;
  if (!c || c.state === "ok") return null;
  const when = `checked ${day(c.at)}${c.detail ? `, ${c.detail}` : ""}`;
  if (c.state === "not running")
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400" data-testid="made-not-running" title={when}>
        Not running.{" "}
        {d.servePath ? (
          <>
            Serve it again from <span className="font-mono">{d.servePath}</span>
            {d.repoUrl && (
              <>
                {" "}
                or{" "}
                <a href={d.repoUrl} target="_blank" rel="noreferrer" className="underline">
                  read its files
                </a>
              </>
            )}
            .
          </>
        ) : (
          "Its folder was not recorded."
        )}
      </span>
    );
  return (
    <span className="block text-xs text-red-700 dark:text-red-400" data-testid="made-gone" title={when}>
      {c.state === "gone" ? "No longer there" : "Does not answer"} ({when}).
    </span>
  );
}

export function MadeList({ items, initial = 20 }: { items: Deliverable[]; initial?: number }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="text-sm text-muted-foreground">Nothing linked yet.</p>;
  const shown = all ? items : items.slice(0, initial);
  return (
    <div className="min-w-0">
      <ul className="grid gap-1.5 text-sm" data-testid="made-list">
        {shown.map((d) => (
          <li key={d.url} className="min-w-0" data-testid="made-item" data-kind={d.kind} data-check={d.check?.state ?? "unchecked"}>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums" title={d.date ?? "no date in the spine"}>
                {d.date ? day(d.date) : "–"}
              </span>
              <span className={`shrink-0 rounded px-1.5 py-px text-[11px] font-medium ${KIND_STYLE[d.kind]}`}>{d.kind}</span>
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                title={`${d.label}${d.row ? ` (${d.row})` : ""}\n${d.url}`}
                className={`min-w-0 truncate underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground ${d.check && d.check.state !== "ok" ? "text-muted-foreground" : ""}`}
              >
                {d.label}
              </a>
            </div>
            <div className="pl-14">
              <Check d={d} />
            </div>
          </li>
        ))}
      </ul>
      {items.length > initial && (
        <button type="button" className="mt-2 text-xs underline" onClick={() => setAll(!all)} data-testid="made-more">
          {all ? `Show the newest ${initial}` : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
