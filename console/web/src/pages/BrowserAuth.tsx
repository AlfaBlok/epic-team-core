import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { api, type AuthSite, type AuthSync, type EgressStatus, type SignedInCheck } from "@/api";
import { invalidate, useQuery } from "@/lib/data";
import { BROWSERS, detectBrowser, expiryState, parsePatterns } from "@/lib/auth";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, ErrorBox, Field, Loading, PageHeader, RelTime } from "@/components/common";
import { ConfirmDialog } from "@/components/dialogs";
import { useSkin } from "@/lib/skin";
import { ownerName } from "@/lib/identity";
import { mainHost } from "../lib/identity";

const POLL_MS = 2000;

function ExpiryBadge({ iso, prefix = "", title }: { iso?: string; prefix?: string; title?: string }) {
  const state = expiryState(iso);
  if (state === "none") return <span className="text-muted-foreground">{prefix}session</span>;
  if (state === "expired") return <Badge variant="red">{prefix}expired</Badge>;
  return (
    <span title={title ?? formatDateTime(iso)}>
      {state === "soon" ? <Badge variant="amber">{prefix + formatRelative(iso)}</Badge> : prefix + formatRelative(iso)}
    </span>
  );
}

/**
 * the login's own expiry (login cookies), with the earliest cookie only as a muted hint: on x.com that is a
 * 30-min bot-protection cookie the site renews itself, which read as "the login dies in 28 min".
 */
function SiteExpiry({ site }: { site: AuthSite }) {
  if (!site.loginCookie) return <ExpiryBadge iso={site.earliestExpiry} />;
  const hint = site.earliestExpiry && site.earliestExpiry !== site.loginExpiry ? site.earliestExpiry : undefined;
  return (
    <>
      <ExpiryBadge
        iso={site.loginExpiry}
        prefix="login: "
        title={`From ${site.loginCookie}${site.loginExpiry ? `, ${formatDateTime(site.loginExpiry)}` : ""}`}
      />
      {hint && (
        <div
          className="text-xs text-muted-foreground"
          title="A short-lived cookie the site renews by itself (e.g. bot protection); not the login."
        >
          shortest cookie {expiryState(hint) === "expired" ? "expired" : formatRelative(hint)}
        </div>
      )}
    </>
  );
}

/** the bootstrap text for the Claude app on the owner's Mac: it runs the one-time sync command itself and reports. */
export function macAgentText(command: string, patterns: string[]): string {
  return (
    `You are the Mac agent for the Team Browser sign-in sync, working for ${ownerName()} in the Claude app on his Mac. ` +
    `Run this one command in your terminal tool on this Mac, once: ${command} . ` +
    `It copies the signed-in cookies for ${patterns.join(", ")} from his browser profile to the team's store, through a one-time link. ` +
    `If it says uv is missing, tell ${ownerName()}, install uv with Homebrew after his OK, and run it again. ` +
    `macOS asks once for the browser's Safe Storage key: tell ${ownerName()} to choose Always Allow. ` +
    `Never print, copy or open a cookie yourself. When it ends, tell ${ownerName()} in two lines what it printed (only counts and domains).`
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (plain http): the text is selectable */
    }
  };
  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs">{command}</code>
      <Button type="button" variant="outline" size="sm" className="h-auto" onClick={copy} aria-label="Copy the text">
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function SyncResult({ sync }: { sync: AuthSync }) {
  const r = sync.result!;
  return (
    <div className="grid gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
      <div className="font-medium">
        Synced from {r.browser} / {r.profileName ?? r.profile}
      </div>
      {r.sites.map((s) => (
        <div key={s.pattern}>
          <span className="font-mono">{s.pattern}</span>:{" "}
          {s.cookieCount > 0 ? `${s.cookieCount} cookies (${s.domains.join(", ")})` : "no cookies found, previous sync kept"}
        </div>
      ))}
    </div>
  );
}

