import type { ConnectCard as ConnectItem } from "@/api/types";
import { aboutFrom } from "@/lib/about";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { saysNeedle, useSearchNeedle } from "@/lib/inboxSearch";
import { Badge } from "@/components/ui/badge";
import { CARD_TITLE, CardMeta, CardShell } from "@/components/cardShell";
import { CardFeedback } from "@/components/cardFeedback";
import { SentOr } from "@/components/sentRow";

/**
 * The owner asked for a full description of what to do, in which browser: one button per account the team needs. It opens Google's own consent page in the browser he is in, with the
 * account already named; Allow brings him back and the card says Connected. Every step names the site and the account.
 * The inbox shows the ones not connected yet; the Connections page shows all (server auth/connects.ts).
 */
export function ConnectCards({ where }: { where: "inbox" | "connections" }) {
  const list = useConnects(where);
  if (!list.length) return null;
  return (
    <div className="mb-4 space-y-3" data-testid={`connect-cards-${where}`}>
      {list.map((c) => (
        <ConnectCard key={c.id} c={c} />
      ))}
    </div>
  );
}

/**
 * the accounts to connect: in the Inbox the ones not connected yet (they lead Blocked on you,), on the
 * Connections page all. E948-S78: in the Inbox the search box filters them too.
 */
export function useConnects(where: "inbox" | "connections", on = true): ConnectItem[] {
  const { data } = useQuery(() => (on ? api.listConnects() : Promise.resolve(undefined)), [on]);
  const needle = useSearchNeedle();
  return (data?.connects ?? []).filter((c) => (where === "inbox" ? c.inbox && !c.connected && saysNeedle(needle, c.title, c.what, c.account, c.channel?.name, c.channel?.handle, ...c.gives) : true));
}

/**
 * one account to connect, on the one card shell: the kind word Connect, the account, the steps, the green button to
 * Google's page, then the same feedback box as every card. No Park: it stays until the account is connected (server auth/connects.ts).
 */
/** E948-S130: a connect card he wrote on collapses to its green Sent row, like every card. */
export function ConnectCard({ c }: { c: ConnectItem }) {
  return (
    <SentOr slot={`connect:${c.id}`}>
      <ConnectBody c={c} />
    </SentOr>
  );
}

function ConnectBody({ c }: { c: ConnectItem }) {
  const channel = c.channel ? `${c.channel.name} ${c.channel.handle}` : undefined;
  return (
    <CardShell as="section" kind="connect" data-testid={`connect-${c.id}`}>
      <CardMeta
        kind="Connect"
        about={aboutFrom(c.channel ? `connecting ${c.channel.name}` : undefined, c.title)}
        right={
          c.connected && (
            <Badge variant="green" data-testid="connect-state">
              Connected{c.at ? ` ${c.at.slice(0, 10)}` : ""}
            </Badge>
          )
        }
      >
        {!c.connected && <span>One tap from you</span>}
      </CardMeta>
      <h3 className={CARD_TITLE}>{c.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{c.what}</p>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Google account</dt>
        <dd className="font-medium" data-testid="connect-account">{c.account}</dd>
        {channel && (
          <>
            <dt className="text-muted-foreground">YouTube channel</dt>
            <dd className="font-medium" data-testid="connect-channel">
              {channel}
              {c.channel?.id ? <span className="ml-1 break-all text-xs font-normal text-muted-foreground">{c.channel.id}</span> : null}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">It lets the team</dt>
        <dd>{c.gives.join(", ")}</dd>
      </dl>
      {!c.connected && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm" data-testid="connect-steps">
          <li>Press the green button below, in this browser, on your phone or your Mac.</li>
          <li>
            Google's own page opens. If it asks which account, pick <strong>{c.account}</strong>. If it asks for a password, it is the one
            for {c.account}.
          </li>
          <li>If Google says the app is not verified: press Advanced, then the Go to link under it. The app is the team's.</li>
          <li>Tick every box Google shows, then press Allow.</li>
          <li>Google brings you back here and this card says Connected. Nothing else to do.</li>
        </ol>
      )}
      <a
        href={c.startUrl}
        className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg px-5 py-3 text-base font-semibold sm:w-auto ${c.connected ? "border text-foreground hover:bg-muted" : "bg-emerald-800 text-white hover:bg-emerald-900"}`}
        data-testid="connect-button"
      >
        {c.connected ? `Connect again with ${c.account}` : c.title}
      </a>
      <CardFeedback origin={`connect-feedback:${c.id}`} title={c.title} refName={c.id} sent={{ slot: `connect:${c.id}` }} />
    </CardShell>
  );
}
