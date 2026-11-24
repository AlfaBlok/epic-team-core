import { useState } from "react";
import { api, type Socials, type SocialsRow } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { ErrorBox, Loading, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * (the owner's voice note 24 Nov 06:11Z: "Did they set up their X account, meaning that their password is
 * on a bidwarden wallet where a user has been given invited? So we're going to ask them to connect their socials ... there
 * needs to be a UX for it"): Connect your socials. The customer keeps their logins in their own Bitwarden and shares one
 * collection with their team's helper through one invite; the team reads a login only when it signs in. Every tick is read
 * live by the console (GET /tenants/:id/socials); the page only asks for the owner's Bitwarden email once.
 */

const STEPS: { id: Socials["stage"]; title: string }[] = [
  { id: "start", title: "Your Bitwarden" },
  { id: "make", title: "Your team's helper" },
  { id: "invite", title: "Invite the helper" },
  { id: "confirm", title: "Confirm it" },
  { id: "save", title: "Save your logins" },
];
const ORDER: Socials["stage"][] = ["start", "make", "invite", "confirm", "save", "ready"];
const GREEN = "hsl(142 60% 40%)";

function Dot({ state }: { state: "done" | "now" | "later" }) {
  const c = state === "done" ? GREEN : state === "now" ? "hsl(var(--foreground))" : "hsl(var(--border))";
  return (
    <span
      aria-hidden
      className="mt-1 inline-block h-3 w-3 flex-none rounded-full border-2"
      style={{ borderColor: c, background: state === "done" ? c : "transparent" }}
    />
  );
}

/** The one picture: your Bitwarden, one shared collection, the helper, your team's browser. */
function Flow({ v }: { v: Socials }) {
  const boxes = ["Your Bitwarden", v.org ? `${v.org}: one collection` : "One shared collection", "Your team's helper", "Your team signs in"];
  return (
    <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="socials-flow" aria-label="How your logins reach your team">
      {boxes.map((b, i) => (
        <li key={b} className="relative rounded-md border px-3 py-2 text-sm" style={{ borderColor: i === 1 ? GREEN : undefined }}>
          <span className="block text-xs text-muted-foreground">{i + 1}</span>
          {b}
        </li>
      ))}
    </ol>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="rounded bg-muted px-1.5 py-0.5 text-sm [overflow-wrap:anywhere]" data-testid="socials-helper">
        {text}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setDone(true));
        }}
      >
        {done ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

function StartForm({ world, onDone }: { world: string; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [server, setServer] = useState<"com" | "eu">("com");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid max-w-md gap-3"
      data-testid="socials-start"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr(undefined);
        mutate(() => api.startSocials(world, { email, server }))
          .then(onDone)
          .catch((x: Error) => setErr(x.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="grid gap-1 text-sm">
        The email of your Bitwarden account
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <fieldset className="grid gap-1 text-sm">
        <legend className="mb-1">Where your Bitwarden lives</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="server" checked={server === "com"} onChange={() => setServer("com")} /> bitwarden.com
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="server" checked={server === "eu"} onChange={() => setServer("eu")} /> bitwarden.eu
        </label>
      </fieldset>
      <p className="text-sm text-muted-foreground">
        No Bitwarden yet? Make a free account at{" "}
        <a className="underline" href="https://bitwarden.com/go/start-free/" target="_blank" rel="noreferrer">
          bitwarden.com
        </a>{" "}
        first. Your own vault stays yours: your team only ever sees the one collection you share.
      </p>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Starting…" : "Make my team's helper"}
        </Button>
      </div>
    </form>
  );
}

function StepBody({ id, v, world, reload }: { id: Socials["stage"]; v: Socials; world: string; reload: () => void }) {
  const web = v.helper.server ?? "https://vault.bitwarden.com";
  if (id === "start") return <StartForm world={world} onDone={reload} />;
  if (id === "make")
    return (
      <p className="text-sm">
        Your team is making its helper, a Bitwarden account of its own at <Copy text={v.helper.address} />. This takes a minute or two.
      </p>
    );
  if (id === "invite")
    return (
      <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
        <li>
          In{" "}
          <a className="underline" href={`${web}/#/create-organization`} target="_blank" rel="noreferrer">
            your Bitwarden
          </a>
          , make a free organization named <b>{v.org ?? "Your team"}</b>. It comes with one collection: that one is your team's.
        </li>
        <li>
          Open the organization, then Members, then Invite member. Paste <Copy text={v.helper.address} />
        </li>
        <li>Pick the role User, give it that one collection with Can edit, and press Save.</li>
        <li>Your team accepts the invite by itself within a minute.</li>
      </ol>
    );
  if (id === "confirm")
    return (
      <p className="text-sm">
        In your organization, open Members. Next to <b>{v.helper.address}</b> press the menu, then Confirm. Only you, the owner, can do this.
      </p>
    );
  return (
    <p className="text-sm">
      Save each social account's login in that collection, with its site address (like x.com). Each one turns green below within a
      minute.
    </p>
  );
}

function SocialLine({ s }: { s: SocialsRow }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-0" data-testid={`socials-${s.id}`} data-state={s.inVault ? "in" : "out"}>
      <span className="font-medium">{s.label}</span>
      <span className="text-right" style={{ color: s.inVault ? GREEN : "hsl(var(--muted-foreground))" }}>
        {s.inVault ? "Connected" : "Not in your vault yet"}
        {s.lastRead && <span className="block text-xs text-muted-foreground">Last used for a sign-in {new Date(s.lastRead).toLocaleString()}</span>}
      </span>
    </li>
  );
}

export function SocialsPage() {
  const [n, setN] = useState(0);
  const world = useQuery(() => worldId(), []);
  const q = useQuery(async () => api.getSocials(await worldId()), [n]);
  const reload = () => setN((x) => x + 1);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data || !world.data) return <Loading />;
  const v = q.data;
  const at = ORDER.indexOf(v.stage);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Connect your socials"
        description={
          v.xConnected
            ? `Your X is connected: your team signs in with the login you keep in your own Bitwarden. ${v.connected} of ${v.socials.length} socials connected.`
            : "Your team signs in to your socials with logins you keep in your own Bitwarden, shared through one invite."
        }
      />
      <div className="mb-4 rounded-lg border p-4" data-testid="socials-answer" data-stage={v.stage}>
        <p className="text-lg font-semibold">
          {v.xConnected ? "X connected" : at >= ORDER.indexOf("save") ? "Your vault is shared. Save your X login next." : `Step ${at + 1} of 5: ${STEPS[at].title}`}
        </p>
      </div>
      <Flow v={v} />
      {v.platform ? (
        <p className="mb-6 text-sm text-muted-foreground">This workspace uses your own Bitwarden, set up already. The list below is read from it.</p>
      ) : (
        <ol className="mb-8 grid gap-4" data-testid="socials-steps">
          {STEPS.map((s, i) => {
            const state = i < at ? "done" : i === at ? "now" : "later";
            return (
              <li key={s.id} className="flex gap-3" data-testid={`socials-step-${s.id}`} data-state={state}>
                <Dot state={state} />
                <div className="min-w-0 flex-1">
                  <p className={state === "later" ? "text-sm text-muted-foreground" : "text-sm font-semibold"}>
                    {i + 1}. {s.title}
                    {state === "done" && <span className="ml-2 font-normal" style={{ color: GREEN }}>done</span>}
                  </p>
                  {state === "now" && (
                    <div className="mt-2">
                      <StepBody id={s.id} v={v} world={world.data!} reload={reload} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <section aria-label="Your socials" data-testid="socials-list">
        <h2 className="mb-1 text-base font-semibold">Your socials</h2>
        <ul className="rounded-lg border px-4">
          {v.socials.map((s) => (
            <SocialLine key={s.id} s={s} />
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Your team reads a login only when it signs in, and each read shows here. To stop it, remove the helper under Members in your
          Bitwarden.
          {v.helper.at && ` Checked ${new Date(v.helper.at).toLocaleTimeString()}.`}
        </p>
      </section>
    </div>
  );
}
