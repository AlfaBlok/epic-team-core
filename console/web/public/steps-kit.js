/*
 * the steps-page kit. Include it on any page that gives the owner steps:
 *
 *   <link rel="stylesheet" href="https://console.example.com/steps-kit.css">
 *   <script src="steps-token.js"></script>   (beside the page, gitignored: window.STEPS_TOKEN = "<the page's token>";)
 *   <script src="https://console.example.com/steps-kit.js" defer></script>
 *   <section data-step="x-epicteam" data-title="X · @EpicTeamHQ" data-row="E907-S5"> … </section>
 *
 * Every element with `data-step` (an id unique on the page) gets three buttons, Not started, Done and Stuck, and a note
 * box (at its `[data-steps-done]` slot, else at its end). Stuck asks for his words; a note can go with any state. `data-row` / `data-ask` name what waits on the step; `data-title` is its name (else its first heading).
 * The token comes from `POST /api/steps/pages` (title, url, repo, spine). Each change or note saves a line in the owning
 * spine, tells the Team desk and wakes the owner; the buttons read their state back from the spine on every load.
 * a change answers at once ("Saved · filing to the repo"); the console files it to the spine in the background
 * and the kit asks again until it reads "In the repo" (and whether the team was woken, or the wake is being retried).
 * a step whose page registered a key for it (`secrets` on POST /api/steps/pages) gets a private box above its
 * buttons: paste, press "Save key · Done", and the key goes to the team's store through the ask's own key path and the
 * step switches to Done in one press (a step with several boxes, once the last one is saved). Write-only: the box empties at once, the key is never shown, read back or kept here.
 * a key that is a file (a JSON service-account key) gets a file box: the page registers it with `file: true` and
 * marks the step `data-secret-file="<app> <NAME>"`; pick the file, press "Save file · Done", and the whole file is stored
 * the same way (store only) and the step switches to Done. The file is read in this tab, sent once and forgotten; its
 * name, size and contents are never shown. A `data-secret-file` the page did not register says so instead of a box.
 * the note box has no length limit here (he pastes long terminal output; the console keeps up to
 * 200 KB and files a long one whole as text beside the spine line), and a voice button: it opens the console's recorder
 * for this step on its https origin (a plain-http tailnet page gets no microphone), which files the words as this
 * step's note, lands them in the memory service, and tells this page to show them. `data-voice-origin` on the script tag picks
 * another console origin. The console serving this file writes its own https address over team.example.com.
 */
