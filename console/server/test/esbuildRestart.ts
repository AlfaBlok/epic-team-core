// vite turns every test file into JS through one long-lived esbuild child process. If that process ends
// mid-run (seen 3 times on a loaded the worker server; a SIGKILL reproduces it exactly), each file not yet transformed fails with
// "The service is no longer running" and its tests never run. esbuild only starts a new service after stop, so this
// wraps vite's esbuild transform: on that error it stops the dead service, says so on stderr, and transforms once
// more with a fresh one. Any other error passes through unchanged.
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const GONE = /The service (is no longer running|was stopped)/;

// vite's own copy of esbuild (vite imports it as CJS, so this is the same module instance and the same service).
const fromVite = createRequire(createRequire(import.meta.url).resolve("vite/package.json"));
const viteEsbuild = fromVite("esbuild") as { stop: () => Promise<void> };

export function esbuildRestart(): Plugin {
  return {
    name: "e44s9:esbuild-restart",
    configResolved(config) {
      const esb = config.plugins.find((p) => p.name === "vite:esbuild");
      const hook = esb?.transform;
      if (!esb || typeof hook !== "function") return;
      (esb as any).transform = async function (this: unknown, code: string, id: string, opts: unknown) {
        try {
          return await hook.call(this as never, code, id, opts as never);
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (!GONE.test(msg)) throw e;
          console.error(`vite's esbuild service had stopped (${msg.split("\n")[0]}) at ${id}; started a new one.`);
          await viteEsbuild.stop();
          return await hook.call(this as never, code, id, opts as never);
        }
      };
    },
  };
}
