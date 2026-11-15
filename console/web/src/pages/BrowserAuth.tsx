import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { api, type AuthSite, type AuthSync, type EgressStatus, type SignedInCheck } from "@/api";
import { invalidate, useQuery } from "@/lib/data";
import { BROWSERS, detectBrowser, expiryState, parsePatterns, syncState } from "@/lib/auth";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, ErrorBox, Field, Loading, PageHeader, RelTime } from "@/components/common";
import { ConfirmDialog } from "@/components/dialogs";
import { useSkin } from "@/lib/skin";
import { mainHost } from "../lib/identity";

const POLL_MS = 2000;

function ExpiryBadge({ iso, prefix = "", title }: { iso?: string; prefix?: string; title?: string }) {
  const state = expiryState(iso);
  if (state === "none") return <span className="text-muted-foreground">{prefix}session</span>;
  if (state === "expired") return <Badge variant="red">{prefix}expired</Badge>;
  return (
    <span title={title ?? formatDateTime(iso)}>
      {state === "soon" ? <span className="font-medium text-destructive">{prefix + formatRelative(iso)}</span> : prefix + formatRelative(iso)}
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

/**
 * The owner's own one-line sync command (`curl -sSL …/auth-sync/<token>.sh | sh`), shown alone in a copy box for him to run
 * in the Terminal app on his Mac. The copy-paste rule's one named exception, on his own words: this box holds strictly the
 * command, never text for the Claude app. `data-owner-command` names the exception for the copy-paste checks; the command
 * was tested in zsh and bash.
 */
export const SYNC_COMMAND_EXCEPTION = "sync-browser-auth";

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
      <code
        className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"
        data-owner-command={SYNC_COMMAND_EXCEPTION}
        data-runs-on="On your Mac, in the Terminal app"
        data-tested-in="zsh and bash"
      >
        {command}
      </code>
      <Button type="button" variant="outline" size="sm" className="h-auto" onClick={copy} aria-label="Copy command">
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
          {!!s.keptBeside?.length && (
            <div className="text-xs text-muted-foreground">Other profiles kept as they were: {s.keptBeside.join(", ")}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The browser profile a row's Re-sync is for. */
export interface SyncTarget {
  /** "Chrome/Profile 5": what the Team Browser keys the row by. */
  key: string;
  /** The profile's own name ("example.com (ops@)"). */
  name: string;
  accounts?: string[];
}

/** a row's profile name: the map's label, else the name Chrome gave it at sync time. */
export const profileNameOf = (s: AuthSite) => s.profileLabel ?? s.sourceProfile;
const targetOf = (s: AuthSite): SyncTarget | undefined =>
  s.profileKey ? { key: s.profileKey, name: profileNameOf(s), accounts: s.accounts } : undefined;

/**
 * Patterns → one-time command → wait for the Mac script → result. The token rides in ?sync= while open.
 * A row's Re-sync passes its `target` profile; the token carries it, so the command is the same one line and
 * the Mac script opens that profile on the site and syncs it, with no question.
 */
function SyncDialog({ token, initialPatterns, target, onClose, onToken }: {
  token?: string;
  initialPatterns: string;
  target?: SyncTarget;
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
      let s: AuthSync;
      try {
        s = await api.startAuthSync({ patterns: list, browser, ...(target ? { profile: target.key } : {}) });
      } catch (err) {
        // an older Team Browser refuses `profile`: a plain sync still works (the script asks which profile)
        if (!target || !/profile|unrecognized/i.test((err as Error).message)) throw err;
        s = await api.startAuthSync({ patterns: list, browser });
      }
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
          <DialogTitle>{target ? `Re-sync ${target.name}` : "Sync browser auth"}</DialogTitle>
          <DialogDescription>
            Copies your logged-in cookies for these sites from a browser profile on your Mac into the central store on
            {mainHost()}. Every agent on {mainHost()} can then browse them as you.
          </DialogDescription>
        </DialogHeader>

        {target && !token && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="resync-target">
            <div>
              Chrome profile <span className="font-medium">{target.name}</span>
            </div>
            {!!target.accounts?.length && (
              <div className="text-muted-foreground">Holds {target.accounts.map((a) => "@" + a).join(", ")}</div>
            )}
            <div className="text-muted-foreground">The command opens this profile on the site, then syncs it.</div>
          </div>
        )}
        {!token && (
          <form className="grid gap-4" onSubmit={submit}>
            <Field label="Sites" hint={<>Comma separated. <code>*.reddit.com</code> = reddit.com and subdomains; <code>x.com</code> = that host only; <code>*.airbnb.*</code> = any airbnb TLD.</>}>
              <Input autoFocus value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder="*.reddit.com, x.com" />
            </Field>
            {!target && (
              <Field label="Browser" hint="Detected from this page. Open this page in the browser profile that is logged in.">
                <NativeSelect value={browser} onChange={(e) => setBrowser(e.target.value)}>
                  {BROWSERS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
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
                  {/* the copy-paste rule's named exception: the owner's own one-line command, strictly the command */}
                  <span className="text-base font-semibold">On your Mac, in the Terminal app</span>
                  <span className="font-medium">Paste this one command and press Return</span>
                  <CopyCommand command={sync.command} />
                  <span className="text-xs text-muted-foreground">
                    One-time link for {sync.patterns.join(", ")}, valid <RelTime iso={sync.expiresAt} />. Needs{" "}
                    <a className="underline" href="https://docs.astral.sh/uv/" target="_blank" rel="noreferrer">
                      uv
                    </a>
                    . macOS asks once for the browser's Safe Storage key: choose Always Allow. Only counts and domains are
                    printed.
                    {sync.targetProfile && (
                      <span className="mt-1 block" data-testid="resync-note">
                        It opens the {target?.name ?? sync.targetProfile} profile on the site, waits 30 seconds, then syncs it.
                      </span>
                    )}
                    {sync.targetProfile && (
                      <span className="mt-1 block" data-testid="resync-mac-list">
                        This row is on your Mac list now too: the next Run all there re-syncs it for you, so you can also just close this.
                      </span>
                    )}
                  </span>
                </div>
                {sync.status === "pending" && !sync.error && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Waiting for the sync…
                  </div>
                )}
                {sync.status === "error" && (
                  <div className="text-sm text-destructive">The script reported: {sync.error}. Fix it and run the command again.</div>
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
    : state === "disabled" ? <span className="text-muted-foreground">disabled</span>
    : <span className="text-muted-foreground">{laptop === undefined && !error ? "checking…" : "unknown"}</span>;
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
          <span className="font-medium">
            {laptop.heldWrites} {laptop.heldWrites === 1 ? "write" : "writes"} held
          </span>{" "}
          <span className="text-muted-foreground">{state === "online" ? "going out one at a time, 20+ min apart" : "sent when it is back, 20+ min apart"}</span>
        </span>
      )}
      {error && <span className="text-muted-foreground" title={error}>Team Browser status could not be read right now</span>}
    </div>
  );
}

/**
 * the check's states in the page's two accents (the card quality check, rule 3): green signed in, red signed out, a grey
 * pill for not synced; waiting for the laptop, could not check and by its API are plain grey text, not a third colour.
 */
const CHECK_LABEL: Record<SignedInCheck["state"], { text: string; variant: "green" | "red" | "gray" | "text" }> = {
  signed_in: { text: "signed in", variant: "green" },
  signed_out: { text: "signed out", variant: "red" },
  held: { text: "waiting for the laptop", variant: "text" },
  error: { text: "could not check", variant: "text" },
  not_synced: { text: "not synced", variant: "gray" },
  by_api: { text: "by its API", variant: "text" },
};

/**
 * the Team Browser's hourly signed-in check, one line per site: signed in or not, since when, and the one step
 * that fixes it. A synced site that turns signed out also puts that step in the owner's inbox once (the ask code shows here).
 */
export function SignedInChecks({ rows }: { rows?: SignedInCheck[] }) {
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
          const l = CHECK_LABEL[r.state] ?? { text: r.state, variant: "text" as const };
          const needsStep = r.state === "signed_out" || r.state === "not_synced";
          return (
            <li
              key={r.site}
              className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-baseline gap-x-2"
              data-testid={`check-${r.site}`}
            >
              {/* one line per label: a long name ends in an ellipsis and keeps its full name in the title */}
              <span className="truncate font-mono" title={r.site} data-testid="check-label">
                {r.site}
              </span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                {l.variant === "text" ? (
                  <span className="whitespace-nowrap text-muted-foreground">{l.text}</span>
                ) : (
                  <Badge variant={l.variant}>{l.text}</Badge>
                )}
                {r.state !== "not_synced" && r.state !== "by_api" && (
                  <span className="whitespace-nowrap text-muted-foreground" title={formatDateTime(r.since)}>
                    since <RelTime iso={r.since} />
                  </span>
                )}
                {r.ask && (
                  <span className="whitespace-nowrap text-muted-foreground" title={`${r.ask.code} in ${r.ask.path}`}>
                    in your inbox
                  </span>
                )}
              </span>
              {needsStep && r.fix && r.fix !== "none" && <span className="col-span-2 text-muted-foreground sm:col-span-1 sm:col-start-2">{r.fix}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const NARROW = "(max-width: 767.98px)";
/** phones get one card per row instead of the wide table. */
function useNarrow() {
  const mq = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : undefined);
  const [narrow, setNarrow] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq();
    if (!m?.addEventListener) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** another row covers the same site (another profile's sync of it): show which row reads use by default. */
const sharedPattern = (sites: AuthSite[], s: AuthSite) =>
  sites.some((o) => o.id !== s.id && o.pattern.replace(/^\*\./, "") === s.pattern.replace(/^\*\./, ""));

/** The Chrome profile a row came from and the accounts it holds. */
function ProfileCell({ site, shared }: { site: AuthSite; shared: boolean }) {
  const state = syncState(site);
  return (
    <div className="grid gap-1" data-testid="profile-cell">
      <div>
        <span className="text-muted-foreground">{site.sourceBrowser} · </span>
        <span className="font-medium">{profileNameOf(site)}</span>
        {shared && site.defaultForReads && (
          <span className="ml-1 text-muted-foreground" title="Reads that name no account use this row">
            default
          </span>
        )}
      </div>
      {site.accounts?.length ? (
        <div className="flex flex-wrap gap-1">
          {site.accounts.map((a) => (
            <Badge key={a} variant="gray">
              @{a}
            </Badge>
          ))}
        </div>
      ) : null}
      {/* the row's sync state in the words of the inbox reminder */}
      <div
        data-testid="sync-state"
        data-stale={state.stale ? "yes" : "no"}
        className={`break-words text-xs ${state.stale ? "font-medium text-destructive" : "text-muted-foreground"}`}
      >
        {state.line}
      </div>
      {/* the Mac list's Run all re-syncs this row by itself; the line clears when fresh cookies arrive */}
      {site.resync && (
        <div data-testid="mac-list" className="break-words text-xs text-muted-foreground">
          On your Mac list: Run all re-syncs it for you, nothing to paste.
          {site.resync.lastError && <span className="text-destructive"> Last try: {site.resync.lastError}</span>}
        </div>
      )}
    </div>
  );
}

function RowActions({ site, onResync, onClear }: { site: AuthSite; onResync: (patterns: string, target?: SyncTarget) => void; onClear: (s: AuthSite) => void }) {
  return (
    <div className="flex shrink-0 justify-end gap-1">
      <Button
        size="sm"
        variant="outline"
        aria-label={`Re-sync ${site.pattern} from ${profileNameOf(site)}`}
        onClick={() => onResync(site.pattern, targetOf(site))}
      >
        <RefreshCw /> Re-sync
      </Button>
      <Button size="sm" variant="ghost" aria-label={`Clear ${site.pattern} from ${profileNameOf(site)}`} onClick={() => onClear(site)}>
        <Trash2 />
      </Button>
    </div>
  );
}

const plainSite = (pattern: string) => pattern.replace(/^\*\./, "");

/**
 * the page's one-line answer (the card quality check, rule 1): how many synced logins are in sync and which
 * need a Re-sync. A login needs one when its row is out of sync (dead, expired or expiring soon) or the hourly check
 * found its site signed out.
 */
export function authPunchline(sites: AuthSite[], checks: SignedInCheck[] = [], now: Date = new Date()): string {
  if (sites.length === 0) return "No logins synced yet. Press Sync browser auth to add one.";
  const signedOut = new Set(checks.filter((c) => c.state === "signed_out" && c.pattern).map((c) => c.pattern!));
  const need = sites.filter((s) => syncState(s, now).stale || signedOut.has(s.pattern));
  const n = sites.length;
  if (need.length === 0) return n === 1 ? "The 1 synced login is in sync." : `All ${n} synced logins are in sync.`;
  const names = [...new Set(need.map((s) => (s.accounts?.length ? s.accounts.map((a) => "@" + a.replace(/^@/, "")).join(", ") : plainSite(s.pattern))))];
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  return `${n - need.length} of ${n} logins in sync, ${need.length} ${need.length === 1 ? "needs" : "need"} a Re-sync: ${shown}.`;
}

export function BrowserAuthPage() {
  const { data: sites, error, loading } = useQuery(() => api.listAuthSites(), []);
  const [params, setParams] = useSearchParams();
  const token = params.get("sync") ?? undefined;
  const [dialog, setDialog] = useState<{ patterns: string; target?: SyncTarget } | undefined>(token ? { patterns: "" } : undefined);
  const [toClear, setToClear] = useState<AuthSite>();
  const narrow = useNarrow();

  // A reload or shared link with ?sync= reopens the dialog on that token.
  useEffect(() => {
    if (token && !dialog) setDialog({ patterns: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const open = (patterns: string, target?: SyncTarget) => setDialog({ patterns, target });
  const close = () => {
    setDialog(undefined);
    if (params.has("sync")) setParams({}, { replace: true });
  };
  // Push (not replace) so the URL with the token lands in the browser's history: the Mac script looks for it there.
  const onToken = (t: string) => setParams(t ? { sync: t } : {});

  // on the social skin this is the tester's own world: their sign-ins stay in their team's own browser.
  const social = useSkin().id === "social";
  const { data: checks } = useQuery(() => (social ? Promise.resolve([] as SignedInCheck[]) : api.listSignedInCheck()), [social]);
  const about = social
    ? "Your own X and Reddit logins, kept encrypted in your team's own browser: only your team uses them, never anyone else's, and values are never shown. Your Scout, Publisher, Responder, Engager and Reporter start once a sign-in arrives."
    : `Logged-in browser sessions shared with every agent on ${mainHost()} through the Team Browser (MCP team-browser: browse, fetch, screenshot). Stored encrypted; values are never shown.`;
  return (
    <>
      <PageHeader
        title={social ? "Browser sign-ins" : "Browser auth"}
        actions={
          <Button onClick={() => open(social ? "x.com, *.reddit.com" : "*.reddit.com")}>
            <KeyRound /> Sync browser auth
          </Button>
        }
      />
      {/* the one-line answer first, in the console's punchline box (ink border, one green bar; app face, no paper) */}
      {sites && (
        <p
          className="mb-4 rounded-md border border-foreground/70 border-l-[6px] border-l-emerald-800 bg-card px-4 py-3 text-base font-medium leading-snug text-foreground sm:text-lg dark:border-l-emerald-500"
          data-testid="auth-punchline"
        >
          {authPunchline(sites, checks)}
        </p>
      )}
      <LaptopStatus />
      {!social && <SignedInChecks rows={checks} />}
      {error && <ErrorBox error={error} />}
      {loading && <Loading />}
      {sites?.length === 0 && <Empty>No synced sites yet. Click Sync browser auth.</Empty>}
      {sites && sites.length > 0 && (
        <>
          {/* phones: one card per row */}
          {narrow && <ul className="grid gap-2" data-testid="auth-cards">
            {sites.map((s) => (
              <li key={s.id} className="rounded-md border p-3 text-sm" data-testid={`auth-row-${s.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono font-medium">{s.pattern}</div>
                    <div className="truncate text-xs text-muted-foreground">{s.cookieCount} cookies · {s.domains.join(", ")}</div>
                  </div>
                  <RowActions site={s} onResync={open} onClear={setToClear} />
                </div>
                <div className="mt-2">
                  <ProfileCell site={s} shared={sharedPattern(sites, s)} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span title={formatDateTime(s.syncedAt)}>
                    synced <RelTime iso={s.syncedAt} />
                  </span>
                  <span>
                    <SiteExpiry site={s} />
                  </span>
                  {s.session === "dead" && <Badge variant="red">session dead</Badge>}
                </div>
              </li>
            ))}
          </ul>}
          {!narrow && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Profile and accounts</TableHead>
                  <TableHead>Cookies</TableHead>
                  <TableHead>Synced</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((s) => (
                  <TableRow key={s.id} data-testid={`auth-row-${s.id}`}>
                    <TableCell>
                      <div className="font-mono font-medium">{s.pattern}</div>
                      <div className="max-w-[16rem] truncate text-xs text-muted-foreground" title={s.domains.join(", ")}>
                        {s.domains.join(", ")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ProfileCell site={s} shared={sharedPattern(sites, s)} />
                    </TableCell>
                    <TableCell>{s.cookieCount}</TableCell>
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
                      <RowActions site={s} onResync={open} onClear={setToClear} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      {/* what the page is, after the answer and the rows (prose last) */}
      <p className="mt-4 text-xs text-muted-foreground" data-testid="auth-about">
        {about}
      </p>
      {dialog && <SyncDialog token={token} initialPatterns={dialog.patterns} target={dialog.target} onClose={close} onToken={onToken} />}
      <ConfirmDialog
        open={!!toClear}
        onOpenChange={(o) => !o && setToClear(undefined)}
        title={`Clear ${toClear?.pattern ?? "site"}${toClear ? ` from ${profileNameOf(toClear)}` : ""}?`}
        description="Deletes the stored cookies. Agents lose the logged-in session until you sync again."
        confirmLabel="Clear"
        onConfirm={() => api.clearAuthSite(toClear!.id)}
      />
    </>
  );
}
