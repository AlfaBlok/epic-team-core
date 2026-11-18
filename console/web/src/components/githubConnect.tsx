import { useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import type { GithubRepoItem, WorldGithubState } from "@/api/client";
import { useQuery } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The owner 2026-11-18 (vn_bd196a82): "I need a button that allows me to say I give permission to this app to read and
 * write on this repo. This is part of the onboarding for creating a workspace ... selecting an existing repo where I have
 * a workspace or creating a new repo in GitHub." One card, three states, the same on Home (while no repo is connected)
 * and on Connections (always):
 *   1. Connect GitHub: one button to GitHub's own page.
 *   2. Pick your repo: one you already have (it says whether it already holds a workspace), or a new one.
 *   3. Connected: who allowed it and the repo.
 */

const WHY: Record<string, string> = {
  cancelled: "You did not say yes on GitHub, so nothing changed. Press the button when you are ready.",
  expired: "That took longer than 10 minutes. Press the button again.",
  refused: "GitHub did not accept that. Press the button again.",
  no_repo_permission: "GitHub did not give the repo permission. Press the button again and say yes to it.",
  not_stored: "GitHub said yes, but it could not be saved here. Nothing was kept. Try again in a minute.",
  unavailable: "GitHub cannot be connected here yet.",
  github_down: "GitHub did not answer. Try again in a minute.",
  not_found: "Sign in as the owner of this workspace, then press the button again.",
};

/** what GitHub's answer left in the address (`?github=…`), read once and taken out of the address. */
function useGithubAnswer(): string | undefined {
  const [answer] = useState(() => new URLSearchParams(window.location.search).get("github") ?? undefined);
  useEffect(() => {
    if (!answer) return;
    const u = new URL(window.location.href);
    u.searchParams.delete("github");
    window.history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
  }, [answer]);
  return answer;
}

export function GithubConnect({ world, state, where, onChange }: { world: string; state: WorldGithubState; where: "home" | "connections"; onChange?: () => void }) {
  const answer = useGithubAnswer();
  if (!state.available && !state.connected) return null;
  const start = `${state.startUrl}${where === "connections" ? "?next=%2Fconnections" : ""}`;
  if (state.repo)
    return where === "home" ? null : (
      <section className="mb-4 grid gap-1 rounded-md border bg-card p-4 text-sm" data-testid="github-connect" data-state="repo">
        <h2 className="text-[15px] font-semibold">GitHub</h2>
        <p className="min-w-0 [overflow-wrap:anywhere]">
          Connected{state.login ? ` as ${state.login}` : ""}. This workspace lives in{" "}
          <a className="underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current" href={`https://github.com/${state.repo}`} target="_blank" rel="noreferrer" data-testid="github-repo">
            {state.repo}
          </a>
          .
        </p>
        <p className="text-xs text-muted-foreground">Your team reads and writes this one repo. Take the permission back any time on GitHub, under Settings, Applications.</p>
      </section>
    );
  if (!state.connected)
    return (
      <section className="mb-4 grid gap-3 rounded-md border bg-card p-4 text-sm" data-testid="github-connect" data-state="start">
        <div className="grid gap-1">
          <h2 className="text-[15px] font-semibold">Connect GitHub</h2>
          <p className="min-w-0 text-muted-foreground">Your workspace lives in a GitHub repo. GitHub asks you to let EpicTeam read and write your repos. Then you pick the one repo your team works in: one you already have, or a new one.</p>
        </div>
        <div>
          <Button asChild size="sm" data-testid="github-start">
            <a href={start}>Connect GitHub</a>
          </Button>
        </div>
        {answer && answer !== "connected" && (
          <p className="text-xs text-red-700 dark:text-red-400" role="alert" data-testid="github-answer">
            {WHY[answer] ?? "That did not work. Press the button again."}
          </p>
        )}
      </section>
    );
  return <PickRepo world={world} login={state.login} start={start} onChange={onChange} />;
}

function PickRepo({ world, login, start, onChange }: { world: string; login?: string; start: string; onChange?: () => void }) {
  const list = useQuery(() => api.listGithubRepos!(world), [world]);
  const [needle, setNeedle] = useState("");
  const [picked, setPicked] = useState<string>();
  const [check, setCheck] = useState<{ repo: string; workspace: boolean; title?: string }>();
  const [name, setName] = useState("my-epicteam-workspace");
  const [busy, setBusy] = useState<"pick" | "new">();
  const [error, setError] = useState<string>();
  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return (list.data?.repos ?? []).filter((r: GithubRepoItem) => !n || r.repo.toLowerCase().includes(n)).slice(0, 8);
  }, [list.data, needle]);
  const pick = (repo: string) => {
    setPicked(repo);
    setCheck(undefined);
    setError(undefined);
    void api.checkGithubRepo!(world, repo).then(
      (c) => setCheck(c),
      () => undefined,
    );
  };
  const run = async (what: "pick" | "new", job: () => Promise<unknown>) => {
    setBusy(what);
    setError(undefined);
    try {
      await job();
      onChange?.();
      window.location.assign("/");
    } catch (x) {
      setError((x as Error).message || "That did not work. Try again.");
      setBusy(undefined);
    }
  };
  return (
    <section className="mb-4 grid gap-4 rounded-md border bg-card p-4 text-sm" data-testid="github-connect" data-state="pick">
      <div className="grid gap-1">
        <h2 className="text-[15px] font-semibold">Pick your repo</h2>
        <p className="min-w-0 text-muted-foreground" data-testid="github-login">
          GitHub is connected{login ? ` as ${login}` : ""}. Your team reads and writes only the repo you pick here.
        </p>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-2" data-testid="github-existing">
          <h3 className="font-medium">A repo you already have</h3>
          <Input className="h-9" placeholder="Search your repos" aria-label="Search your repos" value={needle} onChange={(e) => setNeedle(e.target.value)} autoComplete="off" spellCheck={false} data-testid="github-search" />
          {list.loading && !list.data && <p className="text-xs text-muted-foreground">Reading your repos from GitHub…</p>}
          {list.error && (
            <p className="text-xs text-red-700 dark:text-red-400" role="alert">
              GitHub did not list your repos. <a className="underline" href={start}>Connect GitHub again</a>.
            </p>
          )}
          {list.data && !shown.length && <p className="text-xs text-muted-foreground">No repo of yours matches.</p>}
          {!!shown.length && (
            <ul className="grid min-w-0 divide-y rounded-md border" data-testid="github-repos">
              {shown.map((r) => (
                <li key={r.repo}>
                  <button type="button" onClick={() => pick(r.repo)} aria-pressed={picked === r.repo} className={`flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/60 ${picked === r.repo ? "bg-accent" : ""}`} data-testid="github-repo-item">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r.repo}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{r.private ? "private" : "public"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picked && (
            <div className="grid gap-2" data-testid="github-picked">
              <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="github-check">
                {!check
                  ? `Looking into ${picked}…`
                  : check.workspace
                    ? `${picked} already holds a workspace${check.title ? `, ${check.title}` : ""}. Its goals and key results load as they are.`
                    : `${picked} holds no workspace yet. Your team starts one in it.`}
              </p>
              <div>
                <Button size="sm" disabled={!!busy} pending={busy === "pick"} pendingLabel="Connecting…" onClick={() => run("pick", () => api.pickGithubRepo!(world, picked))} data-testid="github-pick">
                  Use {picked.split("/")[1]}
                </Button>
              </div>
              {busy === "pick" && <p className="text-xs text-muted-foreground">Copying the repo. This can take a minute.</p>}
            </div>
          )}
        </div>
        <form
          className="grid min-w-0 content-start gap-2"
          data-testid="github-new"
          onSubmit={(e) => {
            e.preventDefault();
            void run("new", () => api.newGithubRepo!(world, name.trim()));
          }}
        >
          <h3 className="font-medium">A new repo</h3>
          <Input className="h-9" aria-label="Name of the new repo" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} data-testid="github-new-name" />
          <p className="text-xs text-muted-foreground">Made private in your GitHub account{login ? `, as ${login}/${name.trim() || "…"}` : ""}. This workspace moves into it.</p>
          <div>
            <Button size="sm" variant="outline" type="submit" disabled={!!busy || !name.trim()} pending={busy === "new"} pendingLabel="Making it…" data-testid="github-new-make">
              Make the repo
            </Button>
          </div>
        </form>
      </div>
      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert" data-testid="github-error">
          {error}
        </p>
      )}
    </section>
  );
}

/** the card for one workspace, reading its own state; nothing when the workspace cannot connect GitHub. */
export function GithubConnectFor({ world, where }: { world: string; where: "home" | "connections" }) {
  const state = useQuery(() => (api.getWorldGithub ? api.getWorldGithub(world).catch(() => undefined) : Promise.resolve(undefined)), [world]);
  if (!state.data) return null;
  return <GithubConnect world={world} state={state.data} where={where} />;
}
