import fs from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
const out = fs.openSync(process.env.PROF_OUT!, "w");
const say = (s: string) => fs.writeSync(out, s + "\n");
console.log = () => {};
const dbPath = process.env.CONSOLE_DB!;
const db = openDb(dbPath);
const app = createApp(db, { passive: true, readModel: { mode: "worker", dbPath } } as never);
const token = fs.readFileSync(process.argv[2], "utf8").trim();
const p = process.argv[3] ?? "/api/milestones";
for (let r = 0; r < 4; r++) {
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const t0 = performance.now();
  const res = await app.request(p, { headers: { authorization: `Bearer ${token}` } });
  const buf = await res.arrayBuffer();
  h.disable();
  say(`${p} ${res.status} ${(performance.now() - t0).toFixed(0)} ms, ${buf.byteLength} B, loop max delay ${(h.max / 1e6).toFixed(0)} ms`);
}
process.exit(0);
