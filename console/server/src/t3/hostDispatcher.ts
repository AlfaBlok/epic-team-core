import { execFile } from "node:child_process";
import { runnerDispatcher, type Dispatcher } from "./dispatcher.js";
import { type HostId, workerHost } from "../identity.js";

/**
 * pick on the LAUNCH host. A persona whose thread launches on the worker server asks the worker server's own dispatcher client
 * (the infra repo provision/the worker server-dispatcher.py): it gates on the worker server's MemAvailable (floor 3000 there, 600 MB per launch
 * from the worker server in the last 2 min), then forwards `pick --from the worker server...` to the central broker on the main server, which keeps the one
 * shared reservation store and the global team ceiling (20) and skips its own the main server memory check. the main server personas keep the
 * console's EPICSPINE_DISPATCHER (the main server floor 2000). Releases (`done`) always go to the central dispatcher: same store.
 */
export const VPS3_CLIENT = (): string => `python3 /usr/local/lib/${workerHost()}/${workerHost()}-dispatcher.py`;

export interface SshTarget {
  ssh: string;
  sshKey?: string;
  knownHosts: string;
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** argv of one call of the remote client: ssh hands a single, shell-quoted command line to the far side. */
export function sshArgv(t: SshTarget, remote: string, args: string[]): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${t.knownHosts}`,
    ...(t.sshKey ? ["-i", t.sshKey] : []),
    t.ssh,
    [remote, ...args.map(shq)].join(" "),
  ];
}

export type Exec = (argv: string[], timeoutMs: number) => Promise<string>;

const sshExec: Exec = (argv, timeout) =>
  new Promise((resolve, reject) =>
    execFile("ssh", argv, { timeout, encoding: "utf8" }, (err, stdout, stderr) =>
      err ? reject(new Error((String(stderr).trim().split("\n").pop() || err.message).slice(0, 200))) : resolve(String(stdout)),
    ),
  );

/**
 * the worker server's own dispatcher over the console's the worker server ssh access. A pick that cannot reach it is a refusal with the reason
 * (never a silent fall back to the main server's gate, which would check the wrong host's memory).
 */
export function vps3Dispatcher(t: SshTarget, o: { remote?: string; exec?: Exec; timeoutMs?: number } = {}): Dispatcher {
  const remote = o.remote || VPS3_CLIENT();
  const exec = o.exec ?? sshExec;
  const timeout = o.timeoutMs ?? 45_000; // two ssh hops (the main server → the worker server → the main server), ~1.5 s when healthy
  const d = runnerDispatcher((args) => exec(sshArgv(t, remote, args), timeout));
  const unreachable = (e: unknown) => ({ seat: null, reason: `${workerHost()} dispatcher unreachable: ${e instanceof Error ? e.message : String(e)}` }) as const;
  return {
    ...d,
    pick: (o) => d.pick(o).catch(unreachable),
    pickFor: (a) => d.pickFor!(a).catch(unreachable),
  };
}

/** The dispatcher a pick for a thread launching on `host` asks: that host's own, else the central one (today). */
export function pickerFor(host: string | undefined, central: Dispatcher, byHost?: Partial<Record<string, Dispatcher>>): Dispatcher {
  return (host && byHost?.[host]) || central;
}

/** index.ts wiring: the worker server's client when the console has the worker server ssh access; CONSOLE_VPS3_DISPATCHER=0 turns it off (= today). */
export function hostDispatchersFromEnv(t: SshTarget | undefined, env: NodeJS.ProcessEnv = process.env): Partial<Record<HostId, Dispatcher>> | undefined {
  if (!t || env.CONSOLE_VPS3_DISPATCHER === "0") return undefined;
  return { [workerHost()]: vps3Dispatcher(t, { remote: env.CONSOLE_VPS3_DISPATCHER || undefined }) };
}
