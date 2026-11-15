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
 * 200 KB and files a long one whole as text beside the spine line), a Voice button and a Picture button:
 * - Voice records in place, like a card's answer box: press, speak, press again and the words are filed as this step's note
 *   (with what is typed in the box and its pictures), through the voice note route the cards use (memory service once, desk).
 *   A browser gives a microphone only to a secure page, and the steps pages live on plain-http tailnet hosts: there the
 *   kit opens this page's secure copy on the console (`/steps/view/<page id>/…`, the same page served over https to
 *   the signed-in owner) the moment the page opens, so pressing Voice records in place and never reloads the
 *   page. No window to close, nothing to copy. `data-voice-upgrade="off"` on the script tag (or `?sk-stay` in the
 *   address) keeps the plain page; Voice there still opens the copy at its step.
 * - Picture attaches screenshots: pick them, paste one (an image on the clipboard) or drop one on the box. Each is uploaded
 *   at once (POST …/files, kept like Chat's attachments) and goes with the note as a line of links the team opens.
 * `data-voice-origin` on the script tag picks another console origin for the secure copy. The console serving this file
 * writes its own https address over team.example.com.
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
      if (n && n.words && n.words.trim()) items.push(n); // never a blank dated note
    });
    s.list.innerHTML = "";
    items.slice(-4).forEach(function (n) {
      var li = document.createElement("li");
      // a note's pictures ride after its words as one line of links (the console's files line): show them as links
      var at = n.words.search(/(^|\s)\ud83d\udcce \S.* attached /);
      var words = at < 0 ? n.words : n.words.slice(0, at).trim();
      var links = at < 0 ? [] : n.words.slice(at).match(/https?:\/\/\S+/g) || [];
      li.appendChild(document.createTextNode((n.stuck ? "Stuck: " : "") + (words ? "\u201c" + words + "\u201d" : "")));
      links.forEach(function (u, i) {
        var a = document.createElement("a");
        a.href = u;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "\ud83d\udcce picture" + (links.length > 1 ? " " + (i + 1) : "");
        li.appendChild(document.createTextNode(" "));
        li.appendChild(a);
      });
      if (n.at) li.appendChild(document.createTextNode(" \u00b7 " + n.at));
      s.list.appendChild(li);
    });
    s.list.hidden = !items.length;
  }

  function busy(s, on, text) {
    s.wrap.classList.toggle("is-busy", on);
    s.buttons.concat([s.send, s.box, s.pic]).forEach(function (b) {
      b.disabled = on;
    });
    if (!s.rec) s.voice.disabled = on;
    Object.keys(s.keys || {}).forEach(function (n) {
      var k = s.keys[n];
      k.input.disabled = on;
      k.save.disabled = on || !k.input.value.trim();
    });
    if (text !== undefined) {
      s.state.textContent = text;
      s.state.className = "sk-state";
    }
    if (!on) sendable(s);
  }

  function sendable(s) {
    s.send.disabled = !!s.rec || (!s.box.value.trim() && !s.files.length && s.pending !== "stuck");
  }

  function send(s, state, spoken) {
    var words = [s.box.value.trim(), (spoken || "").trim()].filter(Boolean).join("\n\n");
    var files = s.files.slice();
    busy(s, true, state === "stuck" ? "Telling the team you are stuck\u2026" : (words || files.length) && state === s.current ? "Sending your note\u2026" : "Telling the team\u2026");
    return filesReady(s)
      .then(function () {
        var ids = files.map(function (f) {
          return f.id;
        });
        return call("POST", { step: s.id, state: state, comment: words || undefined, files: ids.length ? ids : undefined, title: titleOf(s.el), row: s.el.getAttribute("data-row") || undefined, ask: s.el.getAttribute("data-ask") || undefined });
      })
      .then(function (r) {
        s.pending = undefined;
        s.box.value = "";
        clearFiles(s);
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
        // a spoken note that could not be filed goes back into the box, so his words are never lost
        if (spoken) s.box.value = words;
        s.state.textContent = "Not saved: " + e.message + (spoken ? " Your words are in the box: press Send to try again." : "");
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
      '<div class="sk-note"><textarea rows="2" placeholder="A note for the team (optional): type, paste a screenshot, or use Voice"></textarea>' +
      '<button type="button" class="sk-voice" aria-label="Record a voice note on this step"><span class="sk-voice-dot" aria-hidden="true"></span><span class="sk-voice-label">\ud83c\udfa4 Voice</span></button>' +
      '<button type="button" class="sk-pic" title="Attach a screenshot or a photo (or paste one in the box)" aria-label="Attach a screenshot">\ud83d\udcce Picture</button>' +
      '<input type="file" class="sk-pic-input" accept="image/*" multiple hidden>' +
      '<button type="button" class="sk-send">Send</button></div>' +
      '<div class="sk-rec" hidden><span class="sk-rec-time">0:00</span><span class="sk-rec-say">Recording. Press the button again to send.</span><button type="button" class="sk-rec-cancel">Cancel</button></div>' +
      '<ul class="sk-files" hidden></ul>' +
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
      voiceLabel: wrap.querySelector(".sk-voice-label"),
      pic: wrap.querySelector(".sk-pic"),
      picInput: wrap.querySelector(".sk-pic-input"),
      recBar: wrap.querySelector(".sk-rec"),
      fileList: wrap.querySelector(".sk-files"),
      files: [],
      list: wrap.querySelector(".sk-notes"),
    };
    s.voice.title = canRecord() ? "Record a voice note on this step: press, speak, press again to send" : "Record a voice note: opens this page's secure copy, where it records right here";
    s.voice.addEventListener("click", function () {
      voice(s);
    });
    wrap.querySelector(".sk-rec-cancel").addEventListener("click", function () {
      cancelVoice(s);
    });
    s.pic.addEventListener("click", function () {
      s.picInput.click();
    });
    s.picInput.addEventListener("change", function () {
      addFiles(s, s.picInput.files);
      s.picInput.value = "";
    });
    // a pasted screenshot (an image on the clipboard) or one dropped on the box is attached, never pasted as text
    s.box.addEventListener("paste", function (e) {
      var pics = imagesOf(e.clipboardData);
      if (!pics.length) return;
      e.preventDefault();
      addFiles(s, pics);
    });
    wrap.addEventListener("dragover", function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) e.preventDefault();
    });
    wrap.addEventListener("drop", function (e) {
      var pics = imagesOf(e.dataTransfer);
      if (!pics.length) return;
      e.preventDefault();
      addFiles(s, pics);
    });
    s.buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        var to = b.getAttribute("data-s");
        if (to === "stuck" && !s.box.value.trim() && !s.files.length) {
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
      sendable(s);
    });
    s.send.addEventListener("click", function () {
      if (s.pending === "stuck" && !s.box.value.trim() && !s.files.length) {
        s.state.textContent = "Write what went wrong first.";
        s.box.focus();
        return;
      }
      send(s, s.pending || s.current);
    });
    busy(s, true);
    return s;
  }

  // ---- pictures: attached, pasted or dropped; uploaded at once, sent with the note as links ----
  var PIC_MAX = 10 * 1024 * 1024;
  function imagesOf(dt) {
    var out = [];
    if (!dt) return out;
    var list = dt.files && dt.files.length ? dt.files : [];
    for (var i = 0; i < list.length; i++) if (/^image\//.test(list[i].type)) out.push(list[i]);
    if (!out.length && dt.items)
      for (var j = 0; j < dt.items.length; j++) {
        var it = dt.items[j];
        if (it.kind === "file" && /^image\//.test(it.type)) {
          var f = it.getAsFile();
          if (f) out.push(f);
        }
      }
    return out;
  }

  function addFiles(s, list) {
    Array.prototype.slice.call(list || []).forEach(function (f) {
      if (s.files.length >= 8) {
        s.state.textContent = "At most 8 pictures in one note: send these first.";
        s.state.className = "sk-state err";
        return;
      }
      if (!/^image\//.test(f.type)) {
        s.state.textContent = "Only pictures go here (a screenshot or a photo).";
        s.state.className = "sk-state err";
        return;
      }
      if (f.size > PIC_MAX) {
        s.state.textContent = "That picture is over 10 MB: send a smaller one.";
        s.state.className = "sk-state err";
        return;
      }
      var item = { name: f.name || "screenshot.png", url: window.URL && URL.createObjectURL ? URL.createObjectURL(f) : "" };
      item.ready = fetch(base + "/files", {
        method: "POST",
        headers: { "content-type": f.type, "x-filename": encodeURIComponent(item.name) },
        body: f,
        credentials: "omit",
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error(errorOf(r, j));
            item.id = j.file.id;
          });
        })
        .catch(function (e) {
          item.error = e.message || "not uploaded";
        })
        .then(function () {
          paintFiles(s);
        });
      s.files.push(item);
    });
    paintFiles(s);
    sendable(s);
  }

  function paintFiles(s) {
    s.fileList.innerHTML = "";
    s.files.forEach(function (f, i) {
      var li = document.createElement("li");
      li.className = "sk-file-item" + (f.error ? " err" : f.id ? "" : " is-up");
      if (f.url) {
        var img = document.createElement("img");
        img.src = f.url;
        img.alt = "";
        li.appendChild(img);
      }
      var t = document.createElement("span");
      t.textContent = f.error ? "Not uploaded: " + f.error : f.id ? "Ready" : "Uploading…";
      li.appendChild(t);
      var x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", "Remove this picture");
      x.addEventListener("click", function () {
        s.files.splice(i, 1);
        if (f.url && URL.revokeObjectURL) URL.revokeObjectURL(f.url);
        paintFiles(s);
        sendable(s);
      });
      li.appendChild(x);
      s.fileList.appendChild(li);
    });
    s.fileList.hidden = !s.files.length;
  }

  // every picture uploaded (one that failed stops the send, so nothing he attached is lost silently)
  function filesReady(s) {
    return Promise.all(
      s.files.map(function (f) {
        return f.ready;
      }),
    ).then(function () {
      var bad = s.files.filter(function (f) {
        return !f.id;
      });
      if (bad.length) throw new Error("a picture did not upload (" + (bad[0].error || "unknown") + "): remove it with × or try again");
    });
  }

  function clearFiles(s) {
    s.files.forEach(function (f) {
      if (f.url && URL.revokeObjectURL) URL.revokeObjectURL(f.url);
    });
    s.files = [];
    paintFiles(s);
  }

  // ---- voice in place: the recorder of the cards' answer boxes, on this page ----
  var pageId;
  var recording; // the step recording now (one at a time)
  function canRecord() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
  // this page's secure copy on the console, at this step (a plain-http page gets no microphone)
  function secureCopy(id) {
    return voiceOrigin + "/steps/view/" + pageId + location.pathname + location.search + "#sk-voice=" + encodeURIComponent(id);
  }
  // the secure copy of this very page, where it stands (no step armed)
  function secureCopyAt() {
    return voiceOrigin + "/steps/view/" + pageId + location.pathname + location.search + location.hash;
  }
  // open the secure copy at once instead of at the Voice press (that press reloaded the whole page, the owner
  // vn_c68935bb). Only from a plain page that cannot record, to an https console, never from the copy itself, never in a
  // browser driven by a script (the quality check's screenshots stay on the page as served), never when the page says
  // data-voice-upgrade="off" on the kit's script tag or carries ?sk-stay in its address.
  function shouldHop() {
    if (canRecord() || !/^https:\/\//.test(voiceOrigin)) return false;
    if (location.pathname.indexOf("/steps/view/") === 0 || location.origin === voiceOrigin) return false;
    if (navigator.webdriver) return false;
    if (me && me.getAttribute("data-voice-upgrade") === "off") return false;
    if (/[?&]sk-stay\b/.test(location.search)) return false;
    return true;
  }
  var keep;
  function keepReady() {
    if (keep) return keep;
    keep = new Promise(function (ok) {
      if (window.KEEP) return ok(window.KEEP);
      var sc = document.createElement("script");
      sc.src = api + "/api/public/steps-keep.js";
      sc.onload = function () {
        ok(window.KEEP);
      };
      sc.onerror = function () {
        ok(undefined); // no keep: the note still goes from memory
      };
      document.head.appendChild(sc);
    });
    return keep;
  }
  var vbase = base + "/voice";
  function vapi(path, init) {
    return fetch(vbase + path, Object.assign({ credentials: "omit" }, init)).then(function (r) {
      return r.json().then(
        function (j) {
          if (!r.ok) {
            var e = new Error(errorOf(r, j));
            e.status = r.status;
            e.code = j && j.error && j.error.code;
            throw e;
          }
          return j;
        },
        function () {
          var e = new Error(errorOf(r));
          e.status = r.status;
          throw e;
        },
      );
    });
  }
  function clock(ms) {
    var t = Math.floor(ms / 1000);
    return Math.floor(t / 60) + ":" + ("0" + (t % 60)).slice(-2);
  }
  function recLook(s, on, label) {
    s.voice.classList.toggle("on", on);
    s.voiceLabel.textContent = label || (on ? "Send voice" : "🎤 Voice");
    s.voice.setAttribute("aria-label", on ? "Stop and send this voice note" : "Record a voice note on this step");
    s.recBar.hidden = !on;
  }
  function say(s, text, err) {
    s.state.textContent = text;
    s.state.className = "sk-state" + (err ? " err" : "");
  }

  function voice(s) {
    if (s.rec) return s.rec.stopping ? undefined : stopVoice(s);
    if (!canRecord()) {
      if (!pageId) return say(s, "Voice is not ready yet: reload the page in a moment.", true);
      // already the secure copy, but served without https (a test console): no microphone here, never hop again
      if (location.pathname.indexOf("/steps/view/") === 0) return say(s, "This browser gives no microphone on this page. Type the note, or open it on the live console.", true);
      var typed = steps.some(function (x) {
        return x.box.value.trim() || x.files.length;
      });
      if (typed && !window.confirm("Voice records on this page's secure copy. What you typed here and did not send stays behind. Open it?")) return;
      location.href = secureCopy(s.id);
      return;
    }
    if (recording && recording !== s) return say(s, "Another step is recording: send or cancel it first.", true);
    startVoice(s);
  }

  function startVoice(s) {
    var r = (s.rec = { parts: 0, part: 0, skip: [], queue: Promise.resolve(), failed: false });
    recording = s;
    s.voice.classList.remove("is-ready");
    s.voice.disabled = true;
    say(s, "Asking for your microphone…");
    var K;
    keepReady()
      .then(function (k) {
        K = k;
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      })
      .then(
        function (stream) {
          r.stream = stream;
          r.cid = K ? K.cid() : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
          if (K) K.held.add(r.cid);
          r.K = K;
          return vapi("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: (document.title + " · step " + s.id).slice(0, 200), clientId: r.cid }) });
        },
        function () {
          throw Object.assign(new Error("The microphone is needed to record. Allow it, then press Voice again."), { mic: true });
        },
      )
      .then(function (j) {
        if (r.cancelled) return;
        r.note = j.note;
        r.seg = (j.segmentS || 120) * 1000;
        // up to 2 hours, a warning ten minutes before, never cut without a word.
        r.maxMin = j.maxMin || 120;
        r.max = r.maxMin * 60000;
        r.warnAt = (j.warnMin || r.maxMin - 10) * 60000;
        r.rec0 = { cid: r.cid, base: vbase, page: (document.title + " · step " + s.id).slice(0, 200), id: r.note.id, step: s.id, title: titleOf(s.el), parts: 0, done: [] };
        if (r.K) r.K.put(r.rec0);
        startPart(s);
        r.t0 = Date.now();
        s.voice.disabled = false;
        sendable(s);
        recLook(s, true);
        say(s, "Recording… take your time.");
        var time = s.recBar.querySelector(".sk-rec-time");
        r.tick = setInterval(function () {
          var el = Date.now() - r.t0;
          time.textContent = clock(el);
          if (!r.warned && el >= r.warnAt) {
            r.warned = true;
            say(s, Math.max(1, Math.round((r.max - el) / 60000)) + " minutes left: at " + lengthText(r.maxMin) + " this note stops and is sent by itself, everything you said kept. Send it now and start a new one to keep talking.", true);
          }
          if (el >= r.max) {
            stopVoice(s);
            say(s, "Stopped at the " + lengthText(r.maxMin) + " limit and sent. Everything you said up to here is kept.");
          }
        }, 250);
        r.roll = setInterval(function () {
          roll(s);
        }, r.seg);
      })
      .catch(function (e) {
        endVoice(s);
        say(s, e.message, true);
      });
  }

  function mimeOf() {
    return (
      ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].filter(function (m) {
        return window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m);
      })[0] || ""
    );
  }

  function startPart(s) {
    var r = s.rec;
    var m = mimeOf();
    var mr = new MediaRecorder(r.stream, m ? { mimeType: m, audioBitsPerSecond: 32000 } : undefined);
    var n = r.part++;
    var chunks = [];
    var t0 = Date.now();
    mr.ondataavailable = function (e) {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    mr.onstop = function () {
      var secs = (Date.now() - t0) / 1000;
      var blob = new Blob(chunks, { type: (mr.mimeType || m || "audio/webm").split(";")[0] });
      r.parts = Math.max(r.parts, n + 1);
      if (!blob.size) return r.skip.push(n);
      if (r.K) {
        r.K.part(r.cid, n, blob, secs);
        r.K.put(Object.assign(r.rec0, { parts: r.parts }));
      }
      r.queue = r.queue.then(function () {
        return uploadPart(r, n, blob, secs);
      });
    };
    mr.start();
    r.mr = mr;
  }

  function lengthText(min) {
    var h = Math.floor(min / 60),
      m = Math.round(min % 60);
    if (!h) return m + " minutes";
    if (!m) return h === 1 ? "1 hour" : h + " hours";
    return h + " h " + m + " min";
  }

  function uploadPart(r, n, blob, secs) {
    var tries = 0;
    function go() {
      return vapi("/notes/" + r.note.id + "/segments/" + n, { method: "POST", headers: { "content-type": blob.type || "audio/webm", "x-seconds": String(secs) }, body: blob }).then(
        function () {
          if (r.K) {
            r.K.dropPart(r.cid, n);
            r.rec0.done.push(n);
            r.K.put(r.rec0);
          }
        },
        function (e) {
          // the console kept the part's audio but could not turn it into words: it is saved there, and the
          // note names it with its audio link, so it never holds back the rest.
          if (e.code === "transcribe_failed" && tries >= 2) {
            if (r.K) {
              r.K.dropPart(r.cid, n);
              r.rec0.done.push(n);
              r.K.put(r.rec0);
            }
            return;
          }
          if ((e.status && e.status < 500 && e.status !== 429) || ++tries >= 6) {
            r.failed = e.message || "The connection dropped.";
            return;
          }
          return new Promise(function (ok) {
            setTimeout(ok, 1500 * tries);
          }).then(go);
        },
      );
    }
    return go();
  }

  function roll(s) {
    var r = s.rec;
    if (!r || r.stopping || !r.mr || r.mr.state !== "recording") return;
    var old = r.mr;
    startPart(s);
    old.stop();
  }

  function stopVoice(s) {
    var r = s.rec;
    r.stopping = true;
    clearInterval(r.tick);
    clearInterval(r.roll);
    recLook(s, true, "Sending…");
    s.voice.disabled = true;
    s.recBar.hidden = true;
    say(s, "Turning your voice into text…");
    new Promise(function (ok) {
      r.mr.addEventListener(
        "stop",
        function () {
          setTimeout(ok, 0);
        },
        { once: true },
      );
      r.mr.stop();
    })
      .then(function () {
        r.stream.getTracks().forEach(function (t) {
          t.stop();
        });
        return r.queue;
      })
      .then(function () {
        if (r.K) r.K.put(Object.assign(r.rec0, { parts: r.parts, send: true }));
        if (r.failed) throw new Error(r.failed);
        return vapi("/notes/" + r.note.id + "/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: r.parts, skip: r.skip }) });
      })
      .then(function (j) {
        var words = ((j.note && j.note.transcript) || "").trim();
        var K = r.K;
        var cid = r.cid;
        endVoice(s);
        if (!words) {
          if (K) K.drop(cid);
          return say(s, "Nothing could be heard. Please try again a bit closer to the microphone.", true);
        }
        return send(s, s.pending || s.current, words).then(function () {
          if (K) K.drop(cid);
        });
      })
      .catch(function (e) {
        endVoice(s);
        say(s, "Kept on this device, sent by itself when the connection is back (" + e.message + ").", true);
        drainKept();
      });
  }

  function cancelVoice(s) {
    var r = s.rec;
    if (!r) return;
    r.cancelled = r.stopping = true;
    clearInterval(r.tick);
    clearInterval(r.roll);
    try {
      if (r.mr && r.mr.state === "recording") {
        r.mr.onstop = null;
        r.mr.stop();
      }
    } catch (e) {}
    if (r.stream)
      r.stream.getTracks().forEach(function (t) {
        t.stop();
      });
    if (r.K && r.cid) r.K.drop(r.cid);
    if (r.note) vapi("/notes/" + r.note.id + "/discard", { method: "POST" }).catch(function () {});
    endVoice(s);
    say(s, "Cancelled. Nothing was sent.");
  }

  function endVoice(s) {
    var r = s.rec;
    if (r) {
      clearInterval(r.tick);
      clearInterval(r.roll);
      if (r.K && r.cid) r.K.held.delete(r.cid);
    }
    s.rec = undefined;
    if (recording === s) recording = undefined;
    recLook(s, false);
    s.recBar.querySelector(".sk-rec-time").textContent = "0:00";
    s.voice.disabled = false;
    sendable(s);
  }

  // a note kept on this device (the connection dropped, the page closed mid-send) goes by itself, filed on its step
  var drainTimer;
  function drainKept() {
    if (!canRecord()) return;
    keepReady().then(function (K) {
      if (!K) return;
      K.drain({
        base: vbase,
        start: function (rec) {
          return vapi("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: rec.page, clientId: rec.cid }) }).then(function (j) {
            return j.note.id;
          });
        },
        segment: function (id, p) {
          return vapi("/notes/" + id + "/segments/" + p.n, { method: "POST", headers: { "content-type": p.blob.type || "audio/webm", "x-seconds": String(p.seconds) }, body: p.blob }).catch(function (e) {
            // the audio is on the console; the note names the part.
            if (e.code === "transcribe_failed") return {};
            throw e;
          });
        },
        finish: function (id, n, sk) {
          return vapi("/notes/" + id + "/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: n, skip: sk }) });
        },
        after: function (j, rec) {
          var words = ((j.note && j.note.transcript) || "").trim();
          if (!words) return;
          return call("POST", { step: rec.step, title: rec.title, comment: words }).then(function () {
            load(true);
          });
        },
      })
        .then(function () {
          return K.waiting(vbase);
        })
        .then(function (left) {
          clearTimeout(drainTimer);
          if (left && left.length) drainTimer = setTimeout(drainKept, 20000);
        });
    });
  }

  // opened from a plain-http page's Voice button: this is the secure copy, scroll to the step and make its button ready
  function armFromHash() {
    var m = /[#&]sk-voice=([^&]+)/.exec(location.hash);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    var s = steps.filter(function (x) {
      return x.id === id;
    })[0];
    if (!s) return;
    s.el.scrollIntoView({ block: "center" });
    s.voice.classList.add("is-ready");
    if (canRecord()) say(s, "Press Voice to start talking; press it again to send.");
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (e) {}
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
        if (v.page && v.page.id) pageId = v.page.id;
        var next = 0;
        steps.forEach(function (s) {
          if (s.pending || s.rec || s.wrap.classList.contains("is-busy") && following) return;
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
    // a plain-http page opens its secure copy at once, so Voice records in place there and its press never
    // reloads the page. The page stays hidden for that instant (at most 1.5 s, then shown as it is).
    var hop = shouldHop();
    var cover;
    if (hop) {
      document.documentElement.style.visibility = "hidden";
      cover = setTimeout(uncover, 1500);
    }
    function uncover() {
      clearTimeout(cover);
      document.documentElement.style.visibility = "";
    }
    load().then(function () {
      if (hop && pageId) {
        try {
          (window.SK_NAVIGATE || function (u) { location.replace(u); })(secureCopyAt()); // tests watch the hop
          return;
        } catch (e) {}
      }
      if (hop) uncover();
      armFromHash();
    });
    drainKept();
    window.addEventListener("online", drainKept);
    // a long recording keeps going when the phone locks: cut a part then, so nothing waits only in memory
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && recording) roll(recording);
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") load();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
