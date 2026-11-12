import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, Stamp } from "lucide-react";
import { api, type MarkVerdict, type Milestone, type MilestoneStatusView } from "@/api";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { doneRows } from "@/components/outcome";
import { liveWorkers, StateWord } from "@/components/status";
import { StampButton } from "@/components/planning";
import { canSettle } from "@/lib/derive";
import { mutate } from "@/lib/data";
import { cn } from "@/lib/utils";
import { useWords } from "@/lib/skin";
import { ownerName } from "@/lib/identity";

/**
 * the two marks in the milestone header, never one blended word. OUTCOME (did the goal get met; only the owner
 * marks it) and FLOW (what is happening now). The spine's own Status word moved to the tooltip and Settings.
 */
type OutcomeWord = MilestoneStatusView["outcome"]["word"];
export const OUTCOME_HEADER: Record<OutcomeWord, string> = {
  not_yet: "Not accomplished yet",
  ready_to_mark: "Ready to mark",
  accomplished: "Accomplished",
  partially: "Partially accomplished",
  superseded: "Superseded",
  reopened: "Reopened",
};
const OUTCOME_TONE: Record<OutcomeWord, BadgeProps["variant"]> = {
  not_yet: "gray",
  ready_to_mark: "green",
  accomplished: "green",
  partially: "amber",
  superseded: "gray",
  reopened: "amber",
};

/** "Accomplished 2026-10-24" from the spine's written Outcome (the history a reopened mark keeps). */
export function markHistory(m: Pick<Milestone, "outcome">): string | undefined {
  const v = m.outcome?.verdict;
  if (!v) return undefined;
  return `${v[0].toUpperCase()}${v.slice(1)}${m.outcome?.closedAt ? ` ${m.outcome.closedAt.slice(0, 10)}` : ""}${m.outcome?.closedBy ? ` by ${m.outcome.closedBy}` : ""}`;
}

export function HeaderMarks({ m, status, treeHref }: { m: Milestone; status?: MilestoneStatusView; treeHref: string }) {
  const spine = `spine Status: ${m.status && m.status !== "unknown" ? m.status : "none"}`;
  const o = status?.outcome;
  const label = o ? `${OUTCOME_HEADER[o.word]}${o.word === "reopened" && o.open ? ` · ${o.open} open` : ""}` : "…";
  const title = [o?.note, o?.word === "reopened" && markHistory(m) && `was ${markHistory(m)}`, spine].filter(Boolean).join(" · ");
  const badge = (
    <Badge
      variant={o ? OUTCOME_TONE[o.word] : "gray"}
      className={cn("px-3 py-1 text-sm", o?.word === "ready_to_mark" && "border-dashed border-emerald-500/60")}
      title={title}
      data-testid="outcome-badge"
      data-outcome={o?.word ?? "loading"}
    >
      <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">Outcome</span>
      {label}
    </Badge>
  );
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="header-marks">
      {o?.word === "reopened" ? (
        <a href={treeHref} className="hover:opacity-80">
          {badge}
        </a>
      ) : (
        badge
      )}
      <span className="inline-flex items-center rounded-md border px-3 py-1" title={[status?.flow.reason, spine].filter(Boolean).join(" · ")} data-testid="flow-badge">
        <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Flow</span>
        <StateWord word={status?.flow.word ?? "loading"} live={liveWorkers(status)} className="text-sm" />
      </span>
      {/* only the owner releases a Planning epic (and can take a ready, not yet started one back). */}
      {status?.flow.word === "planning" ? <StampButton milestoneId={m.id} to="ready" /> : m.runState === "ready" ? <StampButton milestoneId={m.id} to="draft" /> : null}
    </span>
  );
}

const CHOICES: { v: MarkVerdict; label: string; hint: string }[] = [
  { v: "accomplished", label: "Accomplished", hint: "the goal is met; Status becomes done and it settles" },
  { v: "partially", label: "Partially", hint: "part of the goal is met; it settles" },
  { v: "not_accomplished", label: "Not accomplished", hint: "the goal is not met; no Settle" },
  { v: "superseded", label: "Superseded", hint: "replaced by another goal; Status becomes superseded and it settles" },
];

