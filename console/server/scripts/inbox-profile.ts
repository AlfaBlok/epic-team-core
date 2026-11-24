// time the inbox's first-draw reads in-process against a copy of the console database (no network, no jobs).
// Usage: CONSOLE_DB=<copy> CONSOLE_HOME_WORLD=<world> CONSOLE_HOME_REPO=<repo> tsx scripts/inbox-profile.ts [rounds] [token-file]
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { inboxFirstDraw } from "../src/warmInbox.js";

const rounds = Number(process.argv[2] ?? 5);
const token = process.argv[3] ? fs.readFileSync(process.argv[3], "utf8").trim() : "";
const dbPath = process.env.CONSOLE_DB!;
const db = openDb(dbPath);
const app = createApp(db, { passive: true, readModel: { mode: "worker", dbPath } } as never);
const paths = (process.env.PATHS?.split(",") ?? inboxFirstDraw()).filter(Boolean);
const headers = { authorization: `Bearer ${token}`, "accept-encoding": "gzip" };
const times: Record<string, number[]> = {};
const sizes: Record<string, number> = {};
for (let r = 0; r < rounds; r++) {
  for (const p of paths) {
    const t0 = performance.now();
    const res = await app.request(p, { headers });
    const buf = await res.arrayBuffer();
    (times[p] ??= []).push(performance.now() - t0);
    sizes[p] = buf.byteLength;
    if (r === 0 && res.status !== 200) console.error(p, res.status, new TextDecoder().decode(buf).slice(0, 200));
  }
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
for (const p of paths) console.log(`${med(times[p]).toFixed(0).padStart(6)} ms  first ${times[p][0].toFixed(0).padStart(6)}  ${String(sizes[p]).padStart(8)} B  ${p}`);
process.exit(0);
