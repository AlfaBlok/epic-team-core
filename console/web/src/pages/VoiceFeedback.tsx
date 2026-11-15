import { useRef, useState, type FormEvent } from "react";
import { Copy, Loader2, Plus } from "lucide-react";
import { api } from "@/api";
import type { FeedbackLink, FeedbackNoteView, FiledFeedback } from "@/api/types";
import { mutate, useQuery } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty, ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { githubRepoUrl, homeRepo, socialProduct, siteDomain } from "@/lib/identity";
import { FEEDBACK_PATH } from "@/lib/routePaths";
export { FEEDBACK_PATH };

/**
 * customers and testers leave voice notes through their own link; each one is
 * transcribed (the audio is dropped), summed up and filed in the repo as feedback/voice/<day>-<id>.md, where the team
 * reads it. Here the owner makes a link for someone, copies it to send, and reads every filed item: who, summary, asks, bugs.
 */

const SENTIMENT: Record<string, string> = { positive: "bg-emerald-600 text-white", mixed: "bg-amber-500 text-white", negative: "bg-red-600 text-white", neutral: "bg-slate-500 text-white" };

export function VoiceFeedbackPage() {
  const { data, error, loading } = useQuery(() => api.listFeedback(), []);
  const [show, setShow] = useState(20);
  const filed = data?.filed ?? [];
  const inFlight = (data?.notes ?? []).filter((n) => n.state === "transcribed" || n.state === "recording");
  return (
    <div>
      <PageHeader
        title="Voice feedback"
        description={
          <>
            Make a link for a tester or customer and send it. They tap one button and talk. Nobody listens: the voice is turned into text and thrown away.
            Each note is summed up and filed in {data?.repo ?? "the repo"} under {data?.dir ?? "feedback/voice"}, where the team reads it, and you get one note on the Team desk.
          </>
        }
      />
      {data && !data.public && (
        <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100" data-testid="feedback-not-public">
          The links open only inside our private network for now. Strangers can use them once you say yes to opening them on signup.{siteDomain()}.
        </p>
      )}
      <NewLink />
      {error ? (
        <ErrorBox error={error} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <>
          <h2 className="mb-2 mt-6 text-lg font-semibold">Feedback received ({filed.length})</h2>
          {inFlight.length > 0 && (
            <p className="mb-2 text-sm text-muted-foreground" data-testid="feedback-inflight">
              {inFlight.length} note{inFlight.length === 1 ? "" : "s"} still being recorded or filed.
            </p>
          )}
          {!filed.length ? (
            <Empty>No voice feedback yet.</Empty>
          ) : (
            <div className="space-y-3" data-testid="feedback-items">
              {filed.slice(0, show).map((f) => (
                <FiledCard key={f.file} item={f} note={data?.notes.find((n) => f.file === n.file)} repo={data?.repo} />
              ))}
              {filed.length > show && (
                <Button variant="outline" size="sm" onClick={() => setShow(filed.length)}>
                  Show all {filed.length}
                </Button>
              )}
            </div>
          )}
          <h2 className="mb-2 mt-6 text-lg font-semibold">Links ({data?.links.length ?? 0})</h2>
          {!data?.links.length ? <Empty>No links yet.</Empty> : <div className="space-y-2">{data.links.map((l) => <LinkRow key={l.id} link={l} />)}</div>}
        </>
      )}
    </div>
  );
}

/**
 * the button was greyed out
 * until the unlabelled first box held a name, and nothing said so. Now every box has a label, the button is never greyed
 * out (an empty name gets a plain line and the cursor), Enter makes the link, and the result shows the link with Copy
 * link, Copy message (the suggested message with the link in it) and Open.
 */
export function suggestedMessage(l: Pick<FeedbackLink, "product" | "url">): string {
  return `Could you leave us a voice note about ${l.product} once a week? Open this link, tap the button and talk, a minute is plenty. Nobody listens to the audio: it becomes text for our team and is thrown away. ${l.url}`;
}

