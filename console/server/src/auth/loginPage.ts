import { hostOf, sites, socialProduct } from "../identity.js";

/**
 * the login page (GET /login), served by the server so it works with CONSOLE_AUTH=on before and apart from the web
 * build. Three states: log in; pick a world (a login in several); set a password from a one-time setup link (?setup=…);
 * plus a one-time world switch link from the other host (#handoff=…; was ?handoff=), which asks "Continue as <email>
 * into <world>" and is redeemed only on that click, so a link someone else made never signs this browser in by itself.
 * No secrets in the page; it posts JSON to /api/access/*.
 * on the customer sites (cloud.epicteam.app, app.social.app) it also shows Continue with Google and GitHub
 * (auth/oauth.ts; only the ones whose app is set up), which sign in or make a new account; a login in several worlds picks
 * one (#pick=…, a one-time link in the fragment); a failed hop back from the provider says why (?oauth_error=…).
 */
/** the login page, built at call time: its addresses come from the sites in force (identity.ts) */
export const LOGIN_PAGE = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in · EpicTeam</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="EpicTeam">
<meta property="og:type" content="website">
<meta property="og:site_name" content="EpicTeam">
<meta property="og:url" content="${sites().teamUrl}/">
<meta property="og:title" content="EpicTeam">
<meta property="og:description" content="The agent team's console. Goals, reviews and asks in one place.">
<meta property="og:image" content="${sites().teamUrl}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="EpicTeam">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="EpicTeam">
<meta name="twitter:description" content="The agent team's console. Goals, reviews and asks in one place.">
<meta name="twitter:image" content="${sites().teamUrl}/og-image.png">
<style>
  :root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);box-sizing:border-box}
  html{background:Canvas}
  main{box-sizing:border-box;width:min(360px,92vw);padding:24px;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px}
  h1{font-size:20px;margin:0 0 16px}
  label{display:block;font-size:14px;margin:12px 0 4px}
  input,select,button{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:Canvas;color:CanvasText}
  button{margin-top:16px;background:CanvasText;color:Canvas;border:0;cursor:pointer}
  p.err{color:#c62828;font-size:14px;min-height:1em;overflow-wrap:anywhere}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 20px;font-size:18px;font-weight:600;letter-spacing:-0.02em}
  [hidden]{display:none}
  a.oauth{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px;padding:10px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);color:CanvasText;text-decoration:none;font-weight:500}
  a.oauth:hover{background:color-mix(in srgb,CanvasText 6%,transparent)}
  p.note{font-size:14px;margin:4px 0 0;color:color-mix(in srgb,CanvasText 70%,transparent)}
  .or{display:flex;align-items:center;gap:10px;margin:18px 0 0;font-size:13px;color:color-mix(in srgb,CanvasText 55%,transparent)}
  .or::before,.or::after{content:"";flex:1;border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent)}
</style></head>
<body><main>
  <div class="brand"><img src="/favicon.svg" width="32" height="32" alt=""><span data-brand-name>EpicTeam</span></div>
  <section id="oauth" hidden><h1 id="oauthTitle">Log in</h1><p class="note" id="oauthNote" hidden></p><div id="oauthButtons"></div><p class="err" id="errOauth"></p><div class="or">or with email and password</div></section>
  <form id="pick" hidden><h1>Pick a world</h1><p id="pickWho">You belong to several worlds.</p>
    <label for="pickTenant">World</label><select id="pickTenant"></select>
    <button type="submit">Continue</button><p class="err" id="err4"></p>
    <p><a href="/login">Sign in again</a></p>
  </form>
  <form id="login"><h1 id="loginTitle">Log in</h1>
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <label for="tenant" hidden id="tenantLabel">World</label><select id="tenant" name="tenant" hidden></select>
    <button type="submit">Log in</button><p class="err" id="err"></p>
  </form>
  <form id="handoff" hidden><h1>Switch world</h1>
    <p id="hoWho">Checking the switch link…</p>
    <button type="submit" id="hoGo" hidden>Continue</button><p class="err" id="err3"></p>
    <p><a href="/login">Not you? Log in instead</a></p>
  </form>
  <form id="setup" hidden><h1>Set your password</h1>
    <label for="pw1">New password (12+ characters)</label><input id="pw1" type="password" autocomplete="new-password" minlength="12" required>
    <label for="pw2">Again</label><input id="pw2" type="password" autocomplete="new-password" minlength="12" required>
    <button type="submit">Save password</button><p class="err" id="err2"></p>
  </form>
