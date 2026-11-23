import { useEffect, useState } from "react";
import { api, type BriefingPictures } from "@/api";
import { useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import { FoldChevron } from "@/components/foldChevron";

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

/** whether it reached his phone, in his words: read, delivered, not yet, failed (nothing until it is known). */
export function deliveryWords(d: BriefingPictures["delivery"]): { text: string; tone: "ok" | "wait" | "bad" } | null {
  if (d === "read") return { text: "Read on your phone", tone: "ok" };
  if (d === "delivered") return { text: "Delivered to your phone", tone: "ok" };
  if (d === "failed") return { text: "Did not reach your phone", tone: "bad" };
  if (d === "pending" || d === "sent") return { text: "Sent, not delivered yet", tone: "wait" };
  return null;
}

function Briefing({ b }: { b: BriefingPictures }) {
  const [open, setOpen] = useState<number | null>(null);
  const pic = open == null ? undefined : b.pictures[open];
  return (
    <div className="grid min-w-0 gap-1.5" data-testid="briefing-pictures" data-briefing={b.briefing}>
      <div className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{NAME[b.briefing]}</span> · {briefingWhen(b.at)}
        {deliveryWords(b.delivery) && (
          <>
            {" · "}
            <span data-testid="briefing-delivery" data-delivery={b.delivery} className={cn(deliveryWords(b.delivery)!.tone === "bad" && "font-medium text-destructive")}>
              {deliveryWords(b.delivery)!.text}
            </span>
          </>
        )}
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

/**
 * The owner 22 Nov: "right now, I would like to know like the last 6 hours what's been happening. Maybe we need to press
 * a button or something for that one to be created on the spot". One button above the briefings draws the last 6 hours
 * now (posts per channel, when each last posted, red when longer ago than usual); a second tap draws it again.
 */
export function NowPicture({ hours = 6 }: { hours?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "failed">("idle");
  const draw = async () => {
    setState("loading");
    const id = await worldId().catch(() => "");
    if (!id) return setState("failed");
    setUrl(`/api/tenants/${encodeURIComponent(id)}/social/now.png?hours=${hours}&at=${Date.now()}`);
  };
  return (
    <div className="grid min-w-0 gap-1.5" data-testid="now-picture">
      <button type="button" onClick={draw} disabled={state === "loading"} className={cn("justify-self-start rounded-md border px-3 py-1.5 text-sm font-medium", PHONE_TAP)} data-testid="now-picture-button">
        {state === "loading" ? "Drawing the last 6 hours…" : url ? `Draw the last ${hours} hours again` : `Social: the last ${hours} hours, now`}
      </button>
      {!url && state === "failed" && <p className="text-xs text-destructive">It could not be drawn just now. Try again in a minute.</p>}
      {url && (
        <figure className={cn("grid min-w-0 gap-1", state === "loading" && "opacity-60")} data-testid="now-picture-open">
          <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt={`On social, the last ${hours} hours`} onLoad={() => setState("ok")} onError={() => setState("failed")} className="w-full max-w-2xl rounded-md border" />
          </a>
          {state === "failed" && <figcaption className="text-xs text-destructive">It could not be drawn just now. Try again in a minute.</figcaption>}
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
      <NowPicture />
      {last.map((b) => (
        <Briefing key={b.briefing + b.at} b={b} />
      ))}
      {earlier.length > 0 && (
        <>
          <button type="button" onClick={() => setMore(!more)} className={cn("justify-self-start text-xs text-muted-foreground underline underline-offset-2", PHONE_TAP)} aria-expanded={more} data-testid="earlier-briefings">
            <FoldChevron open={more} className="mr-1.5" />
            {more ? "Hide earlier briefings" : `Earlier briefings (${earlier.length})`}
          </button>
          {more && earlier.map((b) => <Briefing key={b.briefing + b.at} b={b} />)}
        </>
      )}
    </section>
  );
}
