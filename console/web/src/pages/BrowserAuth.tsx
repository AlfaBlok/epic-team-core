import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api, type AuthSite, type EgressStatus, type SignedInCheck } from "@/api";
import { useQuery } from "@/lib/data";
import { expiryState, syncState } from "@/lib/auth";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { ConfirmDialog } from "@/components/dialogs";
import { useSkin } from "@/lib/skin";
import { mainHost } from "../lib/identity";

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

/** a row's profile name: the map's label, else the name Chrome gave it at sync time. */
export const profileNameOf = (s: AuthSite) => s.profileLabel ?? s.sourceProfile;

/**
 * the team signs in itself (the Team Browser's own sign_in, with the logins in Bitwarden). The owner rejected
 * the Mac 'Sync browser auth' path, so this page never offers its command, its Get command button or a Re-sync: it
 * shows the sign-ins the team holds, and a row can still be cleared.
 */
export const TEAM_SIGNS_IN = "The team signs in itself with the Team Browser and the logins in Bitwarden. Nothing for you to do here.";

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
              {/* never the Browser's old Mac step (r.fix): the team signs in again itself */}
              {needsStep && <span className="col-span-2 text-muted-foreground sm:col-span-1 sm:col-start-2">The team signs in again itself.</span>}
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
    </div>
  );
}

function RowActions({ site, onClear }: { site: AuthSite; onClear: (s: AuthSite) => void }) {
  return (
    <div className="flex shrink-0 justify-end gap-1">
      <Button size="sm" variant="ghost" aria-label={`Clear ${site.pattern} from ${profileNameOf(site)}`} onClick={() => onClear(site)}>
        <Trash2 />
      </Button>
    </div>
  );
}

const plainSite = (pattern: string) => pattern.replace(/^\*\./, "");

/**
 * the page's one-line answer (the card quality check, rule 1): how many sign-ins the team holds are good and which
 * the team must sign in again (the team does it itself, never the owner). A login needs one when its row is out of sync (dead, expired or expiring soon) or the hourly check
 * found its site signed out.
 */
export function authPunchline(sites: AuthSite[], checks: SignedInCheck[] = [], now: Date = new Date()): string {
  if (sites.length === 0) return "No sign-ins yet. The team signs in itself.";
  const signedOut = new Set(checks.filter((c) => c.state === "signed_out" && c.pattern).map((c) => c.pattern!));
  const need = sites.filter((s) => syncState(s, now).stale || signedOut.has(s.pattern));
  const n = sites.length;
  if (need.length === 0) return n === 1 ? "The 1 sign-in is good." : `All ${n} sign-ins are good.`;
  const names = [...new Set(need.map((s) => (s.accounts?.length ? s.accounts.map((a) => "@" + a.replace(/^@/, "")).join(", ") : plainSite(s.pattern))))];
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  return `${n - need.length} of ${n} sign-ins good, the team signs in again to ${shown}.`;
}

export function BrowserAuthPage() {
  const { data: sites, error, loading } = useQuery(() => api.listAuthSites(), []);
  const [toClear, setToClear] = useState<AuthSite>();
  const narrow = useNarrow();

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
      {sites?.length === 0 && <Empty>Each sign-in the team makes shows here.</Empty>}
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
                  <RowActions site={s} onClear={setToClear} />
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
                      <RowActions site={s} onClear={setToClear} />
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
        {TEAM_SIGNS_IN} {about}
      </p>
      <ConfirmDialog
        open={!!toClear}
        onOpenChange={(o) => !o && setToClear(undefined)}
        title={`Clear ${toClear?.pattern ?? "site"}${toClear ? ` from ${profileNameOf(toClear)}` : ""}?`}
        description="Deletes the stored cookies. The team signs in again itself."
        confirmLabel="Clear"
        onConfirm={() => api.clearAuthSite(toClear!.id)}
      />
    </>
  );
}
