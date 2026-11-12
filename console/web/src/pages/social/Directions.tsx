import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import type { SocialDirections, SocialDirectionsInput } from "@/api/types";
import { useSocialScreen, type WriteNote } from "@/lib/useSocialWrite";
import { ScopedNote, SocialScreen, WriteNoteLine, type Write } from "./parts";

/**
 * Directions (deck v3 slides 10-11): what to push this week (highlights, do / don't, voice note) and this month
 * (priorities). "Served by" is computed by the pack export. Save writes data/brief.md (its This week part; data/directions.md before) through the write API as
 * you; a direction steers what gets written and never posts anything by itself.
 */
type View = "week" | "month";
type WeekRow = { id: string; highlight: string; why: string; until: string };
type RuleRow = { kind: "do" | "don't"; rule: string; until: string };
type MonthRow = { id: string; priority: string; why: string; month: string };
const s = (v: string | null | undefined) => v ?? "";
const opt = (v: string) => v.trim() || null;

const ServedBy = ({ ids }: { ids: string[] }) =>
  ids.length ? (
    <span className="flex flex-wrap gap-1">
      {ids.map((i) => (
        <Badge key={i} variant="gray">
          {i}
        </Badge>
      ))}
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">nothing yet</span>
  );

function WeekView({ d }: { d: SocialDirections }) {
  return (
    <div className="grid gap-4" data-testid="directions-week">
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Highlights</h2>
        {d.week.length === 0 && <div className="text-sm text-muted-foreground">No highlight this week.</div>}
        {d.week.map((h) => (
          <Card key={h._line} data-testid="highlight">
            <CardContent className="grid gap-1 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="violet">{h.id}</Badge>
                <span className="font-medium">{h.highlight}</span>
                {h.until && <span className="text-xs text-muted-foreground">until {h.until}</span>}
              </div>
              {h.why && <div className="text-muted-foreground">{h.why}</div>}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                Served by <ServedBy ids={h.served_by} />
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="grid gap-1">
        <h2 className="text-sm font-semibold">This week only</h2>
        {d.do_dont.length === 0 && <div className="text-sm text-muted-foreground">No do / don't this week.</div>}
        {d.do_dont.map((r) => (
          <div key={r._line} className="text-sm" data-testid="do-dont">
            <Badge variant={r.kind === "do" ? "green" : "red"}>{r.kind === "do" ? "Do" : "Don't"}</Badge> {r.rule}{" "}
            {r.until && <span className="text-xs text-muted-foreground">until {r.until}</span>}
          </div>
        ))}
      </section>
      <section className="grid gap-1">
        <h2 className="text-sm font-semibold">Voice note</h2>
        <div className="text-sm">{d.voice_note || <span className="text-muted-foreground">none</span>}</div>
      </section>
    </div>
  );
}

function MonthView({ d }: { d: SocialDirections }) {
  return (
    <section className="grid gap-2" data-testid="directions-month">
      {d.month.length === 0 && <div className="text-sm text-muted-foreground">No priority this month.</div>}
      {d.month.map((m) => (
        <Card key={m._line} data-testid="priority">
          <CardContent className="grid gap-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="violet">{m.id}</Badge>
              <span className="font-medium">{m.priority}</span>
              {m.month && <span className="text-xs text-muted-foreground">{m.month}</span>}
            </div>
            {m.why && <div className="text-muted-foreground">{m.why}</div>}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              Served by <ServedBy ids={m.served_by} />
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

/** Rows editor: one line of inputs per row, add and remove. */
function Rows<T>({ rows, set, blank, render, label }: { rows: T[]; set: (r: T[]) => void; blank: T; render: (r: T, put: (p: Partial<T>) => void, i: number) => JSX.Element; label: string }) {
  return (
    <div className="grid gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          {render(r, (p) => set(rows.map((x, j) => (j === i ? { ...x, ...p } : x))), i)}
          <Button size="icon" variant="ghost" aria-label={`Remove ${label} ${i + 1}`} onClick={() => set(rows.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="justify-self-start" onClick={() => set([...rows, blank])}>
        <Plus /> Add {label}
      </Button>
    </div>
  );
}

function Editor({ d, view, write, busy, done, note }: { d: SocialDirections; view: View; write: Write; busy?: string; done: () => void; note?: WriteNote }) {
  const [week, setWeek] = useState<WeekRow[]>(() => d.week.map((h) => ({ id: s(h.id), highlight: s(h.highlight), why: s(h.why), until: s(h.until) })));
  const [rules, setRules] = useState<RuleRow[]>(() => d.do_dont.map((r) => ({ kind: r.kind === "do" ? "do" : "don't", rule: s(r.rule), until: s(r.until) })));
  const [voice, setVoice] = useState(s(d.voice_note));
  const [month, setMonth] = useState<MonthRow[]>(() => d.month.map((m) => ({ id: s(m.id), priority: s(m.priority), why: s(m.why), month: s(m.month) })));

  const body: SocialDirectionsInput =
    view === "week"
      ? {
          week: week.filter((h) => h.highlight.trim()).map((h) => ({ id: opt(h.id), highlight: h.highlight.trim(), why: opt(h.why), until: opt(h.until) })),
          do_dont: rules.filter((r) => r.rule.trim()).map((r) => ({ kind: r.kind, rule: r.rule.trim(), until: opt(r.until) })),
          voice_note: voice.trim(),
        }
      : { month: month.filter((m) => m.priority.trim()).map((m) => ({ id: opt(m.id), priority: m.priority.trim(), why: opt(m.why), month: opt(m.month) })) };

  return (
    <div className="grid gap-4" data-testid="directions-editor">
      {view === "week" ? (
        <>
          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">Highlights</h2>
            <Rows
              rows={week}
              set={setWeek}
              label="highlight"
              blank={{ id: "", highlight: "", why: "", until: "" }}
              render={(r, put, i) => (
                <>
                  <Input aria-label={`Highlight ${i + 1}`} className="min-w-48 flex-1" value={r.highlight} onChange={(e) => put({ highlight: e.target.value })} placeholder="What to push" />
                  <Input aria-label={`Why ${i + 1}`} className="min-w-32 flex-1" value={r.why} onChange={(e) => put({ why: e.target.value })} placeholder="Why" />
                  <Input aria-label={`Until ${i + 1}`} className="w-36" type="date" value={r.until} onChange={(e) => put({ until: e.target.value })} />
                </>
              )}
            />
          </section>
          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">This week only</h2>
            <Rows
              rows={rules}
              set={setRules}
              label="rule"
              blank={{ kind: "do", rule: "", until: "" }}
              render={(r, put, i) => (
                <>
                  <NativeSelect aria-label={`Kind ${i + 1}`} className="w-24" value={r.kind} onChange={(e) => put({ kind: e.target.value as RuleRow["kind"] })}>
                    <option value="do">Do</option>
                    <option value="don't">Don't</option>
                  </NativeSelect>
                  <Input aria-label={`Rule ${i + 1}`} className="min-w-48 flex-1" value={r.rule} onChange={(e) => put({ rule: e.target.value })} />
                  <Input aria-label={`Rule until ${i + 1}`} className="w-36" type="date" value={r.until} onChange={(e) => put({ until: e.target.value })} />
                </>
              )}
            />
          </section>
          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">Voice note</h2>
            <Textarea aria-label="Voice note" value={voice} onChange={(e) => setVoice(e.target.value)} />
          </section>
        </>
      ) : (
        <Rows
          rows={month}
          set={setMonth}
          label="priority"
          blank={{ id: "", priority: "", why: "", month: "" }}
          render={(r, put, i) => (
            <>
              <Input aria-label={`Priority ${i + 1}`} className="min-w-48 flex-1" value={r.priority} onChange={(e) => put({ priority: e.target.value })} />
              <Input aria-label={`Priority why ${i + 1}`} className="min-w-32 flex-1" value={r.why} onChange={(e) => put({ why: e.target.value })} placeholder="Why" />
              <Input aria-label={`Month ${i + 1}`} className="w-32" type="month" value={r.month} onChange={(e) => put({ month: e.target.value })} />
            </>
          )}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!!busy} pending={busy === "directions"} pendingLabel="Saving…" onClick={() => write({ action: "directions", body }).then((r) => r && done())}>
          Save
        </Button>
        <Button variant="ghost" onClick={done}>
          Cancel
        </Button>
      </div>
      <ScopedNote note={note} scope="directions" />
      <div className="text-xs text-muted-foreground">Save writes data/brief.md (This week) and commits it as you; the next Creative and Writer wakes read it.</div>
    </div>
  );
}

export function DirectionsPage() {
  const { social, error, write, busy, note } = useSocialScreen();
  const [view, setView] = useState<View>("week");
  const [editing, setEditing] = useState(false);
  return (
    <SocialScreen title="Directions" intro="What to push this week and this month; the Creative and Writer read it first on every wake." social={social} error={error}>
      {(sd) => (
        <div className="grid gap-3">
          <WriteNoteLine note={editing && note?.scope === "directions" ? undefined : note} />
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="tablist" aria-label="Directions view" className="mr-auto flex gap-1.5">
              {(["week", "month"] as const).map((v) => (
                <Button key={v} role="tab" aria-selected={view === v} size="sm" variant={view === v ? "default" : "outline"} disabled={editing} onClick={() => setView(v)}>
                  {v === "week" ? "This week" : "This month"}
                </Button>
              ))}
            </div>
            {!editing && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
          </div>
          {editing ? (
            <Editor d={sd.data.directions} view={view} write={write} busy={busy} done={() => setEditing(false)} note={note} />
          ) : view === "week" ? (
            <WeekView d={sd.data.directions} />
          ) : (
            <MonthView d={sd.data.directions} />
          )}
        </div>
      )}
    </SocialScreen>
  );
}
