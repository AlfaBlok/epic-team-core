import { Link } from "react-router-dom";
import { ExternalLink, MessageSquare } from "lucide-react";
import type { Run, TicketSession, TreeNode } from "@/api";
import { ThreadLink } from "@/components/common";
import { cn } from "@/lib/utils";
import { useWords } from "@/lib/skin";

/**
 * this milestone's Chat tab about one item. `about` = the row id, `title` its title, `run` the run id (a run row): the
 * Chat tab shows the chip "About <id> · <title>" and sends `[page: <milestone> · <id>]` (· <run id>) with the owner's next message.
 * The server builds the same link (`milestoneChatUrl`) for the desks.
 */
export const milestoneChatHref = (milestoneId: string, about?: { id: string; title?: string; run?: string }) =>
  `/milestones/${encodeURIComponent(milestoneId)}?${new URLSearchParams({ tab: "chat", ...(about ? { about: about.id, ...(about.title ? { title: about.title } : {}), ...(about.run ? { run: about.run } : {}) } : {}) })}`;

/** The item a milestone chat URL is about (?about=&title=&run=), as the Chat tab reads it back. */
export function chatAboutFromParams(params: URLSearchParams): { id: string; title?: string; run?: string } | undefined {
  const id = params.get("about")?.trim();
  if (!id) return undefined;
  const title = params.get("title")?.trim();
  const run = params.get("run")?.trim();
  return { id, ...(title ? { title } : {}), ...(run ? { run } : {}) };
}

/**
 * Discuss on a ledger row or a run; it opens this milestone's Chat tab with the item as context (the repo desk
 * answers about it). No thread is launched any more; a row's ticket session from before (`session`) stays linked beside it.
 */
export function DiscussButton({
  milestoneId,
  row,
  title,
  run,
  session,
  className,
}: {
  milestoneId: string;
  row: string;
  title?: string;
  /** The run this Discuss sits on (run rows): sent along in the hint. */
  run?: string;
  session?: TicketSession;
  className?: string;
}) {
  const w = useWords();
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1.5", className)} data-testid="discuss">
      <Link
        to={milestoneChatHref(milestoneId, { id: row, title, run })}
        className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-accent max-sm:min-h-11"
        title={`Discuss ${row} in this ${w.milestone}'s chat`}
      >
        <MessageSquare className="h-3.5 w-3.5" /> Discuss
      </Link>
      {session && (
        <ThreadLink
          className="inline-flex h-7 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground underline max-sm:min-h-11"
          threadId={session.threadId}
          environmentId={session.environmentId}
          title={`The earlier ticket session (${session.persona.name}) · ${session.threadId}`}
        >
          Ticket session <ExternalLink className="h-3 w-3" />
        </ThreadLink>
      )}
    </span>
  );
}

/**
 * Ledger rows of a tree that can be discussed: key → the spine whose ledger holds the row. Only an open ticket row directly
 * under a spine node (a row of a linked ticket file's own table is not in a spine ledger); a finished
 * (done, superseded) row is not offered, and neither is a reference to a row shown elsewhere.
 */
export function discussable(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: TreeNode) => {
    for (const c of n.children) {
      const ref = c.flags.some((f) => f === "cycle" || f === "repeat");
      if (n.kind === "spine" && n.path && c.kind === "ticket" && !ref && !c.closed && c.color !== "green") out.set(c.key, n.path);
      visit(c);
    }
  };
  visit(root);
  return out;
}

/** A run row's ticket id: a child run's summary starts with the ticket id (wake protocol B.2), ` keep moving` →. */
export function runTicketId(r: Pick<Run, "parentRunId" | "summary">): string | undefined {
  if (!r.parentRunId) return undefined;
  const id = /^\s*\**([A-Za-z0-9][\w.-]*?)[.:,;)*]*(?:\s|$)/.exec(r.summary)?.[1];
  return id && /\d/.test(id) && /^[A-Za-z]/.test(id) ? id : undefined;
}
