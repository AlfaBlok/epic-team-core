/**
 * time the Inbox search on production-size data (read only). Feed it the JSON of GET /api/waiting-on-owner
 * (includeSuperseded, includeSettled), /api/review-items (+ ?state=snoozed), /api/status and docs/voice-notes/index.json
 * saved in one directory: `npx tsx scripts/inbox-search-measure.ts <dir>`.
 */
import fs from "node:fs";
import path from "node:path";
import { buildDocs, searchDocs } from "../src/inbox/search.js";

const dir = process.argv[2];
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const waiting = read("waiting.json") as Record<string, unknown>[];
const responses = waiting.flatMap((w) => (w.response ? [{ ...(w.response as object), itemId: w.id }] : []));
const src = { waiting, responses, review: [...read("review.json"), ...read("snoozed.json")], status: read("status.json").items, voice: read("voice.json").notes };
const bytes = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
let t = performance.now();
const docs = buildDocs(src);
const build = performance.now() - t;
const qs = ["condesa", "airbnb", "inbox", "search box", "voice note", "e48", "zzzzzz", "staging deploy", "owner", "co"];
const times = qs.map((q) => {
  const s = performance.now();
  const r = searchDocs(docs, q);
  return { q, ms: +(performance.now() - s).toFixed(2), total: r.total, counts: r.counts };
});
console.log(JSON.stringify({ input: { waiting: waiting.length, responses: responses.length, review: src.review.length, status: src.status.length, voice: src.voice.length, kb: Math.round(bytes / 1024) }, docs: docs.length, buildMs: +build.toFixed(1), queries: times }, null, 1));
