import "./fetchSafeInstall.js"; // first: every outgoing answer is read in full (fetchSafe.ts)
import { timerPhasesOn } from "./timerPhase.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { defaultDbPath, openDb } from "./db.js";
import { resolveRepo } from "./adapters/repos.js";
import { prewarmSpines } from "./adapters/spines.js";
import type { IndexerHandle } from "./indexer/launch.js";
import { watchLoopLag } from "./loopLag.js";
import { milestoneRanks } from "./inbox/priority.js";
import { readConfigFromEnv } from "./routes/read.js";
import { createStore } from "./store.js";
import { McpT3Client } from "./t3/client.js";
import { gitRunner } from "./cycle/repoPull.js";
import { envDispatcher } from "./t3/dispatcher.js";
import { hostDispatchersFromEnv, sshMeminfo } from "./t3/hostDispatcher.js";
import { createWorkerRoom, memAvailableMb, roomyMaxFromEnv } from "./cycle/workerRoom.js";
import { hostGit } from "./cycle/preWake.js";
import { realScanner } from "./usage/collector.js";
import { pricesFromEnv } from "./usage/prices.js";
import { maxWorkersFromEnv } from "./wakePrompt.js";
import type { PressWorker } from "./press/mount.js";
import { createGateway, gatewayConfigFromEnv } from "./gateway/gateway.js";
import { cliRunner } from "./gateway/dispatcherFace.js";
import { realRepoScan, REFRESH_MS } from "./desk/repoIndex.js";
import { DRAIN_MS, type AnswerJobs } from "./inbox/answerJobs.js";
import { defaultHostTokenFile, ensureHostToken, setHostToken } from "./auth/owner.js";
import { createPreflight } from "./auth/preflight.js";
import { authModeFromEnv } from "./auth/identity.js";
import { hooks } from "./plug/hooks.js";
import { createStartGate, SESSION_START_GAP_MS } from "./cycle/startGate.js";
import { loadHosted } from "./plug/hosted.js";
import { stateDir } from "./identity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// the hosted layer (our plugs and hooks) when its folder is here and CONSOLE_ONE_TEAM is not 1; the core runs without it.
const hostedLoaded = await loadHosted(here);
// dev copy, staging, box: their switches are forced before any env is read below (hooks.host; hosted/host.ts).
const { devCopy, staging } = hooks.host.applyEnv(process.env);
const dbPath = defaultDbPath();
// log a blocked event loop, naming the timer that blocked it (CONSOLE_LOOP_LAG=0 = off).
if (process.env.CONSOLE_LOOP_LAG !== "0") watchLoopLag({ thresholdMs: Number(process.env.CONSOLE_LOOP_LAG_MS) || 1_000 });
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8750);
const staticDir = process.env.CONSOLE_STATIC_DIR || path.resolve(here, "../../web/dist");

// the host owner token. Owner powers (agent tokens, secret writes, service changes, world make/remove,
// settings) need an owner login or this token; legacy trust alone no longer has them. Staging keeps its own file.
setHostToken(ensureHostToken(defaultHostTokenFile())); // CONSOLE_HOST_TOKEN_FILE; staging's is under its root (staging.ts)

const db = openDb(dbPath);
hooks.host.afterDb(db); // a box makes its one team
// cycle: off unless CONSOLE_CYCLE_ENABLED is exactly "true" (kill switch; unknown values mean off).
const cycleEnabled = process.env.CONSOLE_CYCLE_ENABLED === "true";
const publicUrl = process.env.CONSOLE_PUBLIC_URL || `http://${host}:${port}`;
const worker = cycleEnabled && (process.env.CONSOLE_VPS3_SSH || process.env.CONSOLE_VPS3_MCP_URL) ? hooks.host.secondHost() : undefined;
const read = readConfigFromEnv();
// tokens per wake: read-only transcript scan on this host, and on the worker server over the console's ssh access (when set).
const vps3Ssh = hooks.host.secondHostSsh(); // the second host's ssh access (hosted: the hosted second-host module)
const centralDispatcher = envDispatcher();
// the worker ceiling follows the room: up to CONSOLE_MAX_WORKERS_WITH_ROOM (14) while the broker has free seats and the
// worker server's memory is over its floor plus the extra workers' share; the flat ceiling otherwise. CONSOLE_WORKER_ROOM=0 = flat.
const workerRoom =
  process.env.CONSOLE_WORKER_ROOM === "0" || !centralDispatcher?.status
    ? undefined
    : (() => {
        const meminfo = vps3Ssh ? sshMeminfo(vps3Ssh) : undefined;
        return createWorkerRoom({
          base: maxWorkersFromEnv(),
          roomy: roomyMaxFromEnv(undefined, maxWorkersFromEnv()),
          seatsFree: async () => (await centralDispatcher.status!()).available,
          memMb: meminfo ? async () => memAvailableMb(await meminfo()) : undefined,
        });
      })();
