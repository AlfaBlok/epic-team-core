import { savedCopyLabel, useSavedCopy } from "@/lib/savedCopy";

/**
 * the Inbox drawn from the app's saved copy (the console slow or no connection) says so in one calm line with
 * the copy's age; the first fresh answer clears it (lib/savedCopy).
 */
export function SavedCopyLine() {
  const s = useSavedCopy();
  if (!s) return null;
  return (
    <div role="status" aria-live="polite" className="mb-3 text-xs text-muted-foreground" data-testid="saved-copy-line">
      {savedCopyLabel(s.keptAt)}
    </div>
  );
}
