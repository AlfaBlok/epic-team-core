/// <reference types="vitest" />
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { guardFullSuiteOnVps1 } from "../vitest-host-guard";

// one fork on the main server (the infra repo S9: every agent shares its 1.5-core user slice; run suites on the worker server), 2 elsewhere;
// VITEST_MAX_WORKERS overrides.
// on the main server an unfiltered run (whole suite) is refused unless VPS1_FULL_SUITE=1; name the files instead.
guardFullSuiteOnVps1();

const maxForks = Number(process.env.VITEST_MAX_WORKERS) || (os.hostname() === "vps-a9-1" ? 1 : 2);

/**
 * A brotli copy (best quality) beside each built script and style, <file>.br, made once here on the build host;
 * the console sends it to browsers that take br (server app.ts staticFile), ~16% smaller than gzip, no run-time CPU.
 */
export function brotliCopies(): Plugin {
  let outDir = "dist";
  return {
    name: "console-brotli-copies",
    apply: "build",
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const dir = path.join(outDir, "assets");
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir).filter((x) => /\.(js|css)$/.test(x))) {
        const raw = fs.readFileSync(path.join(dir, f));
        if (raw.length < 1024) continue;
        const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        fs.writeFileSync(path.join(dir, `${f}.br`), br);
      }
    },
  };
}

/**
 * The libraries that change only when we bump them (React, its DOM and scheduler, the router, tailwind-merge) go in
 * their own vendor script: a console release changes only the app's scripts, so a phone that opened the
 * console before keeps the vendor script cached and downloads only what changed. Same total on a first visit.
 */
export const VENDOR = /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]router|tailwind-merge)[\\/]/;
export function vendorChunk(id: string): string | undefined {
  return VENDOR.test(id) ? "vendor" : undefined;
}

/**
 * The screen a first visit opens starts downloading with the app's entry script: a screen that loads on first
 * open (lib/lazyPage.tsx) waited for the 160 KB entry to arrive and run before its own script was even asked for (Chat on
 * Slow 4G: +0.7 s). The built index.html gets one tiny inline script with { address pattern: [its scripts] } that adds a
 * <link rel="modulepreload"> for each script of the address it opens. Patterns are tried in order, the first match wins.
 */
export const ROUTE_PRELOADS: [RegExp, string][] = [
  [/^\/chat\/?$/, "src/pages/Chat.tsx"],
  [/^\/milestones\/[^/]+\/?$/, "src/pages/Milestone.tsx"],
];
type Chunkish = { type: string; fileName: string; isEntry?: boolean; moduleIds?: string[]; modules?: Record<string, unknown>; imports?: string[] };
export function routePreloadMap(bundle: Record<string, Chunkish>, routes: [RegExp, string][] = ROUTE_PRELOADS): [string, string[]][] {
  const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
  const entry = new Set<string>();
  const walk = (file: string, into: Set<string>) => {
    if (into.has(file)) return;
    into.add(file);
    for (const i of bundle[file]?.imports ?? []) walk(i, into);
  };
  for (const c of chunks.filter((x) => x.isEntry)) walk(c.fileName, entry);
  const out: [string, string[]][] = [];
  for (const [re, mod] of routes) {
    const has = (x: Chunkish) => (x.moduleIds ?? Object.keys(x.modules ?? {})).some((id) => id.replace(/\\/g, "/").endsWith(`/${mod}`));
    const c = chunks.find((x) => !x.isEntry && has(x));
    if (!c) continue; // in the entry already, or gone
    const files = new Set<string>();
    walk(c.fileName, files);
    out.push([re.source, [...files].filter((f) => !entry.has(f))]);
  }
  return out;
}
export function routePreloads(): Plugin {
  let base = "/";
  return {
    name: "console-route-preloads",
    apply: "build",
    configResolved(c) {
      base = c.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        const map = routePreloadMap(ctx.bundle as unknown as Record<string, Chunkish>);
        if (!map.length) return html;
        const js = `(function(m,p){for(var i=0;i<m.length;i++)if(new RegExp(m[i][0]).test(p)){for(var j=0;j<m[i][1].length;j++){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.href=${JSON.stringify(base)}+m[i][1][j];document.head.appendChild(l)}break}})(${JSON.stringify(map)},location.pathname)`;
        return html.replace(/(<script type="module"[^>]*src=)/, `<script data-route-preloads>${js}</script>\n    $1`);
      },
    },
  };
}

export default defineConfig({
  root: __dirname, // also when run from the hosted tree (hosted/console/web/vite.config.ts re-exports this)
  // E948-S129: our JSX goes through src/lib/linkjsx (every URL in rendered text is a link), libraries keep React's own
  plugins: [react({ jsxImportSource: "@/lib/linkjsx" }), brotliCopies(), routePreloads()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { output: { manualChunks: vendorChunk } } },
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
