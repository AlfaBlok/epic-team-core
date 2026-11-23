import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpT3Client } from "../src/t3/client.js";

// One host may run T3 0.1.x while another stays on 0.0.x. 0.1.x merged t3_queue_list/read/cancel into
// t3_queue {action} and update_scheduled_task into schedule_task {scheduledTaskId}; the console speaks both, per T3.
const URL_ = "http://127.0.0.1:1/mcp";
let tokenFile: string;
let calls: { name: string; args: any }[];
beforeEach(() => {
  tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3names-")), "token");
  fs.writeFileSync(tokenFile, "tok\n");
  calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A T3 that knows only `tools`; others answer -32602 "Tool '<name>' not found", as both versions do. */
function fakeT3(tools: Record<string, (args: any) => any>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method !== "tools/call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { headers: { "mcp-session-id": "s1" } });
      const { name, arguments: args } = body.params;
      calls.push({ name, args });
      const f = tools[name];
      const reply = f
        ? { result: { structuredContent: f(args) } }
        : { error: { code: -32602, message: `Tool '${name}' not found` } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), { headers: { "mcp-session-id": "s1" } });
    }),
  );
}
const items = { items: [{ queuedRunId: "q1", text: "held line", truncated: false }], nextCursor: null };

describe("T3 queue and scheduled-task tools on 0.0.46 and 0.1.12", () => {
  it("0.1.12: t3_queue {action} for list, read and cancel", async () => {
    fakeT3({ t3_queue: (a) => (a.action === "list" ? items : a.action === "read" ? items.items[0] : { ok: true }) });
    const c = new McpT3Client(URL_, tokenFile, [0, 0]);
    expect(await c.queueItems("th")).toEqual([{ queuedRunId: "q1", text: "held line", truncated: false }]);
    expect(await c.queuedCount("th")).toBe(1);
    expect(await c.queueRead("th", "q1")).toBe("held line");
    await c.queueCancel("th", "q1");
    expect(calls.map((x) => `${x.name}:${x.args.action}`)).toEqual(["t3_queue:list", "t3_queue:list", "t3_queue:read", "t3_queue:cancel"]);
  });

  it("0.0.46: falls back to t3_queue_list/read/cancel once, then calls them directly", async () => {
    fakeT3({ t3_queue_list: () => items, t3_queue_read: () => ({ text: "held line" }), t3_queue_cancel: () => ({ ok: true }) });
    const c = new McpT3Client(URL_, tokenFile, [0, 0]);
    expect(await c.queuedCount("th")).toBe(1);
    expect(await c.queuedCount("th")).toBe(1);
    expect(await c.queueRead("th", "q1")).toBe("held line");
    await c.queueCancel("th", "q1");
    expect(calls.map((x) => x.name)).toEqual(["t3_queue", "t3_queue_list", "t3_queue_list", "t3_queue_read", "t3_queue_cancel"]);
    expect(calls[1].args).toEqual({ threadId: "th", limit: 100 });
  });

  it("switches back when the T3 behind the same client is upgraded", async () => {
    fakeT3({ t3_queue_list: () => items });
    const c = new McpT3Client(URL_, tokenFile, [0, 0]);
    await c.queuedCount("th");
    fakeT3({ t3_queue: () => items });
    expect(await c.queuedCount("th")).toBe(1);
    expect(calls.map((x) => x.name)).toEqual(["t3_queue", "t3_queue_list", "t3_queue_list", "t3_queue"]);
  });

  it("scheduled task update: update_scheduled_task on 0.0.46, schedule_task {scheduledTaskId} on 0.1.12", async () => {
    const task = (a: any) => ({ scheduledTaskId: a.scheduledTaskId, title: "t", enabled: a.enabled });
    fakeT3({ update_scheduled_task: task, schedule_task: () => ({ error: "needs prompt and schedule" }) });
    const old = new McpT3Client(URL_, tokenFile, [0, 0]);
    expect((await old.updateScheduledTask("st1", { enabled: false }))?.enabled).toBe(false);
    expect(calls.map((x) => x.name)).toEqual(["update_scheduled_task"]);

    calls = [];
    fakeT3({ schedule_task: task });
    const neu = new McpT3Client(URL_, tokenFile, [0, 0]);
    expect((await neu.updateScheduledTask("st1", { enabled: true }))?.enabled).toBe(true);
    expect(calls.map((x) => x.name)).toEqual(["update_scheduled_task", "schedule_task"]);
    expect(calls[1].args).toEqual({ scheduledTaskId: "st1", enabled: true });
  });

  it("any other error is not a reason to try the other name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.method === "tools/call") calls.push({ name: body.params.name, args: body.params.arguments });
        const reply = body.method === "tools/call" ? { error: { code: -32602, message: "Invalid parameters for tool 't3_queue'" } } : { result: {} };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), { headers: { "mcp-session-id": "s1" } });
      }),
    );
    await expect(new McpT3Client(URL_, tokenFile, [0, 0]).queuedCount("th")).rejects.toThrow(/Invalid parameters/);
    expect(calls.map((x) => x.name)).toEqual(["t3_queue"]);
  });
});
