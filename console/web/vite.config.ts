/// <reference types="vitest" />
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { guardFullSuiteOnVps1 } from "../vitest-host-guard";

// one fork on the main server (the infra repo S9: every agent shares its 1.5-core user slice; run suites on the worker server), 2 elsewhere;
// VITEST_MAX_WORKERS overrides.
// on the main server an unfiltered run (whole suite) is refused unless VPS1_FULL_SUITE=1; name the files instead.
guardFullSuiteOnVps1();

const maxForks = Number(process.env.VITEST_MAX_WORKERS) || (os.hostname() === "vps-a9-1" ? 1 : 2);

export default defineConfig({
  root: __dirname, // also when run from the hosted tree (hosted/console/web/vite.config.ts re-exports this)
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // the hosted tree sits beside core/ (../../../hosted): its pages and tests load from there
    fs: { allow: [path.resolve(__dirname, "../../..")] },
    // In real mode during dev, forward /api to the console server.
    proxy: { "/api": process.env.CONSOLE_API_URL ?? "http://127.0.0.1:8750" },
  },
  test: {
    environment: "node",
    // the hosted tree's tests too, when it is there
    include: ["src/**/*.test.{ts,tsx}", "../../../hosted/console/web/src/**/*.test.{ts,tsx}"],
    // the page the hosted console serves carries our identity; the suite reads the same (src/hostedIdentity.test.setup.ts)
    setupFiles: ["src/hostedIdentity.test.setup.ts"],
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks } },
    testTimeout: 60000,
  },
});
