import { useState } from "react";
import type { CardFace } from "@/api";
import { CardButton } from "@/components/ui/cardButton";
import { copyText } from "@/components/laptopSwitch";
import { DeadlineLine } from "@/components/deadlineFirst";

/**
 * (the owner, Team desk 2026-11-16 08:04Z: "came in too subtly"; 20:27Z: "I don't want to add
 * more sections!!! It should just be at the top on blocked waiting for me or top done waiting for your review"): what he
 * was waiting on, now ready, leads the section it belongs to (components/review.tsx), marked plainly by these lines above
 * the card: Ready, why he waits, where the thing is, Open it and Copy link; then its deadline, if it has one. The section
 * opens by itself while it holds one. The console still tells him once by WhatsApp or mail (hosted readyPass).
 */
export function LeadLines({ face, now }: { face: Pick<CardFace, "ready" | "deadline"> | null | undefined; now: number }) {
  if (!face?.ready && !face?.deadline) return null;
  return (
    <>
      {face.ready && <ReadyLine ready={face.ready} />}
      {face.deadline && <DeadlineLine at={face.deadline.at} why={face.deadline.why} now={now} />}
    </>
  );
}

/** "You asked for it · Where: Gmail Drafts, to Airbnb", then Open it and Copy link. */
export function ReadyLine({ ready }: { ready: { whyText: string; where: string; url: string } }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid min-w-0 gap-2 text-sm" data-testid="ready-line">
      <div className="min-w-0">
        <span className="font-semibold" data-testid="ready-mark">Ready for you.</span> <span>{ready.whyText}.</span> <span className="text-muted-foreground">Where:</span>{" "}
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
