import { useEffect, useState, useSyncExternalStore } from "react";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { held, KEEP_SENT, outbox, outboxState, recount, sendNow, sentVersion, subscribeOutbox, subscribeSent, type OutNote, type OutPart, type SentRec } from "./outbox";

/**
 * every voice note kept on this device, in one place: the ones
 * waiting to send (what holds them, the next try, Send now) and the last KEEP_SENT the console confirmed, to play back.
 * The audio is in this browser's IndexedDB (voice/outbox.ts): a note leaves the waiting list only when the console said it
 * stored it, and the last few stay here after that.
 */

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const length = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${t % 60 ? `${t % 60} s` : ""}`.trim();
};
const inMin = (at?: number) => (at && at > Date.now() ? `next try in ${Math.max(1, Math.round((at - Date.now()) / 60_000))} min` : "trying now");

interface Waiting {
  n: OutNote;
  parts: OutPart[];
}

function useDevice() {
  const st = useSyncExternalStore(subscribeOutbox, outboxState, outboxState);
  const ver = useSyncExternalStore(subscribeSent, sentVersion, sentVersion);
  const [waiting, setWaiting] = useState<Waiting[] | undefined>();
  const [sent, setSent] = useState<SentRec[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      const s = outbox();
      const notes = (await s.notes()).sort((a, b) => b.startedAt - a.startedAt);
      const w = await Promise.all(notes.map(async (n) => ({ n, parts: await s.parts(n.cid) })));
      const done = await s.sent();
      if (live) setWaiting(w), setSent(done.slice(0, KEEP_SENT));
    })();
    return () => void (live = false);
  }, [st, ver, tick]);
  // the waiting lines' "next try" and a note being recorded move on by themselves.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  return { waiting, sent, refresh: () => setTick((x) => x + 1) };
}

/** one recording's parts as players (each part is its own short file, played in order). */
function Players({ parts, label }: { parts: { n: number; blob: Blob }[]; label: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = parts.map((p) => URL.createObjectURL(p.blob));
    setUrls(u);
    return () => u.forEach((x) => URL.revokeObjectURL(x));
  }, [parts]);
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {urls.map((u, i) => (
        <div key={u} className="flex items-center gap-2">
          {urls.length > 1 && <span className="w-14 shrink-0 text-xs text-muted-foreground">Part {i + 1}</span>}
          <audio controls preload="none" src={u} className="h-9 w-full min-w-0" aria-label={`${label}, part ${i + 1}`} />
        </div>
      ))}
    </div>
  );
}

export function OnDevicePage() {
  const { waiting, sent, refresh } = useDevice();
  const [busy, setBusy] = useState(false);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const go = async () => {
    setBusy(true);
    try {
      await sendNow();
      await recount();
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const list = waiting ?? [];
  const toSend = list;
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6" data-testid="on-device">
      <PageHeader title="Voice notes on this device" description="Every voice note stays here until the console confirms it stored it, and the last 5 stay after that." />

      <section className="mt-4 rounded-lg border border-border p-4" data-testid="on-device-waiting">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            {toSend.length ? `Waiting to send: ${toSend.length}` : "Nothing waiting to send"}
          </h2>
          {toSend.length > 0 && (
            <Button size="sm" onClick={go} disabled={busy} data-testid="on-device-send-now">
              {busy ? "Sending…" : "Send now"}
            </Button>
          )}
        </div>
        {toSend.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {offline ? "No connection. They go by themselves when you are back online." : "They go by themselves, trying again for days, longer waits between tries."}
          </p>
        )}
        <ul className="mt-2 divide-y divide-border">
          {toSend.map(({ n, parts }) => (
            <li key={n.cid} className="py-3" data-testid="on-device-waiting-note">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">
                  {when(n.startedAt)} · {length(n.seconds || parts.reduce((t, p) => t + p.seconds, 0))}
                  {n.to ? ` · to ${n.to}` : ""}
                </span>
                <span className="text-amber-700 dark:text-amber-400">{held.has(n.cid) ? "on this page now" : n.tries ? `${n.tries} tries, ${inMin(n.nextAt)}` : "waiting to send"}</span>
              </div>
              {n.error && <div className="mt-0.5 text-xs text-muted-foreground">Last answer: {n.error}</div>}
              {parts.length > 0 && <Players parts={parts} label={`Waiting note of ${when(n.startedAt)}`} />}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4" data-testid="on-device-sent">
        <h2 className="text-base font-semibold">Sent, kept here: the last {KEEP_SENT}</h2>
        {!sent.length && <p className="mt-1 text-sm text-muted-foreground">None yet. Each note you send stays here after the console confirms it.</p>}
        <ul className="mt-2 divide-y divide-border">
          {sent.map((r) => (
            <li key={r.cid} className="py-3" data-testid="on-device-sent-note">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">
                  {when(r.startedAt)} · {length(r.seconds)}
                  {r.to ? ` · to ${r.to}` : ""}
                </span>
                <span className="text-emerald-700 dark:text-emerald-400">✓ confirmed {when(r.sentAt)}</span>
              </div>
              <Players parts={r.parts} label={`Note of ${when(r.startedAt)}`} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
