// The web suite's identity: the owner is neutral (Sam), so a screen that names the owner proves it reads the identity the
// server writes into the app page (server/src/identityPage.ts); the rest is the hosted console's (lib/pinIdentity.ts).
// A test that checks our own words pins ours: vi.hoisted(async  => (await import("@/lib/pinIdentity")).pinOurIdentity).
import { suiteIdentity } from "./lib/pinIdentity";
globalThis.__IDENTITY__ = suiteIdentity();

// vn_e00f1134: the Sent rows are page state (a card he answered); each test starts with none.
import { afterEach } from "vitest";
import { resetSent } from "./lib/sentRows";
afterEach(() => resetSent());

// the Inbox's place (lib/inboxPlace.ts) is kept per history entry in sessionStorage, and every MemoryRouter starts on the
// same entry ("default"), so each test starts with none, as a new browser tab does.
afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* node environment: no storage */
  }
});