(function () {
  var me = document.currentScript;
  // The token is a credential: keep it out of git in a `steps-token.js` beside the page (`window.STEPS_TOKEN = "…"`,
  // gitignored, loaded before the kit); a page served from outside a repo may put it on the script tag instead.
  var token = (me && me.getAttribute("data-steps-token")) || window.STEPS_TOKEN || (document.querySelector('meta[name="steps-token"]') || {}).content;
  var api = ((me && me.getAttribute("data-steps-api")) || (me && me.src ? new URL(me.src).origin : "")).replace(/\/+$/, "");
  if (!token || !api) return;
  var base = api + "/api/public/steps/" + encodeURIComponent(token);
  // The recorder needs a secure page: the console's own https origin unless the kit already comes from one.
  var voiceOrigin = ((me && me.getAttribute("data-voice-origin")) || (/^https:/.test(api) ? api : "https://team.example.com/")).replace(/\/+$/, "");

  function titleOf(el) {
    if (el.getAttribute("data-title")) return el.getAttribute("data-title");
    var h = el.querySelector("h1, h2, h3, h4");
    return ((h && h.textContent) || el.getAttribute("data-step")).replace(/\s+/g, " ").trim();
  }

  function errorOf(r, j) {
    return (j && j.error && j.error.message) || "the console answered " + r.status;
  }

  function call(method, body, where) {
    // text/plain keeps it a simple request (no preflight); the body is JSON.
    return fetch(method === "GET" ? base : base + (where || "/ticks"), {
      method: method,
      headers: method === "GET" ? undefined : { "content-type": "text/plain" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      cache: "no-store",
    }).then(function (r) {
      return r.json().then(
        function (j) {
          if (!r.ok) throw new Error(errorOf(r, j));
          return j;
        },
        function () {
          throw new Error(errorOf(r));
        },
      );
    });
  }

  var steps = [];
  var banner = document.createElement("p");
  banner.className = "sk-banner";
  banner.hidden = true;
  var NAMES = { todo: "Not started", done: "Done", stuck: "Stuck" };
  var poll;

  function hhmm(at) {
    var d = new Date(at);
    return isNaN(d) ? "" : ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  // where the step's newest change is: filing, in the repo, the team woken (or its wake being tried again).
  function progress(ch) {
    if (!ch) return undefined;
    if (ch.status === "saved") return { text: "Saved \u00b7 filing to the repo\u2026" + (ch.reason ? " (" + ch.reason + ")" : ""), open: true };
    if (ch.status === "failed") return { text: "Saved here, but the repo refused it: " + (ch.reason || "unknown") + ". The team is told.", err: true };
    if (ch.status === "undone") return undefined;
    var repo = "In the repo";
    if (ch.wake === "pending" || ch.wake === "waking")
      return { text: repo + " \u00b7 waking the team" + (ch.wakeNextAt && ch.wake === "pending" ? ", next try " + hhmm(ch.wakeNextAt) : "\u2026"), open: true, slow: true };
    if (ch.wake === "off") return { text: repo + " \u00b7 the team is told (nobody is on to start now)" };
    if (ch.wake === "gave_up") return { text: repo + " \u00b7 the team is told; no run started yet", err: true };
    return { text: repo + " \u00b7 the team is told" };
  }

  function showProgress(s, ch) {
    var pr = progress(ch);
    if (!pr) return false;
    s.state.textContent = pr.text;
    s.state.className = "sk-state" + (pr.err ? " err" : pr.open ? "" : " ok");
    return pr;
  }

  // Ask again while a change is still on its way: every 3 s while filing, every 30 s while a wake waits.
  function follow(ms) {
    clearTimeout(poll);
    poll = setTimeout(function () {
      load(true);
    }, ms);
  }

  function show(s, st, notes) {
    s.current = st ? st.state : "todo";
    s.el.classList.toggle("is-done", s.current === "done");
    s.el.classList.toggle("is-stuck", s.current === "stuck");
    s.buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-s") === s.current));
    });
    var items = [];
    if (st && st.state === "stuck" && st.words) items.push({ at: st.at, words: st.words, stuck: true });
    (notes || []).forEach(function (n) {
      items.push(n);
    });
    s.list.innerHTML = "";
    items.slice(-4).forEach(function (n) {
      var li = document.createElement("li");
      li.textContent = (n.stuck ? "Stuck: " : "") + "\u201c" + n.words + "\u201d" + (n.at ? " \u00b7 " + n.at : "");
      s.list.appendChild(li);
    });
    s.list.hidden = !items.length;
  }

  function busy(s, on, text) {
    s.wrap.classList.toggle("is-busy", on);
    s.buttons.concat([s.send, s.box]).forEach(function (b) {
      b.disabled = on;
    });
    Object.keys(s.keys || {}).forEach(function (n) {
      var k = s.keys[n];
      k.input.disabled = on;
      k.save.disabled = on || !k.input.value.trim();
    });
    if (text !== undefined) {
      s.state.textContent = text;
      s.state.className = "sk-state";
    }
    if (!on) s.send.disabled = !s.box.value.trim() && s.pending !== "stuck";
  }

  function send(s, state) {
    var words = s.box.value.trim();
    busy(s, true, state === "stuck" ? "Telling the team you are stuck\u2026" : words && state === s.current ? "Sending your note\u2026" : "Telling the team\u2026");
    call("POST", { step: s.id, state: state, comment: words || undefined, title: titleOf(s.el), row: s.el.getAttribute("data-row") || undefined, ask: s.el.getAttribute("data-ask") || undefined })
      .then(function (r) {
        s.pending = undefined;
        s.box.value = "";
        show(s, r.steps[s.id], r.notes[s.id]);
        if (r.spine === "same") {
          s.state.textContent = "Already " + NAMES[r.state].toLowerCase();
          s.state.className = "sk-state ok";
        } else if (r.spine === "saved" && r.change) {
          showProgress(s, r.change);
          follow(3000);
        } else {
          s.state.textContent = "Saved \u00b7 the team is told";
          s.state.className = "sk-state ok";
        }
      })
      .catch(function (e) {
        s.state.textContent = "Not saved: " + e.message;
        s.state.className = "sk-state err";
      })
      .then(function () {
        busy(s, false);
      });
  }

  function build(el) {
    var id = el.getAttribute("data-step");
    var wrap = document.createElement("div");
    wrap.className = "sk-done";
    wrap.innerHTML =
      '<div class="sk-seg" role="group" aria-label="This step">' +
      '<button type="button" data-s="todo">Not started</button><button type="button" data-s="done">Done</button><button type="button" data-s="stuck">Stuck</button>' +
      '</div><span class="sk-state" aria-live="polite">Loading\u2026</span>' +
      '<div class="sk-note"><textarea rows="2" placeholder="A problem or a note for the team (optional; paste as much as you like)"></textarea>' +
      '<button type="button" class="sk-voice" title="Record a voice note on this step" aria-label="Record a voice note on this step">\ud83c\udfa4 Voice</button>' +
      '<button type="button" class="sk-send">Send</button></div>' +
      '<ul class="sk-notes" hidden></ul>';
    var slot = el.querySelector("[data-steps-done]");
    (slot || el).appendChild(wrap);
    var s = {
      id: id,
      el: el,
      wrap: wrap,
      current: "todo",
      buttons: Array.prototype.slice.call(wrap.querySelectorAll(".sk-seg button")),
      state: wrap.querySelector(".sk-state"),
      box: wrap.querySelector("textarea"),
      send: wrap.querySelector(".sk-send"),
      voice: wrap.querySelector(".sk-voice"),
      list: wrap.querySelector(".sk-notes"),
    };
    s.voice.addEventListener("click", function () {
      var u = voiceOrigin + "/api/public/steps/" + encodeURIComponent(token) + "/voice?step=" + encodeURIComponent(id) + "&title=" + encodeURIComponent(titleOf(el));
      var w = window.open(u, "sk-voice-" + id, "popup,width=460,height=640");
      if (!w) location.href = u;
      s.state.textContent = "Recording in the voice window… it files your words here when you tap send.";
      s.state.className = "sk-state";
    });
    s.buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        var to = b.getAttribute("data-s");
        if (to === "stuck" && !s.box.value.trim()) {
          // Stuck asks for his words first: what went wrong goes to the team with it.
          s.pending = "stuck";
          s.buttons.forEach(function (x) {
            x.setAttribute("aria-pressed", String(x === b));
          });
          s.state.textContent = "Write what went wrong, then Send.";
          s.state.className = "sk-state";
          s.send.disabled = false;
          s.box.focus();
          return;
        }
        s.pending = undefined;
        send(s, to);
      });
    });
    s.box.addEventListener("input", function () {
      s.send.disabled = !s.box.value.trim() && s.pending !== "stuck";
    });
    s.send.addEventListener("click", function () {
      if (s.pending === "stuck" && !s.box.value.trim()) {
        s.state.textContent = "Write what went wrong first.";
        s.box.focus();
        return;
      }
      send(s, s.pending || s.current);
    });
    busy(s, true);
    return s;
  }

  // the private boxes. Built once the page view says this step has some (names only come back, never a value).
  function keyBoxes(s, list) {
    s.keys = s.keys || {};
    list.forEach(function (k) {
      var b = s.keys[k.name];
      if (!b && k.file) b = fileBox(s, k);
      if (!b) {
        var el = document.createElement("div");
        el.className = "sk-key";
        el.innerHTML =
          '<div class="sk-key-head"><span class="sk-key-lock" aria-hidden="true"></span><strong>Private box</strong> <code></code></div>' +
          '<div class="sk-key-row"><input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the key here">' +
          '<button type="button" class="sk-key-save"></button></div>' +
          '<p class="sk-key-note">Write-only: the key goes straight to the team\u2019s safe store. Nobody sees it again, not even on this page.</p>';
        var at = s.wrap.querySelector(".sk-seg");
        s.wrap.insertBefore(el, at);
        b = s.keys[k.name] = { el: el, input: el.querySelector("input"), save: el.querySelector(".sk-key-save"), note: el.querySelector(".sk-key-note") };
        b.save.disabled = true;
        b.input.addEventListener("input", function () {
          b.save.disabled = !b.input.value.trim();
        });
        b.input.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && b.input.value.trim()) saveKey(s, b);
        });
        b.save.addEventListener("click", function () {
          saveKey(s, b);
        });
      }
      b.info = k;
    });
    paintKeys(s);
  }

  // a file box. The file is read here only when Save is pressed; the picker is cleared at once after.
  function fileBox(s, k) {
    var el = document.createElement("div");
    el.className = "sk-key sk-file";
    el.innerHTML =
      '<div class="sk-key-head"><span class="sk-key-lock" aria-hidden="true"></span><strong>Private file box</strong> <code></code></div>' +
      '<div class="sk-key-row"><label class="sk-file-pick"><input type="file" accept=".json,application/json,text/plain"><span>Choose the key file</span></label>' +
      '<button type="button" class="sk-key-save"></button></div>' +
      '<p class="sk-key-note">Write-only: the file goes straight to the team\u2019s safe store. Nobody sees it again, not even on this page. Then delete the downloaded copy.</p>';
    var at = s.wrap.querySelector(".sk-seg");
    s.wrap.insertBefore(el, at);
    var b = (s.keys[k.name] = { el: el, input: el.querySelector("input"), save: el.querySelector(".sk-key-save"), note: el.querySelector(".sk-key-note"), label: el.querySelector(".sk-file-pick span"), file: true });
    b.save.disabled = true;
    b.input.addEventListener("change", function () {
      var f = b.input.files && b.input.files[0];
      b.save.disabled = !f;
      b.label.textContent = f ? "File chosen \u00b7 ready to save" : "Choose the key file";
    });
    b.save.addEventListener("click", function () {
      saveFile(s, b);
    });
    return b;
  }

  function saveFile(s, b) {
    var f = b.input.files && b.input.files[0];
    if (!f) return;
    var forget = function () {
      b.input.value = ""; // write-only: the picker never keeps the file after the press
      b.save.disabled = true;
      b.label.textContent = "Choose the key file";
    };
    if (b.info.maxBytes && f.size > b.info.maxBytes) {
      forget();
      s.state.textContent = "File not saved: it is too big for a key file (at most " + Math.round(b.info.maxBytes / 1024) + " KB). Pick the key file itself.";
      s.state.className = "sk-state err";
      return;
    }
    busy(s, true, "Saving the file in the safe store\u2026");
    var read = f.text ? f.text() : new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result)); };
      r.onerror = function () { no(new Error("the file could not be read")); };
      r.readAsText(f);
    });
    forget();
    read
      .then(function (value) {
        return storeValue(s, b, value, "File");
      })
      .catch(function (e) {
        s.state.textContent = "File not saved: " + e.message;
        s.state.className = "sk-state err";
        busy(s, false);
      });
  }

  function paintKeys(s) {
    var names = Object.keys(s.keys || {});
    var open = names.filter(function (n) {
      return !(s.keys[n].info.set === true);
    });
    names.forEach(function (n) {
      var b = s.keys[n];
      var done = b.info.set === true && !b.info.replace;
      b.el.querySelector("code").textContent = n;
      b.el.classList.toggle("is-set", done);
      b.save.hidden = done;
      if (b.file) b.el.querySelector(".sk-file-pick").hidden = done;
      else b.input.hidden = done;
      // The last box still empty says it also ticks the step.
      var what = b.file ? "file" : "key";
      b.save.textContent = open.length <= 1 ? "Save " + what + " \u00b7 Done" : "Save " + what;
      if (done) b.note.textContent = (b.file ? "File saved" : "Key saved") + " \u00b7 in the team\u2019s safe store, never shown.";
    });
  }

  function saveKey(s, b) {
    var value = b.input.value.trim();
    if (!value) return;
    b.input.value = ""; // write-only: the box never holds it after the press
    busy(s, true, "Saving the key in the safe store\u2026");
    storeValue(s, b, value, "Key");
  }

  function storeValue(s, b, value, what) {
    return call("POST", { step: s.id, name: b.info.name, value: value, title: titleOf(s.el), row: s.el.getAttribute("data-row") || undefined }, "/secret")
      .then(function (r) {
        value = "";
        b.info.set = true;
        paintKeys(s);
        show(s, r.steps[s.id], r.notes[s.id]);
        if (r.missing && r.missing.length) {
          s.state.textContent = what + " saved \u00b7 now the other box";
          s.state.className = "sk-state ok";
        } else if (r.change) {
          showProgress(s, r.change);
          s.state.textContent = what + " saved \u00b7 " + s.state.textContent;
          follow(3000);
        } else {
          s.state.textContent = what + " saved \u00b7 Done";
          s.state.className = "sk-state ok";
        }
      })
      .catch(function (e) {
        value = "";
        s.state.textContent = what + " not saved: " + e.message;
        s.state.className = "sk-state err";
      })
      .then(function () {
        busy(s, false);
      });
  }

  // a step that says `data-secret-file="<app> <NAME>"` but whose page registered no such file box shows why,
  // so nobody is told to pick a file that has nowhere to go.
  function fileUnregistered(s, list) {
    var want = (s.el.getAttribute("data-secret-file") || "").trim().split(/\s+/);
    if (want.length !== 2 || s.fileWarn) return;
    var ok = list.some(function (k) {
      return k.file && k.app === want[0] && k.name === want[1];
    });
    if (ok) return;
    s.fileWarn = document.createElement("p");
    s.fileWarn.className = "sk-key-note sk-file-missing";
    s.fileWarn.textContent = "The private file box for " + want[1] + " is not switched on for this page yet. Do not send the file anywhere else: tell the team with Stuck.";
    s.wrap.insertBefore(s.fileWarn, s.wrap.querySelector(".sk-seg"));
  }

  function load(following) {
    return call("GET")
      .then(function (v) {
        banner.hidden = true;
        var next = 0;
        steps.forEach(function (s) {
          if (s.pending || s.wrap.classList.contains("is-busy") && following) return;
          if ((v.secrets || {})[s.id]) keyBoxes(s, [].concat(v.secrets[s.id]));
          fileUnregistered(s, [].concat((v.secrets || {})[s.id] || []));
          var st = (v.steps || {})[s.id] || ((v.ticks || {})[s.id] ? { state: "done", at: v.ticks[s.id].at } : undefined);
          show(s, st, (v.notes || {})[s.id]);
          busy(s, false);
          var pr = following || (v.changes || {})[s.id] && (v.changes[s.id].status === "saved" || v.changes[s.id].wake === "pending") ? showProgress(s, (v.changes || {})[s.id]) : false;
          if (pr && pr.open) next = Math.min(next || Infinity, pr.slow ? 30000 : 3000);
          if (pr) return;
          s.state.textContent = st ? NAMES[st.state] + (st.at ? " " + st.at : "") : "";
          s.state.className = "sk-state";
        });
        if (next) follow(next);
      })
      .catch(function (e) {
        banner.textContent = "The step buttons cannot reach the team right now (" + e.message + "). Reload in a minute.";
        banner.hidden = false;
        steps.forEach(function (s) {
          s.state.textContent = "Offline";
        });
      });
  }

  // a command the owner must still run carries `data-runs-on="On your Mac, in the Terminal app"` (or "On a server, …"):
  // the kit puts those words above it in large type, with the shells it was tested in (`data-tested-in`, e.g. "zsh and bash").
  function whereLabels() {
    var cmds = document.querySelectorAll("pre[data-runs-on], code[data-runs-on]");
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c.previousElementSibling && c.previousElementSibling.className === "sk-where") continue;
      var p = document.createElement("p");
      p.className = "sk-where";
      p.textContent = c.getAttribute("data-runs-on");
      if (c.getAttribute("data-tested-in")) {
        var sm = document.createElement("small");
        sm.textContent = "Tested in " + c.getAttribute("data-tested-in") + ".";
        p.appendChild(sm);
      }
      c.parentNode.insertBefore(p, c);
    }
  }

  function start() {
    whereLabels();
    var els = document.querySelectorAll("[data-step]");
    for (var i = 0; i < els.length; i++) steps.push(build(els[i]));
    if (!steps.length) return;
    var first = els[0];
    first.parentNode.insertBefore(banner, first);
    load();
    // the voice window filed a note: show it (and its filing progress) now.
    window.addEventListener("message", function (e) {
      if (e.origin === voiceOrigin && e.data && e.data.stepsVoice) load(true);
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") load();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
