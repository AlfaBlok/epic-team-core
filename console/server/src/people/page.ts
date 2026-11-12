/**
 * /people, one human's inbox. Server-rendered like the login page (no build), so a
 * person login that reaches nothing else still has a page. Three lists: Answer, Approve, Know. Answer has Not sure (goes
 * to whom they escalate to, with a note); Approve has Approve and Send back (free text is feedback); Know has Seen. The
 * owner also sees the board (who is blocked on whom) and can open anyone's inbox, read only.
 */
export const PEOPLE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inbox · EpicTeam</title><link rel="icon" href="/favicon.svg">
<style>
  :root { --ink:#1d1c1a; --soft:#6b675f; --line:#e4dfd5; --paper:#faf8f3; --card:#fff; --green:#1f5c45; --amber:#8a5a00; --red:#9b2c2c; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:var(--paper); }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  h1 { font-size: 22px; margin: 0; }
  .who { color: var(--soft); font-size: 14px; }
  nav.tabs { display:flex; gap:8px; margin: 20px 0 12px; }
  nav.tabs button { border:1px solid var(--line); background:var(--card); border-radius:999px; padding:6px 14px; font:inherit; cursor:pointer; }
  nav.tabs button[aria-pressed=true] { background:var(--ink); color:#fff; border-color:var(--ink); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin: 10px 0; }
  .card h3 { font-size:16px; margin:0 0 6px; font-weight:600; }
  .meta { color:var(--soft); font-size:13px; }
  .note { margin-top:6px; font-size:14px; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .actions button { border:1px solid var(--line); background:#fff; border-radius:8px; padding:6px 12px; font:inherit; cursor:pointer; }
  .actions button.primary { background:var(--green); border-color:var(--green); color:#fff; }
  textarea { width:100%; min-height:60px; margin-top:8px; font:inherit; padding:8px; border:1px solid var(--line); border-radius:8px; }
  .empty { color:var(--soft); padding: 16px 0; }
  .flash { margin: 8px 0; padding:8px 12px; border-radius:8px; background:#eef5f1; color:var(--green); }
  .flash.bad { background:#fbeeee; color:var(--red); }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-size:14px; vertical-align:top; }
  th { color:var(--soft); font-weight:500; }
  td a { color:var(--ink); }
  section.board { margin-top: 18px; }
  .pill { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; background:#f1ede4; color:var(--soft); margin-left:6px; }
  .seen { opacity:.6; }
  .nowrap { white-space:nowrap; }
</style></head>
<body><main>
<header><h1 id="title">Inbox</h1><span class="who" id="who"></span></header>
<section class="board" id="board" hidden><h2 style="font-size:16px;margin:0 0 8px">Who is blocked on whom</h2><table><thead><tr><th>Human</th><th>Waiting on them</th><th>Oldest</th><th>What is stuck</th></tr></thead><tbody id="boardRows"></tbody></table></section>
<div id="flash"></div>
<nav class="tabs" id="tabs"></nav>
<div id="list"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const q = new URLSearchParams(location.search);
let tab = q.get("tab") || "answer";
let data = null, me = null, viewing = q.get("handle") || "";
const api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || ("HTTP " + r.status));
  return j;
};
const flash = (msg, bad) => { $("flash").innerHTML = msg ? '<div class="flash' + (bad ? " bad" : "") + '">' + esc(msg) + "</div>" : ""; };
const since = (d) => d ? "since " + d : "";
const n = (k, word) => k + " " + word + (k === 1 ? "" : "s");
function card(c, kind) {
  const ro = viewing && me && viewing.toLowerCase() !== (me.handle || "").toLowerCase();
  const id = encodeURIComponent(c.repo) + "/" + encodeURIComponent(c.code);
  let h = '<div class="card' + (c.seen ? " seen" : "") + '" data-path="' + esc(id) + '"><h3>' + esc(c.question) + "</h3>";
  h += '<div class="meta">' + esc(c.goal) + " · " + esc(c.code) + (c.since ? " · " + since(c.since) : "") + "</div>";
  if (c.context) h += '<div class="note">' + esc(c.context) + "</div>";
  if (c.escalatedBy) h += '<div class="note">Passed on by ' + esc(c.escalatedBy) + (c.escalatedNote ? ": " + esc(c.escalatedNote.replace(/^@[^:]+:\\s*/, "")) : "") + "</div>";
  if (kind === "answer" && c.approveBy) h += '<div class="note">' + esc(c.approveBy) + " approves your answer.</div>";
  if (c.recommend && kind === "answer") h += '<div class="note">Recommended: ' + esc(c.recommend) + "</div>";
  if (kind !== "answer" && c.answer) h += '<div class="note"><b>' + esc(c.who) + ' answered:</b> ' + esc(c.answer) + "</div>";
  if (kind === "know" && c.approvedBy) h += '<div class="note">Approved by ' + esc(c.approvedBy) + "</div>";
  if (!ro) {
    if (kind === "answer") {
      h += '<textarea placeholder="Your answer, or what you are unsure about"></textarea><div class="actions">';
      for (const o of c.options || []) h += '<button data-act="answer" data-text="' + esc(o) + '">' + esc(o) + "</button>";
      h += '<button class="primary" data-act="answer">Send answer</button><button data-act="not-sure">Not sure</button></div>';
    } else if (kind === "approve") {
      h += '<textarea placeholder="What should change (only for Send back)"></textarea><div class="actions"><button class="primary" data-act="approve">Approve</button><button data-act="send-back">Send back</button></div>';
    } else if (!c.seen) h += '<div class="actions"><button data-act="seen">Seen</button></div>';
  }
  return h + "</div>";
}
function render() {
  if (!data) return;
  const counts = { answer: data.answer.length, approve: data.approve.length, know: data.know.filter((c) => !c.seen).length };
  $("tabs").innerHTML = ["answer", "approve", "know"].map((t) => '<button data-tab="' + t + '" aria-pressed="' + (t === tab) + '">' + t[0].toUpperCase() + t.slice(1) + " " + counts[t] + "</button>").join("");
  const list = data[tab];
  $("list").innerHTML = list.length ? list.map((c) => card(c, tab)).join("") : '<div class="empty">Nothing here.</div>';
}
async function load() {
  const p = await api("/api/people");
  me = p.me || {};
  if (!me.handle && !me.owner) { $("title").textContent = "Inbox"; $("list").innerHTML = '<div class="empty">This login is on no People list yet. Ask the owner to add you.</div>'; return; }
  const h = viewing || me.handle;
  $("title").textContent = (viewing && viewing !== me.handle ? viewing + "'s inbox" : "Your inbox");
  $("who").textContent = (me.handle ? "@" + me.handle + " · " + me.role : "owner") + (p.world ? " · " + p.world : "");
  if (me.owner) {
    const b = await api("/api/people/board");
    $("board").hidden = !b.people.length;
    $("boardRows").innerHTML = b.people.map((x) => "<tr><td><a href=\\"?handle=" + encodeURIComponent(x.handle) + '">' + esc(x.handle) + '</a><span class="pill">' + esc(x.role) + "</span></td><td>" + n(x.asks, "ask") + ", " + n(x.approvals, "approval") + (x.escalated ? ", " + x.escalated + " passed on" : "") + '</td><td class="nowrap">' + esc(x.oldestSince || "") + "</td><td>" + esc(x.stuck || "") + "</td></tr>").join("") +
      b.unknown.map((u) => '<tr><td>' + esc(u.who) + ' <span class="pill">not on the list</span></td><td colspan="3">' + esc(u.cards.join(", ")) + "</td></tr>").join("");
  }
  if (!h) { $("list").innerHTML = '<div class="empty">The People list names no owner yet.</div>'; return; }
  data = await api("/api/people/inbox" + (viewing ? "?handle=" + encodeURIComponent(viewing) : ""));
  render();
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
  const box = t.closest(".card"); if (!box) return;
  const path = box.dataset.path, act = t.dataset.act, text = (box.querySelector("textarea")?.value || "").trim();
  try {
    if (act === "answer") { const v = t.dataset.text || text; if (!v) return flash("Write your answer first.", true); await api("/api/people/asks/" + path + "/answer", { text: v }); flash("Answer sent."); }
    else if (act === "not-sure") { if (!text) return flash("Say what you are unsure about.", true); const r = await api("/api/people/asks/" + path + "/not-sure", { note: text }); flash("Sent to " + r.to + " with your note."); }
    else if (act === "approve") { await api("/api/people/asks/" + path + "/approve", {}); flash("Approved."); }
    else if (act === "send-back") { if (!text) return flash("Say what should change.", true); await api("/api/people/asks/" + path + "/send-back", { note: text }); flash("Sent back with your note."); }
    else if (act === "seen") { await api("/api/people/asks/" + path + "/seen", {}); }
    await load();
  } catch (err) { flash(err.message, true); }
});
load().catch((err) => flash(err.message, true));
</script>
</body></html>`;
