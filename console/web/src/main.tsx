import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "./fonts.css"; // Inter and Instrument Sans (the wordmark)
import "./polish.css"; // the approved polish layer (both skins)
import { installKeepPlace } from "./lib/keepPlace";

// the service worker that shows phone notifications (no caching); the Chat page's "Turn on notifications" subscribes.
if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);

// a card that leaves the inbox lands the next card's top where its top was.
installKeepPlace();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