</main>
<script>
  // the brand family name of this host (the social host is the social product's).
  if (location.hostname === ${JSON.stringify(hostOf(sites().socialUrl))}) document.title = ${JSON.stringify(`Log in · ${socialProduct()}`)};
  const q = new URLSearchParams(location.search);
  // a path on this site only: no "//", no backslash, no space or control character anywhere (a browser drops tabs
  // and reads a backslash as a slash, so "/<tab>/x" and "/<backslash>x" would leave the site); same rule as oauth.ts safeNext.
  const okNext = (v) => !!v && v[0] === "/" && v[1] !== "/" && ![...v].some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 92 || ch.charCodeAt(0) === 127);
  const next = okNext(q.get("next")) ? q.get("next") : "/";
  const $ = (id) => document.getElementById(id);
  const post = async (url, body) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("error " + r.status));
    return j;
  };
  if (q.get("setup")) { $("login").hidden = true; $("setup").hidden = false; }
  // Continue with Google or GitHub (only the ones set up for this site), sign-up on the customer sites.
  const OAUTH_ERRORS = {
    state: "That sign-in took too long or came from another tab. Press the button again.",
    cancelled: "The sign-in was cancelled.",
    provider_off: "That sign-in is not switched on here yet.",
    provider_refused: "The provider refused the sign-in. Try again.",
    provider_down: "The provider did not answer. Try again in a minute.",
    email_unverified: "Your account there has no confirmed email address.",
    signup_closed: "New accounts are closed right now. Leave your email on the home page and we will write.",
    signup_full: "Today's new accounts are full. Try again tomorrow.",
    signup_failed: "Your account could not be made. We have been told; try again in a few minutes.",
    no_account: "No account uses that email here.",
    no_world: "Your account has no world yet.",
    disabled: "This account is switched off.",
    platform_private: "The platform is managed from the private console.",
  };
  const oauthErr = q.get("oauth_error");
  if (oauthErr) { history.replaceState(null, "", "/login" + (q.get("next") ? "?next=" + encodeURIComponent(next) : "")); }
  const ICONS = {
    google: '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
    github: '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    test: "",
  };
  fetch("/api/access/oauth/providers").then((r) => r.ok ? r.json() : null).then((j) => {
    if (!j || !j.providers || !j.providers.length) { if (oauthErr) $("err").textContent = OAUTH_ERRORS[oauthErr] || "Sign-in failed: " + oauthErr; return; }
    const product = (document.querySelector("[data-brand-name]") || {}).textContent || "the";
    for (const p of j.providers) {
      const a = document.createElement("a");
      a.className = "oauth";
      a.href = "/api/access/oauth/" + p.id + "/start?next=" + encodeURIComponent(next) + (q.get("s") === "TEST" ? "&s=TEST" : "");
      a.innerHTML = ICONS[p.id] || "";
      a.append(document.createTextNode("Continue with " + p.name));
      $("oauthButtons").append(a);
    }
    if (j.signup) {
      $("oauthTitle").textContent = "Sign in or sign up";
      $("oauthNote").textContent = "New here? Continue with Google or GitHub and your " + product + " account is made for you.";
      $("oauthNote").hidden = false;
    }
    $("loginTitle").hidden = true;
    if ($("login").hidden === false) $("oauth").hidden = false;
    if (oauthErr) $("errOauth").textContent = OAUTH_ERRORS[oauthErr] || "Sign-in failed: " + oauthErr;
  }).catch(() => {});
  // a login in several worlds picks one; the one-time link rides in the fragment, never sent to a server.
  const pickToken = new URLSearchParams(location.hash.slice(1)).get("pick");
  if (pickToken) {
    history.replaceState(null, "", "/login");
    $("login").hidden = true; $("pick").hidden = false;
    post("/api/access/oauth/pick/peek", { token: pickToken })
      .then((j) => {
        for (const w of j.choose) { const o = document.createElement("option"); o.value = w.tenantId; o.textContent = w.tenantName; $("pickTenant").append(o); }
      })
      .catch((err) => { $("err4").textContent = err.message; });
    $("pick").onsubmit = (e) => {
      e.preventDefault();
      post("/api/access/oauth/pick", { token: pickToken, tenant: $("pickTenant").value })
        .then((j) => location.replace(j.next || "/"))
        .catch((err) => { $("err4").textContent = err.message; });
    };
  }
  // a world switch from the other host (the team host <-> the social host) brings a one-time link.
  // it is only read on load (who, which world); it signs in only when the person clicks Continue.
  // the link carries the token after "#" (never sent to a server, so no proxy log holds it); it leaves the
  // address bar and the history at once. A ?handoff= query link is not read.
  const token = new URLSearchParams(location.hash.slice(1)).get("handoff");
  if (token) {
    history.replaceState(null, "", "/login");
    const bad = (err) => { history.replaceState(null, "", "/login"); $("handoff").hidden = true; $("login").hidden = false; $("err").textContent = err.message; };
    $("login").hidden = true; $("handoff").hidden = false;
    post("/api/access/handoff/peek", { token })
      .then((j) => {
        $("hoWho").textContent = "This link signs you in as " + j.email + " into the world " + j.tenantName + ".";
        $("hoGo").textContent = "Continue as " + j.email + " into " + j.tenantName;
        $("hoGo").hidden = false;
      })
      .catch(bad);
    $("handoff").onsubmit = (e) => {
      e.preventDefault();
      $("hoGo").disabled = true;
      post("/api/access/handoff", { token })
        .then(() => location.replace("/"))
        .catch((err) => { $("hoGo").disabled = false; bad(err); });
    };
  }
  $("setup").onsubmit = async (e) => {
    e.preventDefault();
    if ($("pw1").value !== $("pw2").value) { $("err2").textContent = "the two passwords differ"; return; }
    try {
      const j = await post("/api/access/setup", { token: q.get("setup"), password: $("pw1").value });
      history.replaceState(null, "", "/login");
      $("setup").hidden = true; $("login").hidden = false; $("email").value = j.email; $("password").focus();
    } catch (err) { $("err2").textContent = err.message; }
  };
  $("login").onsubmit = async (e) => {
    e.preventDefault();
    $("err").textContent = "";
    const body = { email: $("email").value, password: $("password").value };
    if (!$("tenant").hidden) body.tenant = $("tenant").value;
    try {
      const j = await post("/api/access/login", body);
      if (j.choose) {
        $("tenant").innerHTML = "";
        for (const w of j.choose) { const o = document.createElement("option"); o.value = w.tenantId; o.textContent = w.tenantName; $("tenant").append(o); }
        $("tenant").hidden = false; $("tenantLabel").hidden = false;
        return;
      }
      location.href = next;
    } catch (err) { $("err").textContent = err.message; }
  };
</script></body></html>
`;
