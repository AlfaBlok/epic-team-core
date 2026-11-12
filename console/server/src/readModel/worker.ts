import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { fixtureRunner, rescanGapMs, spinesPyRunner } from "../adapters/spines.js";
import { createRefresher } from "./refresher.js";
import { workerSpinesRunner } from "./spinesBridge.js";
import type { ViewKey } from "./views.js";

/**
 * the read model's refresher on its own thread (host.ts starts it). Its own SQLite connection (WAL: readers and
 * the main thread's writes never wait on each other), its own spines.py runs and trees, so a cold build of every
 * waiting-on-you list and status never holds a request on the main thread.
 */
interface Data {
  dbPath: string;
  reposRoot: string;
  skillDir?: string;
  spinesFixture?: string;
  tenant?: string;
  teamRepo?: string;
  worlds: string[];
  tickMs: number;
  t3?: Record<string, { status: string; checkedAt: string }>;
  /** ask the main thread for spines.py output (its shared cache) instead of running spines.py here. */
  spinesViaHost?: boolean;
  startedAt?: number;
}

const d = workerData as Data;
const db = new Database(d.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

let t3: Record<string, { status: string; checkedAt: string }> = d.t3 ?? {};
const log = (msg: string) => parentPort?.postMessage({ type: "log", msg });
const homeThread = (assignmentId: string): string | undefined => {
  try {
    return (db.prepare("SELECT thread_id FROM cycle_assignment_link WHERE assignment_id = ?").get(assignmentId) as { thread_id: string | null } | undefined)?.thread_id ?? undefined;
  } catch {
    return undefined;
  }
};

const viaHost = d.spinesViaHost && !d.spinesFixture ? workerSpinesRunner((m) => parentPort?.postMessage(m), d.startedAt ?? Date.now()) : undefined;
const refresher = createRefresher({
  db,
  reposRoot: d.reposRoot,
  spines: d.spinesFixture ? fixtureRunner(d.spinesFixture) : viaHost ? viaHost.run : d.skillDir ? spinesPyRunner(d.skillDir) : undefined,
  ...(d.tenant ? { tenant: d.tenant } : {}),
  ...(d.teamRepo ? { teamRepo: d.teamRepo } : {}),
  worlds: d.worlds,
  homeThread,
  t3State: (runId) => t3[runId],
  rescanGapMs: d.spinesFixture ? 0 : rescanGapMs(), // a changed repo re-read at most every 5 min
  log,
});

let drifting = false;
parentPort?.on("message", (m: { type: string; dir?: string; stale?: boolean; key?: ViewKey; states?: typeof t3; confirmAfterMs?: number }) => {
  if (viaHost?.onReply(m)) return;
  // the hourly drift check, on this thread (its own reads; the main thread only keeps the result).
  if (m.type === "drift") {
    if (drifting) return;
    drifting = true;
    void refresher
      .driftCheck(m.confirmAfterMs !== undefined ? { confirmAfterMs: m.confirmAfterMs } : {})
      .then((result) => parentPort?.postMessage({ type: "drift-result", result }))
      .finally(() => (drifting = false));
    return;
  }
  if (m.type === "dirty") refresher.dirty(m.dir, m.stale ? { stale: true } : undefined);
  else if (m.type === "dirtyAll") refresher.dirtyAll();
  else if (m.type === "register" && m.key) refresher.register(m.key);
  else if (m.type === "t3" && m.states) t3 = m.states;
});

void refresher.tick();
if (d.tickMs > 0) setInterval(() => void refresher.tick(), d.tickMs);
