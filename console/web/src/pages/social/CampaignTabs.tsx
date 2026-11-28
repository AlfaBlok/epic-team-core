import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArchiveRestore, ExternalLink, Pencil } from "lucide-react";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { Milestone } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { ChatMarkdown } from "@/lib/chatMarkdown";
import { mutate } from "@/lib/data";
import { useSocial, worldId } from "@/lib/useSocial";
import { BriefPage } from "@/pages/Brief";
import { DirectionsPage } from "./Directions";
import { OnePagerPanel, planWithoutOnePager } from "./OnePager";

/**
 * the brief and the directions belong to a campaign, so they
 * live on its page. The header names the repo and the file it edits; the bodies are today's Directions and Campaign brief
 * screens, fed this campaign's repo (CampaignProvider) instead of the world's first social repo.
 */
export function BriefDirectionsTab({ card }: { card: CampaignCard }) {
  const where = card.remote ?? card.repo;
  return (
    <div className="grid gap-6" data-testid="brief-directions">
      {/* the campaign one-pager on top, then the rest of its plan. */}
      {card.campaign && card.milestoneId && <OnePagerPanel card={card} milestoneId={card.milestoneId} />}
      {card.campaign && card.milestoneId && <CampaignPlanPanel card={card} milestoneId={card.milestoneId} />}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-testid="brief-source">
        <span className="min-w-0 flex-1">
          {card.campaign ? "The brief every campaign of this repo shares" : "This campaign's brief"}, from <span className="font-mono text-xs">{where}</span> · <span className="font-mono text-xs">data/brief.md</span>
        </span>
        {card.remote && (
          <Button asChild size="sm" variant="outline">
            <a href={`https://github.com/${card.remote}/blob/HEAD/data/brief.md`} target="_blank" rel="noreferrer">
              <ExternalLink /> Open in GitHub
            </a>
          </Button>
        )}
      </div>
      <DirectionsPage />
      <BriefPage />
    </div>
  );
}

/**
 * a named campaign's plan, the `## Campaign plan` of its spine (platform, period, key messages, voice,
 * posting and reply style, targets, personas and cadence), at the top of its Brief tab. Edit plan replaces that section,
 * committed as the owner; the personas read it from their next wake.
 */
export function CampaignPlanPanel({ card, milestoneId }: { card: CampaignCard; milestoneId: string }) {
  const { data, error, loading } = useSocial();
  const [edit, setEdit] = useState<string | null>(null);
  const [saved, setSaved] = useState<string>();
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const c = card.campaign!;
  const plan = saved ?? data?.campaign?.plan;
  const save = async () => {
    if (edit == null || !edit.trim()) return;
    setBusy(true);
    setNote(undefined);
    try {
      await mutate(async () => api.setCampaignPlan(await worldId(), milestoneId, edit));
      setSaved(edit.trim());
      setEdit(null);
      setNote({ ok: true, text: "Plan saved and committed as you. Its personas work to it from their next wake." });
    } catch (e) {
      setNote({ ok: false, text: `Not saved: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-3 rounded-lg border p-4" data-testid="campaign-plan">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold">Plan</h2>
        <span className="text-xs text-muted-foreground" data-testid="campaign-plan-source">
          {[c.platform, c.period].filter(Boolean).join(" · ")}
          {c.platform || c.period ? " · " : ""}
          <span className="font-mono">{c.path}</span> · tag <span className="font-mono">{c.code}</span>
        </span>
        {edit == null && (
          <Button size="sm" variant="outline" disabled={!plan} onClick={() => setEdit(plan ?? "")} data-testid="campaign-plan-edit">
            <Pencil /> Edit plan
          </Button>
        )}
      </div>
      {edit != null ? (
        <div className="grid gap-2">
          <Textarea rows={18} value={edit} onChange={(e) => setEdit(e.target.value)} className="font-mono text-xs" data-testid="campaign-plan-text" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !edit.trim()} pending={busy} pendingLabel="Saving…" onClick={save} data-testid="campaign-plan-save">
              Save plan
            </Button>
          </div>
        </div>
      ) : loading && !plan ? (
        <div className="text-sm text-muted-foreground">Loading the plan…</div>
      ) : error && !plan ? (
        <div className="text-sm text-destructive">The plan did not load: {error.message}</div>
      ) : (
        <div className="min-w-0 text-sm [overflow-wrap:anywhere]" data-testid="campaign-plan-body">
          <ChatMarkdown text={planWithoutOnePager(plan ?? "")} />
        </div>
      )}
      {note && (
        <div role="status" className={note.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {note.text}
        </div>
      )}
    </section>
  );
}

/**
 * Rename and Retire on a campaign's page. Rename changes its name everywhere (the spine's title too; the tag on
 * its posts stays). Retire pauses it and hides it from the menu; nothing is deleted, its held posts stay held, and Add
 * campaign or job lists it under Retired campaigns with Restore.
 */
export function CampaignActions({ m, card }: { m: Milestone; card: CampaignCard }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<"rename" | "retire" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const shown = card.campaign?.name ?? m.title;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      setOpen(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rename = () => run(async () => void (await mutate(async () => api.renameCampaign(await worldId(), m.id, name.trim()))));
  const retire = () =>
    run(async () => {
      await mutate(async () => api.retireCampaign(await worldId(), m.id));
      navigate("/");
    });
  const restore = () => run(async () => void (await mutate(async () => api.restoreCampaign(await worldId(), m.id))));
  return (
    <>
      <Button size="sm" variant="outline" data-testid="campaign-rename" onClick={() => (setName(shown), setErr(undefined), setOpen("rename"))}>
        <Pencil /> Rename
      </Button>
      {/* Iteration 2: a retired campaign's own page offers Restore (it said Retire again). */}
      {card.retired ? (
        <Button size="sm" variant="outline" data-testid="campaign-restore" disabled={busy} pending={busy} pendingLabel="Restoring…" onClick={restore} title="Back in the menu, pinned, with its personas on again">
          <ArchiveRestore /> Restore
        </Button>
      ) : (
        <Button size="sm" variant="outline" data-testid="campaign-retire" onClick={() => (setErr(undefined), setOpen("retire"))}>
          <Archive /> Retire
        </Button>
      )}
      {err && !open && <span className="self-center text-xs text-destructive">{err}</span>}
      <Dialog open={open != null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          {open === "rename" ? (
            <>
              <DialogHeader>
                <DialogTitle>Rename objective</DialogTitle>
                <DialogDescription>The new name shows in the menu and on its page{card.campaign ? `, and becomes the title of ${card.campaign.path}. Its posts keep their tag ${card.campaign.code}.` : "."}</DialogDescription>
              </DialogHeader>
              <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Campaign name" data-testid="campaign-rename-input" />
            </>
          ) : (
            <DialogHeader>
              <DialogTitle>Retire &ldquo;{shown}&rdquo;?</DialogTitle>
              <DialogDescription>
                It is paused (its personas stop waking for it) and leaves the menu. Nothing is deleted: its posts, held drafts and repo stay as they are. Restore it any time from Add campaign or job.
              </DialogDescription>
            </DialogHeader>
          )}
          {err && <div className="text-sm text-destructive">{err}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            {open === "rename" ? (
              <Button disabled={busy || !name.trim() || name.trim() === shown} pending={busy} pendingLabel="Renaming…" onClick={rename} data-testid="campaign-rename-save">
                Rename
              </Button>
            ) : (
              <Button disabled={busy} pending={busy} pendingLabel="Retiring…" onClick={retire} data-testid="campaign-retire-confirm">
                Retire
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
