import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/api";
import { ApiError } from "@/api/real";
import type { Cadence, SocialData, SocialExport, SocialWriteResult } from "@/api/types";
import { invalidate, useQuery } from "@/lib/data";
import { useSocial } from "@/lib/useSocial";
import { useCampaignScope } from "@/lib/campaign";
import { formatCadence, WEEKDAY_SHORT } from "@/lib/format";
import {
  briefInput,
  changedSections,
  formatsTotal,
  formFromExport,
  formProblems,
  personaCadences,
  WEIGHTS,
  type BriefForm,
  type PersonaCadence,
} from "@/lib/brief";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { BRIEF_PATH } from "@/lib/routePaths";
export { BRIEF_PATH };

/**
 * the Campaign brief, the standing layer every team member reads on every wake. Each field
 * shows where it lives (root spine, message house, brief.md, console assignments); one Save writes the changed sections
 * through the `brief` write action (one commit as the owner) and shows the pack's 422 issue lines inline. Below it, the
 * Assets library (data/assets.md with computed "used by") and an upload to data/assets/. Social skin only.
 */
export const BRIEF_LABEL = "Objective brief";

const ASSET_KINDS = ["diagram", "screenshot", "clip", "video", "logo"] as const;

/** The newer of two exports (a write's answer vs the refetched query). */
const newer = (a?: SocialData, b?: SocialData) => (!a ? b : !b ? a : a.data.generatedAt >= b.data.generatedAt ? a : b);

function Block({ title, where, children, testId, wide }: { title: string; where: string; children: ReactNode; testId: string; wide?: boolean }) {
  return (
    <Card className={`min-w-0 p-4 ${wide ? "lg:col-span-2" : ""}`} data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{where}</span>
      </div>
      {children}
    </Card>
  );
}

function RowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} onClick={onClick} className="shrink-0">
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} className="mt-2">
      <Plus className="mr-1 h-4 w-4" />
      {label}
    </Button>
  );
}

/** Issue lines from a failed write: the pack's (422) every line, else the message. */
function Issues({ error, testId }: { error?: Error; testId: string }) {
  if (!error) return null;
  const lines = error instanceof ApiError && error.issues?.length ? error.issues : [error.message];
  return (
    <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid={testId} role="alert">
      {error instanceof ApiError && error.issues?.length ? <div className="mb-1 font-medium">{error.message}</div> : null}
      <ul className="list-disc space-y-0.5 pl-5">
        {lines.map((l, i) => (
          <li key={i} data-testid={`${testId}-line`}>
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Post ids as links: a live post opens on its platform; one without a link shows its id. */
function PostRefs({ ids, data }: { ids: string[]; data: SocialExport }) {
  if (!ids.length) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const p = data.posts.find((x) => x.id === id);
        return p?.link ? (
          <a key={id} href={p.link} target="_blank" rel="noreferrer" className="rounded bg-muted px-1.5 font-mono text-xs underline" title={p.title ?? undefined}>
            {id}
          </a>
        ) : (
          <span key={id} className="rounded bg-muted px-1.5 font-mono text-xs" title={p ? `${p.status ?? ""} · ${p.title ?? ""}` : "not in the posts ledger"}>
            {id}
          </span>
        );
      })}
    </span>
  );
}

function CadenceEditor({ value, onChange, persona }: { value: Cadence; onChange: (c: Cadence) => void; persona: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={`${persona} cadence type`}
        className="w-auto"
        value={value.type}
        onChange={(e) => onChange(e.target.value === "interval" ? { type: "interval", everyMinutes: 120 } : { type: "fixed_time", timeOfDay: "10:00", weekdays: [1, 2, 3, 4, 5] })}
      >
        <option value="interval">every</option>
        <option value="fixed_time">at a time</option>
      </NativeSelect>
      {value.type === "interval" ? (
        <label className="flex items-center gap-1 text-sm">
          <Input
            aria-label={`${persona} every minutes`}
            type="number"
            min={1}
            className="w-24"
            value={value.everyMinutes}
            onChange={(e) => onChange({ type: "interval", everyMinutes: Math.floor(Number(e.target.value)) })}
          />
          min
        </label>
      ) : (
        <>
          <Input aria-label={`${persona} time`} type="time" className="w-28" value={value.timeOfDay} onChange={(e) => onChange({ ...value, timeOfDay: e.target.value })} />
          <span className="flex flex-wrap gap-0.5">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const on = value.weekdays.includes(d);
              return (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  className="h-7 px-1.5 text-xs"
                  aria-pressed={on}
                  onClick={() => onChange({ ...value, weekdays: on ? value.weekdays.filter((x) => x !== d) : [...value.weekdays, d].sort((a, b) => a - b) })}
                >
                  {WEEKDAY_SHORT[d]}
                </Button>
              );
            })}
          </span>
        </>
      )}
    </div>
  );
}

