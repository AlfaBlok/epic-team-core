import { plainPersonas, type RecordedPersonas } from "../team/personaRecord.js";
import { RecordError } from "../team/milestoneRecord.js";
import type { Context, Hono } from "hono";
import type { DB } from "../db.js";
import type { Store } from "../store.js";
import { modelId } from "../cycle/service.js";
import { pickArgsFor } from "./pick.js";
import { ensureProviders } from "./schema.js";
import { PROVIDER_PRICES, providerPrice } from "./prices.js";
import { classesFor, loadRegistry, registryFile, SEAT_PROVIDER, type Registry } from "./registry.js";
import { homeWorld } from "../identity.js";

/**
 * routes (plan §6b), read through the (possibly scoped) store so another world's id is a 404:
 *   GET /providers?world=W                 classes a world may use + the price keys (registry and prices; no secrets)
 *   GET /providers/price?priceKey=K&model=M per-million-token price of a model under a provider
 *   GET|PUT /tenants/:id/provider          the world default {defaultProvider, defaultModel} (null = seat pool / persona model)
 *   GET|PUT /personas/:id/provider         the persona override {provider} (null = world default) + what a wake would ask for
 */
export interface ProviderSetting {
  provider: string | null;
}

type Row = Record<string, any>;
const err = (c: Context, status: 400 | 404 | 409 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);

export function mountProviders(api: Hono, o: { db: DB; store: Store; registry?: () => Registry; record?: (s: Store) => RecordedPersonas }) {
  ensureProviders(o.db);
  const reg = o.registry ?? (() => loadRegistry(registryFile()));
  const known = (world: string, provider: string) => classesFor(reg(), world).some((c) => c.id === provider);
  const body = async (c: Context): Promise<Row | undefined> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? b : undefined;
    } catch {
      return undefined;
    }
  };
  const nullableText = (v: unknown) => v === null || (typeof v === "string" && v.trim() !== "");

  api.get("/providers/price", (c) => {
    const model = c.req.query("model");
    if (!model) return err(c, 400, "bad_request", "model is required");
    const p = providerPrice(c.req.query("priceKey"), modelId(model));
    return p ? c.json({ model: modelId(model), ...p }) : err(c, 404, "not_found", `no price for ${model} under ${c.req.query("priceKey") ?? SEAT_PROVIDER}`);
  });
  api.get("/providers", (c) => {
    const world = c.req.query("world") ?? o.store.listTenants()[0]?.id ?? homeWorld();
    if (!o.store.getTenant(world)) return err(c, 404, "not_found", `tenant ${world} not found`);
    return c.json({
      world,
      classes: classesFor(reg(), world),
      prices: Object.entries(PROVIDER_PRICES).map(([priceKey, p]) => ({ priceKey, notional: p.notional, models: Object.keys(p.models) })),
    });
  });

  const tenantSetting = (id: string) => {
    const r = o.db.prepare("SELECT default_provider, default_model FROM tenants WHERE id = ?").get(id) as Row;
    return { tenantId: id, defaultProvider: r.default_provider ?? null, defaultModel: r.default_model ?? null };
  };
  api.get("/tenants/:id/provider", (c) => {
    const id = c.req.param("id");
    return o.store.getTenant(id) ? c.json(tenantSetting(id)) : err(c, 404, "not_found", `tenant ${id} not found`);
  });
  api.put("/tenants/:id/provider", async (c) => {
    const id = c.req.param("id");
    if (!o.store.getTenant(id)) return err(c, 404, "not_found", `tenant ${id} not found`);
    const b = await body(c);
    if (!b) return err(c, 400, "bad_request", "JSON object body required");
    for (const k of ["defaultProvider", "defaultModel"]) if (k in b && !nullableText(b[k])) return err(c, 400, "bad_request", `${k}: a non-empty string or null`);
    if (b.defaultProvider && !known(id, b.defaultProvider)) return err(c, 400, "unknown_provider", `provider ${b.defaultProvider} is not enabled for world ${id}`);
    if ("defaultProvider" in b) o.db.prepare("UPDATE tenants SET default_provider = ? WHERE id = ?").run(b.defaultProvider, id);
    if ("defaultModel" in b) o.db.prepare("UPDATE tenants SET default_model = ? WHERE id = ?").run(b.defaultModel && modelId(b.defaultModel), id);
    return c.json(tenantSetting(id));
  });

  const personaSetting = (id: string) => {
    const per = o.store.getPersona(id)!;
    const r = o.db.prepare("SELECT provider, tenant_id FROM personas WHERE id = ?").get(id) as Row;
    const ask = pickArgsFor(o.db, id, per.model);
    return {
      personaId: id,
      world: r.tenant_id as string,
      provider: (r.provider as string | null) ?? null,
      model: per.model,
      // what a wake asks the dispatcher for (world pick on): override > world default > the seat pool
      effective: { provider: ask.provider ?? SEAT_PROVIDER, model: modelId(ask.model ?? "") },
    };
  };
  api.get("/personas/:id/provider", (c) => {
    const id = c.req.param("id");
    return o.store.getPersona(id) ? c.json(personaSetting(id)) : err(c, 404, "not_found", `persona ${id} not found`);
  });
  api.put("/personas/:id/provider", async (c) => {
    const id = c.req.param("id");
    if (!o.store.getPersona(id)) return err(c, 404, "not_found", `persona ${id} not found`);
    const b = await body(c);
    if (!b || !("provider" in b) || !nullableText(b.provider)) return err(c, 400, "bad_request", "provider: a non-empty string or null");
    if ("model" in b && !nullableText(b.model)) return err(c, 400, "bad_request", "model: a non-empty string");
    const world = (o.db.prepare("SELECT tenant_id FROM personas WHERE id = ?").get(id) as Row).tenant_id as string;
    if (b.provider && !known(world, b.provider)) return err(c, 400, "unknown_provider", `provider ${b.provider} is not enabled for world ${world}`);
    // the persona's file first (a refused write changes nothing), then console.db
    try {
      await (o.record ?? ((s) => plainPersonas(s, o.db)))(o.store).updatePersona(id, { provider: b.provider ?? undefined, ...(typeof b.model === "string" ? { model: b.model } : {}) });
    } catch (e) {
      if (e instanceof RecordError) return err(c, e.status === "failed" ? 502 : 409, e.status === "failed" ? "repo_write_failed" : "repo_write_refused", e.message);
      throw e;
    }
    if (b.provider === null) o.db.prepare("UPDATE personas SET provider = NULL WHERE id = ?").run(id);
    return c.json(personaSetting(id));
  });
}
