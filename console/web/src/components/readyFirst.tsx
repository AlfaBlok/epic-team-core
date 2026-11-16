import { useState } from "react";
import type { ReviewItem } from "@/api";
import { useProject } from "@/lib/project";
import { markReviewGoneAfter, unmarkReviewGone, useReviewCards } from "@/lib/inbox";
import { byReady } from "@/lib/cardKind";
import { FoldSection } from "@/components/homeSection";
import { CardButton } from "@/components/ui/cardButton";
import { copyText } from "@/components/laptopSwitch";
import { DeadlineLine } from "@/components/deadlineFirst";
import { PostReviewCard, ReviewCard } from "@/components/review";

/**
 * (the owner, Team desk 2026-11-16 08:04Z: "problem is email showed in the drafts but i was hping for an email
 * or somethingi nmy epicteam inbox notifying - came in too subtly"): what he was waiting on, now ready, leads the whole
 * inbox, set apart above every section (deadline cards included), in both skins: why he waits, where the thing is, and
 * the one action, Open it (Copy link beside it). The console tells him once by WhatsApp or mail (hosted readyPass). The
 * sections below leave these cards out (lib/cardKind `isReady`).
 */
export function ReadyFirst() {
  const project = useProject();
  const { cards } = useReviewCards({ keep: project.keep });
  const list = byReady(cards as ReviewItem[] | undefined);
  if (!list.length) return null;
  return (
    <FoldSection title="Ready for you" count={list.length} tone="needs-you" testId="ready-first">
      <ul className="grid min-w-0 grid-cols-1 gap-[18px]">
        {list.map((i) => (
          <li key={i.id} className="grid min-w-0 gap-2" data-testid="ready-card" data-inbox-card={`review:${i.id}`}>
            <ReadyLine ready={i.face!.ready!} />
            {i.face?.deadline && <DeadlineLine at={i.face.deadline.at} why={i.face.deadline.why} now={Date.now()} />}
            {i.kind === "post" && i.post ? (
              <PostReviewCard item={i} onDone={() => markReviewGoneAfter(i.id, 320)} onFailed={() => unmarkReviewGone(i.id)} />
            ) : (
              <ReviewCard item={i} onDone={() => markReviewGoneAfter(i.id, 320)} onFailed={() => unmarkReviewGone(i.id)} onBack={() => unmarkReviewGone(i.id)} />
            )}
          </li>
        ))}
      </ul>
    </FoldSection>
  );
}

/** "You asked for it · Where: Gmail Drafts, to Airbnb", then Open it and Copy link. */
export function ReadyLine({ ready }: { ready: { whyText: string; where: string; url: string } }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid min-w-0 gap-2 text-sm" data-testid="ready-line">
      <div className="min-w-0">
        <span className="font-semibold">{ready.whyText}.</span> <span className="text-muted-foreground">Where:</span>{" "}
        <span data-testid="ready-where">{ready.where}</span>
      </div>
      {ready.url && (
        <div className="flex flex-wrap gap-2">
          <CardButton asChild>
            <a href={ready.url} target="_blank" rel="noreferrer" data-testid="ready-open">
              Open it
            </a>
          </CardButton>
          <CardButton
            variant="outline"
            data-testid="ready-copy"
            onClick={async () => {
              setCopied(await copyText(ready.url));
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </CardButton>
        </div>
      )}
    </div>
  );
}