/** the owner's mark: verdict, outcome sentence, risk, a note, and the Done means / evidence table (prefilled). */
export function MarkDialog({ m, onClose }: { m: Milestone; onClose: () => void }) {
  const w = useWords();
  const rows = doneRows(m, m.outcome);
  const [verdict, setVerdict] = useState<MarkVerdict>("accomplished");
  const [sentence, setSentence] = useState(m.outcome?.sentence ?? "");
  const [risk, setRisk] = useState(m.outcome?.risk ?? "");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState(rows.map((r) => ({ doneMeans: r.label, evidence: (r.links ?? []).join(", "), done: r.done })));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await mutate(() => api.markMilestone(m.id, { verdict, sentence, risk, note, evidence: evidence.map(({ doneMeans, evidence }) => ({ doneMeans, evidence })) }));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mark the outcome</DialogTitle>
          <DialogDescription>Writes the spine's ## Outcome (Closed by {ownerName()}) and a Decisions row, commits and pushes it. Accomplished, Partially or Superseded also settles the {w.milestone}, so its personas stop waking (Unsettle in Settings).</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} data-testid="mark-dialog">
          <fieldset className="grid gap-1.5 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium">Verdict</legend>
            {CHOICES.map((c) => (
              <label key={c.v} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm", verdict === c.v && "border-sky-500 bg-sky-500/5")}>
                <input type="radio" name="verdict" value={c.v} checked={verdict === c.v} onChange={() => setVerdict(c.v)} className="mt-1" />
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className="block text-xs text-muted-foreground">{c.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Outcome (one sentence)</span>
            <Textarea aria-label="Outcome sentence" rows={2} required value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="What was achieved" />
          </label>
          <div className="grid gap-1 text-sm">
            <span className="font-medium">Done means and evidence</span>
            {evidence.length === 0 && <span className="text-xs text-muted-foreground">The spine lists no Done means.</span>}
            <table className="w-full text-sm" data-testid="mark-evidence">
              <tbody>
                {evidence.map((r, i) => (
                  <tr key={i} className="border-t align-top">
                    <td className="w-1/2 py-1.5 pr-2">
                      <span className={cn(r.done === false && "text-amber-700 dark:text-amber-400")}>{r.done === false ? "☐ " : r.done ? "☑ " : ""}{r.doneMeans}</span>
                    </td>
                    <td className="py-1.5">
                      <Input aria-label={`Evidence for ${r.doneMeans}`} value={r.evidence} onChange={(e) => setEvidence(evidence.map((x, k) => (k === i ? { ...x, evidence: e.target.value } : x)))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Risk</span>
            <Input aria-label="Risk" value={risk} onChange={(e) => setRisk(e.target.value)} placeholder="none" />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Note (Decisions row)</span>
            <Input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
          </label>
          {error && <div className="text-sm text-destructive" role="alert">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !sentence.trim()} pending={busy} pendingLabel="Marking…">
              <Stamp /> Mark {CHOICES.find((c) => c.v === verdict)!.label.toLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mark + Settle row on the Summary tab: Settle stays disabled with the reason until the outcome is marked. */
export function MarkAndSettle({ m, status, openMark }: { m: Milestone; status?: MilestoneStatusView; openMark: () => void }) {
  const navigate = useNavigate();
  const w = useWords();
  if (m.settledAt) return null;
  const ok = canSettle(status);
  const word = status?.outcome.word;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="mark-settle">
      {!ok && <span className="text-xs text-muted-foreground" data-testid="settle-reason">not accomplished yet{word === "reopened" ? `: ${status?.outcome.open ?? "some"} open under it` : ""}</span>}
      <Button variant={word === "ready_to_mark" ? "default" : "outline"} size="sm" onClick={openMark} title={`Only ${ownerName()} marks: writes the spine's ## Outcome`}>
        <Stamp /> {word === "ready_to_mark" ? "Review and mark" : ok ? "Re-mark" : "Mark outcome"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ok}
        title={ok ? `Hide this ${w.milestone} from the sidebar and Team home. Its status and spine are not changed; undo in Settings.` : "not accomplished yet: mark the outcome first"}
        onClick={async () => {
          await mutate(() => api.settleMilestone(m.id));
          navigate("/");
        }}
      >
        <Archive /> Settle
      </Button>
    </div>
  );
}
