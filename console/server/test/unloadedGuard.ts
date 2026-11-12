// a full run must never pass over test files that did not load. Vitest lists each one as a red file with a
// collect error and its tests simply do not run, so "1050 passed" reads like a clean run. This reporter names them,
// says why, and keeps the run red.
import type { Reporter, TestModule } from "vitest/node";

const ESBUILD_GONE = /The service (is no longer running|was stopped)/;

export default class UnloadedGuard implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const unloaded = modules.filter((m) => m.errors().length > 0 && m.children.size === 0);
    if (unloaded.length === 0) return;
    const esbuild = unloaded.filter((m) => m.errors().some((e) => ESBUILD_GONE.test(e.message ?? "")));
    const lines = [
      "",
      `UNLOADED TEST FILES: ${unloaded.length} of ${modules.length} files never loaded, so their tests did not run.`,
    ];
    if (esbuild.length > 0) {
      lines.push(
        `  ${esbuild.length} of them because vite's esbuild service stopped mid-run (docs/status/e44-s9-esbuild.md).`,
        "  This is not a test failure: rerun the suite. To catch how esbuild ended, run it with",
        "  ESBUILD_BINARY_PATH=<exit-logging wrapper> (see the status page) and keep the wrapper's log.",
      );
    }
    for (const m of unloaded.slice(0, 5)) lines.push(`  ${m.moduleId}: ${m.errors()[0]?.message ?? "?"}`);
    if (unloaded.length > 5) lines.push(`  … and ${unloaded.length - 5} more`);
    console.error(lines.join("\n"));
    process.exitCode = 1;
  }
}
