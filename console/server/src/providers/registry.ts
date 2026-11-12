import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seatDir } from "../identity.js";

/**
 * the dispatcher's provider registry (m0/dispatcher/providers.py), read-only here: the same file
 * (CONSOLE_PROVIDERS_FILE, else the ops dir/providers.json next to seats.json) and the same default when it is
 * missing: one class `claude-seat`, the seat pool, shared by every world. It holds no secrets.
 */
export const SEAT_PROVIDER = "claude-seat";

export interface ProviderClass {
  kind: "seat" | "api" | "openrouter" | "opencode" | "codex" | string;
  /** null = shared by every world; else the one world it serves. */
  world: string | null;
  instances?: string[];
  cap?: number;
  priceKey: string;
  notional: boolean;
}
export interface Registry {
  classes: Record<string, ProviderClass>;
  worlds: Record<string, { default?: { provider?: string; model?: string }; personas?: Record<string, { provider?: string; model?: string }> }>;
}

export const DEFAULT_REGISTRY: Registry = {
  classes: { [SEAT_PROVIDER]: { kind: "seat", world: null, priceKey: SEAT_PROVIDER, notional: true } },
  worlds: {},
};

export const registryFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.CONSOLE_PROVIDERS_FILE || path.join(seatDir(), "providers.json");

export function loadRegistry(file = registryFile()): Registry {
  let raw: Partial<Registry>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`providers registry ${file}: ${(e as Error).message}; using the seat pool only`);
    return DEFAULT_REGISTRY;
  }
  const classes: Record<string, ProviderClass> = { ...DEFAULT_REGISTRY.classes };
  for (const [name, c] of Object.entries(raw.classes ?? {}))
    classes[name] = { kind: c.kind, world: c.world ?? null, instances: c.instances, cap: c.cap, priceKey: c.priceKey || name, notional: c.notional ?? c.kind === "seat" };
  return { classes, worlds: raw.worlds ?? {} };
}

/** The classes a world may use (shared ones plus its own), as the API lists them. */
export function classesFor(reg: Registry, world: string) {
  return Object.entries(reg.classes)
    .filter(([, c]) => c.world === null || c.world === world)
    .map(([id, c]) => ({ id, kind: c.kind, world: c.world, priceKey: c.priceKey, notional: c.notional, instances: c.kind === "seat" ? [] : (c.instances ?? []) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
