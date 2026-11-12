import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpT3Client, T3Error, errorText, isTransient } from "../src/t3/client.js";
import { createMcpClient, mapLimit } from "../src/adapters/threads.js";

// transient socket errors (ECONNRESET,...) retry the whole MCP handshake + call; the final error keeps its cause.
const reset = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "read ECONNRESET" } });
const URL_ = "http://127.0.0.1:1/mcp";

let tokenFile: string;
let bodies: any[];
beforeEach(() => {
  tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3retry-")), "token");
  fs.writeFileSync(tokenFile, "tok\n");
  bodies = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fake fetch: the first `fails` tools/call requests throw `err`; everything else answers like T3. */
function fakeFetch(fails: number, err: () => unknown = reset) {
  let left = fails;
  const f = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.method === "tools/call" && left > 0) {
      left--;
      throw err();
    }
    const result = body.method === "tools/call" ? { structuredContent: { ok: true, args: body.params.arguments } } : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "mcp-session-id": "s1" } });
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const toolCalls = () => bodies.filter((b) => b.method === "tools/call");

describe("errorText / isTransient", () => {
  it("adds the cause code and message", () => {
    expect(errorText(reset())).toBe("fetch failed (ECONNRESET: read ECONNRESET)");
    expect(errorText(new Error("plain"))).toBe("plain");
    expect(isTransient(reset())).toBe(true);
    expect(isTransient(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }))).toBe(false);
    expect(isTransient(new Error("T3 MCP HTTP 500"))).toBe(false);
  });
});

describe("McpT3Client retry", () => {
  const client = () => new McpT3Client(URL_, tokenFile, [0, 0]);

  it.each([1, 2])("succeeds after %i transient failure(s), redoing the handshake each time", async (n) => {
    fakeFetch(n);
    await client().runScheduledTaskNow("task_1");
    expect(toolCalls()).toHaveLength(n + 1);
    expect(bodies.filter((b) => b.method === "initialize")).toHaveLength(n + 1);
  });

  it("gives up after three attempts with the cause in the message", async () => {
    fakeFetch(3);
    const e = await client().runScheduledTaskNow("task_1").catch((x) => x);
    expect(e).toBeInstanceOf(T3Error);
    expect(e.message).toBe("tools/call run_scheduled_task_now: fetch failed (ECONNRESET: read ECONNRESET) after 3 attempts");
    expect(e.cause).toMatchObject({ code: "ECONNRESET" });
    expect(errorText(e)).toBe(e.message); // no double cause in run summaries
    expect(toolCalls()).toHaveLength(3);
  });

  it("does not retry a non-transient error", async () => {
    const f = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", f);
    await expect(client().runScheduledTaskNow("task_1")).rejects.toThrow(/HTTP 500/);
    expect(f).toHaveBeenCalledTimes(1);
    fakeFetch(1, () => new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }));
    await expect(client().runScheduledTaskNow("task_1")).rejects.toThrow("fetch failed");
    expect(toolCalls()).toHaveLength(1);
  });

  it("t3_thread_send reuses one clientRequestId across attempts", async () => {
    fakeFetch(2);
    await client().sendToThread("thread_1", "hi");
    const ids = toolCalls().map((b) => b.params.arguments.clientRequestId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^console-send-/);
    bodies = [];
    fakeFetch(1);
    await client().sendToThread("thread_1", "hi", "mine");
    expect(toolCalls().map((b) => b.params.arguments.clientRequestId)).toEqual(["mine", "mine"]);
  });
});

describe("threads adapter retry", () => {
  const mcp = () => createMcpClient({ url: URL_, tokenFile, retryDelaysMs: [0, 0] });

  it("retries transient failures with a fresh session", async () => {
    fakeFetch(2);
    expect(await mcp().call("t3_project_list", {})).toMatchObject({ ok: true });
    expect(toolCalls()).toHaveLength(3);
    expect(bodies.filter((b) => b.method === "initialize")).toHaveLength(3);
  });

  it("three failures → the error carries the cause", async () => {
    fakeFetch(3);
    await expect(mcp().call("t3_project_list", {})).rejects.toThrow("tools/call t3_project_list: fetch failed (ECONNRESET: read ECONNRESET) after 3 attempts");
  });
});

describe("mapLimit", () => {
  it("keeps order and caps concurrency", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (x) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBe(4);
  });
});
