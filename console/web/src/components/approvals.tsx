import { useState } from "react";
import { api, type ApprovalGrant, type GrantInput, type GrantWriteResult, type Milestone } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Empty, ErrorBox, Loading } from "@/components/common";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format";
import { useWords } from "@/lib/skin";

/**
 * the milestone's standing approvals (epicspine-skill docs/doctrine/standing-approvals.md). Own grants first,
 * then inherited ones with their source spine; revoked / expired ones stay, greyed. Add, edit and revoke write the
 * spine line (commit + push) and wake the milestone's Delivery Manager when it is switched on.
 */

const ghLine = (remote: string | undefined, p: string, line?: number) =>
  remote ? `https://github.com/${remote}/blob/HEAD/${p.replace(/^\.\//, "")}${line ? `#L${line}` : ""}` : undefined;

const STATE_STYLE: Record<ApprovalGrant["state"], string> = {
  active: "border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  expired: "text-muted-foreground",
  revoked: "text-muted-foreground line-through",
};

/** "Saved…" plus what happened to the Delivery Manager's wake. */
export function writeMessage(verb: string, r: GrantWriteResult): string {
  const wake = !r.wake ? "No Delivery Manager is switched on: it reads the grant on its next wake." : "runId" in r.wake ? "The Delivery Manager is woken to act on it." : `The Delivery Manager was not woken (${r.wake.error}); it reads the grant on its next wake.`;
  return `${r.code} ${verb}${r.sha ? ` (commit ${r.sha})` : ""}. ${wake}`;
}

