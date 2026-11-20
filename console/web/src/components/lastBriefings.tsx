import { useEffect, useState } from "react";
import { api, type BriefingPictures } from "@/api";
import { useQuery } from "@/lib/data";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";

/**
 * The owner: "Where in the UI can I get access to the last snapshot of these
 * briefings? Where are they?" Home's objectives screen, under the Briefing button: the newest 06:00 and 18:30 briefing
 * as the pictures he got on WhatsApp; a tap on one opens it large, and "Earlier briefings" opens the ones before, one
 * tap away. Nothing shows where the world sends no briefings.
 */

const NAME: Record<BriefingPictures["briefing"], string> = { morning: "Morning briefing", evening: "Evening briefing" };

/** "Thu 20 Nov, 06:00" in his own clock. */
export function briefingWhen(at: string): string {
  const d = new Date(at);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

/** the newest of each briefing first (06:00 and 18:30, newest on top), then every earlier one, newest first. */
export function splitBriefings(all: BriefingPictures[]): { last: BriefingPictures[]; earlier: BriefingPictures[] } {
  const last: BriefingPictures[] = [];
  const earlier: BriefingPictures[] = [];
  for (const b of all) (last.some((x) => x.briefing === b.briefing) ? earlier : last).push(b);
  return { last, earlier };
}

function Briefing({ b }: { b: BriefingPictures }) {
  const [open, setOpen] = useState<number | null>(null);
  const pic = open == null ? undefined : b.pictures[open];
  return (
    <div className="grid min-w-0 gap-1.5" data-testid="briefing-pictures" data-briefing={b.briefing}>
      <div className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{NAME[b.briefing]}</span> · {briefingWhen(b.at)}
      </div>
      <div className="flex min-w-0 gap-2 overflow-x-auto">
        {b.pictures.map((p, i) => (
          <button
            key={p.url}
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            className={cn("shrink-0 overflow-hidden rounded-md border", open === i && "ring-2 ring-primary")}
            aria-label={`${p.what}, open`}
            aria-pressed={open === i}
            data-testid="briefing-picture"
          >
            <img src={p.url} alt={p.what} loading="lazy" decoding="async" fetchPriority="low" className="h-20 w-auto max-w-[9rem] object-cover object-top" />
          </button>
        ))}
      </div>
      {pic && (
        <figure className="grid min-w-0 gap-1" data-testid="briefing-picture-open">
          <a href={pic.url} target="_blank" rel="noreferrer">
            <img src={pic.url} alt={pic.what} className="w-full max-w-2xl rounded-md border" />
          </a>
          <figcaption className="text-xs text-muted-foreground">{pic.what}</figcaption>
        </figure>
      )}
    </div>
  );
}

/** true once the page is idle after its first paint, so nothing here races the inbox or the sidebar's reads. */
export function useAfterFirstPaint(delayMs = 1500): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let idle: number | undefined;
    const t = window.setTimeout(() => {
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) idle = ric(() => setReady(true), { timeout: 2000 });
      else setReady(true);
    }, delayMs);
    return () => {
      window.clearTimeout(t);
      const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle != null && cic) cic(idle);
    };
  }, [delayMs]);
  return ready;
}

export function LastBriefings({ delayMs = 1500 }: { delayMs?: number }) {
  const ready = useAfterFirstPaint(delayMs);
  const q = useQuery(() => (ready && api.getBriefingPictures ? api.getBriefingPictures(14) : Promise.resolve({ briefings: [] })), [ready]);
  const [more, setMore] = useState(false);
  const { last, earlier } = splitBriefings(q.data?.briefings ?? []);
  if (!last.length) return null;
  return (
    <section className="grid min-w-0 gap-3" aria-label="Last briefings" data-testid="last-briefings">
      {last.map((b) => (
        <Briefing key={b.briefing + b.at} b={b} />
      ))}
      {earlier.length > 0 && (
        <>
          <button type="button" onClick={() => setMore(!more)} className={cn("justify-self-start text-xs text-muted-foreground underline underline-offset-2", PHONE_TAP)} aria-expanded={more} data-testid="earlier-briefings">
            {more ? "Hide earlier briefings" : `Earlier briefings (${earlier.length})`}
          </button>
          {more && earlier.map((b) => <Briefing key={b.briefing + b.at} b={b} />)}
        </>
      )}
    </section>
  );
}
