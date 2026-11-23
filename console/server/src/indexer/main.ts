import { setIdentity, setSites, type Identity, type Sites } from "../identity.js";

/**
 * the indexer process entry (E996-S29). The console's identity (its owner, home world, home repo …) reaches this process
 * in its config, and is set here BEFORE any other module loads: db.ts (DEFAULT_TENANT) and tenancy/owner.ts
 * (DEFAULT_OWNER) read it once at load. Without it the indexer took the neutral home world `home` for the real one, so
 * every home world milestone on a symlinked checkout (a world repo on the main server) read as another world's refused repo
 * and its asks, T9-A10's private key box among them, never reached the owner's inbox.
 */
const c = JSON.parse(process.env.CONSOLE_INDEXER_CONFIG || "{}") as { identity?: Partial<Identity>; sites?: Partial<Sites> };
if (c.identity) setIdentity(c.identity);
// E948-S180: its sites too (the console's own addresses): the review gate tells its own pages from someone else's by them
if (c.sites) setSites(c.sites);
await import("./run.js");
