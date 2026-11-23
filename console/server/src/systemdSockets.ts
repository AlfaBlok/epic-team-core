import type { AddressInfo } from "node:net";
import { createAdaptorServer, serve } from "@hono/node-server";

/**
 * systemd socket activation. The host's `.socket` unit holds the console's listening sockets across a release
 * swap, so while one console process stops and the next starts, a caller's connection waits in the kernel's queue
 * instead of being refused ("Failed to connect", "Empty reply"). systemd passes the sockets as fds 3.. with
 * LISTEN_PID / LISTEN_FDS / LISTEN_FDNAMES (FileDescriptorName= in the unit); LISTEN_PID is our pid when the unit's
 * `sh -c 'exec node dist/index.mjs'` ran us. Under the tsx fallback (a child node) LISTEN_PID is the parent's and fd 3
 * is tsx's IPC pipe, never the socket: nothing is taken. No sockets passed: an empty map, and every listener binds its
 * own port as before (staging, dev copies, tests).
 */
export function inheritedSockets(env: NodeJS.ProcessEnv = process.env, pid = process.pid): Map<string, number> {
  const out = new Map<string, number>();
  const owner = Number(env.LISTEN_PID);
  if (!owner || owner !== pid) return out;
  const n = Number(env.LISTEN_FDS || 0);
  const names = (env.LISTEN_FDNAMES || "").split(":");
  for (let i = 0; i < n; i++) out.set(names[i] || `fd${3 + i}`, 3 + i);
  return out;
}

type ServeOptions = Parameters<typeof serve>[0];

/** `serve()`, but on the systemd socket named `name` when one was passed; else it binds options.hostname:port itself. */
export function serveOn(sockets: Map<string, number>, name: string, options: ServeOptions, listening?: (info: AddressInfo) => void) {
  const fd = sockets.get(name);
  if (fd === undefined) return serve(options, listening);
  const server = createAdaptorServer(options);
  server.listen({ fd }, () => listening?.(server.address() as AddressInfo));
  return server;
}
