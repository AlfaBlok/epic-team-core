// No full test suites on the main server: every agent shares its small user slice, and one session running the whole
// console server suite there kept the load high for an hour. On the main host a vitest run with no file or name filter
// is refused unless VPS1_FULL_SUITE=1; a single-file or filtered run (`npx vitest run test/foo.test.ts`, `-t name`,
// `related`, `--changed`) stays allowed. Run full suites on the worker server.
// Imported by the console server, web and browser vitest configs; lives beside them so a release build finds it.
import os from "node:os";
import path from "node:path";

const MAIN_HOST = "vps-a9-1";

// vitest flags that take a separate value (`--reporter dot`), so the value is not read as a file filter.
const VALUE_FLAGS = new Set([
  "-c", "--config", "-r", "--root", "--dir", "--reporter", "--outputFile", "--project", "--pool", "--environment",
  "--maxWorkers", "--minWorkers", "--testTimeout", "--hookTimeout", "--teardownTimeout", "--retry", "--bail", "--mode",
  "--shard", "--exclude", "--include", "--workspace", "--maxConcurrency", "--sequence.seed", "--api.port", "--api.host",
  "--coverage.provider", "--coverage.reporter",
]);
const SUBCOMMANDS = new Set(["run", "watch", "dev", "bench", "typecheck"]);

/** True when the vitest CLI args narrow the run to some files or tests (a filter), false for a full-suite run. */
export function hasTestFilter(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "related" || a === "list") return true; // related <files> / list (runs nothing)
    if (a === "-t" || a === "--testNamePattern" || a.startsWith("--testNamePattern=") || a.startsWith("-t=")) return true;
    if (a === "--changed" || a.startsWith("--changed=")) return true;
    if (a === "--") continue;
    if (a.startsWith("-")) {
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (i === 0 && SUBCOMMANDS.has(a)) continue;
    return true; // a positional file filter
  }
  return false;
}

/** The refusal message for this run, or null when it may go ahead. */
export function fullSuiteRefusal(argv: string[], host: string, env: NodeJS.ProcessEnv): string | null {
  if (host !== MAIN_HOST || env.VPS1_FULL_SUITE === "1") return null;
  // Only the vitest CLI itself (fork workers and `vite build` load configs too, with other argv).
  const bin = path.basename(argv[1] ?? "");
  if (bin !== "vitest" && bin !== "vitest.mjs") return null;
  if (hasTestFilter(argv.slice(2))) return null;
  return (
    `vitest: full suite refused on ${MAIN_HOST}: run the whole suite on the worker server, ` +
    "or name the files here (e.g. `npx vitest run test/foo.test.ts`, or `-t <name>`). " +
    "VPS1_FULL_SUITE=1 overrides when a full run on the main server is truly needed."
  );
}

/** Throws (vitest exits non-zero before starting any worker) when this is an unfiltered run on the main server. */
export function guardFullSuiteOnVps1(): void {
  const msg = fullSuiteRefusal(process.argv, process.env.VITEST_GUARD_HOSTNAME || os.hostname(), process.env);
  if (msg) throw new Error(msg);
}
