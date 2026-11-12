// browser auth moved to the Team Browser service; the console only forwards to it.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempApp } from "./helpers.js";

const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    if (req.url?.startsWith("/auth-sync/")) {
      res.writeHead(410, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store", "x-secret": "leak" });
      return res.end("#!/bin/sh\necho used >&2\nexit 1\n");
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
    // a start mints a real-shaped token (the console records it; only recorded tokens are forwarded)
    res.end(JSON.stringify({ echo: req.url, ...(req.url === "/api/auth-sync" ? { token: "as" + "0".repeat(32) } : {}) }));
  });
});
let browserUrl: string;
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  browserUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => fake.close());

describe("browser auth proxy", () => {
  it("forwards the page's routes, query and body, and tells the browser where the Mac reaches the console", async () => {
    const t = tempApp({ browser: { browserUrl, publicUrl: "http://10.104.206.10:8750/" } });
    try {
      seen.length = 0;
      const start = await t.call("POST", "/api/auth-sync", { patterns: ["*.reddit.com"], browser: "chrome" });
      expect(start).toMatchObject({ status: 201, json: { echo: "/api/auth-sync" } });
      expect(seen[0].headers["x-forwarded-origin"]).toBe("http://10.104.206.10:8750");
      expect(seen[0].headers.host).toBe(browserUrl.replace("http://", ""));
      expect(JSON.parse(seen[0].body)).toEqual({ patterns: ["*.reddit.com"], browser: "chrome" });

      const tok = "as" + "0".repeat(32);
      expect((await t.call("GET", `/api/auth-sync/${tok}`)).json.echo).toBe(`/api/auth-sync/${tok}`);
      expect((await t.call("POST", `/api/auth-sync/${tok}/upload`, { cookies: [] })).status).toBe(201);
      expect((await t.call("POST", `/api/auth-sync/${tok}/fail`, { message: "x" })).status).toBe(201);
      expect((await t.call("GET", "/api/auth/sites")).json.echo).toBe("/api/auth/sites");
      expect((await t.call("GET", "/api/auth/sites/site_1/audit?limit=5")).json.echo).toBe("/api/auth/sites/site_1/audit?limit=5");
      expect((await t.call("DELETE", "/api/auth/sites/site_1")).status).toBe(204);

      const sh = await t.app.request(`/auth-sync/${tok}.sh`);
      expect(sh.status).toBe(410);
      expect(sh.headers.get("content-type")).toContain("shellscript");
      expect(sh.headers.get("x-secret")).toBeNull();
      expect(await sh.text()).toContain("exit 1");
      expect(seen.at(-1)!.url).toBe(`/auth-sync/${tok}.sh`);
    } finally {
      t.cleanup();
    }
  });

  it("the cookie export (storage-state) route is gone", async () => {
    const t = tempApp({ browser: { browserUrl } });
    try {
      seen.length = 0;
      expect((await t.call("GET", "/api/auth/sites/reddit.com/storage-state")).status).toBe(404);
      expect(seen).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it("a down browser service is a clear 502 (JSON for the page, a printing script for the Mac)", async () => {
    const t = tempApp();
    try {
      const r = await t.call("GET", "/api/auth/sites");
      expect(r.status).toBe(502);
      expect(r.json.error.code).toBe("browser_unavailable");
      // a token the console never minted is refused here (a script that says so), never sent to a browser.
      const sh = await t.app.request("/auth-sync/as00000000000000000000000000000000.sh");
      expect(sh.status).toBe(404);
      expect(await sh.text()).toMatch(/no such sync token[\s\S]*exit 1/);
    } finally {
      t.cleanup();
    }
  });
});