function AssetsLibrary({ social, onUploaded }: { social: SocialData; onUploaded: (r: SocialWriteResult) => void }) {
  const d = social.data;
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [done, setDone] = useState<string>();

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api.socialUpload(social.tenantId, { file, ...(kind ? { kind: kind as (typeof ASSET_KINDS)[number] } : {}), ...(source.trim() ? { source: source.trim() } : {}) }, social.repo ?? undefined);
      onUploaded(r);
      setDone(`${String(r.info?.id ?? r.id)} added${r.commit ? ` · commit ${r.commit.slice(0, 7)}` : ""}`);
      setFile(undefined);
      setSource("");
      setKind("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Block title={`Assets library · ${d.assets.length}`} where="data/assets.md + data/assets/" testId="brief-assets" wide>
      {d.assets.length === 0 ? (
        <Empty>No assets yet: upload a diagram, screenshot, clip or logo.</Empty>
      ) : (
        <ul className="divide-y text-sm">
          {d.assets.map((a) => (
            <li key={a.id ?? a._line} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-2" data-testid="asset-row">
              <span className="w-20 shrink-0 text-xs uppercase text-muted-foreground">{a.kind}</span>
              <span className="font-mono text-xs">{a.id}</span>
              <span className="min-w-0 flex-1 break-words">
                {a.source || <span className="text-muted-foreground">{a.file}</span>}
                {a.source && <span className="ml-2 break-all text-xs text-muted-foreground">{a.file}</span>}
              </span>
              <span className="text-xs text-muted-foreground">{a.made_by}</span>
              <span className="flex items-center gap-1 text-xs" data-testid="asset-used-by">
                used by <PostRefs ids={a.used_by} data={d} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        <input ref={fileRef} type="file" accept="image/*,video/*,.svg" aria-label="Asset file" className="max-w-full text-sm" onChange={(e) => setFile(e.target.files?.[0])} />
        <NativeSelect aria-label="Asset kind" className="w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">kind: from the file</option>
          {ASSET_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </NativeSelect>
        <Input aria-label="Asset description" placeholder="what it shows" className="w-56 max-w-full" value={source} onChange={(e) => setSource(e.target.value)} />
        <Button type="button" size="sm" disabled={!file || busy} onClick={upload}>
          <Upload className="mr-1 h-4 w-4" />
          {busy ? "Uploading…" : "Upload"}
        </Button>
        {done && (
          <span className="text-xs text-muted-foreground" data-testid="upload-done">
            {done}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Images and video up to 25 MB; saved to data/assets/ and committed as you. "Used by" is computed from each post's assets.</p>
      <Issues error={error} testId="upload-issues" />
    </Block>
  );
}

export function BriefPage() {
  // inside the campaign's Brief & directions tab the section is just "Brief" (the tab names the campaign).
  const inCampaign = !!useCampaignScope();
  const { data: fetched, error, loading } = useSocial();
  const { data: milestones } = useQuery(() => api.listMilestones({ includeSettled: true }), []);
  const { data: assignments } = useQuery(() => api.listAssignments(), []);
  const { data: personas } = useQuery(() => api.listPersonas(), []);
  const [written, setWritten] = useState<SocialData>();
  const social = newer(written, fetched);

  const cadences: PersonaCadence[] = useMemo(
    () => personaCadences(social?.repo ?? null, milestones ?? [], assignments ?? [], personas ?? []),
    [social?.repo, milestones, assignments, personas],
  );
  const [base, setBase] = useState<BriefForm>();
  const [form, setForm] = useState<BriefForm>();
  // The form starts from the first export (and again after each Save); a refetch while editing never clobbers it.
  const cadenceKey = JSON.stringify(cadences);
  useEffect(() => {
    if (!social) return;
    if (base && form && changedSections(form, base).length) return;
    const next = formFromExport(social.data, cadences);
    setBase(next);
    setForm(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [social?.data.generatedAt, social?.repo, cadenceKey]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error>();
  const [saved, setSaved] = useState<SocialWriteResult>();

  if (error) return <ErrorBox error={error} />;
  if (loading && !social) return <Loading />;
  if (!social || !form || !base) return <Loading />;
  if (!social.repo && !social.sample)
    return (
      <>
        <PageHeader title={inCampaign ? "Brief" : BRIEF_LABEL} />
        <Empty>No social repo in this workspace yet: turn the social pack on in a repo (pack init social) to set its brief.</Empty>
      </>
    );

  const d = social.data;
  const set = <K extends keyof BriefForm>(k: K, v: BriefForm[K]) => setForm((f) => f && { ...f, [k]: v });
  const setRow = <K extends "key_messages" | "formats" | "examples" | "hold_rules">(k: K, i: number, patch: Partial<BriefForm[K][number]>) =>
    setForm((f) => f && { ...f, [k]: f[k].map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const dropRow = (k: "key_messages" | "formats" | "examples" | "hold_rules", i: number) => setForm((f) => f && { ...f, [k]: f[k].filter((_, j) => j !== i) });
  const addRow = <K extends "key_messages" | "formats" | "examples" | "hold_rules">(k: K, row: BriefForm[K][number]) => setForm((f) => f && { ...f, [k]: [...f[k], row] });

  const changed = changedSections(form, base);
  const problems = formProblems(form);
  const total = formatsTotal(form);
  const carried = new Map(d.brief.key_messages.map((k) => [k.id, k.carried_by]));

  const save = async () => {
    const body = briefInput(form, base);
    if (!body || problems.length) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const r = await api.socialWrite(social.tenantId, { action: "brief", body }, social.repo ?? undefined);
      setSaved(r);
      const next = formFromExport(r.data, Object.entries(form.cadence).map(([persona, cadence]) => ({ persona, cadence, mixed: false, enabled: true })));
      setBase(next);
      setForm(next);
      setWritten(r);
      invalidate();
    } catch (e) {
      setSaveError(e as Error);
    } finally {
      setSaving(false);
    }
  };

  const listBox = (k: "voice" | "style_rules" | "never_say", label: string, rows = 4) => (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Textarea autoGrow aria-label={label} rows={rows} value={form[k]} onChange={(e) => set(k, e.target.value)} />
    </label>
  );

  return (
    <>
      <PageHeader
        title={inCampaign ? "Brief" : BRIEF_LABEL}
        description={
          <>
            The standing layer: every team member reads it on every wake.{social.repo ? ` Repo: ${social.repo}.` : ""}
            {social.sample && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-400">sample</span>}
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button type="button" onClick={save} disabled={saving || !changed.length || problems.length > 0} data-testid="brief-save">
              {saving ? "Saving…" : "Save"}
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="brief-status">
              {changed.length ? `unsaved: ${changed.join(", ")}` : saved ? `saved${saved.commit ? ` · commit ${saved.commit.slice(0, 7)}` : " (nothing changed)"}${saved.push.state === "failed" ? ` · push failed: ${saved.push.detail ?? ""}` : ""}` : "no changes"}
            </span>
          </div>
        }
      />
      {problems.length > 0 && (
        <ul className="mb-3 list-disc rounded-md border border-amber-500/40 bg-amber-500/10 p-3 pl-8 text-sm text-amber-800 dark:text-amber-300" data-testid="brief-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <Issues error={saveError} testId="brief-issues" />
      {d.warnings.length > 0 && (
        <details className="mb-3 text-xs text-muted-foreground" data-testid="brief-warnings">
          <summary>{d.warnings.length} pack warning(s)</summary>
          <ul className="mt-1 list-disc pl-5">
            {d.warnings.map((w, i) => (
              <li key={i}>
                {w.file}
                {w.line ? `:${w.line}` : ""}: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-3 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Block title="Objective" where="root spine · Goal" testId="brief-objective">
          <Textarea autoGrow aria-label="Objective" rows={3} value={form.objective} onChange={(e) => set("objective", e.target.value)} />
          <label className="mt-3 grid gap-1 text-sm">
            <span className="font-medium">Targets</span>
            <Textarea autoGrow aria-label="Targets" rows={4} value={form.targets} onChange={(e) => set("targets", e.target.value)} placeholder="- 7 threads a week&#10;- 80% answered in 3 h" />
            <span className="text-xs text-muted-foreground">root spine · Targets</span>
          </label>
        </Block>

        <Block title="Audience" where="brief.md · Audience" testId="brief-audience">
          <Textarea autoGrow aria-label="Audience" rows={7} value={form.audience} onChange={(e) => set("audience", e.target.value)} />
        </Block>

        <Block title="Key messages" where="message house · Points to emphasize (+ weight); carried by = posts that push it" testId="brief-key-messages" wide>
          <div className="grid gap-2">
            {form.key_messages.map((k, i) => {
              const by = (k.id && carried.get(k.id)) || [];
              return (
                <div key={i} className="flex min-w-0 flex-wrap items-center gap-2" data-testid="key-message">
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{k.id ?? "new"}</span>
                  <Input aria-label={`Key message ${i + 1}`} className="min-w-[14rem] flex-1" value={k.message} onChange={(e) => setRow("key_messages", i, { message: e.target.value })} />
                  <NativeSelect aria-label={`Weight ${i + 1}`} className="w-28" value={k.weight} onChange={(e) => setRow("key_messages", i, { weight: e.target.value })}>
                    {[...WEIGHTS, ...(WEIGHTS.includes(k.weight as never) ? [] : [k.weight])].map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </NativeSelect>
                  <span className="flex min-w-[9rem] items-center gap-1 text-xs" data-testid="carried-by">
                    <span className={by.length ? "tabular-nums" : "text-amber-700 dark:text-amber-400"}>{by.length} posts</span>
                    {by.length > 0 && <PostRefs ids={by} data={d} />}
                  </span>
                  <RowButton label={`Remove key message ${i + 1}`} onClick={() => dropRow("key_messages", i)} />
                </div>
              );
            })}
          </div>
          <AddButton label="Key message" onClick={() => addRow("key_messages", { id: null, message: "", weight: "normal", source: "" })} />
          <p className="mt-2 text-xs text-muted-foreground">"Carried by" is computed from each post's messages field: 0 posts means the message isn't being pushed.</p>
        </Block>

        <Block title="Voice and style" where="message house · Voice, Style rules, Never say (one per line)" testId="brief-voice" wide>
          <div className="grid gap-3 md:grid-cols-3">
            {listBox("voice", "Voice")}
            {listBox("style_rules", "Style rules")}
            {listBox("never_say", "Never say")}
          </div>
          {d.brief.topic_weights.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{d.brief.topic_weights.length} topic weights in the message house (edited on Topics).</p>}
        </Block>

        <Block title="Formats mix" where="brief.md · Formats (share of posts)" testId="brief-formats">
          <div className="grid gap-2">
            {form.formats.map((x, i) => (
              <div key={i} className="flex min-w-0 flex-wrap items-center gap-2" data-testid="format-row">
                <Input aria-label={`Format ${i + 1}`} className="w-32" value={x.format} onChange={(e) => setRow("formats", i, { format: e.target.value })} placeholder="text" />
                <label className="flex items-center gap-1 text-sm">
                  <Input aria-label={`Share ${i + 1}`} type="number" min={0} max={100} className="w-20" value={x.share} onChange={(e) => setRow("formats", i, { share: e.target.value })} />%
                </label>
                <Input aria-label={`Format example ${i + 1}`} className="min-w-[8rem] flex-1" value={x.example} onChange={(e) => setRow("formats", i, { example: e.target.value })} placeholder="e.g. P-0139" />
                <RowButton label={`Remove format ${i + 1}`} onClick={() => dropRow("formats", i)} />
              </div>
            ))}
          </div>
          <AddButton label="Format" onClick={() => addRow("formats", { format: "", share: "0", example: "" })} />
          <p className={`mt-2 text-xs ${form.formats.length && total !== 100 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`} data-testid="formats-total">
            total {total}%{form.formats.length && total !== 100 ? " (should come to 100%)" : ""}
          </p>
        </Block>

        <Block title="Cadence per persona" where="console assignments (when each wakes)" testId="brief-cadence">
          {cadences.length === 0 ? (
            <Empty>No team member is assigned to this objective yet.</Empty>
          ) : (
            <div className="grid gap-3">
              {cadences.map((c) => (
                <div key={c.persona} className="grid gap-1" data-testid="cadence-row">
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium">{c.persona}</span>
                    <span className="text-xs text-muted-foreground">
                      now {formatCadence(c.cadence)}
                      {!c.enabled && " · off"}
                      {c.mixed && " · several assignments differ: Save sets them all"}
                    </span>
                  </div>
                  <CadenceEditor persona={c.persona} value={form.cadence[c.persona] ?? c.cadence} onChange={(v) => set("cadence", { ...form.cadence, [c.persona]: v })} />
                </div>
              ))}
            </div>
          )}
        </Block>

        <Block title="Examples" where="brief.md · Examples (like / dislike)" testId="brief-examples">
          <div className="grid gap-2">
            {form.examples.map((e, i) => (
              <div key={i} className="flex min-w-0 flex-wrap items-center gap-2" data-testid="example-row">
                <NativeSelect aria-label={`Verdict ${i + 1}`} className="w-28" value={e.verdict} onChange={(ev) => setRow("examples", i, { verdict: ev.target.value as "like" | "dislike" })}>
                  <option value="like">like</option>
                  <option value="dislike">dislike</option>
                </NativeSelect>
                <Input aria-label={`Example link ${i + 1}`} className="min-w-[10rem] flex-1" value={e.link} onChange={(ev) => setRow("examples", i, { link: ev.target.value })} placeholder="https://…" />
                <Input aria-label={`Example why ${i + 1}`} className="min-w-[8rem] flex-1" value={e.why} onChange={(ev) => setRow("examples", i, { why: ev.target.value })} placeholder="why" />
                <RowButton label={`Remove example ${i + 1}`} onClick={() => dropRow("examples", i)} />
              </div>
            ))}
          </div>
          <AddButton label="Example" onClick={() => addRow("examples", { link: "", verdict: "like", why: "" })} />
        </Block>

        <Block title="Hold for me" where="brief.md · Hold for me (opt-in, default: nothing)" testId="brief-hold">
          <div className="grid gap-2">
            {form.hold_rules.map((h, i) => (
              <div key={i} className="flex min-w-0 flex-wrap items-center gap-2" data-testid="hold-row">
                <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">{h.id ?? "new"}</span>
                <Input aria-label={`Hold rule ${i + 1}`} className="min-w-[12rem] flex-1" value={h.match} onChange={(e) => setRow("hold_rules", i, { match: e.target.value })} placeholder="a post that names a competitor" />
                <Input aria-label={`Hold why ${i + 1}`} className="min-w-[8rem] flex-1" value={h.why} onChange={(e) => setRow("hold_rules", i, { why: e.target.value })} placeholder="why" />
                <RowButton label={`Remove hold rule ${i + 1}`} onClick={() => dropRow("hold_rules", i)} />
              </div>
            ))}
          </div>
          <AddButton label="Hold rule" onClick={() => addRow("hold_rules", { id: null, match: "", why: "" })} />
          <p className="mt-2 text-xs text-muted-foreground">Matches wait in Held. Everything else goes out.</p>
        </Block>

        <AssetsLibrary
          social={social}
          onUploaded={(r) => {
            setWritten(r);
            invalidate();
          }}
        />
      </div>
    </>
  );
}
