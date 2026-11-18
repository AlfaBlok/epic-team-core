import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bufferedFetch } from "../src/fetchSafe.js";

// Node's bundled undici ends the process (`assert(!this.paused)` in Parser.finish) when a `Connection: close` answer is
// read chunk by chunk with the event loop busy between chunks and the server closes its socket. This test runs that read
// in a child Node, once with the plain fetch (it must crash: the bug is real on this Node) and once through bufferedFetch.
const SRC = pathToFileURL(path.join(__dirname, "../src/fetchSafe.ts")).href;
const script = (fixed: boolean) => `
import http from "node:http";
${fixed ? `import { bufferedFetch } from ${JSON.stringify(SRC)};` : ""}
const f = ${fixed ? "bufferedFetch(globalThis.fetch)" : "globalThis.fetch"};
const big = Buffer.alloc(8 * 1024 * 1024, 120);
const srv = http.createServer((req, res) => { res.writeHead(200, { "content-length": big.length, connection: "close" }); res.end(big); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };
srv.listen(0, async () => {
  const r = await f("http://127.0.0.1:" + srv.address().port + "/");
  const rd = r.body.getReader(); let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; block(50); await sleep(20); }
  console.log("READ " + n); srv.close(); process.exit(0);
});`;

function run(fixed: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetchsafe-"));
  const file = path.join(dir, "t.mjs");
  fs.writeFileSync(file, script(fixed));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", file], { encoding: "utf8", timeout: 60_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("every outgoing answer is read in full (the undici paused-parser crash)", () => {
  it("the plain fetch crashes on a slow chunked read of a Connection: close answer; the buffered fetch reads it all", () => {
    const plain = run(false);
    expect(plain.code, plain.out.slice(0, 400)).not.toBe(0);
    expect(plain.out).toContain("assert(!this.paused)");
    const fixed = run(true);
    expect(fixed.code, fixed.out.slice(0, 600)).toBe(0);
    expect(fixed.out).toContain(`READ ${8 * 1024 * 1024}`);
  }, 120_000);

  it("keeps status, headers, url and an empty body as they were", async () => {
    const inner = (async () => {
      const r = new Response('{"a":1}', { status: 201, statusText: "Created", headers: { "x-k": "v", "content-type": "application/json" } });
      Object.defineProperty(r, "url", { value: "https://example.com/final" });
      return r;
    }) as typeof fetch;
    const r = await bufferedFetch(inner)("https://example.com/");
    expect([r.status, r.statusText, r.headers.get("x-k"), r.url]).toEqual([201, "Created", "v", "https://example.com/final"]);
    expect(await r.clone().json()).toEqual({ a: 1 });
    expect(await r.text()).toBe('{"a":1}');
    const empty = await bufferedFetch((async () => new Response(null, { status: 204 })) as typeof fetch)("https://example.com/");
    expect(empty.status).toBe(204);
  });
});
