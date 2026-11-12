// The web suite's identity: the owner is neutral (Sam), so a screen that names the owner proves it reads the identity the
// server writes into the app page (server/src/identityPage.ts); the rest is the hosted console's (lib/pinIdentity.ts).
// A test that checks our own words pins ours: vi.hoisted(async  => (await import("@/lib/pinIdentity")).pinOurIdentity).
import { suiteIdentity } from "./lib/pinIdentity";
globalThis.__IDENTITY__ = suiteIdentity();
