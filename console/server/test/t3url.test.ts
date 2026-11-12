import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpClient } from "../src/adapters/threads.js";
import { McpT3Client } from "../src/t3/client.js";
import { DEFAULT_T3_MCP_URL, mcpUrlFromRuntimeFile, t3UrlResolver } from "../src/t3/url.js";

let dir: string;
let runtime: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3url-"));
  runtime = path.join(dir, "server-runtime.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeRuntime = (o: unknown) => fs.writeFileSync(runtime, typeof o === "string" ? o : JSON.stringify(o));

describe("T3 URL resolution", () => {
  it("explicit T3_MCP_URL wins over the runtime file", () => {
    writeRuntime({ origin: "http://127.0.0.1:37397", port: 37397 });
    expect(t3UrlResolver({ T3_MCP_URL: "http://x:1/mcp", T3_RUNTIME_FILE: runtime })()).toBe("http://x:1/mcp");
  });

  it("uses origin from server-runtime.json, else port, else falls back to 3773", () => {
    writeRuntime({ version: 1, pid: 1, port: 37397, origin: "http://127.0.0.1:37397" });
    expect(t3UrlResolver({ T3_RUNTIME_FILE: runtime })()).toBe("http://127.0.0.1:37397/mcp");
    writeRuntime({ port: 4000 });
    expect(mcpUrlFromRuntimeFile(runtime)).toBe("http://127.0.0.1:4000/mcp");
    writeRuntime("{not json");
    expect(t3UrlResolver({ T3_RUNTIME_FILE: runtime })()).toBe(DEFAULT_T3_MCP_URL);
    writeRuntime({ origin: "file:///etc/passwd" });
    expect(mcpUrlFromRuntimeFile(runtime)).toBeUndefined();
    expect(t3UrlResolver({ T3_RUNTIME_FILE: path.join(dir, "missing.json") })()).toBe(DEFAULT_T3_MCP_URL);
    expect(DEFAULT_T3_MCP_URL).toBe("http://127.0.0.1:3773/mcp");
  });

  it("re-reads the file after the short cache, so a later T3 restart (new port) is picked up", () => {
    let t = 0;
    const r = t3UrlResolver({ T3_RUNTIME_FILE: runtime }, () => t);
    writeRuntime({ origin: "http://127.0.0.1:1111" });
    expect(r()).toBe("http://127.0.0.1:1111/mcp");
    writeRuntime({ origin: "http://127.0.0.1:2222" });
    t = 1_000;
    expect(r()).toBe("http://127.0.0.1:1111/mcp"); // cached
    t = 2_500;
    expect(r()).toBe("http://127.0.0.1:2222/mcp");
  });
});

/** Minimal fake T3 MCP server; records calls; session id carries the server name. */
async function fakeT3(name: string) {
  const seen: { sid?: string; method: string }[] = [];
  let gen = 0; // bump = server "restarted" and forgot its sessions
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const sid = req.headers["mcp-session-id"] as string | undefined;
      seen.push({ sid, method: msg.params?.name ?? msg.method });
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `S-${name}${gen}` });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      }
      if (msg.method === "notifications/initialized") return res.writeHead(202).end();
      if (sid !== `S-${name}${gen}`) return res.writeHead(404).end("unknown session");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: { server: name } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, restart: () => void gen++, origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("MCP clients follow T3 to a new port", () => {
  it("threads client (session-caching) re-initializes on the new port", async () => {
    const tokenFile = path.join(dir, "tok");
    fs.writeFileSync(tokenFile, "t");
    const a = await fakeT3("a");
    const b = await fakeT3("b");
    try {
      let t = 0;
      writeRuntime({ origin: a.origin });
      const mcp = createMcpClient({ url: t3UrlResolver({ T3_RUNTIME_FILE: runtime }, () => t), tokenFile });
      expect(await mcp.call("t3_project_list", {})).toEqual({ server: "a" });
      expect(await mcp.call("t3_project_list", {})).toEqual({ server: "a" });
      await a.close(); // T3 restarts on another port
      writeRuntime({ origin: b.origin });
      t = 10_000;
      expect(await mcp.call("t3_project_list", {})).toEqual({ server: "b" });
      expect(b.seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "t3_project_list"]);
    } finally {
      await b.close();
    }
  });

  it("threads client drops its session after a failed call (same URL, server restarted)", async () => {
    const tokenFile = path.join(dir, "tok");
    fs.writeFileSync(tokenFile, "t");
    const a = await fakeT3("a");
    try {
      const mcp = createMcpClient({ url: () => `${a.origin}/mcp`, tokenFile });
      expect(await mcp.call("x", {})).toEqual({ server: "a" });
      a.restart();
      await expect(mcp.call("x", {})).rejects.toThrow(/HTTP 404/);
      expect(await mcp.call("x", {})).toEqual({ server: "a" });
      expect(a.seen.filter((s) => s.method === "initialize")).toHaveLength(2);
    } finally {
      await a.close();
    }
  });

  it("cycle client (McpT3Client) uses the resolver per call", async () => {
    const tokenFile = path.join(dir, "tok");
    fs.writeFileSync(tokenFile, "t");
    const a = await fakeT3("a");
    const b = await fakeT3("b");
    try {
      let t = 0;
      writeRuntime({ origin: a.origin });
      const c = new McpT3Client(t3UrlResolver({ T3_RUNTIME_FILE: runtime }, () => t), tokenFile);
      expect(await c.call("t3_project_list", {})).toEqual({ server: "a" });
      writeRuntime({ origin: b.origin });
      t = 10_000;
      expect(await c.call("t3_project_list", {})).toEqual({ server: "b" });
    } finally {
      await a.close();
      await b.close();
    }
  });
});
