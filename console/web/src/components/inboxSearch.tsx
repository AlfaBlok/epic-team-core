import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useInboxSearch } from "@/lib/inboxSearch";

/**
 * the search box on top of the Inbox (the owner 2026-11-12 21:17Z: "typing a word filters every section").
 * One quiet line under it names the word (each section's own count pill counts its matches), or "Nothing matches <word>".
 */
export function InboxSearchBox() {
  const s = useInboxSearch();
  const r = s.result;
  const line = !s.active
    ? undefined
    : s.error
      ? "Search is not available right now."
      : !r
        ? "Searching…"
        : r.total === 0
          ? `Nothing matches “${r.q}”.`
          : `Showing what matches “${r.q}”: each section counts its matches.`;
  return (
    <div className="mb-4" role="search" data-testid="inbox-search">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={s.text}
          onChange={(e) => s.setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && s.setText("")}
          placeholder="Search the inbox"
          aria-label="Search the inbox"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={100}
          className="h-10 pl-9 pr-10 [&::-webkit-search-cancel-button]:hidden"
          data-testid="inbox-search-input"
        />
        {s.text && (
          <button
            type="button"
            onClick={() => s.setText("")}
            className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
            data-testid="inbox-search-clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {line && (
        <p className="mt-1.5 text-xs text-muted-foreground" aria-live="polite" data-testid="inbox-search-line">
          {line}
        </p>
      )}
    </div>
  );
}
