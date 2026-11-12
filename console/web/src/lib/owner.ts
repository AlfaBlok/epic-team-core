import type { OwnerInfo } from "@/api/types";
import { ownerName } from "@/lib/identity";

/**
 * the owner of a world is named per tenant; the home world's is the owner and the API leaves the owner out for it, so
 * every string falls back to "the owner" exactly as before. Screens read the same helpers.
 */
// the page's identity (lib/identity.ts) is in place before any module loads, so a constant reads it at load
export const DEFAULT_OWNER = ownerName();
export const ownerLabel = (owner?: Pick<OwnerInfo, "name"> | null) => owner?.name || ownerName();
