import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "./fonts.css"; // Inter and Instrument Sans (the wordmark)
import "./polish.css"; // the approved polish layer (both skins)
import { installKeepPlace } from "./lib/keepPlace";
import { installDeepFocus } from "./lib/deepFocus";
import { installChunkReload } from "./lib/lazyPage";
import "./lib/countCheck"; // E948-S141: window.inboxCountCheck(), read by the live inbox count check after each release
import "./lib/inboxOnly"; // root L-87: window.inboxOnlyCheck(), read by the live inbox load check after each release

// the service worker that shows phone notifications (no caching); the Chat page's "Turn on notifications" subscribes.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  // the installed app stays open for days: back on screen it asks for a new worker at once (at most once a minute), so a
  // release's worker is in place before the build watch reloads onto it
  let asked = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - asked < 60_000) return;
    asked = Date.now();
    void navigator.serviceWorker.getRegistration("/").then((r) => r?.update()).catch(() => undefined);
  });
}

// a card that leaves the inbox lands the next card's top where its top was.
installKeepPlace();

// E948-S180: a link with ?focus= or #<id> lands on that one thing, scrolled to and glowing briefly.
installDeepFocus();

// a screen's script gone after a release (screens load on first open): reload once onto the new build.
if (import.meta.env.PROD) installChunkReload();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