const usage =
  process.env.CONSOLE_USAGE === "0"
    ? undefined
    : {
        scanner: realScanner({
          script: path.resolve(here, "../scripts/run_usage.py"),
          // unset = every ~/.claude and ~/.claude_seat* dir on each host (discovered there); set = exactly these.
          dirs: (process.env.CONSOLE_USAGE_DIRS || "").split(",").map((d) => d.trim()).filter(Boolean),
          worker: vps3Ssh,
        }),
        prices: pricesFromEnv(),
        sweepMs: 5 * 60_000,
        liveMs: Number(process.env.CONSOLE_USAGE_LIVE_MS || 2 * 60_000),
      };
// the answer jobs (spine write, push, wake after the click was answered), drained on SIGTERM.
let answerJobs: AnswerJobs | undefined;
// CONSOLE_INDEXER=unit runs spines.py, the read model's refresher and the Epic Book's build in a
// separate niced, CPU-capped systemd user unit (indexer/launch.ts), `child` in a niced child process; unset/off = in process.
const indexerMode = process.env.CONSOLE_INDEXER === "unit" || process.env.CONSOLE_INDEXER === "child" ? process.env.CONSOLE_INDEXER : undefined;
let indexerHandle: IndexerHandle | undefined;
const revision = (() => {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), "../REVISION"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
})();
let pressWorker: PressWorker | undefined;
// shared staging (the hosted layer) sets CONSOLE_PASSIVE=1: this console reads a database another console owns.
const passive = process.env.CONSOLE_PASSIVE === "1";
const app = createApp(db, {
  passive,
  answers: { ack: process.env.CONSOLE_ANSWER_ACK === "done" ? "done" : "saved", onJobs: (j) => (answerJobs = j) },
  // one answer closes many, with the model check (CONSOLE_SETTLE=0 turns it off).
  settle: process.env.CONSOLE_SETTLE !== "0",
  // asks past their person's time limit go up every 10 min (CONSOLE_PEOPLE_TICK_MS, 0 = only on the owner's request).
  people: { tickMs: Number(process.env.CONSOLE_PEOPLE_TICK_MS ?? 600_000) },
  // a voice note filed on one item hands the rest of what he said to the Team desk (CONSOLE_VOICE_SPILL=0 turns it off).
  voiceSpill: process.env.CONSOLE_VOICE_SPILL !== "0",
  // the memory service helper's answer is worded by the small model (the hosted module's model setting, default gpt-4o-mini); 0 = the plain answer.
  memoryAsk: { worder: process.env.CONSOLE_MEMORY_ASK_WORDS === "0" ? undefined : true },
  // the desk pair (CONSOLE_DESK_PAIRS, default the home world:a social world repo) and the Team desk's relay (POST /api/desk/pass).
  // the automatic router that judged each of his messages is OFF; only CONSOLE_DESK_CROSS=1 (the owner's word)
  // turns it back on. CONSOLE_DESK_CROSS=0 turns the relay off too.
  deskCross: process.env.CONSOLE_DESK_CROSS === "0" ? false : { auto: process.env.CONSOLE_DESK_CROSS === "1" },
  // a long note marks the inbox cards it touches stale or updated and wakes their owners (CONSOLE_NOTE_TOUCH=0 turns it off).
  noteTouch: process.env.CONSOLE_NOTE_TOUCH !== "0",
  // presses not landed yet are retried every 5 s when due (CONSOLE_PRESS_TICK_MS, 0 = no retries).
  // a review button answers once its press is saved and the worker writes it (CONSOLE_PRESS_ANSWER_FIRST=0: in the request, as before).
  presses: { tickMs: Number(process.env.CONSOLE_PRESS_TICK_MS ?? 5_000), onWorker: (w) => (pressWorker = w), answerFirst: process.env.CONSOLE_PRESS_ANSWER_FIRST !== "0" },
  // press writes answer at the local commit, push in the background, skip the hooks after a secret check (0 = off)
  backgroundPush: process.env.CONSOLE_PUSH_BACKGROUND !== "0",
  // spine writes from the console's own clones (<db dir>/write/<repo>-<hash>, or
  // CONSOLE_WRITE_CLONES_DIR); CONSOLE_WRITE_CLONE=off writes in the shared checkouts as before. Never on a dev copy.
  ...(devCopy || process.env.CONSOLE_WRITE_CLONE === "off" ? {} : { writeClones: { root: process.env.CONSOLE_WRITE_CLONES_DIR || path.join(path.dirname(dbPath), "write") } }),
  // waiting-on-you lists and statuses from console.db, refreshed by a worker thread; CONSOLE_READ_MODEL=off computes
  // them per request as before, =in-process refreshes on this thread.
  ...(indexerMode && process.env.CONSOLE_READ_MODEL !== "off"
    ? { indexer: { mode: indexerMode, port, ...(revision ? { revision } : {}), onLaunched: (h: IndexerHandle) => (indexerHandle = h) } }
    : {}),
  readModel: {
    mode: process.env.CONSOLE_READ_MODEL === "off" ? "none" : process.env.CONSOLE_READ_MODEL === "in-process" ? "in-process" : "worker",
    dbPath,
    // every hour the cache is rebuilt off to the side from the repo and compared (first 10 min after start);
    // drift is logged, shown in /api/health and sent to the owner on WhatsApp (not from staging or a dev copy, or with
    // CONSOLE_WA_NOTIFY=0). CONSOLE_DRIFT_CHECK_MS sets the period, 0 turns it off.
    drift: {
      everyMs: Number(process.env.CONSOLE_DRIFT_CHECK_MS ?? 3600_000),
      firstAfterMs: Number(process.env.CONSOLE_DRIFT_FIRST_MS ?? 10 * 60_000),
      alert: !staging && !devCopy && process.env.CONSOLE_WA_NOTIFY !== "0",
    },
  },
  // build the Epic Book once in the background, after the spines.py prewarm has had its turn.
  ...(process.env.CONSOLE_BOOK_PREWARM === "0" ? {} : { book: { prewarmAfterMs: 20_000, tickMs: 2 * 60_000 } }),
  // right after the start, read the milestone trees (focus milestones first) so the first open is warm.
  ...(process.env.CONSOLE_TREE_WARM === "0" ? {} : { warmTrees: { afterMs: 0 } }),
  // the Epic Books' daily refresh (05:00Z, and at start when today's has not run): pull, capability probe, rebuild.
  // Never on staging or a dev copy (no push, and the probe would call production's Team Browser); CONSOLE_BOOK_REFRESH=0 turns it off.
  linkCheck: { tickMs: staging || devCopy || process.env.CONSOLE_LINK_CHECK === "0" ? 0 : 30 * 60_000 },
  bookRefresh: { tickMs: staging || devCopy || process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_BOOK_REFRESH === "0" ? 0 : 10 * 60_000 },
  // the daily press test of the owner's buttons on TEST rows (04:00Z, and at start when today's has not run; production only).
  pressTest: { tickMs: staging || devCopy || process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_PRESS_TEST === "0" ? 0 : 10 * 60_000 },
  deckNotify: { tickMs: staging || devCopy || process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_DECK_NOTIFY === "0" ? 0 : 10 * 60_000 },
  staticDir,
  read,
  usage,
  cycle: {
    enabled: cycleEnabled,
    publicUrl,
    // one new the main server agent session per 90 s (wakes, workers, desk updates); 0 = off.
    startGate: createStartGate({
      gapMs: Number(process.env.CONSOLE_SESSION_START_GAP_MS ?? SESSION_START_GAP_MS),
      file: path.join(path.dirname(dbPath), ".last-session-start.json"),
    }),
    t3: cycleEnabled ? new McpT3Client() : undefined,
    dispatcher: centralDispatcher,
    // the worker server-hosted persona picks through the worker server's own client (the worker server memory, floor 3000; reservation still central).
    // no agent worker launches on the main server; CONSOLE_CAP_FALLBACK=1 is the incident override (the
    // the worker server-cap -> the main server wake fallback and the console worker route), never a standing setting.
    capFallback: process.env.CONSOLE_CAP_FALLBACK === "1",
    hostDispatchers: hostDispatchersFromEnv(vps3Ssh),
    // the worker server target, only when configured (a ssh destination for the tunnel, or a direct MCP URL).
    worker,
    cadenceTickMs: process.env.CONSOLE_SCHEDULER === "0" ? 0 : 60_000, // cadence wakes, every host
    bootstrapModel: process.env.CONSOLE_BOOTSTRAP_MODEL,
    maxWorkersPerMilestone: maxWorkersFromEnv(), // CONSOLE_MAX_WORKERS_PER_MILESTONE, default 10
    workerRoom, // up to 14 while seats and memory have room
    rearmEveryMs: 15 * 60_000, // auto-park re-arm check
    retryTickMs: process.env.CONSOLE_SCHEDULER === "0" ? 0 : 30_000, // timed wakes (run retryAt)
    reconcileEveryMs: Number(process.env.CONSOLE_RECONCILE_MS ?? 60_000), // run recording from T3
    idleStopEveryMs: Number(process.env.CONSOLE_IDLE_STOP_MS ?? 60_000), // stop idle provider sessions (0 = off)
    git: process.env.CONSOLE_RUN_END_PULL === "0" ? undefined : gitRunner(), // run-end pull (root L-7)
    // pre-wake pull + tool fingerprint of the persona's checkout on its host (the worker server over the console's ssh access).
    hostGit:
      process.env.CONSOLE_PREWAKE_PULL === "0"
        ? undefined
        : hostGit({ worker: vps3Ssh }),
  },
  // team skills; a persona's declared skill missing from the library or its host fails the wake check.
  teamSkills: {
    wakeCheck: process.env.CONSOLE_SKILL_CHECK !== "0",
    worker: vps3Ssh,
    // Never sync from staging or a dev copy (they do not push either); CONSOLE_TEAM_SKILLS_SYNC=0 for a local test console.
    ...(staging || devCopy || process.env.CONSOLE_TEAM_SKILLS_SYNC === "0" ? { syncHosts: [] } : {}),
  },
  // every 5 min, a claim whose lease ran out (no commit naming the row) gives its row back to ready (spine writer).
  leases: { everyMs: process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_LEASES === "0" ? 0 : 5 * 60_000 },
  // every minute, every tracked checkout vs origin/main; out of sync over 5 min alerts.
  checkoutSync: { everyMs: process.env.CONSOLE_CHECKOUT_SYNC === "0" ? 0 : 60_000 },
  // every 5 min, the worker server's home volume over the worker server ssh; under 15% free alerts. CONSOLE_HOST_DISK=0 turns it off.
  hostDisk: {
    everyMs: staging || devCopy || process.env.CONSOLE_HOST_DISK === "0" ? 0 : 5 * 60_000,
    probe: vps3Ssh ? hooks.host.diskProbe(vps3Ssh) : undefined,
  },
  // every hour, the T3 MCP tokens' expiry (warn 5 days before); a 401 from T3 alerts at once. CONSOLE_T3_TOKEN_WATCH=0 turns it off.
  t3Tokens: { everyMs: staging || devCopy || process.env.CONSOLE_T3_TOKEN_WATCH === "0" ? 0 : 3600_000 },
  // every minute, the job servers' alerts from box/provision.py (the main server's the console dir); CONSOLE_JOB_SERVERS=0 turns it off.
  jobServers: {
    everyMs: devCopy || process.env.CONSOLE_JOB_SERVERS === "0" ? 0 : 60_000,
    dir: process.env.CONSOLE_JOB_STATE_DIR || stateDir(),
  },
  // the review gate sweep, every 10 min (each new item wakes its Delivery manager once)
  reviewGate: { everyMs: process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_REVIEW_GATE === "0" ? 0 : 10 * 60_000 },
  // pull on open (> 5 min; was 60 s), ls-remote poll, Refresh; CONSOLE_FRESHNESS=0 turns the pulls off. The poll runs
  // every 5 min (was 20 s; CONSOLE_FRESHNESS_POLL_MS overrides) so a push from anywhere shows within ~5 min.
  freshness: { enabled: process.env.CONSOLE_FRESHNESS !== "0", ...(process.env.CONSOLE_FRESHNESS_POLL_MS ? { pollMs: Number(process.env.CONSOLE_FRESHNESS_POLL_MS) } : {}) },
  // a new ask wakes the Unblocker (2 min debounce); HEAD watch every 60 s catches the background sync's pulls. CONSOLE_NEW_ASK_WAKE=0 turns it off.
  newAskWake: { enabled: process.env.CONSOLE_NEW_ASK_WAKE !== "0", headWatchMs: process.env.CONSOLE_SCHEDULER === "0" ? 0 : 60_000 },
  // desk: endpoint-list update to the live thread (once per seed version) and delivered notes; CONSOLE_SCHEDULER=0 pauses.
  deskTickMs: process.env.CONSOLE_SCHEDULER === "0" ? 0 : 60_000,
  // the Company view's uptime checks every 5 minutes, read-only GETs, so staging runs them too though it forces
  // CONSOLE_SCHEDULER=0 (its numbers are checked there before the promote); CONSOLE_UPTIME_PROBE=0 turns it off.
  uptimeProbe: { everyMs: devCopy || process.env.CONSOLE_UPTIME_PROBE === "0" || (!staging && process.env.CONSOLE_SCHEDULER === "0") ? 0 : 5 * 60_000 },
  // the social product KPI snapshot (followers + ledger totals into each social repo's data/kpi-daily.md), checked hourly; CONSOLE_KPI_RECORD=0 turns it off.
  kpiRecord: { everyMs: staging || devCopy || process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_KPI_RECORD === "0" ? 0 : 60 * 60_000 },
  // the launch board (scripts/launch_board.py from the code repo checkout) every 30 min, inside the console; CONSOLE_LAUNCH_BOARD=0 stops the timer.
  launchBoard: {
    everyMs: staging || devCopy || process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_LAUNCH_BOARD === "0" ? 0 : 30 * 60_000,
    cacheFile: path.join(path.dirname(dbPath), "launch-board.json"),
  },
  // GitHub's daily views of the public code page for the Performance page (gh api, hourly at most); staging and dev copies leave it off.
  siteCodeViews: staging || devCopy ? null : hooks.host.codeViews,
  siteReferrers: staging || devCopy ? null : hooks.host.referrers,
  // the owner's team state repo (~/github/team): big roots file → milestones, desk placements and chat copied there every 2 min.
  teamState: { repo: process.env.CONSOLE_TEAM_REPO || undefined, everyMs: process.env.CONSOLE_SCHEDULER === "0" ? 0 : 120_000 },
  // the desk's repo index: scripts/repo_index.py on the main server and over ssh on the worker server, every 6 h in the background (never on a request).
  repoIndex: {
    scan: realRepoScan({
      script: path.resolve(here, "../scripts/repo_index.py"),
      worker: vps3Ssh,
    }),
    everyMs: process.env.CONSOLE_SCHEDULER === "0" || process.env.CONSOLE_REPO_INDEX === "0" ? 0 : REFRESH_MS,
  },
  // stall watch: real Run nows only with CONSOLE_STALL_WATCH=on (default off); GET /api/stall-watch is the dry list.
  // WhatsApp alerts to the owner (new asks/reviews batched + a daily summary) via the memory service's relay; CONSOLE_WA_NOTIFY=0 turns it off.
  whatsapp: { tickMs: process.env.CONSOLE_WA_NOTIFY === "0" || process.env.CONSOLE_SCHEDULER === "0" ? 0 : 2 * 60_000 },
  // phone notifications (Web Push) when the Team desk answers; new items ride the WhatsApp pass. CONSOLE_PUSH_NOTIFY=0 turns it off.
  webPush: { deskTickMs: process.env.CONSOLE_PUSH_NOTIFY === "0" || process.env.CONSOLE_SCHEDULER === "0" ? 0 : 60_000 },
  // the owner's WhatsApp voice notes in the memory service reach the Team desk, polled every minute; never on staging or a dev copy
  // (no posting there); CONSOLE_VOICE_NOTES=0 turns it off.
  voiceNotes: { tickMs: staging || devCopy || process.env.CONSOLE_VOICE_NOTES === "0" || process.env.CONSOLE_SCHEDULER === "0" ? 0 : 60_000 },
  // Chat voice notes go on to the owner's the memory service (ingest_voice_note), from an outbox retried every minute; never on staging
  // or a dev copy (they must not file into his the memory service); CONSOLE_MEMORY_FORWARD=0 turns it off.
  memoryForward: { enabled: !staging && !devCopy && process.env.CONSOLE_MEMORY_FORWARD !== "0", tickMs: 60_000 },
  // the team mailbox (the owner's mail to owner+desk@our domain reaches the Team desk), polled every minute; never on
  // staging (no posting there); CONSOLE_TEAM_MAIL=0 turns it off.
  mcp: { mailTickMs: staging || process.env.CONSOLE_TEAM_MAIL === "0" || process.env.CONSOLE_SCHEDULER === "0" ? 0 : 60_000 },
  timerPhases: timerPhasesOn(), // each 5/10-minute job at its own second (CONSOLE_TIMER_PHASES=0 = all at once)
  stallWatch: { enabled: process.env.CONSOLE_STALL_WATCH === "on" && process.env.CONSOLE_SCHEDULER !== "0", everyMs: Number(process.env.CONSOLE_STALL_WATCH_MS || 10 * 60_000) },
});

