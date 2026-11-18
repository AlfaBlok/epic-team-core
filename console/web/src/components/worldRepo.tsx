import { useState } from "react";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { useSkin } from "@/lib/skin";
import { homeWorld } from "@/lib/identity";
import { knownDoor, knownWorld, worldId } from "@/lib/useSocial";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GithubConnect } from "@/components/githubConnect";

/**
 * The owner opens a new account and points it at the repo that already holds the workspace: an EpicTeam workspace that has not picked its repo shows one line on
 * Home to point it at a repo that already holds a workspace (its projects, objectives and key results). The repo and a
 * one-time code from the team; the server clones it as the workspace's own and Home then shows that repo's objectives.
 */
export function HomeRepoLine() {
  const [known] = useState(knownWorld);
  const world = useQuery(() => worldId(), []);
  const w = world.data ?? known;
  const campaigns = !!useSkin().campaigns;
  const customer = !!w && w !== homeWorld() && !knownDoor() && !campaigns;
  const state = useQuery(() => (customer && api.getWorldRepo ? api.getWorldRepo(w!).catch(() => undefined) : Promise.resolve(undefined)), [customer, w]);
  // where GitHub can be connected, Home shows Connect GitHub and the repo picker instead of the code line
  const github = useQuery(() => (customer && api.getWorldGithub ? api.getWorldGithub(w!).catch(() => undefined) : Promise.resolve(undefined)), [customer, w]);
  const [repo, setRepo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!customer || !state.data || state.data.connected) return null;
  if (github.loading && !github.data) return null;
  if (github.data?.available || github.data?.connected) return <GithubConnect world={w!} state={github.data} where="home" />;
  if (!api.connectWorldRepo) return null;
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.connectWorldRepo!(w!, repo.trim(), code.trim());
      window.location.assign("/");
    } catch (x) {
      setError((x as Error).message || "That did not work. Check the repo and the code and try again.");
      setBusy(false);
    }
  };
  return (
    <form onSubmit={connect} className="mb-4 grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="home-repo-line">
      <p className="min-w-0">Your workspace already lives in a repo? Point this one at it and your projects, objectives and key results come with it.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-9 min-w-0 flex-1 basis-48" placeholder="owner/name" aria-label="Repo" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" spellCheck={false} data-testid="repo-input" />
        <Input className="h-9 min-w-0 flex-1 basis-40" placeholder="Code from the team" aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} data-testid="repo-code" />
        <Button size="sm" type="submit" disabled={busy || !repo.trim() || !code.trim()} pending={busy} pendingLabel="Connecting…" data-testid="repo-connect">
          Connect
        </Button>
      </div>
      {busy && <p className="text-xs text-muted-foreground">Copying the repo. This takes a minute.</p>}
      {error && <p className="text-xs text-red-700 dark:text-red-400" role="alert">{error}</p>}
    </form>
  );
}