/** Patterns → one-time command → wait for the Mac script → result. The token rides in ?sync= while open. */
function SyncDialog({ token, initialPatterns, onClose, onToken }: {
  token?: string;
  initialPatterns: string;
  onClose: () => void;
  onToken: (token: string) => void;
}) {
  const [patterns, setPatterns] = useState(initialPatterns);
  const [browser, setBrowser] = useState(() =>
    detectBrowser(navigator.userAgent, !!(navigator as Navigator & { brave?: unknown }).brave),
  );
  const [sync, setSync] = useState<AuthSync>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Poll the token until it is synced or expired.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.getAuthSync(token);
        if (!alive) return;
        setSync(s);
        setError(undefined);
        if (s.status === "synced") return invalidate();
        if (s.status === "expired") return;
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = parsePatterns(patterns);
    if (list.length === 0) return setError("Enter at least one site pattern.");
    setBusy(true);
    setError(undefined);
    try {
      const s = await api.startAuthSync({ patterns: list, browser });
      setSync(s);
      onToken(s.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setPatterns(sync?.patterns.join(", ") ?? patterns);
    setSync(undefined);
    onToken("");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Sync browser auth</DialogTitle>
          <DialogDescription>
            Copies your logged-in cookies for these sites from a browser profile on your Mac into the central store on
            {mainHost()}. Every agent on {mainHost()} can then browse them as you.
          </DialogDescription>
        </DialogHeader>

        {!token && (
          <form className="grid gap-4" onSubmit={submit}>
            <Field label="Sites" hint={<>Comma separated. <code>*.reddit.com</code> = reddit.com and subdomains; <code>x.com</code> = that host only; <code>*.airbnb.*</code> = any airbnb TLD.</>}>
              <Input autoFocus value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder="*.reddit.com, x.com" />
            </Field>
            <Field label="Browser" hint="Detected from this page. Open this page in the browser profile that is logged in.">
              <NativeSelect value={browser} onChange={(e) => setBrowser(e.target.value)}>
                {BROWSERS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {error && <div className="text-sm text-destructive">{error}</div>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy} pending={busy} pendingLabel="Getting command…">
                <KeyRound /> Get command
              </Button>
            </DialogFooter>
          </form>
        )}

        {token && (
          <div className="grid gap-4">
            {sync && sync.status !== "synced" && (
              <>
                <div className="grid gap-1.5 text-sm">
                  {/* never a terminal line for the owner: the text for the Claude app, which runs the command itself */}
                  <span className="font-medium">Open the Claude app on your Mac, start a new session in Code, paste this text and send it</span>
                  <CopyCommand command={macAgentText(sync.command, sync.patterns)} />
                  <span className="text-xs text-muted-foreground">
                    One-time link for {sync.patterns.join(", ")}, valid <RelTime iso={sync.expiresAt} />. Needs{" "}
                    <a className="underline" href="https://docs.astral.sh/uv/" target="_blank" rel="noreferrer">
                      uv
                    </a>
                    . macOS asks once for the browser's Safe Storage key: choose Always Allow. Only counts and domains are
                    printed.
                  </span>
                </div>
                {sync.status === "pending" && !sync.error && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Waiting for the sync…
                  </div>
                )}
                {sync.status === "error" && (
                  <div className="text-sm text-destructive">The script reported: {sync.error}. Paste the text into a new Claude app session again: it fixes what it can and tells you.</div>
                )}
                {sync.status === "expired" && <div className="text-sm text-destructive">This link expired. Start a new sync.</div>}
              </>
            )}
            {sync?.status === "synced" && <SyncResult sync={sync} />}
            {!sync && !error && <Loading />}
            {error && <div className="text-sm text-destructive">{error}</div>}
            <DialogFooter>
              {(sync?.status === "expired" || error) && (
                <Button type="button" variant="outline" onClick={restart}>
                  New sync
                </Button>
              )}
              <Button type="button" variant={sync?.status === "synced" ? "default" : "outline"} onClick={onClose}>
                {sync?.status === "synced" ? "Done" : "Close"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const EGRESS_POLL_MS = 30_000;

/**
 * whether the owner's laptop (Team Browser egress `laptop`) is online, from the browser's health poller. Reads
 * routed through it answer HELD while it is offline; the console wakes the held personas when it is back.
 */
export function LaptopStatus() {
  const [laptop, setLaptop] = useState<EgressStatus | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await api.listEgress();
        if (!alive) return;
        setLaptop(list.find((e) => e.name === "laptop") ?? null);
        setError(undefined);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive) timer = setTimeout(tick, EGRESS_POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  if (laptop === null && !error) return null; // this world has no laptop egress
  const state = error ? "unknown" : laptop?.state;
  const badge =
    state === "online" ? <Badge variant="green">online</Badge>
    : state === "offline" ? <Badge variant="red">offline</Badge>
    : state === "disabled" ? <Badge variant="outline">disabled</Badge>
    : <Badge variant="outline">{laptop === undefined && !error ? "checking…" : "unknown"}</Badge>;
  const when = laptop?.since ?? laptop?.lastSeen;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm" data-testid="laptop-status">
      <span className="font-medium">Laptop</span>
      {badge}
      {!error && when && (
        <span className="text-muted-foreground" title={formatDateTime(when)}>
          {state === "offline" && laptop?.lastSeen ? <>last seen <RelTime iso={laptop.lastSeen} /></> : <>since <RelTime iso={when} /></>}
        </span>
      )}
      {state === "offline" && (
        <span className="text-muted-foreground">
          {laptop?.whenDown === "hold" ? "Reads that go through it are held until it is back; the team is woken then." : "Reads that go through it are unavailable."}
        </span>
      )}
      {/* Reddit/X writes waiting in the Team Browser's outbox; they go out paced once the laptop is back. */}
      {!error && !!laptop?.heldWrites && (
        <span data-testid="held-writes">
          <Badge variant="outline">
            {laptop.heldWrites} {laptop.heldWrites === 1 ? "write" : "writes"} held
          </Badge>{" "}
          <span className="text-muted-foreground">{state === "online" ? "going out one at a time, 20+ min apart" : "sent when it is back, 20+ min apart"}</span>
        </span>
      )}
      {error && <span className="text-muted-foreground" title={error}>Team Browser status could not be read right now</span>}
    </div>
  );
}

const CHECK_LABEL: Record<SignedInCheck["state"], { text: string; variant: "green" | "red" | "amber" | "gray" | "outline" }> = {
  signed_in: { text: "signed in", variant: "green" },
  signed_out: { text: "signed out", variant: "red" },
  held: { text: "waiting for the laptop", variant: "amber" },
  error: { text: "could not check", variant: "amber" },
  not_synced: { text: "not synced", variant: "gray" },
  by_api: { text: "by its API", variant: "outline" },
};

/**
 * the Team Browser's hourly signed-in check, one line per site: signed in or not, since when, and the one step
 * that fixes it. A synced site that turns signed out also puts that step in the owner's inbox once (the ask code shows here).
 */
export function SignedInChecks() {
  const { data: rows } = useQuery(() => api.listSignedInCheck(), []);
  if (!rows?.length) return null;
  const last = rows.map((r) => r.checkedAt).sort().at(-1)!;
  return (
    <div className="mb-4 rounded-md border px-3 py-2 text-sm" data-testid="signed-in-check">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium">Signed in?</span>
        <span className="text-muted-foreground" title={formatDateTime(last)}>
          checked every hour, last <RelTime iso={last} />
        </span>
      </div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const l = CHECK_LABEL[r.state] ?? { text: r.state, variant: "outline" as const };
          const needsStep = r.state === "signed_out" || r.state === "not_synced";
          return (
            <li key={r.site} className="flex flex-wrap items-baseline gap-x-2" data-testid={`check-${r.site}`}>
              <span className="w-20 font-mono">{r.site}</span>
              <Badge variant={l.variant}>{l.text}</Badge>
              {r.state !== "not_synced" && r.state !== "by_api" && (
                <span className="text-muted-foreground" title={formatDateTime(r.since)}>
                  since <RelTime iso={r.since} />
                </span>
              )}
              {r.ask && <Badge variant="outline" title={`${r.ask.code} in ${r.ask.path}`}>in your inbox</Badge>}
              {needsStep && r.fix && r.fix !== "none" && <span className="basis-full pl-[5.5rem] text-muted-foreground">{r.fix}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function BrowserAuthPage() {
  const { data: sites, error, loading } = useQuery(() => api.listAuthSites(), []);
  const [params, setParams] = useSearchParams();
  const token = params.get("sync") ?? undefined;
  const [dialog, setDialog] = useState<{ patterns: string } | undefined>(token ? { patterns: "" } : undefined);
  const [toClear, setToClear] = useState<AuthSite>();

  // A reload or shared link with ?sync= reopens the dialog on that token.
  useEffect(() => {
    if (token && !dialog) setDialog({ patterns: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const open = (patterns: string) => setDialog({ patterns });
  const close = () => {
    setDialog(undefined);
    if (params.has("sync")) setParams({}, { replace: true });
  };
  // Push (not replace) so the URL with the token lands in the browser's history: the Mac script looks for it there.
  const onToken = (t: string) => setParams(t ? { sync: t } : {});

  // on the social skin this is the tester's own world: their sign-ins stay in their team's own browser.
  const social = useSkin().id === "social";
  return (
    <>
      <PageHeader
        title={social ? "Browser sign-ins" : "Browser auth"}
        description={
          social
            ? "Your own X and Reddit logins, kept encrypted in your team's own browser: only your team uses them, never anyone else's, and values are never shown. Your Scout, Publisher, Responder, Engager and Reporter start once a sign-in arrives."
            : `Logged-in browser sessions shared with every agent on ${mainHost()} through the Team Browser (MCP team-browser: browse, fetch, screenshot). Stored encrypted; values are never shown.`
        }
        actions={
          <Button onClick={() => open(social ? "x.com, *.reddit.com" : "*.reddit.com")}>
            <KeyRound /> Sync browser auth
          </Button>
        }
      />
      <LaptopStatus />
      {!social && <SignedInChecks />}
      {error && <ErrorBox error={error} />}
      {loading && <Loading />}
      {sites?.length === 0 && <Empty>No synced sites yet. Click Sync browser auth.</Empty>}
      {sites && sites.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site</TableHead>
              <TableHead>Cookies</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Synced</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="font-mono font-medium">{s.pattern}</div>
                  <div className="max-w-[16rem] truncate text-xs text-muted-foreground" title={s.domains.join(", ")}>
                    {s.domains.join(", ")}
                  </div>
                </TableCell>
                <TableCell>{s.cookieCount}</TableCell>
                <TableCell>
                  {s.sourceBrowser} / {s.sourceProfile}
                </TableCell>
                <TableCell title={formatDateTime(s.syncedAt)}><RelTime iso={s.syncedAt} /></TableCell>
                <TableCell>
                  <SiteExpiry site={s} />
                  {s.session === "dead" && (
                    <div title={s.sessionReason}>
                      <Badge variant="red">session dead</Badge>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {s.lastUsedAt ? (
                    <span title={formatDateTime(s.lastUsedAt)}>
                      <RelTime iso={s.lastUsedAt} />
                      {s.lastUsedBy && <div className="text-xs text-muted-foreground">{s.lastUsedBy}</div>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" onClick={() => open(s.pattern)}>
                      <RefreshCw /> Re-sync
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Clear ${s.pattern}`} onClick={() => setToClear(s)}>
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dialog && <SyncDialog token={token} initialPatterns={dialog.patterns} onClose={close} onToken={onToken} />}
      <ConfirmDialog
        open={!!toClear}
        onOpenChange={(o) => !o && setToClear(undefined)}
        title={`Clear ${toClear?.pattern ?? "site"}?`}
        description="Deletes the stored cookies. Agents lose the logged-in session until you sync again."
        confirmLabel="Clear"
        onConfirm={() => api.clearAuthSite(toClear!.id)}
      />
    </>
  );
}
