import { DEFAULT_TENANT, type DB } from "../db.js";
import { hooks } from "../plug/hooks.js";

/**
 * What a customer workspace reads of the shared persona text. The shared persona templates and the personas made from
 * them are written by the home team, in its own words (its owner's name, its repo, its memory service). A customer
 * workspace (any tenant whose plan is not `internal`) is served the same text through `hooks.workspaceText`, with its
 * own owner's name and none of the home team's references; the home world and every `internal` world read it unchanged.
 */

/** The owner a customer workspace names (its owner's name, else handle, else "the owner"); undefined for the home team's own worlds. */
export function workspaceOwner(db: DB, tenantId: string | null | undefined): string | undefined {
  if (!tenantId || tenantId === DEFAULT_TENANT) return undefined;
  const t = db.prepare("SELECT plan, owner_name, owner_handle FROM tenants WHERE id = ?").get(tenantId) as
    | { plan?: string | null; owner_name?: string | null; owner_handle?: string | null }
    | undefined;
  if (!t || (t.plan ?? "internal") === "internal") return undefined;
  return String(t.owner_name || t.owner_handle || "").replace(/[\s|]+/g, " ").trim() || "the owner";
}

/** One text as a customer workspace reads it (the text unchanged when there is no customer owner). */
export const forWorkspace = (text: string, owner: string | undefined): string => (owner && text ? hooks.workspaceText(text, owner) : text);

/** A persona as a customer workspace reads it (only the free text changes). */
export function personaForWorkspace<P extends { remit: string }>(p: P, owner: string | undefined): P {
  return owner ? { ...p, remit: forWorkspace(p.remit, owner) } : p;
}

/** A persona template as a customer workspace reads it. */
export function templateForWorkspace<T extends { remit: string; reads: string; writes: string; prompt: string }>(t: T, owner: string | undefined): T {
  if (!owner) return t;
  const f = (s: string) => forWorkspace(s, owner);
  return { ...t, remit: f(t.remit), reads: f(t.reads), writes: f(t.writes), prompt: f(t.prompt) };
}