// rework: staging answers GET /api/staging and POST /api/staging/refresh and refuses what would act for real; a dev
// copy refuses writes (hooks.host.wrapFetch; hosted/host.ts).
// old route names a host still answers are rewritten first, so staging, the dev copy guard and auth read the core's names.
const baseFetch = hooks.host.aliasRoutes(hooks.host.wrapFetch(app.fetch, {
  db,
  mode: { devCopy, staging },
  preflight: staging ? createPreflight(db, authModeFromEnv(), hooks.worldWakeGate()) : () => undefined, // name owner_only / world_needs_box first (staging)
}));
// requests in flight, so a stop lets them finish (drain) instead of cutting them ("Failed to fetch" on an answer).
let inFlight = 0;
const appFetch: typeof baseFetch = async (...a) => {
  inFlight++;
  try {
    return await baseFetch(...a);
  } finally {
    inFlight--;
  }
};
const server = serve({ fetch: appFetch, hostname: host, port }, (info) => {
  console.log(
    `console server on http://${host}:${info.port} (db ${dbPath}, static ${staticDir}, cycle ${cycleEnabled ? "ON" : "off"}, public ${publicUrl}${hooks.host.modeNote({ devCopy, staging })})`,
  );
});

// the agent gateway (token only, D4), a second listener on loopback/tailnet; off unless CONSOLE_GATEWAY_PORT is set.
const gw = gatewayConfigFromEnv();
const gateway = gw
  ? serve({ fetch: hooks.host.aliasRoutes(createGateway({ db, fetch: appFetch, dispatcher: gw.dispatcherCmd ? cliRunner(gw.dispatcherCmd) : undefined })), hostname: gw.host, port: gw.port }, (info) =>
      console.log(`agent gateway on http://${gw.host}:${info.port} (bearer tokens only${gw.dispatcherCmd ? ", dispatcher face on" : ""})`),
    )
  : undefined;

