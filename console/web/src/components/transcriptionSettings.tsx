import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Settings holds what he changes: the
 * model (ours first) and the paid backup on or off; the model in use and the last 30 days' cost sit beside his choice.
 */
export interface TranscriptionView {
  settings: { model: string; paidBackup: boolean };
  models: { id: string; label: string; kind: "ours" | "paid" | "grant"; note: string }[];
  /** the model test behind the accuracy and speed lines, and its page when the site has one. */
  benchmark?: { summary: string; url?: string };
  inUse?: { model: string; provider: string; at: string };
  last30: { usd: number; minutes: number; lines: { provider: string; model: string; parts: number; minutes: number; usd: number; credits?: number }[]; serverMinutes: number; backupParts: number; credits?: number; grantCredits?: number };
  calls: { on: boolean; count: number; usd: number };
}

const money = (v: number) => `$${v.toFixed(2)}`;
const WHO: Record<string, string> = { local: "our server, free", gemini: "paid", openai: "paid", elevenlabs: "from your grant" };
const modelName = (m: string) =>
  m.startsWith("whisper-") ? `Whisper ${m.slice(8)}` : m.startsWith("scribe") ? "ElevenLabs Scribe" : m === "gemini-flash-latest" ? "Gemini Flash" : m === "gpt-4o-mini-transcribe" ? "OpenAI gpt-4o-mini-transcribe" : m;
const count = (n: number) => Math.round(n).toLocaleString("en-US");

export function TranscriptionSettings(props: { load?: () => Promise<TranscriptionView | undefined>; save?: (b: Partial<TranscriptionView["settings"]>) => Promise<TranscriptionView> }) {
  const [v, setV] = useState<TranscriptionView | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const load =
    props.load ??
    (async () => {
      try {
        const r = await fetch("/api/voice/transcription");
        return r.ok ? ((await r.json()) as TranscriptionView) : undefined;
      } catch {
        return undefined;
      }
    });
  const save =
    props.save ??
    (async (b: Partial<TranscriptionView["settings"]>) => {
      const r = await fetch("/api/voice/transcription", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? `could not save (${r.status})`);
      return j as TranscriptionView;
    });
  useEffect(() => {
    void load().then(setV);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return null;
  const change = async (b: Partial<TranscriptionView["settings"]>) => {
    setBusy(true);
    setErr(undefined);
    try {
      setV(await save(b));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const grant = v.last30.lines.filter((l) => l.provider === "elevenlabs");
  const ours = v.last30.lines.filter((l) => l.provider === "local");
  const paid = v.last30.lines.filter((l) => l.provider !== "local" && l.provider !== "elevenlabs");
  return (
    <section id="transcription" className="mt-6 scroll-mt-20" data-testid="transcription-settings">
      <h2 className="mb-3 text-[15px] font-semibold">Transcription</h2>
      <div className="divide-y rounded-xl border bg-card">
        <fieldset className="px-4 py-3" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Model for your voice notes</legend>
          <div className="grid gap-1">
            {v.models.map((m) => (
              <label key={m.id} className={cn("flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/50 max-sm:min-h-11", v.settings.model === m.id && "bg-accent/40")} data-testid={`transcription-model-${m.id}`}>
                <input type="radio" name="transcription-model" className="mt-1 accent-current" checked={v.settings.model === m.id} onChange={() => void change({ model: m.id })} />
                <span className="min-w-0">
                  <span className="block text-sm">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">{m.note}</span>
                </span>
              </label>
            ))}
          </div>
          {v.benchmark && (
            <p className="mt-2 px-2 text-xs text-muted-foreground" data-testid="transcription-benchmark">
              {v.benchmark.summary}{" "}
              {v.benchmark.url && (
                <a href={v.benchmark.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                  See the results
                </a>
              )}
            </p>
          )}
        </fieldset>
        <label className="flex cursor-pointer items-center gap-3 px-4 py-3 max-sm:min-h-11">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Paid backup when ours fails</span>
            <span className="block text-xs text-muted-foreground">
              {v.settings.model === "elevenlabs" ? "Our Whisper writes out a note ElevenLabs cannot. " : ""}
              {v.settings.paidBackup ? "On: Gemini writes out a note our server cannot, and you get a message each time." : "Off: a note our server cannot write out reaches the desk with its audio link, and you get a message."}
            </span>
          </span>
          <Switch className="!min-h-0 !min-w-0" checked={v.settings.paidBackup} disabled={busy || v.settings.model === "gemini"} onCheckedChange={(on) => void change({ paidBackup: on })} data-testid="transcription-backup" aria-label="Paid backup when ours fails" />
        </label>
        <div className="grid gap-1 px-4 py-3 text-sm" data-testid="transcription-cost">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <span className="text-muted-foreground">In use now</span>
            <span data-testid="transcription-in-use">{v.inUse ? `${modelName(v.inUse.model)}, ${WHO[v.inUse.provider] ?? v.inUse.provider}` : "none yet"}</span>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <span className="text-muted-foreground">Last 30 days</span>
            <span className="font-medium tabular-nums" data-testid="transcription-30d">
              {money(v.last30.usd)} for {Math.round(v.last30.minutes)} min
            </span>
          </div>
          <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
            {grant.map((l) => (
              <li key={l.model} className="flex justify-between gap-4" data-testid="transcription-grant">
                <span>{modelName(l.model)}, from your grant</span>
                <span className="tabular-nums">
                  {count(l.credits ?? 0)} credits · {Math.round(l.minutes)} min
                </span>
              </li>
            ))}
            {grant.length > 0 && v.last30.grantCredits ? (
              <li className="flex justify-between gap-4" data-testid="transcription-grant-left">
                <span>Grant used by notes</span>
                <span className="tabular-nums">
                  {count(v.last30.credits ?? 0)} of {count(v.last30.grantCredits)}
                </span>
              </li>
            ) : null}
            {ours.map((l) => (
              <li key={l.model} className="flex justify-between gap-4">
                <span>{modelName(l.model)}, our server</span>
                <span className="tabular-nums">$0.00 · {Math.round(l.minutes)} min</span>
              </li>
            ))}
            {ours.length > 0 && (
              <li className="flex justify-between gap-4" data-testid="transcription-server-time">
                <span>Our server's working time</span>
                <span className="tabular-nums">{Math.max(1, Math.round(v.last30.serverMinutes))} min, free</span>
              </li>
            )}
            {paid.map((l) => (
              <li key={`${l.provider}-${l.model}`} className="flex justify-between gap-4">
                <span>{modelName(l.model)}</span>
                <span className="tabular-nums">
                  {money(l.usd)} · {Math.round(l.minutes)} min
                </span>
              </li>
            ))}
            <li className="flex justify-between gap-4" data-testid="transcription-calls">
              <span>Voice calls, {v.calls.on ? "on" : "now off"}</span>
              <span className="tabular-nums">
                {money(v.calls.usd)} · {v.calls.count} calls
              </span>
            </li>
          </ul>
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </section>
  );
}
