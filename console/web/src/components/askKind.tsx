import { ASK_VERB, type AskKind } from "@/api";
import { cn } from "@/lib/utils";

/** one colour per ask kind, readable in light and dark mode. */
// the kind is a plain grey word on every card, no colour per kind.
const KIND_CLASS: Record<AskKind, string> = {
  decide: "text-muted-foreground",
  approve: "text-muted-foreground",
  provide: "text-muted-foreground",
  do: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** the ask's kind as a category tag (DECIDE, APPROVE, …), shown before the question instead of "Decide: …". */
export function AskKindTag({ kind, className }: { kind: AskKind; className?: string }) {
  return (
    <span
      data-testid="ask-kind"
      data-kind={kind}
      className={cn("inline-flex shrink-0 items-center text-xs font-medium leading-4", KIND_CLASS[kind], className)}
    >
      {ASK_VERB[kind]}
    </span>
  );
}