// fill the spines.py cache once per milestone repo, sequentially, so the first load has Goal/Serves/Pages.
// with the indexer running it fills and keeps the cache; the console reads it and never scans here.
if (read.spines && process.env.CONSOLE_SPINES_PREWARM !== "0" && !indexerHandle) {
  // in milestone priority (focus milestones' repos first), the order the trees are warmed in.
  const all = createStore(db).listMilestones({ includeSettled: true });
  const ranks = milestoneRanks(all);
  const dirs = all
    .filter((m) => !m.settledAt)
    .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
    .flatMap((m) => resolveRepo(read.reposRoot, m.repo)?.path ?? []);
  void prewarmSpines(read.spines, dirs).then(() => console.log(`spines.py prewarm done (${new Set(dirs).size} repos)`));
}

/**
 * graceful stop (a deploy's restart): stop accepting connections, let the requests in flight answer and the answer
 * jobs' running steps (a commit + push, a wake) finish, up to DRAIN_MS (systemd waits 90 s), then exit. What is still
 * pending is in console.db and resumes at the next start; the web retries a refused request with the same key.
 */
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    server.close();
    pressWorker?.stop(); // a press not landed stays in the outbox; the next start retries it
    gateway?.close();
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    const requests = (async () => {
      while (inFlight > 0 && Date.now() - t0 < DRAIN_MS) await new Promise((r) => setTimeout(r, 50));
    })();
    // a press being written finishes its commit and push before the exit (else the next start writes it again)
    void Promise.all([requests, answerJobs?.drain(DRAIN_MS), indexerHandle?.stop(), pressWorker?.drain(DRAIN_MS)]).then(([, jobsDone, , pressesDone]) => {
      console.log(`stop (${sig}): drained in ${Date.now() - t0} ms (requests left ${inFlight}, answer jobs ${jobsDone === false ? "still running: resumed at start" : "done"}, presses ${pressesDone === false ? "still writing: resumed at start" : "done"})`);
      worker?.close(); // do not leave the ssh tunnel (and its remote -R port) behind
      db.close();
      process.exit(0);
    });
  });
