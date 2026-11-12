// the installed app's service worker. Only phone notifications: it shows what the console pushes (the Team
// desk answered, a new ask or review card) and opens its page on tap. No caching, no fetch handler: the app loads as before.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try {
    m = e.data ? e.data.json() : {};
  } catch {
    m = { body: e.data ? e.data.text() : "" };
  }
  const title = m.title || "Team";
  e.waitUntil(
    self.registration.showNotification(title, {
      body: m.body || "",
      tag: m.tag || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: typeof m.url === "string" && m.url.startsWith("/") ? m.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The push service renewed the subscription (rare): hand the new one to the console.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      const r = await fetch("/api/push", { credentials: "same-origin" });
      const s = r.ok ? await r.json() : {};
      if (!s.publicKey) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: s.publicKey });
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), device: "renewed" }),
      });
    })(),
  );
});