export function GrantForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  testId,
}: {
  initial?: GrantInput;
  submitLabel: string;
  onSubmit: (g: GrantInput) => Promise<string>;
  onCancel?: () => void;
  testId: string;
}) {
  const [scope, setScope] = useState(initial?.scope ?? "");
  const [limits, setLimits] = useState(initial?.limits ?? "");
  const [expires, setExpires] = useState(initial?.expires && initial.expires !== "never" ? initial.expires : "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const ready = !!scope.trim() && !busy;
  return (
    <form
      className="grid gap-3"
      data-testid={testId}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setResult(undefined);
        try {
          const text = await onSubmit({ scope: scope.trim(), ...(limits.trim() ? { limits: limits.trim() } : {}), expires: expires || "never" });
          setResult({ ok: true, text });
          if (!initial) {
            setScope("");
            setLimits("");
            setExpires("");
          }
        } catch (err) {
          setResult({ ok: false, text: (err as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="grid gap-1 text-sm">
        <span className="text-xs text-muted-foreground">What agents may do without asking (one sentence, concrete enough to tell if an action is inside it)</span>
        <Textarea aria-label="What it covers" rows={2} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Create, deploy and roll back the app whatgpt-service" />
      </label>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-muted-foreground">Limits (optional): what stays outside</span>
          <Input aria-label="Limits" value={limits} onChange={(e) => setLimits(e.target.value)} placeholder="no change to other apps" />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs text-muted-foreground">Expires (optional; empty = never)</span>
          <Input aria-label="Expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {result && (
          <span role="status" className={cn("text-xs", result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
            {result.text}
          </span>
        )}
      </div>
    </form>
  );
}

function RevokeForm({ code, onRevoke, onCancel }: { code: string; onRevoke: (why: string) => Promise<string>; onCancel: () => void }) {
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-testid={`revoke-form-${code}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          await onRevoke(why.trim());
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <label className="grid flex-1 gap-1 text-sm">
        <span className="text-xs text-muted-foreground">Why (optional): from now on these actions are asks again</span>
        <Input aria-label="Why revoke" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="the app is retired" />
      </label>
      <Button type="submit" size="sm" variant="destructive" disabled={busy}>
        {busy ? "Revoking…" : `Revoke ${code}`}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {error && (
        <span role="status" className="w-full text-xs text-red-700 dark:text-red-400">
          {error}
        </span>
      )}
    </form>
  );
}

function GrantRow({ m, g, onDone }: { m: Milestone; g: ApprovalGrant; onDone: (text: string) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "revoke">("view");
  const [showUses, setShowUses] = useState(false);
  const live = g.state === "active";
  const src = ghLine(m.remote, g.source);
  return (
    <li data-testid={`grant-${g.code}`} data-state={g.state} className={cn("grid gap-2 rounded-md border p-3", !live && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{g.code}</span>
        <Badge variant="outline" className={STATE_STYLE[g.state]}>
          {g.state}
        </Badge>
        {g.inherited && (
          <span className="text-xs text-muted-foreground">
            inherited from{" "}
            {src ? (
              <a className="font-mono underline" href={src} target="_blank" rel="noreferrer">
                {g.source}
              </a>
            ) : (
              <span className="font-mono">{g.source}</span>
            )}
          </span>
        )}
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={g.state === "revoked" ? `revoked ${g.revoked ?? "?"}` : `since ${g.since ?? "?"} · expires ${g.expires || "never"}`}
        >
          {g.state === "revoked"
            ? `revoked ${g.revoked ? formatRelative(g.revoked) : ""}${g.why ? `: ${g.why}` : ""}`
            : `since ${g.since ? formatRelative(g.since) : "?"}${g.who ? ` by ${g.who}` : ""} · ${!g.expires || g.expires === "never" ? "no expiry" : `${g.state === "expired" ? "expired" : "expires"} ${formatRelative(g.expires)}`}`}
        </span>
      </div>
      <p className={cn("text-sm", g.state === "revoked" && "line-through")}>{g.scope}</p>
      {g.limits && <p className="text-xs text-muted-foreground">Limits: {g.limits}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {g.uses > 0 ? (
          <button type="button" className="underline" onClick={() => setShowUses((v) => !v)} aria-expanded={showUses}>
            used {g.uses}×
          </button>
        ) : (
          <span className="text-muted-foreground">not used yet</span>
        )}
        {live || g.state === "expired" ? (
          mode === "view" && (
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
                Edit
              </Button>
              {live && (
                <Button size="sm" variant="outline" onClick={() => setMode("revoke")}>
                  Revoke
                </Button>
              )}
            </span>
          )
        ) : null}
      </div>
      {showUses && g.useRows.length > 0 && (
        <ul className="grid gap-1 text-xs" data-testid={`uses-${g.code}`}>
          {g.useRows.map((u) => {
            const href = ghLine(m.remote, u.path, u.line);
            const label = `${u.date ?? ""} ${u.text}`.trim();
            return (
              <li key={`${u.path}:${u.line}`}>
                {href ? (
                  <a className="underline" href={href} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                ) : (
                  label
                )}{" "}
                <span className="font-mono text-muted-foreground">
                  {u.path}:{u.line}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {mode === "edit" && (
        <GrantForm
          testId={`edit-form-${g.code}`}
          submitLabel={`Save ${g.code}`}
          initial={{ scope: g.scope.replace(/\s*\(edited \d{4}-\d\d-\d\d\)$/, ""), limits: g.limits ?? "", expires: g.expires ?? "" }}
          onCancel={() => setMode("view")}
          onSubmit={async (input) => {
            const r = await mutate(() => api.editApproval(m.id, g.code, input));
            const text = writeMessage("saved", r);
            setMode("view");
            onDone(text);
            return text;
          }}
        />
      )}
      {mode === "revoke" && (
        <RevokeForm
          code={g.code}
          onCancel={() => setMode("view")}
          onRevoke={async (why) => {
            const r = await mutate(() => api.revokeApproval(m.id, g.code, why));
            setMode("view");
            onDone(writeMessage("revoked", r));
            return "";
          }}
        />
      )}
    </li>
  );
}

export function ApprovalsTab({ m }: { m: Milestone }) {
  const w = useWords();
  const { data, error, loading } = useQuery(() => api.getApprovals(m.id), [m.id]);
  const [notice, setNotice] = useState<string>();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const grants = data?.grants ?? [];
  const own = grants.filter((g) => !g.inherited);
  const inherited = grants.filter((g) => g.inherited);
  const list = (gs: ApprovalGrant[]) => (
    <ul className="grid gap-2">
      {gs.map((g) => (
        <GrantRow key={`${g.source}:${g.code}`} m={m} g={g} onDone={setNotice} />
      ))}
    </ul>
  );
  return (
    <div className="grid gap-4" data-testid="approvals-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a standing approval</CardTitle>
          <p className="text-xs text-muted-foreground">
            A yes given up front: agents act inside it without asking and cite its code in Decisions. Written under <span className="font-mono">## Standing approvals</span> of{" "}
            <span className="font-mono">{data?.path ?? m.path}</span>
            {data?.nextCode ? (
              <>
                {" "}as <span className="font-mono">{data.nextCode}</span>
              </>
            ) : null}
            ; applies to this spine and every child.
          </p>
        </CardHeader>
        <CardContent>
          <GrantForm
            testId="add-grant-form"
            submitLabel="Add approval"
            onSubmit={async (input) => {
              const r = await mutate(() => api.addApproval(m.id, input));
              return writeMessage("added", r);
            }}
          />
        </CardContent>
      </Card>
      {notice && (
        <p role="status" data-testid="approvals-notice" className="text-xs text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}
      {data?.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">This {w.milestone} ({own.length})</CardTitle>
        </CardHeader>
        <CardContent>{own.length ? list(own) : <Empty>No standing approvals on this spine yet.</Empty>}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inherited from parent spines ({inherited.length})</CardTitle>
        </CardHeader>
        <CardContent>{inherited.length ? list(inherited) : <Empty>None: no parent spine grants anything.</Empty>}</CardContent>
      </Card>
    </div>
  );
}
