/**
 * the plain
 * recorder pages (a steps page's note box, a customer's voice feedback link) keep each note in the browser like the console's
 * own (web/src/voice/outbox.ts): every part's audio goes into IndexedDB before it is sent and leaves it once the console has
 * it; the note carries a client id, so a resend (a failure, a reload, a closed tab, a restart) lands in the same note, once.
 *
 * `KEEP` is plain browser JS (no build) defining `window.KEEP`: put/get/notes/part/parts/dropPart/drop, and `drain(o)` that
 * sends every kept note of this page (`o.base`) no recording holds: o.start(rec) -> id, o.segment(id, part), o.finish(id,
 * parts, skip, rec) -> answer, then o.after(answer, rec) (filing it) before the note is dropped. It answers how many went.
 */
export const KEEP_ABANDON_MS = 3 * 60_000;

export const KEEP_JS = String.raw`
window.KEEP = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((ok, no) => {
    if (!window.indexedDB) return no(new Error("no IndexedDB"));
    const r = indexedDB.open("epicteam-voice-keep", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("notes", { keyPath: "cid" }); d.createObjectStore("parts", { keyPath: ["cid", "n"] }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbp = undefined; no(r.error); };
  }));
  // A full or blocked store never stops a note: it is still sent from memory.
  const tx = (store, mode, fn) => open().then((d) => new Promise((ok, no) => {
    const t = d.transaction(store, mode); const q = fn(t.objectStore(store));
    t.oncomplete = () => ok(q ? q.result : undefined); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
  })).catch(() => undefined);
  const range = (cid) => IDBKeyRange.bound([cid, -Infinity], [cid, Infinity]);
  const K = {
    held: new Set(),
    cid: () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)),
    put: (rec) => tx("notes", "readwrite", (s) => { s.put(Object.assign({}, rec, { at: Date.now() })); }),
    get: (cid) => tx("notes", "readonly", (s) => s.get(cid)),
    notes: () => tx("notes", "readonly", (s) => s.getAll()).then((x) => x || []),
    part: (cid, n, blob, seconds) => tx("parts", "readwrite", (s) => { s.put({ cid, n, blob, seconds }); }),
    parts: (cid) => tx("parts", "readonly", (s) => s.getAll(range(cid))).then((x) => x || []),
    dropPart: (cid, n) => tx("parts", "readwrite", (s) => { s.delete([cid, n]); }),
    drop: (cid) => tx("parts", "readwrite", (s) => { s.delete(range(cid)); }).then(() => tx("notes", "readwrite", (s) => { s.delete(cid); })),
    /** Notes of this page kept here and not held by a recording now. */
    waiting: (base) => K.notes().then((all) => all.filter((r) => r.base === base && !K.held.has(r.cid))),
    drain: async (o) => {
      if (K.running) return 0;
      K.running = true; let sent = 0;
      try {
        for (const r0 of await K.waiting(o.base)) {
          if (!r0.send && Date.now() - r0.at < ${KEEP_ABANDON_MS}) continue;
          let r = r0;
          try {
            const parts = await K.parts(r.cid);
            if (!r.id) {
              if (!parts.length && !(r.done || []).length) { await K.drop(r.cid); continue; }
              r = Object.assign({}, r, { id: await o.start(r) }); await K.put(r);
            }
            const done = new Set(r.done || []);
            for (const p of parts) {
              if (!done.has(p.n)) { await o.segment(r.id, p); done.add(p.n); r = Object.assign({}, r, { done: [...done] }); await K.put(r); }
              await K.dropPart(r.cid, p.n);
            }
            const n = Math.max(r.parts || 0, ...[...done].map((x) => x + 1), 0);
            if (!n) { await K.drop(r.cid); continue; }
            const skip = []; for (let i = 0; i < n; i++) if (!done.has(i)) skip.push(i);
            const ans = await o.finish(r.id, n, skip, r);
            if (o.after && !r.filed) { await o.after(ans, r); }
            await K.drop(r.cid); sent++;
          } catch (e) {
            // Already closed on the console (sent from elsewhere, or cancelled there): nothing more to send.
            if (e.status === 409 && /already sent|is (posted|transcribed|discarded|empty)/.test(e.message || "")) { await K.drop(r.cid); continue; }
            await K.put(Object.assign({}, r, { tries: (r.tries || 0) + 1, error: String(e.message || e) }));
          }
        }
      } finally { K.running = false; }
      return sent;
    },
  };
  return K;
})();
`;
