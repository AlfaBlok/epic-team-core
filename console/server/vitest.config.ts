import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { esbuildRestart } from "./test/esbuildRestart";
import { guardFullSuiteOnVps1 } from "../vitest-host-guard";

// the units run Node 22 (~/.local/node-22); the worker server's /usr/bin/node is 18, which has no global `crypto` (the MCP SDK
// calls crypto.randomUUID: every tools/list answered 400) and another better-sqlite3 ABI. Stop with the fix, not red tests.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) throw new Error(`Node ${process.versions.node}: run the suite with Node 22, e.g. PATH=$HOME/.local/node-22/bin:$PATH npx vitest run (and npm ci with that Node)`);

// one fork on the main server (the infra repo S9: every agent shares its 1.5-core user slice; run suites on the worker server), 2 elsewhere;
// VITEST_MAX_WORKERS overrides.
// on the main server an unfiltered run (whole suite) is refused unless VPS1_FULL_SUITE=1; name the files instead.
guardFullSuiteOnVps1();

const maxForks = Number(process.env.VITEST_MAX_WORKERS) || (os.hostname() === "vps-a9-1" ? 1 : 2);

// cap workers at 2 (default cpus-1 forks of 1.3-2.3 GiB each thrashed the worker server).
export default defineConfig({
  root: __dirname, // also when run from the hosted tree (hosted/console/server/vitest.config.ts re-exports this)
  // a mid-run esbuild exit restarts the service instead of losing every file not yet loaded.
  plugins: [esbuildRestart()],
  // the hosted tree sits beside core/ (../../../hosted): its tests and the hosted layer load from there
  server: { fs: { allow: [path.resolve(__dirname, "../../..")] } },
  test: {
    // the hosted tree's tests too, when it is there (the hosted layer loads in test/hostedSetup.ts)
    include: ["test/**/*.test.ts", "../../../hosted/console/server/test/**/*.test.ts"],
    // no test writes or pushes a real checkout or its origin (a run pushed fixture ask, 674d6aeb).
    // a fork whose vitest parent died (a command timeout) is killed instead of spinning on alone (orphan guard).
    setupFiles: ["../vitest-orphan-guard.ts", "./test/realCheckoutGuard.ts", "./test/hostedSetup.ts", "./test/ticketIndexSetup.ts"], // the hosted layer, as the server entry loads it
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks } },
    testTimeout: 60000,
    // name test files that never loaded (e.g. vite's esbuild service stopped mid-run) and say why.
    reporters: ["default", "./test/unloadedGuard.ts"],
    // tests edit spines on disk and read them back at once; the tree memo (3 s) is off here, its own tests turn it on.
    env: { CONSOLE_TREE_TTL_MS: "0", CONSOLE_MILESTONE_LIST_MS: "0" },
  },
});
