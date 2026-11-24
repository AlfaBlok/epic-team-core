import { execFile } from "../spawnHost.js";
import { mainHost } from "../identity.js";

/** world-aware pick arguments (plan §6b); the console passes the persona's provider + model setting. */
export interface PickArgs {
  world: string;
  persona?: string;
  provider?: string;
  model?: string;
}
/** What a world pick adds to a plain one: the provider class, the model, how it is priced. */
export interface WorldPick {
  provider?: string;
  model?: string | null;
  priceKey?: string;
  notional?: boolean;
}
export type PickResult = ({ seat: string; providerInstanceId: string } & WorldPick) | { seat: null; reason: string };

/** `sessions` JSON of the main server dispatcher (m0/broker `sessions`). */
export interface HostSessions {
  host: string;
  live: number | null;
  cap: number;
  full: boolean;
}

/**
 * `for: "owner"` marks the owner's own pick (his Team desk chat, his hand dispatch, a handover): the broker then
 * may give the one seat kept for him (`pick --for owner`), which every other pick skips. Unset = a persona's pick.
 */
export interface PickOpts {
  for?: "owner";
}

/** M1 seat pool via EPICSPINE_DISPATCHER (`pick` reserves a seat, `done <seat>` releases it). */
export interface Dispatcher {
  pick(o?: PickOpts): Promise<{ seat: string; providerInstanceId: string } | { seat: null; reason: string }>;
  /** `pick --world W [--persona P] [--provider C] [--model M]`. Optional: without it the console uses `pick`. */
  pickFor?(a: PickArgs): Promise<PickResult>;
  /** `signal` (`--signal TEXT`) is the failure text; one matching "could not start this turn" makes the broker avoid the seat 10 min. */
  done(seat: string, failed?: boolean, signal?: string): Promise<void>;
  /** `status` JSON of the pool (read-only). Optional: a dispatcher without it has no seat counts. */
  status?(): Promise<{ name: string; capacity: number; available: number; ceiling?: number; open?: number }>;
  /** live agent sessions on the dispatcher's host (the main server) vs the infra repo S9 cap; live null = unreadable. */
  sessions?(): Promise<HostSessions>;
}

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("sh", ["-c", `${cmd} "$@"`, "dispatcher", ...args], { timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`dispatcher ${args[0]}: ${stderr || err.message}`)) : resolve(stdout),
    ),
  );
}

export function envDispatcher(cmd = process.env.EPICSPINE_DISPATCHER): Dispatcher | undefined {
  if (!cmd) return undefined;
  return runnerDispatcher((args) => sh(cmd, args));
}

/** The dispatcher contract over any runner (args → stdout); reuses it for the worker server's own client over ssh. */
export function runnerDispatcher(run: (args: string[]) => Promise<string>): Dispatcher {
  return {
    async pick(o) {
      const j = JSON.parse(await run(o?.for === "owner" ? ["pick", "--for", "owner"] : ["pick"]));
      return j.id ? { seat: String(j.id), providerInstanceId: String(j.providerInstanceId) } : { seat: null, reason: String(j.reason ?? "no seat") };
    },
    async pickFor(a) {
      const args = ["pick", "--world", a.world];
      for (const k of ["persona", "provider", "model"] as const) if (a[k]) args.push(`--${k}`, a[k]!);
      const j = JSON.parse(await run(args));
      if (!j.id) return { seat: null, reason: String(j.reason ?? "no seat") };
      return {
        seat: String(j.id),
        providerInstanceId: String(j.providerInstanceId),
        ...(j.provider ? { provider: String(j.provider) } : {}),
        ...(j.model ? { model: String(j.model) } : {}),
        ...(j.priceKey ? { priceKey: String(j.priceKey) } : {}),
        ...(typeof j.notional === "boolean" ? { notional: j.notional } : {}),
      };
    },
    async status() {
      const j = JSON.parse(await run(["status"]));
      // the team ceiling (open reservations allowed) and how many are open, when the broker sends them
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
      const ceiling = num(j.ceiling);
      const open = num(j.open);
      return { name: String(j.name ?? "dispatcher"), capacity: Number(j.capacity), available: Number(j.available), ...(ceiling !== undefined ? { ceiling } : {}), ...(open !== undefined ? { open } : {}) };
    },
    async sessions() {
      const j = JSON.parse(await run(["sessions"]));
      const live = typeof j.live === "number" ? j.live : null;
      const cap = Number(j.cap);
      return { host: String(j.host ?? mainHost()), live, cap, full: live !== null && Number.isFinite(cap) && live >= cap };
    },
    async done(seat, failed, signal) {
      await run(["done", seat, ...(failed ? ["--fail"] : []), ...(failed && signal ? ["--signal", signal.slice(0, 300)] : [])]);
    },
  };
}
