import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Mic, X } from "lucide-react";
import { api } from "@/api";
import type { ScorecardNode, ScorecardRow } from "@/api/pursuit-types";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { TrafficLight, keyResultsOf, krMeasured, lightOf, titleOf } from "@/components/goalSets";
import { splitVoiceReply } from "@/components/ownerPriority";
import { shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { ReplyPlay } from "@/voice/ReplyVoice";
import { cn } from "@/lib/utils";
import { BRIEFING_PARAM, briefingHref, isBriefMe } from "@/lib/briefing";

/**
 * His briefing (the owner, 16 Nov: "there should be somebody, some persona, that helps
 * me with that. It's like it gives me at some point a briefing where it's telling me, these are your objectives and key
 * results, one by one. And I can just talk about it, you know, look at it and talk about it"). The Team desk walks him
 * through his objectives in his order (the social skin: his campaigns), one at a time: the objective and each key
 * result in two plain lines, its number and when it was measured; Play reads it aloud; he answers by voice (or types),
 * and his words are filed on that objective (POST /api/briefing/answer: his words file and a Decisions line on its
 * epic), then the next. Opened by the Briefing button on the objectives screen, `?briefing=1`, or "brief me" in the chat.
 */

export { BRIEFING_PARAM, briefingHref, isBriefMe };

/** the newest time any of its key results was measured. */
function newest(krs: Pick<ScorecardRow, "measuredAt">[]): Pick<ScorecardRow, "measuredAt"> {
  const ts = krs.map((r) => (r.measuredAt ? Date.parse(r.measuredAt) : NaN)).filter(Number.isFinite);
  return ts.length ? { measuredAt: new Date(Math.max(...ts)).toISOString() } : {};
}

/** the objective's two lines: its name, then how many key results are green and when they were measured. */
export function objectiveLines(n: ScorecardNode, place: number): [string, string] {
  const krs = keyResultsOf(n);
  const green = krs.filter((r) => r.state === "green").length;
  const m = krMeasured(newest(krs));
  return [`${place}. ${titleOf(n)}`, krs.length ? `${green} of ${krs.length} key results green, ${m.never ? "nothing measures them yet" : m.words.replace(/^stale: /, "")}.` : "No key results yet."];
}

/** a key result's two lines: what it is, then its number now against its target and when it was measured. */
export function keyResultLines(r: ScorecardRow): [string, string] {
  const m = krMeasured(r);
  const now = r.value ? `${r.value} now` : "no number yet";
  return [r.label, `${now}${r.target ? `, target ${r.target}` : ""}, ${m.never ? "nothing measures this yet" : m.words}.`];
}

/** what Play says: the objective, each key result, then the question. */
export function spoken(n: ScorecardNode, place: number): string {
  const [a, b] = objectiveLines(n, place);
  const krs = keyResultsOf(n).map((r) => keyResultLines(r).join(": "));
  return [`Objective ${a}`, b, ...krs, "What do you think of it?"].join("\n\n");
}

export function Briefing({ nodes, kind, onClose }: { nodes: ScorecardNode[]; kind: "objective" | "campaign"; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [filed, setFiled] = useState<Record<string, true>>({});
  const total = nodes.length;
  const done = i >= total;
  const label = kind === "campaign" ? "campaign" : "objective";
  return (
    <section className="grid min-w-0 gap-3 rounded-xl border bg-card px-3 py-3 sm:px-4" aria-label="Briefing" data-testid="briefing">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="text-base font-semibold" data-testid="briefing-title">
          Briefing{!done && total > 0 && <span className="font-normal text-muted-foreground"> · {i + 1} of {total}</span>}
        </h2>
        <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={onClose} aria-label="Close the briefing" data-testid="briefing-close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {total === 0 && <p className="text-sm text-muted-foreground">No {label}s to brief you on yet.</p>}
      {!done && total > 0 && (
        <BriefingStep
          key={nodes[i].id}
          n={nodes[i]}
          place={i + 1}
          kind={kind}
          filed={!!filed[nodes[i].id]}
          onBack={i > 0 ? () => setI(i - 1) : undefined}
          onNext={(answered) => {
            if (answered) setFiled((f) => ({ ...f, [nodes[i].id]: true }));
            setI(i + 1);
          }}
        />
      )}
      {done && total > 0 && (
        <div className="grid gap-2" data-testid="briefing-end">
          <p className="text-[15px] font-semibold">That was all {total} {label}s.</p>
          <p className="text-sm text-muted-foreground" data-testid="briefing-end-count">
            {Object.keys(filed).length === 0 ? "You answered none this time." : `You answered ${Object.keys(filed).length}: each answer is filed on its ${label}, and its owner reads it on the next wake.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className={PHONE_TAP} onClick={onClose} data-testid="briefing-finish">
              Close
            </Button>
            <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => setI(0)} data-testid="briefing-again">
              From the start
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function BriefingStep({ n, place, kind, filed, onBack, onNext }: { n: ScorecardNode; place: number; kind: "objective" | "campaign"; filed: boolean; onBack?: () => void; onNext: (answered: boolean) => void }) {
  const krs = keyResultsOf(n);
  const [head, sub] = objectiveLines(n, place);
  const [text, setText] = useState("");
  const [state, setState] = useState<{ s: "sending" } | { s: "failed"; why: string }>();
  const sending = state?.s === "sending";
  const files = useChatAttach({ enabled: false, disabled: sending });
  const send = async (reply: string) => {
    const { words, note } = splitVoiceReply(reply);
    if (!words) return;
    setState({ s: "sending" });
    try {
      await api.briefingAnswer({ kind, id: n.milestoneId && kind === "campaign" ? n.milestoneId : n.id, name: titleOf(n), words, ...(note ? { note } : {}) });
      setText("");
      setState(undefined);
      onNext(true);
    } catch (e) {
      setState({ s: "failed", why: e instanceof Error ? e.message : String(e) });
    }
  };
  const voice = useAnswerVoice({
    origin: `briefing:${n.id}`,
    to: shortTo(`briefing: ${titleOf(n)}`),
    page: `briefing on ${titleOf(n)}`.slice(0, 200),
    typed: text,
    deliver: async (reply) => {
      setText("");
      await send(reply);
    },
    disabled: sending,
    big: true,
  });
  return (
    <div className="grid min-w-0 gap-3" data-testid="briefing-step" data-objective={n.id}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-1 shrink-0">
          <TrafficLight light={lightOf(krs)} testId="briefing-light" />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <p className="text-xs text-muted-foreground">Team desk</p>
          <h3 className="text-lg font-semibold leading-snug [overflow-wrap:anywhere]" data-testid="briefing-objective">
            {head}
          </h3>
          <p className="text-sm text-muted-foreground" data-testid="briefing-objective-sub">
            {sub}
          </p>
          <ReplyPlay id={`briefing-${n.id}`} text={spoken(n, place)} />
        </div>
      </div>
      {krs.length > 0 && (
        <ul className="grid min-w-0 gap-0 overflow-hidden rounded-lg border" data-testid="briefing-krs">
          {krs.map((r) => {
            const [a, b] = keyResultLines(r);
            const stale = krMeasured(r).stale;
            return (
              <li key={r.label} className="flex min-w-0 items-start gap-2 border-b px-3 py-2 last:border-b-0" data-testid="briefing-kr" data-state={r.state}>
                <span className="mt-[5px] shrink-0">
                  <TrafficLight light={r.state} size="sm" testId="briefing-kr-light" />
                </span>
                <span className="grid min-w-0">
                  <span className="text-[15px] text-foreground [overflow-wrap:anywhere]" data-testid="briefing-kr-name">
                    {a}
                  </span>
                  <span className={cn("text-sm [overflow-wrap:anywhere]", stale ? "italic text-muted-foreground/70" : "text-muted-foreground")} data-testid="briefing-kr-now">
                    {b}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Mic className="h-4 w-4 text-muted-foreground" aria-hidden /> What do you think of it?
        </p>
        <WordsBox label={`Your words on ${titleOf(n)}`} boxClassName="min-h-16" placeholder="Talk about it, or type. It is filed on this one, then the next comes." value={text} onChange={setText} files={files} voice={voice} testid="briefing-words" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className={PHONE_TAP} disabled={voice.busy || !text.trim()} pending={sending} pendingLabel="Filing…" onClick={() => void send(text)} data-testid="briefing-file">
            File and next
          </Button>
          <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={sending || voice.busy} onClick={() => onNext(false)} data-testid="briefing-skip">
            Next
          </Button>
          {onBack && (
            <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={sending || voice.busy} onClick={onBack} data-testid="briefing-back">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {filed && <span className="text-xs text-muted-foreground" data-testid="briefing-filed">Your words are filed on it.</span>}
          {state?.s === "failed" && (
            <span className="text-xs text-destructive" role="alert" data-testid="briefing-failed">
              Not filed: {state.why}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** the Briefing button and, once pressed (or `?briefing=1`), the briefing in its place. */
export function BriefingSlot({ nodes, kind }: { nodes: ScorecardNode[]; kind: "objective" | "campaign" }) {
  const [params, setParams] = useSearchParams();
  const open = params.get(BRIEFING_PARAM) === "1";
  const set = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set(BRIEFING_PARAM, "1");
    else next.delete(BRIEFING_PARAM);
    setParams(next, { replace: !on });
  };
  if (open) return <Briefing nodes={nodes} kind={kind} onClose={() => set(false)} />;
  if (!nodes.length) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button size="sm" variant="outline" className={PHONE_TAP} onClick={() => set(true)} data-testid="briefing-start">
        <Mic className="h-4 w-4" /> Briefing
      </Button>
      <span className="text-xs text-muted-foreground">Each {kind}, one by one. You answer by voice.</span>
    </div>
  );
}
