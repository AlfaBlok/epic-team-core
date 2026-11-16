import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { VoiceNoteItem, VoiceNotesBody } from "@/api/pages-types";
import { PageHeader } from "@/components/common";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { ON_DEVICE_PATH, VOICE_NOTES_PATH } from "@/lib/routePaths";
import { isVoiceNotesPin } from "@/lib/storedFlag";
export { VOICE_NOTES_PATH };

/**
 * His voice notes in one place: every note of the last two days from every place he speaks, newest first, each with the
 * rows and epics made from it; a product filter shows one product's notes alone (the products and their order come from
 * the file, the first is where the page opens). A persona writes docs/voice-notes/index.json every pass; GET
 * /api/voice-notes reads it (server/src/voiceNotesIndex.ts). Quiet: ink and grey, one list.
 */

const ALL = "all";
const STATE_CLASS: Record<string, string> = {
  delivered: "text-emerald-700 dark:text-emerald-400",
  "in review": "text-emerald-700/80 dark:text-emerald-400/80",
  open: "text-amber-700 dark:text-amber-400",
  "not linked": "text-destructive",
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
};

function Note({ n, names }: { n: VoiceNoteItem; names: Record<string, string> }) {
  return (
    <li className="grid gap-1 border-t border-border py-3" data-testid="voice-note" data-products={n.products.join(" ")}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{when(n.at)}</span>
        <span>{n.app}</span>
        {n.products.map((p) => (
          <span key={p} className="rounded-full border border-border px-1.5">{names[p] ?? (p === "other" ? "Other" : p)}</span>
        ))}
        <span className={cn("font-medium", STATE_CLASS[n.state])} data-testid="voice-note-state">{n.state}</span>
        {n.url && (
          <a href={n.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" title={n.ref}>
            in your memory
          </a>
        )}
      </div>
      <p className="text-sm text-foreground [overflow-wrap:anywhere]">{n.words}</p>
      {n.rows.length > 0 && (
        <ul className="grid gap-0.5 text-xs" data-testid="voice-note-rows">
          {n.rows.map((r) => (
            <li key={`${r.repo}-${r.code}`} className="flex min-w-0 items-baseline gap-2">
              <Link to={`/deck/${encodeURIComponent(r.repo)}/${encodeURIComponent(r.epic)}`} className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline">
                {r.code}
              </Link>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.title || r.epicTitle}>
                {r.status ? `${r.status.split(" ")[0]} · ` : ""}
                {r.title || r.epicTitle || r.epic}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function VoiceNotesPage() {
  const [params, setParams] = useSearchParams();
  // the products the file names (its first is where the page opens); before the first answer, every note.
  const names = useQuery<VoiceNotesBody>(() => api.listVoiceNotes(ALL), []).data?.productNames ?? {};
  const first = Object.keys(names)[0] ?? ALL;
  const product = params.get("product") || first;
  const filters = [...Object.entries(names).map(([id, label]) => ({ id, label })), { id: ALL, label: "All" }];
  const { data, error, loading } = useQuery<VoiceNotesBody>(() => api.listVoiceNotes(product), [product]);
  const chart = useQuery(() => api.listPinnedPages(), []).data?.pinned.find(isVoiceNotesPin);
  const counts = data ? data.notes.reduce<Record<string, number>>((a, n) => ({ ...a, [n.state]: (a[n.state] ?? 0) + 1 }), {}) : {};
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="voice-notes-index">
      <PageHeader
        title="Voice notes"
        description="Everything you said in the last two days, from chat, cards and your phone, with what the team made of it."
        actions={
          <span className="flex flex-wrap items-center gap-3">
            {/* the pinned chart of every note over time (the menu's one Voice notes entry holds both). */}
            {chart && (
              <a href={chart.slug ? `/${chart.slug}` : chart.url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2" data-testid="voice-notes-chart">
                Over time
              </a>
            )}
            <Link to={`/${ON_DEVICE_PATH}`} className="text-sm underline underline-offset-2" data-testid="voice-notes-on-device">
              On this device
            </Link>
          </span>
        }
      />
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Product">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={product === f.id}
            data-testid={`voice-notes-filter-${f.id}`}
            onClick={() => setParams(f.id === first ? {} : { product: f.id }, { replace: true })}
            className={cn("rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", product === f.id && "bg-accent text-foreground")}
          >
            {f.label}
            {data?.products && f.id !== ALL && data.products[f.id] !== undefined ? ` ${data.products[f.id]}` : ""}
          </button>
        ))}
      </div>
      {loading && !data && <div className="text-sm text-muted-foreground">Reading your voice notes…</div>}
      {error && <div className="text-sm text-destructive">Could not read the voice notes: {error.message}</div>}
      {data && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="voice-notes-summary">
          <span className="font-medium">{data.notes.length} notes</span>
          {["delivered", "in review", "open", "not linked"].map((s) =>
            counts[s] ? (
              <span key={s} className={STATE_CLASS[s]}>
                {counts[s]} {s}
              </span>
            ) : null,
          )}
        </div>
      )}
      {data && data.notes.length === 0 && <div className="text-sm text-muted-foreground">No voice notes here yet.</div>}
      {data && data.notes.length > 0 && (
        <ul className="grid" data-testid="voice-notes-list">
          {data.notes.map((n) => (
            <Note key={n.ref} n={n} names={names} />
          ))}
        </ul>
      )}
      {data?.generatedAt && (
        <p className="text-xs text-muted-foreground" data-testid="voice-notes-rule">
          Read {when(data.generatedAt)}. A persona looks again every pass and links each note to the rows made from it.
        </p>
      )}
    </div>
  );
}
