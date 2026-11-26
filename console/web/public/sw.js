// the installed app's service worker: phone notifications (what the console pushes: the Team desk answered, a new ask
// or review card, its page opened on tap) and reading offline (the owner on a long flight reads the objectives and key
// results with no connection). Read only, network first: online every page and every read
// comes fresh from the console exactly as before and its copy is kept; with no connection the last copy answers, so the
// Objectives page opens with the numbers it last showed, and the next load online resyncs it. Writes are never touched.
// v2 drops the app shell an older release kept (activate deletes every cache not named here).
const PAGES = "offline-pages-v2";
const ASSETS = "offline-assets-v1";
const READS = "offline-reads-v1";
const ASSETS_KEPT = 400;
const READS_KEPT = 300;
// on a slow plane or café connection a read that has a kept copy waits this long before the copy answers.
const SLOW_MS = 6000;
// a page open (the app started on his phone) waits this long for the network before the last app shell answers,
// so a stalled connection right after a release never leaves the app hanging on a blank screen.
const PAGE_SLOW_MS = 8000;
// a chat transcript is never drawn from a saved copy while the network still might answer: his phone showed the chat from
// two hours before. The saved copy answers only when the network fails (no connection).
// pages the console draws on the server, outside the app: never kept as the app shell.
const SERVER_PAGES = /^\/(listen|login)(\/|$)/;
const LIVE_ONLY = [/^\/api\/(tenants\/[^/]+\/)?desk\/messages/, /^\/api\/milestones\/[^/]+\/chat\/messages/];

self.addEventListener("install", (e) =>
  e.waitUntil(
    (async () => {
      // the Objectives list and the app shell from the first install, so the page reads offline even if not opened since.
      await keep(PAGES, "/", await fetch("/", { credentials: "same-origin" }).catch(() => undefined));
      await keep(READS, "/api/scorecards", await fetch("/api/scorecards", { credentials: "same-origin" }).catch(() => undefined));
      await self.skipWaiting();
    })().catch(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      const mine = new Set([PAGES, ASSETS, READS]);
      for (const k of await caches.keys()) if (!mine.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  ),
);

async function keep(name, key, res) {
  if (!res || !res.ok || res.type === "opaque" || res.redirected) return;
  const c = await caches.open(name);
  await c.put(key, stamped(res));
}
// a kept read carries when it was kept; answered from here it says it is a saved copy and from when, so the
// app shows "Saved copy from 14:02, refreshing" until a fresh answer lands. A copy kept before this has the console's Date.
const KEPT_AT = "x-kept-at";
const SAVED = "x-saved-copy";
function stamped(res) {
  const h = new Headers(res.headers);
  h.set(KEPT_AT, new Date().toISOString());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
function asSaved(kept) {
  const h = new Headers(kept.headers);
  h.set(SAVED, kept.headers.get(KEPT_AT) || kept.headers.get("date") || "unknown");
  return new Response(kept.body, { status: kept.status, statusText: kept.statusText, headers: h });
}
// the console's fresh answer arrived after a saved copy was drawn: the open pages read again and drop their note.
async function freshAfterSaved() {
  const wins = await self.clients.matchAll({ type: "window" });
  for (const w of wins) w.postMessage({ type: "saved-copy-fresh" });
}
async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
}
const isJson = (res) => (res.headers.get("content-type") || "").includes("application/json");

self.addEventListener("fetch", (e) => {
  const q = e.request;
  if (q.method !== "GET" || q.headers.has("range") || (q.headers.get("accept") || "").includes("text/event-stream")) return;
  const url = new URL(q.url);
  if (url.origin !== self.location.origin) return;
  if (q.mode === "navigate") return e.respondWith(page(q));
  if (url.pathname.startsWith("/assets/")) return e.respondWith(asset(q));
  if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/push")) return e.respondWith(read(q, LIVE_ONLY.some((r) => r.test(url.pathname))));
});

// a page: the network when it answers (a release shows at once); offline, or no answer in PAGE_SLOW_MS, the last app shell
// (one SPA shell). The late answer is kept, and the open app's build watch (components/NewBuild) moves it onto a newer release.
async function page(q) {
  const live = fetch(q).then(async (res) => {
    // only the app's own shell is kept: a page the server draws itself (a briefing's /listen/<id>) is never kept as the shell.
    if (res.ok && !SERVER_PAGES.test(new URL(q.url).pathname) && (res.headers.get("content-type") || "").includes("text/html")) await keep(PAGES, "/", res.clone());
    return res;
  });
  const kept = await caches.open(PAGES).then((c) => c.match("/"));
  if (!kept) return live;
  const slow = new Promise((ok) => setTimeout(() => ok("slow"), PAGE_SLOW_MS));
  try {
    const first = await Promise.race([live, slow]);
    if (first !== "slow") return first;
  } catch {
    /* no connection: the kept shell */
  }
  live.catch(() => undefined);
  return kept;
}

// a built file: its name holds its hash, so a kept copy is always the right one.
async function asset(q) {
  const c = await caches.open(ASSETS);
  const kept = await c.match(q);
  if (kept) return kept;
  const res = await fetch(q);
  if (res.ok) {
    await c.put(q, res.clone());
    trim(ASSETS, ASSETS_KEPT).catch(() => undefined);
  }
  return res;
}

// a read: the console's answer when it comes, kept; the kept copy when the network fails or is too slow.
async function read(q, liveOnly = false) {
  const c = await caches.open(READS);
  const kept = await c.match(q);
  let drewSaved = false;
  const live = fetch(q).then(async (res) => {
    if (res.ok && isJson(res)) {
      await c.put(q, stamped(res.clone()));
      trim(READS, READS_KEPT).catch(() => undefined);
      if (drewSaved) freshAfterSaved().catch(() => undefined);
    }
    return res;
  });
  if (!kept) return live;
  if (liveOnly) return live.catch(() => asSaved(kept));
  const slow = new Promise((ok) => setTimeout(() => ok("slow"), SLOW_MS));
  try {
    const first = await Promise.race([live, slow]);
    if (first !== "slow") return first;
    live.catch(() => undefined);
    drewSaved = true;
    return asSaved(kept);
  } catch {
    return asSaved(kept);
  }
}

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