function NewLink() {
  const [who, setWho] = useState("");
  const [product, setProduct] = useState(socialProduct);
  const [campaign, setCampaign] = useState("testers");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [made, setMade] = useState<FeedbackLink>();
  const whoRef = useRef<HTMLInputElement>(null);
  const make = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!who.trim()) {
      setErr("Type their name first: who is this link for?");
      whoRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(undefined);
    try {
      const l = await mutate(() => api.createFeedbackLink({ who: who.trim(), product: product.trim() || undefined, campaign: campaign.trim() || undefined }));
      setMade(l);
      setWho("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = "w-full rounded border bg-background px-3 py-2 text-base sm:text-sm";
  return (
    <Card id="new-link" data-testid="feedback-new">
      <CardContent className="space-y-3 p-4">
        <div className="text-lg font-semibold">Make a new link</div>
        <form className="space-y-3" onSubmit={(e) => void make(e)} noValidate>
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Their name</span>
              <input
                ref={whoRef}
                className={field}
                placeholder="e.g. Ana or ana@example.com"
                value={who}
                onChange={(e) => {
                  setWho(e.target.value);
                  if (err) setErr(undefined);
                }}
                aria-label="Their name"
                autoComplete="off"
                enterKeyHint="go"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">
                Product <span className="font-normal text-muted-foreground">optional</span>
              </span>
              <input className={field} value={product} onChange={(e) => setProduct(e.target.value)} aria-label="Product" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">
                Campaign <span className="font-normal text-muted-foreground">optional</span>
              </span>
              <input className={field} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label="Campaign" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={busy} data-testid="feedback-make">
              {busy ? <Loader2 className="animate-spin" /> : <Plus />} {busy ? "Making the link…" : "Make the link"}
            </Button>
            {err && (
              <span className="text-sm text-destructive" role="alert" data-testid="feedback-error">
                {err}
              </span>
            )}
          </div>
        </form>
        {made && (
          <div className="space-y-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm dark:bg-emerald-950" data-testid="feedback-made">
            <div className="font-medium">Link for {made.who} is ready. Send them this message:</div>
            <p className="rounded bg-background p-2 italic" data-testid="feedback-message">
              {suggestedMessage(made)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={suggestedMessage(made)} label="Copy message" testId="feedback-copy-message" />
              <CopyLink url={made.url} />
              <a className="text-sm underline" href={made.url} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy /> {copied ? "Copied" : label}
    </Button>
  );
}

function CopyLink({ url }: { url: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded bg-muted px-2 py-1 text-xs">{url}</code>
      <CopyButton text={url} label="Copy link" />
    </div>
  );
}

function LinkRow({ link: l }: { link: FeedbackLink }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const revoke = async () => {
    if (!window.confirm(`Turn off ${l.who}'s link? It stops taking notes; what they sent stays.`)) return;
    setBusy(true);
    try {
      await mutate(() => api.revokeFeedbackLink(l.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="feedback-link">
      <CardContent className="space-y-1 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{l.who}</span>
          <span className="text-muted-foreground">
            {l.product} · {l.campaign} · {l.notes} note{l.notes === 1 ? "" : "s"}
            {l.lastNoteAt ? (
              <>
                , last <RelTime iso={l.lastNoteAt} />
              </>
            ) : null}
          </span>
          {l.revokedAt && <Badge variant="outline">off</Badge>}
        </div>
        {!l.revokedAt && (
          <div className="flex flex-wrap items-center gap-2">
            <CopyLink url={l.url} />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke()}>
              {busy ? "Turning off…" : "Turn off"}
            </Button>
            {err && <span className="text-destructive">{err}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FiledCard({ item: f, note, repo }: { item: FiledFeedback; note?: FeedbackNoteView; repo?: string }) {
  const sentiment = f.fields.sentiment ?? "unknown";
  const gh = repo === homeRepo() ? `${githubRepoUrl()}/blob/main/${f.file}` : undefined;
  return (
    <Card data-testid="feedback-item">
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{f.fields.from}</span>
          <span className="text-muted-foreground">
            {f.fields.product} · {f.fields.campaign} · {Math.round(Number(f.fields.length_s ?? 0) / 6) / 10} min · <RelTime iso={f.fields.received} />
          </span>
          <Badge className={SENTIMENT[sentiment] ?? ""}>{sentiment}</Badge>
          {f.fields.status && f.fields.status !== "new" && <Badge variant="outline">{f.fields.status}</Badge>}
        </div>
        <p>{f.summary}</p>
        {f.asks.length > 0 && (
          <div>
            <div className="font-medium">Asks</div>
            <ul className="list-disc pl-5">
              {f.asks.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        {f.bugs.length > 0 && (
          <div>
            <div className="font-medium text-destructive">Bugs</div>
            <ul className="list-disc pl-5">
              {f.bugs.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {gh ? (
            <a className="underline" href={gh} target="_blank" rel="noreferrer">
              {f.file}
            </a>
          ) : (
            f.file
          )}
          {note?.toldAt ? " · told on your Team desk" : ""}
        </div>
      </CardContent>
    </Card>
  );
}
