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

/** the worker server's /proc/meminfo over the same ssh access (the worker ceiling's room reading). */
export function sshMeminfo(t: SshTarget, o: { exec?: Exec; timeoutMs?: number } = {}): () => Promise<string> {
  const exec = o.exec ?? sshExec;
  return () => exec(sshArgv(t, "cat", ["/proc/meminfo"]), o.timeoutMs ?? 20_000);
}

/**
 * the worker server's CPU count, load and memory in one ssh call (`nproc`, /proc/loadavg, /proc/meminfo), for the
 * Hosts page's caps: the load cap is 2 per CPU and the memory floor is read against MemAvailable. Read-only; an off box fails.
 */
export function sshHostLoad(t: SshTarget, o: { exec?: Exec; timeoutMs?: number; client?: string } = {}): () => Promise<string> {
  const exec = o.exec ?? sshExec;
  return () => exec([...sshArgv(t, "nproc; cat", ["/proc/loadavg", "/proc/meminfo"]).slice(0, -1), hostLoadCommand(o.client)], o.timeoutMs ?? 15_000);
}

/**
 * the probe also prints pick's own memory numbers (`PICK {"floor":…,"per":…,"recent":…}`), read by loading the
 * worker server's dispatcher client itself (its MEM_FLOOR_MB or DISPATCH_MEM_FLOOR_MB, MEM_PER_LAUNCH_MB and its
 * recent-launch file), so Hosts shows exactly what pick would answer now and the two can never read memory apart.
 * An older client or a failed load prints nothing extra (Hosts then says the share is unknown, never a guess).
 */
export function hostLoadCommand(client = VPS3_CLIENT().replace(/^python3\s+/, "")): string {
  const py =
    "import importlib.util as u,json,os;" +
    `s=u.spec_from_file_location("d","${client}");d=u.module_from_spec(s);s.loader.exec_module(d);` +
    'print("PICK "+json.dumps({"floor":int(os.environ.get("DISPATCH_MEM_FLOOR_MB") or d.MEM_FLOOR_MB),"per":d.MEM_PER_LAUNCH_MB,"recent":len(d.recent_launches(os.environ)),"window":d.LAUNCH_WINDOW}))';
  return `nproc; cat /proc/loadavg /proc/meminfo; python3 -c '${py}' 2>/dev/null || true`;
}
