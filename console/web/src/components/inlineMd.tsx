/** Moved out of pages/Milestone.tsx so the cards that use it do not pull the whole Milestone page into the first download. */
/** Inline markdown for spine text: **bold** and `code`; links shown as their label. */
export function InlineMd({ text }: { text: string }) {
  const parts = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}
