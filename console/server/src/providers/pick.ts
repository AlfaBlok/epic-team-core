import type { DB } from "../db.js";
import type { Dispatcher, PickArgs, PickResult, WorldPick } from "../t3/dispatcher.js";
import { SEAT_PROVIDER } from "./registry.js";
import { homeWorld, mainHost, workerHost } from "../identity.js";

/**
 * what a wake asks the dispatcher for, and what the run records it got. With the world pick off (default,
 * CONSOLE_PROVIDER_PICK unset) the console calls plain `pick` as today and stamps the seat pool + the persona's model.
 */
export interface Stamp {
  provider: string;
  providerInstance: string;
  model: string;
  priceKey: string;
  notional: boolean;
}

type Row = Record<string, any>;

/** World, persona override and world default for this persona (NULLs = today). */
export function pickArgsFor(db: DB, personaId: string | undefined, personaModel: string): PickArgs {
  const p = personaId ? (db.prepare("SELECT id, tenant_id, provider FROM personas WHERE id = ?").get(personaId) as Row | undefined) : undefined;
  const world = p?.tenant_id ?? homeWorld();
  const t = db.prepare("SELECT default_provider, default_model FROM tenants WHERE id = ?").get(world) as Row | undefined;
  const provider = p?.provider ?? t?.default_provider ?? undefined;
  const model = personaModel.trim() ? personaModel : (t?.default_model ?? personaModel);
  return { world, ...(p ? { persona: p.id } : {}), ...(provider ? { provider } : {}), ...(model.trim() ? { model } : {}) };
}

/**
 * Pick through the dispatcher: world-aware when on and supported, else exactly today's plain `pick`. `owner` (the
 * owner's own action, home world) asks a plain `pick --for owner`, which may give the seat kept for him.
 */
export async function pickWith(d: Dispatcher, worldPick: boolean, args: PickArgs, modelId: (m: string) => string, owner = false): Promise<PickResult & { stamp?: Stamp }> {
  // a Fable wake always tells the broker its model (seats meter Fable apart; some have none in their plan)
  const seatMetered = !!args.model && /fable/i.test(args.model);
  const r =
    owner && args.world === homeWorld()
      ? await d.pick({ for: "owner" })
      : (worldPick || seatMetered) && d.pickFor
        ? await d.pickFor({ ...args, ...(args.model ? { model: modelId(args.model) } : {}) })
        : await d.pick();
  if (r.seat === null) return r;
  const w = r as WorldPick;
  return {
    ...r,
    stamp: {
      provider: w.provider || SEAT_PROVIDER,
      providerInstance: r.providerInstanceId,
      model: w.model || modelId(args.model ?? ""),
      priceKey: w.priceKey || SEAT_PROVIDER,
      notional: typeof w.notional === "boolean" ? w.notional : true,
    },
  };
}

export function stampRun(db: DB, runId: string, s: Stamp | undefined): void {
  if (!s) return;
  db.prepare("UPDATE runs SET provider = ?, provider_instance = ?, model = ?, price_key = ?, notional = ? WHERE id = ?").run(
    s.provider,
    s.providerInstance,
    s.model,
    s.priceKey,
    s.notional ? 1 : 0,
    runId,
  );
}

/** the host the run's agent was launched on (the pick knows it), for the Runs page's live-by-host chart. */
export function stampHost(db: DB, runId: string | undefined, host: string | undefined): void {
  if (runId && (host === mainHost() || host === workerHost())) db.prepare("UPDATE runs SET host = ? WHERE id = ?").run(host, runId);
}

export function rememberThread(db: DB, threadId: string, s: Stamp | undefined): void {
  if (!s) return;
  db.prepare(
    `INSERT INTO provider_threads (thread_id, provider, provider_instance, model, price_key, notional, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET provider = excluded.provider, provider_instance = excluded.provider_instance,
       model = excluded.model, price_key = excluded.price_key, notional = excluded.notional, at = excluded.at`,
  ).run(threadId, s.provider, s.providerInstance, s.model, s.priceKey, s.notional ? 1 : 0, new Date().toISOString());
}

export function threadStamp(db: DB, threadId: string | undefined): Stamp | undefined {
  const r = threadId ? (db.prepare("SELECT * FROM provider_threads WHERE thread_id = ?").get(threadId) as Row | undefined) : undefined;
  return r ? { provider: r.provider, providerInstance: r.provider_instance, model: r.model, priceKey: r.price_key, notional: !!r.notional } : undefined;
}

/** A wake sent into an existing thread ran on what that thread was launched with (unknown for threads from before S13). */
export function stampFromThread(db: DB, runId: string | undefined, threadId: string | undefined): void {
  if (runId) stampRun(db, runId, threadStamp(db, threadId));
}

/** The run's provider fields for the API (only on stamped runs, so older rows answer exactly as before). */
export function runProviderFields(r: Row) {
  return r.provider_instance
    ? { provider: r.provider as string, providerInstance: r.provider_instance as string, model: r.model as string, priceKey: r.price_key as string, notional: !!r.notional }
    : {};
}
