import type { DB } from "../db.js";
import { ownerName } from "../identity.js";

/**
 * the human who owns a world is named per tenant (`tenants.owner_handle`,
 * `owner_name`) instead of a hard-coded "the owner". The handle is what spines say (`@Ana`, `Ana go`, `Waiting on: Ana`); the
 * name is what the UI shows. the home world's owner is the owner, and every regex below built for "the owner" is the one the parsers
 * used before, so the home world's asks, colors and answer lines stay byte-identical.
 * Out of scope (S4 minimal, plan §7): prompt templates (J4), the EpicSpine handle (J3), table/route names (J1 rename).
 */
export interface OwnerInfo {
  handle: string;
  name: string;
}
export const DEFAULT_OWNER = ownerName();
export const DEFAULT_OWNER_INFO: OwnerInfo = { handle: DEFAULT_OWNER, name: DEFAULT_OWNER };
export const isDefaultOwner = (o?: OwnerInfo) => !o || (o.handle === DEFAULT_OWNER && o.name === DEFAULT_OWNER);

/** The owner of the milestone's world; the owner when the milestone, its tenant or the tenants table is missing. */
export function ownerOf(db: DB, milestoneId?: string): OwnerInfo {
  if (!milestoneId) return DEFAULT_OWNER_INFO;
  try {
    const r = db
      .prepare("SELECT t.owner_handle AS handle, t.owner_name AS name FROM milestones m JOIN tenants t ON t.id = m.tenant_id WHERE m.id = ?")
      .get(milestoneId) as { handle?: string; name?: string } | undefined;
    const handle = r?.handle?.trim();
    return handle ? { handle, name: r?.name?.trim() || handle } : DEFAULT_OWNER_INFO;
  } catch {
    return DEFAULT_OWNER_INFO;
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cache = new Map<string, OwnerPatterns>();
export interface OwnerPatterns {
  /** `who` of an ask names the owner (substring, any case). */
  who: RegExp;
  /** a first clause naming the owner or an approval blocks on the owner. */
  needsHuman: RegExp;
  /** `Waiting on: nobody (the owner: none open)`. */
  none: RegExp;
  /** a ledger owner cell naming the owner first. */
  ownerCell: RegExp;
  /** `the owner: S4 go` / `the owner's go` prefix. */
  prefix: RegExp;
}
/** Regexes for one handle; for "the owner" they match exactly what the hard-coded ones did. */
export function ownerPatterns(handle: string = DEFAULT_OWNER): OwnerPatterns {
  const key = handle.toLowerCase();
  let p = cache.get(key);
  if (!p) {
    const h = esc(key);
    p = {
      who: new RegExp(h, "i"),
      needsHuman: new RegExp(`\\b(${h}|approval|approve|approves|approved)\\b`, "i"),
      none: new RegExp(`\\b${h}\\s*[:—–-]?\\s*(?:none|nothing|nobody|n\\/a)\\b`, "i"),
      ownerCell: new RegExp(`^[\\s@*_\`]*${h}\\b`, "i"),
      prefix: new RegExp(`^(?:${h}(?:'s)?|approval)\\s*[-—:–,]?\\s*`, "i"),
    };
    cache.set(key, p);
  }
  return p;
}
